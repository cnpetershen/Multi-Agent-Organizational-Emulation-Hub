#!/usr/bin/env node
/**
 * extract-diagrams.mjs
 * 从 docs/**\/*.md 中提取 ```mermaid 代码块，输出为 docs/diagrams/*.mmd，
 * 并做一次轻量的结构校验（diagram type / 空块 / 括号配平 / 引号配平）。
 *
 * 单一真相源：Markdown 文档中的 mermaid 块。本脚本只做派生，不反向修改文档。
 *
 * 用法: node scripts/extract-diagrams.mjs [--check]
 *   --check  只校验，不写文件（CI 用）
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const DOCS = join(ROOT, 'docs');
const OUT = join(DOCS, 'diagrams');
const CHECK = process.argv.includes('--check');
const EMIT_JSON = process.argv.includes('--emit-json');

/** 合法的 Mermaid 图首关键字 */
const DIAGRAM_TYPES = [
  'flowchart', 'graph', 'sequenceDiagram', 'classDiagram', 'erDiagram',
  'stateDiagram-v2', 'stateDiagram', 'journey', 'gantt', 'pie', 'quadrantChart',
  'requirementDiagram', 'gitGraph', 'C4Context', 'C4Container', 'C4Component',
  'mindmap', 'timeline', 'sankey-beta', 'xychart-beta', 'block-beta',
  'packet-beta', 'architecture-beta', 'kanban', 'radar', 'treemap',
];

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

function slug(s) {
  return s
    .replace(/[`*_~[\]()#>]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48) || 'diagram';
}

/** 提取 fenced mermaid 块，并记录其最近的上文标题 */
function extract(md) {
  const lines = md.split(/\r?\n/);
  const blocks = [];
  let inFence = false, fenceLang = '', buf = [], lastHeading = '';
  for (const line of lines) {
    const fence = line.match(/^\s*```(\w[\w-]*)?\s*$/);
    if (fence) {
      if (!inFence) {
        inFence = true; fenceLang = (fence[1] || '').toLowerCase(); buf = [];
      } else {
        if (fenceLang === 'mermaid') blocks.push({ code: buf.join('\n'), heading: lastHeading });
        inFence = false; fenceLang = ''; buf = [];
      }
      continue;
    }
    if (inFence) { if (fenceLang === 'mermaid') buf.push(line); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) lastHeading = h[1].trim();
  }
  return blocks;
}

/** 轻量结构校验：只抓最容易被写错的几类问题 */
function validate(code) {
  const errs = [];
  const stripped = code.replace(/%%\{[\s\S]*?\}%%/g, '').trim();
  if (!stripped) return ['空图'];
  const first = stripped.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith('%%'));
  if (!first) return ['只有注释'];
  const kw = first.trim().split(/[\s{]/)[0];
  if (!DIAGRAM_TYPES.includes(kw)) errs.push(`未知图类型: "${kw}"`);

  // 引号配平（忽略行内转义）
  const dq = (code.match(/(?<!\\)"/g) || []).length;
  if (dq % 2 !== 0) errs.push(`双引号未配平 (${dq})`);

  // 方括号 / 花括号 / 圆括号配平
  // 注意：erDiagram 的鸦脚基数符号 o{ / |{ / }o / }| 不是代码块括号，先归一化
  const norm = code
    .replace(/[o|]\{/g, ' ')
    .replace(/\}[o|]/g, ' ');
  for (const [open, close, name] of [['[', ']', '方括号'], ['{', '}', '花括号'], ['(', ')', '圆括号']]) {
    let depth = 0, bad = false;
    for (const ch of norm) {
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (depth < 0) { bad = true; break; } }
    }
    if (bad || depth !== 0) errs.push(`${name}未配平`);
  }

  // sequenceDiagram 中必须声明或使用一致的 participant
  if (/^\s*sequenceDiagram/m.test(stripped)) {
    if (!/\bparticipant\b|\bactor\b/.test(stripped)) errs.push('sequenceDiagram 未声明 participant');
    if (/->>|-->>|->|-->/.test(stripped) === false) errs.push('sequenceDiagram 无消息箭头');
  }
  return errs;
}

const files = walk(DOCS).sort();
let total = 0, failed = 0;
const manifest = [];
const emitted = {};

for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join('/');
  const docSlug = rel.replace(/^docs\//, '').replace(/\.md$/, '').replace(/\//g, '-');
  const blocks = extract(readFileSync(file, 'utf8'));
  blocks.forEach((b, i) => {
    total++;
    const errs = validate(b.code);
    const stem = `${docSlug}--${String(i + 1).padStart(2, '0')}-${slug(b.heading)}`;
    if (errs.length) {
      failed++;
      console.error(`✗ ${rel} #${i + 1} (${b.heading}): ${errs.join('; ')}`);
    }
    manifest.push({ file: rel, index: i + 1, heading: b.heading, stem, bytes: b.code.length, errors: errs });
    if (EMIT_JSON) {
      emitted[`${stem}.mmd`] = b.code.trimEnd() + '\n';
    } else if (!CHECK) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${stem}.mmd`), b.code.trimEnd() + '\n', 'utf8');
    }
  });
}

if (EMIT_JSON) {
  process.stdout.write(JSON.stringify(emitted));
  process.exit(failed === 0 ? 0 : 1);
}

if (!CHECK) {
  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

console.log(`\n扫描 ${files.length} 个文档，发现 ${total} 个 Mermaid 图，校验失败 ${failed} 个。`);
if (!CHECK) console.log(`已导出到 docs/diagrams/（${total} 个 .mmd + manifest.json）`);
process.exit(failed === 0 ? 0 : 1);

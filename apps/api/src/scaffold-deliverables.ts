/**
 * A runnable, brief-aware stand-in for a non-game code delivery.
 *
 * `deterministic-cognition.ts` cannot author an arbitrary codebase — that is what the live LLM
 * is for — but a bare `app.textContent = "<step name>"` page is not a delivery anyone would
 * accept, and the game path (`game-deliverables.ts`) already proved that a stand-in can hand
 * back something genuinely useful. This module does the same for the two other mandate shapes
 * the platform actually routes to an implementation seat:
 *
 * - **content board** (`family: 'content'`) — the "一鱼多吃" class of briefs (自媒体 / 公众号 /
 *   小红书 / 短视频 / 多模态 / 营销…) gets a real multi-platform content console: a source
 *   material pane, per-platform generation, a review gate and a publish flow. All of it is
 *   self-contained client-side logic; there is no network, no API key, no build step.
 * - **workspace board** (`family: 'ops'`) — any other brief gets an ops console derived from the
 *   same texts: the goal broken into a checklist, a kanban board, and a working notepad.
 *
 * The page embeds the instruction it answers (name + goal), so the delivery reads as *this*
 * mandate's work and stays traceable on the event log. When a brief genuinely demands real
 * engineering (or an LLM), the same text still tells the story honestly instead of pretending.
 */

export type ScaffoldFamily = 'content' | 'ops';

const CONTENT_HINTS: readonly RegExp[] = Object.freeze([
  /自媒体/,
  /公众号/,
  /小红书/,
  /短视频/,
  /种草/,
  /文案/,
  /脚本/,
  /封面/,
  /一鱼多吃/,
  /多模态/,
  /营销/,
  /内容/,
]);

export function scaffoldFamilyOf(text: string): ScaffoldFamily {
  return CONTENT_HINTS.some((hint) => hint.test(text)) ? 'content' : 'ops';
}

/** `Complete step "X" of workflow "Y": Z` → `Z`. Falls back to the raw goal otherwise. */
function stripStepBoilerplate(goal: string): string {
  const match = /^Complete step "[^"]*" of workflow "[^"]*":\s*/.exec(goal);
  return match !== null ? goal.slice(match[0].length).trim() : goal;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `:root{--ink:#0f172a;--ink-soft:#334155;--muted:#64748b;--line:#e2e8f0;--card:#fff;--bg:#f1f5f9;--accent:#25855a;--accent-soft:#e8f5ed;--blue:#3b5ccc;--blue-soft:#edf1ff}
*{box-sizing:border-box}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
.top{display:flex;align-items:center;gap:16px;padding:18px 24px;background:#0f172a;color:#e2e8f0}
.mark{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#34d399,#0ea5e9);color:#0f172a;font-weight:800;display:grid;place-items:center;font-size:20px;flex:0 0 auto}
.kicker{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7dd3fc;margin:0 0 4px}
.top h1{margin:0;font-size:19px;line-height:1.35;color:#f8fafc}
.goal{margin:6px 0 0;font-size:12px;color:#94a3b8;max-width:860px}
.layout{display:grid;grid-template-columns:210px 1fr;min-height:calc(100vh - 84px)}
.side{background:#111c2e;padding:18px 12px;display:flex;flex-direction:column;gap:6px}
.side-title{font-size:11px;letter-spacing:.12em;color:#7b8ba3;padding:0 8px 6px}
.tab{display:flex;align-items:center;gap:8px;width:100%;border:0;background:transparent;color:#cbd5e1;font:inherit;font-size:13px;text-align:left;padding:9px 10px;border-radius:8px;cursor:pointer}
.tab:hover{background:#1e293b;color:#fff}
.tab.active{background:#1e3a2f;color:#7dffc7}
.side-foot{margin-top:auto;font-size:10px;color:#64748b;padding:8px}
.panes{padding:18px 20px}
.pane{display:none}
.pane.active{display:block}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;box-shadow:0 1px 2px rgba(15,23,42,.05)}
.pane h2{font-size:14px;margin:0 0 10px}
textarea{width:100%;min-height:150px;border:1px solid var(--line);border-radius:10px;padding:10px;font:inherit;font-size:13px;line-height:1.6;resize:vertical}
.counter{font-size:11px;color:var(--muted);margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px}
.p-card{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:12px;background:#fff;overflow:hidden}
.p-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line)}
.p-dot{width:10px;height:10px;border-radius:50%}
.p-name{font-weight:700;font-size:13px}
.p-out{white-space:pre-wrap;font-size:12px;line-height:1.6;padding:10px;min-height:120px;background:#fafafa;max-height:260px;overflow:auto}
.p-foot{display:flex;gap:6px;padding:8px;border-top:1px solid var(--line)}
.btn{border:1px solid var(--line);background:#fff;border-radius:6px;padding:5px 9px;font:inherit;font-size:12px;cursor:pointer}
.btn:hover{border-color:#cbd5e1}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:disabled{opacity:.45;cursor:not-allowed}
.btn.ghost{border-color:transparent;color:var(--muted);padding:5px 6px}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:10px;border-radius:999px;padding:2px 8px;font-weight:700}
.badge.ok{background:var(--accent-soft);color:var(--accent)}
.badge.wait{background:#fff6e7;color:#a36b12}
.review-row{display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:#fff;margin-bottom:8px}
.review-row small{display:block;color:var(--muted);font-size:11px;max-width:560px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kpis{display:flex;gap:14px;margin-left:auto}
.kpi{display:grid;place-items:center;min-width:64px}
.kpi b{font-size:17px;color:#f8fafc}
.kpi span{font-size:10px;color:#94a3b8}
.note{font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5}
`;

const CONTENT_JS = `var PLATFORMS = [
  { id: 'xhs', name: '小红书', accent: '#ff2442', hint: '种草笔记 · 表情 + 话题' },
  { id: 'douyin', name: '抖音', accent: '#161823', hint: '前 3 秒钩子 · 分镜脚本' },
  { id: 'bilibili', name: 'B站', accent: '#00a1d6', hint: '章节时间轴 · 三连' },
  { id: 'mp', name: '公众号', accent: '#07c160', hint: '标题三选 · 金句开头' },
  { id: 'weibo', name: '微博', accent: '#e6162d', hint: '140 字精炼' },
  { id: 'kuaishou', name: '快手', accent: '#ff4906', hint: '老铁风格短版' },
  { id: 'zhihu', name: '知乎', accent: '#0066ff', hint: '问题 → 数据论据' }
];
var state = { approved: {}, published: {}, seed: 1, notes: '' };
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function sourceText() { return $('#src').value.trim() || '本周我们用一份 3000 字的行业深度好文，派生出小红书种草笔记、抖音口播脚本、B站章节稿、公众号推文，覆盖内容冷启动全链路。'; }
function pick(arr) { return arr[(state.seed - 1) % arr.length]; }
function derive(id, src) {
  var s = src.replace(/\\s+/g, ' ').trim();
  var short = s.length > 120 ? s.slice(0, 117) + '…' : s;
  var tags = /(自媒体|小红书|抖音|B站|公众号|内容|素材|一鱼多吃|多模态|AI)/g;
  var matched = (s.match(tags) || []).slice(0, 3);
  var tagLine = matched.length ? matched.map(function (t) { return '#' + t; }).join(' ') : '#内容创作 #效率';
  var hooks = ['别滑走，3 秒看懂这件事', '这个行业正在悄悄发生这件事', '干货预警：一文讲透' + short.slice(0, 12), '同事看完都沉默了'];
  switch (id) {
    case 'xhs':
      return '🔥 ' + pick(hooks) + '\\n\\n' + short + '\\n\\n▪️ 核心观点：' + s.slice(0, 40) + '\\n▪️ 适合人群：内容创业者 / 运营\\n\\n' + tagLine + ' #种草 #一鱼多吃';
    case 'douyin':
      return '【分镜 01｜0-3s】钩子：' + pick(hooks) + '\\n【分镜 02｜3-8s】痛点呈现：' + short.slice(0, 60) + '\\n【分镜 03｜8-15s】给出方法：把同一素材拆成' + (matched.length || 5) + '个平台版本\\n【分镜 04｜15-20s】升华：' + s.slice(0, 36) + '\\n【结尾 CTA】点赞 + 关注，承接全部渠道';
    case 'bilibili':
      return '《' + short.slice(0, 24) + '》\\n00:00 开头｜为什么这个素材值得一稿多发\\n01:12 平台差异｜小红书 / 抖音 / 公众号分别怎样改写\\n03:40 实操｜' + short.slice(0, 50) + '\\n06:20 避坑｜直接抄稿 = 限流\\n08:57 总结｜' + s.slice(0, 30) + '\\n\\n三连预警：收藏 = 下次照着做';
    case 'mp':
      return '标题三选：\\n1. ' + short.slice(0, 28) + '（深度版）\\n2. 把一份素材吃成五个平台（方法论版）\\n3. 自媒体别再熬夜肝一条稿了（痛点版）\\n\\n' + s.slice(0, 90) + '\\n\\n……正文共 3200 字，含平台适配表与话术库。';
    case 'weibo':
      return short.length > 130 ? short.slice(0, 128) + '…' : short + ' ' + tagLine;
    case 'kuaishou':
      return '老铁们，' + short.slice(0, 60) + ' \\n\\n一份素材，七个渠道，这样派生出来的：\\n1️⃣ 先改钩子\\n2️⃣ 再改结构\\n3️⃣ 最后改语气\\n\\n想看全流程？评论区扣 1。';
    case 'zhihu':
      return '问：如何把一篇长文高效分发到全网？\\n\\n答：关键在“同一素材、八种语言”。' + s.slice(0, 80) + '\\n\\n数据上，平台专属改写后互动率平均提升 2-3 倍；跨平台复制粘贴则几乎必然限流。核心是先拆平台规范，再做内容适配。';
    default:
      return short;
  }
}
function renderPlatforms() {
  var src = sourceText();
  $$('.p-card').forEach(function (card) {
    var id = card.getAttribute('data-id');
    $('.p-out', card).textContent = derive(id, src);
    var badge = $('.badge', card);
    badge.textContent = state.approved[id] ? '已通过' : '待审核';
    badge.className = 'badge ' + (state.approved[id] ? 'ok' : 'wait');
    $('[data-action=approve]', card).textContent = state.approved[id] ? '撤回' : '通过';
  });
}
function renderReview() {
  var src = sourceText();
  $$('.review-row').forEach(function (row) {
    var id = row.getAttribute('data-id');
    var text = derive(id, src).split('\\n')[0];
    $('.review-text', row).textContent = text;
    var badge = $('.badge', row);
    badge.textContent = state.approved[id] ? '已通过' : '待审核';
    badge.className = 'badge ' + (state.approved[id] ? 'ok' : 'wait');
  });
}
function renderPublish() {
  $$('.publish-card').forEach(function (card) {
    var id = card.getAttribute('data-id');
    var approved = !!state.approved[id];
    var published = !!state.published[id];
    var btn = $('[data-action=publish]', card);
    btn.disabled = !approved || published;
    btn.textContent = published ? '已发布' : '发布';
    var badge = $('.badge', card);
    badge.textContent = published ? '已发布' : approved ? '待发布' : '未过审';
    badge.className = 'badge ' + (published ? 'ok' : 'wait');
  });
}
function renderCounters() {
  var approved = Object.keys(state.approved).filter(function (k) { return state.approved[k]; }).length;
  var published = Object.keys(state.published).filter(function (k) { return state.published[k]; }).length;
  $('#kpiApproved').textContent = String(approved);
  $('#kpiPublished').textContent = String(published);
  $('#kpiTotal').textContent = String(PLATFORMS.length);
  var src = $('#src').value;
  $('#srcCount').textContent = String(src.length) + ' 字';
}
function renderAll() { renderPlatforms(); renderReview(); renderPublish(); renderCounters(); }
function toggleApprove(id) {
  state.approved[id] = !state.approved[id];
  if (!state.approved[id]) state.published[id] = false;
  renderAll();
}
function togglePublish(id) {
  if (!state.approved[id]) return;
  state.published[id] = !state.published[id];
  renderAll();
}
function approveAll() {
  PLATFORMS.forEach(function (p) { state.approved[p.id] = true; });
  renderAll();
}
function publishApproved() {
  PLATFORMS.forEach(function (p) { if (state.approved[p.id]) state.published[p.id] = true; });
  renderAll();
}
function resetAll() { state.approved = {}; state.published = {}; state.seed = 1; renderAll(); }
function switchTab(name) {
  $$('.tab').forEach(function (tab) { tab.classList.toggle('active', tab.getAttribute('data-tab') === name); });
  $$('.pane').forEach(function (pane) { pane.classList.toggle('active', pane.getAttribute('data-pane') === name); });
}
$$('.tab').forEach(function (tab) { tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-tab')); }); });
$$('[data-action=approve]').forEach(function (btn) { btn.addEventListener('click', function () { toggleApprove(btn.closest('[data-id]').getAttribute('data-id')); }); });
$$('[data-action=publish]').forEach(function (btn) { btn.addEventListener('click', function () { togglePublish(btn.closest('[data-id]').getAttribute('data-id')); }); });
$$('[data-action=rewrite]').forEach(function (btn) { btn.addEventListener('click', function () { state.seed += 1; renderAll(); }); });
$('#approveAll').addEventListener('click', approveAll);
$('#publishApproved').addEventListener('click', publishApproved);
$('#resetAll').addEventListener('click', resetAll);
var src = $('#src'); var timer = null;
src.addEventListener('input', function () {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(renderAll, 250);
});
src.addEventListener('input', function () { $('#srcCount').textContent = String(src.value.length) + ' 字'; });
renderAll();
`;

/** The content-board page: source → per-platform generation → review gate → publish. */
function contentPage(name: string, goal: string): string {
  const brief = stripStepBoilerplate(goal);
  const title = escapeHtml(brief.length > 64 ? `${brief.slice(0, 64)}…` : brief);
  const platforms = ['xhs', 'douyin', 'bilibili', 'mp', 'weibo', 'kuaishou', 'zhihu'];
  const platformName: Record<string, string> = {
    xhs: '小红书',
    douyin: '抖音',
    bilibili: 'B站',
    mp: '公众号',
    weibo: '微博',
    kuaishou: '快手',
    zhihu: '知乎',
  };
  const platformColor: Record<string, string> = {
    xhs: '#ff2442',
    douyin: '#161823',
    bilibili: '#00a1d6',
    mp: '#07c160',
    weibo: '#e6162d',
    kuaishou: '#ff4906',
    zhihu: '#0066ff',
  };
  const cards = platforms
    .map(
      (id) => `        <article class="p-card" data-id="${id}">
          <div class="p-head"><span class="p-dot" style="background:${platformColor[id] ?? '#64748b'}"></span><span class="p-name">${platformName[id] ?? id}</span><span class="badge wait">待审核</span></div>
          <pre class="p-out"></pre>
          <div class="p-foot">
            <button type="button" class="btn ghost" data-action="rewrite">换一版</button>
            <button type="button" class="btn" data-action="approve">通过</button>
          </div>
        </article>`,
    )
    .join('\n');
  const reviewRows = platforms
    .map(
      (id) => `        <div class="review-row" data-id="${id}">
          <span class="p-dot" style="background:${platformColor[id] ?? '#64748b'}"></span>
          <span><b>${platformName[id] ?? id}</b><small class="review-text"></small></span>
          <span class="badge wait" style="margin-left:auto">待审核</span>
          <button type="button" class="btn" data-action="approve">通过</button>
        </div>`,
    )
    .join('\n');
  const publishCards = platforms
    .map(
      (id) => `        <article class="p-card publish-card" data-id="${id}">
          <div class="p-head"><span class="p-dot" style="background:${platformColor[id] ?? '#64748b'}"></span><span class="p-name">${platformName[id] ?? id}</span><span class="badge wait">待发布</span></div>
          <div class="p-foot"><button type="button" class="btn primary" data-action="publish">发布</button></div>
        </article>`,
    )
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width,initial-scale=1" />',
    `    <title>${escapeHtml(name)}</title>`,
    `    <style>${CSS}</style>`,
    '  </head>',
    '  <body>',
    '    <header class="top">',
    '      <div class="mark">鱼</div>',
    '      <div>',
    `        <p class="kicker">${escapeHtml(name)}</p>`,
    `        <h1>${title}</h1>`,
    `        <p class="goal">${escapeHtml(brief)}</p>`,
    '      </div>',
    '      <nav class="kpis" aria-label="统计">',
    '        <div class="kpi"><b id="kpiTotal">7</b><span>平台</span></div>',
    '        <div class="kpi"><b id="kpiApproved">0</b><span>已通过</span></div>',
    '        <div class="kpi"><b id="kpiPublished">0</b><span>已发布</span></div>',
    '      </nav>',
    '    </header>',
    '    <main class="layout">',
    '      <aside class="side" aria-label="导航">',
    '        <div class="side-title">一鱼多吃 · 工作台</div>',
    '        <button type="button" class="tab active" data-tab="source">📄 原始素材</button>',
    '        <button type="button" class="tab" data-tab="platforms">🐟 平台分发</button>',
    '        <button type="button" class="tab" data-tab="review">✅ 审核闸门</button>',
    '        <button type="button" class="tab" data-tab="publish">🚀 发布中心</button>',
    '        <div class="side-foot">自包含页面 · 无网络 / 无构建 / 无外链</div>',
    '      </aside>',
    '      <section class="panes">',
    '        <div class="pane active" data-pane="source">',
    '          <div class="card">',
    '            <h2>📄 原始素材（改它，全平台实时重写）</h2>',
    '            <textarea id="src" placeholder="粘贴一篇原稿 / 逐字稿 / 产品 brief…">本周我们用一份 3000 字的行业深度好文，派生出小红书种草笔记、抖音口播脚本、B站章节稿、公众号推文，覆盖内容冷启动全链路。</textarea>',
    '            <div class="counter"><span id="srcCount">0 字</span></div>',
    '            <p class="note">编辑器即工作流的第一步：素材一改，平台分发、审核队列、发布统计全部同步重算。</p>',
    '          </div>',
    '        </div>',
    '        <div class="pane" data-pane="platforms">',
    '          <h2>🐟 多平台分发（点击「通过」逐平台放行）</h2>',
    `          <div class="grid">${cards}</div>`,
    '        </div>',
    '        <div class="pane" data-pane="review">',
    '          <div class="card">',
    '            <h2>✅ 审核闸门（SoD：生成者与审核者分开签字）</h2>',
    `            ${reviewRows}`,
    '            <button type="button" class="btn primary" id="approveAll">全部通过</button>',
    '          </div>',
    '        </div>',
    '        <div class="pane" data-pane="publish">',
    '          <h2>🚀 发布中心（仅「已通过」可发布）</h2>',
    `          <div class="grid">${publishCards}</div>`,
    '          <div style="margin-top:10px;display:flex;gap:8px"><button type="button" class="btn primary" id="publishApproved">发布全部已通过</button><button type="button" class="btn ghost" id="resetAll">重置演示</button></div>',
    '        </div>',
    '      </section>',
    '    </main>',
    `    <script>${CONTENT_JS}</script>`,
    '  </body>',
    '</html>',
  ].join('\n');
}

const OPS_JS = `var state = { column: 'todo' };
function $(sel, ctx) { return (ctx || document).querySelector(sel); }
function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }
var items = [];
function saveItems() { try { window.localStorage.setItem('ops-items', JSON.stringify(items)); } catch (e) {} }
function loadItems() {
  try { var raw = window.localStorage.getItem('ops-items'); if (raw !== null) items = JSON.parse(raw); } catch (e) {}
  if (items.length === 0) {
    items = [
      { id: 'i1', text: '需求对齐：把 brief 拆成可验收判据', done: false },
      { id: 'i2', text: '接口契约：输入 / 输出 / 失败形态', done: false },
      { id: 'i3', text: '实现与自测', done: false },
      { id: 'i4', text: '交付验收与回写', done: false }
    ];
  }
}
function renderChecklist() {
  var list = $('#checklist');
  list.innerHTML = '';
  items.forEach(function (item) {
    var li = document.createElement('li');
    li.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;background:#fff';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = item.done;
    box.addEventListener('change', function () { item.done = box.checked; saveItems(); renderKpis(); });
    var span = document.createElement('span');
    span.textContent = item.text;
    span.style.cssText = item.done ? 'text-decoration:line-through;color:var(--muted)' : '';
    li.appendChild(box); li.appendChild(span); list.appendChild(li);
  });
}
function renderKpis() {
  $('#kpiDone').textContent = String(items.filter(function (i) { return i.done; }).length);
  $('#kpiTotal').textContent = String(items.length);
}
function addItem() {
  var input = $('#newItem');
  var text = input.value.trim();
  if (text === '') return;
  items.push({ id: 'i' + String(Date.now()), text: text, done: false });
  input.value = '';
  saveItems(); renderChecklist(); renderKpis();
}
$$('.tab').forEach(function (tab) { tab.addEventListener('click', function () {
  $$('.tab').forEach(function (t) { t.classList.toggle('active', t === tab); });
  $$('.pane').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-pane') === tab.getAttribute('data-tab')); });
}); });
$('#addItem').addEventListener('click', addItem);
$('#newItem').addEventListener('keydown', function (e) { if (e.key === 'Enter') addItem(); });
loadItems(); renderChecklist(); renderKpis();
`;

/** The workspace page for briefs that are not a content pipeline: target → checklist → notes. */
function opsPage(name: string, goal: string): string {
  const brief = stripStepBoilerplate(goal);
  const title = escapeHtml(brief.length > 72 ? `${brief.slice(0, 72)}…` : brief);
  const bullets = brief
    .split(/[，。；、\n]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 4)
    .slice(0, 4)
    .map(
      (part) => `              <li class="review-row" style="margin:0"><span class="review-text" style="max-width:none;overflow:visible;white-space:normal;flex:1">${escapeHtml(part)}</span><span class="badge wait">目标</span></li>`,
    )
    .join('\n');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width,initial-scale=1" />',
    `    <title>${escapeHtml(name)}</title>`,
    `    <style>${CSS}</style>`,
    '  </head>',
    '  <body>',
    '    <header class="top">',
    '      <div class="mark">办</div>',
    '      <div>',
    `        <p class="kicker">${escapeHtml(name)}</p>`,
    `        <h1>${title}</h1>`,
    `        <p class="goal">${escapeHtml(brief)}</p>`,
    '      </div>',
    '      <nav class="kpis" aria-label="统计">',
    '        <div class="kpi"><b id="kpiDone">0</b><span>已达成</span></div>',
    '        <div class="kpi"><b id="kpiTotal">0</b><span>检查项</span></div>',
    '      </nav>',
    '    </header>',
    '    <main class="layout">',
    '      <aside class="side" aria-label="导航">',
    '        <div class="side-title">交付工作台</div>',
    '        <button type="button" class="tab active" data-tab="goal">🎯 目标与判据</button>',
    '        <button type="button" class="tab" data-tab="checklist">✅ 验收清单</button>',
    '        <div class="side-foot">自包含页面 · 无网络 / 无构建 / 无外链</div>',
    '      </aside>',
    '      <section class="panes">',
    '        <div class="pane active" data-pane="goal">',
    '          <div class="card">',
    '            <h2>🎯 目标拆解（来自本次任务的原始要求）</h2>',
    `            <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${bullets}</ul>`,
    '            <p class="note">验收判据由内核的 verification 步骤判定：交付提交后，校验器核对 requiredOutputKeys；未过则沿流程打回重做。</p>',
    '          </div>',
    '        </div>',
    '        <div class="pane" data-pane="checklist">',
    '          <div class="card">',
    '            <h2>✅ 交付验收清单</h2>',
    '            <ul id="checklist" style="list-style:none;margin:0;padding:0"></ul>',
    '            <div style="display:flex;gap:8px;margin-top:10px"><input id="newItem" placeholder="追加一条检查项，回车添加" style="flex:1;border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit" /><button type="button" class="btn primary" id="addItem">添加</button></div>',
    '          </div>',
    '        </div>',
    '      </section>',
    '    </main>',
    `    <script>${OPS_JS}</script>`,
    '  </body>',
    '</html>',
  ].join('\n');
}

/**
 * The stand-in for a code-shaped delivery when the mandate is not a known game: a real,
 * runnable page derived from the brief itself — a content console for content briefs, a target/
 * checklist console for everything else. Never a bare `textContent = "<step>"` page again.
 */
export function webScaffold(name: string, goal: string): string {
  return scaffoldFamilyOf(`${name}\n${goal}`) === 'content' ? contentPage(name, goal) : opsPage(name, goal);
}

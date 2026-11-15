import { CONTENT_PLATFORMS, PLATFORM_BRIEFS } from './content-studio.js';

/**
 * The 一鱼多吃 workbench, served by the API itself.
 *
 * It is a page, not a screenshot and not a second console: one source material, four platforms,
 * and the copy comes back from `/api/content/generate` — the real model, in real time. Nothing on
 * this page contains platform copy of its own, so a generation that produced nothing is visible
 * as an empty card rather than hidden behind a template. Every asset carries its provenance
 * (`LLM · <model>` or `模板 · mock`), which is the distinction the brief requires.
 *
 * Served from the same origin as the API on purpose: the page needs no build step, no CORS
 * configuration and no API key in the browser.
 */
export function contentStudioPage(): string {
  const briefs = CONTENT_PLATFORMS.map((id) => PLATFORM_BRIEFS[id]);
  const platformMarkup = briefs
    .map(
      (brief) =>
        `<label class="pick"><input type="checkbox" value="${brief.id}" checked>`
        + `<span><b>${brief.name}</b><small>${brief.kind} · 平台原生格式</small></span></label>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>一鱼多吃 · 多平台文案工坊</title>
<style>
:root{--ink:#0f172a;--soft:#475569;--muted:#64748b;--line:#e2e8f0;--bg:#f5f7fa;--card:#fff;--accent:#1f7a5a;--accent-soft:#e6f4ee;--warn:#a15c00;--warn-soft:#fff4e0}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 Inter,system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:center;gap:16px;padding:16px 22px;background:#0f172a;color:#e2e8f0}
header h1{font-size:17px;margin:0}
header p{margin:2px 0 0;font-size:12px;color:#94a3b8}
.prov{margin-left:auto;font-size:12px;padding:4px 10px;border-radius:999px;background:#1e293b;color:#cbd5e1}
.prov.live{background:#123a2c;color:#7ff0bd}
.prov.mock{background:#3a2c12;color:#ffd28a}
main{display:grid;grid-template-columns:320px 1fr;gap:16px;padding:16px 20px;max-width:1500px;margin:auto}
@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
h2{font-size:13px;margin:0 0 10px;color:var(--soft);letter-spacing:.04em}
textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px;font:inherit;font-size:13px;resize:vertical;background:#fff;color:var(--ink)}
#source{min-height:170px}
.pick{display:flex;gap:8px;align-items:flex-start;padding:7px 4px;border-bottom:1px dashed var(--line);cursor:pointer}
.pick:last-of-type{border-bottom:0}
.pick b{display:block;font-size:13px}
.pick small{display:block;color:var(--muted);font-size:11px;line-height:1.45}
button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.hint{font-size:11px;color:var(--muted)}
#status{font-size:12px;color:var(--soft);margin-top:8px;min-height:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:12px;background:#fff;display:flex;flex-direction:column;overflow:hidden}
.card header{background:#f8fafc;color:var(--ink);padding:9px 12px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--line)}
.card header b{font-size:13px}
.card header small{color:var(--muted);font-size:11px}
.badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--warn-soft);color:var(--warn)}
.badge.live{background:var(--accent-soft);color:var(--accent)}
.badge.ok{background:#e7f6ee;color:#0f7a45}
.card textarea{flex:1;border:0;border-radius:0;min-height:210px;font-size:12.5px;line-height:1.65}
.card .foot{display:flex;gap:6px;padding:8px;border-top:1px solid var(--line);align-items:center}
.card .count{margin-left:auto;font-size:11px;color:var(--muted)}
.empty{color:var(--muted);font-size:13px;padding:24px;text-align:center;border:1px dashed var(--line);border-radius:12px}
.preview{white-space:pre-wrap;font-size:12px;color:var(--soft);max-height:180px;overflow:auto;margin:0}
</style>
</head>
<body>
<header>
  <div>
    <h1>一鱼多吃 · 多平台文案工坊</h1>
    <p>一份素材 → 四个平台的原生文案。文案由真实模型逐平台生成，可修改、审核、导出。</p>
  </div>
  <span class="prov" id="provenance">尚未生成</span>
</header>
<main>
  <section>
    <h2>1 · 源素材</h2>
    <textarea id="source" placeholder="粘贴一篇长文、一段发布会记录或产品资料……"></textarea>
    <div class="row"><span class="hint" id="sourceCount">0 字</span></div>
    <h2 style="margin-top:16px">2 · 目标平台</h2>
    ${platformMarkup}
    <div class="row">
      <button class="primary" id="generate">生成四个平台文案</button>
      <button id="clear">清空</button>
    </div>
    <div id="status" class="hint">选择平台后点击生成；每次生成都是一次真实的模型调用。</div>
  </section>
  <section>
    <h2>3 · 平台文案（可编辑 / 审核 / 导出）</h2>
    <div id="grid" class="grid">
      <div class="empty" id="empty">生成后，每个平台一张卡片。卡片里只会有模型返回的内容。</div>
    </div>
    <div class="row">
      <button id="exportJson" disabled>导出 JSON</button>
      <button id="exportMarkdown" disabled>导出 Markdown</button>
      <span class="hint" id="approved">已审核 0 / 0</span>
    </div>
  </section>
</main>
<script>
(function () {
  var state = { assets: [], approved: {}, provenance: null, provider: null, model: null, calls: 0 };
  var $ = function (id) { return document.getElementById(id); };

  function sourceText() { return $('source').value.trim(); }
  function checkedPlatforms() {
    return Array.prototype.slice.call(document.querySelectorAll('.pick input:checked')).map(function (input) { return input.value; });
  }
  function updateSourceCount() { $('sourceCount').textContent = String(sourceText().length) + ' 字'; }

  function setProvenance(result) {
    var pill = $('provenance');
    var live = result.provenance === 'live';
    state.provider = result.provider || null;
    state.model = result.model || null;
    state.calls = result.calls || 0;
    pill.className = 'prov ' + (live ? 'live' : 'mock');
    pill.textContent = live
      ? 'LLM · ' + (result.provider || 'provider') + ' / ' + (result.model || 'model') + ' · ' + result.calls + ' 次调用'
      : '模板 · mock（未调用真实模型）';
  }

  function render() {
    var grid = $('grid');
    grid.innerHTML = '';
    $('exportJson').disabled = state.assets.length === 0;
    $('exportMarkdown').disabled = state.assets.length === 0;
    if (state.assets.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = state.provenance === null
        ? '生成后，每个平台一张卡片。卡片里只会有模型返回的内容。'
        : '模型没有返回任何文案：这张卡片没有内容可显示，也没有用模板填补。';
      grid.appendChild(empty);
      $('approved').textContent = '已审核 0 / 0';
      return;
    }
    state.assets.forEach(function (asset, index) {
      var card = document.createElement('article');
      card.className = 'card';
      var head = document.createElement('header');
      var name = document.createElement('b');
      name.textContent = asset.name;
      var kind = document.createElement('small');
      kind.textContent = asset.kind;
      var badge = document.createElement('span');
      badge.className = 'badge ' + (state.provenance === 'live' ? 'live' : '');
      badge.textContent = state.provenance === 'live' ? 'LLM' : '模板';
      var approvedBadge = document.createElement('span');
      approvedBadge.className = 'badge ' + (state.approved[asset.platform] ? 'ok' : '');
      approvedBadge.textContent = state.approved[asset.platform] ? '已审核' : '待审核';
      head.appendChild(name); head.appendChild(kind); head.appendChild(badge); head.appendChild(approvedBadge);

      var body = document.createElement('textarea');
      body.value = asset.text;
      body.addEventListener('input', function () { asset.text = body.value; count(); });

      var foot = document.createElement('div');
      foot.className = 'foot';
      var approve = document.createElement('button');
      approve.textContent = state.approved[asset.platform] ? '撤销审核' : '通过审核';
      approve.addEventListener('click', function () {
        state.approved[asset.platform] = !state.approved[asset.platform];
        render();
      });
      var copy = document.createElement('button');
      copy.textContent = '复制';
      copy.addEventListener('click', function () {
        if (navigator.clipboard) navigator.clipboard.writeText(asset.text);
      });
      var countEl = document.createElement('span');
      countEl.className = 'count';
      countEl.setAttribute('data-count', asset.platform);
      countEl.textContent = String(asset.text.length) + ' 字';
      foot.appendChild(approve); foot.appendChild(copy); foot.appendChild(countEl);

      card.appendChild(head); card.appendChild(body); card.appendChild(foot);
      grid.appendChild(card);
    });
    count();
  }

  function count() {
    var approvedCount = state.assets.filter(function (asset) { return state.approved[asset.platform]; }).length;
    $('approved').textContent = '已审核 ' + approvedCount + ' / ' + state.assets.length;
    state.assets.forEach(function (asset) {
      var el = document.querySelector('[data-count="' + asset.platform + '"]');
      if (el) el.textContent = String(asset.text.length) + ' 字';
    });
  }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = name;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  $('source').addEventListener('input', updateSourceCount);
  $('clear').addEventListener('click', function () {
    $('source').value = ''; state.assets = []; state.approved = {}; state.provenance = null;
    $('provenance').className = 'prov'; $('provenance').textContent = '尚未生成';
    $('status').textContent = '已清空。'; updateSourceCount(); render();
  });
  $('generate').addEventListener('click', function () {
    var source = sourceText();
    var platforms = checkedPlatforms();
    if (source === '') { $('status').textContent = '请先粘贴源素材。'; return; }
    if (platforms.length === 0) { $('status').textContent = '至少选择一个平台。'; return; }
    var button = $('generate');
    button.disabled = true;
    $('status').textContent = '正在调用模型生成 ' + platforms.length + ' 个平台的文案……';
    state.approved = {};
    fetch('/api/content/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: source, platforms: platforms })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = {};
        try { payload = JSON.parse(text); } catch (error) { payload = { error: text }; }
        if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
        return payload;
      });
    }).then(function (result) {
      state.assets = result.assets || [];
      state.provenance = result.provenance;
      state.calls = result.calls;
      setProvenance(result);
      $('status').textContent = '已完成：' + state.assets.length + ' 个平台，' + result.calls + ' 次模型调用。文案可直接修改后审核、导出。';
      render();
    }).catch(function (error) {
      state.assets = [];
      $('status').textContent = '生成失败：' + error.message;
      render();
    }).then(function () {
      button.disabled = false;
    });
  });
  $('exportJson').addEventListener('click', function () {
    download('content-assets.json', JSON.stringify({
      source: sourceText(),
      provenance: state.provenance,
      provider: state.provider,
      model: state.model,
      calls: state.calls,
      assets: state.assets.map(function (asset) {
        return { platform: asset.platform, name: asset.name, kind: asset.kind, approved: !!state.approved[asset.platform], text: asset.text };
      })
    }, null, 2), 'application/json');
  });
  $('exportMarkdown').addEventListener('click', function () {
    var lines = ['# 一鱼多吃 · 多平台文案', '', '> 生成方式：' + (state.provenance === 'live' ? 'LLM' : '模板（mock）'), ''];
    state.assets.forEach(function (asset) {
      lines.push('## ' + asset.name + ' · ' + asset.kind + (state.approved[asset.platform] ? '（已审核）' : ''));
      lines.push('');
      lines.push(asset.text);
      lines.push('');
    });
    download('content-assets.md', lines.join('\\n'), 'text/markdown');
  });

  updateSourceCount();
  render();
  document.documentElement.setAttribute('data-maoeh-ready', '1');
})();
</script>
</body>
</html>`;
}

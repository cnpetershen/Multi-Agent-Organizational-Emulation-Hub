/**
 * 赛博沙盘 workbench, served by the API.
 *
 * It replaces the manual shell (`apps/web/public/sandbox.html`): no role switching, no typing,
 * no client-side score. The operator sets a topic and a round count, four real agents speak in
 * turn, and the page renders the transcript and the evaluator's grounded scoring that came back
 * from the session. Every line shown here is a `Communication.MessageSent` fact from the sandbox
 * runtime's own event log — the page adds no text of its own to the transcript.
 *
 * Historical sessions are read back through the same API, so "保存和回看" is a read of the log,
 * not a browser localStorage copy.
 */
export function sandboxPage(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>赛博沙盘 · 多角色对抗质询</title>
<style>
:root{--ink:#e8eef4;--soft:#9fb0c0;--line:#263340;--bg:#0b1015;--card:#111a22;--accent:#39b77b;--warn:#e7b05a;--bad:#e27878}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line);background:#0e151c}
header h1{font-size:17px;margin:0}
header p{margin:2px 0 0;font-size:12px;color:var(--soft)}
.prov{margin-left:auto;font-size:12px;padding:3px 10px;border-radius:999px;background:#1c2a35;color:var(--soft)}
.prov.live{background:#123a2c;color:#7ff0bd}
.prov.mock{background:#3a2c12;color:#ffd28a}
main{display:grid;grid-template-columns:340px 1fr;gap:14px;padding:14px 18px;max-width:1500px;margin:auto}
@media(max-width:980px){main{grid-template-columns:1fr}}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
h2{font-size:12px;letter-spacing:.05em;color:var(--soft);margin:0 0 10px;font-weight:600}
textarea{width:100%;min-height:110px;background:#0a1118;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:9px;font:inherit;font-size:13px;resize:vertical}
input{width:100%;background:#0a1118;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px 9px;font:inherit;font-size:13px}
select{background:#0a1118;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit;font-size:13px}
button{border:1px solid #2f6f52;background:#1e704b;color:#fff;border-radius:7px;padding:7px 12px;font:inherit;cursor:pointer}
button.g{background:transparent;color:var(--soft);border-color:var(--line)}
button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.hint{font-size:11px;color:var(--soft)}
.roles{display:grid;gap:6px;margin-top:6px}
.role{display:flex;gap:8px;align-items:baseline;border:1px solid var(--line);border-radius:6px;padding:6px 8px;font-size:12px}
.role b{color:#7ff0bd}
.role small{color:var(--soft)}
.turns{display:grid;gap:8px;max-height:520px;overflow:auto;padding-right:4px}
.turn{border-left:3px solid #4d7ea8;background:#0d151d;border-radius:6px;padding:8px 10px}
.turn.challenger{border-color:var(--bad)}
.turn.defender{border-color:var(--warn)}
.turn.evaluator{border-color:var(--accent)}
.turn header{all:unset;display:flex;gap:8px;align-items:baseline;font-size:11px;color:var(--soft)}
.turn header b{color:var(--ink);font-size:12px}
.turn p{margin:4px 0 0;white-space:pre-wrap;font-size:13px}
.turn .mid{font-family:ui-monospace,Consolas,monospace;font-size:10px;color:#6b8296}
.scores table{width:100%;border-collapse:collapse;font-size:12px}
.scores td,.scores th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
.scores th{color:var(--soft);font-weight:400}
.badge{font-size:10px;padding:1px 7px;border-radius:999px;background:#1c2a35;color:var(--soft)}
.badge.ok{background:#123a2c;color:#7ff0bd}
.badge.warn{background:#3a2c12;color:#ffd28a}
.total{font-size:26px;font-weight:700;color:#7ff0bd}
.sessions{display:grid;gap:6px}
.session{display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:6px;padding:7px 9px;font-size:12px;cursor:pointer}
.session:hover{border-color:#3a5165}
.session b{font-weight:600}
.session small{margin-left:auto;color:var(--soft)}
.empty{color:var(--soft);font-size:13px;padding:18px;text-align:center;border:1px dashed var(--line);border-radius:8px}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent);animation:p 1.2s infinite}
@keyframes p{0%,100%{opacity:.25}50%{opacity:1}}
.field{display:grid;gap:4px;margin:8px 0;font-size:11px;color:var(--soft)}
.field textarea{min-height:64px;font-size:12px}
.field input{font-size:12px}
.preview{white-space:pre-wrap;max-height:220px;overflow:auto;background:#0a1118;border:1px solid var(--line);border-radius:8px;padding:8px;font-size:11px;color:var(--soft);margin:8px 0}
.warn-list{margin:6px 0 0;padding-left:16px;color:var(--warn);font-size:11px}
</style>
</head>
<body>
<header>
  <div>
    <h1>赛博沙盘 · 多角色对抗质询</h1>
    <p>输入一个议题，提案方 / 质询方 / 答辩方三个真实 Agent 逐轮发言，评审 Agent 给出带依据的评分。</p>
  </div>
  <span class="prov" id="prov">尚未开始</span>
</header>
<main>
  <div style="display:grid;gap:14px;align-content:start">
    <section>
      <h2>1 · 议题</h2>
      <textarea id="topic" placeholder="例如：我们要不要把这套多 Agent 组织仿真平台做成面向高校的课程实验平台？"></textarea>
      <div class="row">
        <label class="hint">回合 <select id="rounds"><option>1</option><option selected>2</option><option>3</option></select></label>
        <button id="start">开始对抗质询</button>
      </div>
      <div class="hint" id="status" style="margin-top:8px">一次会话约 7-10 次真实模型调用，可能需要 1-3 分钟。</div>
    </section>
    <section>
      <h2>2 · 参与角色（来自真实组织）</h2>
      <div class="roles" id="roles"><div class="empty">开始后显示本次分会角色。</div></div>
    </section>
    <section>
      <h2>3 · 历史会话</h2>
      <div class="sessions" id="sessions"><div class="empty">加载中……</div></div>
    </section>
  </div>
  <div style="display:grid;gap:14px;align-content:start">
    <section>
      <h2>4 · 实时 transcript（每条都是一个真实消息事件）</h2>
      <div class="turns" id="turns"><div class="empty">还没有会话。</div></div>
    </section>
    <section class="scores" id="scoreSection" hidden>
      <h2>5 · 评审结果（每条评分都指向具体发言）</h2>
      <div id="scores"></div>
    </section>
    <section id="briefSection" hidden>
      <h2>6 · 转为任务书（草稿，确认后才提交）</h2>
      <p class="hint" id="briefStatus">可以将会话转为任务书；草稿可修改，确认后才提交。</p>
      <div id="briefForm" hidden>
        <label class="field">标题<input id="briefTitle" maxlength="200"></label>
        <label class="field">目标（会追加所需能力，供组织路由）<textarea id="briefGoal"></textarea></label>
        <label class="field">任务拆分（每行一条）<textarea id="briefRequirements"></textarea></label>
        <label class="field">所需能力（逗号分隔）<input id="briefCapabilities"></label>
        <label class="field">约束（每行一条）<textarea id="briefConstraints"></textarea></label>
        <label class="field">验收标准（每行一条）<textarea id="briefAcceptance"></textarea></label>
        <label class="field">验收键（逗号分隔）<input id="briefKeys"></label>
        <label class="field">补充说明（可选）<textarea id="briefNotes"></textarea></label>
        <div class="field">提交时的上下文预览<pre class="preview" id="briefContext"></pre></div>
      </div>
      <div class="row">
        <button id="briefDraft">生成任务书草稿</button>
        <button id="briefConfirm" hidden>确认并提交任务书</button>
      </div>
      <p class="hint">提交后，CEO 会在下一拍把任务书分解为能力工作流；工作流仍需你在画布上确认，未确认不会执行。</p>
    </section>
  </div>
</main>
<script>
(function () {
  var current = null;
  var $ = function (id) { return document.getElementById(id); };
  var ROLE_LABEL = { proposer: '提案方', challenger: '质询方', defender: '答辩方', evaluator: '评审' };

  function setProv(session) {
    var pill = $('prov');
    if (!session) { pill.className = 'prov'; pill.textContent = '尚未开始'; return; }
    var live = session.provenance === 'live';
    pill.className = 'prov ' + (live ? 'live' : 'mock');
    pill.textContent = live
      ? 'LLM · ' + (session.provider || 'provider') + ' / ' + (session.model || 'model')
      : '模板 · mock（未调用真实模型）';
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderRoles(session) {
    var box = $('roles');
    box.innerHTML = '';
    var roles = session.roles && session.roles.length ? session.roles : [];
    if (!roles.length) { box.appendChild(el('div', 'empty', '该历史会话没有记录角色分配。')); return; }
    roles.forEach(function (role) {
      var row = el('div', 'role');
      row.appendChild(el('b', '', ROLE_LABEL[role.role] || role.role));
      row.appendChild(el('span', '', role.name));
      row.appendChild(el('small', '', role.title || ''));
      box.appendChild(row);
    });
  }

  function renderTurns(session) {
    var box = $('turns');
    box.innerHTML = '';
    if (!session.turns.length) { box.appendChild(el('div', 'empty', '还没有发言。')); return; }
    session.turns.forEach(function (turn) {
      var card = el('article', 'turn ' + turn.role);
      var head = el('header');
      head.appendChild(el('b', '', (ROLE_LABEL[turn.role] || turn.role) + ' · ' + turn.name));
      head.appendChild(el('span', '', turn.title || ''));
      head.appendChild(el('span', 'mid', turn.messageId));
      card.appendChild(head);
      card.appendChild(el('p', '', turn.body));
      box.appendChild(card);
    });
  }

  function renderScores(session) {
    var section = $('scoreSection');
    var box = $('scores');
    box.innerHTML = '';
    if (!session.scores) {
      section.hidden = session.scoringRaw === null;
      if (session.scoringRaw !== null) {
        box.appendChild(el('div', 'empty', '评审返回的内容不是可解析的评分 JSON，原始内容见 transcript 最后一条。'));
      }
      return;
    }
    section.hidden = false;
    var head = el('div', 'row');
    head.appendChild(el('span', 'total', String(session.scores.total)));
    head.appendChild(el('span', 'hint', '/ 100 · ' + session.scores.verdict));
    box.appendChild(head);
    var table = el('table');
    var thead = el('tr');
    ['维度', '分', '依据', '出处'].forEach(function (label) { thead.appendChild(el('th', '', label)); });
    table.appendChild(thead);
    session.scores.dimensions.forEach(function (dimension) {
      var tr = el('tr');
      tr.appendChild(el('td', '', dimension.name));
      tr.appendChild(el('td', '', String(dimension.score)));
      tr.appendChild(el('td', '', dimension.evidence));
      var cite = el('td');
      if (dimension.citedMessageId) {
        var badge = el('span', 'badge ok', dimension.citedMessageId);
        cite.appendChild(badge);
      } else {
        cite.appendChild(el('span', 'badge warn', '未引用具体发言'));
      }
      tr.appendChild(cite);
      table.appendChild(tr);
    });
    box.appendChild(table);
    box.appendChild(el('p', 'hint', session.scores.rationale));
    box.appendChild(el('p', 'hint', '会话耗时 ' + Math.round(session.durationMs / 1000) + ' 秒 · ' + session.turns.length + ' 条消息 · 来源：事件日志'));
  }

  function show(session) {
    current = session;
    setProv(session);
    renderRoles(session);
    renderTurns(session);
    renderScores(session);
    $('briefSection').hidden = false;
    $('briefForm').hidden = true;
    $('briefConfirm').hidden = true;
    $('briefDraft').hidden = false;
    $('briefStatus').className = 'hint';
    $('briefStatus').textContent = '可以将会话转为任务书；草稿可修改，确认后才提交。';
  }

  function splitLines(id) {
    return $(id).value.split('\n').map(function (line) { return line.trim(); }).filter(function (line) { return line !== ''; });
  }
  function splitList(id) {
    return $(id).value.split(/[,，]/).map(function (item) { return item.trim(); }).filter(function (item) { return item !== ''; });
  }

  function fillBrief(draft) {
    $('briefTitle').value = draft.title;
    $('briefGoal').value = draft.goal;
    $('briefRequirements').value = (draft.requirements || []).join('\n');
    $('briefCapabilities').value = (draft.capabilities || []).join(', ');
    $('briefConstraints').value = (draft.constraints || []).join('\n');
    $('briefAcceptance').value = (draft.acceptanceCriteria || []).join('\n');
    $('briefKeys').value = (draft.verificationKeys || []).join(', ');
    $('briefNotes').value = draft.notes || '';
    $('briefContext').textContent = draft.context || '';
    $('briefForm').hidden = false;
    $('briefConfirm').hidden = false;
    $('briefDraft').hidden = true;
    var warnings = draft.warnings || [];
    $('briefStatus').className = warnings.length ? 'warn-list' : 'hint';
    $('briefStatus').textContent = warnings.length
      ? warnings.join(' ')
      : '草稿已生成。确认前不会提交任何命令。';
  }

  function readJson(response) {
    return response.text().then(function (text) {
      var payload = {};
      try { payload = JSON.parse(text); } catch (error) { payload = { error: text }; }
      if (!response.ok) {
        var failure = new Error(payload.message || payload.error || ('HTTP ' + response.status));
        failure.payload = payload;
        throw failure;
      }
      return payload;
    });
  }

  function briefBody() {
    return {
      confirm: true,
      title: $('briefTitle').value.trim(),
      goal: $('briefGoal').value.trim(),
      requirements: splitLines('briefRequirements'),
      capabilities: splitList('briefCapabilities'),
      constraints: splitLines('briefConstraints'),
      acceptanceCriteria: splitLines('briefAcceptance'),
      verificationKeys: splitList('briefKeys'),
      notes: $('briefNotes').value.trim()
    };
  }

  function loadSessions() {
    fetch('/api/sandbox/sessions').then(function (response) { return response.json(); }).then(function (payload) {
      var box = $('sessions');
      box.innerHTML = '';
      var sessions = (payload && payload.sessions) || [];
      if (!sessions.length) { box.appendChild(el('div', 'empty', '还没有历史会话。')); return; }
      sessions.forEach(function (session) {
        var row = el('div', 'session');
        row.appendChild(el('b', '', session.topic.length > 34 ? session.topic.slice(0, 34) + '…' : session.topic));
        row.appendChild(el('span', 'badge ' + (session.scores ? 'ok' : 'warn'), session.scores ? ('评分 ' + session.scores.total) : '无评分'));
        row.appendChild(el('small', '', session.startedAt.slice(0, 16).replace('T', ' ')));
        row.addEventListener('click', function () {
          fetch('/api/sandbox/sessions/' + encodeURIComponent(session.sessionId))
            .then(function (response) { return response.json(); })
            .then(function (full) { if (full && full.sessionId) show(full); });
        });
        box.appendChild(row);
      });
    }).catch(function () {
      $('sessions').innerHTML = '';
      $('sessions').appendChild(el('div', 'empty', '历史会话加载失败。'));
    });
  }

  $('start').addEventListener('click', function () {
    var topic = $('topic').value.trim();
    if (topic === '') { $('status').textContent = '请先填写议题。'; return; }
    var rounds = Number($('rounds').value);
    var button = $('start');
    button.disabled = true;
    $('turns').innerHTML = '';
    $('turns').appendChild(el('div', 'empty', '三个 Agent 正在逐轮发言，评审随后打分……'));
    $('scoreSection').hidden = true;
    var startedAt = Date.now();
    $('status').innerHTML = '<span class="pulse"></span> 会话进行中，已用 0 秒（请勿关闭页面）';
    var timer = setInterval(function () {
      var seconds = Math.round((Date.now() - startedAt) / 1000);
      $('status').innerHTML = '<span class="pulse"></span> 会话进行中，已用 ' + seconds + ' 秒（请勿关闭页面）';
    }, 1000);
    fetch('/api/sandbox/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: topic, rounds: rounds })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = {};
        try { payload = JSON.parse(text); } catch (error) { payload = { error: text }; }
        if (!response.ok) throw new Error(payload.message || payload.error || ('HTTP ' + response.status));
        return payload;
      });
    }).then(function (session) {
      show(session);
      var cited = session.scores ? session.scores.dimensions.filter(function (d) { return d.citedMessageId; }).length : 0;
      $('status').textContent = '会话完成：' + session.turns.length + ' 条消息，'
        + (session.scores ? ('评分 ' + session.scores.total + ' / 100，' + cited + '/' + session.scores.dimensions.length + ' 条评分引用了具体发言') : '评分未能解析');
      loadSessions();
    }).catch(function (error) {
      $('status').textContent = '会话失败：' + error.message;
      $('turns').innerHTML = '';
      $('turns').appendChild(el('div', 'empty', '没有产生可展示的会话。失败原因：' + error.message));
    }).then(function () {
      clearInterval(timer);
      button.disabled = false;
    });
  });

  $('briefDraft').addEventListener('click', function () {
    if (!current) { $('briefStatus').textContent = '请先打开一个会话。'; return; }
    var button = $('briefDraft');
    button.disabled = true;
    $('briefStatus').className = 'hint';
    $('briefStatus').textContent = '正在从会话生成草稿……';
    fetch('/api/sandbox/sessions/' + encodeURIComponent(current.sessionId) + '/brief')
      .then(readJson)
      .then(function (payload) {
        fillBrief(payload.draft);
        if (payload.submitted) {
          $('briefConfirm').hidden = true;
          $('briefStatus').textContent = '该会话已转为任务书 ' + payload.submitted.briefId + '，不会重复创建。';
        }
      })
      .catch(function (error) {
        $('briefStatus').className = 'warn-list';
        $('briefStatus').textContent = '生成草稿失败：' + error.message;
        if (error.payload && error.payload.briefId) {
          $('briefStatus').textContent += '（已有任务书 ' + error.payload.briefId + '）';
        }
      })
      .then(function () { button.disabled = false; });
  });

  $('briefConfirm').addEventListener('click', function () {
    if (!current) { $('briefStatus').textContent = '请先打开一个会话。'; return; }
    var button = $('briefConfirm');
    button.disabled = true;
    $('briefStatus').className = 'hint';
    $('briefStatus').textContent = '正在提交任务书……';
    fetch('/api/sandbox/sessions/' + encodeURIComponent(current.sessionId) + '/brief', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(briefBody())
    }).then(readJson).then(function (payload) {
      $('briefStatus').className = 'hint';
      var briefId = payload.submitted && payload.submitted.briefId ? payload.submitted.briefId : '（已受理）';
      $('briefStatus').textContent = '任务书已提交：' + briefId
        + '。CEO 会在下一拍把它分解为能力工作流；工作流仍需你在画布上确认，未确认不会执行。';
      $('briefConfirm').hidden = true;
      $('briefForm').hidden = true;
    }).catch(function (error) {
      $('briefStatus').className = 'warn-list';
      $('briefStatus').textContent = '提交失败：' + error.message;
      if (error.payload && error.payload.briefId) {
        $('briefStatus').textContent += '（已有任务书 ' + error.payload.briefId + '）';
      }
    }).then(function () { button.disabled = false; });
  });

  loadSessions();
  // Readiness marker: the inline script attaches its listeners before this runs, so a browser
  // test (or a person with a slow machine) can wait for "the workbench is operable" instead of
  // racing the first paint of the markup.
  document.documentElement.setAttribute('data-maoeh-ready', '1');
})();
</script>
</body>
</html>`;
}

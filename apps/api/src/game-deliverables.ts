/**
 * Real, runnable game artifacts for the deterministic stand-in cognition.
 *
 * `deterministic-cognition.ts` cannot author an arbitrary model's work product, but the platform's
 * own product-level acceptance is a game mandate ("写一个 Web 端的贪吃蛇小游戏",
 * "开发一个俄罗斯方块程序"). The stand-in used to answer every code-shaped step with a generic
 * `webScaffold` page whose only content was `app.textContent = "<step name>"` — the workflow
 * finished and the delivery page showed a page that did nothing, which is exactly the reported
 * "只有一系列步骤、游戏没写出来".
 *
 * For a game the organization ships a *known* product, so the stand-in can hand back a genuine,
 * self-contained, playable implementation instead of a placeholder. The page embeds the mandate
 * text it answers, so the delivery reads as *this* instruction's work and stays traceable on the
 * event log.
 *
 * This is deliberately a small, open catalog: an unknown mandate still falls back to the generic
 * scaffold in `deterministic-cognition.ts`. Adding a game is a data change (one entry + one page
 * builder), not a rewrite of the delivery contract.
 *
 * The pages also carry the client half of the product: when the mandate asks for a service that
 * records the plays (`leaderboard: true`), the finished game posts its score and renders the
 * shared board — see `product-deliverables.ts`, which decides that from the step's capability.
 */

export type GameKind = 'tetris' | 'snake';

interface GameCue {
  readonly kind: GameKind;
  readonly hints: readonly string[];
}

const GAME_CUES: readonly GameCue[] = Object.freeze([
  Object.freeze({
    kind: 'tetris',
    hints: Object.freeze(['tetris', '俄罗斯方块', '方块游戏', 'falling blocks']),
  }),
  Object.freeze({
    kind: 'snake',
    hints: Object.freeze(['snake', '贪吃蛇', '贪食蛇']),
  }),
]);

/** Which known game a mandate names, or `null` for the generic delivery shape. */
export function detectGame(text: string): GameKind | null {
  const lowered = text.toLowerCase();
  for (const entry of GAME_CUES) {
    if (entry.hints.some((hint) => lowered.includes(hint.toLowerCase()))) return entry.kind;
  }
  return null;
}

const GAME_DISPLAY_NAME: Readonly<Record<GameKind, string>> = Object.freeze({
  tetris: '俄罗斯方块 · Tetris',
  snake: '贪吃蛇 · Snake',
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const PAGE_STYLE = [
  ':root { color-scheme: dark; }',
  "* { box-sizing: border-box; }",
  'body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; align-items: center;',
  '  gap: 12px; padding: 20px; background: #0b0e14; color: #e6e9ef;',
  '  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }',
  'h1 { margin: 0; font-size: 20px; letter-spacing: .02em; }',
  '.goal { margin: 0; max-width: 640px; text-align: center; color: #9aa4b2; font-size: 13px; }',
  '.stage { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; justify-content: center; }',
  'canvas { background: #10141c; border: 1px solid #232a36; border-radius: 8px; display: block; }',
  '.hud { min-width: 120px; display: flex; flex-direction: column; gap: 8px; font-variant-numeric: tabular-nums; }',
  '.hud .row { display: flex; justify-content: space-between; gap: 12px; }',
  '.hud .label { color: #9aa4b2; }',
  '.status { min-height: 18px; color: #ffb74d; font-size: 13px; }',
  '.hint { color: #6b7280; font-size: 12px; line-height: 1.6; }',
].join('\n');

/**
 * The leaderboard half of a client that talks to the delivered score service.
 *
 * Only rendered when the product actually has a backend step. The client has to work in both
 * places an owner opens it from: served by the service (same origin → relative URLs) or opened
 * straight off disk (`file://` → the service's default address). Every failure path is copy, not
 * a stack trace: a delivered page must never look broken because a server is not running yet.
 */
const LEADERBOARD_STYLE = [
  '.board { width: min(420px, 100%); display: flex; flex-direction: column; gap: 8px; }',
  '.board h2 { margin: 0; font-size: 15px; letter-spacing: .04em; text-transform: uppercase; color: #9aa4b2; }',
  '.board .player { display: flex; align-items: center; gap: 8px; color: #9aa4b2; font-size: 12px; }',
  '.board .player input { flex: 1; border: 1px solid #232a36; border-radius: 6px; background: #10141c;',
  '  color: #e6e9ef; padding: 6px 8px; font: inherit; font-size: 13px; }',
  '.board-list { margin: 0; padding-left: 20px; color: #e6e9ef; font-size: 13px; line-height: 1.7; }',
].join('\n');

const LEADERBOARD_BODY = [
  '    <section class="board" aria-label="Leaderboard">',
  '      <h2>Leaderboard</h2>',
  '      <label class="player">Name <input id="player" maxlength="24" placeholder="Player" /></label>',
  '      <p class="status" id="board-status">Connecting to the score service…</p>',
  '      <ol class="board-list" id="board-list"></ol>',
  '    </section>',
].join('\n');

const LEADERBOARD_SCRIPT = [
  "const boardStatus = document.getElementById('board-status');",
  "const boardList = document.getElementById('board-list');",
  "const playerInput = document.getElementById('player');",
  "const API = (location.protocol === 'http:' || location.protocol === 'https:') ? '' : 'http://127.0.0.1:8000';",
  "function playerName() {",
  "  const raw = playerInput === null ? '' : String(playerInput.value || '').trim();",
  "  return raw === '' ? 'Player' : raw.slice(0, 24);",
  "}",
  "async function loadBoard() {",
  "  try {",
  "    const response = await fetch(API + '/api/scores?limit=10');",
  "    if (!response.ok) throw new Error('HTTP ' + response.status);",
  "    const payload = await response.json();",
  "    const rows = Array.isArray(payload.scores) ? payload.scores : [];",
  "    boardList.innerHTML = '';",
  "    rows.forEach(function (row, index) {",
  "      const item = document.createElement('li');",
  "      item.textContent = (index + 1) + '. ' + row.player + ' — ' + row.score;",
  "      boardList.appendChild(item);",
  "    });",
  "    boardStatus.textContent = rows.length === 0",
  "      ? 'No scores yet — the first finished game opens the board.'",
  "      : payload.players + ' player(s) · ' + payload.plays + ' play(s) recorded';",
  "  } catch (error) {",
  "    boardStatus.textContent = 'Score service offline — start it with: python server/app.py';",
  "  }",
  "}",
  "window.maoehScore = async function (entry) {",
  "  try {",
  "    const response = await fetch(API + '/api/scores', {",
  "      method: 'POST',",
  "      headers: { 'content-type': 'application/json' },",
  "      body: JSON.stringify({ player: playerName(), score: entry.score | 0, lines: entry.lines | 0 }),",
  "    });",
  "    if (!response.ok) throw new Error('HTTP ' + response.status);",
  "    const payload = await response.json();",
  "    boardStatus.textContent = 'Saved ' + playerName() + ' · rank #' + payload.rank + ' · best ' + payload.best;",
  "    loadBoard();",
  "  } catch (error) {",
  "    boardStatus.textContent = 'Score service offline — this play was not recorded.';",
  "  }",
  "};",
  "window.maoehReset = function () { if (boardStatus !== null) boardStatus.textContent = 'Playing as ' + playerName(); };",
  "loadBoard();",
].join('\n');

export interface GamePageOptions {
  /**
   * Ship the score-service client too: the finished game posts its score and the page renders the
   * shared leaderboard. Off by default — a standalone mandate has no service to talk to, and a
   * page that polls a backend nobody delivered would be a lie.
   */
  readonly leaderboard?: boolean;
}

/**
 * The generic page shell. Every game page is one self-contained HTML file with no network
 * dependency, so the delivered artifact runs the moment a browser opens it.
 */
function pageShell(input: {
  readonly kind: GameKind;
  readonly title: string;
  readonly goal: string;
  readonly body: string;
  readonly script: string;
  readonly leaderboard: boolean;
}): string {
  const display = GAME_DISPLAY_NAME[input.kind];
  const heading = input.title.trim() === '' || input.title.trim() === 'Delivery'
    ? display
    : `${display} · ${input.title.trim()}`;
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${escapeHtml(heading)}</title>`,
    '    <style>',
    PAGE_STYLE,
    ...(input.leaderboard ? [LEADERBOARD_STYLE] : []),
    '    </style>',
    '  </head>',
    '  <body>',
    `    <h1>${escapeHtml(heading)}</h1>`,
    `    <p class="goal">${escapeHtml(input.goal)}</p>`,
    input.body,
    ...(input.leaderboard ? [LEADERBOARD_BODY] : []),
    '    <script type="module">',
    ...(input.leaderboard ? [LEADERBOARD_SCRIPT] : []),
    input.script,
    '    </script>',
    '  </body>',
    '</html>',
  ].join('\n');
}

const TETRIS_SCRIPT = [
  "(function () {",
  "  var COLS = 10, ROWS = 20, BLOCK = 24;",
  "  var board = document.getElementById('board');",
  "  var ctx = board.getContext('2d');",
  "  var nextCanvas = document.getElementById('next');",
  "  var nctx = nextCanvas.getContext('2d');",
  "  var scoreEl = document.getElementById('score');",
  "  var linesEl = document.getElementById('lines');",
  "  var statusEl = document.getElementById('status');",
  "  var SHAPES = {",
  "    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],",
  "    J: [[1,0,0],[1,1,1],[0,0,0]],",
  "    L: [[0,0,1],[1,1,1],[0,0,0]],",
  "    O: [[1,1],[1,1]],",
  "    S: [[0,1,1],[1,1,0],[0,0,0]],",
  "    T: [[0,1,0],[1,1,1],[0,0,0]],",
  "    Z: [[1,1,0],[0,1,1],[0,0,0]]",
  "  };",
  "  var COLORS = { I:'#4dd0e1', J:'#5c6bc0', L:'#ffb74d', O:'#fff176', S:'#81c784', T:'#ba68c8', Z:'#e57373' };",
  "  var KEYS = Object.keys(SHAPES);",
  "  var grid, current, next, dropCounter, dropInterval, lastTime, score, lines, over;",
  "  function emptyGrid() {",
  "    var g = [];",
  "    for (var y = 0; y < ROWS; y++) { var row = []; for (var x = 0; x < COLS; x++) row.push(null); g.push(row); }",
  "    return g;",
  "  }",
  "  function randomPiece() {",
  "    var key = KEYS[Math.floor(Math.random() * KEYS.length)];",
  "    var matrix = SHAPES[key].map(function (r) { return r.slice(); });",
  "    return { key: key, matrix: matrix, x: Math.floor((COLS - matrix[0].length) / 2), y: 0 };",
  "  }",
  "  function collide(piece, g) {",
  "    var m = piece.matrix;",
  "    for (var y = 0; y < m.length; y++) for (var x = 0; x < m[y].length; x++) {",
  "      if (!m[y][x]) continue;",
  "      var bx = piece.x + x, by = piece.y + y;",
  "      if (bx < 0 || bx >= COLS || by >= ROWS) return true;",
  "      if (by >= 0 && g[by][bx]) return true;",
  "    }",
  "    return false;",
  "  }",
  "  function rotate(matrix) {",
  "    var n = matrix.length;",
  "    var out = [];",
  "    for (var y = 0; y < n; y++) { var row = []; for (var x = 0; x < n; x++) row.push(0); out.push(row); }",
  "    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) out[j][n - 1 - i] = matrix[i][j];",
  "    return out;",
  "  }",
  "  function merge(piece, g) {",
  "    for (var y = 0; y < piece.matrix.length; y++) for (var x = 0; x < piece.matrix[y].length; x++) {",
  "      if (piece.matrix[y][x]) g[piece.y + y][piece.x + x] = piece.key;",
  "    }",
  "  }",
  "  function clearLines(g) {",
  "    var cleared = 0;",
  "    for (var y = ROWS - 1; y >= 0; y--) {",
  "      var full = true;",
  "      for (var x = 0; x < COLS; x++) if (!g[y][x]) { full = false; break; }",
  "      if (full) {",
  "        g.splice(y, 1);",
  "        var blank = []; for (var k = 0; k < COLS; k++) blank.push(null);",
  "        g.unshift(blank);",
  "        cleared++; y++;",
  "      }",
  "    }",
  "    return cleared;",
  "  }",
  "  function drawCell(c, x, y, size, color) {",
  "    c.fillStyle = color;",
  "    c.fillRect(x * size, y * size, size - 1, size - 1);",
  "  }",
  "  function drawBoard() {",
  "    ctx.fillStyle = '#10141c'; ctx.fillRect(0, 0, board.width, board.height);",
  "    for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) if (grid[y][x]) drawCell(ctx, x, y, BLOCK, COLORS[grid[y][x]]);",
  "    if (current) for (var cy = 0; cy < current.matrix.length; cy++) for (var cx = 0; cx < current.matrix[cy].length; cx++) {",
  "      if (current.matrix[cy][cx]) { var by = current.y + cy; if (by >= 0) drawCell(ctx, current.x + cx, by, BLOCK, COLORS[current.key]); }",
  "    }",
  "  }",
  "  function drawNext() {",
  "    nctx.fillStyle = '#10141c'; nctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);",
  "    if (!next) return;",
  "    var size = 16, m = next.matrix;",
  "    var offx = (nextCanvas.width - m[0].length * size) / 2, offy = (nextCanvas.height - m.length * size) / 2;",
  "    for (var y = 0; y < m.length; y++) for (var x = 0; x < m[y].length; x++) if (m[y][x]) {",
  "      nctx.fillStyle = COLORS[next.key];",
  "      nctx.fillRect(offx + x * size, offy + y * size, size - 1, size - 1);",
  "    }",
  "  }",
  "  function spawn() {",
  "    current = next; next = randomPiece();",
  "    if (collide(current, grid)) { over = true; statusEl.textContent = 'Game Over — press R to restart'; }",
  "    if (over && window.maoehScore) window.maoehScore({ score: score, lines: lines });",
  "    drawNext();",
  "  }",
  "  function drop() {",
  "    current.y++;",
  "    if (collide(current, grid)) {",
  "      current.y--; merge(current, grid);",
  "      var cleared = clearLines(grid);",
  "      if (cleared) {",
  "        score += [0, 100, 300, 500, 800][cleared] || 0;",
  "        lines += cleared; scoreEl.textContent = score; linesEl.textContent = lines;",
  "      }",
  "      spawn();",
  "    }",
  "    dropCounter = 0;",
  "  }",
  "  function move(dir) { current.x += dir; if (collide(current, grid)) current.x -= dir; }",
  "  function turn() { var old = current.matrix; current.matrix = rotate(current.matrix); if (collide(current, grid)) current.matrix = old; }",
  "  function hardDrop() { while (!collide(current, grid)) current.y++; current.y--; drop(); }",
  "  function reset() {",
  "    grid = emptyGrid(); score = 0; lines = 0; over = false;",
  "    dropCounter = 0; dropInterval = 800; lastTime = 0;",
  "    scoreEl.textContent = '0'; linesEl.textContent = '0'; statusEl.textContent = '';",
  "    if (window.maoehReset) window.maoehReset();",
  "    next = randomPiece(); spawn(); drawBoard();",
  "  }",
  "  function update(time) {",
  "    if (time === undefined) time = 0;",
  "    var delta = time - lastTime; lastTime = time;",
  "    if (!over) { dropCounter += delta; if (dropCounter > dropInterval) drop(); drawBoard(); }",
  "    requestAnimationFrame(update);",
  "  }",
  "  document.addEventListener('keydown', function (e) {",
  "    if (over && e.key !== 'r' && e.key !== 'R') return;",
  "    if (e.key === 'ArrowLeft') { move(-1); e.preventDefault(); }",
  "    else if (e.key === 'ArrowRight') { move(1); e.preventDefault(); }",
  "    else if (e.key === 'ArrowDown') { drop(); e.preventDefault(); }",
  "    else if (e.key === 'ArrowUp') { turn(); e.preventDefault(); }",
  "    else if (e.key === ' ') { hardDrop(); e.preventDefault(); }",
  "    else if (e.key === 'r' || e.key === 'R') { reset(); }",
  "    if (!over) drawBoard();",
  "  });",
  "  reset();",
  "  requestAnimationFrame(update);",
  "})();",
].join('\n');

const TETRIS_BODY = [
  '    <div class="stage">',
  '      <canvas id="board" width="240" height="480" aria-label="Tetris board"></canvas>',
  '      <div class="hud">',
  '        <div class="row"><span class="label">Score</span><span id="score">0</span></div>',
  '        <div class="row"><span class="label">Lines</span><span id="lines">0</span></div>',
  '        <canvas id="next" width="88" height="88" aria-label="Next piece"></canvas>',
  '        <div class="status" id="status"></div>',
  '        <div class="hint">← → move · ↑ rotate · ↓ drop · Space hard drop · R restart</div>',
  '      </div>',
  '    </div>',
].join('\n');

const SNAKE_SCRIPT = [
  "(function () {",
  "  var COLS = 20, ROWS = 20, CELL = 20;",
  "  var canvas = document.getElementById('board');",
  "  var ctx = canvas.getContext('2d');",
  "  var scoreEl = document.getElementById('score');",
  "  var statusEl = document.getElementById('status');",
  "  var snake, dir, nextDir, food, score, over, acc, lastTime;",
  "  function emptyCell() {",
  "    var taken = {};",
  "    snake.forEach(function (s) { taken[s.x + ',' + s.y] = true; });",
  "    var open = [];",
  "    for (var y = 0; y < ROWS; y++) for (var x = 0; x < COLS; x++) if (!taken[x + ',' + y]) open.push({ x: x, y: y });",
  "    if (open.length === 0) return null;",
  "    return open[Math.floor(Math.random() * open.length)];",
  "  }",
  "  function reset() {",
  "    snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];",
  "    dir = { x: 1, y: 0 }; nextDir = dir; score = 0; over = false; acc = 0; lastTime = 0;",
  "    scoreEl.textContent = '0'; statusEl.textContent = '';",
  "    if (window.maoehReset) window.maoehReset();",
  "    food = emptyCell(); draw();",
  "  }",
  "  function draw() {",
  "    ctx.fillStyle = '#10141c'; ctx.fillRect(0, 0, canvas.width, canvas.height);",
  "    ctx.fillStyle = '#e57373';",
  "    if (food) ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);",
  "    snake.forEach(function (s, i) {",
  "      ctx.fillStyle = i === 0 ? '#c6f6d5' : '#81c784';",
  "      ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);",
  "    });",
  "  }",
  "  function step() {",
  "    dir = nextDir;",
  "    var head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };",
  "    var hitWall = head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS;",
  "    var hitSelf = snake.some(function (s) { return s.x === head.x && s.y === head.y; });",
  "    if (hitWall || hitSelf) { over = true; statusEl.textContent = 'Game Over — press R to restart (score ' + score + ')'; if (window.maoehScore) window.maoehScore({ score: score, lines: 0 }); return; }",
  "    snake.unshift(head);",
  "    if (food && head.x === food.x && head.y === food.y) { score += 10; scoreEl.textContent = score; food = emptyCell(); }",
  "    else snake.pop();",
  "  }",
  "  function loop(time) {",
  "    if (time === undefined) time = 0;",
  "    var delta = time - lastTime; lastTime = time;",
  "    if (!over) { acc += delta; if (acc >= 110) { acc = 0; step(); draw(); } }",
  "    requestAnimationFrame(loop);",
  "  }",
  "  document.addEventListener('keydown', function (e) {",
  "    if (e.key === 'r' || e.key === 'R') { reset(); return; }",
  "    if (over) return;",
  "    if (e.key === 'ArrowLeft' && dir.x === 0) { nextDir = { x: -1, y: 0 }; e.preventDefault(); }",
  "    else if (e.key === 'ArrowRight' && dir.x === 0) { nextDir = { x: 1, y: 0 }; e.preventDefault(); }",
  "    else if (e.key === 'ArrowUp' && dir.y === 0) { nextDir = { x: 0, y: -1 }; e.preventDefault(); }",
  "    else if (e.key === 'ArrowDown' && dir.y === 0) { nextDir = { x: 0, y: 1 }; e.preventDefault(); }",
  "  });",
  "  reset();",
  "  requestAnimationFrame(loop);",
  "})();",
].join('\n');

const SNAKE_BODY = [
  '    <div class="stage">',
  '      <canvas id="board" width="400" height="400" aria-label="Snake board"></canvas>',
  '      <div class="hud">',
  '        <div class="row"><span class="label">Score</span><span id="score">0</span></div>',
  '        <div class="status" id="status"></div>',
  '        <div class="hint">Arrow keys to steer · R restart</div>',
  '      </div>',
  '    </div>',
].join('\n');

/**
 * One self-contained, playable page for the named game. `title` is the step's own name and
 * `goal` is the mandate text, both quoted on the page so the artifact reads as this job's work.
 *
 * With `options.leaderboard` the page also carries the client half of the delivered product: it
 * posts each finished play to the score service and renders the shared board. The flag is the
 * caller's decision because only the step that knows the product has a backend may claim one.
 */
export function gamePage(
  kind: GameKind,
  title: string,
  goal: string,
  options: GamePageOptions = {},
): string {
  const leaderboard = options.leaderboard === true;
  if (kind === 'tetris') {
    return pageShell({ kind, title, goal, body: TETRIS_BODY, script: TETRIS_SCRIPT, leaderboard });
  }
  return pageShell({ kind, title, goal, body: SNAKE_BODY, script: SNAKE_SCRIPT, leaderboard });
}

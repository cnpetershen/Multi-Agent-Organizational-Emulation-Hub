import { describe, expect, it } from 'vitest';
import {
  baseName,
  deliveryFilesFromData,
  extensionOf,
  fixedPortOf,
  looksLikeNodeHttpServer,
  looksLikePythonHttpServer,
  normalizePath,
  planArtifact,
  productNameOf,
  projectNameOf,
  readsPortFromEnv,
  readinessPathOf,
  type PlannedFile,
} from '../../../apps/api/src/preview-plan';

/**
 * The preview planner: *what* a delivery is and *how* to start it.
 *
 * Everything here is a pure function over the delivered bytes, so the decision "this is a
 * runnable web app and here is its entry point" is pinned without starting a process. Three
 * properties matter more than any individual case:
 *
 * - a delivery that is not a web app must be reported as such instead of being started as
 *   something it is not (a preview that hangs is worse than no preview);
 * - nothing may be keyed off a particular product — the cases below use the shapes a real
 *   delivery has, and a differently-named project must plan identically;
 * - the port must be *injectable* whenever the artifact reads it from the environment, because
 *   that is what stops two previews from colliding.
 */

/** The shape of the standard-library service this platform's deliveries ship. */
const PYTHON_SERVICE = [
  'import os',
  'from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer',
  'PORT = int(os.environ.get("PORT", "8000"))',
  'class Handler(SimpleHTTPRequestHandler):',
  '    pass',
  'def main():',
  '    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()',
].join('\n');

/**
 * The same service plus the health endpoint it really declares.
 *
 * The real delivered service states its routes in the module docstring (`GET /api/health`), and
 * that is exactly where the readiness probe has to find them.
 */
const PYTHON_SERVICE_HEALTH = [
  '"""Score service.',
  '',
  'Endpoints',
  '    GET  /api/health           -> {"ok": true}',
  '    GET  /api/scores?limit=10  -> {"scores": []}',
  '"""',
  PYTHON_SERVICE,
].join('\n');

const NODE_SERVICE = [
  "import { createServer } from 'node:http';",
  'const PORT = Number(process.env.PORT ?? 8000);',
  "createServer((request, response) => response.end('ok')).listen(PORT);",
].join('\n');

const RUN_LAUNCHER = [
  'import os',
  'import subprocess',
  'PORT = int(os.environ.get("PORT", "8000"))',
  'subprocess.Popen(["python", "server/app.py"])',
].join('\n');

function file(path: string, content: string): PlannedFile {
  return { path, content };
}

/** The delivered tree of the real product this feature was built for, by shape. */
function splitProduct(): readonly PlannedFile[] {
  return [
    file('run.py', RUN_LAUNCHER),
    file('README.md', '# Tetris Demo\n\nRequirement: a tetris program\n'),
    file('client/index.html', '<!doctype html><canvas id="board"></canvas><script>play()</script>'),
    file('client/README.md', '# client\n'),
    file('server/app.py', PYTHON_SERVICE_HEALTH),
    file('server/README.md', '# server\n'),
  ];
}

describe('recovering files from a delivery result', () => {
  const GAME_PAGE = '<!doctype html><html><canvas id="board"></canvas><script>play()</script></html>';

  it('reads the canonical files[] list and normalizes each path', () => {
    const files = deliveryFilesFromData({
      files: [
        { path: 'client\\index.html', language: 'html', content: GAME_PAGE },
        { path: './README.md', language: 'markdown', content: '# Play me\n' },
      ],
    });
    expect(files.map((file) => file.path)).toEqual(['client/index.html', 'README.md']);
    expect(files[0]?.language).toBe('html');
  });

  it('sees a single-file delivery exposed as an index.html data key', () => {
    const files = deliveryFilesFromData({ 'index.html': GAME_PAGE, playable: true, scoreboard: true });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'index.html', language: 'html', content: GAME_PAGE });
    const analysis = planArtifact(files, 'Tic-Tac-Toe');
    expect(analysis.plan?.plan).toBe('static');
    expect(analysis.plan?.entryPath).toBe('index.html');
  });

  it('reads entrypoint + content and names bare HTML content', () => {
    const entry = deliveryFilesFromData({ entrypoint: 'game/index.html', content: GAME_PAGE });
    expect(entry[0]?.path).toBe('game/index.html');
    const bare = deliveryFilesFromData({ content: GAME_PAGE });
    expect(bare[0]?.path).toBe('index.html');
  });

  it('keeps the richer record when the same path appears twice', () => {
    const files = deliveryFilesFromData({
      files: [{ path: 'index.html', language: 'html', content: GAME_PAGE }],
      'index.html': '<html>weaker duplicate</html>',
    });
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe(GAME_PAGE);
  });

  it('drops escaping paths instead of turning them into files on disk', () => {
    const files = deliveryFilesFromData({
      '../outside.html': GAME_PAGE,
      '/etc/passwd': 'root',
      'C:\\Windows\\win.ini': 'x',
    });
    expect(files).toHaveLength(0);
  });

  it('does not invent a file from ordinary delivery fields', () => {
    expect(deliveryFilesFromData({ passed: true, failures: [], test_report: 'all pass' })).toHaveLength(0);
    expect(deliveryFilesFromData(null)).toHaveLength(0);
    expect(deliveryFilesFromData([])).toHaveLength(0);
  });
});

describe('delivered path handling', () => {
  it('keeps an artifact-relative path and rejects anything that would escape it', () => {
    expect(normalizePath('client/index.html')).toBe('client/index.html');
    expect(normalizePath('server\\app.py')).toBe('server/app.py');
    expect(normalizePath('./run.py')).toBe('run.py');
    expect(normalizePath('/etc/passwd')).toBeNull();
    expect(normalizePath('C:\\Windows\\system32')).toBeNull();
    expect(normalizePath('../outside.py')).toBeNull();
    expect(normalizePath('a/../../b')).toBeNull();
    expect(normalizePath('')).toBeNull();
    expect(normalizePath('   ')).toBeNull();
  });

  it('reads a basename and an extension for the naming rules', () => {
    expect(baseName('server/app.py')).toBe('app.py');
    expect(baseName('run.py')).toBe('run.py');
    expect(extensionOf('client/index.html')).toBe('.html');
    expect(extensionOf('run.py')).toBe('.py');
    expect(extensionOf('README')).toBe('');
  });
});

describe('server evidence', () => {
  it('recognizes a real HTTP server and refuses a script that merely mentions one', () => {
    expect(looksLikePythonHttpServer(PYTHON_SERVICE)).toBe(true);
    expect(looksLikePythonHttpServer('from fastapi import FastAPI\napp = FastAPI()')).toBe(false);
    expect(looksLikePythonHttpServer('import socket\ns = socket.socket()\ns.connect(("x", 1))')).toBe(false);
    expect(looksLikePythonHttpServer('print("hello")')).toBe(false);
    expect(looksLikePythonHttpServer('import http.server\n# a comment only, never serves')).toBe(false);
  });

  it('recognizes a Node server the same way', () => {
    expect(looksLikeNodeHttpServer(NODE_SERVICE)).toBe(true);
    expect(looksLikeNodeHttpServer('console.log("no server here")')).toBe(false);
    expect(looksLikeNodeHttpServer("import { readFile } from 'node:fs/promises';\nawait readFile('x');")).toBe(false);
  });

  it('detects whether the artifact can be told which port to use', () => {
    expect(readsPortFromEnv('PORT = int(os.environ.get("PORT", "8000"))', 'python')).toBe(true);
    expect(readsPortFromEnv('port = os.getenv("PORT")', 'python')).toBe(true);
    expect(readsPortFromEnv('PORT = 8000', 'python')).toBe(false);
    expect(readsPortFromEnv('const PORT = Number(process.env.PORT ?? 8000);', 'node')).toBe(true);
    expect(readsPortFromEnv("const PORT = 8000;", 'node')).toBe(false);
  });

  it('finds a fixed port rather than guessing one', () => {
    expect(fixedPortOf('PORT = 8000\n', 'python')).toBe(8000);
    expect(fixedPortOf('server.listen(3000, () => {})', 'node')).toBe(3000);
    expect(fixedPortOf('print("nothing to listen on")', 'python')).toBeNull();
  });

  it('prefers the service health endpoint as the readiness signal', () => {
    expect(readinessPathOf(PYTHON_SERVICE_HEALTH)).toBe('/api/health');
    expect(readinessPathOf(NODE_SERVICE)).toBe('/');
    expect(readinessPathOf('if path == "/api/status": pass')).toBe('/api/status');
  });
});

describe('project naming', () => {
  it('takes the name the artifact gives itself', () => {
    expect(projectNameOf(splitProduct(), 'Implementation')).toBe('Tetris Demo');
    expect(projectNameOf([file('client/README.md', '# Inner\n')], 'Fallback')).toBe('Inner');
    expect(projectNameOf([file('README.md', 'no heading\n')], 'Implementation')).toBe('Implementation');
    expect(projectNameOf([], '')).toBe('Delivery');
  });

  it('names the product a workflow step belongs to, not the step', () => {
    expect(productNameOf('Complete step "Backend" of workflow "Tetris Demo": build it', 'Backend')).toBe('Tetris Demo');
    expect(productNameOf('Publish the churn table', 'Fallback')).toBe('Publish the churn table');
    expect(productNameOf('', 'Fallback')).toBe('Fallback');
  });
});

describe('planning a delivered product', () => {
  it('starts the service of a split product, on an injectable port, and knows its health path', () => {
    const analysis = planArtifact(splitProduct(), 'Implementation');
    expect(analysis.reason).toBeNull();
    expect(analysis.projectName).toBe('Tetris Demo');
    expect(analysis.plan).toEqual({
      plan: 'python-server',
      entryPath: 'server/app.py',
      entryCommand: 'server/app.py',
      portMode: 'env',
      fixedPort: null,
      readinessPath: '/api/health',
      launcherPath: 'run.py',
    });
  });

  it('plans a Node service and a Python service identically in shape', () => {
    const node = planArtifact([file('server/server.mjs', NODE_SERVICE), file('client/index.html', '<p>hi</p>')]);
    expect(node.plan?.plan).toBe('node-server');
    expect(node.plan?.entryPath).toBe('server/server.mjs');
    expect(node.plan?.portMode).toBe('env');
    const python = planArtifact([file('server/app.py', PYTHON_SERVICE), file('client/index.html', '<p>hi</p>')]);
    expect(python.plan?.plan).toBe('python-server');
    expect(python.plan?.entryPath).toBe('server/app.py');
  });

  it('prefers the conventional entry name when several files look like a service', () => {
    const analysis = planArtifact([
      file('tools/probe.py', PYTHON_SERVICE),
      file('server/app.py', PYTHON_SERVICE),
      file('client/index.html', '<p>hi</p>'),
    ]);
    expect(analysis.plan?.entryPath).toBe('server/app.py');
  });

  it('keeps a fixed port but marks the run as non-portable', () => {
    const fixed = PYTHON_SERVICE.replace('int(os.environ.get("PORT", "8000"))', '8000');
    const analysis = planArtifact([file('server/app.py', fixed), file('client/index.html', '<p>hi</p>')]);
    expect(analysis.plan?.portMode).toBe('probe');
    expect(analysis.plan?.fixedPort).toBe(8000);
  });

  it('falls back to the launcher when only a launcher and a client were delivered', () => {
    const analysis = planArtifact([file('run.py', RUN_LAUNCHER), file('client/index.html', '<p>play</p>')]);
    expect(analysis.plan?.plan).toBe('launcher');
    expect(analysis.plan?.entryPath).toBe('run.py');
    // `run.py` here reads PORT itself, so the preview can still move it off the default.
    expect(analysis.plan?.portMode).toBe('env');
  });

  it('serves a client shell with no service as static files', () => {
    const analysis = planArtifact([file('client/index.html', '<p>play</p>'), file('client/app.js', 'play()')]);
    expect(analysis.plan?.plan).toBe('static');
    expect(analysis.plan?.entryPath).toBe('client/index.html');
    expect(analysis.plan?.portMode).toBe('env');
  });

  it('still previews a delivered page that is not named index.html', () => {
    const analysis = planArtifact([file('report/summary.html', '<p>summary</p>')]);
    expect(analysis.plan?.plan).toBe('html');
    expect(analysis.plan?.entryPath).toBe('report/summary.html');
  });

  it('refuses to start a delivery that is not a web app, with a reason', () => {
    const analysis = planArtifact([file('churn/test-report.md', '# Test report\n\nall checks pass\n')]);
    expect(analysis.plan).toBeNull();
    expect(analysis.reason).toContain('no web entry point');
    expect(planArtifact([]).plan).toBeNull();
    expect(planArtifact([]).reason).toBe('the delivery carries no files');
  });

  it('is stable: the same delivery always plans the same way', () => {
    const first = planArtifact(splitProduct(), 'Implementation');
    const second = planArtifact([...splitProduct()].reverse(), 'Implementation');
    expect(second).toEqual(first);
  });

  it('does not care what the product is called or where it was delivered', () => {
    const renamed = splitProduct().map((entry) => ({ ...entry, path: `nested/${entry.path}` }));
    const analysis = planArtifact(renamed, 'Anything');
    // A nested tree is still the same product: the service is found by content, not by position.
    expect(analysis.plan?.plan).toBe('python-server');
    expect(analysis.plan?.entryPath).toBe('nested/server/app.py');
  });
});

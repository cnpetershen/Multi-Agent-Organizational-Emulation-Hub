// Probe: can the API process spawn the delivered project with `stdio: 'ignore'` and reach it
// over HTTP? This is the sandbox boundary test before any Preview Runtime code is written.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = 'deliverables/ss-tetris';
const PORT = 18123;

const child = spawn('python', ['server/app.py'], {
  cwd: ROOT,
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
  windowsHide: true,
});
child.on('error', (error) => console.log('spawn error =>', String(error)));
child.on('exit', (code, signal) => console.log('child exit =>', code, signal));

let ready = false;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(250);
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    if (response.ok) {
      console.log('health =>', await response.text());
      ready = true;
      break;
    }
  } catch {
    /* not up yet */
  }
}
console.log('ready =>', ready);

const client = await fetch(`http://127.0.0.1:${PORT}/`);
const html = await client.text();
console.log('client =>', client.status, html.length, html.includes('canvas id="board"'));
const post = await fetch(`http://127.0.0.1:${PORT}/api/scores`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ player: 'probe', score: 42, lines: 3 }),
});
console.log('post =>', post.status, await post.text());

child.kill();
await sleep(500);
console.log('killed =>', child.killed, 'exitCode =>', child.exitCode);

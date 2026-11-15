import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './api-adapter.js';
export * from './composition.js';
// M3.5 reads the confirmed plan through HTTP; these exports are the typed contract for callers
// that embed the API instead of talking to it.
export * from './planning-types.js';
export * from './plan-validator.js';

/**
 * Self-start only when this file is the process entry point. The comparison is done on
 * resolved absolute paths so it behaves the same on Windows (`dist\index.js`) and POSIX
 * (`dist/index.js`) — the previous `endsWith('dist/index.js')` check never matched on
 * Windows, so `pnpm dev` silently started no API server at all.
 */
const entryPoint = process.argv[1];
if (entryPoint !== undefined && resolve(entryPoint) === resolve(fileURLToPath(import.meta.url))) {
  const { startApiServer } = await import('./composition.js');
  const server = await startApiServer();
  console.log(`[api] listening on http://localhost:${String(server.port)}`);
}

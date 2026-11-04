import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
const file = process.argv[2];
const filter = process.argv[3] ?? '';
const limit = Number(process.argv[4] ?? 40);
const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
let n = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (/^System\.SimClockTicked$/.test(e.type)) continue;
  if (filter && !new RegExp(filter, 'i').test(e.type)) continue;
  if (n++ >= limit) break;
  console.log(`--- #${e.seq} sim=${e.occurredAtSim} actor=${e.actorId} ${e.type}`);
  console.log(JSON.stringify(e.payload));
}

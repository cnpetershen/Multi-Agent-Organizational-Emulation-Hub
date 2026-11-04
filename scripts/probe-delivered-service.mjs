// Proves the delivered service runs and does what the requirement asked: record every play,
// rank the players, and serve the delivered client.
const BASE = 'http://127.0.0.1:8000';

const get = async (path) => {
  const response = await fetch(BASE + path);
  return { status: response.status, body: await response.text() };
};
const post = async (path, payload) => {
  const response = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.text() };
};

const out = {};
out.healthBefore = await get('/api/health');

// Two players, three plays, posted concurrently — "多用户在线运行".
out.plays = await Promise.all([
  post('/api/scores', { player: 'ada', score: 120, lines: 4 }),
  post('/api/scores', { player: 'grace', score: 340, lines: 11 }),
  post('/api/scores', { player: 'ada', score: 260, lines: 8 }),
]);

out.leaderboard = await get('/api/scores?limit=10');
out.healthAfter = await get('/api/health');
const client = await get('/');
out.client = { status: client.status, bytes: client.body.length, isSpa: client.body.includes('<canvas id="board"') };
out.clientCallsService = client.body.includes('/api/scores');
out.badPlay = await post('/api/scores', { player: 'ada', score: -5, lines: 0 });

for (const [key, value] of Object.entries(out)) {
  console.log(key, '=>', JSON.stringify(value));
}

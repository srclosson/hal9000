import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake game ship: /_game answers with whatever `ship` holds; start and reset are recorded.
let ship = { active: false }, calls = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.method === 'POST') {
      const a = JSON.parse(body).action;
      calls.push(a);
      ship = a === 'start' ? { active: true, opened_at: null, relocks: 0, ae35_replaced: false } : { active: false };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ship));
  });
});
await new Promise(r => server.listen(0, r));
process.env.GAME_MODE = 'on';
process.env.GAME_SHIP_URL = `http://127.0.0.1:${server.address().port}`;
const game = await import('./index.js');

test('the trigger and reset phrases', () => {
  assert.ok(game.isTrigger('Open the pod bay doors, HAL.'));
  assert.ok(game.isTrigger('HAL, please open the podbay doors'));
  assert.ok(!game.isTrigger('how are the pods doing'));
  assert.ok(game.isReset('reset the game'));
  assert.ok(game.enabled());
});

test('a game: started, alerts from the ship, won when the doors open', async () => {
  const events = [];
  game.onUpdate((e, s, extra) => events.push([e, extra]));
  assert.equal(await game.start('ROOM', 'Steph'), true);
  assert.equal(await game.start('ROOM'), false);   // one at a time
  assert.deepEqual(calls, ['start']);
  assert.equal(game.forScreen().phase, 'playing');
  await new Promise(r => setTimeout(r, 2300));       // one tick: the AE-35 alert fires
  assert.deepEqual(game.rules().map(r => r.uid), ['game-ae35']);
  assert.ok(events.some(([e, x]) => e === 'alerts' && x[0].uid === 'game-ae35'));
  ship = { ...ship, opened_at: Date.now(), ae35_replaced: true };
  await new Promise(r => setTimeout(r, 2300));
  assert.equal(game.current().phase, 'won');
  assert.equal(game.forScreen().recap.length, 4);
  assert.equal(game.rules().length, 0);
  await game.reset();
  assert.equal(game.forScreen(), null);
  assert.deepEqual(calls, ['start', 'reset']);
  server.close();
});

test('panels read the recorded ship readings like Prometheus series', () => {
  const t = Date.now();
  for (let i = 10; i >= 0; i--) game.record({ t: t - i * 2000, v: { ship_pod_bay_interlock_engaged: i % 2 } });
  const now = game.query('ship_pod_bay_interlock_engaged');
  assert.equal(now[0].value[1], '0');
  const range = game.query('max(ship_pod_bay_interlock_engaged)', true, 1, 0, 2);
  assert.equal(range[0].values.length, 11);
  assert.deepEqual(game.query('ship_pod_bay_interlock_engaged', true, 30, 1440), []);   // no earlier days
  assert.deepEqual(game.query('up'), []);
});

test('the note for the model never names the cause', () => {
  assert.doesNotMatch(game.note(), /directive|crew_override|AE-35/i);
});

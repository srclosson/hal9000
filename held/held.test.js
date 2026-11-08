// Held calls (held/index.js): node --test held/
// A slow tool is held, never abandoned or sent twice; slow (alive) is told apart from gone (no ping), and quiet from
// working (progress).

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as held from './index.js';
import { retryable } from '../mcp/index.js';

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const events = [];
held.onUpdate((c, event, text) => events.push({ id: c.id, event, text }));

let room = 0;
beforeEach(() => { mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] }); events.length = 0; room++; });
afterEach(() => mock.timers.reset());

// A tool that answers when told to; alive() answers pings as set.
function slowTool() {
  const t = { calls: 0, up: true };
  t.answer = new Promise(r => { t.reply = r; });
  t.start = wait => { t.calls++; t.wait = wait; wait.signal.addEventListener('abort', () => t.reply('Error: aborted')); return t.answer; };
  t.alive = async () => t.up;
  return t;
}
const run = (t, extra = {}) => held.run({ room: `R${room}`, tool: 'chat_with_agent', args: { msg: 'hi' }, label: 'Asking Aiden', question: 'why is checkout slow?',
  start: t.start, alive: t.alive, ...extra });

test('a quick answer passes straight through and is never held', async () => {
  const t = slowTool();
  const p = run(t);
  t.reply('fine');
  assert.equal(await p, 'fine');
  mock.timers.tick(60_000);
  assert.deepEqual(events, []);
  assert.equal(held.waiting(`R${room}`).length, 0);
});

test('a slow answer is held after the threshold, then brought back once, without asking again', async () => {
  const t = slowTool();
  const p = run(t);
  mock.timers.tick(20_000);
  const note = await p;
  assert.match(note, /^Held \(H\d+\)/);
  assert.match(note, /not a failure/);
  assert.equal(held.waiting(`R${room}`).length, 1);
  // The model asks again: the same call is not sent twice.
  assert.match(await run(t), /already running/);
  assert.equal(t.calls, 1);
  t.reply('Aiden says: the cache is cold');
  await flush();
  assert.deepEqual(events.map(e => e.event), ['held', 'done']);
  assert.equal(events.at(-1).text, 'Aiden says: the cache is cold');
  assert.equal(held.waiting(`R${room}`).length, 0);
});

test('alive but silent for longer than usual is quiet (said once); progress makes it working again', async () => {
  const t = slowTool();
  const p = run(t);
  mock.timers.tick(20_000); await p;
  for (let i = 0; i < 11; i++) { mock.timers.tick(30_000); await flush(); }   // 5.5 min, no progress
  assert.equal(events.filter(e => e.event === 'quiet').length, 1);
  assert.equal(held.waiting(`R${room}`)[0].state, 'quiet');
  t.wait.onprogress({ progress: 3, total: 10, message: 'reading traces' });
  assert.equal(held.waiting(`R${room}`)[0].state, 'working');
  assert.equal(held.forScreen(`R${room}`)[0].progress, 'reading traces');
  t.reply('done');
});

test('a server that stops answering pings is lost: the call is stopped and said, not retried', async () => {
  const t = slowTool();
  const p = run(t);
  mock.timers.tick(20_000); await p;
  t.up = false;
  for (let i = 0; i < 3; i++) { mock.timers.tick(30_000); await flush(); }
  assert.ok(events.some(e => e.event === 'lost'));
  assert.ok(t.wait.signal.aborted);
  assert.equal(t.calls, 1);
  await flush();
  assert.ok(!events.some(e => e.event === 'done'), 'the abort is not reported as an answer');
});

test('the model can see and cancel what it is waiting on', async () => {
  const t = slowTool();
  const p = run(t);
  mock.timers.tick(20_000); await p;
  const hooks = { board: { room: `R${room}` }, person: 'Stephanie Closson' };
  assert.match(held.call('waiting_on', {}, hooks), /Asking Aiden: working/);
  assert.match(held.call('waiting_on', { cancel: 'all' }, hooks), /Stopped waiting for H\d+ \(Asking Aiden\)/);
  assert.ok(t.wait.signal.aborted);
  assert.match(held.call('waiting_on', {}, hooks), /cancelled/);
});

test('usual time is learned from finished calls', () => {
  for (const ms of [40_000, 50_000, 60_000, 70_000]) held.record('learned_tool', ms);
  assert.equal(held.usual('learned_tool'), 70_000);
  assert.equal(held.usual('never_seen'), null);
});

test('a timed-out or cancelled call is never retried; a lost session is, and a read-only tool on a dropped connection', () => {
  const chat = { name: 'chat_with_agent' }, read = { name: 'list_agents' };
  assert.equal(retryable({ code: -32001, message: 'Request timed out' }, chat), false);
  assert.equal(retryable({ code: -32001, message: 'Request timed out' }, read), false);
  assert.equal(retryable({ name: 'AbortError', message: 'This operation was aborted' }, chat), false);
  assert.equal(retryable({ code: 404, message: 'Session not found' }, chat), true);
  assert.equal(retryable({ message: 'fetch failed' }, chat), false);
  assert.equal(retryable({ message: 'fetch failed' }, read), true);
});

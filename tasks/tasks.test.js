import test from 'node:test';
import assert from 'node:assert/strict';
import * as tasks from './index.js';

let rules = [{ uid: 'u1', title: 'High error rate', state: 'firing', labels: { service: 'checkout' } },
  { uid: 'u2', title: 'Pod restarts', state: 'normal', labels: { service: 'cart' } }];
let values = [120, 80], incident = { status: 'investigating' };
tasks.setSources({ alertRules: async () => rules, promValues: async () => values, incident: async () => incident });
const events = [];
tasks.onUpdate((t, e) => events.push(`${t.id}:${e}`));

test('a reminder fires when due, and only then', async () => {
  const t = tasks.remind('R1', { minutes: 5, question: 'check checkout errors' }, 'Steph');
  assert.equal(t.kind, 'reminder');
  await tasks.tick(Date.now() + 60_000);
  assert.equal(t.state, 'pending');
  await tasks.tick(Date.now() + 5 * 60_000 + 1);
  assert.equal(t.state, 'fired');
  assert.deepEqual(tasks.undelivered('R1').map(x => x.id), [t.id]);
});

test('an alert watch waits for the alert to clear', async () => {
  const t = await tasks.watchFor('R2', { alert: 'error rate', until: 'clear' }, 'Steph');
  assert.equal(t.check.uid, 'u1');
  assert.equal(tasks.forScreen('R2')[0].last, 'firing');
  await tasks.tick();
  assert.equal(t.state, 'pending');
  rules = rules.map(r => (r.uid === 'u1' ? { ...r, state: 'normal' } : r));
  await tasks.tick();
  assert.equal(t.state, 'fired');
});

test('a watch already true sets nothing', async () => {
  const r = await tasks.watchFor('R3', { alert: 'Pod restarts', until: 'clear' });
  assert.ok(r.already);
  assert.equal(tasks.pending('R3').length, 0);
});

test('metric watch: above is any series, below is every series', async () => {
  values = [120, 80];
  const below = await tasks.watchFor('R4', { query: 'x', op: 'below', value: 100 });
  assert.equal(below.state, 'pending');
  values = [90, 80];
  await tasks.tick();
  assert.equal(below.state, 'fired');
  const above = await tasks.watchFor('R4', { query: 'x', op: 'above', value: 95 });
  values = [96, 10];
  await tasks.tick();
  assert.equal(above.state, 'fired');
});

test('incident watch, cancel, ambiguous alerts and a broken source', async () => {
  const t = await tasks.watchFor('R5', { incident: 'inc-0042', incident_status: 'resolved' }, 'Steph');
  assert.equal(t.incident, 'INC-0042');
  incident = { status: 'resolved' };
  await tasks.tick();
  assert.equal(t.state, 'fired');

  rules = [...rules, { uid: 'u3', title: 'High error rate (cart)', state: 'firing', labels: {} }];
  assert.match(await tasks.watchFor('R5', { alert: 'error' }), /matches 2 alerts/);

  const w = await tasks.watchFor('R5', { query: 'y', op: 'above', value: 1000 });
  assert.equal(tasks.cancel('R5', w.id, 'Steph').length, 1);
  assert.equal(w.state, 'cancelled');
  assert.equal(tasks.undelivered('R5').some(x => x.id === w.id), false);

  values = [1];
  const b = await tasks.watchFor('R5', { query: 'z', op: 'above', value: 1000 });
  tasks.setSources({ promValues: async () => null });
  for (let i = 0; i < 5; i++) await tasks.tick();
  assert.equal(b.state, 'broken');
});

test('tools say it is a trial', async () => {
  for (const t of tasks.tools()) assert.match(t.description, /Trial task/);
  const out = await tasks.call('remind_me', { minutes: 10, question: 'look again' }, { board: { room: 'R6' }, person: 'Steph' });
  assert.match(out, /^Trial task T\d+ set/);
  assert.match(await tasks.call('list_tasks', {}, { board: { room: 'R6' } }), /trial/);
});

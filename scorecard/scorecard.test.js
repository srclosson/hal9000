import test from 'node:test';
import assert from 'node:assert/strict';
import * as sc from './index.js';

test('digs: cleared is likely right, snoozed is disputed, a person\'s thumbs replace either', () => {
  const a = sc.record('dig', { key: 'retail:CLB', about: 'retail: checkout OOMKilled', ms: 40_000, tokens: 12_000 });
  const b = sc.record('dig', { key: 'gaming:ERR', about: 'gaming: errors from auth' });
  const c = sc.record('dig', { key: 'iot:NOD', about: 'iot: 2 nodes not ready' });
  sc.board(new Set(['gaming:ERR', 'iot:NOD']), key => key === 'iot:NOD');
  assert.equal(a.verdict, 'likely_right');
  assert.match(a.why, /cleared/);
  assert.equal(b.verdict, null);
  assert.equal(c.verdict, 'disputed');
  sc.judge(a, 'unknown', 'no sign either way');   // a settled case is not overwritten by a guess
  assert.equal(a.verdict, 'likely_right');
  sc.judge(a, 'wrong', 'by Stephanie');            // but a person decides
  assert.equal(a.verdict, 'wrong');
});

test('plans are judged by how they end, and an undo makes the original wrong', () => {
  sc.plan({ id: 'P1', room: 'R', title: 'Restart checkout', status: 'pending' });
  sc.plan({ id: 'P1', room: 'R', title: 'Restart checkout', status: 'verified' });
  assert.equal(sc.latest('plan', x => x.key === 'P1').verdict, 'likely_right');
  sc.plan({ id: 'P2', room: 'R', title: 'Scale auth', status: 'unverified' });
  assert.equal(sc.latest('plan', x => x.key === 'P2').verdict, 'wrong');
  sc.plan({ id: 'P3', room: 'R', title: 'Raise limit', status: 'done' });
  sc.plan({ id: 'P4', room: 'R', title: 'Undo: Raise limit', problem: 'Reverses plan P3 (done).', status: 'running' });
  assert.equal(sc.latest('plan', x => x.key === 'P3').verdict, 'wrong');
});

test('a correction disputes the last answer; Aiden takes the review\'s verdict', () => {
  sc.record('answer', { room: 'R', about: 'why is checkout slow?' });
  assert.equal(sc.heard('R', 'thanks, that helps'), null);
  assert.equal(sc.heard('R', "No, that's wrong, it was the database").verdict, 'disputed');
  const run = { uid: 'u1', title: 'Checkout errors', startedAt: Date.now() - 9 * 60_000, finishedAt: Date.now() };
  assert.equal(sc.aiden(run, 'wrong').verdict, 'wrong');
  assert.equal(sc.aiden(run, 'partly right').verdict, 'disputed');
});

test('rate: a person\'s word on the last answer or a card', async () => {
  sc.record('answer', { room: 'R2', about: 'how is retail?' });
  sc.setCardKeys(code => (code === 'GAM' ? 'gaming:ERR' : null));
  assert.match(await sc.call('rate', { what: 'answer', right: true }, { board: { room: 'R2' }, person: 'Steph' }), /right/);
  assert.equal(sc.latest('answer', x => x.room === 'R2').verdict, 'right');
  await sc.call('rate', { what: 'card', code: 'gam', right: false }, { board: { room: 'R2' } });
  assert.equal(sc.latest('dig', x => x.key === 'gaming:ERR').verdict, 'wrong');
  assert.match(await sc.call('rate', { what: 'card', code: 'XYZ', right: true }, {}), /no dig/);
});

test('the summary reads the metrics store when it can, else this run, and lists what went badly', async () => {
  const local = await sc.summary({ days: 7 });
  assert.match(local, /since the 9000 last started/);
  assert.match(local, /Board digs: 3 \(/);
  assert.match(local, /Recent cases that went badly/);
  const prom = async expr => (/cases_total/.test(expr) ? [{ metric: { kind: 'dig' }, value: [0, '31'] }]
    : /verdicts_total/.test(expr) ? [{ metric: { kind: 'dig', verdict: 'likely_right' }, value: [0, '24'] }, { metric: { kind: 'dig', verdict: 'disputed' }, value: [0, '3'] }]
    : /tokens/.test(expr) ? [{ metric: { kind: 'dig' }, value: [0, '372000'] }] : [{ metric: { kind: 'dig' }, value: [0, '1240000'] }]);
  const week = await sc.summary({ days: 7, prom });
  assert.match(week, /from the metrics store/);
  assert.match(week, /Board digs: 31 \(24 likely right, 3 disputed, 4 not settled yet\); 40 s each on average, about 12k model tokens each\./);
});

test('counters for the metrics export, one per kind and verdict', () => {
  const sum = (name, unit, value, attrs) => ({ name, value, attrs: Object.fromEntries(attrs.map(a => [a.key, a.value])) });
  const attr = (key, value) => ({ key, value });
  const m = sc.metrics(sum, attr);
  assert.ok(m.find(x => x.name === 'hal9000.cases' && x.attrs.kind === 'dig').value === 3);
  assert.ok(m.some(x => x.name === 'hal9000.verdicts' && x.attrs.kind === 'plan' && x.attrs.verdict === 'wrong' && x.value === 2));
});

test('confidence forecasts are cases, and other modules can add lines (the blind spots) to the summary', async () => {
  const f = sc.record('forecast', { key: 'kubernetes:CLB', about: 'kubernetes:CLB: forecast 0.44, was 0.76' });
  sc.judge(f, 'wrong', 'forecast 0.44, actual 0.76');
  sc.addNotes(() => ['Blind spots (tools that keep failing for me; I work around them until someone fixes them):', '- k8s_logs on kubernetes: 10 of its last 10 calls failed']);
  sc.addNotes(() => { throw new Error('a broken source is left out'); });
  const s = await sc.summary({ days: 7 });
  assert.match(s, /Confidence forecasts: \d+/);
  assert.match(s, /confidence forecast wrong: "kubernetes:CLB: forecast 0\.44, was 0\.76"/);
  assert.match(s, /- k8s_logs on kubernetes: 10 of its last 10 calls failed$/);
});

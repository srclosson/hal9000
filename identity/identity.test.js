import test from 'node:test';
import assert from 'node:assert/strict';
import * as identity from './index.js';
import * as telemetry from '../telemetry/index.js';
import * as scorecard from '../scorecard/index.js';
import * as confidence from '../confidence/index.js';
import * as resume from '../resume/index.js';

const fp = model => ({ mind: `openai:${model}@api.openai.com`, model, version: '0.42.0', prompt: 'p1', tools: 't1' });
const T = Date.parse('2026-11-03T12:30:00Z');

test('names a model from its provider name', () => {
  assert.equal(identity.modelOf('openai:gpt-6.1-terra@api.openai.com'), 'gpt-6.1-terra');
  assert.equal(identity.modelOf('openai-compatible:glm-5.3:cloud@ollama.stackgen.run'), 'glm-5.3:cloud');
  assert.equal(identity.modelOf(''), 'scripted');
  assert.match(identity.VERSION, /^\d+\.\d+\.\d+$/, 'from package.json');
});

test('a model switch is noticed when used: a ledger entry, and probation until 10 of its digs are judged', () => {
  identity.reset();
  let judged = 0, heard = null;
  identity.setJudged(() => judged);
  identity.onChange((e, was) => { heard = [was.model, e.model]; });
  assert.deepEqual(identity.observe(T, fp('glm-5.3:cloud')).changed, ['first']);
  assert.equal(identity.probation(), null, 'the first mind seen is not new');
  identity.observe(T + 60_000, fp('glm-5.3:cloud'));
  assert.equal(identity.history().length, 1, 'unchanged: nothing recorded');
  const e = identity.observe(T + 120_000, fp('gpt-6.1-terra'));
  assert.deepEqual(e.changed, ['model']);
  assert.deepEqual(heard, ['glm-5.3:cloud', 'gpt-6.1-terra']);
  assert.deepEqual(identity.probation(), { model: 'gpt-6.1-terra', since: T + 120_000, from: 'glm-5.3:cloud', judged: 0, needed: 10 });
  assert.match(identity.describeMind(), /Mind: gpt-6\.1-terra since 2026-11-03 12:32 UTC \(before that, glm-5\.3:cloud\).*probation: 0 of 10/);
  // A new version or tool list is recorded, but isn't a new mind: probation goes on counting from the model change.
  assert.deepEqual(identity.observe(T + 180_000, { ...fp('gpt-6.1-terra'), version: '0.42.1', tools: 't2' }).changed, ['version', 'tools']);
  assert.equal(identity.probation().since, T + 120_000);
  judged = 10;
  assert.equal(identity.probation(), null);
  assert.doesNotMatch(identity.describeMind(), /probation/);
  identity.setJudged(scorecard.judgedSince);
});

test('what was kept before a restart is merged with an answer that came in before the restore', async () => {
  identity.reset();
  identity.observe(T + 600_000, fp('gpt-6.1-terra'));   // answered before the restore finished
  const docs = new Map([['identity', { at: T, data: [{ at: T, ...fp('glm-5.3:cloud'), changed: ['first'] }] }]]);
  resume.setStore({ load: async n => docs.get(n) ?? null, save: async () => true });
  await resume.restore();
  assert.deepEqual(identity.history().map(e => [e.model, e.changed]), [['glm-5.3:cloud', ['first']], ['gpt-6.1-terra', ['model']]]);
  assert.equal(identity.mindSince().from, 'glm-5.3:cloud');
});

test('metrics come per model, so a new model starts its own series', () => {
  for (const [model, signals] of [['glm-5.3:cloud', { tool_error: 11, long_loop: 3 }], ['gpt-6.1-terra', {}]]) {
    const t = telemetry.startTurn('How is kubernetes?', { model });
    for (const [k, n] of Object.entries(signals)) t.signal(k, n);
    t.end('answered');
  }
  const ms = telemetry.metrics();
  const models = name => ms.find(m => m.name === name)[ms.find(m => m.name === name).sum ? 'sum' : ms.find(m => m.name === name).histogram ? 'histogram' : 'gauge']
    .dataPoints.map(d => d.attributes.find(a => a.key === 'gen_ai.request.model')?.value.stringValue);
  assert.ok(models('hal9000.turns').includes('glm-5.3:cloud') && models('hal9000.turns').includes('gpt-6.1-terra'));
  assert.deepEqual(new Set(models('ai_confusion_score')), new Set(['glm-5.3:cloud', 'gpt-6.1-terra']));
  assert.equal(ms.filter(m => m.name === 'hal9000.turns').length, 1, 'one metric per name, a data point per model');
  assert.match(telemetry.summary(60), /By model: .*glm-5\.3:cloud .*gpt-6\.1-terra/);
});

test('the scorecard keeps each model\'s cases apart, and counts a new model\'s judged digs for its probation', async () => {
  identity.reset();
  identity.observe(T, fp('glm-5.3:cloud'));
  const a = scorecard.record('dig', { key: 'kubernetes:CLB', about: 'old mind' });
  scorecard.judge(a, 'likely_right', 'cleared');
  identity.observe(Date.now(), fp('gpt-6.1-terra'));
  const b = scorecard.record('dig', { key: 'kubernetes:CLB', about: 'new mind' });
  assert.equal(a.model, 'glm-5.3:cloud');
  assert.equal(b.model, 'gpt-6.1-terra');
  scorecard.judge(b, 'wrong', 'by Stephanie');
  scorecard.record('dig', { key: 'kubernetes:RST', about: 'not judged yet' });
  assert.equal(identity.probation().judged, 1);
  const s = await scorecard.summary({ days: 7 });
  assert.match(s, /Board digs by model \(on record here\):\n- glm-5\.3:cloud: \d+.*\n- gpt-6\.1-terra: 2 \(1 wrong\)/);
  assert.match(s, /New mind on probation: 1 of 10/);
});

test('a new model\'s forecast borrows only the old one\'s tools, and is less sure while on probation', async () => {
  confidence.reset();
  identity.reset();
  identity.setJudged(() => 0);
  identity.observe(T, fp('glm-5.3:cloud'));
  await confidence.record('x:CLB', 'x', { model: 'glm-5.3:cloud', tools: [{ name: 'query_loki_logs', ok: true }], signals: { long_loop: 3 }, confusion: 0.22 }, T);
  identity.observe(T + 60_000, fp('gpt-6.1-terra'));
  const f = await confidence.forecast('x:CLB', 'x', T + 120_000);
  assert.equal(f.basis, 'another model\'s dig');
  assert.equal(f.probation.model, 'gpt-6.1-terra');
  assert.ok(f.reasons.some(r => /no digs here by gpt-6\.1-terra yet/.test(r)));
  assert.match(f.reasons[0], /new mind gpt-6\.1-terra on probation: 0 of 10/);
  const signsOnly = 1 - (1 - 0.08) ** 3;
  assert.equal(f.confusion, +(signsOnly + 0.1).toFixed(3), 'the old signs, no old history, plus the probation margin');
  identity.setJudged(scorecard.judgedSince);
});

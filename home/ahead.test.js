import test from 'node:test';
import assert from 'node:assert/strict';
import * as ahead from './ahead.js';
import * as config from '../config/index.js';
import * as sc from '../scorecard/index.js';

const T = Date.parse('2026-11-03T12:00:00Z');
const MEM = 'max by (cluster) (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)';
const iso = ms => new Date(ms).toISOString();

// A series as the forecast tool returns it. eta: ms from T for the mean's crossing, or null for none in the horizon.
const series = (cluster, { last = 0.8, eta = 6 * 3600_000, already = false } = {}) => ({
  series: `{cluster="${cluster}"}`, labels: { cluster }, method: 'lightgbm', last: { ds: iso(T), value: last },
  crossing: { threshold: 0.9, direction: 'above', level: 80, already, mean_eta: eta == null ? null : iso(T + eta), earliest_eta: eta == null ? null : iso(T + eta / 2),
    summary: already ? 'already above 0.9' : eta == null ? 'not expected to cross 0.9 within the horizon' : `crosses 0.9 in about ${eta / 3600_000}h` },
});

// A fake mlforecast server: the memory query answers with mem, every other watch with nothing; backtest with skill.
function server({ mem = [], skill = {} } = {}) {
  const calls = [];
  const call = async (name, args, opts) => {
    calls.push({ name, args, opts });
    if (name === 'forecast') return JSON.stringify({ success: true, series: args.query === MEM ? mem : [] });
    if (name === 'backtest') return JSON.stringify({ success: true, series: Object.entries(skill).map(([c, k]) => ({ series: `{cluster="${c}"}`, labels: { cluster: c }, skill: k })) });
    return 'Error: no tool';
  };
  return { call, calls, backtests: () => calls.filter(c => c.name === 'backtest').length };
}

test('forecasts are off by default and never due', () => {
  ahead.reset();
  assert.equal(config.get('forecast.enabled'), 'off');
  assert.equal(ahead.due(T), false);
});

test('a crossing within the horizon with skill above 0.1 raises a panel and a scorecard case', async () => {
  ahead.reset();
  const s = server({ mem: [series('retail')], skill: { retail: 0.34 } });
  assert.equal(await ahead.check({ now: T, call: s.call }), true);
  assert.equal(s.calls[0].args.threshold, 0.9);
  assert.equal(s.calls[0].opts.internal, true);
  const [p] = ahead.panels();
  assert.equal(p.code, 'MEM');
  assert.equal(p.cluster, 'retail');
  assert.match(p.query, /cluster="retail"/);
  assert.match(p.insight, /crosses 0.9 in about 6h; beats the baseline \(skill 0.34\)/);
  const c = sc.get(p.outlook.case);
  assert.equal(c.kind, 'outlook');
  assert.equal(c.verdict, null);
  // The same forecast next time is the same case, not a new one.
  await ahead.check({ now: T + 15 * 60_000, call: s.call });
  assert.equal(ahead.panels()[0].outlook.case, c.id);
});

test('no panel when the backtest skill is 0.1 or less', async () => {
  for (const skill of [0.1, 0.05, -0.4]) {
    ahead.reset();
    const s = server({ mem: [series('gaming')], skill: { gaming: skill } });
    await ahead.check({ now: T, call: s.call });
    assert.equal(s.backtests(), 1);
    assert.deepEqual(ahead.panels(), [], `skill ${skill}`);
  }
  // A series the backtest couldn't score, or a backtest that failed, is not trusted either.
  ahead.reset();
  await ahead.check({ now: T, call: server({ mem: [series('gaming')], skill: { iot: 0.5 } }).call });
  assert.deepEqual(ahead.panels(), []);
  ahead.reset();
  await ahead.check({ now: T, call: async name => (name === 'forecast' ? JSON.stringify({ success: true, series: [series('gaming')] }) : JSON.stringify({ success: false, error: 'too short' })) });
  assert.deepEqual(ahead.panels(), []);
});

test('no panel without a crossing ETA, or when it is already over (that is the live board\'s)', async () => {
  ahead.reset();
  const s = server({ mem: [series('iot', { eta: null }), series('saas', { last: 0.93, already: true })], skill: { iot: 0.6, saas: 0.6 } });
  await ahead.check({ now: T, call: s.call });
  assert.deepEqual(ahead.panels(), []);
  assert.equal(s.backtests(), 0, 'nothing coming: no backtest');
  ahead.reset();
  await ahead.check({ now: T, call: server({ mem: [{ ...series('nolabel'), labels: {} }], skill: { nolabel: 0.6 } }).call });
  assert.deepEqual(ahead.panels(), [], 'a series with no cluster label');
  assert.equal(ahead.raises(series('x'), 0.11), true);
  assert.equal(ahead.raises(series('x', { eta: null }), 0.9), false);
});

test('a raised forecast is judged by whether the crossing happened', async () => {
  ahead.reset();
  await ahead.check({ now: T, call: server({ mem: [series('fintech'), series('travel')], skill: { fintech: 0.3, travel: 0.3 } }).call });
  const [a, b] = ahead.current().map(o => o.case);
  // Seven hours on: fintech went over 0.9; travel is still under, but within the grace after its ETA.
  await ahead.check({ now: T + 7 * 3600_000, call: server({ mem: [series('fintech', { last: 0.92, already: true }), series('travel', { last: 0.85, eta: null })], skill: {} }).call });
  assert.equal(a.verdict, 'likely_right');
  assert.match(a.why, /crossed 0.9 \(at 0.92\) 60 min after/);
  assert.equal(b.verdict, null);
  // Past the grace and still under: wrong.
  await ahead.check({ now: T + 9 * 3600_000, call: server({ mem: [series('travel', { last: 0.84, eta: null })] }).call });
  assert.equal(b.verdict, 'wrong');
  assert.match(b.why, /still at 0.84/);
  assert.deepEqual(ahead.panels(), []);
});

test('a failed forecast call keeps what was raised', async () => {
  ahead.reset();
  await ahead.check({ now: T, call: server({ mem: [series('retail')], skill: { retail: 0.4 } }).call });
  await ahead.check({ now: T + 15 * 60_000, call: async () => 'Error: forecast is unavailable right now (fetch failed).' });
  assert.equal(ahead.panels().length, 1);
});

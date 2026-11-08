import test from 'node:test';
import assert from 'node:assert/strict';
import * as confidence from './index.js';
import { confusionOf } from '../telemetry/index.js';
import { digQuestion } from '../home/index.js';

// The dig of 3 November 2026, 12:30: ten k8s_logs and a k8s_get all failed on the kubernetes cluster; Loki and
// Prometheus worked. It scored 0.76 and tripped "HAL 9000: lost".
const pods = ['odoo', 'nextcloud', 'tempo-ingester-0', 'ghost', 'tempo-compactor', 'tempo-distributor', 'tempo-query-frontend', 'tempo-querier', 'tempo-ingester-1', 'skywalking'];
const crashDig = () => ({
  tools: [{ name: 'investigate', ok: true }, { name: 'find_tools', ok: true }, ...pods.map(() => ({ name: 'k8s_logs', ok: false })), { name: 'k8s_get', ok: false },
    ...Array.from({ length: 12 }, () => ({ name: 'query_loki_logs', ok: true })), ...Array.from({ length: 4 }, () => ({ name: 'query_prometheus', ok: true }))],
  signals: { tool_error: 11, long_loop: 3 }, confusion: confusionOf({ tool_error: 11, long_loop: 3 }),
});
const T = Date.parse('2026-11-03T12:31:19Z');

test('nothing to go on: no forecast', async () => {
  confidence.reset();
  assert.equal(await confidence.forecast('kubernetes:CLB', 'kubernetes', T), null);
});

test('after the confused dig: k8s_logs is a blind spot, the dig is told to work around it, and the forecast drops', async () => {
  confidence.reset();
  assert.equal(crashDig().confusion.toFixed(2), '0.76');
  await confidence.record('kubernetes:CLB', 'kubernetes', crashDig(), T);
  const f = await confidence.forecast('kubernetes:CLB', 'kubernetes', T + 30 * 60_000);
  assert.deepEqual(f.blindSpots, [{ tool: 'k8s_logs', cluster: 'kubernetes', calls: 10, failed: 10 }]);
  assert.match(f.reasons[0], /k8s_logs failed 10 of 10 calls on kubernetes/);
  // k8s_logs is skipped, k8s_get (one call, too few to call blind) still expected to fail once: well under the alert.
  assert.ok(f.confusion < 0.5 && f.confusion > 0.3, `forecast ${f.confusion}`);
  assert.equal(f.alert, false);
  assert.equal(f.confidence, +(1 - f.confusion).toFixed(3));
  const brief = confidence.brief(f);
  assert.match(brief, /k8s_logs \(10 of 10 failed\)/);
  assert.match(digQuestion({ dig: { about: 'kubernetes: 9 pods crash-looping' } }, null, f), /Blind spots on this cluster/);
  // Another cluster isn't blind: k8s_logs only failed on kubernetes.
  assert.equal(await confidence.forecast('fe-apps-discovery-one:LAT', 'fe-apps-discovery-one', T), null);
  assert.deepEqual(await confidence.blindSpots(T), [{ tool: 'k8s_logs', cluster: 'kubernetes', calls: 10, failed: 10 }]);
});

test('a tool failing less than always is not skipped: its errors are forecast, and can trip the alert', async () => {
  confidence.reset();
  const flaky = { tools: [...Array.from({ length: 6 }, (_, i) => ({ name: 'k8s_logs', ok: i % 3 === 0 })), ...Array.from({ length: 8 }, () => ({ name: 'query_loki_logs', ok: false }))],
    signals: { tool_error: 12, long_loop: 4 }, confusion: confusionOf({ tool_error: 12, long_loop: 4 }) };
  await confidence.record('kubernetes:RST', 'kubernetes', flaky, T);
  const f = await confidence.forecast('kubernetes:RST', 'kubernetes', T + 60_000);
  assert.deepEqual(f.blindSpots.map(b => b.tool), ['query_loki_logs'], 'all 8 Loki calls failed; k8s_logs worked 2 of 6 times');
  assert.ok(f.reasons.some(r => /k8s_logs failed 4 of its last 6 calls/.test(r)));
  assert.equal(confidence.brief({ blindSpots: [] }), '');
});

test('tool health fades: a day later the blind spot is gone and the dig tries the tool again', async () => {
  confidence.reset();
  await confidence.record('kubernetes:CLB', 'kubernetes', crashDig(), T);
  const f = await confidence.forecast('kubernetes:CLB', 'kubernetes', T + 25 * 3600_000);
  assert.deepEqual(f.blindSpots, []);
  assert.ok(f.confusion > 0.6, 'the old dig still counts: it expects the same trouble');
});

test('the problem\'s own record: recent digs count more, and only the last 10 are kept', async () => {
  confidence.reset();
  const clear = { tools: [{ name: 'query_prometheus', ok: true }], signals: {}, confusion: 0 };
  for (let i = 0; i < 12; i++) await confidence.record('x:CPU', 'x', i < 11 ? clear : crashDig(), T + i * 60_000);
  const f = await confidence.forecast('x:CPU', 'x', T + 13 * 60_000);
  assert.match(f.basis, /^10 past digs$/);
  assert.ok(f.reasons.some(r => /past 10 digs averaged/.test(r)));
  confidence.reset();
  for (let i = 0; i < 3; i++) await confidence.record('x:CPU', 'x', clear, T + i * 60_000);
  const calm = await confidence.forecast('x:CPU', 'x', T + 4 * 60_000);
  assert.equal(calm.confusion, 0);
  assert.equal(calm.confidence, 1);
});

test('nothing recorded for a dig with no conclusion', async () => {
  confidence.reset();
  await confidence.record('k:CLB', 'k', null, T);
  assert.equal(await confidence.forecast('k:CLB', 'k', T), null);
});

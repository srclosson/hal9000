// Views (boards/view.js): node --test boards/
// The promise of phase 1 is that nothing drawn changes: every panel spec, lifted into a view and lowered again,
// reads exactly as before; a query is only ever restructured when that can't change its meaning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toView, toPanel, compile, parse, check, applyDiff, undo, redo, at } from './view.js';
import { layersOf } from './compose.js';

// Everything the readers look at, in a form where key order doesn't matter.
const sorted = x => (Array.isArray(x) ? x.map(sorted) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, sorted(x[k])])) : x);
const same = (a, b) => assert.deepEqual(sorted(JSON.parse(JSON.stringify(a))), sorted(JSON.parse(JSON.stringify(b))));

const SPECS = [
  { code: 'VIT', kind: 'compose', title: 'Errors today vs yesterday', unit: '%', window: 120,
    layers: [{ query: 'sum by (service) (rate(http_requests_total{cluster="retail",code=~"5.."}[5m]))', label: 'today', by: 'service', hero: true },
      { query: 'sum by (service) (rate(http_requests_total{cluster="retail",code=~"5.."}[5m]))', label: 'yesterday', shift: 1440, style: 'faint' }],
    headline: { show: 'change', layer: 0, against: 1 }, refs: [{ value: 1, label: 'SLO', tone: 'warn' }], spans: [{ from: '-90m', to: '-60m', label: 'deploy' }],
    callouts: [{ at: '-30m', text: 'peak', layer: 0 }], events: [{ source: 'logs', query: '{cluster="retail"} |= "error"' }], y: { min: 0 }, caption: 'Errors doubled', warn: 1, crit: 5 },
  { code: 'AE3', kind: 'compose', title: 'AE-35', layers: [{ query: 'ship_ae35_pointing_error_degrees', unit: 'degrees' },
    { query: 'ship_ae35_signal_dbm', axis: 'right', unit: 'dBm', over: 'avg' }] },
  { code: 'BAR', kind: 'compose', layout: 'bars', title: 'Now vs last week', listLabel: 'service',
    layers: [{ query: 'sum by (service) (rate(x_total[5m]))' }, { query: 'sum by (service) (rate(x_total[5m]))', shift: 10080, style: 'outline' }] },
  { code: 'SCT', kind: 'compose', layout: 'scatter', title: 'Latency vs load', layers: [{ query: 'sum by (pod) (rate(req_total[5m]))', label: 'load', by: 'pod' },
    { query: 'histogram_quantile(0.95, sum by (le, pod) (rate(req_duration_seconds_bucket[5m])))', label: 'p95', by: 'pod', unit: 's' }] },
  { code: 'ONE', kind: 'compose', title: 'From query', query: 'up{job="api"}', listLabel: 'instance' },
  { code: 'STY', kind: 'compose', layout: 'story', title: 'What happened', caption: 'a card', elements: [
    { type: 'trend', title: 'Errors', layers: [{ query: 'rate(errors_total[5m])' }], window: 90, events: [{ source: 'traces', service: 'checkout' }] },
    { type: 'trace', title: 'Slowest', service: 'checkout', failing: true },
    { type: 'logs', title: 'Lines', query: '{app="checkout"}' }, { type: 'stat', title: 'Now', query: 'sum(up)', unit: 'pods' }, { type: 'note', text: 'Rolled back' }] },
  { code: 'CPU', kind: 'timeseries', title: 'CPU', query: 'avg(rate(container_cpu_usage_seconds_total{namespace="x"}[5m]))', unit: '%', warn: 70, crit: 90, window: 60 },
  { code: 'TOP', kind: 'list', title: 'Top pods', query: 'topk(5, sum by (pod) (rate(http_requests_total[5m])))', listLabel: 'pod' },
  { code: 'STA', kind: 'stat', title: 'Pods', query: 'count(kube_pod_info) or vector(0)', unit: 'pods' },
  { code: 'HM', kind: 'heatmap', title: 'Latency', query: 'sum by (le) (rate(x_bucket[5m]))' },
  { code: 'LOG', kind: 'logs', title: 'Errors', query: '{cluster="x"} |= "error"', status: 'warn' },
  { code: 'NOT', kind: 'note', title: 'Note', text: 'All quiet' },
  { code: 'TRC', kind: 'trace', title: 'Trace', service: 'checkout', traceId: 'abc' },
  { code: 'FLW', kind: 'flow', title: 'Flow', services: ['checkout-api'] },
  { code: 'TL', kind: 'timeline', title: 'Story', alert_uid: 'u1', window: 120 },
  { code: 'WEIRD', kind: 'compose', title: 'Unknown extras survive', layers: [{ query: 'a_metric', futureField: 7 }], futureTop: { x: 1 } },
];

test('every panel spec comes back exactly as it went in', () => {
  for (const p of SPECS) same(toPanel(toView(p)), p);
});

test('compose panels read the same layers after a round trip', () => {
  for (const p of SPECS.filter(s => s.kind === 'compose' && s.layout !== 'story')) same(layersOf(toPanel(toView(p))), layersOf(p));
});

test('views are sound, and a view lowers to the same spec twice', () => {
  for (const p of SPECS) {
    const v = toView(p);
    assert.deepEqual(check(v), [], `${p.code}: ${check(v).join('; ')}`);
    same(toPanel(toView(toPanel(v))), toPanel(v));
  }
});

test('simple queries become structured, with the same text when compiled', () => {
  const cases = {
    'ship_ae35_signal_dbm': { metric: 'ship_ae35_signal_dbm' },
    'up{job="api"}': { metric: 'up', filters: [{ label: 'job', op: '=', value: 'api' }] },
    'sum by (service) (rate(http_requests_total{cluster="retail",code=~"5.."}[5m]))':
      { metric: 'http_requests_total', filters: [{ label: 'cluster', op: '=', value: 'retail' }, { label: 'code', op: '=~', value: '5..' }], fn: 'rate', range: '5m', agg: 'sum', by: ['service'] },
    'topk(5, sum by (pod) (rate(http_requests_total[5m])))': { metric: 'http_requests_total', fn: 'rate', range: '5m', agg: 'sum', by: ['pod'], top: 5 },
    'histogram_quantile(0.95, sum by (le, pod) (rate(req_duration_seconds_bucket[5m])))': { metric: 'req_duration_seconds_bucket', quantile: 0.95, range: '5m', by: ['pod'] },
    'avg(rate(container_cpu_usage_seconds_total{namespace="x"}[5m]))': { metric: 'container_cpu_usage_seconds_total', filters: [{ label: 'namespace', op: '=', value: 'x' }], fn: 'rate', range: '5m', agg: 'avg' },
  };
  for (const [q, fields] of Object.entries(cases)) {
    same(parse(q), fields);
    assert.equal(toPanel(toView({ kind: 'stat', code: 'S', query: q })).query, q, 'kept word for word');
    assert.equal(compile(fields).replace(/\s+/g, ''), q.replace(/\s+/g, ''));
  }
});

test('anything else stays opaque, word for word', () => {
  for (const q of ['count(kube_pod_info) or vector(0)', 'sum(rate(a[5m])) / sum(rate(b[5m]))', 'rate(x[5m] offset 1d)', 'sum without (pod) (x)',
    'max_over_time(x[1h])', 'x > 5', '(sum(a))', 'quantile(0.9, x)'])
    assert.equal(parse(q), null, q);
  const v = toView({ kind: 'stat', code: 'S', query: 'count(kube_pod_info) or vector(0)' });
  assert.equal(v.layers[0].query, 'count(kube_pod_info) or vector(0)');
});

// Every query string in the code that builds boards: whatever parse makes of it compiles back to the same text.
test('real queries in the codebase never change meaning', () => {
  const src = ['boards/index.js', 'home/index.js', 'alerts/index.js'].filter(f => fs.existsSync(new URL(`../${f}`, import.meta.url))).map(f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  const literals = [...src.matchAll(/`([^`]*\([^`]*)`|'([^'\n]*\([^'\n]*)'/g)].map(m => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, 'cluster="x"'));
  let structured = 0;
  for (const q of literals) {
    const f = parse(q);
    if (f) { structured++; assert.equal(compile(f).replace(/\s+/g, ''), q.trim().replace(/\s+/g, ''), q); }
  }
  assert.ok(literals.length > 10);
});

test('scope filters reach structured layers, never opaque ones, and a layer\'s own filter wins', () => {
  const scope = { filters: [{ label: 'cluster', op: '=', value: 'fe-apps-discovery-one' }, { label: 'job', op: '=', value: 'all' }] };
  assert.equal(compile({ metric: 'up', filters: [{ label: 'job', op: '=', value: 'api' }] }, scope), 'up{cluster="fe-apps-discovery-one",job="api"}');
  assert.equal(compile({ query: 'up' }, scope), 'up');
  assert.equal(compile({ metric: 'up', filters: [{ label: 'msg', op: '=', value: 'say "hi"' }] }), 'up{msg="say \\"hi\\""}');
});

test('diffs are recorded, undone and redone exactly', () => {
  const v0 = toView(SPECS[1]);
  const v1 = applyDiff(v0, [{ op: 'set', path: ['layers', 1, 'fn'], value: 'rate' }, { op: 'set', path: ['scope', 'window'], value: 360 }], { by: 'Stephanie Closson', why: 'rate it, six hours' });
  assert.equal(v1.layers[1].fn, 'rate');
  assert.equal(toPanel(v1).layers[1].query, 'rate(ship_ae35_signal_dbm[5m])');
  assert.equal(toPanel(v1).window, 360);
  assert.equal(v1.history.length, 1);
  assert.equal(v1.history[0].by, 'Stephanie Closson');
  const v2 = applyDiff(v1, [{ op: 'add', path: ['layers', '-'], value: { id: 'L3', source: 'metrics', role: 'y', metric: 'ship_ae35_bit_error_rate' } }], { by: 'HAL 9000', why: 'errors too' });
  assert.equal(v2.layers.length, 3);
  const back = undo(undo(v2));
  same(toPanel(back), SPECS[1]);
  assert.equal(back.redo.length, 2);
  const again = redo(redo(back));
  same(toPanel(again), toPanel(v2));
  same(toPanel(at(v2, 1)), toPanel(v1));
  assert.equal(v0.history.length, 0, 'the original view is never changed');
});

test('a diff that would leave an unsound view is refused, and nothing changes', () => {
  const v0 = toView(SPECS[1]);
  assert.throws(() => applyDiff(v0, [{ op: 'set', path: ['layers', 0, 'fn'], value: 'explode' }]), /fn must be/);
  assert.throws(() => applyDiff(v0, [{ op: 'set', path: ['history'], value: [] }]), /can't change/);
  assert.throws(() => applyDiff(v0, [{ op: 'remove', path: ['layers', 9] }]), /nothing at/);
  assert.equal(v0.layers[0].fn, undefined);
});

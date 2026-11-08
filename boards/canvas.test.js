// The canvas's drop rules (public/drops.js) applied to real views: node --test boards/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toView, toPanel, applyDiff, undo } from './view.js';
import { opsFor, accepts, kindOf, unitOf, sharedFilters } from '../public/drops.js';

const drop = (view, zone, item, by = 'Stephanie Closson') => {
  const r = opsFor(zone, item, view);
  if (r.refuse) throw new Error(r.refuse);
  return applyDiff(view, r.ops, { by, why: r.why });
};
const AE = { code: 'AE3', kind: 'compose', title: 'AE-35', window: 60,
  layers: [{ query: 'ship_ae35_pointing_error_degrees{cluster="fe-apps-discovery-one"}', unit: 'degrees' }] };

test('names say what a metric is', () => {
  assert.equal(kindOf('http_requests_total'), 'counter');
  assert.equal(kindOf('req_duration_seconds_bucket'), 'histogram');
  assert.equal(kindOf('ship_ae35_signal_dbm'), 'gauge');
  assert.equal(unitOf('http_requests_total'), '/s');
  assert.equal(unitOf('node_network_receive_bytes_total'), 'bytes/s');
  assert.equal(unitOf('req_duration_seconds_bucket'), 's');
  assert.equal(unitOf('ship_ae35_signal_dbm'), 'dBm');
});

test('a metric dropped on a cluster\'s panel stays in that cluster, on its own scale when units differ', () => {
  const v = drop(toView(AE), 'plot', { type: 'metric', name: 'ship_ae35_signal_dbm' });
  const l = v.layers[1];
  assert.equal(l.axis, 'right');
  assert.equal(l.unit, 'dBm');
  assert.equal(toPanel(v).layers[1].query, 'ship_ae35_signal_dbm{cluster="fe-apps-discovery-one"}');
  assert.equal(toPanel(v).layers[0].query, AE.layers[0].query, 'HAL\'s line is untouched');
  assert.equal(v.history[0].by, 'Stephanie Closson');
  assert.match(v.history[0].why, /own scale/);
});

test('counters are rated, histograms become p95, and the left scale is used when asked', () => {
  let v = drop(toView(AE), 'y', { type: 'metric', name: 'ship_device_actions_total' });
  assert.equal(toPanel(v).layers[1].query, 'sum (rate(ship_device_actions_total{cluster="fe-apps-discovery-one"}[5m]))');
  assert.equal(v.layers[1].axis, undefined);
  v = drop(v, 'plot', { type: 'metric', name: 'req_duration_seconds_bucket', cluster: 'retail' });
  assert.equal(toPanel(v).layers[2].query, 'histogram_quantile(0.95,sum by (le) (rate(req_duration_seconds_bucket{cluster="retail"}[5m])))');
});

test('split by a label reaches lines built here and leaves HAL\'s own; out undoes it', () => {
  const HAL = { ...AE, layers: [{ query: 'max(ship_ae35_pointing_error_degrees{cluster="fe-apps-discovery-one"}) * 2', unit: 'degrees' }] };
  let v = drop(toView(HAL), 'plot', { type: 'metric', name: 'http_requests_total' });
  v = drop(v, 'color', { type: 'label', name: 'service' });
  assert.equal(v.encode.color, 'service');
  assert.equal(toPanel(v).layers[1].query, 'sum by (service) (rate(http_requests_total{cluster="fe-apps-discovery-one"}[5m]))');
  assert.equal(toPanel(v).layers[1].by, 'service', 'series are named by it');
  assert.equal(toPanel(v).layers[0].query, HAL.layers[0].query);
  assert.match(v.history.at(-1).why, /1 of HAL's own line unchanged/);
  v = drop(v, 'out', { type: 'color' });
  assert.equal(toPanel(v).layers[1].query, 'sum (rate(http_requests_total{cluster="fe-apps-discovery-one"}[5m]))');
});

test('only-filters and windows come from Only; removing the leading line hands the lead on', () => {
  let v = drop(toView(AE), 'plot', { type: 'metric', name: 'http_requests_total' });
  v = drop(v, 'scope', { type: 'label', name: 'service', value: 'gateway' });
  assert.equal(toPanel(v).layers[1].query, 'sum (rate(http_requests_total{service="gateway",cluster="fe-apps-discovery-one"}[5m]))');
  v = drop(v, 'scope', { type: 'window', minutes: 360 });
  assert.equal(toPanel(v).window, 360);
  v = drop(v, 'out', { type: 'filter', index: 0 });
  v = drop(v, 'out', { type: 'layer', id: 'L1' });
  assert.equal(v.layers.length, 1);
  assert.equal(v.layers[0].hero, true);
});

test('drops that make no sense are refused before anything changes', () => {
  const opaque = toView({ code: 'X', kind: 'compose', layers: [{ query: 'sum(a) / sum(b)' }] });
  assert.equal(accepts('color', { type: 'label', name: 'pod' }, opaque).ok, false);
  assert.match(accepts('color', { type: 'label', name: 'pod' }, opaque).words, /ask HAL/);
  assert.equal(accepts('scope', { type: 'metric', name: 'up' }, opaque).ok, false);
  assert.equal(accepts('out', { type: 'layer', id: 'L1' }, opaque).ok, false);
  assert.equal(accepts('right', { type: 'metric', name: 'up' }, opaque).ok, true);
  let full = toView(AE);
  for (const n of ['a', 'b', 'c', 'd']) full = drop(full, 'plot', { type: 'metric', name: n });
  assert.equal(accepts('plot', { type: 'metric', name: 'e' }, full).ok, false);
});

test('a plain trend becomes composable on its first drop, and undo brings it back exactly', () => {
  const ts = { code: 'CPU', kind: 'timeseries', title: 'CPU', query: 'avg(rate(cpu_seconds_total{cluster="x"}[5m]))', unit: '%', warn: 70, window: 60 };
  const v = drop(toView(ts), 'plot', { type: 'metric', name: 'mem_bytes' });
  assert.equal(toPanel(v).kind, 'compose');
  assert.deepEqual(sharedFilters(toView(ts)), [{ label: 'cluster', op: '=', value: 'x' }]);
  assert.deepEqual(toPanel(undo(v)), toPanel(toView(ts)));
});

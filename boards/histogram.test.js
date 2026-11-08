// Histogram bars know which series they are made of (boards/index.js histogram): node --test boards/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { histogram } from './index.js';

const row = (metric, v) => ({ metric, value: [0, String(v)] });

test('series binned by value: each bar names its series, and the max is named', () => {
  const out = histogram([row({ service: 'cart' }, 40), row({ service: 'checkout' }, 350), row({ service: 'search' }, 45), row({ service: 'auth' }, 120)], { query: 'x', unit: 'ms' });
  assert.equal(out.maxLabel, 'checkout');
  assert.deepEqual(out.buckets[0].members.map(m => m.name), ['search', 'cart']);
  assert.equal(out.buckets.at(-1).members[0].name, 'checkout');
  assert.match(out.buckets[0].range, /–/);
});

test('a Prometheus histogram kept by service: each bar says which services fill it', () => {
  const rows = [];
  for (const [svc, counts] of [['cart', [5, 6, 6]], ['checkout', [0, 1, 4]]])
    ['0.1', '0.5', '+Inf'].forEach((le, i) => rows.push(row({ service: svc, le }, counts[i])));
  const out = histogram(rows, { query: 'sum by (service, le) (rate(http_server_duration_seconds_bucket[5m]))' });
  assert.deepEqual(out.buckets[0].members.map(m => m.name), ['cart']);
  assert.deepEqual(out.buckets.at(-1).members.map(m => m.name), ['checkout']);
});

test('summed by le only: bars have no names, and nothing breaks', () => {
  const out = histogram([row({ le: '0.1' }, 2), row({ le: '+Inf' }, 3)], { query: 'sum by (le) (rate(x_seconds_bucket[5m]))' });
  assert.equal(out.buckets.every(b => b.members.length === 0), true);
});

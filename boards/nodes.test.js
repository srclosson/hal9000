import test from 'node:test';
import assert from 'node:assert/strict';
import { build, describe, workloadOf } from './nodes.js';

const s = (metric, v = 1) => ({ metric, value: [0, String(v)] });
const GiB = 1024 ** 3;

const series = {
  alloc: [s({ node: 'n1' }, 8 * GiB), s({ node: 'n2' }, 8 * GiB), s({ node: 'n3' }, 4 * GiB)],
  ready: [s({ node: 'n1' }, 1), s({ node: 'n2' }, 0), s({ node: 'n3' }, 1)],
  cordoned: [s({ node: 'n3' })],
  pods: [
    s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-abcde', node: 'n1' }),
    s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-fghij', node: 'n1' }),
    s({ namespace: 'shop', pod: 'cart-0', node: 'n1', workload: 'cart' }),
    s({ namespace: 'shop', pod: 'cart-0', node: 'n1', workload: 'cart' }),   // repeated per container: counted once
    s({ namespace: 'shop', pod: 'search-5f6c7d8e9-zzzzz', node: 'n2' }),
    s({ namespace: 'kube-system', pod: 'job-done-xyz12', node: 'n3' }),
    s({ namespace: 'shop', pod: 'payments-6b7c8d9e0-qqqqq', node: '' }),
  ],
  owners: [s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-abcde', owner_kind: 'ReplicaSet', owner_name: 'checkout-7d9f8b6c4' }),
    s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-fghij', owner_kind: 'ReplicaSet', owner_name: 'checkout-7d9f8b6c4' })],
  phase: [s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-abcde', phase: 'Running' }), s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-fghij', phase: 'Running' }),
    s({ namespace: 'shop', pod: 'cart-0', phase: 'Running' }), s({ namespace: 'shop', pod: 'search-5f6c7d8e9-zzzzz', phase: 'Running' }),
    s({ namespace: 'kube-system', pod: 'job-done-xyz12', phase: 'Succeeded' }), s({ namespace: 'shop', pod: 'payments-6b7c8d9e0-qqqqq', phase: 'Pending' })],
  waiting: [s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-fghij', reason: 'CrashLoopBackOff' })],
  restarts: [s({ namespace: 'shop', pod: 'cart-0' }, 2)],
  used: [s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-abcde' }, 3 * GiB), s({ namespace: 'shop', pod: 'checkout-7d9f8b6c4-fghij' }, 3 * GiB),
    s({ namespace: 'shop', pod: 'cart-0' }, 1.5 * GiB)],
  requested: [s({ namespace: 'shop', pod: 'search-5f6c7d8e9-zzzzz' }, 512 * 1024 ** 2)],
};

test('workloads: owners and generated names folded to the workload', () => {
  assert.deepEqual(workloadOf(s({ pod: 'x-7d9f8b6c4-abcde' }), { owner_kind: 'ReplicaSet', owner_name: 'x-7d9f8b6c4' }), { name: 'x', kind: 'Deployment' });
  assert.equal(workloadOf(s({ pod: 'db-2' }), { owner_kind: 'StatefulSet', owner_name: 'db' }).name, 'db');
  assert.equal(workloadOf(s({ pod: 'agent-k2j4x' })).name, 'agent');
});

test('the map: nodes, workloads, memory and trouble', () => {
  const m = build(series);
  const n1 = m.nodes.find(n => n.name === 'n1');
  const checkout = n1.workloads.find(w => w.name === 'checkout');
  assert.equal(checkout.pods.length, 2);
  assert.equal(checkout.status, 'crit');
  assert.match(checkout.reason, /CrashLoopBackOff/);
  assert.equal(n1.workloads.find(w => w.name === 'cart').status, 'warn');   // restarts
  assert.equal(n1.workloads.find(w => w.name === 'cart').pods.length, 1);
  assert.equal(Math.round(n1.pct), 94);    // 7.5 of 8 GiB
  assert.equal(n1.status, 'warn');
  assert.equal(m.nodes.find(n => n.name === 'n2').status, 'crit');   // not ready
  assert.equal(m.nodes.find(n => n.name === 'n2').workloads[0].memShown, 'requested');
  const n3 = m.nodes.find(n => n.name === 'n3');
  assert.equal(n3.status, 'warn');   // cordoned
  assert.equal(n3.workloads.length, 0);   // a finished job takes no room
  const pending = m.nodes.at(-1);
  assert.ok(pending.unscheduled);
  assert.equal(pending.workloads[0].name, 'payments');
  assert.equal(m.status, 'crit');
  assert.match(m.display, /NODES/);
  assert.match(describe({ cluster: 'c', ...m }), /node n2 .*NOT READY/);
});

test('a pod placed on an unknown node is put where cAdvisor saw it; one nowhere known is flagged', () => {
  const m = build({ alloc: [s({ node: 'real-1' }, 8 * GiB)], ready: [s({ node: 'real-1' }, 1)],
    pods: [s({ namespace: 'x', pod: 'a-0', node: 'node0', workload: 'a' }), s({ namespace: 'x', pod: 'b-0', node: 'ghost', workload: 'b' })],
    used: [s({ namespace: 'x', pod: 'a-0', node: 'real-1' }, GiB)] });
  assert.equal(m.nodes.find(n => n.name === 'real-1').workloads[0].name, 'a');
  assert.deepEqual(m.nodes.find(n => n.name === 'ghost').notes, ['NO NODE DATA']);
  assert.equal(m.nodes.some(n => n.name === 'node0'), false);
});

test('a healthy cluster reads NOMINAL', () => {
  const m = build({ alloc: [s({ node: 'a' }, 8 * GiB)], ready: [s({ node: 'a' }, 1)], pods: [s({ namespace: 'x', pod: 'web-0', node: 'a', workload: 'web' })],
    phase: [s({ namespace: 'x', pod: 'web-0', phase: 'Running' })], used: [s({ namespace: 'x', pod: 'web-0' }, GiB)] });
  assert.equal(m.display, 'NOMINAL');
  assert.equal(m.status, 'ok');
});

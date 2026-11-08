import test from 'node:test';
import assert from 'node:assert/strict';
import * as resume from './index.js';
import { plainHistory } from '../brain.js';
import * as boards from '../boards/index.js';

// A store in memory standing in for StackGen Incidents' settings documents.
const docs = new Map(), writes = [];
resume.setStore({ load: async name => docs.get(name) ?? null, save: async (name, doc) => { writes.push(name); docs.set(name, doc); return true; } });

test('parts are saved when they change, and given back at the next start', async () => {
  let n = { count: 1 }, got = null;
  resume.register('test-part', { save: () => n, restore: d => { got = d; } });
  resume.register('test-broken', { save: () => { throw new Error('boom'); }, restore: () => { throw new Error('boom'); } });
  writes.length = 0;
  await resume.save();
  assert.ok(writes.includes('test-part'));
  writes.length = 0;
  await resume.save();
  assert.ok(!writes.includes('test-part'), 'unchanged: not written again');
  n = { count: 2 };
  await resume.save();
  assert.ok(writes.includes('test-part'));
  const done = await resume.restore();
  assert.deepEqual(got, { count: 2 });
  assert.ok(done.includes('test-part') && !done.includes('test-broken'), 'a part that fails is left out, the rest come back');
});

test('fit keeps the newest items within a size', () => {
  const xs = Array.from({ length: 10 }, (_, i) => ({ i, pad: 'x'.repeat(100) }));
  const kept = resume.fit(xs, 500);
  assert.ok(JSON.stringify(kept).length <= 500);
  assert.equal(kept.at(-1).i, 9);
});

test('a conversation is kept as its spoken exchanges, without the tool calls in between', () => {
  const messages = [
    { role: 'user', content: 'How is the kubernetes cluster?' },
    { role: 'assistant', content: '', tool_calls: [{ id: '1', function: { name: 'investigate' } }] },
    { role: 'tool', tool_call_id: '1', content: '{"pods":9}' },
    { role: 'assistant', content: 'Nine pods are crash-looping on kubernetes.' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    { role: 'user', content: 'And Ghost?' },
    { role: 'assistant', content: [{ type: 'text', text: 'Ghost is stuck on a migration lock.' }] },
    { role: 'user', content: 'Thanks' },   // unanswered when it restarted: dropped
  ];
  assert.deepEqual(plainHistory(messages), [
    { role: 'user', content: 'How is the kubernetes cluster?' },
    { role: 'assistant', content: 'Nine pods are crash-looping on kubernetes.' },
    { role: 'user', content: 'And Ghost?' },
    { role: 'assistant', content: 'Ghost is stuck on a migration lock.' },
  ]);
  const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const kept = plainHistory(long);
  assert.equal(kept.length, 16);
  assert.equal(kept[0].role, 'user');
  assert.equal(kept.at(-1).content, 'm39');
});

test('a ship\'s recent views and the board on its screens come back, live', async () => {
  const sent = [];
  await boards.bringBack({ FCB6: { views: [{ id: 'b7', title: 'Tempo', story: false, spec: { title: 'Tempo', panels: [{ code: 'TMP', title: 'Tempo restarts', kind: 'stat', query: 'up' }] } }], active: 'b7' } },
    () => msg => sent.push(msg));
  assert.deepEqual(boards.views('FCB6'), [{ id: 'b7', title: 'Tempo', kind: 'board' }]);
  assert.equal(boards.activeId('FCB6'), 'b7');
  assert.equal(sent.at(-1)?.type, 'board');
  assert.equal(sent.at(-1).board.title, 'Tempo');
  assert.deepEqual(boards.kept().FCB6.active, 'b7');
  boards.stop('FCB6');
});

test('a part that could not be read at start is never written over what was kept, and is read again later', async () => {
  const kept = new Map([['test-slow', { at: 1, data: { items: ['a', 'b'] } }]]), saved = [];
  let down = true, got = null, mine = { items: [] };
  resume.setStore({ load: async n => { if (down && n === 'test-slow') throw new Error('timeout'); return kept.get(n) ?? null; },
    save: async (n, doc) => { saved.push(n); kept.set(n, doc); return true; } });
  resume.register('test-slow', { save: () => mine, restore: d => { got = d; mine = { items: [...d.items, 'c'] }; } });
  await resume.restore();
  await resume.save();
  assert.ok(!saved.includes('test-slow'), 'not written while unread');
  assert.deepEqual(kept.get('test-slow').data, { items: ['a', 'b'] });
  down = false;
  await resume.save();
  assert.deepEqual(got, { items: ['a', 'b'] }, 'read late');
  assert.deepEqual(kept.get('test-slow').data, { items: ['a', 'b', 'c'] }, 'then written, with what was kept');
});

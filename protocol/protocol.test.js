import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TO_SERVER, TO_SCREENS } from '../public/protocol.js';

const root = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
// The server's own code: every .js outside public/, node_modules and tests.
const serverFiles = (dir = root) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? (['node_modules', 'public', '.git'].includes(e.name) ? [] : serverFiles(path.join(dir, e.name)))
    : e.name.endsWith('.js') && !e.name.endsWith('.test.js') ? [path.join(dir, e.name)] : []);
const all = (re, s) => new Set([...s.matchAll(re)].map(m => m[1]));
const sorted = s => [...s].sort();

test('every message the 9000 sends to a screen is in the contract, and the contract has nothing it never sends', () => {
  const sent = new Set();
  for (const f of serverFiles()) for (const t of all(/(?:broadcast\([^,()]+,\s*|send\(|JSON\.stringify\()\{\s*type: '(\w+)'/g, fs.readFileSync(f, 'utf8'))) sent.add(t);
  for (const t of all(/return \{ type: '(\w+)'/g, read('server.js'))) sent.add(t);   // views(): built, then broadcast
  assert.deepEqual(sorted(sent), sorted(Object.keys(TO_SCREENS)));
});

test('every message a screen sends is one the 9000 handles, and both are in the contract', () => {
  const handled = all(/msg\.type === '(\w+)'/g, read('server.js'));
  const sdk = all(/send\(\{ type: '(\w+)'/g, read('public/shared.js'));
  assert.deepEqual(sorted(handled), sorted(Object.keys(TO_SERVER)));
  assert.deepEqual(sorted(sdk), sorted(Object.keys(TO_SERVER)));
});

test('the screens\' SDK passes on every message the 9000 sends', () => {
  const passed = all(/msg\.type === '(\w+)'/g, read('public/shared.js'));
  assert.deepEqual(sorted(passed), sorted(Object.keys(TO_SCREENS)));
});

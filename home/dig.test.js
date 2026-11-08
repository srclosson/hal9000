import test from 'node:test';
import assert from 'node:assert/strict';
import { readDig, digQuestion } from './index.js';
import { toolsFor } from '../brain.js';

test('a dig reply is read into finding, detail, advice and effort, even flattened to one line', () => {
  const r = readDig('FINDING: checkout-7f9 OOMKilled at its 256Mi limit. DETAIL: last ended OOMKilled, exit 137, 14 restarts/h; last lines show heap growth. ADVICE: raise checkout memory to 512Mi; it dies at the current limit. EFFORT: quick');
  assert.deepEqual(r, { finding: 'checkout-7f9 OOMKilled at its 256Mi limit', detail: 'last ended OOMKilled, exit 137, 14 restarts/h; last lines show heap growth.',
    advice: 'raise checkout memory to 512Mi; it dies at the current limit', effort: 'quick' });
  assert.equal(readDig('I could not reach a conclusion just now.'), null);
  assert.equal(readDig(null), null);
});

test('a raw, multi-line dig reply keeps its runbook commands intact (no speech cleaning)', () => {
  const reply = `**FINDING:** Ghost migration lock blocks startup
**DETAIL:** knex-migrator reports the lock held;
exit 1 after 20 s.
**ADVICE:** back up, then release the lock.
**EFFORT:** quick
**SERVICES:** ghost, ghost_mysql
RUNBOOKS: [{"title":"Ghost migration lock","services":["ghost"],"steps":[{"kind":"act","text":"Back up the database","command":"kubectl -n ghost exec ghost-mysql-0 -- sh -c 'mysqldump -u root -p\\"$MYSQL_ROOT_PASSWORD\\" --all-databases' > ghost.sql"},{"kind":"check","text":"Watch it","command":"kubectl -n ghost get pods -w | grep ghost"}]}]`;
  const r = readDig(reply);
  assert.equal(r.finding, 'Ghost migration lock blocks startup');
  assert.equal(r.detail, 'knex-migrator reports the lock held; exit 1 after 20 s.');
  assert.deepEqual(r.services, ['ghost', 'ghost_mysql']);
  assert.equal(r.runbooks[0].steps[0].command, `kubectl -n ghost exec ghost-mysql-0 -- sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --all-databases' > ghost.sql`);
  assert.equal(r.runbooks[0].steps[1].command, 'kubectl -n ghost get pods -w | grep ghost');
});

test('the dig question asks for act steps with commands even when an owner makes the change', () => {
  const q = digQuestion({ dig: { about: 'kubernetes: 9 pods crash-looping' } });
  assert.match(q, /Always include the act steps, with commands/);
  assert.match(q, /--from-env-file=/);
  assert.match(q, /never an echo or a STOP note/);
  assert.match(q, /<placeholder>/);
});

test('the dig question names the problem and asks for advice, not homework', () => {
  const q = digQuestion({ dig: { about: 'retail: 2 pods crash-looping; alerts firing 1', guess: 'possibly OOM' } });
  assert.match(q, /retail: 2 pods crash-looping/);
  assert.match(q, /first guess, before looking: possibly OOM/);
  assert.match(q, /why each container last ended/);
  assert.match(q, /never a step to go and look/);
});

test('digging in offers only tools that look', () => {
  const names = toolsFor({ name: 'HAL', loaded: new Set(), looking: true }, null).map(t => t.name);
  for (const n of ['propose_fix', 'show_panels', 'show_story', 'remember', 'open_incident', 'snooze_problem', 'remind_me']) assert.ok(!names.includes(n), n);
  const all = toolsFor({ name: 'HAL', loaded: new Set() }, null).map(t => t.name);
  assert.ok(names.length <= all.length);
});

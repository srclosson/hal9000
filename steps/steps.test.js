import test from 'node:test';
import assert from 'node:assert/strict';
import * as steps from './index.js';
import { spokenLine } from '../tts/index.js';
import { persona } from '../brain.js';

test('a steps card keeps commands exactly, with their kind and what to expect', async () => {
  const cards = [];
  const out = await steps.call('show_steps', { title: 'Back up and release the Ghost migration lock', steps: [
    { kind: 'act', text: 'Back up the database first', command: `kubectl -n ghost exec ghost-mysql-0 -- sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --all-databases' > ghost.sql`, expect: 'ghost.sql is a few MB' },
    { kind: 'LOOK', text: 'Check the lock', command: 'kubectl -n ghost logs deploy/ghost --tail=50 | grep -i migration_lock' },
    { kind: 'nonsense', text: 'Restart Ghost' }, { text: '' }] }, { cards });
  assert.match(out, /on the screen/);
  assert.equal(cards.length, 1);
  const [c] = cards;
  assert.equal(c.steps.length, 3, 'a step with no text is dropped');
  assert.equal(c.steps[0].command, `kubectl -n ghost exec ghost-mysql-0 -- sh -c 'mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --all-databases' > ghost.sql`);
  assert.deepEqual(c.steps.map(s => s.kind), ['act', 'look', 'act']);
  assert.match(c.id, /^[0-9a-f]{12}$/);
});

test('a card with a secret in it, no title or no steps is refused; with no screen it says so', async () => {
  assert.match(String(steps.card({ title: 'Fix', steps: [{ text: 'Log in', command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" https://x' }] })), /^Error: .*a bearer token/);
  assert.match(String(steps.card({ title: 'Fix', steps: [{ text: 'Set it', command: 'export PASSWORD=hunter2hunter2' }] })), /a password or secret value/);
  assert.equal(typeof steps.card({ title: 'Fix', steps: [{ text: 'Set it', command: 'kubectl create secret generic s --from-env-file=s.env' }] }), 'object', 'naming where a secret lives is fine');
  assert.match(String(steps.card({ steps: [{ text: 'x' }] })), /title/);
  assert.match(String(steps.card({ title: 'x', steps: [] })), /at least one step/);
  assert.match(await steps.call('show_steps', { title: 't', steps: [{ text: 'x' }] }, {}), /no screen/);
});

test('the voice says only the first plain sentence of a written answer', () => {
  assert.equal(spokenLine('Ghost is stuck on a migration lock since 09:12.\n\n- It blocks `ghost-57b9`\n- **Back up first**'), 'Ghost is stuck on a migration lock since 09:12. The rest is on the screen.');
  assert.equal(spokenLine('The steps are on your screen.', 1), 'The steps are on your screen.');
  assert.equal(spokenLine('Nine pods are crash-looping.'), 'Nine pods are crash-looping.');
  assert.equal(spokenLine('Tempo uses `tempo_ingester` here.', 1), 'Tempo uses tempo_ingester here. The rest is on the screen.');
  assert.equal(spokenLine('```\nkubectl get pods\n```'), 'The details are on the screen.');
});

test('a typed question is answered in writing, a spoken one for the voice; both put commands on a card', () => {
  const spoken = persona('HAL'), written = persona('HAL', true);
  assert.match(spoken, /read aloud/);
  assert.match(spoken, /No lists, markdown/);
  assert.match(written, /typed into the chat/);
  assert.match(written, /Light markdown is fine/);
  for (const p of [spoken, written]) assert.match(p, /show_steps/);
  assert.equal(written.replace(/[\s\S]*?\n\nCharacter:/, ''), spoken.replace(/[\s\S]*?\n\nCharacter:/, ''), 'the character and the rules after it are the same');
});

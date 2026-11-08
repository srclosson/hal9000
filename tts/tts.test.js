import test from 'node:test';
import assert from 'node:assert/strict';
import { sentences, speakable } from './index.js';

test('the voice is given identifiers the way a person reads them; the screen keeps them as written', () => {
  assert.equal(speakable('connecting to the Kubernetes API at 192.168.1.21:6443 failed'), 'connecting to the Kubernetes API at 192 dot 168 dot 1 dot 21, port 6443 failed');
  assert.equal(speakable('I am running 0.40.0 now.'), 'I am running version 0 point 40 point 0 now.');
  assert.equal(speakable('Version 1.32.4 and v2.0.1.'), 'Version 1 point 32 point 4 and version 2 point 0 point 1.');
  assert.equal(speakable('Confusion was 0.76 at 14:05, 3.5 per second.'), 'Confusion was 0.76 at 14:05, 3.5 per second.', 'plain numbers and times are left alone');
});

test('sentences end at a full stop followed by a space, never inside a number or an address', () => {
  assert.deepEqual(sentences('Confusion was 0.76 on 192.168.1.21 this morning. It has recovered since then, mostly.'),
    ['Confusion was 0.76 on 192.168.1.21 this morning.', 'It has recovered since then, mostly.']);
  assert.deepEqual(sentences('Yes. Tempo is down.'), ['Yes. Tempo is down.'], 'a very short sentence rides along with the next');
  assert.deepEqual(sentences(''), ['']);
});

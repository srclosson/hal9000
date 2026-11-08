import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake StackGen Incidents: open incidents, and what was posted.
let open = [], posted = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b = body ? JSON.parse(body) : null;
    let out = open;
    if (req.method === 'POST' && req.url === '/api/incidents') { out = { ref: 'INC-0042', ...b }; posted.push(['open', b]); }
    else if (req.method === 'POST') posted.push(['event', req.url.split('/')[3], b]);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
await new Promise(r => server.listen(0, r));
process.env.INCIDENTS_URL = `http://127.0.0.1:${server.address().port}`;
process.env.INCIDENTS_TOKEN = 'test-only';
const { review, read, question } = await import('./review.js');

const run = { uid: 'abc', title: 'Checkout errors', cluster: 'retail', service: 'checkout', status: 'completed', startedAt: Date.now() - 9 * 60_000,
  finishedAt: Date.now(), summary: 'Root cause: payments-db pod payments-db-0 out of disk.', url: 'https://aiden.example/i/1' };
const reply = file => `VERDICT: wrong. PROBLEMS: Aiden blames payments-db-0, which does not exist; checkout is OOMKilled at 256Mi (exit 137). FILE: ${file} TITLE: names pods that do not exist. SAY: Aiden blamed a database pod that does not exist; checkout is running out of memory.`;

test('the question asks for a critical, evidence-based review and lists open feedback', () => {
  const q = question(run, [{ ref: 'INC-0007', title: 'Aiden feedback: slow on simple alerts' }]);
  assert.match(q, /demanding, critical reviewer/);
  assert.match(q, /every criticism must rest on evidence you checked/);
  assert.match(q, /INC-0007 "Aiden feedback: slow on simple alerts"/);
  assert.match(q, /payments-db-0 out of disk/);
});

test('a reply is read, and a bad one is not', () => {
  assert.deepEqual(read(reply('NEW')).file, 'NEW');
  assert.equal(read(reply('INC-0007')).file, 'INC-0007');
  assert.equal(read('**VERDICT:** good\n**PROBLEMS:** none\n**FILE:** NONE\n**TITLE:** none\n**SAY:** Aiden got it right: _checkout_ is OOMKilled.').say, 'Aiden got it right: checkout is OOMKilled.', 'a raw dig reply is cleaned as speech');
  assert.equal(read('No conclusion.'), null);
});

test('a new kind of problem opens a severity 4 feedback incident with the details', async () => {
  open = []; posted = [];
  const v = await review(run, { digIn: async () => ({ reply: reply('NEW') }) });
  assert.equal(v.action, 'opened');
  assert.equal(v.ref, 'INC-0042');
  const [, b] = posted.find(p => p[0] === 'open');
  assert.equal(b.title, 'Aiden feedback: names pods that do not exist');
  assert.equal(b.severity, 4);
  const ev = posted.find(p => p[0] === 'event');
  assert.equal(ev[1], 'INC-0042');
  assert.match(ev[2].body, /Aiden's result:\nRoot cause: payments-db pod/);
  assert.match(ev[2].body, /https:\/\/aiden.example\/i\/1/);
});

test('another case of an open one is added to it; a good result files nothing', async () => {
  open = [{ ref: 'INC-0007', title: 'Aiden feedback: names pods that do not exist' }, { ref: 'INC-0008', title: 'Checkout down' }];
  posted = [];
  const v = await review(run, { digIn: async () => ({ reply: reply('INC-0007') }) });
  assert.equal(v.action, 'noted');
  assert.deepEqual(posted.map(p => p.slice(0, 2)), [['event', 'INC-0007']]);
  assert.match(posted[0][2].body, /^Another case/);
  posted = [];
  const ok = await review(run, { digIn: async () => ({ reply: 'VERDICT: good. PROBLEMS: none. FILE: NONE TITLE: none. SAY: Aiden got it right: checkout is OOMKilled.' }) });
  assert.equal(ok.ref, null);
  assert.equal(posted.length, 0);
  server.close();
});

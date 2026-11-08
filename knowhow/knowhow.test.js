import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake Know-how: canned advice and orders, and what was posted.
let posted = [], orders = [], down = false;
const drafts = [
  { ref: 'RB-0003', status: 'draft', source_ref: 'situation board kubernetes:CLB', services: ['nextcloud'], created_by: 'HAL 9000', updated_by: 'HAL 9000' },
  { ref: 'RB-0004', status: 'draft', source_ref: 'situation board kubernetes:CLB', services: ['ghost'], created_by: 'HAL 9000', updated_by: 'Stephanie' },
  { ref: 'RB-0006', status: 'draft', source_ref: 'situation board kubernetes:RST', services: ['tempo-ingester'], created_by: 'HAL 9000', updated_by: 'HAL 9000' },
  { ref: 'RB-0007', status: 'draft', source_ref: 'situation board other:ERR', services: ['ghost'], created_by: 'HAL 9000', updated_by: 'HAL 9000' },
];
const advice = { advice: [{ ref: 'RB-0004', runbook: 'Tempo store fails to initialise', status: 'approved', score: 0.62, confidence: 'high',
  why: '3 of 3 similar cases held, last on 2026-10-30.', next: { kind: 'look', text: 'Read the last termination log', tool: 'k8s_logs', args: { pod_name: 'tempo-ingester-0', previous: true } } }],
  precedents: [], orders: [{ kind: 'require_approval', instruction: 'Ask Stephanie before changing observability.', author: 'Stephanie' }], unknown: false };
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const b = body ? JSON.parse(body) : null;
    let out = {};
    if (down) { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"unavailable"}'); }
    if (req.url.startsWith('/api/advise')) out = advice;
    else if (req.url.startsWith('/api/orders/for')) { out = orders; posted.push(['orders', req.url]); }
    else if (req.url === '/api/runbooks') { out = { ref: 'RB-0009', status: 'draft', ...b }; posted.push(['draft', b]); }
    else if (req.url === '/api/runbooks?status=draft') out = drafts;
    else if (/^\/api\/runbooks\/RB-\d+$/.test(req.url) && req.method === 'GET') out = drafts.find(d => req.url.endsWith(d.ref));
    else if (/^\/api\/runbooks\/RB-\d+$/.test(req.url) && req.method === 'PATCH') { out = { ref: req.url.split('/').at(-1), ...b }; posted.push(['redraft', req.url.split('/').at(-1), b]); }
    else if (req.url === '/api/cases') { out = { ref: 'CS-0012' }; posted.push(['case', b]); }
    else { posted.push([req.url, b]); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});
await new Promise(r => server.listen(0, r));
process.env.KNOWHOW_URL = `http://127.0.0.1:${server.address().port}`;
process.env.KNOWHOW_TOKEN = 'test-only';
const kh = await import('./index.js');
const { readDig, digQuestion } = await import('../home/index.js');

test('advice becomes lines for the dig question, with the orders and the first read-only step', async () => {
  const k = await kh.advise({ text: 'tempo crash-looping', clusters: ['c1'], signals: ['CLB'] });
  const q = digQuestion({ dig: { about: 'c1: 2 pods crash-looping; alerts firing 1' } }, k);
  assert.match(q, /Standing order \(require approval, from Stephanie\): Ask Stephanie before changing observability\./);
  assert.match(q, /Runbook RB-0004 "Tempo store fails to initialise" \(approved, high confidence\): 3 of 3 similar cases held/);
  assert.match(q, /k8s_logs \{"pod_name":"tempo-ingester-0","previous":true\}/);
  assert.match(q, /If a runbook above fits, run its read-only steps first/);
  assert.equal(kh.covering(k).ref, 'RB-0004');
  assert.doesNotMatch(digQuestion({ dig: { about: 'x' } }, null), /Know-how/);
});

test('a dig reply carries one runbook per separate cause, each with its services and steps', () => {
  const r = readDig('FINDING: Tempo and Nextcloud are crash-looping for separate reasons. DETAIL: tempo "failed to init store: access denied"; nextcloud data 35.0.1.1 ahead of image 34.0.1.2. ' +
    'ADVICE: restore tempo\'s bucket credentials; run a Nextcloud image matching its data. EFFORT: quick SERVICES: tempo-ingester, nextcloud. RUNBOOKS: [' +
    '{"title":"Tempo cannot read its S3 bucket","services":["tempo-ingester"],"steps":[{"kind":"look","text":"Read the last termination log","tool":"k8s_logs","args":{"pod_name":"tempo-ingester-0"},"saw":"access denied"},' +
    '{"kind":"act","text":"Restore the key in tempo-s3 from Vault","command":"kubectl -n observability rollout restart statefulset/tempo-ingester"},{"kind":"bogus"},{"kind":"check","text":"Ingesters ready"}]},' +
    '{"title":"Nextcloud image older than its data","services":["nextcloud"],"steps":[{"kind":"act","text":"Deploy a 35.x image","command":"kubectl -n nextcloud set image deploy/nextcloud nextcloud=nextcloud:35"}]},' +
    '{"title":"No usable steps","steps":[{"kind":"bogus"}]}]');
  assert.deepEqual(r.services, ['tempo-ingester', 'nextcloud']);
  assert.deepEqual(r.runbooks.map(b => [b.title, b.services, b.steps.map(s => s.kind)]), [
    ['Tempo cannot read its S3 bucket', ['tempo-ingester'], ['look', 'act', 'check']],
    ['Nextcloud image older than its data', ['nextcloud'], ['act']]]);
  // The older form, one list of steps, is one runbook titled by the finding.
  const one = readDig('FINDING: a thing. DETAIL: b. ADVICE: c. EFFORT: quick SERVICES: x RUNBOOK: [{"kind":"act","text":"do it"}]');
  assert.deepEqual(one.runbooks, [{ title: 'a thing', services: ['x'], steps: [{ kind: 'act', text: 'do it' }] }]);
  assert.equal(readDig('FINDING: a. DETAIL: b. ADVICE: c. EFFORT: auto SERVICES: none RUNBOOKS: NONE').runbooks, undefined);
  assert.equal(readDig('FINDING: a. DETAIL: b. ADVICE: c. EFFORT: quick RUNBOOKS: [not json').runbooks, undefined);
});

test('the dig question asks for separate runbooks with the look steps that showed the cause', () => {
  const q = digQuestion({ dig: { about: 'c1: 9 pods crash-looping' } }, null);
  assert.match(q, /one runbook per separate cause/);
  assert.match(q, /first the read-only lookups you actually ran that showed the cause, as look steps/);
  assert.match(q, /for a junior engineer who doesn't know the commands: each has a "command" they can paste/);
  assert.match(q, /after a step that backs it up, with the actual backup command/);
  assert.match(q, /sh -c 'mysqldump -u root -p"\$MYSQL_ROOT_PASSWORD"/, 'the password is read inside the pod, not on the laptop');
});

test('read-only lookups become commands a person can type; drafts carry them', async () => {
  assert.equal(kh.commandFor('k8s_logs', { namespace: 'observability', pod_name: 'tempo-ingester-0', previous: true, tail: 50 }), 'kubectl -n observability logs tempo-ingester-0 --previous --tail=50');
  assert.equal(kh.commandFor('k8s_get', { resource: 'configmaps', namespace: 'observability' }), 'kubectl -n observability get configmaps -o wide');
  assert.equal(kh.commandFor('k8s_get', { resource: 'deployment', name: 'ghost', namespace: 'ghost' }), 'kubectl -n ghost get deployment ghost -o yaml');
  assert.match(kh.commandFor('query_prometheus', { expr: 'up{job="tempo"}' }), /Explore, with the Prometheus data source:\nup\{job="tempo"\}$/);
  assert.equal(kh.commandFor('k8s_logs', { namespace: "it's" , pod_name: 'p' }), `kubectl -n 'it'\\''s' logs p --tail=100`);
  assert.equal(kh.commandFor('something_else', {}), null);
  // As the live dig wrote them, underscores dropped:
  assert.equal(kh.commandFor('k8slogs', { tail: 30, podname: 'nextcloud-5b796fcd65-8vbxz', previous: true, namespace: 'nextcloud' }), 'kubectl -n nextcloud logs nextcloud-5b796fcd65-8vbxz --previous --tail=30');
  assert.equal(kh.commandFor('k8sdescribe', { name: 'nextcloud-5b796fcd65-8vbxz', namespace: 'nextcloud', resourcetype: 'pod' }), 'kubectl -n nextcloud describe pod nextcloud-5b796fcd65-8vbxz');
  posted = [];
  await kh.draft({ title: 't', when: { text: 'w' }, steps: [{ kind: 'look', text: 'Read the log', tool: 'k8s_logs', args: { namespace: 'ns', pod_name: 'p', previous: true } },
    { kind: 'act', text: 'Fix it', command: 'kubectl -n ns rollout restart deploy/p' }, { kind: 'look', text: 'Odd tool', tool: 'mystery' }] });
  const steps = posted.find(p => p[0] === 'draft')[1].steps;
  assert.equal(steps[0].command, 'kubectl -n ns logs p --previous --tail=100');
  assert.equal(steps[1].command, 'kubectl -n ns rollout restart deploy/p', 'a command the dig wrote is kept');
  assert.equal(steps[2].command, undefined);
});

test('a re-dig updates the 9000\'s own drafts from that problem, and leaves ones a person edited', async () => {
  assert.deepEqual((await kh.draftsFrom('situation board kubernetes:CLB')).map(d => d.ref), ['RB-0003', 'RB-0004']);
  assert.deepEqual((await kh.draftsFrom('situation board kubernetes:')).map(d => d.ref), ['RB-0003', 'RB-0004', 'RB-0006'], 'any of the cluster\'s problems');
  posted = [];
  await kh.redraft('RB-0003', { title: 'Nextcloud image older than its data', steps: [{ kind: 'look', text: 'Log', tool: 'k8slogs', args: { namespace: 'nextcloud', podname: 'nc-1', previous: true } }] });
  await kh.redraft('RB-0004', { title: 'Ghost migration lock', steps: [{ kind: 'act', text: 'x', command: 'y' }] });
  const r = posted.filter(p => p[0] === 'redraft');
  assert.deepEqual(r.map(p => p[1]), ['RB-0003'], 'RB-0004 was edited by a person, so it is left alone');
  assert.equal(r[0][2].steps[0].command, 'kubectl -n nextcloud logs nc-1 --previous --tail=100');
});

test('standing orders: avoid refuses a plan, require approval goes on it', async () => {
  const fixes = await import('../fixes/index.js');
  orders = [{ kind: 'avoid', instruction: 'Do not restart nextcloud.', author: 'Stephanie' }];
  const g = await kh.guard({ title: 'Restart nextcloud', problem: 'crash-looping', steps: [{ tool: 'k8s_rollout_restart', args: { namespace: 'nextcloud', name: 'nextcloud' } }] });
  assert.equal(g.avoid.length, 1);
  assert.match(posted.at(-1)[1], /services=nextcloud/);
  if (fixes.available()) {
    const said = await fixes.call('propose_fix', { title: 'Restart nextcloud', problem: 'x', steps: [], expected: 'y', risk: 'z' }, { board: { room: 'R' } });
    assert.match(said, /a standing order says not to: "Do not restart nextcloud\." \(Stephanie\)/);
  }
  orders = [];
});

test('a plan that followed a runbook becomes a case, settled by how it ended; once', async () => {
  posted = [];
  const p = { id: 'P-7', title: 'Restore tempo credentials', problem: 'tempo cannot read S3', runbook: 'RB-0004', status: 'verified', decidedBy: 'Stephanie',
    steps: [{ tool: 'k8s_rollout_restart', args: { name: 'tempo-ingester' }, why: 'pick up the key', status: 'done' }] };
  await kh.planChanged(p);
  await kh.planChanged(p);
  const cs = posted.filter(x => x[0] === 'case');
  assert.equal(cs.length, 1);
  assert.equal(cs[0][1].runbook, 'RB-0004');
  const out = posted.find(x => x[0] === '/api/cases/CS-0012/outcome');
  assert.deepEqual(out[1], { outcome: 'held', source: 'scorecard', why: 'HAL\'s plan P-7 "Restore tempo credentials": its check passed.' });
  await kh.planChanged({ id: 'P-8', title: 'Undo: Restore tempo credentials', problem: 'Reverses plan P-7 (verified).', status: 'running', steps: [] });
  assert.equal(posted.filter(x => x[0] === '/api/cases/CS-0012/outcome').at(-1)[1].outcome, 'failed');
  await kh.planChanged({ id: 'P-9', title: 'No runbook', status: 'verified', steps: [] });
  assert.equal(posted.filter(x => x[0] === 'case').length, 1, 'plans without a runbook are not cases');
});

test('Know-how not answering is unknown, not "no drafts": the caller must not draft (it would duplicate)', async () => {
  down = true;
  try {
    assert.equal(await kh.draftsFrom('situation board kubernetes:'), null);
    assert.equal(await kh.advise({ text: 'x' }), null);
  } finally { down = false; }
  assert.equal((await kh.draftsFrom('situation board kubernetes:')).length, 3);
});

test.after(() => server.close());

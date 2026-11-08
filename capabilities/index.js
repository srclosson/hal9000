// Capability requests: when the 9000 can't answer for want of something (a service without traces, a panel kind the
// monitors can't draw), he can have it built, tried and shipped, through two gates a person holds. He never approves,
// merges or deploys his own work.
//
// GATE 1, "may I build it?": a plan (fixes/index.js) whose first step is the built-in
//   aiden_request_change { repository, kind, title, need, reason, change }
// followed by steps telling the owners a request is in progress. Approving it only lets Aiden work: the Aiden workflow
// named in settings (capabilities.workflow) makes the change on a branch and opens a pull request. Nothing ships.
//
// GATE 2, "ship what you tried?": a deployer outside the 9000 (CI with its own scoped credential; see the deployer
// interface below) builds the branch and puts up a preview, then records it here: its address, the exact image digest
// and the eval scores against production. The request is then READY TO TRY on every ship's monitor. A signed-in person
// opens the preview through /try/<id> (which records that they tried it), then on the real 9000's monitor:
//   ship      pins the digest they tried; the deployer merges and rolls out exactly that digest and reports it shipped
//             (a different digest is refused, the way a plan is pinned by its hash)
//   feedback  goes to Aiden on the same session and pull request; it iterates and the deployer builds a new preview
//   reject    Aiden is asked to close the pull request; the preview is torn down
// An untried preview expires after capabilities.trialHours and is torn down.
//
// Sandboxes, by kind of change (the deployer reads `sandbox`):
//   preview_app      the 9000's own code (panels, grammar, server): a preview 9000 at its own address, HAL_PREVIEW=1
//   preview_service  instrumentation of a service: a preview copy of the service in its own namespace, its telemetry
//                    tagged deployment.environment=preview
//   (in_place        a view preset or drop rule, pure data: tried on the requester's monitor, marked TRIAL; arrives
//                    with the canvas, docs/CANVAS.md)
// Branch code is never loaded into the normal monitor, which carries the person's sign-in.
//
// Lifecycle: building → (waiting) → pr_open → ready_to_try → approved → shipped
//            ready_to_try → changes_requested → building …  |  rejected  |  expired      any → failed
// Records are kept in StackGen Incidents (scope hal9000-capabilities), so a trial survives restarts.
//
//   capability_requests {}   the model's view of them

import fs from 'node:fs/promises';
import * as mcp from '../mcp/index.js';
import * as config from '../config/index.js';
import { registerStep } from '../fixes/index.js';
import { PREVIEW } from '../preview.js';

const KINDS = ['instrumentation', 'panel', 'feature'];
const FOLLOW_MS = 3 * 60_000, FOLLOWS = 6, PR_POLL_MS = 5 * 60_000, PR_WATCH_MS = 14 * 86_400_000;
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SCOPE = 'hal9000-capabilities', KEEP = 50;
// Local testing only: CAPABILITIES_TEST_FILE keeps the records in a file instead of StackGen Incidents, so a local server
// never writes to the shared store (and a test can seed a request that is ready to try).
const TEST_FILE = process.env.CAPABILITIES_TEST_FILE;
const loadRecords = () => (TEST_FILE ? fs.readFile(TEST_FILE, 'utf8').then(JSON.parse).catch(() => ({})) : config.loadDoc(SCOPE));
// Outside a cluster (a laptop with the shared credentials in .env) records are kept in memory only.
const IN_CLUSTER = !!process.env.KUBERNETES_SERVICE_HOST;
const saveRecords = doc => (TEST_FILE ? fs.writeFile(TEST_FILE, JSON.stringify(doc, null, 1)) : IN_CLUSTER ? config.saveDoc(SCOPE, doc) : Promise.resolve(false));
const OPEN = new Set(['building', 'waiting', 'pr_open', 'ready_to_try', 'changes_requested', 'approved']);

// "owner/name — what it holds", one per line.
export const repositories = () => String(config.get('capabilities.repositories') ?? '').split('\n').map(l => l.trim()).filter(Boolean)
  .map(l => { const [name, ...rest] = l.split(/\s+[—–-]+\s+/); return { name: name.trim(), about: rest.join(' — ').trim() }; })
  .filter(r => /^[\w.-]+\/[\w.-]+$/.test(r.name));
const sandboxOf = kind => (kind === 'instrumentation' ? 'preview_service' : 'preview_app');
// Aiden's tools carry their own prefix (aiden__run_workflow), so they are found by their ending.
const aidenTool = end => mcp.resolve(end) ?? [...mcp.list().map(t => t.name)].find(n => new RegExp(`(^|_)${end}$`).test(n)) ?? null;
const runTool = () => aidenTool('run_workflow');

// The workflow must exist (and be approved) in the Aiden workspace: checked every five minutes, so the 9000 never offers
// a request that would fail, and starts offering them once the workflow is created.
let workflowSeen = { at: 0, ok: false, key: '' };
const workflowKey = () => `${config.get('aiden.workspace')}|${config.get('capabilities.workflow')}`;
async function checkWorkflow() {
  const tool = aidenTool('list_workflows');
  if (!tool || !runTool()) return;
  const text = await mcp.call(tool, { stackgen_workspace_id: config.get('aiden.workspace'), limit: 200 }, { internal: true });
  let names = []; try { names = (JSON.parse(text).workflows ?? []).filter(w => w.status === 'approved').map(w => w.name); } catch { return; }
  workflowSeen = { at: Date.now(), ok: names.includes(config.get('capabilities.workflow')), key: workflowKey() };
}
if (!PREVIEW) {
  setInterval(() => checkWorkflow().catch(() => {}), 5 * 60_000).unref();
  mcp.onSync(() => { if (!workflowSeen.at || workflowSeen.key !== workflowKey()) checkWorkflow().catch(() => {}); });   // first sight, or a changed setting
}
export const available = () => !PREVIEW && !!runTool() && !!config.get('aiden.workspace') && repositories().length > 0 && workflowSeen.ok && workflowSeen.key === workflowKey();
export const workflowReady = () => workflowSeen.ok;

// ---- records -----------------------------------------------------------------------------------------------------
const requests = new Map();   // id -> request
let seq = 0;
const listeners = new Set();
export const onUpdate = fn => listeners.add(fn);
export const list = () => [...requests.values()];
export const get = id => requests.get(id) ?? null;
let saving = null;
function persist() {
  clearTimeout(saving);
  saving = setTimeout(() => saveRecords({ seq, requests: list().slice(-KEEP).map(({ watching, ...r }) => r) }).catch(err => console.error('Capabilities: save failed:', err.message)), 1000);
}
function update(req, changes, event, extra = {}) {
  Object.assign(req, changes, { updatedAt: Date.now() });
  if (event) (req.history ??= []).push({ at: Date.now(), event, ...extra });
  if (req.history?.length > 40) req.history = req.history.slice(-40);
  persist();
  if (event) for (const fn of listeners) try { fn(req, event, extra); } catch (err) { console.error('Capability listener:', err.message); }
}
// Back after a restart: the records, and following whatever was in flight.
async function restore() {
  const doc = await loadRecords().catch(() => null);
  if (!doc) return;
  seq = Math.max(seq, doc.seq ?? 0);
  for (const r of doc.requests ?? []) if (!requests.has(r.id)) requests.set(r.id, r);
  for (const r of requests.values()) {
    r.watching = false;
    if (r.status === 'building' && r.session) { r.follows = 0; follow(r); }
    if (r.pr && OPEN.has(r.status)) watchPr(r);
  }
  console.log(`Capabilities: ${requests.size} request(s) restored`);
}
if (!PREVIEW) setTimeout(() => { restore().catch(() => {}); checkWorkflow().catch(() => {}); }, 15_000).unref();

// ---- talking to Aiden ------------------------------------------------------------------------------------------
async function runWorkflow(args) {
  if (!runTool()) throw new Error('Aiden is not connected here (no run_workflow tool)');
  const text = await mcp.call(runTool(), { stackgen_workspace_id: config.get('aiden.workspace'), name: config.get('capabilities.workflow'), ...args }, { internal: true });
  if (/^Error\b/.test(text)) throw new Error(text.replace(/^Error[^:]*: /, '').slice(0, 300));
  let j = null; try { j = JSON.parse(text); } catch { /* plain text */ }
  return { status: j?.status ?? 'completed', session: j?.session_id ?? null, pr: text.match(PR_URL), text };
}
// What Aiden said, as a few words for a note (its final reply when the result has one).
const said = r => { let j; try { j = JSON.parse(r.text); } catch { return r.text.slice(0, 300); } return String(j.response ?? j.message ?? j.output ?? j.result ?? '').slice(0, 300); };

function firstMessage(req, plan) {
  return [
    `Capability request ${req.id} from the HAL 9000 operator (plan ${plan.id}, approved by ${plan.decidedBy ?? 'a signed-in person'}).`,
    `Repository: ${req.repository}`, `Kind: ${req.kind}`, `Title: ${req.title}`,
    `What is missing: ${req.need}`, `Why it matters: ${req.reason}`, `The change: ${req.change}`, '',
    `Make this change on a new branch in ${req.repository} and open a pull request for review. Do not merge it and do not deploy it:`,
    'a person will try a preview built from the branch and decide. Keep the change focused and follow the code style around it.',
    'When the pull request is open, reply with a line "PR: <url>".',
  ].join('\n');
}

// Apply one Aiden result to the request. Returns words for the plan step.
function absorb(req, r) {
  req.session = r.session ?? req.session;
  if (r.pr) {
    const pr = { url: r.pr[0], owner: r.pr[1], repo: r.pr[2], number: Number(r.pr[3]) };
    const updated = req.pr?.url === pr.url;
    retire(req);   // an updated branch needs a new preview; the old one is torn down
    update(req, { status: 'pr_open', pr: { ...req.pr, ...pr }, preview: null }, updated ? 'pr_updated' : 'pr_open');
    if (!updated) watchPr(req);
    return `Aiden ${updated ? 'updated' : 'opened'} the pull request ${pr.url} (request ${req.id}). It ships only after a person tries its preview and approves it.`;
  }
  if (r.status === 'timed_out') { if (req.status !== 'building') update(req, { status: 'building' }, 'building'); return `Aiden is still working on request ${req.id} (session ${req.session}); I am following it.`; }
  if (/^waiting/.test(r.status)) {
    const what = r.status === 'waiting_for_clarification' ? 'a clarification' : 'an approval';
    update(req, { status: 'waiting', note: `Aiden is waiting for ${what} in Guild (session ${req.session}).` }, 'waiting');
    return `Aiden is waiting for ${what} in Guild before it continues (request ${req.id}, session ${req.session}).`;
  }
  const note = r.status === 'failed' ? `Aiden's run failed: ${said(r)}` : `Aiden finished without a pull request: ${said(r)}`;
  update(req, { status: 'failed', note }, 'failed');
  return `Error: ${note}`;
}

// A run still going: ask its session again, a few times.
function follow(req) {
  if (req.follows >= FOLLOWS || req.status !== 'building') return;
  setTimeout(async () => {
    if (req.status !== 'building') return;
    req.follows++;
    try {
      absorb(req, await runWorkflow({ session_id: req.session, input: `Status check from the HAL 9000 for request ${req.id}: is the pull request open (or updated)? If so reply "PR: <url>". Make no other changes.` }));
    } catch (err) { req.note = err.message; }
    if (req.status === 'building') {
      if (req.follows >= FOLLOWS) update(req, { status: 'failed', note: `No pull request after ${FOLLOWS} checks; Aiden session ${req.session} may still be running.` }, 'failed');
      else follow(req);
    }
  }, FOLLOW_MS).unref();
}

// ---- following the pull request (with a read-only GitHub token) ----------------------------------------------------
function watchPr(req) {
  if (req.watching) return;
  req.watching = true;
  const tick = async () => {
    const token = config.get('capabilities.githubToken');
    if (!token || !req.pr || Date.now() - req.createdAt > PR_WATCH_MS || !(OPEN.has(req.status) || req.status === 'shipped') || req.pr.merged) { req.watching = false; return; }
    try {
      const res = await fetch(`https://api.github.com/repos/${req.pr.owner}/${req.pr.repo}/pulls/${req.pr.number}`,
        { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'hal9000' }, signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const pr = await res.json();
        req.pr.title = pr.title; req.pr.head = pr.head?.sha ?? req.pr.head;
        if (pr.merged_at) { update(req, { pr: { ...req.pr, merged: true, mergedBy: pr.merged_by?.login ?? null } }, 'merged'); req.watching = false; return; }
        if (pr.state === 'closed' && OPEN.has(req.status)) { retire(req); update(req, { status: 'rejected', note: 'The pull request was closed without merging.' }, 'closed'); req.watching = false; return; }
      }
    } catch { /* try again next time */ }
    setTimeout(tick, PR_POLL_MS).unref();
  };
  setTimeout(tick, PR_POLL_MS).unref();
}

// ---- gate 1: the plan step ---------------------------------------------------------------------------------------
registerStep({
  name: 'aiden_request_change',
  available,
  description: () => `Ask Aiden (StackGen) to build something you are missing, as a pull request in one of these repositories: ${repositories().map(r => `${r.name} (${r.about})`).join('; ')}. ` +
    'Use it when a question cannot be answered because instrumentation is missing (a service sends no traces, a metric does not exist) or the monitors cannot show it (a panel kind or element that does not exist). ' +
    'Approving the plan only lets Aiden work on a branch and open a pull request: nothing ships. Once a preview is built, a person tries it and decides on the monitor whether to ship exactly what they tried, send feedback, or reject it. ' +
    `Add steps after it that tell the owners a request is in progress (team chat message, issue) if such tools are listed. Owners: ${config.get('capabilities.owners')}`,
  inputSchema: () => ({ type: 'object', properties: {
    repository: { type: 'string', enum: repositories().map(r => r.name) },
    kind: { type: 'string', enum: KINDS, description: 'instrumentation (traces, metrics, logs a service lacks), panel (something the monitors cannot draw), feature (anything else)' },
    title: { type: 'string', description: 'The pull request title, e.g. "Trace the payments service"' },
    need: { type: 'string', description: 'What is missing, concretely' },
    reason: { type: 'string', description: 'The question it would answer, and what the person asked' },
    change: { type: 'string', description: 'What to change: where, and how, as far as you know (files, libraries, the shape of the result)' } },
    required: ['repository', 'kind', 'title', 'need', 'reason', 'change'] }),
  async run(args, plan) {
    if (!repositories().some(r => r.name === args.repository)) return `Error: ${args.repository} is not one of the repositories in settings.`;
    const kind = KINDS.includes(args.kind) ? args.kind : 'feature';
    const req = { id: `CR-${++seq}`, plan: plan.id, room: plan.room, repository: args.repository, kind, sandbox: sandboxOf(kind),
      title: String(args.title ?? '').slice(0, 120), need: String(args.need ?? '').slice(0, 800), reason: String(args.reason ?? '').slice(0, 800),
      change: String(args.change ?? '').slice(0, 2000), status: 'building', session: null, pr: null, preview: null, tried: [], feedback: [],
      approval: null, shipped: null, stale: [], note: null, follows: 0, requestedBy: plan.decidedBy, createdAt: Date.now(), updatedAt: Date.now() };
    requests.set(req.id, req);
    while (requests.size > KEEP) requests.delete(requests.keys().next().value);
    update(req, {}, 'building');
    let r;
    try { r = await runWorkflow({ input: firstMessage(req, plan) }); }
    catch (err) { update(req, { status: 'failed', note: err.message }, 'failed'); return `Error: Aiden could not take request ${req.id}: ${err.message}`; }
    const out = absorb(req, r);
    follow(req);
    return out;
  },
});

// ---- the deployer interface ---------------------------------------------------------------------------------------
// A preview no longer wanted (feedback, a decision, expiry) is queued for the deployer to tear down.
function retire(q) {
  if (q.preview && !q.preview.tornDown && !(q.stale ?? []).some(p => p.url === q.preview.url)) (q.stale ??= []).push({ url: q.preview.url, digest: q.preview.digest });
}
// Called by the deployer (server.js: /api/capabilities, with its own bearer token), never by the 9000 or a preview.
// What it should do next for each request is in wants(): build a preview, ship a pinned digest, tear old previews down.
export function wants(q) {
  const base = { sandbox: q.sandbox, repository: q.repository, pr: q.pr?.number ?? null };
  return [
    ...(q.status === 'pr_open' && q.pr && !q.preview ? [{ action: 'preview', ...base, head: q.pr.head ?? null }] : []),
    ...(q.status === 'approved' && q.approval && !q.shipped ? [{ action: 'ship', ...base, digest: q.approval.digest }] : []),
    ...(q.stale ?? []).filter(p => !p.tornDown).map(p => ({ action: 'teardown', ...base, url: p.url, digest: p.digest })),
  ];
}
// A preview is up: { url, digest, evals?: { prod, preview, regressed?: [names] } }. The person tries this digest.
export function recordPreview(id, body = {}) {
  const q = requests.get(id);
  if (!q) return { status: 404, error: `no request ${id}` };
  if (!['pr_open', 'ready_to_try', 'building'].includes(q.status) || !q.pr) return { status: 409, error: `${id} is ${q.status}; a preview is recorded once its pull request is open` };
  let url; try { url = new URL(String(body.url)); } catch { return { status: 400, error: 'url must be an absolute https address' }; }
  if (url.protocol !== 'https:') return { status: 400, error: 'url must be https' };
  if (!DIGEST.test(String(body.digest))) return { status: 400, error: 'digest must be sha256:<64 hex>' };
  const ev = body.evals && typeof body.evals === 'object' ? { prod: String(body.evals.prod ?? '').slice(0, 20), preview: String(body.evals.preview ?? '').slice(0, 20),
    regressed: (Array.isArray(body.evals.regressed) ? body.evals.regressed : []).map(x => String(x).slice(0, 80)).slice(0, 12) } : null;
  // A new digest is a new thing to try: earlier tries don't count for it.
  if (q.preview && q.preview.url !== url.href) retire(q);
  // A preview rebuilt at the same address replaces the old one there: nothing left to tear down for it.
  for (const p of q.stale ?? []) if (p.url === url.href && !p.tornDown) p.tornDown = Date.now();
  update(q, { status: 'ready_to_try', preview: { url: url.href, digest: body.digest, evals: ev, at: Date.now() }, tried: q.preview?.digest === body.digest ? q.tried : [] }, 'ready_to_try');
  return { status: 200, body: view(q) };
}
// The deployer shipped: only the pinned digest counts.
export function recordShipped(id, body = {}) {
  const q = requests.get(id);
  if (!q) return { status: 404, error: `no request ${id}` };
  if (q.status !== 'approved' || !q.approval) return { status: 409, error: `${id} is ${q.status}, not approved to ship` };
  if (body.digest !== q.approval.digest) {
    update(q, {}, 'digest_mismatch', { got: String(body.digest ?? '').slice(0, 80) });
    return { status: 409, error: `refused: ${id} was approved to ship ${q.approval.digest}, not ${body.digest}` };
  }
  retire(q);
  update(q, { status: 'shipped', shipped: { digest: body.digest, at: Date.now() } }, 'shipped');
  return { status: 200, body: view(q) };
}
// { url? }: that preview (or every one queued) is gone.
export function recordTornDown(id, body = {}) {
  const q = requests.get(id);
  if (!q) return { status: 404, error: `no request ${id}` };
  const gone = (q.stale ?? []).filter(p => !p.tornDown && (!body.url || p.url === body.url));
  for (const p of gone) p.tornDown = Date.now();
  // The current preview itself removed (its pull request closed): nothing is left to try.
  const current = q.preview && !q.preview.tornDown && (!body.url || q.preview.url === body.url);
  if (current) q.preview.tornDown = Date.now();
  if (current && ['ready_to_try', 'pr_open'].includes(q.status)) update(q, { status: 'rejected', note: 'Its preview was removed: the pull request was closed.' }, 'closed');
  else if (gone.length || current) update(q, {}, 'torn_down');
  return { status: 200, body: view(q) };
}
export function recordMerged(id) {   // for a deployer that merges, when no GitHub token is set here
  const q = requests.get(id);
  if (!q?.pr) return { status: 404, error: `no pull request for ${id}` };
  if (!q.pr.merged) update(q, { pr: { ...q.pr, merged: true } }, 'merged');
  return { status: 200, body: view(q) };
}

// Untried previews expire.
setInterval(() => {
  const ms = config.get('capabilities.trialHours') * 3_600_000;
  for (const q of requests.values()) if (q.status === 'ready_to_try' && Date.now() - q.preview.at > ms)
    { retire(q); update(q, { status: 'expired', note: `Not tried within ${config.get('capabilities.trialHours')} h.` }, 'expired'); }
}, 10 * 60_000).unref();

// ---- gate 2: try, then ship, send feedback, or reject (people only, on the real 9000) ---------------------------------
// /try/<id> records who opened which digest, then sends them to the preview.
export function tried(id, person) {
  const q = requests.get(id);
  if (!q?.preview || q.status !== 'ready_to_try') return null;
  if (person && !q.tried.some(t => t.person === person && t.digest === q.preview.digest)) {
    q.tried.push({ person, digest: q.preview.digest, at: Date.now() });
    update(q, {}, 'tried', { person });
  }
  return q.preview.url;
}
// decision: ship (with the digest the card showed) | feedback (with text) | reject. Returns words for the ship.
export async function decide(id, decision, person, { digest, text } = {}) {
  if (PREVIEW) return 'This is a preview of the 9000: what ships is decided on the real one.';
  const q = requests.get(id);
  if (!q) return 'There is no such request.';
  if (!person) return 'Only a signed-in person can decide what ships. Sign in on this monitor first.';
  if (q.status !== 'ready_to_try') return `${q.id} is ${words(q)}; there is nothing to decide right now.`;
  if (decision === 'ship') {
    if (digest !== q.preview.digest) return `The preview of ${q.id} changed since it was shown; look at it again.`;
    if (!q.tried.some(t => t.person === person && t.digest === digest)) return `Try the preview of ${q.id} first (Try it on the card), then decide.`;
    update(q, { status: 'approved', approval: { digest, by: person, at: Date.now() } }, 'approved', { person });
    return null;   // spoken by the update
  }
  if (decision === 'reject') {
    retire(q);
    update(q, { status: 'rejected', decidedBy: person }, 'rejected', { person });
    if (q.session) runWorkflow({ session_id: q.session, input: `Request ${q.id} was rejected by ${person} after trying the preview${text ? `: ${text}` : ''}. Close the pull request without merging it. Make no other changes.` }).catch(() => {});
    return null;
  }
  const note = String(text ?? '').trim().slice(0, 2000);
  if (!note) return 'Say what should change, then send it.';
  q.feedback.push({ person, text: note, digest: q.preview.digest, at: Date.now() });
  retire(q);
  update(q, { status: 'changes_requested' }, 'changes_requested', { person });
  if (!q.session) { update(q, { status: 'failed', note: 'No Aiden session to send the feedback to.' }, 'failed'); return null; }
  try {
    const r = await runWorkflow({ session_id: q.session, input: `Feedback on request ${q.id} from ${person}, who tried the preview of ${q.pr?.url ?? 'the pull request'}:\n${note}\n\nUpdate the same branch and pull request (do not open a new one, do not merge). When the update is pushed, reply with a line "PR: <url>".` });
    q.status = 'building'; q.follows = 0;
    absorb(q, r);
    follow(q);
  } catch (err) { update(q, { status: 'failed', note: err.message }, 'failed'); }
  return null;
}

// ---- words, views, and the model's tool --------------------------------------------------------------------------
const STATE = { building: 'Aiden is building it', waiting: 'Aiden is waiting in Guild', pr_open: 'pull request open, waiting for its preview',
  ready_to_try: 'ready to try', changes_requested: 'feedback sent to Aiden', approved: 'approved to ship, waiting for the deployer', shipped: 'shipped',
  rejected: 'rejected', expired: 'expired untried', failed: 'failed' };
export const words = q => STATE[q.status] ?? q.status;
export function describeRequest(q) {
  const ev = q.preview?.evals ? ` · evals ${q.preview.evals.prod} → ${q.preview.evals.preview}${q.preview.evals.regressed.length ? ` (regressed: ${q.preview.evals.regressed.join(', ')})` : ''}` : '';
  return `${q.id} "${q.title}" (${q.kind}, ${q.repository}): ${words(q)}${q.pr ? ` · ${q.pr.url}${q.pr.merged ? ' (merged)' : ''}` : ''}${ev}` +
    `${q.approval ? ` · approved by ${q.approval.by}` : ''}${q.note && ['failed', 'waiting', 'expired', 'rejected'].includes(q.status) ? ` · ${q.note}` : ''}`;
}
// For the monitors and the deployer: everything but the Aiden session.
export const view = q => q && ({ id: q.id, title: q.title, kind: q.kind, sandbox: q.sandbox, repository: q.repository, status: q.status, words: words(q),
  need: q.need, reason: q.reason, change: q.change, pr: q.pr && { url: q.pr.url, number: q.pr.number, merged: !!q.pr.merged },
  preview: q.preview && { url: `/try/${q.id}`, digest: q.preview.digest, evals: q.preview.evals, at: q.preview.at, tornDown: q.preview.tornDown ?? null },
  tried: (q.tried ?? []).filter(t => t.digest === q.preview?.digest).map(t => t.person), feedback: (q.feedback ?? []).slice(-3),
  approval: q.approval, shipped: q.shipped, stale: (q.stale ?? []).map(p => ({ url: p.url, tornDown: p.tornDown ?? null })), requestedBy: q.requestedBy, note: q.note, updatedAt: q.updatedAt, wants: wants(q) });
// The request waiting at gate 2 (newest first), for every ship's monitor.
export const awaiting = () => list().filter(q => q.status === 'ready_to_try').sort((a, b) => b.updatedAt - a.updatedAt).map(view);

export function tools() {
  if (PREVIEW || !requests.size && !available()) return [];
  return [{ name: 'capability_requests', description: 'The capability requests made through approved plans: where each stands (building, ready to try, approved, shipped…), with links and eval scores.',
    inputSchema: { type: 'object', properties: {} } }];
}
export const has = name => name === 'capability_requests';
export const describe = () => 'Checking capability requests';
export async function call() {
  return requests.size ? list().map(describeRequest).join('\n') : 'No capability requests have been made.';
}

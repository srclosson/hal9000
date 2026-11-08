// Know-how (https://know-how.stackgen.run): what worked before, what changed since, and what will likely work now.
// KNOWHOW_URL (in-cluster service URL) and KNOWHOW_TOKEN (a named API token made on Know-how's Settings page).
//
// The 9000 uses it in three places:
//   digging in      advise() before a dig, so a known problem starts from its runbook and the standing orders;
//                   draft() after one, when the advice needs a person to act and no runbook covers it yet
//   propose_fix     guard() first: an "avoid" order refuses the plan, a "require approval" order is put on it
//   plan outcomes   planChanged(): a plan that followed a runbook becomes a case, settled by how the plan ended
// The 9000 never approves a runbook or writes a standing order: Know-how refuses both from a token.

import { PREVIEW } from '../preview.js';
const URL_ = (process.env.KNOWHOW_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.KNOWHOW_TOKEN;
export const available = () => !!(URL_ && TOKEN);
export const link = ref => `${(process.env.KNOWHOW_PUBLIC_URL ?? URL_).replace(/\/$/, '')}/runbooks/${ref}`;

async function call(path, { method = 'GET', body, actor, timeoutMs = 10_000 } = {}) {
  // A preview (preview.js) asks for advice but never writes (advise is a POST that only reads).
  if (PREVIEW && method !== 'GET' && path !== '/api/advise') throw new Error('this is a preview of the 9000; writing to Know-how is switched off here');
  const res = await fetch(`${URL_}${path}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(actor && { 'X-Actor': actor }) },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data;
}

// advise({ text, services, clusters, signals }) -> { advice, precedents, orders, unknown } or null (unavailable, or it failed).
export async function advise(situation) {
  if (!available()) return null;
  try { return await call('/api/advise?actor=hal', { method: 'POST', body: situation, timeoutMs: 8000 }); }
  catch (err) { console.error(`Know-how advise: ${err.message}`); return null; }
}

// What Know-how knows, as lines for a dig question or a model's context ('' when nothing useful).
export function brief(k) {
  if (!k) return '';
  const lines = [];
  for (const o of k.orders ?? []) lines.push(`Standing order (${o.kind.replace('_', ' ')}, from ${o.author}): ${o.instruction}`);
  for (const a of (k.advice ?? []).filter(a => a.score >= 0.35)) {
    const look = a.next?.kind === 'look' ? ` Its first step, read-only: ${a.next.text}${a.next.tool ? ` (${a.next.tool} ${JSON.stringify(a.next.args ?? {})})` : ''}.` : '';
    lines.push(`Runbook ${a.ref} "${a.runbook}" (${a.status}, ${a.confidence} confidence): ${a.why}${look}`);
  }
  for (const p of k.precedents ?? []) lines.push(`Worked before without a runbook (${p.case}, ${p.when}): ${p.did.join('; ') || p.situation}`);
  return lines.length ? `What Know-how already knows (check it against the live data; it may be out of date):\n${lines.map(l => `- ${l}`).join('\n')}` : '';
}

// The runbook that already covers a situation well enough not to draft another, from an advise() result.
export const covering = k => (k?.advice ?? []).find(a => a.score >= 0.45) ?? null;

// The command a person types for one of the 9000's read-only lookups, so a junior engineer can run the same check
// (null for tools with no plain equivalent). Shell-quoted where a value could hold spaces.
const q = v => (/^[\w./:@=,-]+$/.test(String(v)) ? String(v) : `'${String(v).replace(/'/g, `'\\''`)}'`);
// Names are compared without case or punctuation: the model sometimes writes k8slogs / podname for k8s_logs / pod_name.
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function commandFor(tool, args = {}) {
  const a = Object.fromEntries(Object.entries(args ?? {}).map(([k, v]) => [norm(k), v]));
  const ns = a.namespace ? `-n ${q(a.namespace)} ` : '', pod = a.podname ?? a.pod ?? a.name, kind = a.resource ?? a.resourcetype ?? a.kind;
  switch (norm(tool)) {
    case 'k8slogs': return pod ? `kubectl ${ns}logs ${q(pod)}${a.container ? ` -c ${q(a.container)}` : ''}${a.previous ? ' --previous' : ''} --tail=${Number(a.tail) || 100}` : null;
    case 'k8sget': return kind ? `kubectl ${ns}get ${q(kind)}${a.name ? ` ${q(a.name)} -o yaml` : ' -o wide'}` : null;
    case 'k8sdescribe': return kind && a.name ? `kubectl ${ns}describe ${q(kind)} ${q(a.name)}` : null;
    case 'k8sevents': return `kubectl ${ns}get events --sort-by=.lastTimestamp`;
    case 'queryprometheus': return a.expr ? `# In Grafana → Explore, with the Prometheus data source:\n${a.expr}` : null;
    case 'querylokilogs': return a.logql ?? a.query ? `# In Grafana → Explore, with the Loki data source:\n${a.logql ?? a.query}` : null;
    default: return null;
  }
}
const withCommands = steps => steps.map(s => (s.command || !s.tool ? s : { ...s, ...(commandFor(s.tool, s.args) && { command: commandFor(s.tool, s.args) }) }));

// Drafts already written from board problems whose source_ref starts with this (one cluster's, say), so a re-dig
// after a restart, or the same causes seen as another problem (crash loops, then restarts), doesn't duplicate them.
// null when Know-how could not be asked.
export async function draftsFrom(sourcePrefix) {
  if (!available()) return [];
  try { return (await call('/api/runbooks?status=draft')).filter(r => String(r.source_ref ?? '').startsWith(sourcePrefix)); }
  catch (err) { console.error(`Know-how drafts: ${err.message}`); return null; }   // unknown, not none: the caller mustn't draft
}

// A re-dig's better steps for one of the 9000's own drafts. Left alone once a person has edited it (or approved it).
export async function redraft(ref, rb, me = 'HAL 9000') {
  if (!available()) return null;
  try {
    const cur = await call(`/api/runbooks/${ref}`);
    if (cur.status !== 'draft' || (cur.updated_by && cur.updated_by !== cur.created_by && !String(cur.updated_by).includes(me))) return cur;
    return await call(`/api/runbooks/${ref}`, { method: 'PATCH', body: { title: rb.title, steps: withCommands(rb.steps ?? []), note: 'HAL dug in again' } });
  } catch (err) { console.error(`Know-how redraft ${ref}: ${err.message}`); return null; }
}

// draft({ title, when, steps, source_ref }) -> the draft runbook { ref, ... } or null.
// actor: the person it is drafted for (a card saved from the chat; source 'agent', which Know-how accepts), else a dig's ('hal-dig').
export async function draft(rb, actor) {
  if (!available()) return null;
  try { return await call('/api/runbooks', { method: 'POST', actor: actor ? `${actor} via HAL 9000` : undefined, body: { ...rb, steps: withCommands(rb.steps ?? []), source: actor ? 'agent' : 'hal-dig' } }); }
  catch (err) { console.error(`Know-how draft: ${err.message}`); return null; }
}

// The standing orders that apply to a plan before it is shown: { avoid: [...], approval: [...] }.
// Services come from the plan's step arguments (deployment, name, service, namespace, app).
export async function guard(plan) {
  if (!available()) return { avoid: [], approval: [] };
  const services = [...new Set((plan.steps ?? []).flatMap(s => ['deployment', 'name', 'service', 'statefulset', 'app', 'namespace'].map(k => s.args?.[k]))
    .filter(v => typeof v === 'string' && v.length < 80))];
  const q = new URLSearchParams({ actor: 'hal', text: `${plan.title ?? ''}. ${plan.problem ?? ''}` });
  for (const s of services) q.append('services', s);
  try {
    const os = await call(`/api/orders/for?${q}`, { timeoutMs: 5000 });
    return { avoid: os.filter(o => o.kind === 'avoid'), approval: os.filter(o => o.kind === 'require_approval') };
  } catch (err) { console.error(`Know-how orders: ${err.message}`); return { avoid: [], approval: [] }; }
}

// A plan that followed a runbook: a case once it has run, settled by how it ended. Once per plan.
const OUTCOME = { verified: ['held', 'its check passed'], unverified: ['failed', 'its check did not pass'], failed: ['failed', 'a step failed'] };
const cased = new Map();   // plan id -> case ref
export async function planChanged(p) {
  if (!available() || PREVIEW) return;
  // An undo of a plan that followed a runbook: the original did not hold.
  if (p.status === 'running' && /^Undo: /.test(p.title)) {
    const of = String(p.problem ?? '').match(/plan (\S+?)[ .(]/)?.[1], ref = of && cased.get(of);
    if (ref) await call(`/api/cases/${ref}/outcome`, { method: 'POST', body: { outcome: 'failed', source: 'scorecard', why: `Plan ${of} was undone (${p.id}).` } }).catch(() => {});
    return;
  }
  if (!p.runbook || !['verified', 'unverified', 'failed', 'done'].includes(p.status) || cased.has(p.id)) return;
  cased.set(p.id, null);
  try {
    const c = await call('/api/cases', { method: 'POST', actor: p.decidedBy ? `${p.decidedBy} via HAL 9000` : undefined, body: {
      runbook: p.runbook, alert_uid: p.alertUid ?? undefined, incident_ref: p.incident ?? undefined,
      situation: { text: p.problem || p.title, services: p.services ?? [] },
      steps: p.steps.map(s => ({ did: `${s.tool} ${JSON.stringify(s.args)}${s.why ? ` (${s.why})` : ''}`, result: s.status })),
    } });
    cased.set(p.id, c.ref);
    const o = OUTCOME[p.status];
    if (o) await call(`/api/cases/${c.ref}/outcome`, { method: 'POST', body: { outcome: o[0], source: 'scorecard', why: `HAL's plan ${p.id} "${p.title}": ${o[1]}.` } });
    else await call(`/api/cases/${c.ref}/close`, { method: 'POST', body: {} });
    console.log(`Know-how: plan ${p.id} on ${p.runbook} recorded as ${c.ref}${o ? ` (${o[0]})` : ''}`);
  } catch (err) { console.error(`Know-how case for ${p.id}: ${err.message}`); }
}

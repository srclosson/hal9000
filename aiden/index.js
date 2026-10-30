// Aiden for SRE (StackGen's AI SRE), as the 9000's deep investigator. The 9000 answers in seconds; Aiden takes
// minutes, with several agents and its own verification. When an alert fires the 9000 tells the quick story and, in
// parallel, starts an Aiden investigation of the same alert; a panel on the board follows it, and its result is
// spoken, put in the chat, added to the incident for that alert (if one is open) and remembered.
//
// Aiden is an MCP server configured in settings (any name). It is found by its tools, which must be set as
// "internal" there (the 9000's own code calls them; the model never sees them):
//   sre__sre_list_alerts         match the 9000's alert (a Grafana rule) to Aiden's copy of it
//   sre__sre_sync_alerts         ask Aiden to pull alerts now, when it hasn't seen the new one yet
//   sre__sre_start_investigation start one (Aiden returns the one in flight if there is one)
//   sre__sre_get_investigation   follow it
// The workspace is the setting aiden.workspace.
//
//   aiden_investigate { alert_uid }   the model starts one on request ("ask Aiden to look into this")

import * as mcp from '../mcp/index.js';
import * as config from '../config/index.js';

const T = { list: 'sre__sre_list_alerts', sync: 'sre__sre_sync_alerts', start: 'sre__sre_start_investigation', get: 'sre__sre_get_investigation' };
const POLL_MS = 20_000, MATCH_FOR_MS = 5 * 60_000, GIVE_UP_MS = 45 * 60_000;

export const available = () => [T.list, T.start, T.get].every(mcp.hasInternal) && !!config.get('aiden.workspace');

async function aiden(tool, args = {}) {
  const text = await mcp.call(tool, { stackgen_workspace_id: config.get('aiden.workspace'), ...args }, { internal: true });
  try { return JSON.parse(text); } catch { throw new Error(text.replace(/^Error[^:]*: /, '').slice(0, 200)); }
}

// ---- matching the 9000's alert to Aiden's ------------------------------------------------------------------
// Aiden's alerts don't carry the Grafana rule uid, so match on the title (and service / namespace when both have them).
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
let inventory = { at: 0, list: [] };
async function aidenAlerts(fresh) {
  if (!fresh && Date.now() - inventory.at < 60_000) return inventory.list;
  const list = [];
  for (let page = 1; page <= 4; page++) {
    const r = await aiden(T.list, { page, page_size: 100 });
    list.push(...(r.alerts ?? []));
    if (list.length >= (r.pagination?.total ?? 0) || !(r.alerts ?? []).length) break;
  }
  inventory = { at: Date.now(), list };
  return list;
}
// Aiden titles read "<rule title> : <summary>".
const head = t => norm(String(t ?? '').split(' : ')[0]);
function match(rule, list) {
  const title = norm(rule.title), l = rule.labels ?? {};
  const same = list.filter(a => head(a.title) === title);
  const scored = same.map(a => ({ a, s: (l.service && a.labels?.service === l.service ? 2 : 0) + (l.namespace && a.labels?.namespace === l.namespace ? 1 : 0) +
    (a.status === 'firing' || a.status === 'active' ? 1 : 0) }));
  return scored.sort((x, y) => y.s - x.s || Date.parse(y.a.triggered_at ?? 0) - Date.parse(x.a.triggered_at ?? 0))[0]?.a ?? null;
}

// ---- investigations, one per alert rule ---------------------------------------------------------------------
// uid -> { uid, title, cluster, service, status: matching | unmatched | queued | running | completed | failed | error,
//          alertId, id, summary, url, startedAt, finishedAt, error }
const runs = new Map();
const listeners = new Set();
export const onUpdate = fn => listeners.add(fn);
const emit = run => { for (const fn of listeners) try { fn(run); } catch (err) { console.error('Aiden listener:', err.message); } };
export const get = uid => runs.get(uid) ?? null;
export const active = () => [...runs.values()];

// "draft" is a finished result awaiting review, but only once it carries a summary.
const TERMINAL = new Set(['completed', 'failed', 'unmatched', 'error', 'cancelled']);
const done = run => TERMINAL.has(run.status) || (run.status === 'draft' && !!run.summary);
const absolute = u => (u && u.startsWith('/') ? `${(process.env.AIDEN_URL || 'https://stage.dev.stackgen.com').replace(/\/$/, '')}${u}` : u ?? null);

// Start (or join) an Aiden investigation of a Grafana alert rule { uid, title, labels }. Returns its run.
export function investigate(rule, { operator } = {}) {
  if (!available() || !rule?.uid) return null;
  const have = runs.get(rule.uid);
  if (have && !done(have)) return have;
  if (finished(have) && Date.now() - have.finishedAt < 30 * 60_000) return have;   // a fresh answer stands
  const run = { uid: rule.uid, title: rule.title ?? 'alert', cluster: rule.labels?.cluster ?? null, service: rule.labels?.service ?? null,
    status: 'matching', startedAt: Date.now() };
  runs.set(rule.uid, run);
  emit(run);
  drive(run, rule, operator).catch(err => { Object.assign(run, { status: 'error', error: err.message, finishedAt: Date.now() }); emit(run); });
  return run;
}

async function drive(run, rule, operator) {
  // Find Aiden's copy of the alert; a just-fired one may not be ingested yet, so ask it to sync and keep looking.
  let alert = match(rule, await aidenAlerts(true));
  for (let tries = 0; !alert && Date.now() - run.startedAt < MATCH_FOR_MS; tries++) {
    if (tries === 0) await aiden(T.sync, { source: 'grafana' }).catch(() => null);
    await new Promise(r => setTimeout(r, POLL_MS));
    alert = match(rule, await aidenAlerts(true));
  }
  if (!alert) { Object.assign(run, { status: 'unmatched', finishedAt: Date.now() }); return emit(run); }
  run.alertId = alert.id;
  const started = await aiden(T.start, { alert_id: alert.id, ...(operator && { operator_message: operator.slice(0, 500) }) });
  const inv = started.investigation ?? started;
  Object.assign(run, { id: inv.id, status: inv.status || 'queued', url: absolute(inv.chat_url) });
  emit(run);
  while (!done(run) && Date.now() - run.startedAt < GIVE_UP_MS) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const r = await aiden(T.get, { id: run.id }).catch(() => null);
    if (!r) continue;
    const before = run.status;
    Object.assign(run, { status: r.status || run.status, summary: r.result_summary || run.summary, url: absolute(r.chat_url) || run.url, evidence: r.evidence_count ?? run.evidence });
    if (done(run)) run.finishedAt = Date.parse(r.finished_at ?? '') || Date.now();
    if (run.status !== before || done(run)) emit(run);
  }
  if (!done(run)) { Object.assign(run, { status: 'error', error: 'still running after 45 minutes', finishedAt: Date.now() }); emit(run); }
}

// "completed" and "draft" (Aiden's word for a finished result awaiting review) both carry a summary.
export const finished = run => ['completed', 'draft'].includes(run?.status) && !!run.summary;

export const elapsed = run => Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000);

// For the model and the panels: one run in words.
export function describeRun(run) {
  if (!run) return 'No Aiden investigation for that alert.';
  const mins = Math.max(1, Math.round(elapsed(run) / 60));
  if (finished(run)) return `Aiden's investigation of "${run.title}" finished after ${mins} min: ${run.summary}`;
  if (run.status === 'unmatched') return `Aiden has no record of the alert "${run.title}", so it could not investigate it.`;
  if (run.status === 'error' || run.status === 'failed') return `Aiden's investigation of "${run.title}" did not complete${run.error ? ` (${run.error})` : ''}.`;
  return `Aiden is investigating "${run.title}" (${run.status}, ${mins} min so far).`;
}

// ---- tool for the model --------------------------------------------------------------------------------------

export function tools() {
  if (!available()) return [];
  return [{ name: 'aiden_investigate',
    description: 'Ask Aiden (StackGen\'s AI SRE) for a deep investigation of an alert: several agents, verified, takes several minutes. Its progress shows on the board and you will be told the result. Started automatically when an alert fires; use this when the person asks for Aiden, or for a deeper look at an alert that is quiet. Also reports the state of one already running.',
    inputSchema: { type: 'object', properties: { alert_uid: { type: 'string', description: 'The alert rule uid, from list_alerts' },
      note: { type: 'string', description: 'Optional: what to focus on, passed to Aiden' } }, required: ['alert_uid'] } }];
}
export const has = name => name === 'aiden_investigate';
export const describe = () => 'Asking Aiden to investigate';

// Set by the server (to avoid import cycles): the alerts module's rule lookup, and how to put the AID panel on a ship.
let ruleByUid = async () => null, attach = () => {};
export const configure = hooks => { ruleByUid = hooks.rule ?? ruleByUid; attach = hooks.attach ?? attach; };

// ctx: { room } (the asking ship's board hooks).
export async function call(name, args = {}, ctx = {}) {
  try {
    const have = runs.get(args.alert_uid);
    if (have && !done(have)) return describeRun(have);
    const rule = await ruleByUid(args.alert_uid);
    if (!rule) return `No alert rule with uid ${args.alert_uid}. Find it with list_alerts.`;
    const run = investigate(rule, { operator: args.note });
    if (run && ctx.room) attach(ctx.room, rule.uid);
    return run ? `${describeRun(run)} Progress shows on the board (panel AID); you will hear the result.` : 'Aiden is not connected.';
  } catch (err) {
    return `Error: Aiden is unavailable right now (${err.message}).`;
  }
}

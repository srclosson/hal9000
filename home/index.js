// The situation board: the monitors' home screen. Instead of a fixed set of systems, the six panels show what is
// most worth attention across the estate right now.
//
//   Survey (every SURVEY_MS, no LLM): a few estate-wide queries, one series per cluster, now and 30 minutes ago.
//   Score: how close each cluster's signals are to their thresholds, whether they are rising, pending/firing alerts.
//   Curate (every CURATE_MS, one LLM call): the 9000 picks six panels from the top candidates, in order, and writes
//     a one-line insight for each, plus its most likely fix and what that fix takes (effort): automatic (a tool a
//     plan can run does it, one approval), quick (a known small change), project (real engineering) or unknown
//     (nothing to go on yet: investigate). The fix rests on what was found for that cluster first: memory (what fixed
//     it before), Aiden's runbooks, and the tools a plan may use; otherwise on the signals. Without an LLM (or if it
//     fails), the scores alone decide and there is no fix line.
//
// Each panel is one cluster, coded by cluster (RET, GAM, HLT...), showing its most notable signal; the board itself
// is an ordinary live board (boards/index.js) so it refreshes, colours and tours like any other.

import * as mcp from '../mcp/index.js';
import * as alerts from '../alerts/index.js';
import { current as currentModel, background } from '../llm/index.js';
import * as snooze from '../snooze/index.js';
import * as config from '../config/index.js';
import * as memory from '../memory/index.js';

const DATASOURCE = process.env.BOARD_DATASOURCE || 'metrics';
// Live settings (config/index.js): survey interval, re-ranking interval, and how many panels at most.
const SURVEY_MS = () => config.get('board.surveySeconds') * 1000;
const CURATE_MS = () => config.get('board.curateMinutes') * 60_000;
const SLOTS = () => config.get('board.maxPanels');

// Signals surveyed per cluster. Thresholds match the curated cluster-health board.
export const SIGNALS = [
  { key: 'ERR', name: 'error rate', unit: '%', warn: 1, crit: 5, kind: 'timeseries',
    all: '100 * max by (cluster) (http_error_ratio)', one: c => `100 * max(http_error_ratio{cluster="${c}"})`,
    // What is behind it, for finding the fix: the worst few services, pods or nodes, with their values.
    detail: c => `topk(3, 100 * max by (k8s_deployment_name) (http_error_ratio{cluster="${c}"}))`, label: 'k8s_deployment_name', unitOf: v => `${+v.toFixed(2)}%` },
  { key: 'LAT', name: 'worst latency', unit: 'ms', warn: 500, crit: 1000, kind: 'timeseries',
    all: 'max by (cluster) (http_request_duration_ms_milliseconds)', one: c => `max(http_request_duration_ms_milliseconds{cluster="${c}"})`,
    detail: c => `topk(3, max by (k8s_deployment_name) (http_request_duration_ms_milliseconds{cluster="${c}"}))`, label: 'k8s_deployment_name', unitOf: v => `${Math.round(v)} ms` },
  { key: 'CLB', name: 'crash-looping pods', unit: 'pods', warn: 1, crit: 3, kind: 'stat', noTrend: true,
    all: 'count by (cluster) (kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"} == 1)',
    one: c => `count(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",cluster="${c}"} == 1) or vector(0)`,
    detail: c => `topk(5, sum by (namespace, container) (increase(kube_pod_container_status_restarts_total{cluster="${c}"}[1h])) and on (namespace, container) (max by (namespace, container) (kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",cluster="${c}"}) == 1))`,
    label: ['namespace', 'container'], unitOf: v => `${Math.round(v)} restarts/h` },
  { key: 'RST', name: 'restarts in the last hour', unit: 'restarts', warn: 1, crit: 10, kind: 'stat', noTrend: true,
    all: 'sum by (cluster) (increase(kube_pod_container_status_restarts_total[1h]))',
    one: c => `sum(increase(kube_pod_container_status_restarts_total{cluster="${c}"}[1h])) or vector(0)`,
    detail: c => `topk(3, sum by (namespace, container) (increase(kube_pod_container_status_restarts_total{cluster="${c}"}[1h])))`, label: ['namespace', 'container'], unitOf: v => `${Math.round(v)} restarts/h` },
  { key: 'NOD', name: 'nodes not ready', unit: 'nodes', warn: 1, crit: 2, kind: 'stat', noTrend: true,
    all: 'count by (cluster) (kube_node_info) - count by (cluster) (kube_node_status_condition{condition="Ready",status="true"} == 1)',
    one: c => `(count(kube_node_info{cluster="${c}"}) - count(kube_node_status_condition{condition="Ready",status="true",cluster="${c}"} == 1)) or vector(0)`,
    detail: c => `topk(5, kube_node_status_condition{condition="Ready",status!="true",cluster="${c}"} == 1)`, label: ['node', 'status'], unitOf: () => 'not ready' },
];

// Three-letter codes for the panels: one per cluster.
const KNOWN = { retail: 'RET', gaming: 'GAM', fintech: 'FIN', iot: 'IOT', saas: 'SAS', streaming: 'STR', travel: 'TRV',
  ht: 'HLT', healthtech: 'HLT', pp: 'PPT', kubernetes: 'K8S' };
const SPOKEN = { ht: 'healthtech', pp: 'patientpoint' };
const baseName = c => c.replace(/-prod(-cluster|-us-east-\d)?$|-cluster$/, '');
const shortName = c => SPOKEN[baseName(c)] ?? baseName(c);
function codeFor(cluster, taken) {
  const base = baseName(cluster);
  let code = KNOWN[base] ?? base.replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase().padEnd(3, 'X');
  for (let i = 2; taken.has(code); i++) code = code.slice(0, 2) + i;   // RET, RE2... if two clusters collide
  taken.add(code);
  return code;
}

// at: 'now', or an earlier moment such as 'now-30m' or 'now-1d' (the same query, evaluated then).
async function byCluster(expr, at = 'now') {
  const text = await mcp.call('query_prometheus', { datasourceUid: DATASOURCE, expr, queryType: 'instant', endTime: at }, { internal: true });
  try {
    const out = new Map();
    for (const s of JSON.parse(text).data ?? []) if (s.metric?.cluster) out.set(s.metric.cluster, parseFloat(s.value?.[1]));
    return out;
  } catch { return new Map(); }
}

// ---- survey and score ---------------------------------------------------------------------------------------

export async function survey() {
  const [now, before, yesterday, rules] = await Promise.all([
    Promise.all(SIGNALS.map(s => byCluster(s.all))),
    Promise.all(SIGNALS.map(s => (s.noTrend ? Promise.resolve(new Map()) : byCluster(s.all, 'now-30m')))),
    Promise.all(SIGNALS.map(s => byCluster(s.all, 'now-1d'))),   // the baseline: the same time yesterday
    alerts.available() ? alerts.allRules() : null,
  ]);
  const clusters = new Set(now.flatMap(m => [...m.keys()]));
  const alerting = new Map();   // cluster -> { firing, pending }
  for (const r of rules ?? []) {
    const c = r.labels?.cluster;
    if (!c || !['firing', 'pending'].includes(r.state)) continue;
    const a = alerting.get(c) ?? { firing: 0, pending: 0 };
    a[r.state]++;
    alerting.set(c, a);
  }

  return [...clusters].map(cluster => {
    const signals = SIGNALS.map((s, i) => {
      const v = now[i].get(cluster), was = before[i].get(cluster), yd = yesterday[i].get(cluster);
      if (!Number.isFinite(v)) return null;
      const lvl = x => (x >= s.crit ? 2 : x >= s.warn ? 1 : 0);
      const level = lvl(v);
      const change = Number.isFinite(was) && was > 0 ? (v - was) / was : 0;
      // Against normal: chronic = just as bad this time yesterday; new = fine yesterday; worsening = rising now.
      const baseline = !level ? 'normal'
        : change >= .25 ? 'worsening'
        : Number.isFinite(yd) && lvl(yd) >= level && Math.abs(v - yd) <= Math.max(yd * .25, s.warn * .25) ? 'chronic'
        : !Number.isFinite(yd) || lvl(yd) === 0 ? 'new' : 'steady';
      // Concern: threshold level dominates, then closeness to the warning line, then a rising trend; adjusted for
      // whether it is new (more urgent) or chronic (known, and less urgent than anything new).
      let score = level * 10 + Math.min(v / s.warn, 3) + Math.max(0, Math.min(change, 2)) * 3;
      score = baseline === 'chronic' ? score * .5 : baseline === 'new' ? score + 8 : baseline === 'worsening' ? score + 4 : score;
      return { ...s, value: v, was, yesterday: yd, change, level, baseline, score };
    }).filter(Boolean);
    const a = alerting.get(cluster) ?? { firing: 0, pending: 0 };
    const top = signals.sort((x, y) => y.score - x.score)[0];
    const score = (top?.score ?? 0) + a.firing * 25 + a.pending * 8 + signals.filter(s => s.level).length * 2;
    return { cluster, signals, top, alerts: a, score };
  }).filter(c => c.top).sort((x, y) => y.score - x.score);
}

const PHRASE = {
  ERR: v => `errors at ${v < 10 ? v.toFixed(2) : v.toFixed(1)}%`,
  LAT: v => `worst latency ${Math.round(v)} ms`,
  CLB: v => `${Math.round(v)} pod${Math.round(v) === 1 ? '' : 's'} crash-looping`,
  RST: v => `${Math.round(v)} restart${Math.round(v) === 1 ? '' : 's'} in the last hour`,
  NOD: v => `${Math.round(v)} node${Math.round(v) === 1 ? '' : 's'} not ready`,
};
function describeSignal(s) {
  const trend = !s.noTrend && Math.abs(s.change) >= 0.15 ? `, ${s.change > 0 ? 'up' : 'down'} ${Math.round(Math.abs(s.change) * 100)}% in 30 min` : '';
  const base = { chronic: '; chronic, the same yesterday', new: '; new since yesterday', worsening: '; worsening' }[s.baseline] ?? '';
  return PHRASE[s.key](s.value) + trend + base;
}

// ---- curation -------------------------------------------------------------------------------------------------

function fallbackInsight(c) {
  const parts = [describeSignal(c.top)];
  if (c.alerts.firing) parts.push(`${c.alerts.firing} alert${c.alerts.firing > 1 ? 's' : ''} firing`);
  else if (c.alerts.pending) parts.push(`${c.alerts.pending} alert${c.alerts.pending > 1 ? 's' : ''} pending`);
  const text = parts.join('; ');
  return text[0].toUpperCase() + text.slice(1);
}

// What a fix could rest on, per cluster: memory of past fixes and Aiden's runbooks, each within a few seconds.
const within = (ms, p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);
const EFFORTS = ['auto', 'quick', 'project', 'unknown'];
// The worst few things behind a cluster's live signals: "kube-system/hubble-relay 17 restarts/h".
async function behind(c) {
  const live = c.signals.filter(s => s.level >= 1).slice(0, 2);
  const parts = await Promise.all(live.map(async sig => {
    const def = SIGNALS.find(x => x.key === sig.key);
    if (!def?.detail) return null;
    const text = await within(4000, mcp.call('query_prometheus', { datasourceUid: DATASOURCE, expr: def.detail(c.cluster), queryType: 'instant', endTime: 'now' }, { internal: true }));
    try {
      const rows = (JSON.parse(text ?? '{}').data ?? []).map(r => `${[def.label].flat().map(l => r.metric?.[l]).filter(Boolean).join('/')} ${def.unitOf(parseFloat(r.value?.[1]))}`);
      return rows.length ? `${def.name}: ${rows.join(', ')}` : null;
    } catch { return null; }
  }));
  return parts.filter(Boolean).join('; ');
}
async function fixEvidence(c) {
  const detail = await behind(c);
  const what = `${c.cluster}: ${detail || c.signals.filter(s => s.level >= 1).map(describeSignal).join('; ') || `${c.alerts.firing} alerts firing`}`;
  const runbooks = mcp.resolve('aiden__search_runbooks');
  const [mem, rb] = await Promise.all([
    memory.available() ? within(8000, memory.find(`cause and fix: ${what}`, 3, .5)) : null,
    runbooks && config.get('aiden.workspace') ? within(4000, mcp.call(runbooks, { query: what, limit: 2, stackgen_workspace_id: config.get('aiden.workspace') }, { internal: true })) : null,
  ]);
  let books = [];
  try { books = (JSON.parse(rb ?? '{}').runbooks ?? []).filter(b => (b.confidence ?? 1) >= .5).map(b => `${b.name}: ${String(b.description ?? '').slice(0, 120)}`); } catch {}
  return [detail ? `behind it: ${detail}` : '', mem ? `memory:\n${mem.slice(0, 700)}` : '', books.length ? `runbooks: ${books.join(' | ')}` : ''].filter(Boolean).join('\n');
}

// One LLM call: pick and order six clusters from the candidates and write an insight for each. Returns
// [{ cluster, signal, insight }] or null.
async function curate(candidates) {
  const llm = currentModel();   // the provider the settings choose, shared with conversations
  if (!llm) return null;
  const top = candidates.slice(0, 12);
  const evidence = await Promise.all(top.map((c, i) => (i < SLOTS() + 2 ? fixEvidence(c).catch(() => '') : '')));
  if (process.env.DEBUG_FIXES) top.forEach((c, i) => evidence[i] && console.log(`FIX EVIDENCE ${c.cluster}:\n${evidence[i]}`));
  const lines = top.map((c, i) =>
    `${c.cluster}: ${c.signals.map(describeSignal).join('; ')}; alerts firing ${c.alerts.firing}, pending ${c.alerts.pending}` +
    (evidence[i] ? `\n  known for this cluster — ${evidence[i].replace(/\n/g, '\n  ')}` : ''));
  const planTools = mcp.approvalTools().map(t => `${t.name} (${t.server}): ${t.description.replace(/\s+/g, ' ').slice(0, 100)}`);
  const system = 'You choose what an SRE wall display should show. Reply with JSON only, no prose.';
  const ask = `Candidate clusters with their current signals:\n${lines.join('\n')}\n\n` +
    `Every cluster listed has a real problem. Order up to ${SLOTS()} of them by how much attention they deserve, most important first; ` +
    `never add a cluster that is not listed. For each, pick the one signal ` +
    `(ERR, LAT, CLB, RST or NOD) that best shows why, and write an insight of at most 12 words, e.g. "13 of 16 nodes not ready; latency up 67%". ` +
    `Prefer new or worsening problems over chronic ones (the same yesterday); keep a chronic one if nothing newer is worse, and say it is chronic. ` +
    `For each, also give its most likely fix, as an action of at most 10 words ("renew the hubble-relay peer certificate"), and its effort: ` +
    `"auto" only if one of these plan tools can carry it out with one approval: ${planTools.length ? planTools.join('; ') : '(none are available, so never auto)'}; ` +
    `"quick" for a known small change a person can make in minutes; "project" when it needs real engineering or many steps; ` +
    `Always give the single most likely fix, even when it is not yet confirmed: a well-grounded hypothesis is what the person wants ` +
    `(memory says hubble-relay's peer certificate expired → "renew hubble-relay's peer TLS certificate", quick). ` +
    `Use "unknown" only when nothing above points to any cause, and then the fix is the one most telling check ("check kubelet status on the 16 not-ready nodes"). ` +
    `Base the fix on what is known for that cluster (memory, runbooks, what is behind it) when it fits, else on the signals; name the service, pod or node; never invent a cause the evidence does not suggest. ` +
    `basis says which: "memory", "runbook", "signals" or "none". ` +
    `JSON: [{"cluster": "...", "signal": "ERR", "insight": "...", "fix": "...", "effort": "quick", "basis": "memory"}]`;
  const t0 = Date.now();
  try {
    // In full: it now decides likely fixes, not only the order (one call every few minutes).
    const r = await background(() => llm.send(system, [{ role: 'user', content: ask }], []));
    const json = r?.reply?.match(/\[[\s\S]*\]/)?.[0];
    const picks = JSON.parse(json ?? 'null');
    if (!Array.isArray(picks)) {
      console.warn(`Situation board: curation gave no list after ${Date.now() - t0} ms (${String(r?.reply ?? 'no reply').slice(0, 120)}); using scores`);
      return null;
    }
    const auto = mcp.approvalTools().length > 0;
    const valid = picks.filter(p => candidates.some(c => c.cluster === p.cluster) && SIGNALS.some(s => s.key === p.signal)).slice(0, SLOTS())
      .map(p => ({ ...p, effort: EFFORTS.includes(p.effort) ? (p.effort === 'auto' && !auto ? 'quick' : p.effort) : 'unknown' }));
    console.log(`Situation board: curated ${valid.length} panels in ${Math.round((Date.now() - t0) / 1000)} s`);
    return valid.length ? valid : null;
  } catch (err) {
    console.warn('Situation board: curation failed, using scores:', err.message);
    return null;
  }
}

// ---- the board ------------------------------------------------------------------------------------------------

let spec = null, lastCurated = 0, picks = null, onChange = () => {};
// The last survey, for alert coverage checks: [{ cluster, signals: [{ key, value, level, baseline }] }].
let latestSurvey = [];
export const latest = () => latestSurvey;
export const current = () => spec;

// What earns a place on the board: a signal at warning or worse, or alerts firing or pending, that nobody has
// snoozed (a snooze lifts early if the problem gets worse). Calm clusters never fill space.
function worth(c) {
  const live = c.signals.filter(s => s.level >= 1 && !snooze.isSnoozed(c.cluster, s.key, s.level)).sort((a, b) => b.score - a.score);
  const alertLevel = c.alerts.firing ? 2 : c.alerts.pending ? 1 : 0;
  const alerting = alertLevel > 0 && !snooze.isSnoozed(c.cluster, 'ALR', alertLevel);
  if (!live.length && !alerting) return null;
  // Shown by its worst live signal; a cluster that is here only for its alerts is snoozed as its alerts.
  return live.length ? { c, top: live[0], live, snoozeKey: live[0].key, level: live[0].level }
    : { c, top: c.top, live: [], snoozeKey: 'ALR', level: alertLevel };
}

function build(candidates) {
  const items = candidates.map(worth).filter(Boolean);
  if (!items.length) {
    const hidden = snooze.active().length;
    return { title: 'Situation', home: true, window: 60, panels: [{
      code: 'ALL', title: 'Situation · all clear', kind: 'note', status: 'ok',
      text: hidden ? `Nothing new needs attention. ${hidden} known issue${hidden > 1 ? 's' : ''} snoozed; ${candidates.length} clusters watched.`
        : `Nothing needs attention. All ${candidates.length} clusters are within normal ranges.`,
    }] };
  }
  // The curated order first (only for clusters still worth showing, with a signal that isn't snoozed), then by score.
  const chosen = [];
  for (const p of picks ?? []) {
    const it = items.find(i => i.c.cluster === p.cluster);
    if (it && !chosen.includes(it)) chosen.push({ ...it, p: it.live.some(s => s.key === p.signal) ? p : { ...p, signal: it.top.key } });
  }
  for (const it of items) if (!chosen.some(x => x.c === it.c)) chosen.push({ ...it, p: null });
  const taken = new Set();
  const panels = chosen.slice(0, SLOTS()).map(({ c, p, top, snoozeKey, level }) => {
    const s = SIGNALS.find(x => x.key === p?.signal) ?? top;
    const sig = c.signals.find(x => x.key === s.key) ?? top;
    const key = snoozeKey === 'ALR' ? 'ALR' : s.key;
    return {
      code: codeFor(c.cluster, taken),
      title: `${shortName(c.cluster)} · ${s.name}`,
      kind: s.kind, unit: s.unit, warn: s.warn, crit: s.crit,
      query: s.one(c.cluster),
      insight: (p?.insight || fallbackInsight({ ...c, top: sig })).slice(0, 90),
      // The most likely fix and what it takes, from curation (none on a score-only board).
      ...(p?.fix && { fix: { text: String(p.fix).slice(0, 80), effort: p.effort, basis: ['memory', 'runbook', 'signals'].includes(p.basis) ? p.basis : 'none' } }),
      baseline: sig?.baseline,   // new / worsening / chronic, shown as a tag
      cluster: c.cluster,
      // What "snooze" on this panel hides: this cluster's signal (or its alerts), at today's level.
      snooze: { key: snooze.keyOf(c.cluster, key), level: key === 'ALR' ? level : sig.level, value: sig.value,
        label: key === 'ALR' ? `${shortName(c.cluster)} alerts` : `${shortName(c.cluster)} ${s.name}` },
    };
  });
  return { title: 'Situation', home: true, window: 60, panels };
}

let running = false, again = false;
async function cycle(force = false) {
  if (running) { again ||= force; return; }   // still busy: a forced recompose runs once this one finishes
  running = true;
  try { await compose(force); } finally {
    running = false;
    if (again) { again = false; cycle(true); }
  }
}

async function compose(force) {
  const candidates = await survey();
  latestSurvey = candidates;
  if (alerts.available()) alerts.ruleDetails().catch(() => {});   // keep the coverage check's rule cache warm
  if (!candidates.length) return;
  if (!spec) { spec = build(candidates); onChange(spec); }   // show the score-only board now; curation takes a while
  if (force || !picks || Date.now() - lastCurated > CURATE_MS()) {
    const worthy = candidates.filter(c => worth(c));
    picks = worthy.length ? (await curate(worthy.map(c => ({ ...c, signals: c.signals.filter(x => !snooze.isSnoozed(c.cluster, x.key, x.level)) })))) ?? null : null;
    lastCurated = Date.now();
  }
  const next = build(candidates);
  const changed = JSON.stringify(next.panels.map(p => [p.code, p.query, p.insight, p.fix])) !== JSON.stringify(spec?.panels.map(p => [p.code, p.query, p.insight, p.fix]));
  spec = next;
  if (changed) onChange(spec);
}

// start({ onChange(spec) }): survey now and every minute; onChange fires whenever the composition changes.
export function start(handlers) {
  if (!mcp.names().includes('query_prometheus')) return false;
  onChange = handlers.onChange ?? onChange;
  const run = force => cycle(force).catch(err => console.error('Situation board:', err.message));
  run(true);
  const next = () => setTimeout(() => { run(false); next(); }, SURVEY_MS()).unref?.();   // re-read the interval each time
  next();
  config.onChange(() => recompose());   // board size or other settings changed: recompose now
  console.log('Situation board: surveying every 60 s, curated every 5 min');
  return true;
}

// Something changed (an alert fired or resolved): recompose now, with fresh curation.
export const recompose = () => cycle(true).catch(err => console.error('Situation board:', err.message));

// For the model: what is on the home screen and why.
export function summary() {
  if (!spec) return 'The situation board has not been composed yet.';
  const body = spec.panels[0]?.code === 'ALL' && spec.panels.length === 1 ? spec.panels[0].text
    : `The situation board (the monitors' home screen) shows only clusters with a real, unsnoozed problem, most important first:\n` +
      spec.panels.map((p, i) => `${i + 1}. ${p.code} ${p.title}: ${p.insight}${p.fix ? ` — likely fix (${p.fix.effort}${p.fix.basis !== 'none' ? `, from ${p.fix.basis}` : ''}): ${p.fix.text}` : ''}${p.baseline && p.baseline !== 'normal' ? ` [${p.baseline}${p.baseline === 'chronic' ? ': as bad at this time yesterday' : p.baseline === 'new' ? ': fine at this time yesterday' : ''}]` : ''}`).join('\n');
  return `${body}\n${snooze.describe()}`;
}

// ---- tool for the model ----------------------------------------------------------------------------------------
export function tools() {
  if (!spec) return [];
  return [{ name: 'get_situation',
    description: 'What the situation board (the monitors\' home screen) is showing right now and why each cluster is on it. Use when asked about the main screen or what needs attention across the estate.',
    inputSchema: { type: 'object', properties: {} } }];
}
export const has = name => name === 'get_situation';
export const describe = () => 'Reviewing the situation board';
export const call = async () => summary();

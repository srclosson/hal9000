// The confidence forecast: before the 9000 digs into a problem on its situation board, how confused it is likely to be,
// and why. A confusion score (telemetry/index.js) is no surprise: it comes from signs that repeat. The same problem dug
// with the same broken tool scores the same each time (on 3 November 2026 a dig into the kubernetes crash loops scored
// 0.76 twice, half an hour apart, from the same 11 failed Kubernetes calls).
//
// From each dig it keeps (record):
//   the problem's past digs    their confusion, signs and tool calls (the last 10 per problem)
//   tool health                each tool's recent calls on that cluster, and how many failed (the last 40 per tool)
// and before the next one it forecasts (forecast):
//   blind spots    tools on this cluster that keep failing (most of at least 4 calls in the last 6 h): the dig is told
//                  not to rely on them, and the card names them, as a to-do for a person (give the tool access there)
//   confusion      the last dig's signs again, with each tool's errors re-estimated from its current health and the blind
//                  spots left out, blended with the problem's past scores; 0 clear to 1 lost
// After the dig the forecast is scored against what happened (the scorecard's "forecast" cases).
// Past digs count only for the model that made them (identity/): a new model starts its own record, borrowing the last
// one's only for which tools it will reach for, and while it is on probation the forecast is less sure of it.
//
// Kept in StackGen Incidents (scope "hal9000-confidence") so a restart doesn't forget, as capabilities/ does.

import * as config from '../config/index.js';
import { confusionOf } from '../telemetry/index.js';
import * as identity from '../identity/index.js';

const SCOPE = 'hal9000-confidence', DIGS = 10, CALLS = 40, KEYS = 60;
const RECENT_MS = 6 * 3600_000, OLD_MS = 24 * 3600_000;
export const ALERT = 0.75;   // the "HAL 9000: lost" alert's threshold on ai_confusion_score
const IN_CLUSTER = !!process.env.KUBERNETES_SERVICE_HOST;

let state = { digs: {}, health: {} }, loaded = null;
const load = () => (loaded ??= (IN_CLUSTER ? config.loadDoc(SCOPE).catch(() => null) : Promise.resolve(null))
  .then(doc => { if (doc?.digs) state = { digs: doc.digs, health: doc.health ?? {} }; }));
let saving = null;
function save() {
  if (!IN_CLUSTER || saving) return;
  saving = setTimeout(() => { saving = null; config.saveDoc(SCOPE, state).catch(err => console.error(`Confidence: ${err.message}`)); }, 5000);
  saving.unref?.();
}
export const reset = () => { state = { digs: {}, health: {} }; loaded = Promise.resolve(); };   // tests

const where = (tool, cluster) => `${tool}@${cluster}`;
// A tool's failure rate on a cluster: its calls in the last 6 h, or the last 24 h when it has none since.
function health(tool, cluster, now) {
  const calls = state.health[where(tool, cluster)] ?? [];
  const recent = calls.filter(c => now - c.at <= RECENT_MS), use = recent.length ? recent : calls.filter(c => now - c.at <= OLD_MS);
  const failed = use.filter(c => !c.ok).length;
  return { calls: use.length, failed, rate: use.length ? failed / use.length : null, recent: !!recent.length };
}

// After a dig: turn is brain.js's telemetry record ({ tools: [{ name, ok }], signals, confusion }).
export async function record(key, cluster, turn, now = Date.now()) {
  if (!turn) return;
  await load();
  const tools = {};
  for (const t of turn.tools ?? []) {
    if (t.name === 'find_tools') continue;
    const c = (tools[t.name] ??= [0, 0]);
    c[0]++; if (!t.ok) c[1]++;
    const h = (state.health[where(t.name, cluster)] ??= []);
    h.push({ at: now, ok: !!t.ok });
    if (h.length > CALLS) h.splice(0, h.length - CALLS);
  }
  const list = (state.digs[key] ??= []);
  list.push({ at: now, model: turn.model ?? null, confusion: +(turn.confusion ?? 0).toFixed(3), signals: turn.signals ?? {}, tools });
  if (list.length > DIGS) list.splice(0, list.length - DIGS);
  // Keep the problems dug most recently.
  const keys = Object.keys(state.digs);
  if (keys.length > KEYS) for (const k of keys.sort((a, b) => state.digs[a].at(-1).at - state.digs[b].at(-1).at).slice(0, keys.length - KEYS)) delete state.digs[k];
  save();
}

// Before a dig: { confusion, confidence, alert, blindSpots: [{ tool, cluster, calls, failed }], reasons: [...], basis }
// or null when there's nothing to go on (never dug, and no tool on the cluster has a record).
export async function forecast(key, cluster, now = Date.now(), model = identity.now()?.model ?? null) {
  await load();
  // This model's digs (older records without a model count as its own); else another model's, for its tools only.
  const all = state.digs[key] ?? [], own = all.filter(d => !d.model || !model || d.model === model);
  const past = own.length ? own : all.slice(-1), borrowed = !own.length && past.length > 0;
  const p = identity.probation();
  const onProbation = p ? `new mind ${p.model} on probation: ${p.judged} of ${p.needed} digs judged` : null;
  // Blind spots: any tool on this cluster failing most of its recent calls, whether or not this problem used it.
  const blindSpots = spots(now).filter(b => b.cluster === cluster);
  const blind = new Set(blindSpots.map(b => b.tool));
  if (!past.length) {
    if (!blindSpots.length && !p) return null;
    return { confusion: null, confidence: null, alert: false, blindSpots, probation: p, basis: p ? 'new mind' : 'tool health',
      reasons: [...blindSpots.map(describeSpot), ...(onProbation ? [onProbation] : [])] };
  }
  const last = past.at(-1), reasons = [];
  // The last dig's signs, with tool errors re-estimated: blind spots are skipped (no errors), the rest fail at their
  // current rate. A skipped tool means a round or two more elsewhere, which the carried-over long_loop allows for.
  const { tool_error: _, ...signs } = last.signals;
  let errors = 0;
  for (const [tool, [calls, failed]] of Object.entries(last.tools)) {
    if (blind.has(tool)) continue;
    const h = health(tool, cluster, now);
    errors += calls * (h.rate ?? failed / calls);
    if (h.rate >= 0.5 && h.calls >= 2) reasons.push(`${tool} failed ${h.failed} of its last ${h.calls} calls here`);
  }
  if (errors >= 0.5) signs.tool_error = errors;
  const fromSigns = confusionOf(signs);
  // The problem's own record, latest first: each older dig counts half as much.
  let w = 0, sum = 0;
  past.slice().reverse().forEach((d, i) => { const k = 0.5 ** i; w += k; sum += k * d.confusion; });
  const history = sum / w;
  // Borrowed from another model: its signs say which tools will be used, not how this model copes. On probation, less sure.
  let confusion = borrowed ? fromSigns : 0.7 * fromSigns + 0.3 * history;
  if (p) confusion = Math.min(1, confusion + 0.1 * (1 - p.judged / p.needed));
  confusion = +confusion.toFixed(3);
  for (const s of ['long_loop', 'round_limit', 'empty_answer', 'repeated_call', 'find_miss', 'wrong_tool']) if (last.signals[s]) reasons.push(`last time: ${s.replace('_', ' ')} ×${last.signals[s]}`);
  if (past.length > 1 && !borrowed) reasons.push(`past ${past.length} digs averaged ${history.toFixed(2)}`);
  if (borrowed) reasons.push(`no digs here by ${model} yet; going by the tools ${past[0].model ?? 'the last model'} used`);
  if (onProbation) reasons.unshift(onProbation);
  return { confusion, confidence: +(1 - confusion).toFixed(3), alert: confusion >= ALERT, blindSpots, probation: p,
    basis: borrowed ? `another model's dig` : `${past.length} past dig${past.length > 1 ? 's' : ''}`,
    reasons: [...blindSpots.map(describeSpot), ...reasons].slice(0, 5) };
}
const describeSpot = b => `${b.tool} failed ${b.failed} of ${b.calls} calls on ${b.cluster} in the last 6 h`;

// For the dig question: what to avoid ('' when nothing).
export function brief(f) {
  if (!f?.blindSpots?.length) return '';
  return `Blind spots on this cluster (your own recent calls failed): ${f.blindSpots.map(b => `${b.tool} (${b.failed} of ${b.calls} failed)`).join(', ')}. ` +
    'Don\'t rely on them: get the same facts another way (logs from query_loki_logs, pod state from query_prometheus), and say in DETAIL what you could not see because of them.';
}

// Every blind spot the 9000 knows of, for the scorecard and the monitors: [{ tool, cluster, calls, failed }].
export async function blindSpots(now = Date.now()) {
  await load();
  return spots(now);
}
function spots(now) {
  return Object.keys(state.health).map(w => { const i = w.lastIndexOf('@'); return { tool: w.slice(0, i), cluster: w.slice(i + 1) }; })
    .map(x => ({ ...x, ...health(x.tool, x.cluster, now) })).filter(h => h.recent && h.calls >= 4 && h.rate >= 0.8)
    .map(({ tool, cluster, calls, failed }) => ({ tool, cluster, calls, failed }));
}

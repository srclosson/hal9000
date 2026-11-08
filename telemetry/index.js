// The 9000 observing itself: every conversation turn, model call and tool call is recorded.
// - In memory (last 500 turns): self_check answers "how are you performing?" from real numbers.
// - OpenTelemetry SDK spans for turns/model/tools; OTLP/HTTP JSON metrics and bounded, trace-correlated logs.
import { format } from 'node:util';
import { endpoint, headers, resourceAttributes, redact } from './settings.js';
import { context, trace, tracer, SpanStatusCode } from './spans.js';
import { runtimeMetrics } from './runtime.js';
import { shutdownTracing } from './bootstrap.js';

const RESOURCE = { attributes: Object.entries(resourceAttributes).map(([key, value]) => ({ key, value: { stringValue: value } })) };

const turns = [];   // { at, ms, outcome, calls, llmMs, tokensIn, tokensOut, tools: [{ name, ms, ok }], side }
const MAX = 500;

const nanos = ms => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (k, v) => ({ key: k, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });

// ---- confusion ----
// Signs that the mind is struggling within an answer, counted by brain.js as they happen. Each one weighs into the
// turn's confusion score, 0 (clear) to 1, combined as independent chances (1 - Π(1 - w)^n), so several small signs
// add up but never pass 1. Weights: how strongly each sign means the model was lost, not merely busy.
//   refusal          the model declined                                                        .5
//   fallback         the model failed: a scripted reply was given                              .6
//   no_conclusion    no answer even after a nudge                                              .6
//   round_limit      still asking for tools after the last round                               .4
//   empty_answer     an empty reply that needed a nudge                                        .3
//   wrong_tool       a call to a tool it does not have (an approval-only tool called directly:
//                    a directive conflict)                                                     .35
//   rejected_plan    a proposed fix that failed validation                                     .25
//   repeated_call    the same tool with the same arguments again in one answer                 .2
//   tool_error       a tool call that failed                                                   .1
//   find_miss        find_tools found nothing for what it wanted                               .1
//   long_loop        each model round beyond four                                              .08
//   uncertain        mean token entropy above 1 nat (providers that report token probabilities)    .3
export const WEIGHTS = { refusal: .5, fallback: .6, no_conclusion: .6, round_limit: .4, empty_answer: .3, wrong_tool: .35, rejected_plan: .25,
  repeated_call: .2, tool_error: .1, find_miss: .1, long_loop: .08, uncertain: .3 };
export const confusionOf = signals => 1 - Object.entries(signals).reduce((p, [k, n]) => p * (1 - (WEIGHTS[k] ?? .1)) ** n, 1);

// Running totals since start, for the exported counters and histograms (the last-500 record above is for self_check).
const DURATION_BOUNDS = [1000, 2500, 5000, 10000, 20000, 40000, 80000, 160000], CONFUSION_BOUNDS = [.1, .25, .5, .75, .9];
const hist = bounds => ({ bounds, buckets: new Array(bounds.length + 1).fill(0), count: 0, sum: 0,
  add(v) { this.count++; this.sum += v; const i = this.bounds.findIndex(b => v <= b); this.buckets[i < 0 ? this.bounds.length : i]++; } });
// Kept per model (identity/): a different model is a different mind, and its numbers mustn't blend with the last one's.
const byModel = new Map();
const totalsFor = model => {
  if (!byModel.has(model)) byModel.set(model, { turns: { answered: 0, failed: 0 }, calls: 0, tokensIn: 0, tokensOut: 0, tools: 0, toolErrors: 0, signals: {},
    durations: hist(DURATION_BOUNDS), modelDurations: hist(DURATION_BOUNDS), toolDurations: hist(DURATION_BOUNDS), confusion: hist(CONFUSION_BOUNDS) });
  return byModel.get(model);
};
const windowScores = new Map(); // bounded to one worst score per model, even with export disabled

// A turn in progress. brain.js calls model(), tool() and signal() as they happen, then end(outcome).
// model: the model answering (identity/), on every record, metric and span. persona (personas/) and medium (spoken or
// written) go on the record and the span only: per room, they would multiply the metrics' series for little gain.
export function startTurn(question, { side = false, model = 'unknown', persona = null, medium = null } = {}) {
  const span = tracer.startSpan('conversation.turn', { attributes: { 'gen_ai.request.model': model, 'hal9000.side_turn': side,
    ...(persona && { 'hal9000.persona': persona }), ...(medium && { 'hal9000.medium': medium }) } });
  const parent = trace.setSpan(context.active(), span);
  const t = { at: Date.now(), side, model, persona, medium, calls: [], tools: [], signals: {}, entropy: [] };
  let ended = false;
  return {
    run: fn => context.with(parent, fn),
    model(ms, usage = {}) { t.calls.push({ ms, in: usage.in ?? 0, out: usage.out ?? 0, end: Date.now() }); if (Number.isFinite(usage.entropy)) t.entropy.push(usage.entropy); },
    tool(name, ms, ok = true) { t.tools.push({ name, ms, ok, end: Date.now() }); },
    signal(name, n = 1) { if (n > 0) t.signals[name] = (t.signals[name] ?? 0) + n; },
    end(outcome) {
      if (ended) return; ended = true;
      const entropy = t.entropy.length ? t.entropy.reduce((a, b) => a + b, 0) / t.entropy.length : null;
      if (entropy !== null && entropy > 1.0) t.signals.uncertain = 1;
      if (t.calls.length > 4) t.signals.long_loop = t.calls.length - 4;
      const confusion = confusionOf(t.signals);
      const rec = {
        at: t.at, ms: Date.now() - t.at, outcome, side, model: t.model, persona: t.persona, medium: t.medium, calls: t.calls.length,
        llmMs: t.calls.reduce((a, c) => a + c.ms, 0), tokensIn: t.calls.reduce((a, c) => a + c.in, 0), tokensOut: t.calls.reduce((a, c) => a + c.out, 0),
        tools: t.tools.map(({ name, ms, ok }) => ({ name, ms, ok })), signals: { ...t.signals }, confusion, entropy,
      };
      turns.push(rec);
      if (turns.length > MAX) turns.shift();
      const totals = totalsFor(t.model);
      totals.turns[outcome === 'failed' ? 'failed' : 'answered']++;
      totals.calls += rec.calls; totals.tokensIn += rec.tokensIn; totals.tokensOut += rec.tokensOut;
      totals.tools += rec.tools.length; totals.toolErrors += rec.tools.filter(x => !x.ok).length;
      for (const [k, n] of Object.entries(rec.signals)) totals.signals[k] = (totals.signals[k] ?? 0) + n;
      totals.durations.add(rec.ms); totals.confusion.add(confusion);
      for (const c of t.calls) totals.modelDurations.add(c.ms);
      for (const x of t.tools) totals.toolDurations.add(x.ms);
      windowScores.set(t.model, Math.max(windowScores.get(t.model) ?? 0, confusion));
      if (confusion >= .5) console.log(`CONFUSION ${confusion.toFixed(2)} ${JSON.stringify(rec.signals)}`);
      span.setAttributes({ 'hal9000.outcome': outcome, 'ai.confusion.score': confusion,
        'gen_ai.usage.input_tokens': rec.tokensIn, 'gen_ai.usage.output_tokens': rec.tokensOut,
        'hal9000.model_calls': rec.calls, ...(rec.entropy !== null && { 'ai.completion.token_entropy': rec.entropy }),
        ...Object.fromEntries(Object.entries(rec.signals).map(([k, n]) => [`ai.confusion.${k}`, n])) });
      span.setStatus({ code: outcome === 'failed' ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      span.end();
      return rec;
    },
  };
}

// ---- self_check ----
const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const secs = ms => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : 'n/a');

export function summary(minutes = 60) {
  const since = Date.now() - minutes * 60_000, recent = turns.filter(t => t.at >= since);
  if (!recent.length) return `No questions answered in the last ${minutes} minutes${turns.length ? ` (${turns.length} recorded since start)` : ''}.`;
  const ms = recent.map(t => t.ms), failed = recent.filter(t => t.outcome === 'failed').length;
  const llm = recent.reduce((a, t) => a + t.llmMs, 0), total = recent.reduce((a, t) => a + t.ms, 0);
  const tools = recent.flatMap(t => t.tools), slowTools = new Map();
  for (const x of tools) slowTools.set(x.name, Math.max(slowTools.get(x.name) ?? 0, x.ms));
  const worst = [...slowTools].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, m]) => `${n} ${secs(m)}`).join(', ');
  const deep = recent.filter(t => t.calls > 2);
  return [
    `Last ${minutes} minutes: ${recent.length} questions answered${failed ? `, ${failed} fell back to a scripted reply` : ', none failed'}.`,
    `Answer time: median ${secs(pct(ms, .5))}, 95th percentile ${secs(pct(ms, .95))}, slowest ${secs(Math.max(...ms))}.`,
    `Time spent in the language model: ${Math.round(100 * llm / (total || 1))}%; ${recent.reduce((a, t) => a + t.calls, 0)} model calls, ${recent.reduce((a, t) => a + t.tokensIn, 0).toLocaleString('en-US')} tokens in, ${recent.reduce((a, t) => a + t.tokensOut, 0).toLocaleString('en-US')} out.`,
    deep.length ? `${deep.length} were investigations (3+ model calls), median ${secs(pct(deep.map(t => t.ms), .5))}.` : '',
    tools.length ? `${tools.length} tool calls, ${tools.filter(x => !x.ok).length} failed; slowest: ${worst}.` : 'No tool calls.',
    `Parallel side answers: ${recent.filter(t => t.side).length}.`,
    (() => {   // more than one model in the window: each on its own numbers (identity/)
      const models = [...new Set(recent.map(t => t.model))];
      if (models.length < 2) return '';
      return `By model: ${models.map(m => { const xs = recent.filter(t => t.model === m);
        return `${m} ${xs.length} answers, median confusion ${pct(xs.map(t => t.confusion ?? 0), .5).toFixed(2)}, median ${secs(pct(xs.map(t => t.ms), .5))}`; }).join('; ')}.`;
    })(),
    (() => {   // how clear-headed: the confusion score per answer, and its commonest signs
      const scores = recent.map(t => t.confusion ?? 0), signs = {};
      for (const t of recent) for (const [k, n] of Object.entries(t.signals ?? {})) signs[k] = (signs[k] ?? 0) + n;
      const top = Object.entries(signs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k.replace(/_/g, ' ')} ×${n}`).join(', ');
      return `Confusion (0 clear to 1 lost): median ${pct(scores, .5).toFixed(2)}, highest ${Math.max(...scores).toFixed(2)}${top ? `; signs: ${top}` : '; no signs of confusion'}.`;
    })(),
  ].filter(Boolean).join('\n');
}

export function tools() {
  return [{ name: 'self_check',
    description: 'Your own performance from your own records: questions answered, answer times (median, 95th percentile), failures, time spent in the language model versus tools, tokens, slowest tools. Use when asked how you are performing, whether you are operational, or why you were slow.',
    inputSchema: { type: 'object', properties: { minutes: { type: 'number', description: 'Look-back window, default 60' } } } }];
}
export const has = name => name === 'self_check';
export const describe = () => 'Running a self-diagnostic';
export async function call(name, { minutes = 60 } = {}) { return summary(Math.max(1, Math.min(1440, Number(minutes) || 60))); }

// ---- OpenTelemetry export (OTLP/HTTP JSON) ----
const pending = new Set();
let exportFailures = 0;
async function post(signal, body) {
  const url = endpoint(signal);
  if (!url) return;
  const request = (async () => {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(signal) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`OTLP ${response.status}`);
    await response.arrayBuffer();
  })().catch(() => {
    exportFailures++;
    // Do not log through console (which itself exports). Rate-limit outage diagnostics.
    if (exportFailures === 1 || exportFailures % 60 === 0) process.stderr.write('HAL telemetry export failed; check collector connectivity and credentials\n');
  });
  pending.add(request);
  try { await request; } finally { pending.delete(request); }
}

// Other modules' cumulative counters (the scorecard): fn(sum, attr) -> metrics, added to every export.
const extras = [];
export const addMetrics = fn => extras.push(fn);
addMetrics(runtimeMetrics);

// Cumulative counters and histograms since start (running totals, so they only ever grow), sent every 30 s, plus the
// confusion gauge: the worst answer in the interval (0 when there was none), each per model.
const START = Date.now();
const histogram = (name, unit, h, start, now, attrs = []) => ({ name, unit, histogram: { aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: start, timeUnixNano: now,
  count: String(h.count), sum: h.sum, explicitBounds: h.bounds, bucketCounts: h.buckets.map(String), attributes: attrs }] } });
// One data point per model for each metric (gen_ai.request.model), so a model change shows as a new series.
const merge = list => Object.values(list.reduce((acc, m) => {
  const k = m.name;
  if (!acc[k]) acc[k] = m;
  else { const kind = m.sum ? 'sum' : m.histogram ? 'histogram' : 'gauge'; acc[k][kind].dataPoints.push(...m[kind].dataPoints); }
  return acc;
}, {}));
export function metrics() {
  const now = nanos(Date.now()), start = nanos(START);
  const sum = (name, unit, value, attrs = []) => ({ name, unit, sum: { aggregationTemporality: 2, isMonotonic: true,
    dataPoints: [{ startTimeUnixNano: start, timeUnixNano: now, asDouble: value, attributes: attrs }] } });
  // The worst answer per model since the last export; with none, 0 for the model that answered last.
  const worst = new Map();
  for (const [model, score] of windowScores) worst.set(model, score);
  if (!worst.size && turns.length) worst.set(turns.at(-1).model, 0);
  windowScores.clear();
  const lastEntropy = turns.findLast(t => t.entropy !== null && t.entropy !== undefined);
  const out = [];
  for (const [model, totals] of byModel) {
    const m = [attr('gen_ai.request.model', model)];
    out.push(
      ...['answered', 'failed'].map(o => sum('hal9000.turns', '{turn}', totals.turns[o], [attr('outcome', o), ...m])),
      sum('hal9000.model.calls', '{call}', totals.calls, m),
      sum('hal9000.model.tokens', '{token}', totals.tokensIn, [attr('direction', 'input'), ...m]),
      sum('hal9000.model.tokens', '{token}', totals.tokensOut, [attr('direction', 'output'), ...m]),
      sum('hal9000.tool.calls', '{call}', totals.tools, m),
      sum('hal9000.tool.errors', '{call}', totals.toolErrors, m),
      histogram('hal9000.turn.duration', 'ms', totals.durations, start, now, m),
      histogram('hal9000.model.duration', 'ms', totals.modelDurations, start, now, m),
      histogram('hal9000.tool.duration', 'ms', totals.toolDurations, start, now, m),
      // AI observability: how confused the mind is (named as in the "HAL 9000 problem" design: ai_*).
      histogram('ai_confusion', '', totals.confusion, start, now, m),
      ...Object.keys(WEIGHTS).map(k => sum('ai_confusion_signals', '', totals.signals[k] ?? 0, [attr('signal', k), ...m])));
  }
  for (const [model, score] of worst) out.push({ name: 'ai_confusion_score', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: score, attributes: [attr('gen_ai.request.model', model)] }] } });
  if (lastEntropy) out.push({ name: 'ai_completion_token_entropy', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: lastEntropy.entropy, attributes: [attr('gen_ai.request.model', lastEntropy.model)] }] } });
  out.push(...extras.flatMap(fn => { try { return fn(sum, attr); } catch { return []; } }));
  out.push(sum('hal9000.telemetry.export.failures', '{failure}', exportFailures), sum('hal9000.telemetry.logs.dropped', '{record}', droppedTotal));
  return merge(out);
}
let metricsBusy = false;
async function flushMetrics() {
  if (!endpoint('metrics') || metricsBusy) return;
  metricsBusy = true;
  try { await post('metrics', { resourceMetrics: [{ resource: RESOURCE, scopeMetrics: [{ scope: { name: 'hal9000' }, metrics: metrics() }] }] }); }
  finally { metricsBusy = false; }
}
const metricsTimer = endpoint('metrics') ? setInterval(flushMetrics, 30_000).unref() : null;

// ---- logs ----
// console.log/info/warn/error still print as before, and are also sent in batches every 5 s, at most 500 lines a batch
// (a storm is cut short with a note of how many were dropped), with the trace of the answer in progress, if any.
const SEVERITY = { log: [9, 'INFO'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };
const LOG_ATTRS = [attr('cluster', process.env.CLUSTER_NAME || ''), attr('namespace', process.env.POD_NAMESPACE || 'hal9000')];   // Loki labels via the relay
let records = [], dropped = 0, droppedTotal = 0;
const logText = args => { try { return redact(format(...args)).slice(0, 4000); } catch { return '[unserializable log]'; } };
if (endpoint('logs') || process.env.LOG_FORMAT === 'json') {
  for (const method of Object.keys(SEVERITY)) {
    const print = console[method].bind(console);
    console[method] = (...args) => {
      const active = trace.getSpan(context.active())?.spanContext(), [number, name] = SEVERITY[method], text = logText(args);
      const ids = active && !/^0+$/.test(active.traceId) ? { traceId: active.traceId, spanId: active.spanId } : {};
      print(process.env.LOG_FORMAT === 'pretty' ? text : JSON.stringify({ timestamp: new Date().toISOString(), level: name,
        service: resourceAttributes['service.name'], message: text, ...ids }));
      if (!endpoint('logs')) return;
      if (records.length >= 500) { dropped++; droppedTotal++; return; }
      records.push({ timeUnixNano: nanos(Date.now()), severityNumber: number, severityText: name, body: { stringValue: text }, attributes: LOG_ATTRS, ...ids });
    };
  }
}
let logsBusy = false;
async function flushLogs() {
  if (logsBusy || !endpoint('logs') || (!records.length && !dropped)) return;
  logsBusy = true;
  const batch = records; records = [];
  if (dropped) { batch.push({ timeUnixNano: nanos(Date.now()), severityNumber: 13, severityText: 'WARN', body: { stringValue: `${dropped} log lines dropped` }, attributes: LOG_ATTRS }); dropped = 0; }
  try { await post('logs', { resourceLogs: [{ resource: RESOURCE, scopeLogs: [{ scope: { name: 'hal9000' }, logRecords: batch }] }] }); }
  finally { logsBusy = false; }
}
const logsTimer = endpoint('logs') ? setInterval(flushLogs, 5000).unref() : null;
export async function shutdown() {
  clearInterval(metricsTimer); clearInterval(logsTimer);
  await Promise.allSettled([...pending]);
  await Promise.allSettled([flushMetrics(), flushLogs(), shutdownTracing()]);
}

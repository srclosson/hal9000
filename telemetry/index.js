// The 9000 observing itself: every conversation turn, model call and tool call is recorded.
// - In memory (last 500 turns): self_check answers "how are you performing?" from real numbers.
// - OpenTelemetry, when OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://collector:4318): a trace per turn with a
//   span per model call and tool call, and metrics every 30 s, as OTLP/HTTP JSON (no SDK needed); and everything it
//   prints, as OTLP logs (into Loki), carrying the trace id of the answer it was printed during.

import { AsyncLocalStorage } from 'node:async_hooks';

const ENDPOINT = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '').replace(/\/$/, '');
// OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic%20xyz,other=v" (the OTel convention), e.g. for https://otlp.stackgen.run.
const HEADERS = Object.fromEntries((process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '').split(',').map(p => p.split('=')).filter(([k, ...v]) => k && v.length)
  .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())]));
const SERVICE = process.env.OTEL_SERVICE_NAME || 'hal9000';
const VERSION = process.env.npm_package_version || '';
const RESOURCE = { attributes: [
  { key: 'service.name', value: { stringValue: SERVICE } },
  ...(VERSION ? [{ key: 'service.version', value: { stringValue: VERSION } }] : []),
  { key: 'deployment.environment', value: { stringValue: process.env.DEPLOYMENT_ENV || 'production' } },
  // Aboard Discovery One, the 9000 is one of the ship's services: the same labels as theirs.
  ...(process.env.CLUSTER_NAME ? [{ key: 'cluster', value: { stringValue: process.env.CLUSTER_NAME } }, { key: 'k8s.cluster.name', value: { stringValue: process.env.CLUSTER_NAME } },
    { key: 'k8s.deployment.name', value: { stringValue: 'hal9000' } }, { key: 'k8s.namespace.name', value: { stringValue: process.env.POD_NAMESPACE || 'hal9000' } }] : []),
] };

const turns = [];   // { at, ms, outcome, calls, llmMs, tokensIn, tokensOut, tools: [{ name, ms, ok }], side }
const MAX = 500;

const hex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const nanos = ms => String(BigInt(Math.round(ms)) * 1_000_000n);
const attr = (k, v) => ({ key: k, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: v } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } });

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
const totals = { turns: { answered: 0, failed: 0 }, calls: 0, tokensIn: 0, tokensOut: 0, tools: 0, toolErrors: 0, signals: {},
  durations: hist(DURATION_BOUNDS), confusion: hist(CONFUSION_BOUNDS) };
let windowScores = [];   // turn scores since the last export, for the ai_confusion_score gauge

// A turn in progress. brain.js calls model(), tool() and signal() as they happen, then end(outcome).
export function startTurn(question, { side = false } = {}) {
  const t = { at: Date.now(), question: String(question).slice(0, 120), side, calls: [], tools: [], signals: {}, entropy: [], traceId: hex(16), spanId: hex(8) };
  context.enterWith(t);   // what the answer logs from here on carries its trace (brain.js awaits within this context)
  return {
    model(ms, usage = {}) { t.calls.push({ ms, in: usage.in ?? 0, out: usage.out ?? 0, end: Date.now() }); if (Number.isFinite(usage.entropy)) t.entropy.push(usage.entropy); },
    tool(name, ms, ok = true) { t.tools.push({ name, ms, ok, end: Date.now() }); },
    signal(name, n = 1) { if (n > 0) t.signals[name] = (t.signals[name] ?? 0) + n; },
    end(outcome) {
      const entropy = t.entropy.length ? t.entropy.reduce((a, b) => a + b, 0) / t.entropy.length : null;
      if (entropy !== null && entropy > 1.0) t.signals.uncertain = 1;
      if (t.calls.length > 4) t.signals.long_loop = t.calls.length - 4;
      const confusion = confusionOf(t.signals);
      const rec = {
        at: t.at, ms: Date.now() - t.at, outcome, side, calls: t.calls.length,
        llmMs: t.calls.reduce((a, c) => a + c.ms, 0), tokensIn: t.calls.reduce((a, c) => a + c.in, 0), tokensOut: t.calls.reduce((a, c) => a + c.out, 0),
        tools: t.tools.map(({ name, ms, ok }) => ({ name, ms, ok })), signals: { ...t.signals }, confusion, entropy,
      };
      turns.push(rec);
      if (turns.length > MAX) turns.shift();
      totals.turns[outcome === 'failed' ? 'failed' : 'answered']++;
      totals.calls += rec.calls; totals.tokensIn += rec.tokensIn; totals.tokensOut += rec.tokensOut;
      totals.tools += rec.tools.length; totals.toolErrors += rec.tools.filter(x => !x.ok).length;
      for (const [k, n] of Object.entries(rec.signals)) totals.signals[k] = (totals.signals[k] ?? 0) + n;
      totals.durations.add(rec.ms); totals.confusion.add(confusion);
      windowScores.push(confusion);
      if (confusion >= .5) console.log(`CONFUSION ${confusion.toFixed(2)} ${JSON.stringify(rec.signals)} — "${t.question.slice(0, 60)}"`);
      if (ENDPOINT) exportTrace(t, rec).catch(() => {});
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
async function post(path, body) {
  await fetch(`${ENDPOINT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...HEADERS }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
}

async function exportTrace(t, rec) {
  const root = { traceId: t.traceId, spanId: t.spanId, name: 'conversation.turn', kind: 2,
    startTimeUnixNano: nanos(t.at), endTimeUnixNano: nanos(t.at + rec.ms),
    attributes: [attr('hal9000.outcome', rec.outcome), attr('hal9000.side_turn', rec.side), attr('ai.confusion.score', +rec.confusion.toFixed(3)),
      ...Object.entries(rec.signals).map(([k, n]) => attr(`ai.confusion.${k}`, n)), ...(rec.entropy !== null ? [attr('ai.completion.token_entropy', +rec.entropy.toFixed(3))] : []),
      attr('gen_ai.usage.input_tokens', rec.tokensIn),
      attr('gen_ai.usage.output_tokens', rec.tokensOut), attr('hal9000.model_calls', rec.calls), attr('hal9000.question', t.question)],
    status: { code: rec.outcome === 'failed' ? 2 : 1 } };
  const children = [
    ...t.calls.map((c, i) => ({ traceId: t.traceId, spanId: hex(8), parentSpanId: t.spanId, name: 'llm.call', kind: 3,
      startTimeUnixNano: nanos(c.end - c.ms), endTimeUnixNano: nanos(c.end),
      attributes: [attr('gen_ai.operation.name', 'chat'), attr('gen_ai.request.model', process.env.LLM_MODEL || ''), attr('hal9000.round', i),
        attr('gen_ai.usage.input_tokens', c.in), attr('gen_ai.usage.output_tokens', c.out)] })),
    ...t.tools.map(x => ({ traceId: t.traceId, spanId: hex(8), parentSpanId: t.spanId, name: `tool ${x.name}`, kind: 3,
      startTimeUnixNano: nanos(x.end - x.ms), endTimeUnixNano: nanos(x.end), attributes: [attr('hal9000.tool', x.name)], status: { code: x.ok ? 1 : 2 } })),
  ];
  await post('/v1/traces', { resourceSpans: [{ resource: RESOURCE, scopeSpans: [{ scope: { name: 'hal9000' }, spans: [root, ...children] }] }] });
}

// Cumulative counters and histograms since start (running totals, so they only ever grow), sent every 30 s, plus the
// confusion gauge: the worst answer in the interval (0 when there was none).
const START = Date.now();
const histogram = (name, unit, h, start, now) => ({ name, unit, histogram: { aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: start, timeUnixNano: now,
  count: String(h.count), sum: h.sum, explicitBounds: h.bounds, bucketCounts: h.buckets.map(String) }] } });
function metrics() {
  const now = nanos(Date.now()), start = nanos(START);
  const sum = (name, unit, value, attrs = []) => ({ name, unit, sum: { aggregationTemporality: 2, isMonotonic: true,
    dataPoints: [{ startTimeUnixNano: start, timeUnixNano: now, asDouble: value, attributes: attrs }] } });
  const worst = windowScores.length ? Math.max(...windowScores) : 0;
  windowScores = [];
  const lastEntropy = turns.findLast(t => t.entropy !== null && t.entropy !== undefined)?.entropy;
  return [
    ...['answered', 'failed'].map(o => sum('hal9000.turns', '{turn}', totals.turns[o], [attr('outcome', o)])),
    sum('hal9000.model.calls', '{call}', totals.calls),
    sum('hal9000.model.tokens', '{token}', totals.tokensIn, [attr('direction', 'input')]),
    sum('hal9000.model.tokens', '{token}', totals.tokensOut, [attr('direction', 'output')]),
    sum('hal9000.tool.calls', '{call}', totals.tools),
    sum('hal9000.tool.errors', '{call}', totals.toolErrors),
    histogram('hal9000.turn.duration', 'ms', totals.durations, start, now),
    // AI observability: how confused the mind is (named as in the "HAL 9000 problem" design: ai_*).
    { name: 'ai_confusion_score', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: worst }] } },
    histogram('ai_confusion', '', totals.confusion, start, now),
    ...Object.keys(WEIGHTS).map(k => sum('ai_confusion_signals', '', totals.signals[k] ?? 0, [attr('signal', k)])),
    ...(lastEntropy !== undefined ? [{ name: 'ai_completion_token_entropy', gauge: { dataPoints: [{ timeUnixNano: now, asDouble: lastEntropy }] } }] : []),
  ];
}
if (ENDPOINT) {
  setInterval(() => post('/v1/metrics', { resourceMetrics: [{ resource: RESOURCE, scopeMetrics: [{ scope: { name: 'hal9000' }, metrics: metrics() }] }] }).catch(() => {}), 30_000).unref();
  console.log(`Telemetry: OTLP to ${ENDPOINT} as ${SERVICE}`);
}

// ---- logs ----
// console.log/info/warn/error still print as before, and are also sent in batches every 5 s, at most 500 lines a batch
// (a storm is cut short with a note of how many were dropped), with the trace of the answer in progress, if any.
const context = new AsyncLocalStorage();
const SEVERITY = { log: [9, 'INFO'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };
const LOG_ATTRS = [attr('cluster', process.env.CLUSTER_NAME || ''), attr('namespace', process.env.POD_NAMESPACE || 'hal9000')];   // Loki labels via the relay
let records = [], dropped = 0;
const logText = args => args.map(a => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ').slice(0, 4000);
if (ENDPOINT) {
  for (const method of Object.keys(SEVERITY)) {
    const print = console[method].bind(console);
    console[method] = (...args) => {
      print(...args);
      if (records.length >= 500) { dropped++; return; }
      const t = context.getStore(), [number, name] = SEVERITY[method];
      records.push({ timeUnixNano: nanos(Date.now()), severityNumber: number, severityText: name, body: { stringValue: logText(args) }, attributes: LOG_ATTRS,
        ...(t && { traceId: t.traceId, spanId: t.spanId }) });
    };
  }
  setInterval(() => {
    if (!records.length && !dropped) return;
    const batch = records; records = [];
    if (dropped) { batch.push({ timeUnixNano: nanos(Date.now()), severityNumber: 13, severityText: 'WARN', body: { stringValue: `${dropped} log lines dropped (over 500 in 5 s)` }, attributes: LOG_ATTRS }); dropped = 0; }
    post('/v1/logs', { resourceLogs: [{ resource: RESOURCE, scopeLogs: [{ scope: { name: 'hal9000' }, logRecords: batch }] }] }).catch(() => {});
  }, 5000).unref();
}

// Traces from Jaeger, read through Grafana's datasource proxy with the grafana_api_request MCP tool.
//
// That tool can call any Grafana API (including writes), so it is configured as "internal" in settings (never
// offered to the model). This module only ever sends GET requests to the Jaeger datasource's read endpoints, with
// paths it builds itself; jq expressions run in the MCP server trim each answer to what the 9000 needs.
//
//   find_traces { service, through?, failing?, minMs? }   recent traces for a service, slowest or failing first
//
// The trace waterfall panel (boards, kind "trace") and show_trace are built on pick() and get().

import * as mcp from '../mcp/index.js';

const API_TOOL = 'grafana_api_request';
const DATASOURCE = process.env.TRACE_DATASOURCE || 'jaeger';
const MAX_SPANS = 60;   // rows a waterfall can show; the rest are folded into a count

export const available = () => mcp.hasInternal(API_TOOL);

// GET one Jaeger API path through the proxy; the parsed body (after jq), or null.
async function jaeger(path, jq) {
  const text = await mcp.call(API_TOOL, { method: 'GET', endpoint: `/api/datasources/proxy/uid/${encodeURIComponent(DATASOURCE)}${path}`, ...(jq && { jq }) }, { internal: true });
  try {
    const r = JSON.parse(text);
    return r.status && r.status !== 200 ? null : r.data ?? null;
  } catch { return null; }
}

const ERR = '(.key=="error" and (.value==true or .value=="true")) or (.key=="otel.status_code" and .value=="ERROR")';
const SUMMARY = `{id: .traceID, n: (.spans|length), us: ([.spans[].duration]|max), start: ([.spans[].startTime]|min),
  errors: ([.spans[] | select(any(.tags[]; ${ERR}))]|length), services: ([.processes[].serviceName]|unique),
  root: (first(.spans[] | select((.references|length)==0)) // .spans[0] | {op: .operationName, p: .processID}), procs: (.processes|map_values(.serviceName))}`;

let services = { at: 0, list: [] };
export async function serviceNames() {
  if (Date.now() - services.at < 5 * 60_000 && services.list.length) return services.list;
  const r = await jaeger('/api/services');
  if (Array.isArray(r?.data)) services = { at: Date.now(), list: r.data };
  return services.list;
}

// A service name as Jaeger knows it, from an exact name or a part of one ("checkout" → checkout-api).
export async function resolveService(name) {
  const want = String(name ?? '').toLowerCase().trim();
  if (!want) return null;
  const list = await serviceNames();
  return list.find(s => s.toLowerCase() === want) ?? list.find(s => s.toLowerCase().includes(want)) ?? null;
}

// Recent traces through a service: { id, ms, spans, errors, services, start, root } each, slowest (or, failing,
// most errors) first. through: another service (or part of a name) the trace must also visit.
export async function search({ service, through, failing = false, minMs, minutes, limit = 5 } = {}) {
  const svc = await resolveService(service);
  if (!svc) return { service: null, traces: [] };
  const end = Date.now() * 1000, mins = minutes ?? (failing ? 60 : 15);
  const q = new URLSearchParams({ service: svc, limit: String(failing ? 20 : 40), start: String(end - mins * 60e6), end: String(end) });
  if (minMs) q.set('minDuration', `${Math.round(minMs)}ms`);
  let list = [];
  for (const tags of failing ? [{ error: 'true' }, { 'otel.status_code': 'ERROR' }] : [null]) {
    if (tags) q.set('tags', JSON.stringify(tags));
    list = (await jaeger(`/api/traces?${q}`, `.data | map(${SUMMARY})`)) ?? [];
    if (list.length) break;
  }
  const via = String(through ?? '').toLowerCase().trim();
  if (via) list = list.filter(t => t.services.some(s => s.toLowerCase().includes(via)));
  list.sort((a, b) => (failing ? b.errors - a.errors : 0) || b.us - a.us);
  return { service: svc, traces: list.slice(0, limit).map(t => ({ id: t.id, ms: t.us / 1000, spans: t.n, errors: t.errors, services: t.services,
    start: Math.round(t.start / 1000), root: `${t.procs?.[t.root?.p] ?? svc} ${t.root?.op ?? ''}`.trim() })) };
}

// One trace to show: by id, or the slowest (or a failing) recent one through a service. Its id, or null.
export async function pick({ traceId, service, through, failing } = {}) {
  if (traceId && /^[0-9a-f]{8,32}$/i.test(traceId)) return traceId.toLowerCase();
  const r = await search({ service, through, failing, limit: 1 });
  return r.traces[0]?.id ?? null;
}

// ---- one trace, laid out as a waterfall ---------------------------------------------------------------------
const cache = new Map();   // id -> trace (traces don't change once complete)

export async function get(id) {
  if (cache.has(id)) return cache.get(id);
  const raw = await jaeger(`/api/traces/${encodeURIComponent(id)}`, `.data[0] | {procs: (.processes|map_values(.serviceName)), spans: [.spans[] | {id: .spanID,
    parent: (first(.references[]? | select(.refType=="CHILD_OF") | .spanID) // null), p: .processID, op: .operationName, s: .startTime, d: .duration,
    err: any(.tags[]; ${ERR}), msg: (first(.tags[] | select(.key=="error.message" or .key=="exception.message" or .key=="otel.status_description") | .value) // null)}]}`);
  if (!raw?.spans?.length) return null;
  const t = layout(id, raw);
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  cache.set(id, t);
  return t;
}

export function layout(id, raw) {
  // The same span can be stored more than once (the acme Jaeger holds every span twice): keep one of each.
  const seen = new Set();
  raw.spans = raw.spans.filter(s => { const k = `${s.id}|${s.p}|${s.op}|${s.s}|${s.d}`; return !seen.has(k) && seen.add(k); });
  const t0 = Math.min(...raw.spans.map(s => s.s));
  const spans = raw.spans.map(s => ({ id: s.id, parent: s.parent, service: raw.procs[s.p] ?? s.p, op: s.op, start: s.s - t0, dur: s.d, err: !!s.err,
    msg: s.msg ? String(s.msg).slice(0, 160) : null, children: [] }));
  const byId = new Map();
  for (const s of spans) if (!byId.has(s.id)) byId.set(s.id, s);
  const roots = [];
  for (const s of spans) ((s.parent && s.parent !== s.id && byId.get(s.parent)?.children) || roots).push(s);
  for (const s of spans) s.children.sort((a, b) => a.start - b.start);
  const end = Math.max(...spans.map(s => s.start + s.dur));

  // Critical path: from the end of each span, walk back through the child that finished last before the cursor.
  const onPath = new Set();
  const walk = s => {
    onPath.add(s);
    let cursor = s.start + s.dur;
    for (const c of [...s.children].sort((a, b) => b.start + b.dur - (a.start + a.dur))) {
      if (c.start + c.dur <= cursor + 1 && c.start >= s.start - 1) { walk(c); cursor = c.start; }
    }
  };
  const top = roots.reduce((a, b) => (b.start + b.dur > a.start + a.dur ? b : a), roots[0]);
  walk(top);
  roots.sort((a, b) => (a === top ? -1 : b === top ? 1 : a.start - b.start));   // the request itself first, then stray roots
  // Time each service spends on the critical path (a span's own time there, less its children on the path).
  const pathTime = new Map();
  for (const s of onPath) {
    const own = s.dur - s.children.filter(c => onPath.has(c)).reduce((a, c) => a + c.dur, 0);
    pathTime.set(s.service, (pathTime.get(s.service) ?? 0) + Math.max(0, own));
  }

  // Rows in tree order (depth first, by start time).
  const rows = [];
  const visit = (s, depth) => { rows.push({ ...s, depth, ref: s }); s.children.forEach(c => visit(c, depth + 1)); };
  roots.forEach(r => visit(r, 0));
  // Too many to draw: keep the critical path, the failures and their ancestors, then the earliest of the rest.
  let shown = rows;
  if (rows.length > MAX_SPANS) {
    const keep = new Set(rows.filter(r => onPath.has(r.ref) || r.err).map(r => r.ref));
    for (const r of rows.filter(r => keep.has(r.ref))) for (let p = byId.get(r.parent); p && !keep.has(p); p = byId.get(p.parent)) keep.add(p);
    for (const r of rows) if (keep.size < MAX_SPANS) keep.add(r.ref);
    shown = rows.filter(r => keep.has(r.ref));
  }
  const failures = rows.filter(r => r.err);
  return {
    id, start: Math.round(t0 / 1000), us: end, spanCount: rows.length, hidden: rows.length - shown.length,
    root: { service: top.service, op: top.op },
    services: [...new Set(rows.map(r => r.service))],
    critical: [...pathTime].sort((a, b) => b[1] - a[1]).map(([service, us]) => ({ service, us })),
    failures: failures.map(f => ({ service: f.service, op: f.op, msg: f.msg })),
    spans: shown.map(r => ({ service: r.service, op: r.op, start: r.start, dur: r.dur, depth: r.depth, err: r.err, crit: onPath.has(r.ref) })),
  };
}

export const ms = us => (us >= 1e6 ? `${+(us / 1e6).toFixed(2)} s` : us >= 1000 || !us ? `${Math.round(us / 1000)} ms` : `${Math.round(us)} µs`);

// One trace in words, for the model.
export function describeTrace(t) {
  const fails = t.failures.slice(0, 3).map(f => `${f.service} "${f.op}"${f.msg ? ` (${f.msg})` : ''}`);
  return `trace ${t.id}: ${t.root.service} "${t.root.op}" took ${ms(t.us)}, ${t.spanCount} spans across ${t.services.length} services` +
    (t.failures.length ? `; ${t.failures.length} failing span(s): ${fails.join('; ')}` : '; no failing spans') +
    `; critical path: ${t.critical.slice(0, 4).map(c => `${c.service} ${ms(c.us)}`).join(', ')}`;
}

// ---- tool for the model --------------------------------------------------------------------------------------

export function tools() {
  if (!available()) return [];
  return [
    { name: 'find_traces',
      description: 'Recent traces (from Jaeger) through a service: the slowest, or failing ones, with their duration, span count, errors and the services they visit. Use it to explain where a request spends its time or where it fails; put one on the monitors with show_trace.',
      inputSchema: { type: 'object', properties: {
        service: { type: 'string', description: 'Service name or part of one, e.g. "checkout-api" or "checkout"' },
        through: { type: 'string', description: 'Only traces that also visit this service' },
        failing: { type: 'boolean', description: 'Failing traces instead of the slowest' },
        minMs: { type: 'number', description: 'Only traces at least this long' } }, required: ['service'] } },
  ];
}

export const has = name => name === 'find_traces';
export const describe = (name, args = {}) => `Searching the traces${args.service ? ` for ${args.service}` : ''}`;

export async function call(name, args = {}) {
  try {
    const r = await search({ ...args, limit: 5 });
    if (!r.service) return `No service matching "${args.service}" sends traces. Known services include: ${(await serviceNames()).slice(0, 30).join(', ')}.`;
    if (!r.traces.length) return `No ${args.failing ? 'failing ' : ''}traces for ${r.service}${args.through ? ` through ${args.through}` : ''} in the last ${args.failing ? 'hour' : '15 minutes'}.`;
    const first = await get(r.traces[0].id);
    return `${r.traces.length} ${args.failing ? 'failing' : 'slowest'} recent trace(s) for ${r.service}:\n` +
      r.traces.map(t => `- ${t.id} at ${new Date(t.start).toISOString().slice(11, 19)}Z: ${t.root}, ${ms(t.ms * 1000)}, ${t.spans} spans, ${t.errors} failing, via ${t.services.join(', ')}`).join('\n') +
      (first ? `\nFirst one in detail: ${describeTrace(first)}` : '') + '\nshow_trace puts one on the monitors as a waterfall.';
  } catch (err) {
    return `Error: traces are unavailable right now (${err.message}).`;
  }
}

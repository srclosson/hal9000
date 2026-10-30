// Live data boards: up to six panels of monitoring data that temporarily replace the ship's systems on
// the monitors, refreshed every 15 s. The 9000 puts them up through built-in tools (not MCP):
//
//   show_cluster_health { cluster }   a curated board with known-good queries (the reliable path)
//   show_panels { title, panels }     an ad-hoc board; every query is tested and empty ones are dropped
//   show_story { title, panels }      an alert story: panels in narrative order, each with its narration,
//                                     spoken afterwards as a guided tour (the monitors follow along)
//   show_trace { service, through?, failing?, traceId? }   one trace as a waterfall, added to the board showing
//   clear_panels {}                   back to the ship's systems
//
// Queries run through the MCP tool named by BOARD_QUERY_TOOL (default query_prometheus) against the
// Prometheus datasource BOARD_DATASOURCE (default "metrics"), so boards work wherever Grafana MCP is connected.
//
// Panel kinds: stat, timeseries (with warn/crit threshold lines and an optional "since" marker), list (one row
// per series), logs (matching Loki lines), note (a few words of text), events (a timeline of [time, label]).
// Panel shape sent to monitors:
//   { code, title, unit, kind, value, display, status: 'ok'|'warn'|'crit'|'nodata',
//     series: [numbers], window, warn, crit, since (timeseries), items: [{ label, value, display }] (list),
//     lines: [{ time, text, level }] (logs), text (note), events: [{ time, label }] (events) }

import * as mcp from '../mcp/index.js';
import { changes } from '../changes/index.js';
import * as traces from '../traces/index.js';
import * as aiden from '../aiden/index.js';
import * as fixes from '../fixes/index.js';
import * as timeline from '../timeline/index.js';

import { readCompose, describeCompose, layersOf } from './compose.js';

const QUERY_TOOL = process.env.BOARD_QUERY_TOOL || 'query_prometheus';
const DATASOURCE = process.env.BOARD_DATASOURCE || 'metrics';
const LOGS_TOOL = process.env.BOARD_LOGS_TOOL || 'query_loki_logs';
const LOGS_DATASOURCE = process.env.BOARD_LOGS_DATASOURCE || 'loki';
const KINDS = ['compose', 'stat', 'timeseries', 'graph', 'list', 'bargauge', 'table', 'histogram', 'heatmap', 'state', 'flow', 'trace', 'timeline', 'logs', 'note', 'events'];
const REFRESH_MS = 15_000;
const MAX_PANELS = 6;

export const available = () => mcp.names().includes(QUERY_TOOL);

// ---- curated boards ----------------------------------------------------------------------------------
// Signals chosen to be meaningful in the connected estate (see the grafana hint in MCP_SERVERS).

function clusterHealth(cluster) {
  const c = `cluster="${cluster.replace(/["\\]/g, '')}"`;
  return {
    title: `Cluster health · ${cluster}`,
    panels: [
      { code: 'ERR', title: 'Error rate', unit: '%', kind: 'timeseries', warn: 1, crit: 5,
        query: `100 * max(http_error_ratio{${c}})` },
      { code: 'LAT', title: 'Worst latency', unit: 'ms', kind: 'timeseries', warn: 500, crit: 1000,
        query: `max(http_request_duration_ms_milliseconds{${c}})` },
      { code: 'RPS', title: 'Requests per second', unit: 'req/s', kind: 'timeseries',
        query: `sum(rate(http_requests_total{${c}}[1m]))` },
      { code: 'CLB', title: 'Crash-looping pods', unit: 'pods', kind: 'list', warn: 1, crit: 3,
        query: `count(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",${c}} == 1) or vector(0)`,
        listQuery: `count by (namespace, pod) (kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff",${c}} == 1)`,
        listLabel: 'pod' },
      { code: 'RST', title: 'Restarts, last hour', unit: 'restarts', kind: 'stat', warn: 1, crit: 10,
        query: `sum(increase(kube_pod_container_status_restarts_total{${c}}[1h])) or vector(0)` },
      { code: 'NOD', title: 'Nodes not ready', unit: 'nodes', kind: 'stat', warn: 1, crit: 2,
        query: `(count(kube_node_info{${c}}) - count(kube_node_status_condition{condition="Ready",status="true",${c}} == 1)) or vector(0)` },
    ],
  };
}

// ---- querying ------------------------------------------------------------------------------------------

// shift: minutes into the past to move the whole range (1440 = the same window yesterday).
// step: seconds between points (default: a point per minutes*2 seconds, at least 30).
export async function prom(expr, range, minutes = 30, shift = 0, step) {
  const args = range
    ? { datasourceUid: DATASOURCE, expr, queryType: 'range', startTime: `now-${minutes + shift}m`, endTime: shift ? `now-${shift}m` : 'now', stepSeconds: step ?? Math.max(30, Math.round(minutes * 2)) }
    : { datasourceUid: DATASOURCE, expr, queryType: 'instant', endTime: shift ? `now-${shift}m` : 'now' };
  const text = await mcp.call(QUERY_TOOL, args, { internal: true });   // parsed here: no trimming
  try { return JSON.parse(text).data ?? []; } catch { return null; }   // null: error text from the tool
}

export async function loki(logql, limit = 6, minutes) {
  const text = await mcp.call(LOGS_TOOL, { datasourceUid: LOGS_DATASOURCE, logql, limit, direction: 'backward',
    ...(minutes ? { startRfc3339: new Date(Date.now() - minutes * 60_000).toISOString() } : {}) }, { internal: true });
  try {
    return (JSON.parse(text).data ?? []).map(e => {
      let body = e.line ?? '';
      try { const j = JSON.parse(body); body = j.body ?? j.message ?? j.msg ?? body; } catch { /* plain text line */ }
      const ns = String(e.timestamp ?? '').replace(/\D/g, '');
      // Whole lines (up to 1,500 characters): the monitors shorten them to fit and show them in full on hover.
      return { time: ns ? Math.round(Number(ns.slice(0, 13))) : null, text: String(body).slice(0, 1500), level: e.labels?.level ?? e.labels?.detected_level ?? '' };
    });
  } catch { return null; }
}

// ---- the metric browser ---------------------------------------------------------------------------------
// The monitors' list of metric names (dragged onto a trend to ask the 9000 to add one): the names Prometheus has,
// for one cluster or all, kept two minutes. The kind comes from the name, by Prometheus convention (…_total is a
// counter, …_bucket/_sum/_count a histogram's series, anything else a gauge), so the 9000 knows to rate() a counter.
const NAMES_TOOL = process.env.BOARD_LABELS_TOOL || 'list_prometheus_label_values';
const browsed = new Map();   // labelName|cluster -> { at, names }
async function labelValues(labelName, cluster) {
  const key = `${labelName}|${cluster ?? ''}`, hit = browsed.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.names;
  const text = await mcp.call(NAMES_TOOL, { datasourceUid: DATASOURCE, labelName, limit: 5000,
    ...(cluster && { matches: [{ filters: [{ name: 'cluster', value: cluster, type: '=' }] }] }) }, { internal: true });
  let v; try { v = JSON.parse(text); v = v?.data ?? v; } catch { return null; }
  if (!Array.isArray(v)) return null;
  const names = v.map(String).sort();
  browsed.set(key, { at: Date.now(), names });
  return names;
}
const kindOf = name => (/_total$/.test(name) ? 'counter' : /_(bucket|sum|count)$/.test(name) ? 'histogram' : 'gauge');

// -> { clusters: [names], cluster, metrics: [{ name, kind }] }, or null when Prometheus can't be reached.
export async function browse({ cluster } = {}) {
  if (!available()) return null;
  const [clusters, names] = await Promise.all([labelValues('cluster'), labelValues('__name__', cluster || null)]);
  if (!names) return null;
  return { clusters: clusters ?? [], cluster: cluster || null, metrics: names.map(name => ({ name, kind: kindOf(name) })) };
}

const COUNTS = new Set(['pods', 'nodes', 'restarts', 'alerts', 'conns', 'connections', 'errors', 'lines']);
const fmt = (v, unit) => {
  if (!Number.isFinite(v)) return '—';
  if (COUNTS.has(String(unit).toLowerCase())) return String(Math.round(v));   // counts are whole numbers
  const n = Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? v.toFixed(1) : +v.toFixed(2);
  return unit === '%' ? `${n}%` : String(n);
};

function status(v, p) {
  if (!Number.isFinite(v)) return 'nodata';
  if (p.crit !== undefined && v >= p.crit) return 'crit';
  if (p.warn !== undefined && v >= p.warn) return 'warn';
  return 'ok';
}

// ---- baselines and change marks for trends ----------------------------------------------------------------
// The same window yesterday, drawn faintly behind today's line (cached for five minutes per query and window).
const ydCache = new Map();
async function yesterday(query, minutes) {
  const key = `${minutes}|${query}`, hit = ydCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.series;
  const r = await prom(query, true, minutes, 1440).catch(() => null);
  const series = (r?.[0]?.values ?? []).map(([, v]) => parseFloat(v)).filter(Number.isFinite);
  if (ydCache.size > 200) ydCache.clear();
  ydCache.set(key, { at: Date.now(), series });
  return series;
}
// Changes in the panel's cluster (read from its query) during the window, each tied to what this panel's line did
// next. points: [[ms, value]] of the panel's (headline) series.
async function marksFor(query, minutes, points = [], p = {}) {
  const cluster = String(query ?? '').match(/cluster\s*=\s*"([^"]+)"/)?.[1];
  if (!cluster) return [];
  const list = await changes(cluster, minutes).catch(() => []);
  return list.map(c => annotate(c, points, p, query));
}

// What the line did in the ten minutes after a change, against the ten minutes before it. A change "matters" to the
// panel (and gets words on the trend) when it is on a service the panel is about, or the line moved after it.
const IMPACT_MS = 10 * 60_000;
function annotate(c, points, p, query) {
  const mark = { t: c.time, until: c.until, label: c.label.slice(0, 48), kind: c.kind, service: c.service, count: c.count,
    items: c.items.map(i => ({ time: i.time, text: i.text })) };
  const before = points.filter(([t]) => t < c.time && t >= c.time - IMPACT_MS).map(([, v]) => v).sort((a, b) => a - b);
  const after = points.filter(([t]) => t > c.time && t <= c.time + IMPACT_MS);
  const named = !!c.service && String(query ?? '').includes(c.service);
  if (before.length && after.length) {
    const base = before[Math.floor(before.length / 2)];
    const [peakT, peak] = after.reduce((a, b) => (Math.abs(b[1] - base) > Math.abs(a[1] - base) ? b : a));
    const crossed = [p.warn, p.crit].some(th => th !== undefined && (base < th) !== (peak < th));
    const moved = crossed || (Math.abs(peak - base) >= Math.max(Math.abs(base) * .3, 1e-9) && Math.abs(peak - base) > 0);
    if (moved) {
      const half = after.find(([, v]) => Math.abs(v - base) >= Math.abs(peak - base) / 2) ?? [peakT];
      const lag = Math.max(0, Math.round((half[0] - c.time) / 60_000)), up = peak > base, unit = p.unit && p.unit !== '%' ? ` ${p.unit}` : '';
      mark.impact = { before: base, after: peak, up, lag, crossed,
        display: `${fmt(base, p.unit)} → ${fmt(peak, p.unit)}${unit}${lag ? ` within ${lag} min` : ' at once'}` };
      mark.label = `${mark.label} · ${up ? '↑' : '↓'} ${lag ? `+${lag} MIN` : 'AT ONCE'}`;
    }
  }
  mark.relevant = named || !!mark.impact;
  return mark;
}

// ---- histograms ------------------------------------------------------------------------------------------
// Two shapes: a Prometheus histogram (series with an "le" label, cumulative counts, e.g.
// sum by (le) (rate(x_bucket[5m]))) becomes per-bucket counts; any other set of series is binned by value.
const MAX_BARS = 10;
const seconds = q => /_seconds_bucket/.test(q ?? '');
const bound = (v, secs, unit) => !Number.isFinite(v) ? '∞'
  : secs ? (v < 1 ? `${+(v * 1000).toPrecision(3)}ms` : `${+v.toPrecision(3)}s`)
  : `${+v.toPrecision(3)}${unit && unit !== '%' ? '' : unit ?? ''}`;

// Estimate a quantile from cumulative buckets, as histogram_quantile does (linear within a bucket).
function quantile(q, cum) {
  const total = cum.at(-1)?.[1] ?? 0;
  if (!total) return NaN;
  const rank = q * total;
  for (let i = 0; i < cum.length; i++) {
    const [le, c] = cum[i];
    if (c >= rank) {
      if (!Number.isFinite(le)) return cum[i - 1]?.[0] ?? NaN;   // in the +Inf bucket: report the last finite bound
      const [ple, pc] = i ? cum[i - 1] : [0, 0];
      return ple + (le - ple) * (c === pc ? 1 : (rank - pc) / (c - pc));
    }
  }
  return NaN;
}

// Merge neighbouring bars until at most MAX_BARS remain: always the adjacent pair with the fewest samples,
// so the dense part of the distribution keeps its detail and the sparse tail is lumped together.
// A merged bar keeps the upper bound of its group.
function merge(bars) {
  bars = [...bars];
  while (bars.length > MAX_BARS) {
    let best = 0;
    for (let i = 1; i < bars.length - 1; i++) if (bars[i].value + bars[i + 1].value < bars[best].value + bars[best + 1].value) best = i;
    bars.splice(best, 2, { ...bars[best + 1], value: bars[best].value + bars[best + 1].value });
  }
  return bars;
}

function histogram(series, p) {
  if (!series?.length) return { status: 'nodata', display: '—' };
  const secs = seconds(p.query);
  if (series.some(s => s.metric?.le !== undefined)) {
    // Sum by le, in case the query kept other labels.
    const byLe = new Map();
    for (const s of series) {
      const le = s.metric?.le === '+Inf' ? Infinity : parseFloat(s.metric?.le);
      const v = parseFloat(s.value?.[1]);
      if (!Number.isNaN(le) && Number.isFinite(v)) byLe.set(le, (byLe.get(le) ?? 0) + v);
    }
    const cum = [...byLe].sort((a, b) => a[0] - b[0]);
    const total = cum.at(-1)?.[1] ?? 0;
    // Differences of cumulative rates carry float noise (1e-13): treat that as empty.
    let bars = cum.map(([le, c], i) => ({ le, value: c - (i ? cum[i - 1][1] : 0) }))
      .map(b => ({ ...b, value: b.value > total * 1e-9 ? b.value : 0 }));
    // Trim empty buckets at either end, so the shape fills the panel.
    const first = bars.findIndex(b => b.value > 0), last = bars.findLastIndex(b => b.value > 0);
    if (first < 0) return { status: 'ok', display: '0', value: 0, buckets: [], total: 0 };
    bars = merge(bars.slice(first, last + 1));
    const buckets = bars.map(b => ({
      label: Number.isFinite(b.le) ? `≤${bound(b.le, secs, p.unit)}` : `>${bound(cum.at(-2)?.[0], secs, p.unit)}`,
      value: b.value,
    }));
    const p50 = quantile(.5, cum), p95 = quantile(.95, cum);
    const show = v => secs ? bound(v, true) : fmt(v, p.unit);
    return {
      buckets, total: cum.at(-1)[1], p50: show(p50), p95: show(p95),
      value: p95, display: show(p95), status: status(p95, p), stat: 'P95',
    };
  }
  // Plain series (e.g. memory per pod): equal-width bins across the observed range.
  const vals = series.map(s => parseFloat(s.value?.[1])).filter(Number.isFinite);
  if (!vals.length) return { status: 'nodata', display: '—' };
  const lo = Math.min(...vals), hi = Math.max(...vals), n = Math.min(8, Math.max(1, vals.length)), width = (hi - lo) / n || 1;
  const counts = Array(n).fill(0);
  for (const v of vals) counts[Math.min(n - 1, Math.floor((v - lo) / width))]++;
  const buckets = counts.map((value, i) => ({ label: `≤${fmt(lo + width * (i + 1), p.unit)}`, value }));
  return {
    buckets, total: vals.length, value: hi, display: fmt(hi, p.unit), status: status(hi, p), stat: 'MAX',
    p50: fmt(vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)], p.unit),
  };
}

// ---- multi-series kinds: graph, state timeline, heatmap, table, bar gauge ----------------------------------
const MAX_ROWS = 8;
const seriesLabel = (m = {}, key) => (key && m[key]) ??
  (Object.entries(m).filter(([k]) => k !== '__name__').map(([, v]) => v).join(' ') || 'value');
const RANK = { nodata: 0, ok: 1, warn: 2, crit: 3 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);

// Range query → [{ label, points: [[ms, value]] }], busiest (latest value) first.
async function rangeSeries(p, minutes, limit = MAX_ROWS) {
  const r = await prom(p.query, true, minutes);
  return (r ?? []).map(s => ({
    label: seriesLabel(s.metric, p.listLabel),
    metric: s.metric ?? {},
    points: (s.values ?? []).map(([t, v]) => [Math.round(t * 1000), +parseFloat(v).toPrecision(4)]).filter(([, v]) => Number.isFinite(v)),
  })).filter(s => s.points.length).sort((a, b) => b.points.at(-1)[1] - a.points.at(-1)[1]).slice(0, limit);
}

// Instant query → rows, busiest first, each with its own health.
async function instantRows(p) {
  const r = await prom(p.query);
  return (r ?? []).map(s => ({ metric: s.metric ?? {}, value: parseFloat(s.value?.[1]) }))
    .filter(x => Number.isFinite(x.value)).sort((a, b) => b.value - a.value).slice(0, MAX_ROWS)
    .map(x => ({ ...x, label: seriesLabel(x.metric, p.listLabel), display: fmt(x.value, p.unit), status: status(x.value, p) }));
}

// State of one sample: the named state the 9000 gave for that value, else the thresholds.
function stateOf(v, p) {
  const named = (p.states ?? []).find(s => Number(s.value) === v) ?? (p.states ?? []).find(s => Number(s.value) === Math.round(v));
  if (named) return { name: String(named.name ?? v).toUpperCase().slice(0, 12), status: named.status ?? 'ok' };
  const st = status(v, p);
  return { name: { ok: 'OK', warn: 'WARN', crit: 'CRIT', nodata: '—' }[st], status: st };
}

async function readMulti(out, p, spec) {
  const minutes = p.window ?? spec.window ?? 30;
  const none = { ...out, status: 'nodata', display: '—' };

  if (out.kind === 'graph') {   // a detailed trend: several series, axes, legend, thresholds
    const lines = await rangeSeries(p, minutes, 5);
    if (!lines.length) return none;
    const head = lines[0].points.at(-1)[1];
    return { ...out, window: minutes, warn: p.warn, crit: p.crit, since: p.since ? Date.parse(p.since) || null : null, marks: await marksFor(p.query, minutes, lines[0].points, p),
      graph: lines.map(({ label, points }) => ({ label, points, display: fmt(points.at(-1)[1], p.unit) })),
      value: head, display: fmt(head, p.unit), status: lines.reduce((st, l) => worse(st, status(l.points.at(-1)[1], p)), 'ok') };
  }

  if (out.kind === 'state') {   // state timeline: one band per series, coloured by state over time
    const rows = await rangeSeries(p, minutes, 6);
    if (!rows.length) return none;
    const start = Math.min(...rows.map(r => r.points[0][0])), end = Math.max(...rows.map(r => r.points.at(-1)[0]));
    const bands = rows.map(r => {
      const segs = [];   // runs of the same state: { from, to, name, status }
      for (const [t, v] of r.points) {
        const s = stateOf(v, p), last = segs.at(-1);
        if (last && last.name === s.name) last.to = t; else segs.push({ from: t, to: t, ...s });
      }
      return { label: r.label, segs, now: segs.at(-1) };
    });
    const worst = bands.reduce((a, b) => (RANK[b.now.status] > RANK[a.now.status] ? b : a));
    return { ...out, window: minutes, start, end, bands, display: worst.now.name, status: worst.now.status,
      value: bands.filter(b => b.now.status !== 'ok').length };
  }

  if (out.kind === 'heatmap') {   // distribution over time: the buckets of a Prometheus histogram, or one row per series
    const r = (await prom(p.query, true, minutes)) ?? [];
    if (!r.length) return none;
    const secs = seconds(p.query);
    let rows;
    if (r.some(s => s.metric?.le !== undefined)) {
      // Per time step, difference the cumulative buckets into per-bucket counts.
      const byLe = new Map();
      for (const s of r) {
        const le = s.metric?.le === '+Inf' ? Infinity : parseFloat(s.metric?.le);
        if (Number.isNaN(le)) continue;
        const m = byLe.get(le) ?? new Map();
        for (const [t, v] of s.values ?? []) m.set(t, (m.get(t) ?? 0) + (parseFloat(v) || 0));
        byLe.set(le, m);
      }
      const les = [...byLe.keys()].sort((a, b) => a - b);
      const times = [...new Set(les.flatMap(le => [...byLe.get(le).keys()]))].sort((a, b) => a - b);
      const cum = les.map(le => times.map(t => byLe.get(le).get(t) ?? 0));
      const top = Math.max(...cum.at(-1), 0);
      rows = les.map((le, i) => ({
        le, label: Number.isFinite(le) ? `≤${bound(le, secs, p.unit)}` : `>${bound(les.at(-2), secs, p.unit)}`,
        cells: times.map((_, j) => { const d = cum[i][j] - (i ? cum[i - 1][j] : 0); return d > top * 1e-9 ? d : 0; }),
      }));
      const used = i => rows[i].cells.some(v => v > 0);
      const first = rows.findIndex((_, i) => used(i)), last = rows.findLastIndex((_, i) => used(i));
      if (first < 0) return { ...out, display: '0', value: 0, status: 'ok', rows: [] };
      rows = rows.slice(first, last + 1);
      while (rows.length > MAX_BARS) {   // merge the sparsest neighbours, as the histogram does
        const sum = r => r.cells.reduce((a, b) => a + b, 0);
        let best = 0;
        for (let i = 1; i < rows.length - 1; i++) if (sum(rows[i]) + sum(rows[i + 1]) < sum(rows[best]) + sum(rows[best + 1])) best = i;
        rows.splice(best, 2, { ...rows[best + 1], cells: rows[best].cells.map((v, j) => v + rows[best + 1].cells[j]) });
      }
      // Headline: p95 now, from the latest step.
      const lastCum = les.map((le, i) => [le, cum[i].at(-1)]);
      const p95 = quantile(.95, lastCum), show = v => secs ? bound(v, true) : fmt(v, p.unit);
      return { ...out, window: minutes, rows: rows.map(({ label, cells }) => ({ label, cells: cells.map(v => +v.toPrecision(3)) })), lowFirst: true,
        value: p95, display: show(p95), stat: 'P95', status: status(p95, p) };
    }
    const series = await rangeSeries(p, minutes, 10);
    const n = Math.max(...series.map(s => s.points.length));
    rows = series.map(s => ({ label: s.label, cells: Array.from({ length: n }, (_, j) => s.points[j - (n - s.points.length)]?.[1] ?? 0) }));
    const head = series[0].points.at(-1)[1];
    return { ...out, window: minutes, rows, value: head, display: fmt(head, p.unit), stat: 'MAX', status: status(head, p) };
  }

  const rows = await instantRows(p);
  if (!rows.length) return none;
  const head = rows[0];

  if (out.kind === 'table') {   // label columns plus the value, worst first
    const columns = (p.columns?.length ? p.columns : [p.listLabel ?? Object.keys(head.metric).find(k => k !== '__name__') ?? 'series']).slice(0, 3);
    return { ...out, columns: [...columns, out.unit || 'value'],
      rows: rows.map(r => ({ cells: columns.map(c => String(r.metric[c] ?? '—')), display: r.display, status: r.status })),
      value: head.value, display: fmt(head.value, p.unit), status: head.status };
  }

  // bargauge: one gauge per series, filled against a scale, with threshold marks.
  const max = p.max ?? (Math.max(head.value, p.crit ?? 0, p.warn ?? 0) * 1.1 || 1);
  return { ...out, max, warn: p.warn, crit: p.crit,
    items: rows.map(({ label, value, display, status }) => ({ label, value, display, status })),
    value: head.value, display: head.display, status: head.status };
}

// ---- flow: a data-flow diagram of the system ---------------------------------------------------------------
// Live mode: edges from the trace service graph (client → server), each with its request rate and error %,
// scoped to the named services and their neighbours (or, with none named, the part of the graph in trouble).
// Manual mode: nodes and edges the 9000 wrote, each optionally carrying a PromQL query for its number.
const GRAPH_TOTAL = process.env.SERVICE_GRAPH_TOTAL || 'traces_service_graph_request_total';
const GRAPH_FAILED = process.env.SERVICE_GRAPH_FAILED || 'traces_service_graph_request_failed_total';
const MAX_NODES = 12;

// Longest-path layers, left to right; cycles are cut by capping the depth.
function layer(nodes, edges) {
  // Columns by the longest path from the starting boxes, over the edges that go forward: an edge back to a box no
  // further from the start (A ⇄ B, a loop) is left out of the layering, so loops don't push boxes ever rightwards.
  const ids = new Set(nodes.map(n => n.id)), into = new Set(edges.map(e => e.to));
  const near = new Map(), queue = nodes.filter(n => !into.has(n.id)).map(n => n.id);
  if (!queue.length && nodes.length) queue.push(nodes[0].id);
  for (const id of queue) near.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const e of edges) if (e.from === id && ids.has(e.to) && !near.has(e.to)) { near.set(e.to, near.get(id) + 1); queue.push(e.to); }
  }
  for (const n of nodes) if (!near.has(n.id)) near.set(n.id, 0);
  const forward = edges.filter(e => ids.has(e.from) && ids.has(e.to) && near.get(e.to) > near.get(e.from));
  const depth = new Map(nodes.map(n => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let moved = false;
    for (const e of forward) {
      const d = depth.get(e.from) + 1;
      if (d > depth.get(e.to)) { depth.set(e.to, d); moved = true; }
    }
    if (!moved) break;
  }
  // No empty columns.
  const used = [...new Set(depth.values())].sort((a, b) => a - b);
  return new Map([...depth].map(([id, d]) => [id, used.indexOf(d)]));
}

async function readFlow(out, p) {
  const errStatus = pct => status(pct, { warn: p.warn ?? 1, crit: p.crit ?? 5 });
  let nodes, edges;

  if (p.nodes?.length) {   // manual
    const num = async q => { if (!q) return NaN; const r = await prom(q); return r?.[0]?.value ? parseFloat(r[0].value[1]) : NaN; };
    nodes = await Promise.all(p.nodes.slice(0, MAX_NODES).map(async n => {
      const v = await num(n.query);
      return { id: String(n.id), label: String(n.label ?? n.id).slice(0, 24), value: v,
        display: Number.isFinite(v) ? `${fmt(v, n.unit ?? p.unit)}${n.unit && n.unit !== '%' ? ' ' + n.unit : ''}` : '',
        status: Number.isFinite(v) ? status(v, { warn: n.warn ?? p.warn, crit: n.crit ?? p.crit }) : (n.status ?? 'ok') };
    }));
    const ids = new Set(nodes.map(n => n.id));
    edges = await Promise.all((p.edges ?? []).filter(e => ids.has(String(e.from)) && ids.has(String(e.to))).slice(0, 24).map(async e => {
      const v = await num(e.query);
      return { from: String(e.from), to: String(e.to), value: v, label: e.label ? String(e.label).slice(0, 16) : '',
        display: Number.isFinite(v) ? `${fmt(v, e.unit ?? '')}${e.unit && e.unit !== '%' ? ' ' + e.unit : ''}` : '',
        status: Number.isFinite(v) ? status(v, { warn: e.warn, crit: e.crit }) : (e.status ?? 'ok') };
    }));
  } else {   // live, from the service graph
    const [tot, fail] = await Promise.all([
      prom(`sum by (client, server) (rate(${GRAPH_TOTAL}[5m]))`),
      prom(`sum by (client, server) (rate(${GRAPH_FAILED}[5m]))`),
    ]);
    if (!tot?.length) return { ...out, status: 'nodata', display: '—' };
    const failed = new Map((fail ?? []).map(r => [`${r.metric.client}→${r.metric.server}`, parseFloat(r.value[1]) || 0]));
    let all = tot.map(r => ({ from: r.metric.client, to: r.metric.server, rps: parseFloat(r.value[1]) || 0 }))
      .filter(e => e.from && e.to && e.from !== e.to)
      .map(e => ({ ...e, failed: failed.get(`${e.from}→${e.to}`) ?? 0 }));
    // Failures recorded on edges with no traffic count against the edge anyway.
    for (const [k, f] of failed) if (f > 0 && !all.some(e => `${e.from}→${e.to}` === k)) {
      const [from, to] = k.split('→'); if (from !== to) all.push({ from, to, rps: f, failed: f });
    }
    // Scope: the named services (by substring) plus everything connected to them, nearest first.
    const named = (p.services ?? []).map(x => String(x).toLowerCase()).filter(Boolean);
    let seeds = named.length
      ? [...new Set(all.flatMap(e => [e.from, e.to]))].filter(n => named.some(x => n.toLowerCase().includes(x)))
      : [...all].sort((a, b) => b.failed - a.failed || b.rps - a.rps).slice(0, 1).map(e => e.from);
    if (!seeds.length) return { ...out, status: 'nodata', display: '—' };
    // Up to two hops out; shared infrastructure (a node many services call, like redis) is shown but not
    // expanded, or it would pull in the whole estate.
    const degree = new Map();
    for (const e of all) for (const n of [e.from, e.to]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const keep = new Set(seeds), queue = seeds.map(n => [n, 0]);
    while (queue.length && keep.size < MAX_NODES) {
      const [n, hops] = queue.shift();
      if (hops >= 2 || (hops > 0 && degree.get(n) > 5)) continue;
      for (const e of all) for (const [a, b] of [[e.from, e.to], [e.to, e.from]])
        if (a === n && !keep.has(b) && keep.size < MAX_NODES) { keep.add(b); queue.push([b, hops + 1]); }
    }
    all = all.filter(e => keep.has(e.from) && keep.has(e.to));
    edges = all.map(e => {
      const pct = e.rps > 0 ? (100 * e.failed) / e.rps : e.failed > 0 ? 100 : 0;
      return { from: e.from, to: e.to, value: e.rps, err: pct, display: `${fmt(e.rps)}/s`, errDisplay: pct > 0 ? fmt(pct, '%') : '', status: errStatus(pct) };
    });
    nodes = [...keep].map(id => {
      const inbound = edges.filter(e => e.to === id), rps = inbound.reduce((a, e) => a + e.value, 0);
      const bad = all.filter(e => e.to === id).reduce((a, e) => a + e.failed, 0), pct = rps > 0 ? (100 * bad) / rps : 0;
      return { id, label: id, value: rps, err: pct, display: inbound.length ? `${fmt(rps)}/s` : '', errDisplay: pct > 0 ? fmt(pct, '%') : '',
        status: errStatus(pct) };
    });
  }
  if (!nodes.length) return { ...out, status: 'nodata', display: '—' };
  const depth = layer(nodes, edges);
  nodes = nodes.map(n => ({ ...n, layer: depth.get(n.id) ?? 0 }));
  const worst = [...nodes, ...edges].reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a), { status: 'ok' });
  const errs = [...nodes, ...edges].filter(x => x.status !== 'ok');
  return { ...out, nodes, edges, value: errs.length, status: worst.status,
    display: errs.length ? `${errs.length} FAULT${errs.length > 1 ? 'S' : ''}` : 'NOMINAL' };
}

// ---- timeline: the story over time: the signal (the alert\'s own query, or query) with annotations of what happened along it: the alert firing, deploys and other changes, the acknowledgement, Aiden\'s finding, plans approved and their checks, incident updates; set alert_uid or incident (query optional); trace: one request as a waterfall ---------------------------------------------------------------------
// The trace is picked once (when the panel is made) and pinned by id, so refreshes keep showing the same request.
async function readTrace(out, p) {
  const t = p.traceId && await traces.get(p.traceId);
  if (!t) return { ...out, status: 'nodata', display: '—' };
  const durMs = t.us / 1000;
  const status = t.failures.length ? 'crit' : (p.crit !== undefined && durMs >= p.crit) ? 'crit' : (p.warn !== undefined && durMs >= p.warn) ? 'warn' : 'ok';
  return { ...out, traceId: t.id, start: t.start, us: t.us, value: durMs, display: traces.ms(t.us), unit: '', status,
    root: t.root, spanCount: t.spanCount, hidden: t.hidden, services: t.services, failures: t.failures.slice(0, 3),
    critical: t.critical.slice(0, 4).map(c => ({ ...c, display: traces.ms(c.us) })), spans: t.spans };
}

// ---- aiden: an Aiden investigation of an alert, followed live (panels added by the server, not the model) -------
const AIDEN_WORD = { matching: 'FINDING ALERT', queued: 'QUEUED', running: 'INVESTIGATING', completed: 'FINDINGS', draft: 'FINDINGS',
  unmatched: 'NO RECORD', failed: 'FAILED', error: 'UNAVAILABLE' };
function readAiden(out, p) {
  const run = aiden.get(p.alertUid);
  if (!run) return { ...out, status: 'nodata', display: '—' };
  const done = aiden.finished(run);
  return { ...out, display: done ? 'FINDINGS' : AIDEN_WORD[run.status] ?? run.status.toUpperCase(), value: aiden.elapsed(run),
    status: ['unmatched', 'failed', 'error'].includes(run.status) ? 'warn' : 'ok',
    aiden: { status: run.status, done, startedAt: run.startedAt, finishedAt: run.finishedAt ?? null, summary: run.summary ?? '', url: run.url ?? null,
      evidence: run.evidence ?? null, alert: run.title, error: run.error ?? null } };
}

// ---- plan: a fix the 9000 proposed, its steps and their state (panels added by the server, not the model) -------
const PLAN_HEALTH = { pending: 'warn', approved: 'warn', running: 'warn', verifying: 'warn', verified: 'ok', done: 'ok', unverified: 'crit', failed: 'crit',
  rejected: 'ok', expired: 'ok', replaced: 'ok' };
function readPlan(out, p) {
  const plan = fixes.get(p.planId);
  if (!plan) return { ...out, status: 'nodata', display: '—' };
  return { ...out, display: plan.status === 'pending' ? 'AWAITING APPROVAL' : fixes.statusWords(plan).toUpperCase(), status: PLAN_HEALTH[plan.status] ?? 'ok',
    plan: { id: plan.id, status: plan.status, title: plan.title, problem: plan.problem, expected: plan.expected, decidedBy: plan.decidedBy, expiresAt: plan.expiresAt,
      steps: plan.steps.map(s => ({ tool: s.tool, why: s.why, status: s.status })), verify: plan.verify && { expect: plan.verify.expect, value: plan.verify.value, now: plan.verify.now } } };
}

// ---- timeline: the story over time: the signal, with what happened annotated along it --------------------------
// Around an alert (alert_uid) or an incident: the alert's own query unless another is given, from a little before the
// first event to now. Events come from timeline/index.js (alert, changes, acknowledgement, Aiden, plans, the incident).
async function readTimeline(out, p, spec) {
  const tl = await timeline.collect({ alertUid: p.alert_uid, incident: p.incident, cluster: p.cluster, minutes: p.window ?? spec.window ?? 60 });
  const query = p.query || tl.rule?.query;
  const minutes = Math.max(10, Math.ceil((tl.to - tl.from) / 60_000));
  const r = query ? await prom(query, true, minutes).catch(() => null) : null;
  const series = (r?.[0]?.values ?? []).map(([t, v]) => [Math.round(t * 1000), parseFloat(v)]).filter(([, v]) => Number.isFinite(v));
  const crit = p.crit ?? (Number.isFinite(tl.rule?.threshold) && !tl.rule?.below ? tl.rule.threshold : undefined);
  const last = series.at(-1)?.[1];
  const fired = tl.events.find(e => e.kind === 'alert'), since = Number.isFinite(Date.parse(tl.rule?.since)) ? Date.parse(tl.rule.since) : fired?.t;
  const open = tl.rule?.state === 'firing' || (tl.incident && tl.incident.status !== 'resolved');
  const mins = Number.isFinite(since) ? Math.round((Date.now() - since) / 60_000) : null;
  return { ...out, kind: 'timeline', start: tl.from, end: tl.to, series, events: tl.events, unit: p.unit ?? out.unit, warn: p.warn, crit,
    value: last, display: mins !== null ? `${mins < 120 ? `${mins} MIN` : mins < 2880 ? `${Math.round(mins / 60)} H` : `${Math.round(mins / 1440)} DAYS`}${open ? '' : ' · CLEARED'}` : Number.isFinite(last) ? fmt(last, p.unit) : `${tl.events.length} EVENTS`,
    status: tl.rule?.state === 'firing' ? 'crit' : open ? 'warn' : 'ok' };
}

// Signals a composed panel can lay on a trend as events (boards/compose.js): -> [{ time, text, level?, traceId? }].
// profiles: add a reader here when a profiling backend (Pyroscope, via mcp-grafana's query_pyroscope) is connected.
const EVENT_SOURCES = {
  logs: (e, minutes, limit) => (e.query ? loki(String(e.query), limit, minutes) : []),
  traces: async (e, minutes, limit) => {
    if (!traces.available() || !e.service) return [];
    const r = await traces.search({ service: e.service, failing: !!e.failing, minMs: e.min_ms, minutes, limit });
    return r.traces.map(t => ({ time: t.start, traceId: t.id, level: t.errors ? 'error' : '',
      text: `${t.errors ? `failing trace (${t.errors} error${t.errors > 1 ? 's' : ''})` : 'slow trace'} ${t.root} ${traces.ms(t.ms * 1000)}` }));
  },
};

async function readPanel(p, spec = {}) {
  const out = { code: p.code, title: p.title, unit: p.unit ?? '', kind: p.kind ?? 'stat' };
  // Panels without a query: the 9000 wrote their content (a headline, a next step, a timeline).
  if (p.insight) out.insight = p.insight;   // situation board: why this panel is on screen
  if (p.baseline) out.baseline = p.baseline;   // against yesterday: new, worsening or chronic
  if (p.snooze) out.snooze = p.snooze;         // situation board: what snoozing this panel hides
  if (p.fix) out.fix = p.fix;                  // situation board: the most likely fix and its effort
  if (out.kind === 'note') return { ...out, text: String(p.text ?? '').slice(0, 280), display: p.value ?? '', status: p.status ?? 'ok' };
  if (out.kind === 'events') {
    const events = (p.events ?? []).slice(0, 8).map(e => ({ time: e.time ?? '', label: String(e.label ?? '').slice(0, 90) }));
    return { ...out, events, display: `${events.length}`, status: p.status ?? 'ok' };
  }
  if (out.kind === 'logs') {
    const lines = await loki(p.query, 6);
    if (!lines) return { ...out, status: 'nodata', display: '—' };
    return { ...out, lines, value: lines.length, display: lines.length ? `${lines.length}+` : '0', status: p.status ?? (lines.length ? 'warn' : 'ok') };
  }
  if (out.kind === 'flow') return readFlow(out, p);
  if (out.kind === 'trace') return readTrace(out, p);
  if (out.kind === 'aiden') return readAiden(out, p);
  if (out.kind === 'plan') return readPlan(out, p);
  if (out.kind === 'timeline') return readTimeline(out, p, spec);
  if (out.kind === 'compose') return readCompose(out, p, spec, { prom, fmt, status, seriesLabel, marksFor, sources: EVENT_SOURCES, readPanel, pickTrace: e => traces.pick(e) });
  if (['graph', 'state', 'heatmap', 'table', 'bargauge'].includes(out.kind)) return readMulti(out, p, spec);
  if (out.kind === 'histogram') return { ...out, ...histogram(await prom(p.query), p) };
  const now = await prom(p.query);
  const value = now?.[0]?.value ? parseFloat(now[0].value[1]) : NaN;
  Object.assign(out, { value, display: fmt(value, p.unit), status: status(value, p) });
  if (out.kind === 'timeseries') {
    const minutes = p.window ?? spec.window ?? 30;
    const [r, yd] = await Promise.all([prom(p.query, true, minutes), yesterday(p.query, minutes)]);
    const points = (r?.[0]?.values ?? []).map(([t, v]) => [t * 1000, parseFloat(v)]).filter(([, v]) => Number.isFinite(v));
    out.series = points.map(([, v]) => v);
    const marks = await marksFor(p.query, minutes, points, p);
    Object.assign(out, { window: minutes, warn: p.warn, crit: p.crit, since: p.since ? Date.parse(p.since) || null : null, yesterday: yd, marks });
  }
  if (out.kind === 'list') {
    const r = p.listQuery ? await prom(p.listQuery) : now;
    out.items = (r ?? []).map(s => ({
      label: s.metric?.[p.listLabel] ?? Object.values(s.metric ?? {}).join(' ') ?? '',
      value: parseFloat(s.value?.[1]),
    })).filter(i => Number.isFinite(i.value)).sort((a, b) => b.value - a.value).slice(0, 6)
      .map(i => ({ ...i, display: fmt(i.value, p.unit) }));
    // A list built from the panel's own query (one series per service, say): headline and health come from
    // the worst series, not whichever happened to come first.
    if (!p.listQuery && out.items.length) {
      const worst = out.items[0].value;
      Object.assign(out, { value: worst, display: fmt(worst, p.unit), status: status(worst, p) });
    }
  }
  return out;
}

// ---- boards per room -------------------------------------------------------------------------------------

const active = new Map();   // room -> { spec, timer, last }

async function refresh(room, send) {
  const b = active.get(room);
  if (!b) return;
  const panels = await Promise.all(b.spec.panels.map(p => readPanel(p, b.spec).catch(() => ({ code: p.code, title: p.title, status: 'nodata', display: '—' }))));
  if (active.get(room) !== b) return;   // replaced or cleared meanwhile
  b.last = { title: b.spec.title, story: !!b.spec.story, panels };
  send({ type: 'board', board: b.last });
}

export function stop(room, send) {
  const b = active.get(room);
  if (!b) return false;
  clearInterval(b.timer);
  active.delete(room);
  tours.delete(room);
  send?.({ type: 'board', board: homeFor(room) });   // back to the situation board (or the ship systems)
  viewsChanged(room);
  return true;
}

export const hasActive = room => active.has(room);

// Take one panel off a ship's board ("dismiss", "snooze" on a one-off board). The rest re-flow; an empty board goes
// back to the situation board. Returns the removed panel's title, or null.
export function removePanel(room, code, send) {
  const b = active.get(room);
  const p = b?.spec.panels.find(x => x.code === code);
  if (!p) return null;
  b.spec = { ...b.spec, panels: b.spec.panels.filter(x => x.code !== code) };
  if (!b.spec.panels.length) { stop(room, send); return p.title; }
  if (b.last) b.last = { ...b.last, panels: b.last.panels.filter(x => x.code !== code) };
  send?.({ type: 'board', board: b.last });
  refresh(room, send);
  return p.title;
}

// ---- the situation board (home screen) ---------------------------------------------------------------------------
// One shared board, composed by home/index.js and refreshed here every 15 s, shown on every ship that has no other
// board up and hasn't asked for the ship systems. The server tells us which ships those are.
const home = { spec: null, timer: null, last: null };
let homeShips = () => [];          // -> [{ room, send }] ships currently showing the situation board
let wantsHome = () => true;        // room -> false while that ship shows the ship systems instead

export function configureHome({ ships, wants }) {
  homeShips = ships;
  wantsHome = wants;
}
export const homeFor = room => (wantsHome(room) ? home.last : null);

async function refreshHome() {
  if (!home.spec) return;
  const spec = home.spec;
  const panels = await Promise.all(spec.panels.map(p => readPanel(p, spec).catch(() => ({ code: p.code, title: p.title, status: 'nodata', display: '—' }))));
  if (home.spec !== spec) return;   // recomposed meanwhile
  home.last = { title: spec.title, home: true, panels };
  for (const ship of homeShips()) ship.send({ type: 'board', board: home.last });
}

export function setHome(spec) {
  home.spec = spec;
  clearInterval(home.timer);
  refreshHome();
  home.timer = setInterval(refreshHome, REFRESH_MS);
}

export const current = room => active.get(room)?.last ?? homeFor(room);

// Guided-tour narration from the last show_story, collected once by the server after the reply is ready.
const tours = new Map();   // room -> [{ code, text }]
export function takeTour(room) {
  const t = tours.get(room);
  tours.delete(room);
  return t ?? null;
}

async function start(room, spec, send, keepId) {
  stop(room);
  const id = keepId ?? remember(room, spec);   // a re-opened board keeps its place in the list
  const b = { id, spec, timer: null, last: null };
  active.set(room, b);
  await refresh(room, send);
  b.timer = setInterval(() => refresh(room, send), REFRESH_MS);
  viewsChanged(room);
  return b.last;
}

// Add a panel to the one-off board a ship is showing (replacing a panel with the same code, or the oldest when the
// board is full), or open a board of its own when the ship shows the situation board or its systems.
// extra: a panel the 9000 adds for itself (Aiden's), allowed one place beyond the usual six.
export async function addPanel(room, panel, send, title, { extra = false } = {}) {
  const b = active.get(room);
  if (!b) {
    // Redesigning a panel of the situation board: the board becomes this ship's own, with that panel replaced.
    const homePanels = homeFor(room) && home.spec?.panels.some(x => x.code === panel.code) ? home.spec.panels : null;
    if (homePanels) return start(room, { title: home.spec.title, panels: homePanels.map(x => (x.code === panel.code ? panel : x)) }, send);
    return start(room, { title, panels: [panel] }, send);
  }
  const at = b.spec.panels.findIndex(x => x.code === panel.code);
  if (at >= 0) b.spec = { ...b.spec, panels: b.spec.panels.map((x, i) => (i === at ? panel : x)) };   // redesigned in place
  else b.spec = { ...b.spec, panels: [...b.spec.panels.slice(-(extra ? MAX_PANELS : MAX_PANELS - 1)), panel] };
  await refresh(room, send);
  return b.last;
}

// ---- recent views per ship, for the monitors' view picker -----------------------------------------------------
// Every board shown is remembered (newest first, one entry per title) so it can be brought back, live, later.
const MAX_RECENT = 8;
const recent = new Map();          // room -> [{ id, title, story, spec }]
let nextViewId = 1;
let viewsChanged = () => {};       // set by the server: re-send the views list for a room

export const onViewsChange = fn => { viewsChanged = fn; };

function remember(room, spec) {
  const list = (recent.get(room) ?? []).filter(v => v.title !== spec.title);
  const id = `b${nextViewId++}`;
  list.unshift({ id, title: spec.title, story: !!spec.story, spec });
  recent.set(room, list.slice(0, MAX_RECENT));
  return id;
}

// The boards this ship has seen, and which one (if any) is up now.
export const views = room => (recent.get(room) ?? []).map(({ id, title, story }) => ({ id, title, kind: story ? 'story' : 'board' }));
export const activeId = room => active.get(room)?.id ?? null;

// Bring a remembered board back (live again). Returns false if it's no longer remembered.
export async function reopen(room, id, send) {
  const v = (recent.get(room) ?? []).find(x => x.id === id);
  if (!v) return false;
  await start(room, v.spec, send, v.id);
  return true;
}

// Ad-hoc panels: keep only those whose query returns data now.
async function validate(panels) {
  const kept = [], dropped = [], seen = new Set();
  for (const p of panels.slice(0, MAX_PANELS)) {
    let code = String(p.code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    // No code given: make one from the title's initials ("Checkout to ledger flow" → CTL), else its first letters.
    if (code.length < 2) {
      const words = String(p.title ?? p.kind ?? '').toUpperCase().match(/[A-Z0-9]+/g) ?? [];
      code = (words.length >= 3 ? words.map(w => w[0]).join('') : words.join('')).slice(0, 3);
      for (let n = 2; seen.has(code) && n < 10; n++) code = code.slice(0, 2) + n;
    }
    const kind = KINDS.includes(p.kind) ? p.kind : 'stat';
    if (code.length < 2 || seen.has(code)) { dropped.push(p.code ?? '?'); continue; }
    if (kind === 'timeline') {
      if (!p.alert_uid && !p.incident && !p.query && !p.cluster) { dropped.push(code); continue; }
      seen.add(code); kept.push({ ...p, code, kind }); continue;
    }
    if (kind === 'compose' && p.layout === 'story') {   // a story card: its elements are checked when read
      if (!Array.isArray(p.elements) || !p.elements.length) { dropped.push(code); continue; }
      seen.add(code); kept.push({ ...p, code, kind }); continue;
    }
    if (kind === 'compose') {   // keep the layers that have data now; the panel needs one
      const { layers } = layersOf(p);
      const live = [];
      for (const l of layers) if ((await prom(l.query, false, 0, l.shift))?.length) live.push(l.index);
      if (!live.length) { dropped.push(code); continue; }
      const given = Array.isArray(p.layers) && p.layers.length ? p.layers.filter(l => l?.query) : null;
      seen.add(code); kept.push({ ...p, code, kind, ...(given && { layers: given.filter((_, i) => live.includes(i)) }) }); continue;
    }
    if (kind === 'trace') {
      const id = await traces.pick(p).catch(() => null);
      if (!id) { dropped.push(code); continue; }
      seen.add(code); kept.push({ ...p, code, kind, traceId: id }); continue;
    }
    if (kind === 'note' ? !p.text : kind === 'events' ? !p.events?.length : kind === 'flow' ? false : !p.query) { dropped.push(code); continue; }
    if (kind === 'logs') { if (!(await loki(p.query, 1))) { dropped.push(code); continue; } }
    else if (!['note', 'events', 'flow'].includes(kind) && !(await prom(p.query))?.length) { dropped.push(code); continue; }
    seen.add(code);
    kept.push({ ...p, code, kind });
  }
  return { kept, dropped };
}

// What the model hears back: the live values, so its spoken verdict matches the panels.
// One panel in words: code, title, headline value, health and the detail behind it.
function panelLine(p) {
  const items = p.items?.length ? ` (${p.items.map(i => `${i.label} ${i.display}`).join(', ')})`
    : p.nodes?.length ? ` (${[...p.nodes.filter(n => n.status !== 'ok').map(n => `${n.label} ${n.errDisplay || n.display} ${n.status}`),
        ...p.edges.filter(e => e.status !== 'ok').map(e => `${p.nodes.find(n => n.id === e.from)?.label ?? e.from}→${p.nodes.find(n => n.id === e.to)?.label ?? e.to} ${e.errDisplay || e.display} ${e.status}`)].join(', ') || 'no faults'}; showing ${p.nodes.map(n => n.label).join(', ')})`
    : p.kind === 'compose' && p.layout ? describeCompose(p, panelLine)
    : p.kind === 'timeline' ? ` (${p.events.length} events: ${p.events.slice(-8).map(e => `${new Date(e.t).toISOString().slice(11, 16)}Z ${e.label}`).join('; ')})`
    : p.plan ? ` (plan ${p.plan.id} "${p.plan.title}": ${p.display.toLowerCase()}; ${p.plan.steps.map((s, i) => `${i + 1}. ${s.tool} [${s.status}]`).join(', ')})`
    : p.aiden ? ` (Aiden ${p.aiden.done ? 'finished' : p.aiden.status}${p.aiden.summary ? `: ${p.aiden.summary}` : ''})`
    : p.spans?.length ? ` (${p.root.service} "${p.root.op}", ${p.spanCount} spans across ${p.services.length} services; ${p.failures.length ? `failing: ${p.failures.map(f => `${f.service} "${f.op}"${f.msg ? ` (${f.msg})` : ''}`).join('; ')}` : 'no failing spans'}; critical path ${p.critical.map(c => `${c.service} ${c.display}`).join(', ')}; trace ${p.traceId})`
    : p.graph?.length ? ` (${p.graph.map(l => `${l.label} ${l.display}`).join(', ')})`
    : p.bands?.length ? ` (now: ${p.bands.map(b => `${b.label} ${b.now.name}` + (b.segs.length > 1 ? `, ${b.segs.length - 1} changes` : '')).join('; ')})`
    : p.rows?.[0]?.cells && p.columns ? ` (${p.rows.map(r => `${r.cells.join(' ')} ${r.display}`).join(', ')})`
    : p.rows?.length ? ` (${p.rows.length} rows: ${p.rows.map(r => r.label).join(', ')})`
    : p.buckets?.length ? ` (${p.stat === 'P95' ? `p50 ${p.p50}, p95 ${p.p95}; ` : `median ${p.p50}, max ${p.display}; `}buckets ${p.buckets.map(b => `${b.label}: ${fmt(b.value)}`).join(', ')})`
    : p.lines?.length ? ` (latest: ${p.lines.slice(0, 3).map(l => l.text.slice(0, 90)).join(' | ')})`
    : p.text ? ` "${p.text}"` : p.insight ? ` — ${p.insight}` : '';
  const fix = p.fix ? `; likely fix (${p.fix.effort}${p.fix.basis !== 'none' ? `, from ${p.fix.basis}` : ''}): ${p.fix.text}` : '';
  const base = p.baseline && p.baseline !== 'normal' ? ` [${p.baseline}]` : '';
  const chg = (p.marks ?? []).filter(m => m.relevant).slice(-3).map(m => `${new Date(m.t).toISOString().slice(11, 16)}Z ${m.label.replace(/ · .*$/, '')}${m.impact ? ` then ${m.impact.display}` : ''}`);
  const state = { ok: 'normal', warn: 'WARNING', crit: 'CRITICAL', nodata: 'no data' }[p.status];
  return `${p.code} ${p.title}: ${p.stat ? p.stat + ' ' : ''}${p.display}${p.unit && p.unit !== '%' ? ' ' + p.unit : ''} (${state})${base}${items}${fix}` +
    (chg.length ? `; changes marked: ${chg.join('; ')}` : '');
}

// One panel on a ship's screen, for drilldown questions: its live values, the line the model hears, and how it is
// built (query, labels, services), so a follow-up can query around it.
export function panelInfo(room, code) {
  const board = current(room);
  const p = board?.panels.find(x => x.code === code);
  if (!p) return null;
  const spec = (board.home ? home.spec : active.get(room)?.spec)?.panels.find(x => x.code === code) ?? {};
  const how = [spec.query && `query ${spec.query}`, spec.layers?.length && `layers ${spec.layers.map(l => `${l.query}${l.shift ? ` shifted ${l.shift} min` : ''}${l.style ? ` (${l.style})` : ''}`).join(' | ')}`, spec.listLabel && `per ${spec.listLabel}`, spec.services?.length && `services ${spec.services.join(', ')}`]
    .filter(Boolean).join('; ');
  return { board: board.title, home: !!board.home, panel: p, spec, line: panelLine(p) + (how ? ` [${how}]` : '') };
}

function summary(board, dropped = []) {
  const lines = board.panels.map(panelLine);
  return `Board "${board.title}" is now on the monitors (refreshing every 15 seconds):\n${lines.join('\n')}` +
    (dropped.length ? `\nDropped (no data): ${dropped.join(', ')}.` : '') +
    `\nGive the person a one-sentence spoken verdict from these values; mention anything at WARNING or CRITICAL and which panel shows it. Panels are not coloured green, so do not call them green.`;
}

// ---- tools for the model ---------------------------------------------------------------------------------

const PANEL_PROPS = {
  code: { type: 'string', description: 'Three capital letters shown on the panel, unique on the board, e.g. ERR, LAT, DBC' },
  title: { type: 'string', description: 'Short panel title' },
  kind: { type: 'string', enum: KINDS, description: 'compose: a panel you design yourself from layers (see layers, layout); stat: one number; timeseries: number + trend; graph: a detailed trend with up to five series, axes and legend (use listLabel to name series); list: one row per series; bargauge: one gauge per series against a scale with warn/crit marks (set max for a known ceiling such as 100 for %); table: rows of label columns plus the value (set columns); state: a state timeline, one band per series coloured by state over the window (set states for named values, e.g. 1 up / 0 down); heatmap: a distribution over time, the buckets of a Prometheus histogram (sum by (le) (rate(x_bucket[5m]))) or one row per series; flow: a data-flow diagram of the system, services as boxes and calls as arrows with request rate and error %, faults highlighted; live from the trace service graph (set services to centre it, e.g. ["checkout-api"]; with none it centres on the failing part), or draw your own with nodes and edges; trace: one request as a waterfall of its spans (set service, optionally through or failing, or traceId; no query), failing spans lit, critical path marked; histogram: a distribution as bars (a Prometheus histogram such as sum by (le) (rate(x_bucket[5m])), headline p95; or many series binned by value, headline max); logs: matching log lines (query is LogQL); note: a few words of text you write; events: a timeline you write' },
  query: { type: 'string', description: 'PromQL (every kind except logs, note, events and trace) or LogQL (logs). Not used by note, events or trace.' },
  unit: { type: 'string', description: 'Unit, e.g. %, ms, req/s, pods, conns' },
  warn: { type: 'number', description: 'Value at or above which the panel shows WARNING (drawn as a line on timeseries)' },
  crit: { type: 'number', description: 'Value at or above which the panel shows CRITICAL (drawn as a line on timeseries)' },
  columns: { type: 'array', items: { type: 'string' }, description: 'table: up to three label names to show as columns, e.g. ["k8s_namespace_name", "k8s_deployment_name"]' },
  states: { type: 'array', items: { type: 'object', properties: { value: { type: 'number' }, name: { type: 'string' }, status: { type: 'string', enum: ['ok', 'warn', 'crit'] } } },
    description: 'state: names and health for values, e.g. [{value:1,name:"up",status:"ok"},{value:0,name:"down",status:"crit"}]; without it, warn/crit decide' },
  alert_uid: { type: 'string', description: 'timeline: the alert to tell the story of (its signal and everything that happened around it)' },
  incident: { type: 'string', description: 'timeline: an incident ref, e.g. INC-0007, whose story to tell' },
  cluster: { type: 'string', description: 'timeline: the cluster whose changes to show, when no alert or incident names it' },
  service: { type: 'string', description: 'trace: the service whose trace to show (name or part of one)' },
  through: { type: 'string', description: 'trace: only a trace that also visits this service' },
  failing: { type: 'boolean', description: 'trace: a failing trace instead of the slowest' },
  traceId: { type: 'string', description: 'trace: a specific trace id (from find_traces)' },
  services: { type: 'array', items: { type: 'string' }, description: 'flow: service names (or parts of names) to centre the live diagram on; their neighbours are included' },
  nodes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, query: { type: 'string' }, unit: { type: 'string' }, warn: { type: 'number' }, crit: { type: 'number' }, status: { type: 'string', enum: ['ok', 'warn', 'crit'] } } },
    description: 'flow, manual: up to 12 boxes, each optionally with a PromQL query for the number shown in it' },
  edges: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, query: { type: 'string' }, unit: { type: 'string' }, warn: { type: 'number' }, crit: { type: 'number' }, status: { type: 'string', enum: ['ok', 'warn', 'crit'] } } },
    description: 'flow, manual: arrows between node ids, each optionally with a PromQL query for its number' },
  max: { type: 'number', description: 'bargauge: the full-scale value (e.g. 100 for %); default a little above the largest value or threshold' },
  listLabel: { type: 'string', description: 'list, graph, state, heatmap, bargauge: the label to show for each series, e.g. k8s_deployment_name' },
  since: { type: 'string', description: 'timeseries, graph: ISO time to mark on the trend, e.g. when the alert started' },
  window: { type: 'number', description: 'timeseries, graph, state, heatmap: minutes of history to draw (default 30; stories default 60)' },
  text: { type: 'string', description: 'note: the text, at most about 20 words' },
  layout: { type: 'string', enum: ['time', 'bars', 'scatter', 'story'], description: 'compose: time (a time axis, default), bars (one row per series, one bar per layer: compare now with then, or A with B), scatter (layer 1 on x, layer 2 on y, one point per series joined on "by"), story (a card telling a data story in stacked elements: see elements)' },
  elements: { type: 'array', maxItems: 4, description: 'compose, story: the card\'s elements, top to bottom. trend: a time chart with the fields of a time layout (layers, events, refs, spans, callouts, headline, window); trace: one request as a waterfall (service, through, failing, or traceId); logs: matching lines (query: LogQL); stat: one number (query, unit, warn, crit); note: a few words (text). Each has a short title.',
    items: { type: 'object', properties: { type: { type: 'string', enum: ['trend', 'trace', 'logs', 'stat', 'note'] }, title: { type: 'string' },
      layers: { type: 'array', items: { type: 'object' } }, events: { type: 'array', items: { type: 'object' } }, refs: { type: 'array', items: { type: 'object' } },
      callouts: { type: 'array', items: { type: 'object' } }, headline: { type: 'object' }, window: { type: 'number' },
      service: { type: 'string' }, through: { type: 'string' }, failing: { type: 'boolean' }, traceId: { type: 'string' },
      query: { type: 'string' }, unit: { type: 'string' }, warn: { type: 'number' }, crit: { type: 'number' }, text: { type: 'string' } }, required: ['type'] } },
  layers: { type: 'array', maxItems: 5, description: 'compose: the data, as layers drawn over each other',
    items: { type: 'object', properties: {
      query: { type: 'string', description: 'PromQL' },
      label: { type: 'string', description: 'What this layer is, e.g. "today", "yesterday", "p95"' },
      unit: { type: 'string', description: 'This layer\'s unit when it differs from the panel\'s (e.g. req/s against ms)' },
      axis: { type: 'string', enum: ['left', 'right'], description: 'time: right gives this layer its own scale on the right, for a metric in other units or of a very different size (req/s beside ms, dBm beside degrees), with its unit; left (default) shares the panel\'s scale' },
      by: { type: 'string', description: 'The label that names each series, e.g. k8s_deployment_name' },
      shift: { type: 'number', description: 'Minutes into the past, laid over the present: 1440 = this time yesterday, 10080 = last week' },
      style: { type: 'string', enum: ['line', 'dotted', 'faint', 'area', 'step', 'bars', 'points', 'solid', 'outline'], description: 'time: line, dotted, faint (a ghost for comparison), area, step, bars, points; bars layout: solid, outline, faint' },
      hero: { type: 'boolean', description: 'The layer the eye should go to (brightest; the headline comes from it). Default the first.' },
      limit: { type: 'number', description: 'Most series to keep from this layer (default 4)' } }, required: ['query'] } },
  headline: { type: 'object', description: 'compose: the big number. show: last (default), max, min, avg, change (the hero now against another layer, in %), none',
    properties: { show: { type: 'string', enum: ['last', 'max', 'min', 'avg', 'change', 'none'] }, layer: { type: 'number' }, against: { type: 'number' } } },
  refs: { type: 'array', maxItems: 4, description: 'compose: horizontal reference lines, e.g. an SLO', items: { type: 'object', properties: { value: { type: 'number' }, label: { type: 'string' }, tone: { type: 'string', enum: ['warn', 'crit', 'plain'] } } } },
  spans: { type: 'array', maxItems: 4, description: 'compose, time: shaded time ranges, e.g. an outage or a deploy window; times ISO or relative like "-90m", "now"',
    items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, tone: { type: 'string', enum: ['warn', 'crit', 'plain'] } } } },
  events: { type: 'array', maxItems: 4, description: 'compose, time: other signals marked on the hero line at their times, each showing how much the line moved right after (what preceded a rise): logs (query: LogQL), traces (service, failing or min_ms: failing or slow traces; a click opens one), profiles (service; once a profiling backend is connected)',
    items: { type: 'object', properties: { source: { type: 'string', enum: ['logs', 'traces', 'profiles'] }, query: { type: 'string', description: 'logs: LogQL' },
      service: { type: 'string', description: 'traces, profiles: the service' }, failing: { type: 'boolean' }, min_ms: { type: 'number', description: 'traces: only traces slower than this' },
      label: { type: 'string', description: 'A short prefix for each marker, e.g. "tool error"' }, limit: { type: 'number', description: 'Most markers from this source (default 8)' } } } },
  callouts: { type: 'array', maxItems: 4, description: 'compose, time: a few words pinned to a layer\'s line at a time ("peak", "deploy"); at is ISO or relative',
    items: { type: 'object', properties: { at: { type: 'string' }, text: { type: 'string' }, layer: { type: 'number' } } } },
  y: { type: 'object', description: 'compose: fix the value axis, e.g. {min: 0}', properties: { min: { type: 'number' }, max: { type: 'number' } } },
  caption: { type: 'string', description: 'compose: one short line under the plot saying what to notice' },
  events: { type: 'array', items: { type: 'object', properties: { time: { type: 'string' }, label: { type: 'string' } } }, description: 'events: up to 8 [time, label] entries, oldest first' },
  status: { type: 'string', enum: ['ok', 'warn', 'crit'], description: 'note, events and logs only: the health this panel should show' },
};
const PANEL_SCHEMA = { type: 'object', properties: PANEL_PROPS, required: ['code', 'title', 'kind'] };
const STORY_PANEL_SCHEMA = {
  type: 'object',
  properties: { ...PANEL_PROPS, narration: { type: 'string', description: 'One short spoken sentence (about 15 words) about this panel, said while the monitors zoom to it' } },
  required: ['code', 'title', 'kind', 'narration'],
};

export function tools() {
  if (!available()) return [];
  return [
    { name: 'show_cluster_health',
      description: 'Put a live six-panel health board for a Kubernetes cluster on the monitors (errors, latency, traffic, crash-looping pods, restarts, nodes) and get its current values. Use this whenever someone asks how a cluster is doing or wants to see its health.',
      inputSchema: { type: 'object', properties: { cluster: { type: 'string', description: 'Cluster name, e.g. retail-prod-cluster' } }, required: ['cluster'] } },
    { name: 'show_panels',
      description: 'Put a custom live board of up to six panels on the monitors, one PromQL query each, and get the current values. Use when asked to show or display specific metrics that show_cluster_health does not cover. Panels whose query returns nothing are dropped.',
      inputSchema: { type: 'object', properties: { title: { type: 'string' }, panels: { type: 'array', items: PANEL_SCHEMA, maxItems: MAX_PANELS } }, required: ['title', 'panels'] } },
    { name: 'show_story',
      description: 'Tell the story of an alert or incident on the monitors: up to six panels in narrative order (what is happening, impact, blast radius, what changed, evidence, next step), each with a short narration. The narrations are then spoken automatically as a guided tour while every monitor zooms to each panel in turn. Investigate with your other tools first so every panel rests on evidence.',
      inputSchema: { type: 'object', properties: {
        title: { type: 'string', description: 'Short story title, e.g. "Checkout errors · retail"' },
        window: { type: 'number', description: 'Minutes of history for trend panels (default 60)' },
        panels: { type: 'array', items: STORY_PANEL_SCHEMA, maxItems: MAX_PANELS } }, required: ['title', 'panels'] } },
    ...(traces.available() ? [{ name: 'show_trace',
      description: 'Put one trace (a single request, from Jaeger) on the monitors as a waterfall: every span as a bar, nested by caller, failing spans lit and the critical path marked. It joins the board that is showing (e.g. next to a flow diagram), or opens its own. By default the slowest recent trace through the service; failing for a failing one; traceId for one from find_traces.',
      inputSchema: { type: 'object', properties: {
        service: { type: 'string', description: 'Service name or part of one, e.g. "checkout-api"' },
        through: { type: 'string', description: 'Only a trace that also visits this service (for a call from service to through)' },
        failing: { type: 'boolean' }, traceId: { type: 'string' } } } }] : []),
    { name: 'design_panel',
      description: 'Design one panel for the question in front of you and put it on the monitors. With the code of a panel that is showing (e.g. VIT), it is redesigned in place and the rest of the board stays; with a new code it joins the board. Use kind compose to lay data over each other: today over yesterday (shift 1440), a service against its neighbours, p50 under p95, traffic with errors, an SLO line, a shaded outage. Any other kind works too.',
      inputSchema: { type: 'object', properties: { panel: PANEL_SCHEMA }, required: ['panel'] } },
    { name: 'clear_panels',
      description: 'Remove the live board from the monitors and return to the ship systems display.',
      inputSchema: { type: 'object', properties: {} } },
  ];
}

export const has = name => ['show_cluster_health', 'show_panels', 'show_story', 'show_trace', 'design_panel', 'clear_panels'].includes(name);

export function describe(name, args = {}) {
  if (name === 'show_cluster_health') return `Assembling the health board for ${args.cluster ?? 'the cluster'}`;
  if (name === 'show_panels') return `Assembling a board: ${args.title ?? 'custom panels'}`;
  if (name === 'show_story') return `Composing the story: ${args.title ?? 'the incident'}`;
  if (name === 'design_panel') return `Designing a panel: ${args.panel?.title ?? args.panel?.code ?? ''}`;
  if (name === 'show_trace') return `Fetching a ${args.failing ? 'failing ' : args.traceId ? '' : 'slow '}trace${args.service ? ` for ${args.service}` : ''}`;
  return 'Clearing the monitors';
}

// ctx: { room, send(msg) }. Always resolves to text for the model.
export async function call(name, args = {}, ctx) {
  try {
    if (name === 'clear_panels') return stop(ctx.room, ctx.send) ? 'The board has been cleared.' : 'No board was showing.';
    if (name === 'show_cluster_health') {
      if (!args.cluster) return 'Error: which cluster?';
      const board = await start(ctx.room, clusterHealth(args.cluster), ctx.send);
      if (board.panels.every(p => p.status === 'nodata')) {
        stop(ctx.room, ctx.send);
        return `No data for cluster "${args.cluster}". Check the exact name with list_prometheus_label_values (labelName "cluster").`;
      }
      return summary(board);
    }
    if (name === 'show_story') {
      const { kept, dropped } = await validate(args.panels ?? []);
      if (!kept.length) return `None of the story panels could be shown (${dropped.join(', ')}). Check queries with your other tools and try again.`;
      const spec = { title: args.title || 'Incident', story: true, window: args.window ?? 60, panels: kept };
      const board = await start(ctx.room, spec, ctx.send);
      tours.set(ctx.room, kept.filter(p => p.narration).map(p => ({ code: p.code, text: String(p.narration) })));
      return summary(board, dropped).replace(/\nGive the person.*$/s, '') +
        '\nThe panel narrations will now be spoken automatically as a guided tour while the monitors zoom to each panel. ' +
        'Do not repeat them. Close with a few words only, e.g. "That is the picture."';
    }
    if (name === 'show_trace') {
      if (!args.service && !args.traceId) return 'Error: which service (or trace id)?';
      const id = await traces.pick(args);
      if (!id) return `No ${args.failing ? 'failing ' : ''}trace found for ${args.service ?? args.traceId}${args.through ? ` through ${args.through}` : ''} recently. find_traces can check what exists.`;
      const panel = { code: 'TRC', kind: 'trace', title: `${args.failing ? 'Failing' : args.traceId ? 'Trace' : 'Slowest'} trace · ${args.service ?? id.slice(0, 8)}${args.through ? ` → ${args.through}` : ''}`,
        service: args.service, through: args.through, failing: !!args.failing, traceId: id };
      const board = await addPanel(ctx.room, panel, ctx.send, panel.title);
      const p = board.panels.find(x => x.code === 'TRC');
      return `The trace is on the monitors as panel TRC${board.panels.length > 1 ? ` on "${board.title}"` : ''}: ${panelLine(p)}\nTell the person in a sentence or two where the time goes (the critical path) and which span fails, with its error if it has one. Say only what the spans show: a failing span does not by itself mean the request never completed.`;
    }
    if (name === 'design_panel') {
      const { kept, dropped } = await validate([args.panel ?? {}]);
      if (!kept.length) return `The panel ${dropped.join(', ')} has no data for any of its queries, so nothing changed. Check the queries and try again.`;
      const panel = kept[0];
      const board = await addPanel(ctx.room, panel, ctx.send, panel.title);
      const p = board.panels.find(x => x.code === panel.code);
      return `Panel ${panel.code} is on the monitors${board.panels.length > 1 ? ` on "${board.title}"` : ''}: ${panelLine(p)}\nSay in a sentence what it shows; mention what the layering reveals (the gap between now and then, which line stands out).`;
    }
    if (name === 'show_panels') {
      const { kept, dropped } = await validate(args.panels ?? []);
      if (!kept.length) return `None of the panels returned data (${dropped.join(', ')}); nothing was shown. Check metric names with list_prometheus_metric_names.`;
      const board = await start(ctx.room, { title: args.title || 'Custom board', panels: kept }, ctx.send);
      return summary(board, dropped);
    }
    return `Error: unknown board tool ${name}.`;
  } catch (err) {
    return `Error: the board could not be shown (${err.message}).`;
  }
}

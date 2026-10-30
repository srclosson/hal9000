// Composed panels (kind "compose"): panels the 9000 designs itself, for the question in front of it, out of a small
// visual grammar that the monitors draw in the 9000's own design language. The model never writes code for the
// screen: it writes a description (layers of data, how each is drawn, reference lines, shaded spans, callouts), this
// module fetches the data, and displays.js draws it. Anything it can describe is safe to draw, and every panel looks
// like it belongs on the ship.
//
//   layout "time" (default)  a time axis; each layer is a PromQL range query, one or more series
//   layout "bars"            one row per series (split by `by`), one bar per layer: compare now with then, A with B
//   layout "scatter"         layer 1 on x, layer 2 on y, one point per series joined on `by`: how two things relate
//   layout "story"           a card that tells a data story in up to four stacked elements (top to bottom), each drawn
//                            by the same code as a full panel, so one card can hold the trend, the trace behind its
//                            spike, the log lines, and the number that matters:
//     elements: [{ type, title, ... }]
//       trend     a time chart: the fields of a time layout (layers, events, refs, spans, callouts, headline, window)
//       trace     one request as a waterfall: service (+ through, failing) or traceId
//       logs      the latest matching lines: query (LogQL)
//       stat      one number with its health: query (PromQL), unit, warn, crit
//       note      a few words: text
//
// layers: [{ query, label, by, shift, style, hero, limit, over, unit, axis }]
//   by     the label that names each series (e.g. k8s_deployment_name); without it a layer is named by its label
//   shift  minutes into the past: the layer is the same query that long ago, laid over the present
//          (1440 = this time yesterday, 10080 = last week)
//   style  time: line, dotted, faint, area, step, bars, points; bars: solid, outline, faint
//   hero   the layer the eye goes to (brightest; the headline comes from it). Default the first.
//   over   time layouts draw ~240 points; each point is the max (default), avg or min over its step, so a short spike
//          between two points is never lost; "last" samples the raw value instead.
//   axis   time: "right" puts the layer on its own scale at the right (a metric in other units, e.g. dBm beside
//          degrees, or req/s beside ms), so neither line is flattened by the other's range
// headline: { show: last | max | min | avg | change | none, layer, against }   change: hero now against another layer
// refs: [{ value, label, tone: warn | crit | plain }]        horizontal lines (warn/crit on the panel are refs too)
// spans: [{ from, to, label, tone }]                        shaded time ranges; times ISO or relative ("-90m", "now")
// callouts: [{ at, text, layer }]                           a few words pinned to a layer's line at a time
// events: [{ source, query, service, failing, min_ms, label, limit }]
//                                                           other signals on the same time axis: each becomes a marker
//                                                           on the hero line at its time, labelled, with how much the
//                                                           line moved in the minutes after it (what came before a rise):
//          source "logs" (default)   query: LogQL; each matching line
//          source "traces"           service (+ failing, or min_ms): its failing or slow traces; a click opens one
//          source "profiles"         service: CPU/memory profile changes, once a profiling backend (Pyroscope) is
//                                    connected (h.sources.profiles); until then the panel says it has none
// Every time panel also reports its context: the peak and when, the typical level (median), and how many spikes there
// were and how long they lasted, so a single spike reads as a spike.
// y: { min, max }   caption: a line of text under the plot

const MAX_LAYERS = 5, MAX_SERIES = 8, MAX_NOTES = 4, MAX_EVENTS = 16, POINTS = 240;
const ELEMENT_KINDS = { trend: 'compose', trace: 'trace', logs: 'logs', stat: 'stat', note: 'note' };
const WEIGHT = { trend: 3, trace: 3, logs: 2, stat: 1, note: 1 };
export const STYLES = { story: [], time: ['line', 'dotted', 'faint', 'area', 'step', 'bars', 'points'], bars: ['solid', 'outline', 'faint'], scatter: ['points'] };

// "-90m", "-2h", "-1d", "now" or an ISO time -> ms.
export function when(s, now = Date.now()) {
  if (s === undefined || s === null || s === '') return NaN;
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^(?:now)?\s*-\s*(\d+(?:\.\d+)?)\s*([smhd])$/i);
  if (m) return now - parseFloat(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  if (/^now$/i.test(String(s).trim())) return now;
  return Date.parse(s);
}

const shiftWords = min => !min ? '' : min % 10080 === 0 ? (min === 10080 ? 'last week' : `${min / 10080} weeks ago`)
  : min % 1440 === 0 ? (min === 1440 ? 'yesterday' : `${min / 1440} days ago`) : min % 60 === 0 ? `${min / 60} h ago` : `${min} min ago`;

// The layers as the model gave them, cleaned: at most five, each with a query, a style the layout knows, a name.
export function layersOf(p) {
  const layout = STYLES[p.layout] ? p.layout : 'time';
  const raw = (Array.isArray(p.layers) && p.layers.length ? p.layers : p.query ? [{ query: p.query, by: p.listLabel }] : []).slice(0, MAX_LAYERS);
  const list = raw.filter(l => l && l.query).map((l, i) => ({
    query: String(l.query), by: l.by ?? p.listLabel, shift: Math.max(0, Math.round(Number(l.shift) || 0)),
    style: STYLES[layout].includes(l.style) ? l.style : (Number(l.shift) > 0 ? (layout === 'time' ? 'faint' : 'outline') : STYLES[layout][0]),
    label: String(l.label ?? '').slice(0, 40), hero: !!l.hero, limit: Math.min(MAX_SERIES, Math.max(1, Number(l.limit) || 4)),
    unit: l.unit ?? (layout === 'scatter' ? '' : p.unit ?? ''), index: i, over: ['max', 'avg', 'min', 'last'].includes(l.over) ? l.over : 'max',
    axis: layout === 'time' && l.axis === 'right' ? 'right' : 'left',
    ...(layout === 'time' && l.axis === 'right' && { unit: l.unit ?? '' }),   // its own scale: never the panel's unit
  }));
  if (list.length && !list.some(l => l.hero)) list[0].hero = true;
  return { layout, layers: list };
}

// h: { prom, fmt, status, seriesLabel, marksFor } from boards/index.js.
export async function readCompose(out, p, spec, h) {
  if (p.layout === 'story') return readStory(out, p, spec, h);
  const { layout, layers } = layersOf(p);
  const none = { ...out, layout, status: 'nodata', display: '—' };
  if (!layers.length) return none;
  const minutes = Math.min(7 * 1440, p.window ?? spec.window ?? 60), now = Date.now();
  const common = { layout, window: minutes, caption: p.caption ? String(p.caption).slice(0, 100) : '', y: p.y ?? null };
  const name = (l, metric, many) => {
    const own = h.seriesLabel(metric, l.by);
    const base = many ? (l.label ? `${own} · ${l.label}` : own) : (l.label || own);
    return l.shift && !l.label ? `${base} · ${shiftWords(l.shift)}` : base;
  };

  if (layout === 'time') {
    // About 240 points, each the max (or avg/min) over its step: a 30-second spike in an hour still shows.
    const step = Math.max(15, Math.round(minutes * 60 / POINTS));
    const sampled = l => (l.over === 'last' ? l.query : /^[a-zA-Z_:][\w:]*(\{[^{}]*\})?$/.test(l.query.trim())
      ? `${l.over}_over_time(${l.query.trim()}[${step}s])` : `${l.over}_over_time((${l.query})[${step}s:15s])`);
    const fetched = await Promise.all(layers.map(async l => [l, (await h.prom(sampled(l), true, minutes, l.shift, step).catch(() => null) ?? []).map(s => ({ metric: s.metric ?? {},
      key: h.seriesLabel(s.metric, l.by),
      points: (s.values ?? []).map(([t, v]) => [Math.round(t * 1000) + l.shift * 60_000, +parseFloat(v).toPrecision(4)]).filter(([, v]) => Number.isFinite(v)) }))
      .filter(s => s.points.length).sort((a, b) => b.points.at(-1)[1] - a.points.at(-1)[1])]));
    // The hero layer picks which series are shown; the other layers show the same ones where they have them
    // (yesterday's telem-api under today's telem-api), so comparisons line up.
    fetched.sort(([a], [b]) => b.hero - a.hero);
    const [heroLayer, heroSeries] = fetched[0];
    const keys = heroSeries.slice(0, heroLayer.limit).map(s => s.key);
    const series = [];
    for (const [l, got] of fetched) {
      const matched = l === heroLayer ? got.slice(0, l.limit) : got.filter(s => keys.includes(s.key)).sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
      const chosen = (matched.length ? matched : got).slice(0, l.limit);
      chosen.forEach((s, k) => series.push({ layer: l.index, key: s.key, label: name(l, s.metric, chosen.length > 1), style: l.style, hero: l.hero && k === 0, shift: l.shift,
        ...(l.axis === 'right' && { axis: 'right', unit: l.unit }),
        points: s.points, last: s.points.at(-1)[1], display: h.fmt(s.points.at(-1)[1], l.unit) }));
    }
    series.sort((a, b) => a.layer - b.layer);
    if (!series.length) return none;
    const shown = series.slice(0, MAX_SERIES);
    const hero = shown.find(s => s.hero) ?? shown[0];
    const t0 = now - minutes * 60_000;
    const head = headline(p.headline, shown, hero, h, p.unit);
    const refs = [...(p.refs ?? []), ...(Number.isFinite(p.warn) ? [{ value: p.warn, label: 'WARN', tone: 'warn' }] : []), ...(Number.isFinite(p.crit) ? [{ value: p.crit, label: 'CRIT', tone: 'crit' }] : [])]
      .filter(r => Number.isFinite(Number(r.value))).slice(0, 4).map(r => ({ value: Number(r.value), label: String(r.label ?? '').slice(0, 24), tone: ['warn', 'crit'].includes(r.tone) ? r.tone : 'plain' }));
    const spans = (p.spans ?? []).slice(0, MAX_NOTES).map(s => ({ t0: Math.max(t0, when(s.from, now)), t1: Math.min(now, when(s.to ?? 'now', now)), label: String(s.label ?? '').slice(0, 30),
      tone: ['warn', 'crit'].includes(s.tone) ? s.tone : 'plain' })).filter(s => s.t1 > s.t0);
    const callouts = (p.callouts ?? []).slice(0, MAX_NOTES).map(c => {
      const t = when(c.at, now), s = shown.find(x => x.layer === (Number(c.layer) || 0)) ?? hero;
      const near = s.points.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a), s.points[0]);
      return { t: near[0], v: near[1], text: String(c.text ?? '').slice(0, 40), ...(s.axis && { axis: s.axis }) };
    }).filter(c => c.text && c.t >= t0);
    const marks = await h.marksFor(hero.points.length ? layers.find(l => l.index === hero.layer).query : '', minutes, hero.points, p).catch(() => []);
    const context = contextOf(hero.points, step, p.unit, h);
    // Other signals on the hero line: where each sits on the trend, and how far the line moved in the minutes after it.
    const unavailable = new Set();
    const lines = (await Promise.all((p.events ?? []).slice(0, 4).map(async e => {
      const source = ['logs', 'traces', 'profiles'].includes(e?.source) ? e.source : 'logs', read = h.sources?.[source];
      if (!read) { unavailable.add(source); return []; }
      return ((await read(e, minutes, Math.min(MAX_EVENTS, Number(e.limit) || 8)).catch(() => null)) ?? []).map(x => ({ ...x, source, label: e.label }));
    }))).flat();
    const span = (hero.points.length ? Math.max(...hero.points.map(q => q[1])) - Math.min(...hero.points.map(q => q[1])) : 0) || 1;
    const after = Math.max(2 * step * 1000, minutes * 60_000 / 20);
    const events = lines.filter(e => e.time >= t0).sort((a, b) => a.time - b.time).slice(-MAX_EVENTS).map(e => {
      const v = valueAt(hero.points, e.time), next = hero.points.filter(([t]) => t > e.time && t <= e.time + after).map(q => q[1]);
      const rise = next.length && Number.isFinite(v) ? Math.max(...next) - v : 0;
      const text = `${e.label ? `${e.label}: ` : ''}${String(e.text).replace(/\s+/g, ' ').replace(/^(TOOL|TURN) /, '')}`.slice(0, 400);   // whole: the monitors shorten labels and show them in full on hover
      return { t: e.time, v, text, source: e.source, ...(e.traceId && { traceId: e.traceId }), ...(hero.axis && { axis: hero.axis }), kind: e.level === 'error' || /error|fail/i.test(e.text) ? 'error' : 'event',
        rise: Math.abs(rise) >= span * .15 ? +rise.toPrecision(2) : 0, riseDisplay: Math.abs(rise) >= span * .15 ? `${rise > 0 ? '↑' : '↓'}${h.fmt(Math.abs(rise), p.unit)}` : '' };
    });
    return { ...out, ...common, t0, t1: now, step, series: shown, refs, spans, callouts, events, marks, context, ...head, ...(unavailable.size && { unavailable: [...unavailable] }),
      status: Number.isFinite(p.crit) || Number.isFinite(p.warn) ? h.status(hero.last, p) : 'ok' };
  }

  // bars and scatter: one value per series per layer, at now (or now minus the layer's shift).
  const per = await Promise.all(layers.map(async l => {
    const r = await h.prom(l.query, false, 0, l.shift).catch(() => null);
    return (r ?? []).map(s => ({ key: h.seriesLabel(s.metric, l.by), v: parseFloat(s.value?.[1]) })).filter(x => Number.isFinite(x.v));
  }));
  if (!per.some(x => x.length)) return none;

  if (layout === 'scatter') {
    const [xs, ys] = per, [lx, ly] = layers;
    if (!lx || !ly) return none;
    const yOf = new Map((ys ?? []).map(x => [x.key, x.v]));
    const points = (xs ?? []).filter(x => yOf.has(x.key)).slice(0, 24).map(x => ({ label: x.key, x: x.v, y: yOf.get(x.key) }));
    if (!points.length) return none;
    const top = [...points].sort((a, b) => b.y - a.y)[0];
    // No headline: the picture is the point. Units are the layers' own (the panel's unit fits at most one axis).
    return { ...out, ...common, unit: '', points, x: { label: lx.label || 'x', unit: lx.unit }, yAxis: { label: ly.label || 'y', unit: ly.unit },
      display: '', value: points.length, top: top.label, status: 'ok' };
  }

  // bars: rows ordered by the hero layer, worst first.
  const hi = layers.findIndex(l => l.hero);
  const keys = [...new Set([...(per[hi] ?? []).sort((a, b) => b.v - a.v).map(x => x.key), ...per.flat().map(x => x.key)])].slice(0, MAX_SERIES);
  const rows = keys.map(k => ({ label: k, values: layers.map((l, i) => {
    const v = per[i].find(x => x.key === k)?.v;
    return { layer: i, v: v ?? null, display: h.fmt(v, l.unit), style: l.style, hero: l.hero };
  }) }));
  const bars = layers.map(l => ({ label: l.label || (l.shift ? shiftWords(l.shift) : 'now'), style: l.style, hero: l.hero }));
  const heroTop = rows[0]?.values[hi]?.v;
  return { ...out, ...common, rows, bars, value: heroTop, display: h.fmt(heroTop, layers[hi].unit), stat: 'TOP',
    status: Number.isFinite(p.crit) || Number.isFinite(p.warn) ? h.status(heroTop, p) : 'ok' };
}

// A story card: its elements read as panels of their own (h.readPanel), stacked by weight.
async function readStory(out, p, spec, h) {
  const els = (Array.isArray(p.elements) ? p.elements : []).filter(e => ELEMENT_KINDS[e?.type]).slice(0, 4);
  const read = await Promise.all(els.map(async (e, i) => {
    const kind = ELEMENT_KINDS[e.type];
    const panel = { ...e, code: `${out.code}${i}`, title: e.title ?? e.type, kind, ...(e.type === 'trend' && { layout: 'time' }) };
    if (e.type === 'trace') { panel.traceId = await h.pickTrace?.(e).catch(() => null); if (!panel.traceId) return { type: e.type, title: panel.title, weight: WEIGHT[e.type], data: { ...panel, status: 'nodata', display: '—' } }; }
    const data = await h.readPanel(panel, { ...spec, window: e.window ?? p.window ?? spec.window }).catch(err => ({ ...panel, status: 'nodata', display: '—', error: err.message }));
    return { type: e.type, title: panel.title, weight: WEIGHT[e.type], data };
  }));
  if (!read.length) return { ...out, layout: 'story', status: 'nodata', display: '—' };
  const order = { nodata: 0, ok: 1, warn: 2, crit: 3 }, worst = read.map(r => r.data.status ?? 'ok').reduce((a, b) => (order[b] > order[a] ? b : a), 'ok');
  return { ...out, layout: 'story', elements: read, caption: p.caption ? String(p.caption).slice(0, 100) : '', display: '', status: worst };
}

// The value of a line at a time (linear between points; null outside it).
function valueAt(points, t) {
  if (!points.length || t < points[0][0] || t > points.at(-1)[0]) return points.length ? points.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a))[1] : null;
  const i = points.findIndex(([x]) => x >= t);
  if (i <= 0) return points[0][1];
  const [ta, va] = points[i - 1], [tb, vb] = points[i];
  return va + ((t - ta) / (tb - ta || 1)) * (vb - va);
}

// What a trend says beyond its last value: peak and when, the typical level, and the spikes (runs well above typical:
// how many, how long), so "0.15" can be read as one brief spike over a flat line rather than a sustained level.
function contextOf(points, step, unit, h) {
  if (points.length < 3) return null;
  const vals = points.map(p => p[1]), sorted = [...vals].sort((a, b) => a - b), q = f => sorted[Math.floor(f * (sorted.length - 1))];
  const median = q(.5), mad = q(.5) === undefined ? 0 : [...vals.map(v => Math.abs(v - median))].sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const [peakT, peak] = points.reduce((a, b) => (b[1] > a[1] ? b : a));
  const bar = median + Math.max(3 * mad, (peak - sorted[0]) * .25, 1e-9);
  const runs = [];
  for (const [t, v] of points) {
    const last = runs.at(-1);
    if (v > bar) { if (last && t - last.end <= step * 1000 * 1.5) last.end = t; else runs.push({ start: t, end: t }); }
  }
  const longest = runs.length ? Math.max(...runs.map(r => r.end - r.start + step * 1000)) / 1000 : 0;
  const dur = s => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
  const clock = t => new Date(t).toISOString().slice(11, 16) + 'Z';
  const flat = peak - sorted[0] < 1e-9;
  const words = flat ? `flat at ${h.fmt(median, unit)}`
    : runs.length && runs.length <= 6 ? `peak ${h.fmt(peak, unit)} at ${clock(peakT)} · typical ${h.fmt(median, unit)} · ${runs.length} spike${runs.length > 1 ? 's' : ''}, longest ${dur(longest)}`
    : `peak ${h.fmt(peak, unit)} at ${clock(peakT)} · typical ${h.fmt(median, unit)} · p95 ${h.fmt(q(.95), unit)}`;
  return { peak, peakAt: peakT, typical: median, p95: q(.95), spikes: runs.length, longestSeconds: Math.round(longest), words };
}

function headline(spec = {}, series, hero, h, unit) {
  const show = spec.show ?? 'last';
  if (show === 'none') return { display: '', stat: '', value: hero.last };
  const s = series.find(x => x.layer === Number(spec.layer)) ?? hero;
  const vals = s.points.map(p => p[1]);
  if (show === 'change') {
    const other = series.find(x => x.layer === Number(spec.against)) ?? series.find(x => x !== s && x.shift) ?? series.find(x => x !== s);
    if (!other) return { display: h.fmt(s.last, unit), stat: '', value: s.last };
    const t = s.points.at(-1)[0];
    const then = other.points.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a))[1];
    const pct = then ? ((s.last - then) / Math.abs(then)) * 100 : NaN;
    const display = Number.isFinite(pct) ? `${pct >= 0 ? '+' : '−'}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%` : h.fmt(s.last - then, unit);
    return { display, stat: `VS ${(other.label.split(' · ').at(-1) || 'THEN').toUpperCase()}`, value: s.last, change: { now: s.last, then, pct } };
  }
  const v = show === 'max' ? Math.max(...vals) : show === 'min' ? Math.min(...vals) : show === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : s.last;
  return { display: h.fmt(v, unit), stat: show === 'last' ? '' : show.toUpperCase(), value: v };
}

// The panel in words, for the model: what each layer shows now. line(panel) describes an element (boards' panelLine).
export function describeCompose(p, line = () => '') {
  if (p.layout === 'story') return ` (story card: ${p.elements.map((e, i) => `${i + 1}. ${e.type} "${e.title}": ${line(e.data).replace(/^\S+ /, '')}`).join(' | ')})`;
  if (p.layout === 'scatter') return ` (${p.points.length} series, ${p.x.label} against ${p.yAxis.label}: ${p.points.slice(0, 8).map(x => `${x.label} ${+x.x.toPrecision(3)}/${+x.y.toPrecision(3)}`).join(', ')})`;
  if (p.layout === 'bars') return ` (${p.bars.map(b => b.label).join(' vs ')}: ${p.rows.map(r => `${r.label} ${r.values.map(v => v.display).join(' / ')}`).join(', ')})`;
  const change = p.change ? `; change ${p.display} (now ${+p.change.now.toPrecision(3)}, then ${+p.change.then.toPrecision(3)})` : '';
  const ctx = p.context ? `; over ${p.window} min: ${p.context.words}` : '';
  const missing = p.unavailable?.length ? `; not available yet: ${p.unavailable.join(', ')} (no backend connected)` : '';
  const ev = p.events?.length ? `; ${p.events.length} log events marked${p.events.filter(e => e.rise > 0).length ? `, ${p.events.filter(e => e.rise > 0).length} followed by a rise (${p.events.filter(e => e.rise > 0).slice(0, 3).map(e => `${new Date(e.t).toISOString().slice(11, 16)}Z "${e.text.slice(0, 40)}" ${e.riseDisplay}`).join('; ')})` : ', none followed by a rise'}` : '';
  return ` (${p.series.map(s => `${s.label} ${s.display}${s.hero ? ' [hero]' : ''}`).join(', ')}${change}${ctx}${ev}${missing})`;
}

// The canvas's drop rules (spec 2.0, docs/CANVAS.md §6): what dropping something on a zone of an open view does, as
// ops on the view (boards/view.js applies them, with history). One table, shared by the server (which applies a
// drop) and the monitors (which use accepts() to refuse a drop while it hovers, before anything changes).
// Deterministic and instant: no model in the loop. A drop the rules can't do well (splitting HAL's own query) is
// refused with a reason, and the monitor can ask HAL instead.
//
// Zones (phase 2): plot (add a layer), y (add a layer on the left scale), right (add a layer on its own right scale),
// color (split by a label), scope (filter every layer built here; the window), out (remove).
// Items: { type: 'metric', name, kind, cluster? } { type: 'label', name, value? } { type: 'window', minutes }
//        { type: 'layer', id } { type: 'color' } { type: 'filter', index }

export const ZONES = ['plot', 'y', 'right', 'color', 'scope', 'out'];
export const ZONE_WORDS = { plot: 'Add', y: 'Add (left scale)', right: 'Add (own scale, right)', color: 'Split by', scope: 'Only', out: 'Remove' };
const MAX_LAYERS = 5;

// Prometheus conventions: the kind and unit a metric's name declares.
export const kindOf = name => (/_bucket$/.test(name) ? 'histogram' : /_(total|count|sum)$/.test(name) ? 'counter' : 'gauge');
const UNITS = [[/_seconds(_bucket|_sum|_count|_total)?$/, 's'], [/_milliseconds(_bucket|_sum|_count|_total)?$/, 'ms'], [/_bytes(_total)?$/, 'bytes'],
  [/_ratio$/, 'ratio'], [/_percent$/, '%'], [/_degrees$/, 'degrees'], [/_dbm$/, 'dBm'], [/_kpa$/, 'kPa'], [/_amperes$/, 'A'], [/_minutes$/, 'min'], [/_celsius$/, '°C']];
export function unitOf(name) {
  const hit = UNITS.find(([re]) => re.test(name))?.[1] ?? '';
  return kindOf(name) === 'counter' && !/_(sum|count)$/.test(name) ? (hit ? `${hit}/s` : '/s') : hit;
}

const structured = view => (view.layers ?? []).filter(l => l.metric);
const nextId = view => `L${Math.max(0, ...(view.layers ?? []).map(l => Number(String(l.id).slice(1)) || 0)) + 1}`;
const heroOf = view => (view.layers ?? []).find(l => l.hero) ?? view.layers?.[0];
const unitOfLayer = l => l?.unit || (l?.metric ? unitOf(l.metric) : '');

// The equality matchers every layer shares (e.g. cluster="retail"), so a metric added to a cluster's panel stays in
// that cluster. Opaque queries are read for them too (never changed).
export function sharedFilters(view) {
  const sets = (view.layers ?? []).map(l => (l.metric ? (l.filters ?? []).filter(f => f.op === '=')
    : [...String(l.query ?? '').matchAll(/([a-zA-Z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map(m => ({ label: m[1], op: '=', value: m[2] }))));
  if (!sets.length) return [];
  return sets[0].filter(f => !['__name__', 'le', 'code', 'status', 'status_code'].includes(f.label) && sets.every(s => s.some(g => g.label === f.label && g.value === f.value)));
}

// How a metric becomes a layer: a counter is rated and summed, a histogram is its p95, a gauge is drawn as it is
// (averaged when the view is split by a label).
function shaped(name, color) {
  const by = color ? [color] : undefined;
  if (kindOf(name) === 'histogram') return { quantile: 0.95, range: '5m', ...(by && { by }), seriesBy: color };
  if (kindOf(name) === 'counter') return { fn: 'rate', range: '5m', agg: 'sum', ...(by && { by }), seriesBy: color };
  return color ? { agg: 'avg', by, seriesBy: color } : {};
}

// -> { ops, why } to apply, or { refuse: 'reason' }.
export function opsFor(zone, item, view) {
  if (!ZONES.includes(zone)) return { refuse: 'not a drop zone' };
  const layers = view.layers ?? [], color = view.encode?.color ?? null;
  // A panel that isn't composed yet (a plain trend, a stat) becomes one on its first change.
  const compose = view.kind === 'compose' ? [] : [{ op: 'set', path: ['kind'], value: 'compose' }];

  if (item?.type === 'metric') {
    if (!['plot', 'y', 'right'].includes(zone)) return { refuse: zone === 'color' || zone === 'scope' ? 'drop a label here, not a metric' : 'metrics go on the plot' };
    if (view.mark === 'story') return { refuse: 'open one element of a story card' };
    if (layers.length >= MAX_LAYERS) return { refuse: `a view holds at most ${MAX_LAYERS} layers` };
    const filters = item.cluster ? [{ label: 'cluster', op: '=', value: item.cluster }] : sharedFilters(view);
    const unit = unitOf(item.name), heroUnit = unitOfLayer(heroOf(view));
    const axis = zone === 'right' || (zone === 'plot' && layers.length && unit && heroUnit && unit !== heroUnit) ? 'right' : undefined;
    const layer = { id: nextId(view), source: 'metrics', role: 'y', metric: item.name, ...(filters.length && { filters }), ...shaped(item.name, color),
      ...(unit && { unit }), ...(axis && { axis }), label: item.name.replace(/_(total|bucket|count|sum)$/, '') };
    for (const k of Object.keys(layer)) if (layer[k] === undefined) delete layer[k];
    return { ops: [...compose, { op: 'add', path: ['layers', '-'], value: layer }],
      why: `added ${item.name}${axis ? ' on its own scale' : ''}${filters.length ? ` (${filters.map(f => `${f.label} ${f.value}`).join(', ')})` : ''}` };
  }

  if (item?.type === 'label') {
    if (zone === 'color') {
      const own = structured(view);
      if (!own.length) return { refuse: `${view.code ?? 'this panel'}'s lines are HAL's own queries: ask HAL to split them by ${item.name}` };
      const ops = [...compose, { op: 'set', path: ['encode', 'color'], value: item.name }];
      layers.forEach((l, i) => {
        if (!l.metric) return;
        ops.push({ op: 'set', path: ['layers', i, 'by'], value: [item.name] }, { op: 'set', path: ['layers', i, 'seriesBy'], value: item.name });
        if (!l.agg && l.quantile === undefined) ops.push({ op: 'set', path: ['layers', i, 'agg'], value: l.fn ? 'sum' : 'avg' });
      });
      const left = layers.length - own.length;
      return { ops, why: `split by ${item.name}${left ? ` (${left} of HAL's own line${left > 1 ? 's' : ''} unchanged)` : ''}` };
    }
    if (zone === 'scope') {
      if (item.value === undefined) return { refuse: 'pick a value' };
      if (!structured(view).length) return { refuse: 'filters reach only lines built here; HAL\'s queries keep their own' };
      const at = (view.scope?.filters ?? []).findIndex(f => f.label === item.name);
      const f = { label: item.name, op: '=', value: String(item.value) };
      return { ops: [...compose, at >= 0 ? { op: 'set', path: ['scope', 'filters', at], value: f } : { op: 'add', path: ['scope', 'filters', '-'], value: f }],
        why: `only ${item.name} ${item.value}` };
    }
    return { refuse: 'drop a label on Split by or Only' };
  }

  if (item?.type === 'window') {
    if (zone !== 'scope') return { refuse: 'a window goes on Only' };
    return { ops: [{ op: 'set', path: ['scope', 'window'], value: Number(item.minutes) }], why: `window ${item.minutes} min` };
  }

  if (zone === 'out') {
    if (item?.type === 'layer') {
      const i = layers.findIndex(l => l.id === item.id);
      if (i < 0) return { refuse: 'no such line' };
      if (layers.length === 1) return { refuse: 'a view needs one line' };
      const ops = [...compose, { op: 'remove', path: ['layers', i] }];
      if (heroOf(view) === layers[i]) ops.push({ op: 'set', path: ['layers', 0, 'hero'], value: true });   // the first that is left leads
      return { ops, why: `removed ${layers[i].label || layers[i].metric || layers[i].id}` };
    }
    if (item?.type === 'color') {
      if (!color) return { refuse: 'not split' };
      const ops = [{ op: 'remove', path: ['encode', 'color'] }];
      layers.forEach((l, i) => { if (l.metric && l.by) ops.push({ op: 'remove', path: ['layers', i, 'by'] }); if (l.metric && l.seriesBy === color) ops.push({ op: 'remove', path: ['layers', i, 'seriesBy'] }); });
      return { ops, why: `no longer split by ${color}` };
    }
    if (item?.type === 'filter') {
      const f = view.scope?.filters?.[item.index];
      if (!f) return { refuse: 'no such filter' };
      return { ops: [{ op: 'remove', path: ['scope', 'filters', item.index] }], why: `all ${f.label}s again` };
    }
    return { refuse: 'nothing to remove' };
  }
  return { refuse: 'that can\'t go here' };
}

// While dragging: can this zone take it? -> { ok, words } (words: what a drop would do, or why not).
export function accepts(zone, item, view) {
  const r = opsFor(zone, item?.type === 'label' && zone === 'scope' && item.value === undefined ? { ...item, value: '…' } : item, view);
  return r.refuse ? { ok: false, words: r.refuse } : { ok: true, words: `${ZONE_WORDS[zone]}${item?.name ? ` ${item.name}` : ''}` };
}

// Views (spec 2.0, docs/CANVAS.md): the one description behind every panel. HAL writes them, people will reshape them
// by dragging (the canvas), and the monitors draw them. A view is data, never code.
//
//   view = { v: 2, kind, title, scope: { window, filters }, layers: [layer], encode: { x, color, facet }, mark,
//            …the panel's other fields (refs, spans, callouts, events, headline, y, caption, unit, warn, crit…),
//            history: [{ at, by, why, ops, undo }], redo: [same] }
//
//   layer = { id, source: 'metrics', role: 'y' | 'x', unit, axis, style, hero, shift, over, label, seriesBy, limit,
//             // structured (editable by drops; compiled to PromQL here):
//             metric, filters: [{ label, op, value }], fn, range, agg, by: [labels], top, quantile,
//             written (the query as first written: kept, spacing and all, while the fields still compile to it),
//             // or opaque (HAL's freehand PromQL, kept exactly as written):
//             query }
//
// Today's panels are v1 specs: toView lifts one into a view and toPanel lowers a view back into exactly the spec the
// readers (compose.js, index.js) already understand, so nothing drawn changes. A layer is structured only when its
// query recompiles to the very same text; anything else stays opaque and keeps HAL's meaning.
//
// Every change to a view is a diff (ops on paths) with its inverse, so history, undo, redo and replay all come from
// the same list: applyDiff(view, ops, { by, why }), undo(view), redo(view).

export const VERSION = 2;
export const MARKS = ['auto', 'line', 'area', 'step', 'bars', 'points', 'heatmap', 'histogram', 'story'];
const MAX_LAYERS = 5, MAX_HISTORY = 200;
const FNS = ['rate', 'irate', 'increase', 'delta', 'deriv'];
const AGGS = ['sum', 'avg', 'max', 'min', 'count'];
const OPS = ['=', '!=', '=~', '!~'];
// Panel kinds whose data is one PromQL query (a view with one layer), and the mark each draws as.
const QUERY_KINDS = { timeseries: 'line', graph: 'line', stat: 'auto', list: 'bars', bargauge: 'bars', table: 'auto', state: 'step', heatmap: 'heatmap', histogram: 'histogram' };
// v1 layer fields a view models; any others ride along untouched.
const LAYER_FIELDS = ['query', 'label', 'by', 'shift', 'style', 'hero', 'limit', 'over', 'unit', 'axis'];
// v1 panel fields a view models; everything else ride along untouched (refs, spans, events, headline, warn…).
const PANEL_FIELDS = ['v', 'kind', 'layout', 'layers', 'query', 'listLabel', 'window', 'view'];

const clone = x => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// ---- PromQL for structured layers ---------------------------------------------------------------------------------
const quote = v => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const selector = (metric, filters) => `${metric}${filters.length ? `{${filters.map(f => `${f.label}${f.op}${quote(f.value)}`).join(',')}}` : ''}`;

// A structured layer (with the view's scope filters it doesn't already have) as PromQL.
export function compile(layer, scope = {}) {
  if (layer.query) return layer.query;
  if (!layer.metric) throw new Error(`layer ${layer.id ?? '?'} has neither a metric nor a query`);
  const own = layer.filters ?? [], filters = [...(scope.filters ?? []).filter(f => !own.some(o => o.label === f.label)), ...own];
  const by = layer.by ?? [];
  if (layer.quantile !== undefined) {   // a histogram: the quantile of its buckets' rate
    const inner = `sum by (${['le', ...by].join(',')}) (rate(${selector(layer.metric, filters)}[${layer.range ?? '5m'}]))`;
    return wrapTop(`histogram_quantile(${layer.quantile},${inner})`, layer.top);
  }
  let q = selector(layer.metric, filters);
  if (layer.fn) q = `${layer.fn}(${q}[${layer.range ?? '5m'}])`;
  if (layer.agg) q = `${layer.agg}${by.length ? ` by (${by.join(',')})` : ''} (${q})`;
  return wrapTop(q, layer.top);
}
const wrapTop = (q, top) => (top ? `topk(${top},${q})` : q);

// The query as structured fields, or null when it isn't one of the shapes compile() writes. Only accepted when
// compiling the fields gives back the same query (ignoring whitespace), so a parse can never change its meaning.
const NAME = '[a-zA-Z_:][\\w:]*', LABEL = '[a-zA-Z_]\\w*';
const SEL = new RegExp(`^(${NAME})(?:\\{(.*)\\})?$`);
export function parse(query) {
  const text = String(query ?? '').trim();
  const fields = parseShape(text.replace(/\s+/g, ' '));
  if (!fields) return null;
  try { return squash(compile(fields)) === squash(text) ? fields : null; } catch { return null; }
}
const squash = q => q.replace(/\s+/g, '');
function parseShape(q) {
  let top;
  let m = q.match(/^topk\s*\(\s*(\d+)\s*,(.*)\)$/s);
  if (m) { top = Number(m[1]); q = m[2].trim(); }
  m = q.match(/^histogram_quantile\s*\(\s*([0-9.]+)\s*,\s*sum by \(([^)]*)\)\s*\(\s*rate\s*\((.*)\[(\w+)\]\s*\)\s*\)\s*\)$/s);
  if (m) {
    const labels = splitLabels(m[2]), s = parseSelector(m[3].trim());
    if (!s || labels[0] !== 'le') return null;
    return defined({ ...s, quantile: Number(m[1]), range: m[4], by: labels.slice(1), top });
  }
  let agg, by;
  m = q.match(new RegExp(`^(${AGGS.join('|')})(?:\\s+by\\s*\\(([^)]*)\\))?\\s*\\((.*)\\)$`, 's'));
  if (m) { agg = m[1]; by = m[2] !== undefined ? splitLabels(m[2]) : undefined; q = m[3].trim(); }
  let fn, range;
  m = q.match(new RegExp(`^(${FNS.join('|')})\\s*\\((.*)\\[(\\w+)\\]\\s*\\)$`, 's'));
  if (m) { fn = m[1]; q = m[2].trim(); range = m[3]; }
  const s = parseSelector(q);
  if (!s) return null;
  return defined({ ...s, fn, range, agg, by: by?.length ? by : undefined, top });
}
const splitLabels = s => s.split(',').map(x => x.trim()).filter(Boolean);
function parseSelector(text) {
  const m = text.match(SEL);
  if (!m) return null;
  const filters = [];
  let rest = (m[2] ?? '').trim();
  const one = new RegExp(`^(${LABEL})\\s*(=~|!~|!=|=)\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*(,\\s*)?`);
  while (rest) {
    const f = rest.match(one);
    if (!f) return null;
    filters.push({ label: f[1], op: f[2], value: f[3].replace(/\\(.)/g, '$1') });
    rest = rest.slice(f[0].length);
  }
  return { metric: m[1], ...(filters.length && { filters }) };
}

// ---- v1 panel spec <-> view -----------------------------------------------------------------------------------------
function liftLayer(l, i) {
  const extra = Object.fromEntries(Object.entries(l).filter(([k]) => !LAYER_FIELDS.includes(k)));
  const structured = parse(l.query);
  // written: HAL's own wording of a structured query, used as long as the fields still say the same thing.
  return defined({ id: `L${i + 1}`, source: 'metrics', role: 'y', ...(structured ? { ...structured, written: String(l.query) } : { query: String(l.query) }),
    label: l.label, seriesBy: l.by, shift: l.shift, style: l.style, hero: l.hero, limit: l.limit, over: l.over, unit: l.unit, axis: l.axis,
    ...(Object.keys(extra).length && { extra }) });
}
function lowerLayer(l, scope) {
  const q = compile(l, scope);
  return defined({ query: l.written && squash(l.written) === squash(q) ? l.written : q, label: l.label, by: l.seriesBy, shift: l.shift, style: l.style, hero: l.hero,
    limit: l.limit, over: l.over, unit: l.unit, axis: l.axis, ...(l.extra ?? {}) });
}

// Any panel spec (v1, or already a view) -> a view.
export function toView(p) {
  if (!p || typeof p !== 'object') throw new Error('not a panel');
  if (p.v === VERSION) return clone(p);
  const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !PANEL_FIELDS.includes(k)));
  const view = { v: VERSION, kind: p.kind, ...rest, scope: defined({ window: p.window, filters: [] }), layers: [], encode: { x: 'time' }, mark: 'auto', history: [], redo: [] };
  if (p.kind === 'compose') {
    const layout = p.layout ?? 'time';
    view.layout = p.layout;   // v1 shorthand, kept so lowering gives back the same spec (CANVAS.md §3)
    if (layout === 'story') {
      view.mark = 'story';
      view.elements = (p.elements ?? []).map(e => (e?.type === 'trend' ? { ...toView({ ...e, kind: 'compose', layout: 'time' }), type: 'trend' } : clone(e)));
      delete view.encode;
      return view;
    }
    const given = Array.isArray(p.layers) && p.layers.length ? p.layers : p.query ? [{ query: p.query, by: p.listLabel }] : [];
    if (!(Array.isArray(p.layers) && p.layers.length) && p.query) view.fromQuery = true;   // the panel used query/listLabel
    if (Array.isArray(p.layers) && p.layers.length && p.query !== undefined) view.extraQuery = p.query;
    if (p.listLabel !== undefined) view.listLabel = p.listLabel;
    view.layers = given.filter(l => l && l.query).map(liftLayer);
    if (layout === 'bars') { view.encode = { x: p.listLabel ?? view.layers[0]?.seriesBy ?? null }; view.mark = 'bars'; }
    if (layout === 'scatter') { view.encode = { x: view.layers[0]?.id ?? null }; view.mark = 'points'; if (view.layers[0]) view.layers[0].role = 'x'; }
    return view;
  }
  if (QUERY_KINDS[p.kind] && p.query) {
    view.layers = [liftLayer({ query: p.query, by: p.listLabel }, 0)];
    if (p.listLabel !== undefined) view.listLabel = p.listLabel;
    view.mark = QUERY_KINDS[p.kind];
    return view;
  }
  // Logs, notes, traces, flows, timelines, plans: a view with no metric layers; their own fields ride along.
  if (p.query !== undefined) view.query = p.query;
  if (p.listLabel !== undefined) view.listLabel = p.listLabel;
  delete view.encode;
  return view;
}

// A view -> the panel spec the readers understand (v1). toPanel(toView(p)) reads exactly as p does.
export function toPanel(view) {
  if (!view || view.v !== VERSION) return view;
  const { v, scope, layers = [], encode, mark, history, redo, elements, fromQuery, extraQuery, listLabel, layout, query, ...rest } = view;
  const p = { ...clone(rest), ...(scope?.window !== undefined && { window: scope.window }) };
  if (listLabel !== undefined) p.listLabel = listLabel;
  if (view.kind === 'compose') {
    if (layout !== undefined) p.layout = layout;
    else if (mark === 'story') p.layout = 'story';
    else if (mark === 'bars') p.layout = 'bars';
    else if (encode?.x && encode.x !== 'time' && layers.some(l => l.id === encode.x)) p.layout = 'scatter';
    if (p.layout === 'story' || mark === 'story') {
      p.elements = (elements ?? []).map(e => (e?.v === VERSION ? (({ kind, layout: _l, type, ...el }) => ({ type: 'trend', ...el }))(toPanel(e)) : clone(e)));
      return p;
    }
    const lowered = layers.map(l => lowerLayer(l, scope));
    if (fromQuery && lowered.length === 1) { p.query = lowered[0].query; }
    else { p.layers = lowered; if (extraQuery !== undefined) p.query = extraQuery; }
    return p;
  }
  if (layers.length) p.query = lowerLayer(layers[0], scope).query;
  else if (query !== undefined) p.query = query;
  return p;
}

// ---- checking -----------------------------------------------------------------------------------------------------
// Problems with a view, in words (empty when it is sound).
export function check(view) {
  const errs = [];
  if (view?.v !== VERSION) return ['not a v2 view'];
  if (!view.kind) errs.push('kind is missing');
  if (view.mark && !MARKS.includes(view.mark)) errs.push(`mark must be one of ${MARKS.join(', ')}`);
  if ((view.layers ?? []).length > MAX_LAYERS) errs.push(`at most ${MAX_LAYERS} layers`);
  const ids = new Set();
  for (const l of view.layers ?? []) {
    if (!l.id || ids.has(l.id)) errs.push(`layer ids must be unique (${l.id ?? 'missing'})`);
    ids.add(l.id);
    if (!l.query && !l.metric) errs.push(`${l.id}: needs a metric or a query`);
    if (l.metric && !new RegExp(`^${NAME}$`).test(l.metric)) errs.push(`${l.id}: "${l.metric}" is not a metric name`);
    if (l.fn && !FNS.includes(l.fn)) errs.push(`${l.id}: fn must be one of ${FNS.join(', ')}`);
    if (l.agg && !AGGS.includes(l.agg)) errs.push(`${l.id}: agg must be one of ${AGGS.join(', ')}`);
    for (const f of l.filters ?? []) if (!new RegExp(`^${LABEL}$`).test(f.label) || !OPS.includes(f.op)) errs.push(`${l.id}: bad filter ${JSON.stringify(f)}`);
    for (const b of l.by ?? []) if (!new RegExp(`^${LABEL}$`).test(b)) errs.push(`${l.id}: "${b}" is not a label`);
    if (l.axis && !['left', 'right'].includes(l.axis)) errs.push(`${l.id}: axis is left or right`);
  }
  for (const f of view.scope?.filters ?? []) if (!new RegExp(`^${LABEL}$`).test(f.label) || !OPS.includes(f.op)) errs.push(`scope: bad filter ${JSON.stringify(f)}`);
  if (view.encode?.x && !['time', null].includes(view.encode.x) && !ids.has(view.encode.x) && !new RegExp(`^${LABEL}$`).test(view.encode.x)) errs.push(`encode.x "${view.encode.x}" is neither time, a layer nor a label`);
  return errs;
}

// ---- diffs, history, undo ------------------------------------------------------------------------------------------
// An op: { op: 'set' | 'remove' | 'add', path: ['layers', 0, 'fn'], value }. 'add' inserts into an array at the
// path's last index ('-' appends); 'set' replaces or creates; 'remove' deletes a key or an array item.
const HISTORY_FIELDS = new Set(['history', 'redo']);
function walk(root, path) {
  let at = root;
  for (const k of path.slice(0, -1)) {
    if (at[k] === undefined || at[k] === null) at[k] = typeof k === 'number' || k === '-' ? [] : {};
    at = at[k];
  }
  return [at, path.at(-1)];
}
const read = (root, path) => path.reduce((a, k) => (a === undefined || a === null ? undefined : a[k]), root);
function applyOp(view, o) {
  if (!Array.isArray(o.path) || !o.path.length || HISTORY_FIELDS.has(o.path[0]) || o.path[0] === 'v') throw new Error(`can't change ${JSON.stringify(o.path)}`);
  const [parent, key] = walk(view, o.path);
  if (o.op === 'set') {
    const had = Array.isArray(parent) ? key < parent.length : Object.prototype.hasOwnProperty.call(parent, key);
    const before = clone(parent[key]);
    parent[key] = clone(o.value);
    return had ? { op: 'set', path: o.path, value: before } : { op: 'remove', path: o.path };
  }
  if (o.op === 'add') {
    if (!Array.isArray(parent)) throw new Error(`add needs an array at ${JSON.stringify(o.path.slice(0, -1))}`);
    const i = key === '-' ? parent.length : Math.min(Number(key), parent.length);
    parent.splice(i, 0, clone(o.value));
    return { op: 'remove', path: [...o.path.slice(0, -1), i] };
  }
  if (o.op === 'remove') {
    if (Array.isArray(parent)) {
      if (!(key < parent.length)) throw new Error(`nothing at ${JSON.stringify(o.path)}`);
      const [gone] = parent.splice(key, 1);
      return { op: 'add', path: o.path, value: gone };
    }
    if (!Object.prototype.hasOwnProperty.call(parent, key)) throw new Error(`nothing at ${JSON.stringify(o.path)}`);
    const gone = parent[key];
    delete parent[key];
    return { op: 'set', path: o.path, value: gone };
  }
  throw new Error(`unknown op ${o.op}`);
}
function applyAll(view, ops) {
  const next = clone(view), inverse = [];
  for (const o of ops) inverse.unshift(applyOp(next, o));
  return { next, inverse };
}

// A new view with the ops applied and recorded (by: a person or 'HAL 9000'; why: a few words). Throws, leaving the
// view as it was, if an op doesn't apply or the result isn't a sound view.
export function applyDiff(view, ops, { by = 'someone', why = '', at = Date.now() } = {}) {
  if (!Array.isArray(ops) || !ops.length) return view;
  const { next, inverse } = applyAll(view, ops);
  const errs = check(next);
  if (errs.length) throw new Error(errs.join('; '));
  next.history = [...(view.history ?? []), { at, by, why: String(why).slice(0, 200), ops: clone(ops), undo: inverse }].slice(-MAX_HISTORY);
  next.redo = [];
  return next;
}
// Step back through the history, or forward again. A view with nothing to undo (or redo) comes back as it was.
export function undo(view) {
  const last = view.history?.at(-1);
  if (!last) return view;
  const { next } = applyAll(view, last.undo);
  next.history = view.history.slice(0, -1);
  next.redo = [...(view.redo ?? []), last];
  return next;
}
export function redo(view) {
  const again = view.redo?.at(-1);
  if (!again) return view;
  const { next } = applyAll(view, again.ops);
  next.history = [...(view.history ?? []), again];
  next.redo = view.redo.slice(0, -1);
  return next;
}
// The view as it was after its first n changes (for replaying how it was built).
export function at(view, n) {
  let v = view;
  for (let i = (view.history ?? []).length; i > n; i--) v = undo(v);
  return { ...v, redo: [] };
}
export { read as valueAt };

// The forecast signal: what is coming, not only what is here. A short watch list of estate-wide queries, each with a
// threshold, is forecast by the mlforecast MCP server (its "forecast" tool, settings forecast.tool) every few minutes.
// A series earns a panel on the situation board only when both hold:
//   - the forecast's mean crosses the threshold within the horizon (not "could cross", and not already over it: a
//     problem already here is the live board's), and
//   - that series' backtest skill (its "backtest" tool: 1 − model error / seasonal-naive error) is above MIN_SKILL, so
//     a forecast that doesn't beat "same as yesterday" never reaches the board.
// Each raised forecast is a scorecard case ("outlook"), judged by whether the crossing happened: the series seen over
// its threshold on a later check → likely right; still under it GRACE_MS after the predicted time → wrong. Checks
// sample the value every few minutes, so a brief crossing between two checks can be missed.
//
// Off by default (forecast.enabled): the server has to be connected (MCP_SERVERS or settings) and hold enough history.

import * as mcp from '../mcp/index.js';
import * as config from '../config/index.js';
import * as scorecard from '../scorecard/index.js';
import * as snooze from '../snooze/index.js';

export const MIN_SKILL = 0.1;
const GRACE_MS = 2 * 3600_000;      // how long past its ETA a crossing may still arrive before the forecast is wrong
const SKILL_MS = 6 * 3600_000;      // a backtest is reused this long per query (it trains several models)
const CALL_MS = 120_000;            // the server's own budget is 90 s per call
const FS = 'fstype!~"tmpfs|overlay|squashfs|nsfs|ramfs"';
const sel = (labels, keys) => keys.map(k => `${k}="${String(labels[k] ?? '').replace(/["\\]/g, '')}"`).join(',');

// key doubles as the panel code; one(labels) is the live query for the panel, for that series alone.
export const WATCH = [
  { key: 'MEM', name: 'node memory used', unit: '', threshold: 0.9, crit: 0.95,
    query: 'max by (cluster) (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)',
    one: l => `max(1 - node_memory_MemAvailable_bytes{${sel(l, ['cluster'])}} / node_memory_MemTotal_bytes{${sel(l, ['cluster'])}})` },
  { key: 'DSK', name: 'filesystem used', unit: '', threshold: 0.85, crit: 0.95,
    query: `max by (cluster) (1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}})`,
    one: l => `max(1 - node_filesystem_avail_bytes{${FS},${sel(l, ['cluster'])}} / node_filesystem_size_bytes{${FS},${sel(l, ['cluster'])}})` },
  { key: 'RNS', name: 'restarts per hour', unit: 'restarts', threshold: 10, crit: 30, by: 'namespace',
    query: 'sum by (cluster, namespace) (increase(kube_pod_container_status_restarts_total[1h]))',
    one: l => `sum(increase(kube_pod_container_status_restarts_total{${sel(l, ['cluster', 'namespace'])}}[1h])) or vector(0)` },
];

let outlooks = [];          // what is raised now: [{ w, series, labels, cluster, crossing, skill, method, last, case }]
const open = new Map();     // "MEM:<series>" -> { case, w, series, eta, threshold }
const skills = new Map();   // query|horizon -> { at, bySeries: Map(series -> skill) }
let lastCheck = 0, checking = false;
export const reset = () => { outlooks = []; open.clear(); skills.clear(); lastCheck = 0; checking = false; };   // tests

export const enabled = () => config.get('forecast.enabled') === 'on' && !!mcp.resolve(config.get('forecast.tool'));
export const due = (now = Date.now()) => enabled() && !checking && now - lastCheck >= config.get('forecast.everyMinutes') * 60_000;

const parse = text => { try { const r = JSON.parse(text); return r?.success === false ? null : r; } catch { return null; } };
const callTool = (call, setting, args) => call(mcp.resolve(config.get(setting)) ?? config.get(setting), args, { internal: true, wait: { timeout: CALL_MS } });

async function skillOf(call, w, horizon, lookback, now) {
  const k = `${w.query}|${horizon}`, have = skills.get(k);
  if (have && now - have.at < SKILL_MS) return have.bySeries;
  const r = parse(await callTool(call, 'forecast.backtestTool', { query: w.query, lookback, horizon }));
  if (!r) return new Map();   // no backtest: nothing is trusted, and it is asked again next time
  const bySeries = new Map((r.series ?? []).filter(s => Number.isFinite(s.skill)).map(s => [s.series, s.skill]));
  skills.set(k, { at: now, bySeries });
  return bySeries;
}

// A forecast earns a panel: its mean crosses within the horizon, it isn't already over, and it beats the baseline.
export const raises = (s, skill) => !!s?.crossing?.mean_eta && !s.crossing.already && Number.isFinite(skill) && skill > MIN_SKILL;

// Open cases for this watch, against what the forecast just read: over the threshold → it happened; long past its ETA
// and still under → it didn't.
function judgeOpen(w, series, now) {
  for (const [k, o] of open) {
    if (o.w !== w) continue;
    const s = series.find(x => x.series === o.series), v = s?.last?.value;
    const late = Math.round((now - o.eta) / 60_000), when = late >= 0 ? `${late} min after` : `${-late} min before`;
    if (Number.isFinite(v) && v >= o.threshold) scorecard.judge(o.case, 'likely_right', `crossed ${o.threshold} (at ${+v.toFixed(3)}) ${when} the forecast time`);
    else if (now - o.eta > GRACE_MS) scorecard.judge(o.case, 'wrong', `${Number.isFinite(v) ? `still at ${+v.toFixed(3)}` : 'no longer seen'}, ${Math.round(GRACE_MS / 3600_000)} h past the forecast time`);
    else continue;
    open.delete(k);
  }
}

// One pass over the watch list. call: mcp.call's shape (tests pass their own). Returns true when the outlooks changed.
export async function check({ now = Date.now(), call = mcp.call } = {}) {
  if (checking) return false;
  checking = true;
  const before = JSON.stringify(outlooks.map(o => [o.w.key, o.series, o.crossing.summary]));
  try {
    const horizon = config.get('forecast.horizon'), lookback = config.get('forecast.lookback'), next = [];
    for (const w of WATCH) {
      const r = parse(await callTool(call, 'forecast.tool', { query: w.query, lookback, horizon, threshold: w.threshold, direction: 'above' }));
      if (!r) { next.push(...outlooks.filter(o => o.w === w)); continue; }   // the server failed: keep what was raised
      const series = r.series ?? [];
      judgeOpen(w, series, now);
      const crossing = series.filter(s => s.labels?.cluster && s.crossing?.mean_eta && !s.crossing.already);   // a series with no cluster has no panel to go on
      if (!crossing.length) continue;   // nothing coming: no backtest needed
      const skill = await skillOf(call, w, horizon, lookback, now);
      for (const s of crossing.filter(s => raises(s, skill.get(s.series)))) {
        const k = `${w.key}:${s.series}`, cluster = s.labels?.cluster ?? '';
        let o = open.get(k);
        if (!o) {
          const about = `${[cluster, w.by && s.labels?.[w.by]].filter(Boolean).join('/')}: ${w.name} ${s.crossing.summary} (skill ${skill.get(s.series).toFixed(2)})`;
          o = { case: scorecard.record('outlook', { key: k, about }), w, series: s.series, eta: Date.parse(s.crossing.mean_eta), threshold: w.threshold };
          open.set(k, o);
        }
        next.push({ w, series: s.series, labels: s.labels ?? {}, cluster, crossing: s.crossing, skill: skill.get(s.series), method: s.method, last: s.last?.value, case: o.case });
      }
    }
    outlooks = next.sort((a, b) => Date.parse(a.crossing.mean_eta) - Date.parse(b.crossing.mean_eta));   // soonest first
    lastCheck = now;
    if (outlooks.length) console.log(`Forecasts: ${outlooks.map(o => `${o.w.key} ${o.cluster}${o.w.by ? `/${o.labels[o.w.by]}` : ''} ${o.crossing.summary}`).join('; ')}`);
  } finally { checking = false; }
  return JSON.stringify(outlooks.map(o => [o.w.key, o.series, o.crossing.summary])) !== before;
}

export const current = () => outlooks;

// Panels for the situation board, soonest crossing first, leaving out snoozed ones. name(cluster) is the board's short
// name; taken is the set of codes already on the board.
export function panels(name = c => c, taken = new Set()) {
  return outlooks.filter(o => !snooze.isSnoozed(o.cluster, o.w.key, 1)).map(o => {
    let code = o.w.key;
    for (let i = 2; taken.has(code); i++) code = code.slice(0, 2) + i;
    taken.add(code);
    const where = [name(o.cluster), o.w.by && o.labels[o.w.by]].filter(Boolean).join(' ');
    return {
      code, title: `${where} · ${o.w.name}, forecast`, kind: 'timeseries', unit: o.w.unit, warn: o.w.threshold, crit: o.w.crit,
      query: o.w.one(o.labels),
      insight: `Forecast: ${o.crossing.summary}; beats the baseline (skill ${o.skill.toFixed(2)})`.slice(0, 90),
      outlook: { eta: o.crossing.mean_eta, earliest: o.crossing.earliest_eta, threshold: o.w.threshold, skill: o.skill, method: o.method, case: o.case.id },
      cluster: o.cluster,
      snooze: { key: snooze.keyOf(o.cluster, o.w.key), level: 1, value: o.last ?? null, label: `${where} ${o.w.name} forecast` },
    };
  });
}

// For the model: forecasts that crossed the gate, whether or not they fit on the board.
export function summary() {
  if (!outlooks.length) return '';
  return `Forecasts (mlforecast; shown only when the series' backtest beats a seasonal-naive baseline):\n` +
    outlooks.map(o => `- ${o.cluster}${o.w.by ? `/${o.labels[o.w.by]}` : ''} ${o.w.name}: ${o.crossing.summary} (skill ${o.skill.toFixed(2)}, ${o.method}; case ${o.case.id})`).join('\n');
}

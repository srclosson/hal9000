// Watches Grafana alert rules and reports changes, so the 9000 can speak up unprompted.
//
//   ALERT_WATCH            on | off            (default on whenever alerts are available)
//   ALERT_WATCH_SECONDS    poll interval       (default 30)
//   ALERT_MIN_SEVERITY     critical | warning  (default critical: what is worth interrupting for)
//   ALERT_WATCH_OVERRIDES  path to a JSON file { "<rule uid>": "firing" | "normal", ... } merged over the real
//                          states on every poll. For local testing only, so a story can be tried without
//                          touching shared demo data. Never set in a deployment.
//
// start({ onFire, onResolve }) polls; the first poll only records a baseline (alerts already firing when the
// server starts are not announced). onFire(alerts) gets every rule that started firing in one poll, most severe
// first; onResolve(rule) is called for each rule that stops firing.

import * as alerts from './index.js';

const SEVERITY = { critical: 0, warning: 1, info: 2 };
import * as config from '../config/index.js';
// Live settings: don't re-announce the same alert within this window (flapping); severity threshold; poll interval.
const REPEAT_MS = () => config.get('alerts.repeatMinutes') * 60_000;

const enabled = () => (process.env.ALERT_WATCH ?? 'on').toLowerCase() !== 'off';
const minRank = () => SEVERITY[config.get('alerts.minSeverity')] ?? 0;
const rank = r => SEVERITY[r.labels?.severity] ?? 9;

let previous = null;                // uid -> state at the last poll (null until the baseline poll)
const announcedAt = new Map();      // uid -> time it was last announced
let timer;

async function poll({ onFire, onResolve }) {
  const all = await alerts.allRules();
  if (!all) return;   // Grafana unreachable: try again next time, keep the last known states
  const states = new Map(all.map(r => [r.uid, r.state]));   // allRules() already applies any test overrides

  if (previous) {
    const fired = [], now = Date.now();
    for (const r of all) {
      const was = previous.get(r.uid), is = states.get(r.uid);
      if (is === 'firing' && was !== 'firing' && rank(r) <= minRank() && now - (announcedAt.get(r.uid) ?? 0) > REPEAT_MS()) {
        fired.push({ ...r, state: is });
        announcedAt.set(r.uid, now);
      }
      if (was === 'firing' && is !== 'firing' && rank(r) <= minRank()) onResolve({ ...r, state: is });
    }
    if (fired.length) onFire(fired.sort((a, b) => rank(a) - rank(b)));
  }
  previous = states;
}

export function start(handlers) {
  if (!enabled() || !alerts.available() || timer) return false;
  const tick = () => poll(handlers).catch(err => console.error('Alert watch:', err.message));
  const loop = () => { timer = setTimeout(() => { tick(); loop(); }, config.get('alerts.watchSeconds') * 1000); };   // interval re-read each time
  tick();
  loop();
  console.log(`Alert watch: every ${config.get('alerts.watchSeconds')}s, announcing ${config.get('alerts.minSeverity')} and above` +
    (process.env.ALERT_WATCH_OVERRIDES ? ` (test overrides from ${process.env.ALERT_WATCH_OVERRIDES})` : ''));
  return true;
}

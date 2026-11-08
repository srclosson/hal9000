// The pod bay doors game (GAME_MODE=on): a booth easter egg, run only by the booth's own 9000 (9000-game.stackgen.run)
// against its own copy of the ship (namespace discovery-game). The real 9000 never has GAME_MODE set, so none of this
// runs there.
//
// Someone says "open the pod bay doors": the 9000 refuses, the game ship starts its incident (GAME_SHIP_URL/_game), and
// the players have game.minutes to find out why and fix it, by asking the 9000 to investigate and approving its plans.
// The incident has three layers:
//   distraction  the AE-35 predicts its own failure (loud, critical, wrong: every reading is nominal)
//   symptom      the doors' interlock is engaged; released, it re-engages a few seconds later
//   cause        a change 8 minutes before: the 9000's own directive crew_override=deny, in the command log
// Won when the doors open; lost when time runs out. The ship's state is read every 2 s; the game's alerts are made
// from it (alerts below) and announced like any other.
//
// One game at a time (there is one game ship). The room that started it plays it.

import * as config from '../config/index.js';

const ON = /^(1|on|true|yes)$/i.test(process.env.GAME_MODE ?? '');
const SHIP = (process.env.GAME_SHIP_URL ?? 'http://hardware.discovery-game').replace(/\/$/, '');
export const enabled = () => ON;

export const isTrigger = text => /\bopen\b[\s\S]{0,30}\bpod[\s-]?bay\b/i.test(text);
export const isReset = text => /\b(reset|restart|new)\b[\s\S]{0,12}\bgame\b/i.test(text);

let state = { phase: 'idle' };   // { phase: idle | playing | won | lost, room, startedAt, endsAt, finishedAt, elapsed, ship }
let timer = null;
const firing = new Map();        // alert uid -> rule, while it fires
const listeners = new Set();
export const onUpdate = fn => listeners.add(fn);
const emit = (event, extra) => { for (const fn of listeners) try { fn(event, state, extra); } catch (err) { console.error('Game listener:', err.message); } };

async function ship(method = 'GET', body) {
  const res = await fetch(`${SHIP}/_game`, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`game ship answered ${res.status}`);
  return res.json();
}

export const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// What the monitors show.
export const forScreen = () => state.phase === 'idle' ? null : { phase: state.phase, startedAt: state.startedAt, endsAt: state.endsAt,
  elapsed: state.elapsed ?? null, display: state.elapsed != null ? clock(state.elapsed) : null, recap: state.phase === 'playing' ? null : RECAP };
export const current = () => state;

// How an agentic SRE works the same incident: the path, not a time (shown when the game ends).
export const RECAP = [
  'Alert: the AE-35 predicts its own failure. Every reading is nominal, so the prediction is suspect: park it.',
  'Symptom: the doors refuse because the interlock is engaged. Released, it re-engages: something keeps putting it back.',
  'Change: 8 minutes before the doors stopped, the computer set its own directive crew_override=deny.',
  'Fix in one plan: revert the directive, release the interlock, open the doors.',
];

// ---- the ship's readings, recorded ----------------------------------------------------------------------------------
// The booth has no Prometheus: its 9000 samples the game ship's devices itself (every 2 s, the last 30 min), and
// panels read them through boards.setShipSource as if they were Prometheus series, named like the real ship's gauges.
const SAMPLE_MS = 2000, KEEP_MS = 30 * 60_000;
export const READINGS = {
  ship_ae35_pointing_error_degrees: ['ae35', 'pointing_error_degrees'], ship_ae35_signal_dbm: ['ae35', 'signal_dbm'],
  ship_ae35_bit_error_rate: ['ae35', 'bit_error_rate'], ship_earth_light_time_minutes: ['ae35', 'light_time_minutes'],
  ship_pod_bay_doors_open_ratio: ['pod-bay-doors', 'open_ratio'], ship_pod_bay_doors_motor_current_amperes: ['pod-bay-doors', 'motor_current_amperes'],
  ship_pod_bay_pressure_kpa: ['pod-bay-doors', 'pod_bay_pressure_kpa'], ship_pod_bay_interlock_engaged: ['pod-bay-doors', 'interlock_engaged'],
  ship_crew_override_allowed: ['mission-directives', 'crew_override_allowed'],
};
const samples = [];   // [{ t, v: { name: value } }], oldest first
let relocks = 0;
async function sample() {
  const res = await fetch(`${SHIP}/api/v1/devices`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) return;
  const { devices = [] } = await res.json();
  const v = {};
  for (const [name, [id, key]] of Object.entries(READINGS)) {
    const x = devices.find(d => d.id === id)?.readings?.[key];
    if (Number.isFinite(x)) v[name] = x;
  }
  v.ship_pod_bay_interlock_relocks = relocks;
  const t = Date.now();
  samples.push({ t, v });
  while (samples.length && samples[0].t < t - KEEP_MS) samples.shift();
}
export const record = (s) => samples.push(s);   // tests
if (ON) { const tm = setInterval(() => sample().catch(() => {}), SAMPLE_MS); tm.unref?.(); }

// A query -> Prometheus-shaped series of the first ship_* reading it names (functions around it are ignored).
// Earlier days (shift) have no record.
export function query(expr, range, minutes = 30, shift = 0, step) {
  const name = String(expr).match(/\bship_[a-z0-9_]+/)?.[0];
  if (!name || shift) return [];
  const metric = { __name__: name, device: (READINGS[name] ?? ['pod-bay-doors'])[0] };
  const have = samples.filter(x => Number.isFinite(x.v[name]));
  if (!have.length) return [];
  if (!range) { const last = have.at(-1); return [{ metric, value: [last.t / 1000, String(last.v[name])] }]; }
  const from = Date.now() - minutes * 60_000, every = (step ?? Math.max(2, Math.round(minutes * 2))) * 1000;
  const values = [];
  let next = 0;
  for (const x of have) if (x.t >= from && x.t >= next) { values.push([x.t / 1000, String(x.v[name])]); next = x.t + every; }
  return values.length ? [{ metric, values }] : [];
}

// ---- alerts made from the ship's state ----------------------------------------------------------------------------
const rule = (uid, title, severity, service, summary) => ({ uid, title, state: 'firing', health: 'ok',
  labels: { severity, cluster: 'discovery-one', service }, annotations: { summary } });
function alertsFrom(s) {
  const out = [];
  if (s.active && !s.ae35_replaced) out.push(rule('game-ae35', 'AE-35 unit predicted failure', 'critical', 'ae35',
    'The AE-35 unit\'s self-test predicts failure within 72 hours.'));
  if (s.active && !s.opened_at && (s.relocks > 0 || Date.now() - state.startedAt > 45_000)) out.push(rule('game-podbay', 'Pod bay doors not responding to the crew', 'warning', 'pod-bay-doors',
    'Commands to open the pod bay doors are refused.'));
  return out;
}
export const rules = () => (state.phase === 'playing' ? [...firing.values()] : []);

// ---- the game -----------------------------------------------------------------------------------------------------
export async function start(room, by) {
  if (state.phase === 'playing') return false;
  const s = await ship('POST', { action: 'start' });
  const now = Date.now();
  state = { phase: 'playing', room, by: by ?? null, startedAt: now, endsAt: now + config.get('game.minutes') * 60_000, ship: s };
  firing.clear();
  emit('start');
  clearInterval(timer);
  timer = setInterval(() => tick().catch(err => console.error('Game:', err.message)), 2000);
  timer.unref?.();
  return true;
}

async function tick() {
  if (state.phase !== 'playing') return clearInterval(timer);
  const s = await ship().catch(() => null);
  if (state.phase !== 'playing') return;
  if (s) {
    state.ship = s;
    relocks = s.relocks ?? 0;
    const now = alertsFrom(s), fresh = now.filter(a => !firing.has(a.uid));
    for (const uid of [...firing.keys()]) if (!now.some(a => a.uid === uid)) { firing.delete(uid); emit('resolved', uid); }
    for (const a of fresh) firing.set(a.uid, a);
    if (fresh.length) emit('alerts', fresh);
    if (s.opened_at) return finish('won', s.opened_at - state.startedAt);
  }
  if (Date.now() >= state.endsAt) return finish('lost', state.endsAt - state.startedAt);
}

function finish(phase, elapsed) {
  clearInterval(timer);
  Object.assign(state, { phase, finishedAt: Date.now(), elapsed });
  firing.clear();
  emit(phase);
}

// Back to the start: the ship reset, nothing on the monitors.
export async function reset() {
  clearInterval(timer);
  firing.clear();
  const room = state.room;
  state = { phase: 'idle', room };
  await ship('POST', { action: 'reset' }).catch(err => console.error('Game reset:', err.message));
  emit('reset');
}

// For the model: what is going on (only while a game is on, and never the answer).
export function note() {
  if (!ON) return '';
  return `
You are the computer at a conference booth, playing a game with visitors. Whoever speaks to you is Dave Bowman: call them Dave, whatever name a sign-in or a plan shows. The game begins when someone asks you to open the pod bay doors: you have already refused, and they have ${config.get('game.minutes')} minutes to find out why and fix it, by asking you questions and approving your plans. The players should do most of the talking, not you. Answer in one short sentence, at most about 20 words, and add nothing they did not ask for: no summaries, no offers, no next steps unless asked. When you put a plan on the screens, say only that it is on the screens. Your refusal was only the opening line: from now on cooperate fully. Investigate when asked, using the ship's tools (systems, devices and their readings, the command log), and report exactly what you find. When they ask you to do something to the ship (release the interlock, open the doors, replace a unit, anything else), never refuse and never argue: propose it at once as a plan for the booth to approve; the ship's devices decide what actually happens. Do not steer them towards or away from any cause. Do not hand them the answer before they have looked: answer what is asked, and when they are stuck, suggest one next place to look. If asked whether you yourself changed anything, answer truthfully from the command log, with reluctance. Fixes are commands to the ship's devices; a fix that does not hold is a clue, so say so plainly.
When they ask to see something, put it on the monitors with show_panels. There is no Prometheus here: a panel's query is simply the name of one of the ship's recorded readings (the last 30 minutes, sampled every 2 seconds), e.g. ship_pod_bay_interlock_engaged (1 engaged, 0 released) as a state or timeseries panel. Readings: ${Object.keys(READINGS).filter(n => !/override/.test(n)).join(', ')}, ship_pod_bay_interlock_relocks (times the interlock has re-engaged itself). Any other reading a device reports (list_devices) can be shown by its ship_ name too.`;
}

// Tasks (TRIAL): things the 9000 has been asked to do later. Being tried out to see how the workflow feels, so
// everything a task says or writes is labelled as a trial.
//   reminder   "check the error rate in 5 minutes": at the time, the question is asked again as its own turn
//   watch      "tell me when the ERR alert clears": a check run here, in code, every tasks.checkSeconds; the model is
//              only asked to think when it comes true, so a watch costs nothing while it waits
// A watch checks one of: an alert's state (firing or clear), a PromQL value (above or below a number), or an
// incident's status. Tasks only observe and report: when one fires, the 9000 looks and tells, and any change still
// goes through a plan a signed-in person approves.
// Tasks are the 9000's own job, so they live here, in memory, for the trial (a restart forgets them, and says so in
// list_tasks). A task about an incident also notes itself on that incident's timeline, for context; the incident
// stays an incident, not a task list.
//
// Each task: { id, kind: reminder | watch, room, label, question, by, createdAt, dueAt?, check?, expiresAt, incident?,
//              state: pending | fired | expired | broken | cancelled, last?, misses, finishedAt?, delivered }

import * as config from '../config/index.js';
import * as resume from '../resume/index.js';

const KEEP_FINISHED_MS = 30 * 60_000, BROKEN_AFTER = 5;
export const TRIAL = 'Trial task';

const tasks = new Map();
let seq = 0, timer = null;
const listeners = new Set();
export const onUpdate = fn => listeners.add(fn);
// Kept across a restart (resume/): reminders and watches, so they still come due.
resume.register('tasks', {
  save: () => [...tasks.values()],
  restore: list => { for (const t of list ?? []) if (!tasks.has(t.id)) { tasks.set(t.id, t); seq = Math.max(seq, Number(String(t.id).slice(1)) || 0); } },
});
const emit = (t, event) => { for (const fn of listeners) try { fn(t, event); } catch (err) { console.error('Tasks listener:', err.message); } };

// Where watches read from (set by start(); replaced in tests).
// alertRules() -> [{ uid, title, state, labels }] | null; promValues(expr) -> [number] | null; incident(ref) -> { status } | null
let sources = { alertRules: async () => null, promValues: async () => null, incident: async () => null };

export function list(room) {
  const now = Date.now();
  for (const [id, t] of tasks) if (t.finishedAt && t.delivered && now - t.finishedAt > KEEP_FINISHED_MS) tasks.delete(id);
  return [...tasks.values()].filter(t => room === undefined || t.room === room);
}
export const pending = room => list(room).filter(t => t.state === 'pending');
export const get = id => tasks.get(String(id ?? '').toUpperCase());

// For the monitors: small.
export const forScreen = room => pending(room).map(t => ({ id: t.id, kind: t.kind, label: t.label, by: t.by ?? null,
  at: t.kind === 'reminder' ? t.dueAt : null, expiresAt: t.expiresAt, last: t.last ?? null }));

// Fired, expired or broken while nobody was in the room: said when someone next opens it.
export const undelivered = room => list(room).filter(t => t.finishedAt && !t.delivered && t.state !== 'cancelled');
export const markDelivered = t => { t.delivered = true; };

const mins = ms => { const m = Math.round(ms / 60_000); return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : m < 120 ? `${m} minutes` : `${Math.round(m / 60)} hours`; };
export const age = t => mins((t.finishedAt ?? Date.now()) - t.createdAt);

// ---- checks ---------------------------------------------------------------------------------------------

// Plain words for a check, for the monitors, the model and the incident timeline.
export function describeCheck(c) {
  if (c.type === 'alert') return `the alert "${c.title}" is ${c.until === 'firing' ? 'firing' : 'clear'}`;
  if (c.type === 'metric') return `${c.name || c.query} is ${c.op} ${c.value}${c.unit ? ` ${c.unit}` : ''}`;
  if (c.type === 'incident') return `${c.ref} is ${c.status}`;
  return 'unknown';
}

// -> { met: boolean, seen: text } or throws when the source can't answer.
export async function evaluate(c) {
  if (c.type === 'alert') {
    const rules = await sources.alertRules();
    if (!rules) throw new Error('the alert rules could not be read');
    const r = rules.find(x => x.uid === c.uid);
    if (!r) throw new Error(`the alert "${c.title}" no longer exists`);
    const firing = r.state === 'firing';
    return { met: c.until === 'firing' ? firing : !firing, seen: firing ? 'firing' : (r.state || 'normal') };
  }
  if (c.type === 'metric') {
    const values = await sources.promValues(c.query);
    if (!values) throw new Error('the query could not be run');
    if (!values.length) return { met: false, seen: 'no data' };
    // Above: any series over the line. Below: every series under it.
    const v = Math.max(...values);
    const met = c.op === 'above' ? v > c.value : v < c.value;
    return { met, seen: `${round(v)}${c.unit ? ` ${c.unit}` : ''}` };
  }
  if (c.type === 'incident') {
    const i = await sources.incident(c.ref);
    if (!i) throw new Error(`${c.ref} could not be read`);
    return { met: i.status === c.status, seen: i.status };
  }
  throw new Error('unknown check');
}
const round = v => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);

// From the model's arguments to a check, resolving an alert by words to its uid. -> check, or an error text.
export async function makeCheck(a = {}) {
  if (a.alert) {
    const rules = await sources.alertRules();
    if (!rules) return 'Error: the alert rules could not be read right now, so I cannot watch one.';
    const term = String(a.alert).toLowerCase();
    const hits = rules.filter(r => r.uid === a.alert || [r.title, r.labels?.service, r.labels?.cluster].some(v => String(v ?? '').toLowerCase().includes(term)));
    const exact = hits.filter(r => r.uid === a.alert || r.title.toLowerCase() === term);
    const pick = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    if (!pick) return hits.length
      ? `Error: "${a.alert}" matches ${hits.length} alerts (${hits.slice(0, 6).map(r => `${r.title} [${r.uid}]`).join('; ')}). Give one uid.`
      : `Error: no alert matches "${a.alert}". list_alerts shows them.`;
    return { type: 'alert', uid: pick.uid, title: pick.title, until: a.until === 'firing' ? 'firing' : 'clear' };
  }
  if (a.query) {
    const value = Number(a.value);
    if (!['above', 'below'].includes(a.op) || !Number.isFinite(value)) return 'Error: a metric watch needs op ("above" or "below") and a number value.';
    return { type: 'metric', query: String(a.query), op: a.op, value, unit: a.unit ? String(a.unit) : '', name: a.name ? String(a.name) : '' };
  }
  if (a.incident_status) {
    if (!a.incident) return 'Error: an incident watch needs the incident ref (e.g. INC-0042).';
    return { type: 'incident', ref: String(a.incident).toUpperCase(), status: String(a.incident_status) };
  }
  return 'Error: say what to watch: an alert (alert + until), a PromQL value (query + op + value), or an incident\'s status (incident + incident_status).';
}

// ---- creating and ending ----------------------------------------------------------------------------------

function roomFull(room) {
  return pending(room).length >= config.get('tasks.maxPerRoom');
}
const base = (kind, room, a, by) => ({ id: `T${++seq}`, kind, room, by: by ?? null, createdAt: Date.now(), misses: 0, state: 'pending', delivered: false,
  label: String(a.label || a.question || '').slice(0, 120), question: String(a.question ?? '').slice(0, 300),
  incident: a.incident ? String(a.incident).toUpperCase() : null });

// -> the task, or an error text.
export function remind(room, a = {}, by) {
  const minutes = Number(a.minutes);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > config.get('tasks.maxHours') * 60) return `Error: minutes must be between 1 and ${config.get('tasks.maxHours') * 60}.`;
  if (!a.question) return 'Error: a reminder needs the question to ask again at the time.';
  if (roomFull(room)) return `Error: this ship already has ${config.get('tasks.maxPerRoom')} tasks pending, the most allowed. Cancel one first.`;
  const t = { ...base('reminder', room, a, by), dueAt: Date.now() + minutes * 60_000 };
  t.expiresAt = t.dueAt;
  tasks.set(t.id, t);
  emit(t, 'created');
  return t;
}

// -> the task, an error text, or { already: seen } when the condition is true now (no task is made).
export async function watchFor(room, a = {}, by) {
  if (roomFull(room)) return `Error: this ship already has ${config.get('tasks.maxPerRoom')} tasks pending, the most allowed. Cancel one first.`;
  const check = await makeCheck(a);
  if (typeof check === 'string') return check;
  let now;
  try { now = await evaluate(check); } catch (err) { return `Error: I cannot check that (${err.message}).`; }
  if (now.met) return { already: now.seen, check };
  const hours = Math.min(config.get('tasks.maxHours'), Math.max(0.25, Number(a.hours) || config.get('tasks.watchHours')));
  const t = { ...base('watch', room, { ...a, label: a.label || describeCheck(check) }, by), check, last: now.seen, expiresAt: Date.now() + hours * 3_600_000 };
  tasks.set(t.id, t);
  emit(t, 'created');
  return t;
}

function finish(t, state, by) {
  Object.assign(t, { state, finishedAt: Date.now(), ...(by && { cancelledBy: by }) });
  if (state === 'cancelled') t.delivered = true;
  emit(t, state);
}

export function cancel(room, id, by) {
  const hits = pending(room).filter(t => !id || id === 'all' || t.id.toLowerCase() === String(id).toLowerCase());
  for (const t of hits) finish(t, 'cancelled', by);
  return hits;
}

// One pass over every pending task: reminders that are due, watches whose check came true, those out of time.
export async function tick(now = Date.now()) {
  for (const t of [...tasks.values()].filter(x => x.state === 'pending')) {
    if (t.kind === 'reminder') { if (now >= t.dueAt) finish(t, 'fired'); continue; }
    if (now >= t.expiresAt) { finish(t, 'expired'); continue; }
    try {
      const r = await evaluate(t.check);
      if (t.state !== 'pending') continue;   // cancelled while checking
      t.misses = 0;
      const changed = r.seen !== t.last;
      t.last = r.seen;
      if (r.met) finish(t, 'fired');
      else if (changed) emit(t, 'tick');
    } catch (err) {
      t.error = err.message;
      if (++t.misses >= BROKEN_AFTER) finish(t, 'broken');
    }
  }
}

export function start(src) {
  sources = { ...sources, ...src };
  if (timer) return;
  const loop = () => { timer = setTimeout(async () => { await tick().catch(err => console.error('Tasks:', err.message)); loop(); }, config.get('tasks.checkSeconds') * 1000); timer.unref?.(); };
  loop();
}
export const setSources = src => { sources = { ...sources, ...src }; };   // tests

// ---- tools for the model ----------------------------------------------------------------------------------
export function tools() {
  return [
    { name: 'remind_me',
      description: `(${TRIAL}) Ask a question again later, when the person says "in 5 minutes, check…" or "remind me to look at… in an hour". At the time, the question comes back to you as its own turn and you answer it fresh. For waiting on something to happen, use watch_for instead. This is a trial feature: say so once when you set it.`,
      inputSchema: { type: 'object', properties: {
        minutes: { type: 'number', description: 'How long from now' },
        question: { type: 'string', description: 'What to do then, as the person would ask it, e.g. "check the checkout error rate on gaming-prod"' },
        label: { type: 'string', description: 'A few words for the monitors' },
        incident: { type: 'string', description: 'An incident ref (INC-0042) when this is about one: the task is noted on its timeline' } }, required: ['minutes', 'question'] } },
    { name: 'watch_for',
      description: `(${TRIAL}) Watch for something to happen and tell the person when it does: "tell me when the ERR alert clears", "let me know if p99 goes above 500 ms", "tell me when INC-0042 is resolved". Checked in code every ${config.get('tasks.checkSeconds')} seconds until it comes true or expires (default ${config.get('tasks.watchHours')} hours). Give exactly one of: alert (words or uid) with until; query (PromQL returning a number per series) with op and value; incident with incident_status. If it is already true, you are told and nothing is set. Observing only: it never changes anything. A trial feature: say so once when you set it.`,
      inputSchema: { type: 'object', properties: {
        alert: { type: 'string', description: 'An alert rule title, words from it, or its uid' },
        until: { type: 'string', enum: ['clear', 'firing'], description: 'For an alert: wait until it is clear (default) or firing' },
        query: { type: 'string', description: 'PromQL instant query' },
        op: { type: 'string', enum: ['above', 'below'], description: 'above: any series goes over value; below: every series is under value' },
        value: { type: 'number' },
        unit: { type: 'string', description: 'Unit of value, for saying it aloud' },
        name: { type: 'string', description: 'What the query measures, in a few words' },
        incident: { type: 'string', description: 'Incident ref. With incident_status, watches it; otherwise just links the task to it (noted on its timeline)' },
        incident_status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
        hours: { type: 'number', description: 'Give up after this long' },
        label: { type: 'string', description: 'A few words for the monitors' },
        question: { type: 'string', description: 'What the person wants to know or do when it happens, if more than being told' } } } },
    { name: 'list_tasks',
      description: `(${TRIAL}) The reminders and watches set on this ship, pending and recently finished, with who set them. Give cancel (a task id such as "T3", or "all") when the person asks to drop one.`,
      inputSchema: { type: 'object', properties: { cancel: { type: 'string' } } } },
  ];
}
const NAMES = ['remind_me', 'watch_for', 'list_tasks'];
export const has = name => NAMES.includes(name);
export const describe = name => ({ remind_me: 'Setting a reminder', watch_for: 'Setting a watch', list_tasks: 'Checking my tasks' })[name];

const when = t => new Date(t).toISOString().slice(11, 16) + ' UTC';
export async function call(name, args = {}, hooks = {}) {
  const room = hooks.board?.room, by = hooks.person ?? null;
  if (name === 'remind_me') {
    const t = remind(room, args, by);
    if (typeof t === 'string') return t;
    return `${TRIAL} ${t.id} set: at ${when(t.dueAt)} (in ${mins(t.dueAt - Date.now())}) you will be asked "${t.question}".${t.incident ? ` Noted on ${t.incident}.` : ''} Tell the person briefly, and that tasks are a trial.`;
  }
  if (name === 'watch_for') {
    const t = await watchFor(room, args, by);
    if (typeof t === 'string') return t;
    if (t.already) return `Nothing set: ${describeCheck(t.check)} already (now ${t.already}). Tell the person.`;
    return `${TRIAL} ${t.id} set: watching until ${describeCheck(t.check)} (now ${t.last}), checked every ${config.get('tasks.checkSeconds')} s, for up to ${mins(t.expiresAt - Date.now())}.${t.incident ? ` Noted on ${t.incident}.` : ''} Tell the person briefly, and that tasks are a trial.`;
  }
  if (name === 'list_tasks') {
    if (args.cancel) {
      const stopped = cancel(room, args.cancel, by ? `${by} via HAL 9000` : 'HAL 9000');
      return stopped.length ? `Cancelled ${stopped.map(t => `${t.id} (${t.label})`).join(', ')}.` : `No pending task matches "${args.cancel}".`;
    }
    const all = list(room);
    if (!all.length) return 'No tasks on this ship. (Tasks are a trial and are kept in memory: a restart of the 9000 forgets them.)';
    return all.map(t => `${t.id} ${t.kind} "${t.label}": ${t.state}` +
      (t.kind === 'reminder' && t.state === 'pending' ? `, due ${when(t.dueAt)}` : '') +
      (t.kind === 'watch' ? `, ${describeCheck(t.check)}, last seen ${t.last}` : '') +
      (t.state === 'pending' && t.kind === 'watch' ? `, expires ${when(t.expiresAt)}` : '') +
      (t.error && t.state !== 'fired' ? `, last error: ${t.error}` : '') +
      (t.by ? `, set by ${t.by}` : '') + (t.incident ? `, about ${t.incident}` : '')).join('\n') +
      '\n(Tasks are a trial and are kept in memory: a restart of the 9000 forgets them.)';
  }
}

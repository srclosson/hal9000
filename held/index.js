// Held calls: tools that take longer than a moment, above all other agents (Aiden thinking through a chat can take
// minutes). The 9000 waits in the conversation for tools.holdSeconds; a call still working then is held, not given
// up: the model is told it is waiting (so the turn ends and the 9000 carries on), and the answer is brought back when
// it arrives (server.js turns it into an [Automatic: …] turn in the room that asked).
//
// Slow is not the same as gone, so a held call is watched three ways:
//   alive      its server answers an MCP ping (every PING_MS)          no: lost after LOST_AFTER misses in a row
//   progress   the server sends progress notifications for the call    resets the quiet clock
//   result     the answer itself
// A call that is alive but silent is "quiet": said once, when it has been silent for twice the longest it usually
// takes (learned per tool from recent calls; tools.quietMinutes until there is history). Quiet is honest: nobody can
// tell thinking hard from stuck without progress, so the 9000 says so and offers to stop waiting; it never gives up on
// its own before tools.maxWaitMinutes.
//
// Each call: { id, room, tool, label, question, args, startedAt, lastAlive, lastProgress, progress, misses,
//              state: working | quiet | done | lost | gave_up | cancelled, finishedAt, by }

import * as config from '../config/index.js';

const PING_MS = 30_000, LOST_AFTER = 3, KEEP_FINISHED_MS = 10 * 60_000, SAMPLES = 20;

const calls = new Map();
let seq = 0;
const durations = new Map();   // tool -> recent durations in ms, newest last
const listeners = new Set();
export const onUpdate = fn => listeners.add(fn);
const emit = (call, event, text) => { for (const fn of listeners) try { fn(call, event, text); } catch (err) { console.error('Held listener:', err.message); } };

const key = (tool, args) => `${tool} ${JSON.stringify(args ?? {})}`;
const isError = text => /^Error/.test(String(text));

// How long a tool usually takes at worst: the 90th percentile of its recent calls (null with fewer than three).
export function usual(tool) {
  const list = [...(durations.get(tool) ?? [])].sort((a, b) => a - b);
  return list.length < 3 ? null : list[Math.min(list.length - 1, Math.floor(list.length * 0.9))];
}
export function record(tool, ms) {
  const list = durations.get(tool) ?? [];
  list.push(ms);
  if (list.length > SAMPLES) list.shift();
  durations.set(tool, list);
}
const quietAfter = tool => Math.max(60_000, usual(tool) ? 2 * usual(tool) : config.get('tools.quietMinutes') * 60_000);

// The calls a room is waiting on, and those that ended in the last few minutes (so the model can see what happened).
export function list(room) {
  const now = Date.now();
  for (const [id, c] of calls) if (c.finishedAt && now - c.finishedAt > KEEP_FINISHED_MS) calls.delete(id);
  return [...calls.values()].filter(c => room === undefined || c.room === room);
}
export const waiting = room => list(room).filter(c => !c.finishedAt);

// For the monitors: small, no arguments or results.
export const forScreen = room => waiting(room).map(c => ({ id: c.id, label: c.label, state: c.state, startedAt: c.startedAt,
  lastSign: Math.max(c.lastAlive ?? 0, c.lastProgress ?? 0) || c.startedAt, progress: c.progress ?? null }));

// Runs a tool that may be slow. start({ signal, onprogress, timeout }) -> Promise<text>; alive() -> Promise<boolean>.
// Resolves with the tool's answer if it comes within tools.holdSeconds, else with a note that it is held.
export function run({ room, tool, args, label, question, start, alive }) {
  const same = waiting(room).find(c => c.key === key(tool, args));
  if (same) return Promise.resolve(heldNote(same, true));
  const c = { id: `H${++seq}`, key: key(tool, args), room, tool, args, label: label || tool, question: String(question ?? '').slice(0, 200),
    startedAt: Date.now(), lastAlive: null, lastProgress: null, progress: null, misses: 0, state: 'working', held: false };
  const controller = new AbortController();
  c.abort = reason => { c.stopReason = reason; controller.abort(); };
  const answer = start({
    signal: controller.signal,
    timeout: config.get('tools.maxWaitMinutes') * 60_000,
    onprogress: p => {
      c.lastProgress = Date.now();
      c.progress = p?.message || (p?.total ? `${Math.round((100 * p.progress) / p.total)}%` : c.progress);
      if (c.state === 'quiet') { c.state = 'working'; c.quietSaid = false; }
      if (c.held) emit(c, 'progress');
    },
  }).catch(err => `Error: ${tool} failed (${err.message}).`);

  answer.then(text => {
    clearInterval(c.watch);
    if (c.finishedAt) return;   // already lost, cancelled or given up
    c.finishedAt = Date.now();
    if (!isError(text)) record(tool, c.finishedAt - c.startedAt);
    if (!c.held) return calls.delete(c.id);
    if (c.stopReason) return;   // said when it stopped
    c.state = 'done';
    emit(c, 'done', text);
  });

  return new Promise(resolve => {
    const hold = setTimeout(() => {
      if (c.finishedAt) return;
      c.held = true;
      calls.set(c.id, c);
      c.watch = setInterval(() => watch(c, alive), PING_MS);
      c.watch.unref?.();
      emit(c, 'held');
      resolve(heldNote(c));
    }, config.get('tools.holdSeconds') * 1000);
    answer.then(text => { if (!c.held) { clearTimeout(hold); resolve(text); } });
  });
}

async function watch(c, alive) {
  if (c.finishedAt) return clearInterval(c.watch);
  const ok = await alive().catch(() => false);
  if (c.finishedAt) return;
  const now = Date.now();
  if (ok) { c.lastAlive = now; c.misses = 0; }
  else if (++c.misses >= LOST_AFTER) return stop(c, 'lost');
  if (now - c.startedAt > config.get('tools.maxWaitMinutes') * 60_000) return stop(c, 'gave_up');
  const silentFor = now - (c.lastProgress ?? c.startedAt);
  if (ok && c.state === 'working' && !c.quietSaid && silentFor > quietAfter(c.tool)) {
    c.state = 'quiet';
    c.quietSaid = true;
    emit(c, 'quiet');
  } else emit(c, 'tick');
}

function stop(c, state, by) {
  clearInterval(c.watch);
  Object.assign(c, { state, finishedAt: Date.now(), ...(by && { by }) });
  c.abort(state);
  emit(c, state);
}

// Stop waiting for one (or every) held call in a room. -> the calls stopped.
export function cancel(room, id, by) {
  const hits = waiting(room).filter(c => !id || id === 'all' || c.id.toLowerCase() === String(id).toLowerCase());
  for (const c of hits) stop(c, 'cancelled', by);
  return hits;
}

const mins = ms => { const m = Math.round(ms / 60_000); return m < 1 ? 'under a minute' : m === 1 ? '1 minute' : `${m} minutes`; };
export const age = c => mins((c.finishedAt ?? Date.now()) - c.startedAt);

function heldNote(c, again) {
  return again
    ? `Held (${c.id}): that exact call is already running (${c.label}, started ${age(c)} ago). Do not call it again; its answer will be brought to you when it arrives.`
    : `Held (${c.id}): ${c.label} is still working after ${config.get('tools.holdSeconds')} s. That is normal for another agent or a long job, not a failure: it has not been cancelled or retried, and its answer will be brought to you when it arrives. Do not call it again. Tell the person in a few words that you are waiting on it, then carry on with what you can do meanwhile. waiting_on lists or cancels held calls.`;
}

// ---- tools for the model ----
export function tools() {
  return [{ name: 'waiting_on',
    description: 'The tool calls you are still waiting on (held because they are slow, e.g. another agent thinking), each with how long it has run, its last sign of life, and whether its server still answers; also those that ended in the last ten minutes. Give cancel (a held call id such as "H3", or "all") to stop waiting for one when the person asks.',
    inputSchema: { type: 'object', properties: { cancel: { type: 'string', description: 'Held call id to stop waiting for, or "all"' } } } }];
}
export const has = name => name === 'waiting_on';
export const describe = () => 'Checking what I am waiting on';
const STATE_WORDS = { working: 'working', quiet: 'quiet (its server answers, but no progress)', done: 'answered', lost: 'lost: its server stopped answering',
  gave_up: 'given up after the longest wait allowed', cancelled: 'cancelled' };
export function call(name, args = {}, hooks = {}) {
  const room = hooks.board?.room;
  if (args.cancel) {
    const stopped = cancel(room, args.cancel, hooks.person ? `${hooks.person} via HAL 9000` : 'HAL 9000');
    return stopped.length ? `Stopped waiting for ${stopped.map(c => `${c.id} (${c.label})`).join(', ')}.` : `Nothing held matches "${args.cancel}".`;
  }
  const all = list(room);
  if (!all.length) return 'You are not waiting on anything.';
  const now = Date.now();
  return all.map(c => {
    const sign = Math.max(c.lastAlive ?? 0, c.lastProgress ?? 0);
    return `${c.id} ${c.label}: ${STATE_WORDS[c.state]}, ${age(c)}${c.finishedAt ? '' : ' so far'}` +
      (c.progress ? `, last progress "${c.progress}"` : '') + (!c.finishedAt && sign ? `, last sign of life ${mins(now - sign)} ago` : '') +
      (!c.finishedAt && usual(c.tool) ? `, usually up to ${mins(usual(c.tool))}` : '') + (c.question ? ` (asked for: "${c.question}")` : '');
  }).join('\n');
}

// Snoozing and dismissing panels, wherever they come from: voice commands, the drilldown menu, the "s" key, and the
// model's tools all come through here. A situation-board panel is snoozed (shared, timed, lifts early if it gets
// worse); a panel on a one-off data board is simply removed from that board.

import * as boards from '../boards/index.js';
import * as snooze from './index.js';
import * as config from '../config/index.js';

export function spokenDuration(min) {
  if (min < 60) return `${min} minutes`;
  if (min < 48 * 60) { const h = Math.round(min / 60); return h === 1 ? 'an hour' : `${h} hours`; }
  const d = Math.round(min / 1440); return d === 1 ? 'a day' : `${d} days`;
}

// Which panel: a three-letter code, "this"/"that"/"it" (the panel being looked at), or words from its title or cluster.
export function findPanel(room, target, focus) {
  const board = boards.current(room);
  if (!board?.panels?.length) return null;
  const t = String(target ?? '').toLowerCase().replace(/\b(the|panel|problem|alerts?|board|one)\b/g, ' ').trim();
  if (!t || /^(this|that|it)$/.test(t)) return focus ? board.panels.find(p => p.code === focus) ?? null : null;
  return board.panels.find(p => p.code.toLowerCase() === t)
    ?? board.panels.find(p => t.split(/\s+/).every(w => `${p.title} ${p.cluster ?? ''} ${p.snooze?.label ?? ''}`.toLowerCase().includes(w)))
    ?? board.panels.find(p => t.split(/\s+/).some(w => w.length > 2 && `${p.title} ${p.cluster ?? ''}`.toLowerCase().includes(w)))
    ?? null;
}

// -> the sentence to say back.
export async function snoozePanel(room, { target, code, minutes, reason = '' }, { focus, actor, send } = {}) {
  minutes = Number(minutes) || Math.round(config.get('board.snoozeHours') * 60);
  const board = boards.current(room);
  const panel = code ? board?.panels.find(p => p.code === code) : findPanel(room, target, focus);
  if (!panel) return target && !/^(this|that|it)$/i.test(target) ? `I cannot find "${target}" on the monitors.` : 'Which panel? Say its code, or look at it first.';
  if (panel.code === 'ALL') return 'There is nothing on the board to snooze.';
  if (!board.home) {
    boards.removePanel(room, panel.code, send);
    return `Removed ${panel.title} from the board.`;
  }
  if (!panel.snooze) return `${panel.code} cannot be snoozed.`;
  await snooze.snooze({ ...panel.snooze, minutes, reason }, actor);
  return `Snoozed ${panel.snooze.label} for ${spokenDuration(minutes)}. It comes back sooner if it gets worse.`;
}

export async function unsnoozeByName(target, { actor } = {}) {
  const list = snooze.active();
  if (!list.length) return 'Nothing is snoozed.';
  const t = String(target ?? '').toLowerCase().replace(/\b(the|panel|problem|board)\b/g, ' ').trim();
  const hits = /^(all|everything)$/.test(t) ? list
    : list.filter(s => t.split(/\s+/).filter(w => w.length > 2).every(w => `${s.label} ${s.key}`.toLowerCase().includes(w)));
  if (!hits.length) return `Nothing snoozed matches "${target}". ${snooze.describe()}`;
  for (const s of hits) await snooze.unsnooze(s.key, actor);
  const names = hits.length > 2 ? `${hits.length} snoozed problems` : hits.map(s => s.label).join(' and ');
  return `${names[0].toUpperCase() + names.slice(1)} ${hits.length > 1 ? 'are' : 'is'} back: ${hits.length > 1 ? 'they return' : 'it returns'} to the board while ${hits.length > 1 ? 'they need' : 'it needs'} attention.`;
}

// ---- tools for the model ----
export function tools() {
  return [
    { name: 'snooze_problem',
      description: 'Snooze a known problem so it leaves the situation board for a while (it returns early if it gets worse), or take a panel off a one-off data board. Use when the person asks to snooze, hide, dismiss or silence a panel or problem.',
      inputSchema: { type: 'object', properties: {
        target: { type: 'string', description: 'The panel code, cluster or problem, e.g. "GAM" or "gaming error rate"; "this" for the panel being looked at' },
        hours: { type: 'number', description: 'How long, default 4' }, reason: { type: 'string' } }, required: ['target'] } },
    { name: 'unsnooze_problem',
      description: 'Bring a snoozed problem back onto the situation board ("all" for everything). The list of snoozed problems is in get_situation.',
      inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  ];
}
export const has = name => name === 'snooze_problem' || name === 'unsnooze_problem';
export const describe = name => (name === 'snooze_problem' ? 'Snoozing it' : 'Bringing it back');
// hooks: { board: { room, send }, person, focus }
export async function call(name, args = {}, hooks = {}) {
  const actor = hooks.person ? `${hooks.person} via HAL 9000` : 'HAL 9000';
  if (name === 'snooze_problem') return snoozePanel(hooks.board?.room, { target: args.target, minutes: args.hours ? Math.round(Number(args.hours) * 60) : undefined, reason: args.reason ?? '' },
    { focus: hooks.focus, actor, send: hooks.board?.send });
  return unsnoozeByName(args.target, { actor });
}

// The canvas (spec 2.0, docs/CANVAS.md §4, §6): a panel opened in place and reshaped by dragging. While open it is
// the person's own draft: only their monitor sees it change (read live for them, refreshed every 15 s), and every
// other monitor on the ship shows the panel as "being edited by …". Closing it with "Put up" replaces the panel on
// the board with the draft (history and all); "Discard" drops it. Drops are applied by the rules in public/drops.js:
// deterministic, recorded as diffs with who made them, undoable.
//
// Messages from a monitor ({ type: 'canvas', op, … }):
//   open { code }                 start a draft of that panel
//   drop { code, zone, item }     apply a drop (refused with a reason when the rules say no)
//   undo { code } / redo { code }
//   close { code, put }           put the draft up (put: true) or discard it
// To the drafting monitor: { type: 'draft', code, panel, view, why? } or { type: 'draft', code, refused } or
// { type: 'draft', code, closed: true }. To every monitor: { type: 'editing', code, by } (by: null when done).

import * as boards from './index.js';
import { toPanel, applyDiff, undo, redo } from './view.js';
import { opsFor } from '../public/drops.js';

const REFRESH_MS = 15_000;
const drafts = new Map();   // `${room}|${code}` -> { ws, room, code, by, view, timer }

const key = (room, code) => `${room}|${code}`;
const codeOf = c => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);

// The ship's monitors are told who is editing what; one joining later asks with editing(room).
export const editing = room => [...drafts.values()].filter(d => d.room === room).map(d => ({ code: d.code, by: d.by }));

async function show(d, why) {
  try {
    const panel = await boards.readView(d.room, d.view);
    if (d.ws.readyState === 1) d.ws.send(JSON.stringify({ type: 'draft', code: d.code, panel, view: d.view, ...(why && { why }) }));
  } catch (err) {
    if (d.ws.readyState === 1) d.ws.send(JSON.stringify({ type: 'draft', code: d.code, refused: `could not read it: ${err.message}` }));
  }
}
function end(d, broadcast) {
  clearInterval(d.timer);
  drafts.delete(key(d.room, d.code));
  broadcast({ type: 'editing', code: d.code, by: null });
}

// ws: the monitor's socket (with .user); broadcast(msg): to every monitor on the ship.
export async function handle(ws, room, msg, broadcast) {
  const code = codeOf(msg.code), person = ws.user?.name || ws.user?.email || 'someone at a monitor';
  const reply = m => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'draft', code, ...m }));
  const d = drafts.get(key(room, code));
  if (msg.op === 'open') {
    if (d && d.ws !== ws) return reply({ refused: `${d.by} is editing ${code}` });
    if (d) return show(d);
    const view = boards.current(room)?.panels.find(p => p.code === code)?.view;
    if (!view) return reply({ refused: `${code} can't be opened` });
    const draft = { ws, room, code, by: person, view };
    draft.timer = setInterval(() => show(draft), REFRESH_MS);
    draft.timer.unref?.();
    drafts.set(key(room, code), draft);
    broadcast({ type: 'editing', code, by: person });
    return show(draft);
  }
  if (!d || d.ws !== ws) return reply({ refused: `${code} isn't open here` });
  if (msg.op === 'drop') {
    const r = opsFor(String(msg.zone), msg.item ?? {}, d.view);
    if (r.refuse) return reply({ refused: r.refuse });
    try { d.view = applyDiff(d.view, r.ops, { by: person, why: r.why }); } catch (err) { return reply({ refused: err.message }); }
    return show(d, r.why);
  }
  if (msg.op === 'undo' || msg.op === 'redo') {
    const was = d.view;
    d.view = msg.op === 'undo' ? undo(d.view) : redo(d.view);
    return show(d, d.view === was ? `nothing to ${msg.op}` : `${msg.op === 'undo' ? 'undid' : 'redid'}: ${(msg.op === 'undo' ? d.view.redo : d.view.history).at(-1)?.why ?? ''}`);
  }
  if (msg.op === 'close') {
    end(d, broadcast);
    reply({ closed: true });
    if (msg.put && d.view.history?.length) {
      const panel = { ...toPanel(d.view), view: d.view };
      await boards.addPanel(room, panel, broadcast, panel.title).catch(err => console.error('Canvas put up:', err.message));
    }
  }
}

// A monitor that goes away leaves its drafts behind: they are dropped.
export function left(ws, broadcast) {
  for (const d of [...drafts.values()]) if (d.ws === ws) end(d, broadcast);
}

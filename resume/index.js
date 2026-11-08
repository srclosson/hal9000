// Picking up where it left off after a restart (a rollout): each part of the 9000 that holds state registers what to
// keep and how to take it back.
//   conversations    what was said in each room (brain.js)
//   monitors         each room's settings (voice, alerts muted, ship systems) and the board its screens show (server.js, boards/)
//   situation board  findings, runbooks and confidence forecasts per problem, so nothing is dug again (home/)
//   open work        plans awaiting approval, reminders and watches, acknowledged alerts, scorecard cases
//
// Each part is kept as its own document in StackGen Incidents (scope "hal9000-resume-<part>", each under its 200 KB
// limit), written when it changed: every minute, and once more when Kubernetes stops the pod (SIGTERM), so a rollout
// loses at most what happened in its last seconds. Read back once at start, before the rooms open.
// Outside a cluster (a laptop with the shared credentials) nothing is read or written, as capabilities/ does.

import * as config from '../config/index.js';

const SAVE_MS = 60_000, LIMIT = 190_000;
const IN_CLUSTER = !!process.env.KUBERNETES_SERVICE_HOST;
const parts = new Map();   // name -> { save() -> json, restore(json) }
const written = new Map();   // name -> the JSON last written
// Parts whose kept state could not be read (Incidents slow or down at start). Such a part is never written until a
// read succeeds: its state here is near empty, and writing it would overwrite what was kept with nothing.
const unread = new Set();
let store = {   // replaced in tests
  load: name => (IN_CLUSTER ? config.loadDoc(`hal9000-resume-${name}`) : Promise.resolve(null)),
  save: (name, doc) => (IN_CLUSTER ? config.saveDoc(`hal9000-resume-${name}`, doc) : Promise.resolve(false)),
};
export const setStore = s => { store = s; written.clear(); unread.clear(); };

// register(name, { save, restore }): save() returns plain JSON (or null for nothing); restore(json) takes it back.
export const register = (name, part) => parts.set(name, part);

// At start: each registered part gets what was kept for it. Returns the names restored.
export async function restore(names = [...parts.keys()]) {
  const done = [];
  await Promise.all(names.map(async name => {
    const part = parts.get(name);
    let doc;
    try { doc = await store.load(name); } catch (err) {
      unread.add(name);
      console.error(`Resume: ${name} not restored (kept as it was until it can be read): ${err.message}`);
      return;
    }
    unread.delete(name);
    if (!doc?.data) return;
    try {
      written.set(name, JSON.stringify(doc.data));
      await part.restore(doc.data, doc.at);
      done.push(name);
    } catch (err) { console.error(`Resume: ${name} not restored: ${err.message}`); }
  }));
  if (done.length) console.log(`Resume: picked up ${done.sort().join(', ')} from before the restart`);
  return done;
}

// Write the parts that changed since they were last written. A part not read yet is read first (late, merged by its
// own restore) and written only once that has worked.
export async function save() {
  if (unread.size) await restore([...unread]);
  await Promise.all([...parts].filter(([name]) => !unread.has(name)).map(async ([name, part]) => {
    try {
      const data = part.save() ?? null, json = JSON.stringify(data);
      if (written.get(name) === json) return;
      if (json.length > LIMIT) { console.error(`Resume: ${name} is too large to keep (${json.length} bytes)`); return; }
      await store.save(name, { at: Date.now(), data });
      written.set(name, json);
    } catch (err) { console.error(`Resume: ${name} not saved: ${err.message}`); }
  }));
}

// Every minute, and on SIGTERM (then exit; Kubernetes waits up to 30 s, the save is given 8).
export function start() {
  setInterval(() => save(), SAVE_MS).unref();
  process.once('SIGTERM', async () => {
    console.log('Resume: stopping; keeping where we are');
    await Promise.race([save(), new Promise(r => setTimeout(r, 8000))]);
    process.exit(0);
  });
}

// Keep the newest items of a list within a size: drop from the front until its JSON fits.
export function fit(list, bytes) {
  const out = [...list];
  while (out.length && JSON.stringify(out).length > bytes) out.shift();
  return out;
}

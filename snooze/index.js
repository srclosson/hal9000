// Snoozed problems: known irritants the team has chosen to stop seeing for a while. A snooze covers one problem,
// a cluster's signal (e.g. gaming-prod-cluster/ERR), for a time (4 hours by default), and lifts early if the problem
// gets worse than when it was snoozed. Stored in StackGen Incidents so every ship shares them and they survive
// restarts (with who and why); kept in memory here if that service is unreachable.

const URL_ = (process.env.INCIDENTS_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.INCIDENTS_TOKEN;
const remote = () => !!(URL_ && TOKEN);

let cache = [];            // [{ key, label, level, value, until, reason, created_by }]
let local = new Map();     // fallback when the service is unavailable
let changed = () => {};
export const onChange = fn => { changed = fn; };

async function call(path, { method = 'GET', body, actor } = {}) {
  const res = await fetch(`${URL_}${path}`, { method, signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Actor': actor || 'HAL 9000' },
    body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function refresh() {
  if (!remote()) return;
  try { cache = await call('/api/snoozes'); } catch { /* keep the last copy */ }
}
setInterval(refresh, 60_000).unref();
refresh();

export function active() {
  const now = Date.now();
  for (const [k, s] of local) if (Date.parse(s.until) <= now) local.delete(k);
  return [...cache.filter(s => Date.parse(s.until) > now), ...[...local.values()].filter(s => !cache.some(c => c.key === s.key))];
}

export const keyOf = (cluster, signal) => `${cluster}/${signal}`;

// Snoozed and not yet worse than when it was snoozed.
export function isSnoozed(cluster, signal, level) {
  const s = active().find(x => x.key === keyOf(cluster, signal));
  return !!s && (level ?? 0) <= s.level;
}

export async function snooze({ key, label, level = 1, value = null, minutes = 240, reason = '' }, actor) {
  const rec = { key, label, level, value, minutes, reason };
  try {
    if (!remote()) throw new Error('no service');
    await call('/api/snoozes', { method: 'POST', body: rec, actor });
    await refresh();
  } catch {
    local.set(key, { ...rec, until: new Date(Date.now() + minutes * 60_000).toISOString(), created_by: actor });
  }
  changed();
}

export async function unsnooze(key, actor) {
  local.delete(key);
  try { if (remote()) { await call(`/api/snoozes/${encodeURIComponent(key)}`, { method: 'DELETE', actor }); await refresh(); } }
  catch { cache = cache.filter(s => s.key !== key); }
  changed();
}

export function describe() {
  const list = active();
  if (!list.length) return 'Nothing is snoozed.';
  return `Snoozed (hidden from the situation board until the time shown, or sooner if it gets worse):\n- ` +
    list.map(s => `${s.label} until ${new Date(s.until).toISOString().slice(0, 16).replace('T', ' ')}Z${s.created_by ? ` by ${s.created_by}` : ''}${s.reason ? ` (${s.reason})` : ''}`).join('\n- ');
}

// "for 2 hours", "for 30 minutes", "until tomorrow", "for a day" -> minutes (default 240).
export function parseDuration(text) {
  const t = String(text ?? '').toLowerCase();
  const n = t.match(/(\d+(?:\.\d+)?|an?|one|two|three|four|six|twelve)\s*(minute|min|hour|hr|h\b|day|week)/);
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
  if (n) {
    const q = words[n[1]] ?? parseFloat(n[1]);
    return Math.round(q * ({ minute: 1, min: 1, hour: 60, hr: 60, h: 60, day: 1440, week: 10080 })[n[2]]);
  }
  if (/tomorrow|overnight/.test(t)) return 16 * 60;
  return 240;
}

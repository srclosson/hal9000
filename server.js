// Static file server + WebSocket relay.
// A "room" is one ship: one eye (phone) and any number of monitors.
// Clients send partial state; the server merges it and broadcasts to the room.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { respond, mindName } from './brain.js';
import { models as llmModels, signature as llmSignature } from './llm/index.js';
import { parseCommand, SYSTEM_CODES } from './commands.js';
import * as tts from './tts/index.js';
import * as mcp from './mcp/index.js';
import * as boards from './boards/index.js';
import * as drill from './drill.js';
import * as auth from './auth.js';
import * as snooze from './snooze/index.js';
import * as config from './config/index.js';
import * as mcpStatus from './mcp/index.js';
import * as snoozing from './snooze/actions.js';
import * as watch from './alerts/watch.js';
import * as home from './home/index.js';
import * as aiden from './aiden/index.js';
import * as alertRules from './alerts/index.js';
import * as incidentsApi from './incidents/index.js';
import * as fixes from './fixes/index.js';
import * as timeline from './timeline/index.js';
import * as memory from './memory/index.js';
import * as self from './self/index.js';

const PORT = Number(process.env.PORT) || 9000;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return 'localhost';
}

// ---- settings page API ----
// The chosen provider's models (llm/index.js), cached for five minutes per provider, endpoint and key.
let modelsCache = { at: 0, sig: '', list: [] };
async function models() {
  const sig = llmSignature();
  if (sig === modelsCache.sig && Date.now() - modelsCache.at < 5 * 60_000) return modelsCache.list;
  const list = await llmModels();
  modelsCache = { at: Date.now(), sig, list };
  return list;
}
async function settingsApi(req, res, url) {
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const u = auth.user(req);
  const person = auth.enabled ? (u.automation ? null : u.name || u.email) : 'local';
  let raw = ''; for await (const c of req) raw += c;
  const b = raw ? JSON.parse(raw) : undefined;
  try {
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return send(200, { schema: config.pageSchema(), values: config.forPage(), secretsSet: config.secretsSet(), stored: config.stored(), canSave: config.available(),
        models: await models(), mcp: mcpStatus.status(), duplicates: Object.fromEntries((await config.mcp('', {}).catch(() => [])).map(r => [r.name, mcpStatus.duplicateOf(r.name)]).filter(([, d]) => d)), mind: mindName(), version: process.env.npm_package_version });
    }
    if (url.pathname === '/api/settings' && req.method === 'PUT') {
      if (!person) return send(403, { error: 'only a signed-in person can change settings' });
      await config.save(b?.values, `${person} (HAL 9000 settings)`);
      return send(200, { values: config.forPage(), mind: mindName() });
    }
    // MCP servers: passed through to StackGen Incidents, acting for the signed-in person.
    if (url.pathname.startsWith('/api/mcp-servers')) {
      if (req.method !== 'GET' && !person) return send(403, { error: 'only a signed-in person can change MCP servers' });
      return send(200, await config.mcp(url.pathname.slice('/api/mcp-servers'.length), { method: req.method, body: b, actor: `${person ?? 'HAL 9000'} (HAL 9000 settings)` }));
    }
    send(404, { error: 'not found' });
  } catch (err) { send(400, { error: err.message }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Sign-in (auth.js): pages redirect to the identity provider, everything else needs the session cookie.
  if (await auth.handle(req, res, url)) return;
  if (!auth.isPublic(url.pathname) && !auth.user(req)) {
    if (url.pathname === '/' || /^\/(eye|monitor|settings)(\.html)?$|^\/index\.html$/.test(url.pathname)) {
      res.writeHead(302, { Location: `/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
    } else res.writeHead(401, { 'Cache-Control': 'no-store' });
    return res.end();
  }

  // Synthesized speech for the eye. Waits until the clip is ready (it is usually still being made).
  const clipMatch = url.pathname.match(/^\/tts\/([a-f0-9]{24})$/);
  if (clipMatch) {
    const clip = await tts.clip(clipMatch[1]);
    if (!clip) { res.writeHead(502, { 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': clip.type, 'Content-Length': clip.audio.length, 'Cache-Control': 'private, max-age=600' });
    return res.end(clip.audio);
  }

  // Settings (/settings): general settings from config/index.js, and MCP servers kept in StackGen Incidents.
  if (url.pathname.startsWith('/api/settings') || url.pathname.startsWith('/api/mcp-servers')) return settingsApi(req, res, url);

  // The metric browser on the monitors: metric names (for a cluster, or all) with type and help.
  if (url.pathname === '/api/metrics' && req.method === 'GET') {
    const out = await boards.browse({ cluster: (url.searchParams.get('cluster') ?? '').slice(0, 120) }).catch(() => null);
    res.writeHead(out ? 200 : 503, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(out ?? { error: 'Prometheus is not reachable through the metrics MCP server' }));
  }

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  // QR code for pairing, rendered server-side so the monitor needs no extra library.
  if (url.pathname === '/qr.svg') {
    const svg = await QRCode.toString(url.searchParams.get('data') ?? '', {
      type: 'svg', margin: 1, color: { dark: '#000000', light: '#ffffff' },
    });
    res.writeHead(200, { 'Content-Type': MIME['.svg'], 'Cache-Control': 'no-store' });
    return res.end(svg);
  }

  // Tells the monitor which host the phone should use. Behind an ingress that's the public
  // hostname as requested; only a localhost monitor needs the LAN address instead.
  if (url.pathname === '/api/lan') {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(req.headers.host ?? '');
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    // pair: a short-lived pass for the eye QR code, so the phone is signed in as whoever scanned it.
    return res.end(JSON.stringify({ host: local ? `${lanAddress()}:${PORT}` : req.headers.host, pair: auth.pairToken(auth.user(req)) }));
  }

  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (file === '/eye' || file === '/monitor' || file === '/settings') file += '.html';
  const full = path.join(ROOT, path.normalize(file));
  if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end(); }

  try {
    const body = await fs.readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ---- rooms ---------------------------------------------------------------

const rooms = new Map(); // code -> { state, clients: Set<ws> }

const defaultState = () => ({
  theme: config.get('persona.defaultVoice'),   // 'hal' (red) | 'sal' (blue); from settings
  mode: 'idle',      // 'idle' | 'listening' | 'speaking' | 'alert' | 'offline'
  pulse: 0,          // 0..1 instantaneous voice level, driven by the eye while speaking
  line: '',          // last thing the computer said
  alarm: null,       // { uid, title, severity, cluster, since } while an announced alert is firing (red eye)
  proactive: true,   // speak up unprompted when alerts fire ("mute alerts" turns this off)
  focus: null,       // story-tour panel the monitors are zoomed to
  systems: false,    // true while the ship shows COM...MEM instead of the situation board ("show the ship systems")
});

function room(code) {
  if (!rooms.has(code)) rooms.set(code, { state: defaultState(), clients: new Set() });
  return rooms.get(code);
}

function roster(r) {
  return [...r.clients].map(c => ({ id: c.id, role: c.role, panel: c.panel }));
}

// The eye's camera runs only while at least one monitor shows the EYE panel, or the 9000 is taking a look.
function updateCamera(r) {
  const on = [...r.clients].some(c => c.watching) || r.glancing > 0;
  if (on === !!r.camera) return;
  r.camera = on;
  for (const c of r.clients) if (c.role === 'eye' && c.readyState === 1) c.send(JSON.stringify({ type: 'camera', on }));
}

function broadcast(r, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of r.clients) if (c !== except && c.readyState === 1) c.send(data);
}

// Everything the 9000 says goes through here: text for the monitors, audio parts for the eye
// (none when there is no speech provider, and the eye uses browser speech instead).
// interim: a holding line ("One moment.") spoken while the real answer is still being worked on.
// extra: what the chat drawer shows with the reply (the steps taken, the board put up).
function say(r, text, interim = false, extra = {}) {
  broadcast(r, { type: 'say', text, interim, parts: tts.prepare(text, r.state.theme === 'hal' ? 'hal' : 'sal') });
  if (!interim) chat(r, { from: 'computer', text, ...extra });
}

// ---- the ship's conversation, for the monitors' chat drawer ----
// Every question and reply, newest last, shared by all the ship's monitors (a monitor joining later gets the history).
// Kept in memory for the last CHAT_MAX messages; it goes when the server restarts.
const CHAT_MAX = 100;
function chat(r, entry) {
  r.chat ??= [];
  r.chatId = (r.chatId ?? 0) + 1;
  const e = { id: r.chatId, at: Date.now(), ...entry };
  r.chat.push(e);
  if (r.chat.length > CHAT_MAX) r.chat.shift();
  broadcast(r, { type: 'chat', entry: e });
  return e;
}

// A guided tour of a story board: each panel's narration in turn, then the closing line. Every clip carries the
// panel it's about ("focus"); the eye announces each focus as it starts playing it and the monitors zoom to that
// panel. Without speech synthesis the clips are text-only and the eye speaks them with browser speech.
// A narration that talks about a change ("checkout-api rolled out at 14:02") lights that change's mark on its panel.
const CHANGE_WORDS = { deploy: /deploy|roll(ed|ing)? ?out|release|new version|image/i, rollback: /roll(ed|ing)? ?back/i,
  scale: /scal(ed|ing)|replica/i, config: /config/i, upgrade: /upgrad/i,
  // timeline events
  alert: /fired|started firing|alert/i, resolve: /cleared|resolved|recovered/i, ack: /acknowledg/i, aiden: /aiden/i,
  plan: /plan|approved|restart(ed)?|fix/i, incident: /incident|declared|identified|severity/i, change: /deploy|roll(ed|ing)? ?out|scal|config|change/i };
const LABEL_KIND = { DEPLOY: 'deploy', ROLLBACK: 'rollback', SCALE: 'scale', CONFIG: 'config', UPGRADE: 'upgrade' };
function markFor(code, panel, text) {
  const p = boards.current(code)?.panels.find(x => x.code === panel);
  // Trend marks, or the rows of a "what changed" timeline ("DEPLOY checkout-api v2.4.0").
  const marks = p?.marks ?? (p?.kind === 'timeline' ? (p.events ?? []).map(e => ({ t: e.t, kind: e.kind, service: '', label: e.label, relevant: true })) : null) ?? (p?.events ?? []).map(e => {
    const [word, service] = String(e.label).split(' ');
    return { t: Date.parse(e.time), kind: LABEL_KIND[word?.toUpperCase()], service: LABEL_KIND[word?.toUpperCase()] ? service : '', relevant: true };
  }).filter(m => m.kind && Number.isFinite(m.t));
  // The sentence has to be about the change (its kind, or "changed", "since", "after"), not just name the service.
  const aboutChange = /chang|since|after|follow|began|started/i.test(text);
  const best = marks.map(m => {
    const kind = !!CHANGE_WORDS[m.kind]?.test(text), svc = !!m.service && text.toLowerCase().includes(m.service.toLowerCase());
    // Words the sentence shares with the event's own label ("Aiden: config reload…", "Plan P-2 approved by Stephanie").
    const shared = m.label ? new Set(String(m.label).toLowerCase().match(/[a-z0-9-]{4,}/g) ?? []) : new Set();
    const overlap = [...shared].filter(wd => text.toLowerCase().includes(wd)).length;
    return { m, ok: kind || (svc && aboutChange), s: (svc ? 2 : 0) + (kind ? 1.5 : 0) + (m.relevant ? .5 : 0) + overlap * .4 };
  }).filter(x => x.ok).sort((a, b) => b.s - a.s)[0];
  return best ? best.m.t : null;
}

function sayTour(r, tour, closing, extra = {}, code) {
  const theme = r.state.theme === 'hal' ? 'hal' : 'sal';
  const segments = [...tour.map(t => ({ text: t.text, focus: t.code, mark: code ? markFor(code, t.code, t.text) : null })), ...(closing ? [{ text: closing, focus: null, mark: null }] : [])];
  const parts = segments.flatMap(seg => (tts.prepare(seg.text, theme) ?? [{ text: seg.text }]).map(p => ({ ...p, focus: seg.focus, mark: seg.mark })));
  const text = segments.map(s => s.text).join(' ');
  broadcast(r, { type: 'say', text, parts, tour: true });
  chat(r, { from: 'computer', text, ...extra });

  // No eye to pace the tour: step the monitors along on estimated speaking time instead.
  if (![...r.clients].some(c => c.role === 'eye')) {
    let at = 0;
    for (const seg of segments) {
      setTimeout(() => { Object.assign(r.state, { focus: seg.focus, focusMark: seg.mark }); broadcast(r, { type: 'state', state: { focus: seg.focus, focusMark: seg.mark } }); }, at);
      at += 900 + seg.text.length * 65;
    }
    setTimeout(() => { Object.assign(r.state, { focus: null, focusMark: null }); broadcast(r, { type: 'state', state: { focus: null, focusMark: null } }); }, at);
  }
  return text;
}

// ---- the views a ship can show, for the monitors' view picker ----
// Situation (when Grafana is connected), the ship systems, then recent boards and stories, newest first.
function viewsFor(code, r) {
  const list = [
    ...(home.current() ? [{ id: 'situation', title: 'Situation', kind: 'home' }] : []),
    { id: 'systems', title: 'Ship systems', kind: 'systems' },
    ...boards.views(code),
  ];
  const current = boards.activeId(code) ?? (r.state.systems || !home.current() ? 'systems' : 'situation');
  return { type: 'views', views: list, current };
}
function sendViews(code) {
  const r = rooms.get(code);
  if (r) broadcast(r, viewsFor(code, r));
}
boards.onViewsChange(sendViews);

// A monitor picked a view: the situation board, the ship systems, or a remembered board (shown live again).
async function showView(code, r, id) {
  if (id === 'situation' || id === 'systems') {
    setState(r, { systems: id === 'systems' });
    if (!boards.stop(code, msg => broadcast(r, msg))) broadcast(r, { type: 'board', board: boards.homeFor(code) });
    sendViews(code);
  } else if (!(await boards.reopen(code, id, msg => broadcast(r, msg)))) {
    sendViews(code);   // no longer remembered: refresh the list
  }
}

function setState(r, patch) {
  Object.assign(r.state, patch);
  broadcast(r, { type: 'state', state: patch });
}

// Think about something and answer it: a person's question, or an [Automatic: ...] prompt from the alert watcher.
// Shows progress on the monitors, says "One moment." once tools start, then speaks the answer (as a guided tour
// when a story board was built).
// What the person is looking at: a panel they opened a drilldown on or asked about (explicit), else the panel under
// their mouse or open in Single mode on a monitor. Fresh for FOCUS_MS, so a later question isn't pinned to it.
const FOCUS_MS = 2 * 60_000;
function focusLine(r, code, about) {
  const f = about ? { code: about, explicit: true } : r.focus && Date.now() - r.focus.at < FOCUS_MS ? r.focus : null;
  const info = f && boards.panelInfo(code, f.code);
  if (!info) return '';
  return f.explicit ? `; this question is about panel ${info.line}` : `; the person is looking at panel ${info.line}`;
}

function converse(r, code, text, tz, about, person) {
  // A panel named in the question ("the VIT panel") is what it is about, with its queries, so it can be reworked.
  if (!about && !text.startsWith('[Automatic')) {
    const codes = boards.current(code)?.panels.map(p => p.code) ?? [];
    about = codes.find(c => new RegExp(`\\b${c}\\b`).test(text)) ?? codes.find(c => new RegExp(`\\b${c}\\b`, 'i').test(text) && /panel/i.test(text));
  }
  setState(r, { mode: 'thinking' });
  let acknowledged = false;
  const steps = [], boardBefore = boards.activeId(code);   // for the chat drawer
  const hooks = {
    focus: about ?? (r.focus && Date.now() - r.focus.at < FOCUS_MS ? r.focus.code : undefined),   // the panel being looked at
    person,   // the signed-in person asking, if known
    alarm: () => r.state.alarm,   // the alert this ship is alarming about, for plans
    board: { room: code, send: msg => broadcast(r, msg) },   // live data boards for this ship
    screen: () => {
      const b = boards.current(code), al = r.state.alarm;
      // The alarm, so "open an incident" links the incident to the alert (alert_uid).
      const alarm = al ? `; ALARM: the alert "${al.title}" (uid ${al.uid}) is firing${al.ack ? `, acknowledged by ${al.ack.by}` : ', not yet acknowledged'}` : '';
      if (r.state.systems && !boards.hasActive(code)) return `the ship systems (COM to MEM)${alarm}`;
      return b ? `${b.home ? 'the situation board' : `the "${b.title}" board`} (${b.panels.map(p => p.code).join(', ')})${focusLine(r, code, about)}${alarm}`
        : `the ship systems (COM to MEM)${alarm}`;
    },
    activity: label => {
      if (!acknowledged) { acknowledged = true; say(r, 'One moment.', true); }
      broadcast(r, { type: 'activity', text: label });   // after the holding line, so it stays on screen
      // "Fetching a slow trace" then "Fetching a slow trace for checkout-api": keep the fuller one.
      if (steps.length && label.startsWith(steps.at(-1))) steps[steps.length - 1] = label;
      else if (steps.length < 12 && steps.at(-1) !== label) steps.push(label);
    },
  };
  return respond(code, text, r.state.theme, hooks, tz).then(reply => {
    const tour = boards.takeTour(code), id = boards.activeId(code), b = boards.current(code);
    // A board this answer put up (or changed) becomes a chip in the chat that brings it back.
    const extra = { steps, ...(id && b && (id !== boardBefore || steps.length) && { board: { id, title: b.title, story: !!b.story } }) };
    if (tour?.length) reply = sayTour(r, tour, reply, extra, code);
    else say(r, reply, false, extra);
    // The eye drives speaking/idle; with no eye present, settle back to idle here.
    if (![...r.clients].some(c => c.role === 'eye')) setState(r, { mode: 'idle', line: reply });
  });
}

// ---- speaking up unprompted (alerts/watch.js) ----
// A rule starts firing: every ship with announcements on gets the alarm (red eye, ALERT badge), an immediate
// heads-up, then the investigation and story. When it stops firing, ships that were told hear that it cleared.
const spokenName = r => (r.title ?? 'unnamed').split(' — ')[0].trim();
const spokenCluster = c => String(c ?? '').replace(/-prod(-cluster)?$|-cluster$/, '').replace(/-/g, ' ');

function announceFiring(fired) {
  const lead = fired[0], l = lead.labels ?? {};
  const others = fired.length - 1;
  // The most severe one also goes to Aiden for a deep investigation, once, whichever ships hear it.
  const deep = config.get('aiden.autoInvestigate') === 'on' && !!aiden.investigate(lead);
  for (const [code, r] of rooms) {
    if (!r.clients.size || r.state.proactive === false) continue;
    r.announced ??= new Set();
    fired.forEach(a => r.announced.add(a.uid));
    setState(r, { alarm: { uid: lead.uid, title: spokenName(lead), severity: l.severity ?? 'critical', cluster: l.cluster ?? null, since: Date.now() } });
    const where = spokenCluster(l.cluster) ? ` in the ${spokenCluster(l.cluster)} cluster` : '';
    say(r, `Excuse me. The ${spokenName(lead)} alert has just started firing${where}` +
      (others ? `, along with ${others} other alert${others > 1 ? 's' : ''}` : '') + '. I am looking into it now.');
    const list = fired.map(a => `"${a.title}" (uid ${a.uid}, ${a.labels?.severity ?? 'unknown'})`).join('; ');
    converse(r, code, `[Automatic: these alerts just started firing: ${list}. Investigate the most severe one now and tell its story on the monitors with show_story. You have already told the person you are looking into it, so do not repeat that.${deep ? ' Aiden is also investigating it in depth; do not call aiden_investigate.' : ''}]`, r.tz)
      .then(() => { if (deep) attachAiden(code, lead.uid); });   // after the story is up, so its panel joins the story board
  }
}

// ---- acknowledging the alarm ----
// Someone has it: one acknowledgement per alert, shared by every ship. The red eye and the ALERT badge calm to a
// steady glow; the story, the board and Aiden carry on. It goes on the incident for that alert (now, or when one is
// opened), which gives time to acknowledge. The alarm comes back if a new alert fires, or if this one is still firing
// alerts.ackMinutes later while its incident hasn't moved on to identified or monitoring.
const acks = new Map();   // alert uid -> { by, at, firedAt, title }
// For timelines: acknowledgements of alerts since cleared, and when each alert cleared.
const ackHistory = new Map(), clearedAt = new Map();
timeline.configure({ facts: uid => {
  const out = [], a = acks.get(uid) ?? ackHistory.get(uid);
  if (a) out.push({ t: a.at, kind: 'ack', label: `Acknowledged by ${a.by}` });
  if (clearedAt.has(uid)) out.push({ t: clearedAt.get(uid), kind: 'resolve', label: 'Alert cleared' });
  // When the 9000 raised the alarm on the monitors (the first ship to show it).
  const raised = Math.min(...[...rooms.values()].filter(r => r.state.alarm?.uid === uid).map(r => r.state.alarm.since));
  if (Number.isFinite(raised)) out.push({ t: raised, kind: 'alert', label: 'Alarm raised on the monitors' });
  return out;
} });
const clockOf = t => new Date(t).toISOString().slice(11, 16) + ' UTC';
async function acknowledge(r, person) {
  const alarm = r.state.alarm;
  if (!alarm) return say(r, 'Nothing is alarming right now.');
  if (alarm.ack) return say(r, `${alarm.ack.by === person ? 'You' : alarm.ack.by} acknowledged it at ${clockOf(alarm.ack.at)}. I am still watching it.`);
  const ack = { by: person ?? 'someone at a monitor', at: Date.now() };
  acks.set(alarm.uid, { ...ack, firedAt: alarm.since, title: alarm.title });
  for (const [, ship] of rooms) if (ship.state.alarm?.uid === alarm.uid) setState(ship, { alarm: { ...ship.state.alarm, ack } });
  const inc = await incidentsApi.openForAlert(alarm.uid).catch(() => null);
  if (inc) await incidentsApi.acknowledge(inc.ref, { by: ack.by, at: new Date(ack.at).toISOString(), detected_at: new Date(alarm.since).toISOString() }, `${ack.by} via HAL 9000`).catch(err => console.error('Acknowledge → Incidents:', err.message));
  say(r, inc ? `Acknowledged, and noted on ${inc.ref}. I will keep watching it.`
    : 'Acknowledged. I will keep watching it. Say "open an incident" if you want one.');
}
setInterval(async () => {
  const limit = config.get('alerts.ackMinutes') * 60_000;
  for (const [uid, a] of acks) {
    if (Date.now() - a.at < limit) continue;
    const ships = [...rooms.values()].filter(ship => ship.state.alarm?.uid === uid);
    if (!ships.length) { acks.delete(uid); continue; }
    const inc = await incidentsApi.openForAlert(uid).catch(() => null);
    if (['identified', 'monitoring'].includes(inc?.status)) continue;   // it is being dealt with
    acks.delete(uid);
    const mins = Math.round((Date.now() - a.at) / 60_000);
    for (const ship of ships) {
      const { ack, ...alarm } = ship.state.alarm;
      setState(ship, { alarm });
      say(ship, `The ${a.title} alert is still firing, ${mins} minutes after ${a.by} acknowledged it${inc ? `, and ${inc.ref} is still ${inc.status}` : ''}.`);
    }
  }
}, 60_000).unref();

// Open incidents, for the monitors' incident button: the alarm's own first, then by severity. Checked every 30 s.
const INCIDENTS_PUBLIC = (process.env.INCIDENTS_PUBLIC_URL || 'https://incidents.stackgen.run').replace(/\/$/, '');
let incidentsShown = '', incidentsState = null;   // the last list sent, for ships that join later
setInterval(async () => {
  if (!incidentsApi.available()) return;
  const list = await incidentsApi.listOpen().catch(() => null);
  if (!list) return;
  const open = list.slice(0, 8).map(i => ({ ref: i.ref, title: i.title, severity: i.severity, status: i.status, at: i.created_at,
    alertUid: i.alert_uid, ackBy: i.acknowledged_by, url: `${INCIDENTS_PUBLIC}/incidents/${i.ref}` }));
  const json = JSON.stringify(open);
  if (json === incidentsShown) return;
  incidentsShown = json;
  incidentsState = { open, total: list.length, home: INCIDENTS_PUBLIC };
  for (const [, ship] of rooms) setState(ship, { incidents: incidentsState });
}, 30_000).unref();

// ---- fixes: plans the 9000 proposes, shown on the monitors, run only once a signed-in person approves ----
// Who may decide: a person signed in (on a monitor, or speaking through an eye signed in as them). Never the
// automation token. With sign-in off (local testing), only if ALLOW_UNSIGNED_APPROVAL=1.
function approverOf(ws) {
  if (auth.enabled) return ws.user && !ws.user.automation ? ws.user.name : null;
  return process.env.ALLOW_UNSIGNED_APPROVAL === '1' ? 'local tester' : null;
}
function decidePlan(r, ws, id, decision, hash) {
  const person = approverOf(ws);
  if (!person) return say(r, 'Only a signed-in person can decide a plan. Sign in on this monitor, then decide it on the screen.');
  const reply = fixes.decide(id, decision, person, hash);
  if (!/approved by|rejected\.$/.test(reply)) say(r, reply);   // approvals and rejections are spoken by the plan's own updates
}
// What the monitors get: the whole plan, so the card shows the exact calls that will run.
const planView = p => p && ({ id: p.id, title: p.title, problem: p.problem, status: p.status, words: fixes.statusWords(p), hash: p.hash, destructive: p.destructive,
  steps: p.steps.map(s => ({ tool: s.tool, server: s.server, args: s.args, why: s.why, status: s.status, result: s.result })),
  expected: p.expected, risk: p.risk, verify: p.verify, undo: p.undo, createdAt: p.createdAt, expiresAt: p.expiresAt, decidedBy: p.decidedBy, note: p.note });
const SPOKEN = {
  approved: p => `Approved by ${p.decidedBy}. Running plan ${p.id}.`,
  rejected: p => `Understood. Plan ${p.id} is withdrawn; nothing was changed.`,
  expired: p => `Plan ${p.id} expired without a decision; nothing was changed.`,
  failed: p => `Plan ${p.id} failed. ${p.note ?? ''}${p.undo?.length ? ' The undo is ready to propose from the plan card.' : ''}`,
  done: p => `Plan ${p.id} has run. ${p.expected ? `I have no automatic check, so watch for: ${p.expected}` : ''}`,
  verified: p => `Plan ${p.id} worked: the check held, at ${+Number(p.verify.now).toPrecision(3)} against ${p.verify.expect} ${p.verify.value}.`,
  unverified: p => `Plan ${p.id} ran, but the expected change has not shown after ${p.verify.minutes} minutes (now ${Number.isFinite(p.verify.now) ? +Number(p.verify.now).toPrecision(3) : 'no data'}).${p.undo?.length ? ' The undo is ready to propose from the plan card.' : ''}`,
};
fixes.onChange(p => {
  const r = rooms.get(p.room);
  if (!r) return;
  setState(r, { plan: planView(p) });
  // A new plan is put on the board (one place beyond the usual six), so it is always on a screen while it matters.
  if (p.status === 'pending' && !p.shown) {
    p.shown = true;
    boards.addPanel(p.room, { code: 'PLN', kind: 'plan', title: `Plan · ${p.title}`, planId: p.id }, msg => broadcast(r, msg), `Plan · ${p.title}`, { extra: true })
      .catch(err => console.error('Plan panel:', err.message));
  }
  if (p.spoken !== p.status && SPOKEN[p.status]) { p.spoken = p.status; sayWhenQuiet(r, SPOKEN[p.status](p).trim()); }
  if (['approved', 'failed', 'done', 'verified', 'unverified'].includes(p.status) && p.recorded !== p.status) {
    p.recorded = p.status;
    recordPlan(p).catch(err => console.error('Plan → Incidents:', err.message));
  }
});
// On the incident it is for (named, or the one for its alert): the approval, then the outcome. A plan whose check
// held is remembered as a fix.
async function recordPlan(p) {
  if (['verified', 'unverified', 'failed'].includes(p.status)) {   // what a fix did, for next time (memory/index.js)
    memory.store(`Plan "${p.title}" (${new Date().toISOString().slice(0, 10)}) for: ${p.problem} Steps: ${p.steps.map(s => `${s.tool} ${JSON.stringify(s.args)}`).join('; ')}. Outcome: ${fixes.statusWords(p)}${p.note ? ` (${p.note})` : ''}.`,
      { kind: p.status === 'verified' ? 'fix' : 'correction', by: `${p.decidedBy ?? 'someone'} via HAL 9000` }).catch(() => {});
  }
  if (!incidentsApi.available()) return;
  const ref = p.incident ?? (await incidentsApi.openForAlert(p.alertUid).catch(() => null))?.ref;
  const steps = p.steps.map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.args)}${s.status !== 'pending' ? ` [${s.status}]` : ''}`).join('\n');
  const actor = `${p.decidedBy ?? 'someone'} via HAL 9000`;
  if (ref) await incidentsApi.addEvent(ref, 'change', p.status === 'approved'
    ? `Plan ${p.id} "${p.title}" approved by ${p.decidedBy}:\n${steps}\nExpected: ${p.expected}`
    : `Plan ${p.id} "${p.title}": ${fixes.statusWords(p)}.${p.note ? ` ${p.note}` : ''}${p.verify ? ` Check ${p.verify.query} ${p.verify.expect} ${p.verify.value}: latest ${p.verify.now ?? 'no data'}.` : ''}`, actor);
  if (p.status === 'verified') await incidentsApi.remember({ kind: 'fix', text: `Fix that worked (${new Date().toISOString().slice(0, 10)}): ${p.problem} Plan "${p.title}", approved by ${p.decidedBy}: ${steps.replace(/\n/g, '; ')}. The check held (${p.verify.query} ${p.verify.expect} ${p.verify.value}).`.slice(0, 2000) }, actor);
}

// ---- Aiden, the deep investigator (aiden/index.js) ----
// Its investigation of an alert follows on the board as panel AID; the result is spoken on every ship that heard the
// alert or shows the panel, goes into the chat with a link to Aiden, onto the open incident for that alert, and into memory.
// The 9000 looking through a ship's eye (self/index.js): the camera runs just long enough for one settled frame
// (the first ones are skipped while exposure adjusts), then goes back to how it was. The frame is not kept.
function glance(code) {
  const r = rooms.get(code);
  if (!r || ![...r.clients].some(c => c.role === 'eye' && c.readyState === 1)) return Promise.resolve(null);
  return new Promise(resolve => {
    const w = { skip: 3, last: null };
    w.done = frame => {
      clearTimeout(timer);
      r.glances = r.glances.filter(x => x !== w); r.glancing--; updateCamera(r);
      resolve(frame);
    };
    const timer = setTimeout(() => w.done(w.last), 6000);   // a camera that is slow to start, or was refused
    (r.glances ??= []).push(w);
    r.glancing = (r.glancing ?? 0) + 1; updateCamera(r);
  });
}
self.configure({
  glance,
  ship: code => {
    const r = rooms.get(code);
    if (!r) return {};
    const roles = [...r.clients].map(c => c.role);
    return { persona: r.state.theme === 'hal' ? 'HAL' : 'SAL', voice: tts.voiceName, eyes: roles.filter(x => x === 'eye').length,
      monitors: roles.filter(x => x === 'monitor').length, camera: !!r.camera, cameraState: r.state.camera };
  },
});

aiden.configure({
  rule: async uid => (await alertRules.allRules())?.find(r => r.uid === uid) ?? null,
  attach: (code, uid) => attachAiden(code, uid),
});
function attachAiden(code, uid) {
  const r = rooms.get(code), run = aiden.get(uid);
  if (!r || !run) return;
  boards.addPanel(code, { code: 'AID', kind: 'aiden', title: `Aiden · ${spokenName(run)}`, alertUid: uid }, msg => broadcast(r, msg), `Aiden · ${spokenName(run)}`, { extra: true })
    .catch(err => console.error('Aiden panel:', err.message));
}
const showsAiden = (code, uid) => boards.current(code)?.panels.some(p => p.code === 'AID' && p.aiden && boards.panelInfo(code, 'AID')?.spec?.alertUid === uid);
// The first sentence or two, for speaking; the whole summary goes in the chat.
const spokenSummary = s => { const parts = String(s).match(/[^.!?]+[.!?]+/g) ?? [String(s)]; let out = ''; for (const p of parts) { if ((out + p).length > 300 && out) break; out += p; } return out.trim(); };
aiden.onUpdate(run => {
  if (!['completed', 'draft', 'unmatched', 'failed', 'error'].includes(run.status) || run.told) return;
  if (!aiden.finished(run) && run.status === 'draft') return;
  run.told = true;
  const name = spokenName(run), mins = Math.max(1, Math.round(aiden.elapsed(run) / 60));
  const text = aiden.finished(run) ? `Aiden has finished its investigation of the ${name} alert. ${spokenSummary(run.summary)}`
    : run.status === 'unmatched' ? `Aiden has no record of the ${name} alert, so it could not investigate it.`
    : `Aiden's investigation of the ${name} alert did not complete.`;
  const extra = { via: 'Aiden', ...(run.url && { link: run.url }), ...(aiden.finished(run) && { full: run.summary }) };
  for (const [code, r] of rooms) if (r.clients.size && (r.announced?.has(run.uid) || showsAiden(code, run.uid))) sayWhenQuiet(r, text, 0, extra);
  if (aiden.finished(run)) {
    recordAiden(run, mins).catch(err => console.error('Aiden → Incidents:', err.message));
    memory.store(`Aiden investigated the alert "${run.title}"${run.cluster ? ` on ${run.cluster}` : ''}${run.service ? ` (${run.service})` : ''} on ${new Date(run.startedAt).toISOString().slice(0, 10)}: ${run.summary}`,
      { kind: 'cause', cluster: run.cluster, service: run.service, by: 'Aiden via HAL 9000' }).catch(() => {});
  }
});
async function recordAiden(run, mins, ref) {
  if (!incidentsApi.available()) return;
  const body = `Aiden (deep investigation, ${mins} min): ${run.summary}${run.url ? `\n${run.url}` : ''}`;
  const inc = ref ? { ref } : await incidentsApi.openForAlert(run.uid);
  if (inc) await incidentsApi.addEvent(inc.ref, 'finding', body, 'Aiden via HAL 9000');
  if (!ref && !run.remembered) {
    run.remembered = true;
    await incidentsApi.remember({ text: `Aiden investigated the alert "${run.title}"${run.cluster ? ` on ${run.cluster}` : ''}${run.service ? ` (${run.service})` : ''} on ${new Date(run.startedAt).toISOString().slice(0, 10)}: ${run.summary}`.slice(0, 2000),
      kind: 'fact', services: run.service ? [run.service] : [], clusters: run.cluster ? [run.cluster] : [] }, 'Aiden via HAL 9000');
  }
}
// An incident opened for an alert Aiden has already finished with: its result goes on the new timeline too.
incidentsApi.onDeclared(async (i, uid) => {
  // An acknowledgement made before the incident existed goes on it too.
  const a = acks.get(uid);
  if (a) await incidentsApi.acknowledge(i.ref, { by: a.by, at: new Date(a.at).toISOString(), detected_at: new Date(a.firedAt).toISOString() }, `${a.by} via HAL 9000`).catch(() => {});
  const run = aiden.get(uid);
  if (aiden.finished(run)) return recordAiden(run, Math.max(1, Math.round(aiden.elapsed(run) / 60)), i.ref);
});

// Good news can wait: don't cut off a story tour or an answer in progress; speak once the ship is quiet.
function sayWhenQuiet(r, text, waitedMs = 0, extra = {}) {
  const busy = ['speaking', 'thinking', 'listening'].includes(r.state.mode);
  if (!busy || waitedMs > 180_000) return say(r, text, false, extra);
  setTimeout(() => sayWhenQuiet(r, text, waitedMs + 1000, extra), 1000);
}

function announceResolved(rule) {
  for (const [, r] of rooms) {
    if (!r.announced?.has(rule.uid)) continue;
    r.announced.delete(rule.uid);
    if (acks.has(rule.uid)) ackHistory.set(rule.uid, acks.get(rule.uid));
    acks.delete(rule.uid);
    clearedAt.set(rule.uid, Date.now());
    if (r.state.alarm?.uid === rule.uid) setState(r, { alarm: null });
    sayWhenQuiet(r, `The ${spokenName(rule)} alert has cleared.`);
  }
}

let nextId = 1;
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const user = auth.user(req);
  if (!user) return ws.close(4401, 'sign in required');   // the page sends the person to sign in
  if (user.automation) console.log(`AUTH automation token: ${url.searchParams.get('role') ?? 'monitor'} in room ${url.searchParams.get('room') ?? '?'}`);
  const code = (url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (!code) return ws.close(4000, 'room required');

  ws.id = nextId++;
  ws.role = url.searchParams.get('role') === 'eye' ? 'eye' : 'monitor';
  ws.panel = Number(url.searchParams.get('panel')) || 0;
  ws.code = code;
  ws.user = user;

  const r = room(code);
  r.clients.add(ws);
  if (incidentsState && !r.state.incidents) r.state.incidents = incidentsState;
  ws.send(JSON.stringify({ type: 'hello', id: ws.id, state: r.state, roster: roster(r) }));
  const board = boards.current(code);
  if (board) ws.send(JSON.stringify({ type: 'board', board }));   // a monitor joining mid-board sees it too
  ws.send(JSON.stringify(viewsFor(code, r)));
  ws.send(JSON.stringify({ type: 'chat', history: r.chat ?? [] }));
  broadcast(r, { type: 'roster', roster: roster(r) }, ws);

  if (ws.role === 'eye' && r.camera) ws.send(JSON.stringify({ type: 'camera', on: true }));

  ws.on('message', (raw, isBinary) => {
    if (isBinary) {   // a camera frame from the eye: straight through to the monitors showing the EYE panel
      if (ws.role !== 'eye' || raw.length > 300_000) return;
      for (const w of [...(r.glances ?? [])]) { w.last = raw; if (w.skip-- <= 0) w.done(raw); }   // the 9000 looking
      for (const c of r.clients) if (c.watching && c.readyState === 1 && c.bufferedAmount < 1_000_000) c.send(raw, { binary: true });
      return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'set' && msg.state && typeof msg.state === 'object') {
      Object.assign(r.state, msg.state);
      // pulse is high-frequency; skip echoing it back to the sender
      broadcast(r, { type: 'state', state: msg.state, from: ws.id }, msg.state.pulse !== undefined ? ws : undefined);
    } else if (msg.type === 'say' && typeof msg.text === 'string') {
      // Only the eye speaks: it owns the voice, monitors just display.
      say(r, msg.text.slice(0, 500));
    } else if (msg.type === 'ask' && typeof msg.text === 'string') {
      // A question from anyone (monitor keyboard, eye microphone). Show it, think, answer.
      const text = msg.text.slice(0, 500);
      const asked = typeof msg.about === 'string' ? msg.about.slice(0, 3).toUpperCase() : undefined;
      broadcast(r, { type: 'heard', text, about: asked });
      chat(r, { from: 'you', text, about: asked, spoken: ws.role === 'eye', by: auth.enabled && !ws.user.automation ? ws.user.name : undefined });
      // Display commands ("return to the overview") skip the LLM: move the monitors, then acknowledge.
      const cmd = parseCommand(text);
      if (cmd?.ack) return acknowledge(r, auth.enabled && !ws.user.automation ? ws.user.name : undefined);
      if (cmd?.plan) { const p = fixes.pendingFor(code); return p ? decidePlan(r, ws, p.id, cmd.plan) : say(r, 'There is no plan waiting for a decision.'); }
      // Snooze / unsnooze ("snooze gaming for two hours", "snooze this"): which panel is worked out against this ship's board.
      if (cmd?.snooze || cmd?.unsnooze) {
        const actor = auth.enabled && !ws.user.automation ? ws.user.name : 'someone at a monitor';
        const focus = r.focus && Date.now() - r.focus.at < FOCUS_MS ? r.focus.code : undefined;
        (cmd.snooze ? snoozing.snoozePanel(code, cmd.snooze, { focus, actor, send: m => broadcast(r, m) }) : snoozing.unsnoozeByName(cmd.unsnooze.target, { actor }))
          .then(reply => say(r, reply)).catch(err => say(r, `I could not do that: ${err.message}`));
        return;
      }
      if (cmd) {
        // A ship system ("show me what you see", "show Jupiter") needs the ship systems on screen, not a board.
        if (SYSTEM_CODES.includes(cmd.display?.single) && (!r.state.systems || boards.hasActive(code))) {
          setState(r, { systems: true });
          boards.stop(code);
          broadcast(r, { type: 'board', board: boards.homeFor(code) });
          sendViews(code);
        }
        if (cmd.display) broadcast(r, { type: 'display', display: cmd.display });
        if (cmd.talk !== undefined) broadcast(r, { type: 'talk', on: cmd.talk });
        if (cmd.board === false) boards.stop(code, msg => broadcast(r, msg));
        if (cmd.systems !== undefined) {   // true: ship systems (COM...MEM); false: the situation board
          setState(r, { systems: cmd.systems });
          boards.stop(code);
          broadcast(r, { type: 'board', board: boards.homeFor(code) });
          sendViews(code);
        }
        if (cmd.alarm === false) setState(r, { alarm: null });
        if (cmd.proactive !== undefined) setState(r, { proactive: cmd.proactive, ...(cmd.proactive ? {} : { alarm: null }) });
        say(r, cmd.reply);
        return;
      }
      const tz = typeof msg.tz === 'string' && msg.tz.length < 64 ? msg.tz : undefined;
      if (tz) r.tz = tz;   // remembered for proactive announcements, which have no asker
      // about: the panel a drilldown question was asked from; it also becomes the focus for follow-ups.
      const about = typeof msg.about === 'string' ? msg.about.slice(0, 3).toUpperCase() : undefined;
      if (about) r.focus = { code: about, at: Date.now(), explicit: true };
      converse(r, code, text, tz, about, auth.enabled && !ws.user.automation ? ws.user.name : undefined);
    } else if (msg.type === 'snooze' && typeof msg.code === 'string') {
      // From a monitor's drilldown menu or the "s" key: snooze (or, on a one-off board, remove) that panel.
      const actor = auth.enabled && !ws.user.automation ? ws.user.name : 'someone at a monitor';
      snoozing.snoozePanel(code, { code: msg.code.slice(0, 3).toUpperCase(), minutes: Math.min(14 * 1440, Math.max(5, Number(msg.minutes) || Math.round(config.get('board.snoozeHours') * 60))) },
        { actor, send: m => broadcast(r, m) }).then(reply => say(r, reply)).catch(err => say(r, `I could not do that: ${err.message}`));
    } else if (msg.type === 'plan' && typeof msg.id === 'string') {
      // A plan decided on a monitor: approve / reject (with the hash of what was shown), or propose its undo.
      if (msg.decision === 'undo') { const u = fixes.proposeUndo(msg.id); if (u.error) say(r, u.error); }
      else decidePlan(r, ws, msg.id, msg.decision === 'approve' ? 'approve' : 'reject', typeof msg.hash === 'string' ? msg.hash : undefined);
    } else if (msg.type === 'ack') {
      // The Acknowledge button.
      acknowledge(r, auth.enabled && !ws.user.automation ? ws.user.name : undefined);
    } else if (msg.type === 'watch') {
      ws.watching = !!msg.on;
      updateCamera(r);
    } else if (msg.type === 'focus') {
      // The panel a monitor's person is looking at (mouse over it, Single mode, drilldown open); null clears.
      const f = typeof msg.code === 'string' ? msg.code.slice(0, 3).toUpperCase() : null;
      if (f) r.focus = { code: f, at: Date.now(), explicit: !!msg.explicit };
      else if (r.focus && !r.focus.explicit) r.focus = null;
    } else if (msg.type === 'drill' && typeof msg.code === 'string') {
      // Suggested drilldown questions for one panel, to this monitor only.
      const c = msg.code.slice(0, 3).toUpperCase();
      r.focus = { code: c, at: Date.now(), explicit: true };
      // part: a box (service) or arrow (call) clicked on a flow diagram.
      const p = msg.part, str = v => (typeof v === 'string' ? v.slice(0, 80) : undefined);
      const part = p?.kind === 'node' && str(p.id) ? { kind: 'node', id: str(p.id) } : p?.kind === 'edge' && str(p.from) && str(p.to) ? { kind: 'edge', from: str(p.from), to: str(p.to) } : null;
      drill.suggest(code, c, m => ws.readyState === 1 && ws.send(JSON.stringify(m)), part);
    } else if (msg.type === 'view' && typeof msg.id === 'string') {
      showView(code, r, msg.id.slice(0, 40));
    } else if (msg.type === 'panel') {
      ws.panel = Number(msg.panel) || 0;
      broadcast(r, { type: 'roster', roster: roster(r) });
    }
  });

  ws.on('close', () => {
    r.clients.delete(ws);
    updateCamera(r);
    broadcast(r, { type: 'roster', roster: roster(r) });
    if (r.clients.size === 0) setTimeout(() => { if (r.clients.size === 0) { boards.stop(code); rooms.delete(code); } }, 10 * 60_000);
  });
});

// The situation board goes to every ship that has no other board up and hasn't asked for the ship systems.
boards.configureHome({
  ships: () => [...rooms].filter(([code, r]) => r.clients.size && !r.state.systems && !boards.hasActive(code))
    .map(([code, r]) => ({ room: code, send: msg => broadcast(r, msg) })),
  wants: code => !rooms.get(code)?.state.systems,
});

// The situation board and the alert watch need Grafana's tools, which come from settings and may arrive (or be
// fixed) after boot: try at start and after every settings sync until each is running.
let homeStarted = false, watchStarted = false;
function startWatchers() {
  if (!homeStarted) homeStarted = home.start({ onChange: spec => { boards.setHome(spec); for (const code of rooms.keys()) sendViews(code); } });
  // An alert firing or resolving changes what matters most: recompose the situation board straight away.
  if (!watchStarted) watchStarted = watch.start({
    onFire: fired => { announceFiring(fired); home.recompose(); },
    onResolve: rule => { announceResolved(rule); home.recompose(); },
  });
}
snooze.onChange(() => { if (homeStarted) home.recompose(); });   // a snooze added or lifted: the situation board recomposes now
mcp.onSync(startWatchers);
mcp.start()
  .then(startWatchers)
  .catch(err => console.error('MCP:', err.message));

server.listen(PORT, () => {
  console.log(`SAL 9000 online. Mind: ${mindName()}. Voice: ${tts.voiceName}`);
  console.log(`  Monitor (this computer): http://localhost:${PORT}/monitor`);
  console.log(`  On your network:         http://${lanAddress()}:${PORT}/`);
});

// Settings that can change while the 9000 runs, edited on its settings page (/settings) and stored in StackGen
// Incidents (scope "hal9000") so they survive restarts. Each falls back to its environment variable, then to a
// built-in default. Read with get(key); the stored document is refreshed every minute.

import { PREVIEW } from '../preview.js';

const URL_ = (process.env.INCIDENTS_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.INCIDENTS_TOKEN;
export const available = () => !!(URL_ && TOKEN);

const env = process.env;
// Before settings existed the provider came from LLM_PROVIDER (openai meant any OpenAI-style endpoint).
function defaultProvider() {
  const p = (env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai')).toLowerCase();
  if (p === 'anthropic') return 'anthropic';
  return /api\.openai\.com/.test(env.LLM_BASE_URL ?? '') ? 'openai' : 'openai-compatible';
}
// key -> { label, type, default, ... } (the settings page is built from this)
export const SCHEMA = {
  // The model: provider, model, endpoint and key, switchable here without a redeploy (llm/index.js rebuilds it).
  // Keys are secrets: never sent back to the settings page, kept when the page saves without them.
  'mind.provider':         { group: 'Mind', label: 'Model provider', type: 'choice', choices: ['openai-compatible', 'openai', 'anthropic'], default: defaultProvider(),
    help: 'openai-compatible: any OpenAI-style endpoint (Ollama, vLLM, LiteLLM, OpenRouter…). Changing it starts every conversation afresh.' },
  'mind.model':            { group: 'Mind', label: 'Model', type: 'model', when: 'openai-compatible', default: env.LLM_MODEL ?? '' },
  'mind.baseUrl':          { group: 'Mind', label: 'Endpoint', type: 'text', when: 'openai-compatible', default: env.LLM_BASE_URL ?? '',
    help: 'The base URL, ending before /chat/completions, e.g. http://ollama.ollama.svc.cluster.local/v1' },
  'mind.compatibleKey':    { group: 'Mind', label: 'API key', type: 'secret', when: 'openai-compatible', default: env.LLM_API_KEY ?? '' },
  'mind.openaiModel':      { group: 'Mind', label: 'Model', type: 'model', when: 'openai', default: env.OPENAI_MODEL ?? '' },
  'mind.openaiKey':        { group: 'Mind', label: 'API key', type: 'secret', when: 'openai', default: env.OPENAI_API_KEY ?? '' },
  'mind.anthropicModel':   { group: 'Mind', label: 'Model', type: 'model', when: 'anthropic', default: env.ANTHROPIC_MODEL || 'claude-opus-5-5' },
  'mind.anthropicEffort':  { group: 'Mind', label: 'Effort', type: 'choice', when: 'anthropic', choices: ['low', 'medium', 'high', 'xhigh', 'max'], default: env.LLM_EFFORT || 'low',
    help: 'How hard Claude thinks. Lower is faster and cheaper; one level for every call keeps the prompt cache warm.' },
  'mind.anthropicKey':     { group: 'Mind', label: 'API key', type: 'secret', when: 'anthropic', default: env.ANTHROPIC_API_KEY ?? '' },
  'mind.quickEffort':      { group: 'Mind', label: 'Reasoning on quick calls', type: 'choice', choices: ['low', 'medium', 'high', 'default'], default: env.LLM_FAST_EFFORT || 'low',
    help: 'The opening call of each answer, and background work. Lower is faster.' },
  'mind.hedgeQuickSeconds':{ group: 'Mind', label: 'Retry a stalled quick call after', type: 'number', min: 3, max: 60, unit: 's', default: 8 },
  'mind.hedgeFullSeconds': { group: 'Mind', label: 'Retry a stalled full call after', type: 'number', min: 10, max: 120, unit: 's', default: 25 },
  'persona.defaultVoice':  { group: 'Persona', label: 'Persona for new ships', type: 'choice', choices: ['sal', 'hal', 'assistant'], default: env.DEFAULT_VOICE === 'hal' ? 'hal' : 'sal',
    help: 'A screen can switch its ship to another. The dashboard starts a new ship as the assistant.' },
  'persona.assistantName': { group: 'Persona', label: 'Name of the dashboard\'s assistant', type: 'text', default: 'Assistant',
    help: 'What the assistant persona is called in answers and on screen. Letters, digits and spaces, up to 32.' },
  'board.maxPanels':       { group: 'Situation board', label: 'Most panels at once', type: 'number', min: 1, max: 8, default: 6 },
  'board.surveySeconds':   { group: 'Situation board', label: 'Survey the estate every', type: 'number', min: 30, max: 600, unit: 's', default: 60 },
  'board.curateMinutes':   { group: 'Situation board', label: 'Re-rank with the model every', type: 'number', min: 1, max: 60, unit: 'min', default: 5 },
  'board.snoozeHours':     { group: 'Situation board', label: 'Default snooze', type: 'number', min: 0.25, max: 168, step: 0.25, unit: 'h', default: 4 },
  // Forecasts (home/ahead.js): the mlforecast MCP server's forecast and backtest tools, on any connected server.
  'forecast.enabled':      { group: 'Situation board', label: 'Forecast what is coming (mlforecast)', type: 'choice', choices: ['on', 'off'], default: 'off',
    help: 'Raises a panel when node memory, disk or restarts are forecast to cross their threshold, only where the forecast beats a seasonal-naive baseline. Needs the mlforecast MCP server connected.' },
  'forecast.everyMinutes': { group: 'Situation board', label: 'Forecast every', type: 'number', min: 5, max: 240, unit: 'min', default: 15 },
  'forecast.horizon':      { group: 'Situation board', label: 'Forecast ahead', type: 'choice', choices: ['6h', '12h', '24h', '48h'], default: '24h' },
  'forecast.lookback':     { group: 'Situation board', label: 'Forecast from the last', type: 'choice', choices: ['1d', '3d', '7d', '14d'], default: '7d',
    help: 'History each forecast learns from. Daily patterns need at least two days.' },
  'forecast.tool':         { group: 'Situation board', label: 'Forecast tool (MCP)', type: 'text', default: 'forecast' },
  'forecast.backtestTool': { group: 'Situation board', label: 'Backtest tool (MCP)', type: 'text', default: 'backtest' },
  'alerts.minSeverity':    { group: 'Alerts', label: 'Announce alerts from', type: 'choice', choices: ['critical', 'warning'], default: (env.ALERT_MIN_SEVERITY || 'critical').toLowerCase() },
  'alerts.watchSeconds':   { group: 'Alerts', label: 'Check alerts every', type: 'number', min: 10, max: 600, unit: 's', default: Math.max(10, Number(env.ALERT_WATCH_SECONDS) || 30) },
  'alerts.repeatMinutes':  { group: 'Alerts', label: 'Don\'t repeat an announcement within', type: 'number', min: 1, max: 240, unit: 'min', default: 10 },
  'alerts.ackMinutes':     { group: 'Alerts', label: 'Alarm again if still firing after acknowledging', type: 'number', min: 5, max: 480, unit: 'min', default: 30,
    help: 'Unless the incident for it has moved on to identified or monitoring.' },
  'fixes.expireMinutes':   { group: 'Alerts', label: 'A plan not approved within this expires', type: 'number', min: 2, max: 120, unit: 'min', default: 15 },
  // Slow tools (held/index.js): another agent can take minutes to answer. Past the hold, the 9000 stops waiting in the
  // conversation, carries on, and brings the answer back when it arrives, while checking its server is still there.
  'tools.holdSeconds':     { group: 'Tools', label: 'Stop waiting in the conversation after', type: 'number', min: 5, max: 120, unit: 's', default: 20,
    help: 'A tool still working then is held: the 9000 carries on and tells you when it answers. Fast tools are never held.' },
  'tools.quietMinutes':    { group: 'Tools', label: 'Mention a held tool that is quiet for', type: 'number', min: 1, max: 60, unit: 'min', default: 5,
    help: 'Until it has history: then twice the longest it usually takes. Its server still answering means it is slow, not gone.' },
  'tools.maxWaitMinutes':  { group: 'Tools', label: 'Give up on a held tool after', type: 'number', min: 5, max: 240, unit: 'min', default: 30 },
  // Tasks (tasks/index.js), a trial: reminders ("check X in 5 minutes") and watches ("tell me when X") the 9000 keeps.
  'tasks.checkSeconds':    { group: 'Tasks (trial)', label: 'Check watches every', type: 'number', min: 10, max: 600, unit: 's', default: 30 },
  'tasks.watchHours':      { group: 'Tasks (trial)', label: 'A watch gives up after', type: 'number', min: 0.25, max: 168, step: 0.25, unit: 'h', default: 24 },
  'tasks.maxHours':        { group: 'Tasks (trial)', label: 'Furthest ahead a task may be set', type: 'number', min: 1, max: 168, unit: 'h', default: 72 },
  'tasks.maxPerRoom':      { group: 'Tasks (trial)', label: 'Most tasks pending per ship', type: 'number', min: 1, max: 50, default: 10 },
  // The pod bay doors game (game/index.js), on the booth's 9000 only (GAME_MODE=on).
  'game.minutes':          { group: 'Game (booth only)', label: 'Time to open the pod bay doors', type: 'number', min: 1, max: 30, unit: 'min', default: 5 },
  'memory.findTool':       { group: 'Memory', label: 'Memory search tool (MCP)', type: 'text', default: env.MEMORY_FIND_TOOL || 'qdrant_find',
    help: 'Searched before every answer, so the 9000 starts from what it already knows. Any connected MCP server offering it.' },
  'memory.storeTool':      { group: 'Memory', label: 'Memory store tool (MCP)', type: 'text', default: env.MEMORY_STORE_TOOL || 'qdrant_store',
    help: 'Where the 9000 writes what it learns.' },
  'memory.collection':     { group: 'Memory', label: 'Collection', type: 'text', default: env.MEMORY_COLLECTION || '',
    help: 'Only for servers that take a collection_name; leave empty otherwise.' },
  'aiden.workspace':       { group: 'Aiden', label: 'Aiden workspace id', type: 'text', default: env.AIDEN_WORKSPACE || 'a57118f8-0313-4b51-b17d-c1fabcd9f10e',
    help: 'The StackGen workspace Aiden investigates in (steph-aiden-observe-now by default).' },
  'aiden.autoInvestigate': { group: 'Aiden', label: 'Ask Aiden to investigate when an alert fires', type: 'choice', choices: ['on', 'off'], default: 'on',
    help: 'Alerts announced on the monitors (see Alerts) get a deep Aiden investigation alongside the quick story.' },
  // Capability requests: when the 9000 can't answer for want of instrumentation or a panel feature, he can propose (as
  // an approvable plan) that Aiden opens a pull request for it and that its owners are told (capabilities/index.js).
  'capabilities.workflow':     { group: 'Capabilities', label: 'Aiden workflow that opens the pull request', type: 'text', default: env.CAPABILITY_WORKFLOW || 'capability-request',
    help: 'An approved workflow in the Aiden workspace above; it gets the repository and the change, and replies with "PR: <url>".' },
  'capabilities.repositories': { group: 'Capabilities', label: 'Repositories', type: 'longtext',
    default: env.CAPABILITY_REPOSITORIES || 'srclosson/hal9000 — the 9000 itself: monitors, panels, the compose grammar, its tools\nsrclosson/discovery-one — the ship\'s services (gateway, systems, commands, hardware) and their telemetry',
    help: 'One per line: owner/name — what it holds. A request can only go to one of these.' },
  'capabilities.owners':       { group: 'Capabilities', label: 'Owners, and where to tell them', type: 'longtext',
    default: env.CAPABILITY_OWNERS || 'For a customer estate, the owners are that organisation\'s project lead in the issue tracker and its ops channel in team chat (look them up). For the 9000 or Discovery One, the owner is Stephanie Closson.',
    help: 'Guidance the 9000 follows when adding notification steps to a request (who owns what, which channel or project).' },
  'capabilities.trialHours':   { group: 'Capabilities', label: 'An untried preview expires after', type: 'number', min: 1, max: 336, unit: 'h', default: 72,
    help: 'Then it is torn down; the pull request stays open.' },
  'capabilities.deployerToken': { group: 'Capabilities', label: 'Deployer token', type: 'secret', default: env.CAPABILITY_DEPLOYER_TOKEN ?? '',
    help: 'The bearer token the preview deployer (CI) uses on /api/capabilities to record previews, report what shipped and tear previews down. It cannot approve anything.' },
  'capabilities.githubToken':  { group: 'Capabilities', label: 'GitHub token (read-only, optional)', type: 'secret', default: env.CAPABILITY_GITHUB_TOKEN ?? '',
    help: 'Lets the 9000 follow a request\'s pull request and say when it merges. Pull requests: read on the repositories above is enough.' },
};

let doc = {}, meta = {};
const listeners = new Set();
export const onChange = fn => listeners.add(fn);

function valid(key, v) {
  const s = SCHEMA[key];
  if (!s || v === undefined || v === null || v === '') return undefined;
  if (s.type === 'number') { const n = Number(v); return Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, n)) : undefined; }
  if (s.type === 'choice') return s.choices.includes(v) ? v : undefined;
  return String(v);
}

export function get(key) {
  return valid(key, doc[key]) ?? SCHEMA[key]?.default;
}
export const all = () => Object.fromEntries(Object.keys(SCHEMA).map(k => [k, get(k)]));
// For the settings page: secrets never leave the server, only whether one is set.
const SECRETS = Object.keys(SCHEMA).filter(k => SCHEMA[k].type === 'secret');
export const forPage = () => ({ ...all(), ...Object.fromEntries(SECRETS.map(k => [k, ''])) });
export const secretsSet = () => Object.fromEntries(SECRETS.map(k => [k, !!get(k)]));
export const pageSchema = () => Object.fromEntries(Object.entries(SCHEMA).map(([k, s]) => [k, s.type === 'secret' ? { ...s, default: '' } : s]));
export const stored = () => ({ doc: Object.fromEntries(Object.entries(doc).filter(([k]) => !SECRETS.includes(k))), ...meta });

async function call(path, { method = 'GET', body, actor } = {}) {
  const res = await fetch(`${URL_}${path}`, { method, signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(actor && { 'X-Actor': actor }) },
    body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export async function refresh() {
  if (!available()) return;
  try {
    const r = await call('/api/settings/hal9000');
    const changed = JSON.stringify(r.doc ?? {}) !== JSON.stringify(doc);
    doc = r.doc ?? {}; meta = { updated_by: r.updated_by, updated_at: r.updated_at };
    if (changed) for (const fn of listeners) fn(all());
  } catch { /* keep the last copy */ }
}

// Save the settings page: only known keys, validated; a value equal to its default is dropped (so env changes still apply).
export async function save(values, actor) {
  if (PREVIEW) throw new Error('this is a preview of the 9000: settings are changed on the real one');
  const next = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    if (SECRETS.includes(k)) continue;   // below
    const ok = valid(k, v);
    if (ok !== undefined && ok !== SCHEMA[k].default) next[k] = ok;
  }
  // A secret left blank keeps what is stored; "clear" removes it. Resetting to defaults keeps them too.
  for (const k of SECRETS) {
    const v = values?.[k];
    if (v === 'clear') continue;
    if (typeof v === 'string' && v.trim()) next[k] = v.trim();
    else if (doc[k]) next[k] = doc[k];
  }
  const r = await call('/api/settings/hal9000', { method: 'PUT', body: { doc: next }, actor });
  doc = r.doc; meta = { updated_by: r.updated_by, updated_at: r.updated_at };
  for (const fn of listeners) fn(all());
  return all();
}

// Another document in the same store, under its own scope (e.g. hal9000-capabilities): the 9000's records that must
// outlive a restart. Never written from a preview.
export const loadDoc = async scope => (available() ? (await call(`/api/settings/${scope}`)).doc ?? {} : null);
export async function saveDoc(scope, doc, actor = 'HAL 9000') {
  if (PREVIEW || !available()) return false;
  await call(`/api/settings/${scope}`, { method: 'PUT', body: { doc }, actor });
  return true;
}

// Pass-through to StackGen Incidents' MCP server API, acting for the signed-in person.
export const mcp = (path, opts) => call(`/api/mcp-servers${path}`, opts);

refresh();
setInterval(refresh, 60_000).unref();

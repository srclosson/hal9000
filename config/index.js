// Settings that can change while the 9000 runs, edited on its settings page (/settings) and stored in StackGen
// Incidents (scope "hal9000") so they survive restarts. Each falls back to its environment variable, then to a
// built-in default. Read with get(key); the stored document is refreshed every minute.

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
  'persona.defaultVoice':  { group: 'Persona', label: 'Voice for new ships', type: 'choice', choices: ['sal', 'hal'], default: 'sal' },
  'board.maxPanels':       { group: 'Situation board', label: 'Most panels at once', type: 'number', min: 1, max: 8, default: 6 },
  'board.surveySeconds':   { group: 'Situation board', label: 'Survey the estate every', type: 'number', min: 30, max: 600, unit: 's', default: 60 },
  'board.curateMinutes':   { group: 'Situation board', label: 'Re-rank with the model every', type: 'number', min: 1, max: 60, unit: 'min', default: 5 },
  'board.snoozeHours':     { group: 'Situation board', label: 'Default snooze', type: 'number', min: 0.25, max: 168, step: 0.25, unit: 'h', default: 4 },
  'alerts.minSeverity':    { group: 'Alerts', label: 'Announce alerts from', type: 'choice', choices: ['critical', 'warning'], default: (env.ALERT_MIN_SEVERITY || 'critical').toLowerCase() },
  'alerts.watchSeconds':   { group: 'Alerts', label: 'Check alerts every', type: 'number', min: 10, max: 600, unit: 's', default: Math.max(10, Number(env.ALERT_WATCH_SECONDS) || 30) },
  'alerts.repeatMinutes':  { group: 'Alerts', label: 'Don\'t repeat an announcement within', type: 'number', min: 1, max: 240, unit: 'min', default: 10 },
  'alerts.ackMinutes':     { group: 'Alerts', label: 'Alarm again if still firing after acknowledging', type: 'number', min: 5, max: 480, unit: 'min', default: 30,
    help: 'Unless the incident for it has moved on to identified or monitoring.' },
  'fixes.expireMinutes':   { group: 'Alerts', label: 'A plan not approved within this expires', type: 'number', min: 2, max: 120, unit: 'min', default: 15 },
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

// Pass-through to StackGen Incidents' MCP server API, acting for the signed-in person.
export const mcp = (path, opts) => call(`/api/mcp-servers${path}`, opts);

refresh();
setInterval(refresh, 60_000).unref();

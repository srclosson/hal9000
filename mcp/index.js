// MCP connections: tools the 9000 can use mid-conversation (web search, page reading, ...).
//
//   MCP_SERVERS = JSON list, kept in the Secret because server URLs can carry API keys:
//     [{ "name": "exa", "url": "https://mcp.exa.ai/mcp?exaApiKey=...", "tools": ["web_search_exa", "web_fetch_exa"] }]
//   "tools" is an allowlist. Without one, only tools the server marks read-only are offered.
//   Optional "headers" (e.g. {"Authorization": "Bearer ..."}) are sent with every request.
//   Optional "hint": guidance for the model on using this server (datasource ids, naming conventions...).
//   Optional "internal": tools only the 9000's own code may call (never offered to the model), e.g. a tool
//   that mixes read and write operations, wrapped server-side so only the read operations are used.
//   Optional "approval": tools that change things and may only run as a step of a plan a signed-in person approved
//   on the monitors (fixes/index.js). Never offered to the model directly. Precedence: internal, then approval, then
//   the allowlist.
//
// Servers can also be configured in StackGen Incidents (Settings → MCP servers): with INCIDENTS_URL and INCIDENTS_TOKEN
// set, that list is read every minute and servers are connected, reconnected or dropped as it changes. Servers from
// MCP_SERVERS win if both use the same name.
//
// Exposes the allowed tools in a provider-neutral shape ({ name, description, inputSchema }) and runs them.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as config from '../config/index.js';
import { PREVIEW, refused } from '../preview.js';

// The memory server's search and store tools (settings memory.findTool / memory.storeTool) are the 9000's own
// (memory/index.js wraps them), so they are taken as internal on any server that offers them, whatever its allowlist.
const sameName = (a, b) => String(a).replace(/-/g, '_') === String(b).replace(/-/g, '_');   // qdrant-find = qdrant_find
const memoryTools = () => [config.get('memory.findTool'), config.get('memory.storeTool')].filter(Boolean);
const isMemoryTool = name => memoryTools().some(m => sameName(m, name));

const CALL_TIMEOUT_MS = 20_000;
const RESULT_MAX_CHARS = 6000;   // keeps search results from flooding the conversation

const servers = [];          // { name, url, headers, allow, client }
let duplicates = new Map();  // settings server name -> the built-in server it duplicates
const tools = new Map();     // tool name -> { server, tool }

function parseConfig(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(s => s?.name && s?.url) : [];
  } catch {
    console.warn('MCP: MCP_SERVERS is not valid JSON; no tools.');
    return [];
  }
}

// The SDK opens an optional GET event stream for server-initiated messages, which the 9000 doesn't use.
// Some servers (or proxies in front of them) then hold the replies to later requests, so tool calls time
// out. Answering that GET with 405 is the spec's way of saying "no stream": every reply then arrives on its
// own POST.
const noEventStream = (url, init) =>
  (init?.method ?? 'GET') === 'GET' ? Promise.resolve(new Response(null, { status: 405 })) : fetch(url, init);

async function connect(server) {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: server.headers ? { headers: server.headers } : undefined,
    fetch: noEventStream,
  });
  const client = new Client({ name: 'hal9000', version: '1.0.0' });
  await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
  server.client = client;
  return client;
}

// Connects one server and registers its allowed tools. Failures are logged, not fatal: the 9000 just converses
// without that server's tools.
async function add(cfg, source) {
  const server = { name: cfg.name, url: cfg.url, headers: cfg.headers, allow: cfg.tools, hint: cfg.hint, internal: cfg.internal ?? [], approval: cfg.approval ?? [], source,
    signature: JSON.stringify([cfg.url, cfg.headers ?? {}, cfg.tools ?? null, cfg.hint ?? '', cfg.internal ?? [], cfg.approval ?? []]) };
  try {
    const client = await connect(server);
    const { tools: listed } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
    const isInternal = t => server.internal.includes(t.name) || isMemoryTool(t.name), needsApproval = t => !isInternal(t) && server.approval.includes(t.name);
    const allowed = listed.filter(t => !isInternal(t) && !needsApproval(t) && (server.allow ? server.allow.includes(t.name) : t.annotations?.readOnlyHint === true));
    const unique = t => (tools.has(t.name) ? `${server.name}_${t.name}` : t.name);
    for (const tool of allowed) tools.set(unique(tool), { server, tool });
    for (const tool of listed.filter(isInternal)) tools.set(tool.name, { server, tool, internal: true });
    for (const tool of listed.filter(needsApproval)) tools.set(unique(tool), { server, tool, approval: true });
    server.listed = listed;
    servers.push(server);
    const internal = listed.filter(isInternal).map(t => t.name), ask = listed.filter(needsApproval).map(t => t.name);
    console.log(`MCP: ${server.name} connected${source === 'settings' ? ' (from settings)' : ''}, tools: ${allowed.map(t => t.name).join(', ') || 'none allowed'}` +
      `${internal.length ? ` (internal: ${internal.join(', ')})` : ''}${ask.length ? ` (ask first: ${ask.join(', ')})` : ''}`);
  } catch (err) {
    console.error(`MCP: ${server.name} failed to connect: ${err.message}`);
    servers.push({ ...server, failed: true });   // remembered, so it is retried only when its settings change
  }
}

function drop(name) {
  const i = servers.findIndex(s => s.name === name);
  if (i < 0) return;
  const [server] = servers.splice(i, 1);
  for (const [tname, t] of [...tools]) if (t.server === server) tools.delete(tname);
  server.client?.close?.().catch?.(() => {});
  console.log(`MCP: ${name} removed`);
}

// Servers configured in StackGen Incidents: add new ones, reconnect changed ones, drop removed or disabled ones.
async function syncSettings() {
  const base = (process.env.INCIDENTS_URL ?? '').replace(/\/$/, ''), token = process.env.INCIDENTS_TOKEN;
  if (!base || !token) return;
  let rows;
  try {
    const res = await fetch(`${base}/api/mcp-servers?secrets=1`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    rows = (await res.json()).filter(r => r.enabled);
  } catch { return; }
  // A settings server with the same name or the same address as a built-in one is a duplicate: the built-in one wins,
  // so the model never sees the same tools twice.
  const where = u => { try { const x = new URL(u); return x.host + x.pathname.replace(/\/$/, ''); } catch { return u; } };
  const env = servers.filter(s => s.source === 'env');
  duplicates = new Map(rows.map(r => [r.name, env.find(e => e.name === r.name || where(e.url) === where(r.url))?.name]).filter(([, e]) => e));
  const wanted = rows.filter(r => !duplicates.has(r.name)).map(r => ({ name: r.name, url: r.url, headers: Object.keys(r.headers ?? {}).length ? r.headers : undefined,
    tools: r.tools ?? undefined, hint: r.hint || undefined, internal: r.internal?.length ? r.internal : undefined, approval: r.approval?.length ? r.approval : undefined }));
  for (const s of servers.filter(s => s.source === 'settings' && !wanted.some(w => w.name === s.name))) drop(s.name);
  for (const w of wanted) {
    const have = servers.find(s => s.name === w.name);
    const signature = JSON.stringify([w.url, w.headers ?? {}, w.tools ?? null, w.hint ?? '', w.internal ?? [], w.approval ?? []]);
    if (have && have.signature === signature && !have.failed) continue;   // a failed one is retried each sync
    if (have) drop(w.name);
    await add(w, 'settings');
  }
  for (const fn of synced) fn();
}

// onSync(fn): called after every settings sync, e.g. to start what needed a server that has just arrived.
const synced = [];
export const onSync = fn => synced.push(fn);

// Connects every server from MCP_SERVERS, then the ones configured in settings (and keeps those in step).
export async function start(env = process.env) {
  const own = parseConfig(env.MCP_SERVERS);
  for (const cfg of own) await add(cfg, 'env');
  await syncSettings();
  setInterval(() => {
    // A built-in server that could not be reached (it started after the 9000, say) is tried again each minute.
    for (const cfg of own) if (servers.find(x => x.name === cfg.name && x.source === 'env')?.failed) { drop(cfg.name); add(cfg, 'env').then(() => { for (const fn of synced) fn(); }); }
    syncSettings().catch(err => console.error('MCP settings:', err.message));
  }, 60_000).unref();
}

// A preview (preview.js) offers only tools that read.
const offered = ([n, t]) => !t.internal && !t.approval && !hidden.has(n) && !(PREVIEW && changes(t.tool));
export function list() {
  return [...tools].filter(offered).map(([name, { tool }]) => ({
    name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  }));
}

// For the settings page: every server, where it's configured, whether it connected, and the tools it offers.
export const duplicateOf = name => duplicates.get(name);
export const status = () => servers.map(s => ({ name: s.name, source: s.source, url: s.url.replace(/([?&][^=]*(key|token)[^=]*=)[^&]+/gi, '$1••••'),
  connected: !s.failed, tools: [...tools].filter(([, t]) => t.server === s && !t.internal && !t.approval).map(([n]) => n),
  ask: [...tools].filter(([, t]) => t.server === s && t.approval).map(([n]) => n) }));

export const names = () => [...tools].filter(offered).map(([name]) => name);
// Tools the 9000 wraps in its own (memory/index.js wraps a memory server's find and store): kept from the model's
// list and the access summary, since it reaches them through the wrappers.
const hidden = new Set();
export const hide = names => { hidden.clear(); for (const n of names) if (n) hidden.add(n); };
// The registered name of a tool, whatever server offers it (a clash prefixes it with the server's name), internal or
// not; approval tools are never resolved this way. null when no connected server has it.
export const resolve = base => (base ? [...tools].find(([n, t]) => !t.approval && (sameName(n, base) || sameName(t.tool.name, base)))?.[0] ?? null : null);
// "Ask first" tools, for plans: what each does and takes, and which server it is on.
export const approvalTools = () => [...tools].filter(([, t]) => t.approval && !PREVIEW).map(([name, { server, tool }]) => ({
  name, server: server.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
  destructive: tool.annotations?.destructiveHint === true }));
export const serverOf = name => tools.get(name)?.server.name ?? null;
export const changesThings = name => { const t = tools.get(name); return t ? changes(t.tool) : false; };
export const needsApproval = name => tools.get(name)?.approval === true;
export const hasInternal = name => tools.get(name)?.internal === true;

// What the 9000 can actually do on each connected server, from the servers' own tool lists and the settings, for the
// system prompt (so the model never repeats a stale claim about its access). A tool only reads when its server marks it
// read-only or its name says so (list_, get_, search_..., after any server prefix): many servers mark nothing, and some
// mark every tool destructive. Everything else "changes things". Per server: { name, reads, changes (offered to the model), ask (only in approved plans),
//   off (changing tools not enabled) }; internal tools are the 9000's own business and left out.
const READS = /^(sre_)?(list|get|search|describe|query|find|read|fetch|show|count|explain|check|generate_deeplink|top|stats|log|logs|view|analyze)(_|$)/
const bare = n => n.replace(/^.*__/, '').replace(/^[a-z0-9]+(-[a-z0-9]+)+_/, '');   // aiden__x, unified-team-chat_x
const changes = t => t.annotations?.readOnlyHint !== true && !READS.test(bare(t.name)) && !READS.test(bare(t.name).replace(/^[a-z0-9]+_/, ''));   // qdrant_list_x
export const access = () => servers.filter(s => !s.failed).map(s => {
  const mine = [...tools].filter(([n, t]) => t.server === s && !t.internal && !hidden.has(n));
  const used = new Set(mine.map(([, t]) => t.tool.name));
  return { name: s.name,
    reads: mine.filter(([, t]) => !t.approval && !changes(t.tool)).length,
    changes: mine.filter(([, t]) => !t.approval && changes(t.tool)).map(([n]) => n),
    ask: mine.filter(([, t]) => t.approval).map(([n]) => n),
    off: (s.listed ?? []).filter(t => changes(t) && !used.has(t.name) && !s.internal.includes(t.name) && !isMemoryTool(t.name)).map(t => t.name) };
});

// Usage hints from connected servers, for the system prompt.
export const hints = () => servers.filter(s => s.hint && !s.failed).map(s => `${s.name}: ${s.hint}`);

// What the monitor shows while a tool runs.
export function describe(name, args = {}) {
  if (name === 'query_prometheus') return 'Querying cluster metrics';
  if (/loki|logs/i.test(name)) return 'Searching the logs';
  if (/dashboard/i.test(name)) return 'Consulting the dashboards';
  if (/prometheus|datasource/i.test(name)) return 'Surveying the available metrics';
  if (/search/i.test(name) && args.query) return `Searching the web for "${args.query}"`;
  if (/^(pods|nodes|events|namespaces|resources|helm|configuration)_/.test(name)) return 'Inspecting the cluster';
  if (/fetch|read/i.test(name)) {
    const url = [].concat(args.urls ?? args.url ?? [])[0];
    try { return `Reading ${new URL(url).host}`; } catch { return 'Reading a web page'; }
  }
  return `Using ${name.replace(/_/g, ' ')}`;
}

// Runs a tool; always resolves to text for the model (errors included, so it can recover or apologise).
// Internal tools need { internal: true }: the model's tool calls can never reach them. Internal results are not
// trimmed (they're parsed by the 9000's own code, not read by the model).
// "Ask first" tools need { approved: true }, which only fixes/index.js passes, for a step of an approved plan.
// wait: for a call the 9000 can hold (held/index.js): { signal, onprogress, timeout } instead of the 20 s limit.
export async function call(name, args, { internal = false, approved = false, wait } = {}) {
  const entry = tools.get(name);
  if (!entry || (entry.internal && !internal) || (entry.approval && !approved)) return `Error: no tool named ${name}.`;
  const { server, tool } = entry;
  // A preview changes nothing; memory writes are let through (memory/index.js sends them to a scratch collection).
  if (PREVIEW && (approved || entry.approval || (changes(tool) && !(internal && isMemoryTool(name))))) return refused(`${tool.name} (it changes things)`);
  const options = wait ? { timeout: wait.timeout, signal: wait.signal, onprogress: wait.onprogress, resetTimeoutOnProgress: !!wait.onprogress } : { timeout: CALL_TIMEOUT_MS };
  const run = () => server.client.callTool({ name: tool.name, arguments: args ?? {} }, undefined, options);
  try {
    let result;
    try { result = await run(); }
    catch (err) {
      // Sessions can expire on the server side: reconnect once and retry. Never after a timeout or a cancel (the
      // server may still be working on it), and a tool that changes things only when the server said it had no
      // session, so the first call never ran: a slow chat with another agent must not be sent twice.
      if (!retryable(err, tool)) throw err;
      console.warn(`MCP: ${server.name}.${tool.name} failed (${err.message}); reconnecting`);
      await connect(server);
      result = await run();
    }
    const text = (result.content ?? []).map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n').trim();
    const body = !internal && text.length > RESULT_MAX_CHARS ? text.slice(0, RESULT_MAX_CHARS) + '\n[truncated]' : text;
    return result.isError ? `Error from ${tool.name}: ${body}` : (body || '(no results)');
  } catch (err) {
    console.error(`MCP: ${server.name}.${tool.name}: ${err.message}`);
    if (timedOut(err)) return `Error: ${tool.name} did not answer within ${Math.round((wait?.timeout ?? CALL_TIMEOUT_MS) / 1000)} s. It was not asked again: it may still be working on it.`;
    return `Error: ${tool.name} is unavailable right now (${err.message}).`;
  }
}

// McpError RequestTimeout is -32001; a cancel is an AbortError.
const timedOut = err => err?.code === -32001 || /timed? ?out/i.test(err?.message ?? '');
const cancelled = err => err?.name === 'AbortError' || /abort/i.test(err?.message ?? '');
const noSession = err => err?.code === 404 || (err?.code === 400 && /session/i.test(err?.message ?? ''));
export const retryable = (err, tool) => !timedOut(err) && !cancelled(err) && (noSession(err) || !changes(tool));

// Is the server behind a tool still there? Resolves true or false within 10 s (an MCP ping, the spec's liveness check).
export async function alive(name) {
  const server = tools.get(name)?.server;
  if (!server?.client) return false;
  try { await server.client.ping({ timeout: 10_000 }); return true; } catch { return false; }
}

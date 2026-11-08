// The 9000's memory, on an MCP memory server configured in settings (mcp-qdrant): a search tool and a store tool,
// named in settings (memory.findTool / memory.storeTool, default qdrant_find / qdrant_store; qdrant-find works too).
// StackGen Incidents writes its memories (incident causes, fixes, lessons) to the same store, so one search covers
// both, and what the 9000 stores is there for Incidents and Aiden-styled tools too.
//
// Context first: before the model sees a question, context() searches memory for it (with the alarm and the panel it
// is about) and the result goes in front of the question, so every answer starts from what is already known.
// Learning: the model stores what it learns with remember; the 9000's own findings (Aiden's results, what a fix did)
// are stored by the server with store().
//
//   recall   { question }                          search memory again, mid-answer
//   remember { fact, kind, cluster, service }       store something learned
//
// The server's raw tools are taken as internal (mcp/index.js), so the model reaches memory only through these two,
// which add the date, author and labels in the shape Incidents uses, and through the search before every question.

import { PREVIEW, SCRATCH_COLLECTION } from '../preview.js';
import * as mcp from '../mcp/index.js';
import * as config from '../config/index.js';

const CONTEXT_MS = 2500, CONTEXT_RESULTS = 6, CONTEXT_CHARS = 2200;
const names = () => ({ find: mcp.resolve(config.get('memory.findTool')), store: mcp.resolve(config.get('memory.storeTool')) });

export const available = () => !!names().find;
export const canStore = () => !!names().store;

const collection = () => (config.get('memory.collection') ? { collection_name: config.get('memory.collection') } : {});
// A preview (preview.js) remembers into a scratch collection, never the shared one.
const storeCollection = () => (PREVIEW ? { collection_name: SCRATCH_COLLECTION } : collection());
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const timeout = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

// One memory as a line: "- [2026-10-28 fix · garage on kubernetes] The fix in INC-0009 was …".
function line(m) {
  const md = m.metadata ?? {};
  const where = [[md.service, ...(md.services ?? [])].filter(Boolean)[0], [md.cluster, ...(md.clusters ?? [])].filter(Boolean)[0]];
  const tag = [String(md.date ?? md.at ?? '').slice(0, 10), md.kind, where[0] && where[1] ? `${where[0]} on ${where[1]}` : where[0] ?? where[1]].filter(Boolean).join(' · ');
  return `- ${tag ? `[${tag}] ` : ''}${String(m.information ?? m.content ?? '').replace(/\s+/g, ' ').trim()}`;
}

// Search the memory server -> lines of text. '' when nothing is found, null when it failed or isn't there.
// Reads mcp-qdrant's JSON list ({ information, metadata, score }), or mcp-server-qdrant's <entry> text.
// minScore: leave out weak matches (mcp-qdrant's JSON carries a similarity score).
export async function find(query, max = CONTEXT_RESULTS, minScore = 0) {
  const tool = names().find;
  if (!tool || !query) return null;
  const out = await mcp.call(tool, { query: String(query).slice(0, 500), max_results: max, ...collection() }, { internal: true });
  if (/^Error/.test(out)) { console.warn(`Memory: ${out.slice(0, 160)}`); return null; }
  try {
    const list = JSON.parse(out);
    if (Array.isArray(list)) return list.filter(m => !(typeof m.score === 'number' && m.score < minScore)).slice(0, max).map(line).join('\n');
  } catch {}
  const entries = [...out.matchAll(/<entry><content>([\s\S]*?)<\/content>(?:<metadata>([\s\S]*?)<\/metadata>)?<\/entry>/g)];
  if (entries.length) return entries.slice(0, max).map(([, c, md]) => { let m = {}; try { m = JSON.parse(md); } catch {} return line({ information: c, metadata: m }); }).join('\n');
  return /^(\(no results\)|no information found|no results|\[\])/i.test(out.trim()) ? '' : clip(out, CONTEXT_CHARS);
}

// Store one fact. metadata: { kind, cluster, service, by }, written in the shape StackGen Incidents uses.
export async function store(fact, { kind = 'fact', cluster, service, by } = {}) {
  const tool = names().store;
  if (!tool || !fact) return false;
  const metadata = { source: 'hal9000', path: 'stackgen/hal9000', kind, date: new Date().toISOString().slice(0, 10),
    ...(service && { services: [service] }), ...(cluster && { clusters: [cluster] }), ...(by && { by }) };
  const out = await mcp.call(tool, { information: String(fact).slice(0, 2000), metadata, ...storeCollection() }, { internal: true });
  if (/^Error/.test(out)) { console.warn(`Memory: store failed: ${out.slice(0, 160)}`); return false; }
  console.log(`Memory: stored (${kind}) ${String(fact).slice(0, 120)}`);
  return true;
}

// Before every question: what memory holds about it, within a short time limit so it never holds up an answer.
// about: extra words to search with (the alarm, the panel the question is about). null without a memory server.
export async function context(question, about = '') {
  if (!available()) return null;
  const q = `${question} ${about}`.replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  const found = await timeout(CONTEXT_MS, find(q).catch(() => null));
  if (found === null) return 'Memory could not be searched just now.';
  return found ? clip(found, CONTEXT_CHARS) : 'Nothing on record about this yet.';
}

// ---- tools for the model ----------------------------------------------------------------------------------------

export function tools() {
  if (!available()) return [];
  return [
    { name: 'recall',
      description: 'Search memory again when the question turns to something the memory you were given does not cover: past incidents, causes and fixes, quirks of a system, owners, what the person told you before.',
      inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'What to look for, in plain words' } }, required: ['question'] } },
    ...(canStore() ? [{ name: 'remember',
      description: 'Store something you learned so you know it next time: a cause and what fixed it, a quirk or known-noisy signal, who owns what, how a service normally behaves, a decision, preference or correction from the person. One self-contained sentence that makes sense on its own months from now.',
      inputSchema: { type: 'object', properties: {
        fact: { type: 'string', description: 'The fact, e.g. "clinic-portal-gateway on ht-prod-cluster normally runs about 130 ms at very low traffic; that is its baseline, not a fault (2026-10-28)."' },
        kind: { type: 'string', enum: ['cause', 'fix', 'quirk', 'owner', 'baseline', 'preference', 'correction', 'decision', 'fact'] },
        cluster: { type: 'string' }, service: { type: 'string' } }, required: ['fact'] } }] : []),
  ];
}
export const has = name => name === 'recall' || name === 'remember';
export const describe = name => (name === 'remember' ? 'Committing that to memory' : 'Searching memory');

export async function call(name, args = {}, hooks = {}) {
  try {
    if (name === 'recall') {
      const found = await find(args.question, 10);
      return found === null ? 'Error: memory is unavailable right now.' : found || 'Nothing on record about that.';
    }
    if (name === 'remember') {
      const ok = await store(args.fact, { kind: args.kind, cluster: args.cluster, service: args.service, by: hooks.person ? `${hooks.person} via HAL 9000` : 'HAL 9000' });
      return ok ? 'Stored in memory.' : 'Error: memory could not store that just now.';
    }
    return `Error: unknown memory tool ${name}.`;
  } catch (err) {
    return `Error: memory is unavailable (${err.message}).`;
  }
}

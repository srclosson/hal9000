// Who the 9000 is right now, and when that changed. A different model is a different mind: it answers, digs and gets
// confused differently, so its record starts afresh and it is less sure of itself until it has one.
//
// The fingerprint: the mind (provider, model and endpoint, as llm/ names it), the 9000's version, and hashes of its
// persona and its tool list. Observed at the start of every answer (brain.js), so a model switched on the settings
// page, a rollout or a lost MCP server is noticed the moment it is used, never on a guess.
//   ledger      each change: when, what it became, and which parts changed (kept across restarts, resume/)
//   labels      every metric and span carries the model and version (telemetry/), and the scorecard keeps its cases
//               and the confidence forecast its dig history per model, so a new model is judged on its own record
//   probation   after a model change, until 10 of its digs have been judged (scorecard/): the confidence forecast is
//               less sure, and the cards and self_check say so
// The 9000's version comes from package.json (npm_package_version isn't set when the image runs node directly).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { current } from '../llm/index.js';
import * as resume from '../resume/index.js';
import { addMetrics } from '../telemetry/index.js';

export const VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return ''; } })();
export const PROBATION_DIGS = 10;
const KEEP = 30;

let sources = { prompt: () => '', tools: () => [] };
export const configure = s => { sources = { ...sources, ...s }; };
let judged = () => 0;   // (model, since) -> how many of that model's digs have been judged since; set by the scorecard
export const setJudged = fn => { judged = fn; };
const listeners = new Set();
export const onChange = fn => listeners.add(fn);

let ledger = [];   // [{ at, mind, model, version, prompt, tools, changed: ['model', ...] }]
resume.register('identity', { save: () => ledger.slice(-KEEP), restore: list => {
  // An answer may have come in before the restore finished: its "first" entry is set against what was kept.
  const kept = list ?? [], early = ledger.filter(e => !e.changed.includes('first'));
  const first = ledger.find(e => e.changed.includes('first')), last = kept.at(-1);
  const changed = first && last ? ['model', 'version', 'prompt', 'tools'].filter(k => last[k] !== first[k]) : [];
  ledger = [...kept, ...(first && (changed.length || !last) ? [{ ...first, changed: last ? changed : ['first'] }] : []), ...early].slice(-KEEP);
} });
export const reset = (list = []) => { ledger = list; };   // tests

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
// "openai:gpt-6.1-terra@api.openai.com" -> "gpt-6.1-terra"; "openai-compatible:glm-5.3:cloud@ollama…" -> "glm-5.3:cloud"
export const modelOf = mind => String(mind ?? '').replace(/@.*$/, '').replace(/^[^:]+:/, '') || 'scripted';

export function fingerprint() {
  const mind = current()?.name ?? 'scripted';
  return { mind, model: modelOf(mind), version: VERSION, prompt: hash(sources.prompt()), tools: hash([...sources.tools()].sort().join(',')) };
}

// At the start of an answer: the fingerprint, recorded in the ledger when it differs from the last one. Returns it.
export function observe(now = Date.now(), fp = fingerprint()) {
  const last = ledger.at(-1);
  const changed = last ? ['model', 'version', 'prompt', 'tools'].filter(k => last[k] !== fp[k]) : ['first'];
  if (!changed.length) return last;
  const entry = { at: now, ...fp, changed };
  ledger.push(entry);
  if (ledger.length > KEEP) ledger.shift();
  if (last) {
    console.log(`Self: ${changed.map(k => (k === 'model' ? `model ${last.model} → ${fp.model}` : k === 'version' ? `version ${last.version} → ${fp.version}` : `${k} changed`)).join(', ')}`);
    for (const fn of listeners) try { fn(entry, last); } catch (err) { console.error('Identity listener:', err.message); }
  }
  return entry;
}

// hal9000_self_info{model, version, prompt, tools} 1, and hal9000_self_probation 1 while on probation: a change of
// self shows in Grafana as a new series (changes() over it marks the moment), next to what it did to the numbers.
addMetrics((sum, attr) => {
  const cur = ledger.at(-1);
  if (!cur) return [];
  const t = String(BigInt(Date.now()) * 1_000_000n), p = probation();
  return [{ name: 'hal9000.self.info', gauge: { dataPoints: [{ timeUnixNano: t, asDouble: 1, attributes: [attr('gen_ai.request.model', cur.model), attr('version', cur.version),
      attr('prompt', cur.prompt), attr('tools', cur.tools)] }] } },
    { name: 'hal9000.self.probation', gauge: { dataPoints: [{ timeUnixNano: t, asDouble: p ? 1 : 0, attributes: [attr('gen_ai.request.model', cur.model)] }] } }];
});

export const now = () => ledger.at(-1) ?? null;
export const history = () => [...ledger];
// Since when the current model has been the mind, and what it replaced (null before the first answer).
export function mindSince() {
  const cur = ledger.at(-1);
  if (!cur) return null;
  let i = ledger.length - 1;
  while (i > 0 && ledger[i - 1].model === cur.model) i--;
  const started = ledger[i];
  return { model: cur.model, since: started.changed.includes('first') ? null : started.at, from: i > 0 ? ledger[i - 1].model : null };
}

// { model, since, from, judged, needed } while a model that replaced another has fewer than 10 judged digs; else null.
export function probation() {
  const m = mindSince();
  if (!m?.from || m.since == null) return null;
  const n = judged(m.model, m.since);
  return n >= PROBATION_DIGS ? null : { ...m, judged: n, needed: PROBATION_DIGS };
}

// For self_check and describe_self: one or two plain sentences ('' before the first answer).
export function describeMind() {
  const m = mindSince();
  if (!m) return '';
  const p = probation(), when = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return `Mind: ${m.model}${m.since ? ` since ${when(m.since)}` : ''}${m.from ? ` (before that, ${m.from})` : ''}; version ${VERSION || 'unknown'}.` +
    (p ? ` New mind on probation: ${p.judged} of ${p.needed} digs judged so far, so I hold my own conclusions more loosely.` : '');
}

// Builds the LLM provider from the settings (config/index.js, "Mind"), which fall back to the environment:
//
//   mind.provider = openai-compatible | openai | anthropic   (env LLM_PROVIDER; openai there meant any OpenAI-style endpoint)
//   openai-compatible: mind.model, mind.baseUrl, mind.compatibleKey   (env LLM_MODEL, LLM_BASE_URL, LLM_API_KEY)
//   openai:            mind.openaiModel, mind.openaiKey                (env OPENAI_MODEL, OPENAI_API_KEY)
//   anthropic:         mind.anthropicModel, mind.anthropicEffort, mind.anthropicKey  (env ANTHROPIC_MODEL, LLM_EFFORT, ANTHROPIC_API_KEY)
//   LLM_FAST_MODEL / mind.quickEffort = model and reasoning effort for quick calls (OpenAI-style providers)
//   LLM_PROVIDER=scripted keeps the scripted replies (tests).
//
// A provider exposes send(system, messages, tools) -> { reply, message } | { toolCalls, message } | null,
// toolResults(calls, results) -> messages, and describeError(err).
// messages are user/assistant turns in the provider's own format; brain.js just appends them.
//
// signature() changes whenever the settings would build a different provider; brain.js then builds a new one and starts
// every conversation afresh (histories are in the old provider's format).

import * as anthropic from './anthropic.js';
import * as openai from './openai-compatible.js';
import * as config from '../config/index.js';

const OPENAI_URL = 'https://api.openai.com/v1';
const scripted = () => (process.env.LLM_PROVIDER || '').toLowerCase() === 'scripted';

export function signature() {
  if (scripted()) return 'scripted';
  const kind = config.get('mind.provider');
  const parts = kind === 'anthropic' ? [config.get('mind.anthropicModel'), config.get('mind.anthropicEffort'), config.get('mind.anthropicKey')]
    : kind === 'openai' ? [config.get('mind.openaiModel'), config.get('mind.openaiKey')]
    : [config.get('mind.baseUrl'), config.get('mind.compatibleKey')];   // the compatible model is read live, per call
  return JSON.stringify([kind, ...parts]);
}

export function createProvider(env = process.env) {
  if (scripted()) return null;
  const kind = config.get('mind.provider');
  const hedge = () => ({ quick: config.get('mind.hedgeQuickSeconds'), full: config.get('mind.hedgeFullSeconds') });
  let provider = null;
  if (kind === 'anthropic') {
    provider = anthropic.create({ apiKey: config.get('mind.anthropicKey'), model: config.get('mind.anthropicModel'), effort: config.get('mind.anthropicEffort') });
    if (!provider) console.warn('LLM: Anthropic selected but no API key is set (settings → Mind); using scripted replies.');
  } else if (kind === 'openai') {
    const model = config.get('mind.openaiModel'), apiKey = config.get('mind.openaiKey');
    provider = model && apiKey ? openai.create({ baseUrl: OPENAI_URL, apiKey, model, label: 'openai', fastEffort: () => config.get('mind.quickEffort'), hedge }) : null;
    if (!provider) console.warn('LLM: OpenAI selected but the model or API key is missing (settings → Mind); using scripted replies.');
  } else {
    const baseUrl = config.get('mind.baseUrl');
    provider = baseUrl && config.get('mind.model') ? openai.create({ baseUrl, apiKey: config.get('mind.compatibleKey'), fastModel: env.LLM_FAST_MODEL,
      model: () => config.get('mind.model'), fastEffort: () => config.get('mind.quickEffort'), hedge }) : null;
    if (!provider) console.warn('LLM: OpenAI-compatible selected but the endpoint or model is missing (settings → Mind); using scripted replies.');
  }
  return provider;
}

// The provider in use, shared by everything that calls the model (conversations, the situation board…). Rebuilt when
// the settings would build a different one; onRebuild listeners hear of it (brain.js starts conversations afresh).
let active, built;
const rebuilt = new Set();
export const onRebuild = fn => rebuilt.add(fn);
export function current() {
  const sig = signature();
  if (sig !== built) {
    const first = built === undefined;
    built = sig; active = createProvider();
    if (!first) { console.log(`Mind: now ${active?.name ?? 'scripted'}`); for (const fn of rebuilt) fn(active); }
  }
  return active;
}

// The models the chosen provider offers, for the settings page (empty when it can't be asked).
export async function models() {
  const kind = config.get('mind.provider');
  if (kind === 'anthropic') return anthropic.models(config.get('mind.anthropicKey')).catch(() => []);
  const base = kind === 'openai' ? OPENAI_URL : (config.get('mind.baseUrl') ?? '').replace(/\/$/, '');
  const key = kind === 'openai' ? config.get('mind.openaiKey') : config.get('mind.compatibleKey');
  if (!base) return [];
  return fetch(`${base}/models`, { signal: AbortSignal.timeout(5000), headers: key ? { Authorization: `Bearer ${key}` } : {} })
    .then(r => r.json()).then(d => (d.data ?? []).map(m => m.id).sort()).catch(() => []);
}

// ---- conversation first ----
// The model server may handle one request at a time, so background work (situation curation, drilldown
// suggestions) waits while anyone is in a conversation turn, rather than making the person wait behind it.
let talking = 0;
export async function foreground(fn) {
  talking++;
  try { return await fn(); } finally { talking--; }
}
// Runs fn once no conversation turn is in progress; after maxWaitMs it runs anyway, or with skip returns null.
export async function background(fn, maxWaitMs = 90_000, skip = false) {
  let waited = 0;
  for (; talking > 0 && waited < maxWaitMs; waited += 500) await new Promise(r => setTimeout(r, 500));
  if (skip && talking > 0) return null;
  return fn();
}

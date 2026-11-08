// The 9000's voice. Picks a speech provider from the environment and turns replies into audio the eye plays.
//
//   TTS_PROVIDER = comfyui | browser   (default: comfyui if COMFYUI_URL is set, else browser)
//   COMFYUI_URL, COMFYUI_TOKEN          (comfyui only)
//
// "browser" means no server audio: the eye falls back to its built-in speech synthesis.
// A provider exposes synthesize(text, theme) -> { audio: Buffer, type } and a name.

import crypto from 'node:crypto';
import * as comfyui from './comfyui.js';

function createProvider(env) {
  const kind = (env.TTS_PROVIDER || (env.COMFYUI_URL ? 'comfyui' : 'browser')).toLowerCase();
  if (kind === 'comfyui') {
    const p = comfyui.create({ url: env.COMFYUI_URL, token: env.COMFYUI_TOKEN });
    if (!p) console.warn('TTS: comfyui selected but COMFYUI_URL is not set; the eye will use browser speech.');
    return p;
  }
  if (kind !== 'browser') console.warn(`TTS: unknown provider "${kind}"; the eye will use browser speech.`);
  return null;
}

const provider = createProvider(process.env);
export const voiceName = provider?.name ?? 'browser';

// Replies are spoken a sentence at a time so the first one plays while the rest are still being made.
// Very short sentences ride along with the next one, which sounds more natural.
export function sentences(text) {
  // A sentence ends at . ! or ? followed by a space or the end, so 0.76, 192.168.1.21 and 0.40.0 stay whole.
  const parts = text.split(/(?<=[.!?]+["')\]]*)\s+/).map(s => s.trim()).filter(Boolean);
  if (!parts.length) return [text];
  const out = [];
  for (const s of parts) {
    if (out.length && out[out.length - 1].length < 25) out[out.length - 1] += ' ' + s;
    else out.push(s);
  }
  // Only the first clip delays the start of speech, so split a long first sentence at a comma.
  const m = out[0]?.length > 90 && out[0].slice(25).match(/^(.*?,)\s+(.+)$/s);
  if (m) out.splice(0, 1, out[0].slice(0, 25) + m[1], m[2]);
  return out;
}

// What the voice is given (the screen keeps the text as written): identifiers said the way a person reads them aloud.
//   192.168.1.21:6443  → 192 dot 168 dot 1 dot 21, port 6443
//   0.40.0, v1.32.4    → version 0 point 40 point 0, version 1 point 32 point 4
export function speakable(text) {
  return String(text)
    .replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?\b/g, (_, a, b, c, d, port) => `${a} dot ${b} dot ${c} dot ${d}${port ? `, port ${port}` : ''}`)
    .replace(/(^|[^\w.])([vV]ersion\s+|[vV])?(\d+)\.(\d+)\.(\d+)(?![\w.]*\d)/g, (_, pre, word, a, b, c) => `${pre}${word?.length > 1 ? word : 'version '}${a} point ${b} point ${c}`);
}

// What the voice says of a written answer (typed in the chat, server.js): its first plain sentence, without the markdown,
// and that the rest is on the screen when there's more (a list, code, more sentences, or a steps card). Underscores stay:
// they belong to names (tempo_ingester), not emphasis.
export function spokenLine(markdown, cards = 0) {
  const text = String(markdown ?? '').replace(/```[\s\S]*?(```|$)/g, '\n').trim();
  const lead = text.split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)[0]
    .replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^\s*(?:[-*•#>]+|\d+[.)])\s*/gm, '').replace(/\s+/g, ' ').trim();
  const first = lead.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? lead;
  const more = (text.replace(/\s+/g, ' ').length > first.length + 3 || cards > 0) && !/\bon (the|your) screens?\b/i.test(first);
  if (!first) return String(markdown ?? '').trim() || cards ? 'The details are on the screen.' : '';
  return `${first}${more ? ' The rest is on the screen.' : ''}`;
}

// Finished audio, keyed by voice + text, so repeated lines ("Returning to the overview.") are instant.
const cache = new Map();
const CACHE_MAX = 300;
// Clips in flight or ready, by unguessable id, for the eye to fetch from /tts/<id>.
const clips = new Map();
let queue = Promise.resolve();   // one synthesis at a time keeps sentence order and the GPU sane

function synthesizeCached(text, theme) {
  const key = `${theme}\n${text}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key); cache.set(key, hit);   // keep recently used lines
    return Promise.resolve(hit);
  }
  const job = queue.then(() => provider.synthesize(text, theme));
  queue = job.catch(() => {});
  return job.then(result => {
    cache.set(key, result);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return result;
  });
}

// Starts synthesis for a reply and returns [{ text, url }] for the eye, or null to use browser speech.
export function prepare(text, theme) {
  if (!provider) return null;
  return sentences(speakable(text)).map(part => {
    const id = crypto.randomBytes(12).toString('hex');
    const pending = synthesizeCached(part, theme);
    pending.catch(err => console.error(`TTS (${provider.name}): ${err.message}`));
    clips.set(id, pending);
    setTimeout(() => clips.delete(id), 10 * 60_000);
    return { text: part, url: `/tts/${id}` };
  });
}

// Waits for a clip; resolves to { audio, type } or null if unknown or failed.
export async function clip(id) {
  const pending = clips.get(id);
  if (!pending) return null;
  try { return await pending; } catch { return null; }
}

// Load both voices' models on the speech server at startup (and cache a common line), so the first
// real reply isn't slowed by model loading.
if (provider) {
  setTimeout(() => {
    for (const theme of ['hal', 'sal']) {
      synthesizeCached('All systems are functioning normally.', theme)
        .then(() => console.log(`TTS: ${theme} voice ready`))
        .catch(err => console.error(`TTS warm-up (${theme}): ${err.message}`));
    }
  }, 1000);
}

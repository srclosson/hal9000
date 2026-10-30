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
  const parts = text.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)?.map(s => s.trim()).filter(Boolean) ?? [text];
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
  return sentences(text).map(part => {
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

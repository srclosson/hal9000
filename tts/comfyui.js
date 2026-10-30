// Speech through a ComfyUI server running the Chatterbox nodes (ComfyUI_Fill-ChatterBox).
// Env: COMFYUI_URL (e.g. https://comfyui.stackgen.run), COMFYUI_TOKEN (Bearer token, optional on a private network).
//
// Voices were chosen in a listening test (auditions/voices): each is a Chatterbox node plus a reference
// clip staged in ComfyUI's input folder. The references are demo voices shipped with F5-TTS, not film audio.

export const VOICES = {
  // HAL moved from standard Chatterbox (candidate C) to Turbo (candidate I) with the same reference:
  // about twice as fast as real time, so long replies play without pauses. Keep temperature at 0.5;
  // at 0.3 Turbo looped on a test line.
  hal: {
    node: 'FL_ChatterboxTurboTTS',
    ref: 'voices/hal-9000.wav',
    inputs: { temperature: 0.5, top_k: 1000, top_p: 0.95, repetition_penalty: 1.2 },
  },
  sal: {
    node: 'FL_ChatterboxTurboTTS',
    ref: 'voices/sal-9000.wav',
    inputs: { temperature: 0.5, top_k: 1000, top_p: 0.95, repetition_penalty: 1.2 },
  },
};

export function create({ url, token } = {}) {
  if (!url) return null;
  const base = url.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) };

  async function api(path, body) {
    const res = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers,
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ComfyUI ${path}: HTTP ${res.status}`);
    return res;
  }

  function workflow(text, voice) {
    return {
      ref: { class_type: 'LoadAudio', inputs: { audio: voice.ref } },
      tts: {
        class_type: voice.node,
        inputs: { text, seed: 9000, keep_model_loaded: true, ...voice.inputs, audio_prompt: ['ref', 0] },
      },
      // PreviewAudio writes to ComfyUI's temp folder, which it clears on restart: no clutter in output/.
      out: { class_type: 'PreviewAudio', inputs: { audio: ['tts', 0] } },
    };
  }

  return {
    name: `comfyui@${new URL(base).host}`,

    // Returns { audio: Buffer, type } for one sentence.
    async synthesize(text, theme) {
      const voice = VOICES[theme] ?? VOICES.sal;
      const { prompt_id } = await (await api('/prompt', { prompt: workflow(text, voice) })).json();

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 150));
        const history = await (await api(`/history/${prompt_id}`)).json();
        const run = history[prompt_id];
        if (!run) continue;
        if (run.status?.status_str === 'error') {
          const err = run.status.messages?.find(m => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI run failed: ${err?.exception_message ?? 'unknown error'}`);
        }
        const file = Object.values(run.outputs ?? {}).flatMap(o => o.audio ?? [])[0];
        if (!file) throw new Error('ComfyUI run produced no audio');
        const q = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? '', type: file.type ?? 'temp' });
        const res = await api(`/view?${q}`);
        // ComfyUI serves audio as application/octet-stream; name the real type for the browser.
        const type = { flac: 'audio/flac', wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg' }[file.filename.split('.').pop()] ?? 'audio/flac';
        return { audio: Buffer.from(await res.arrayBuffer()), type };
      }
      throw new Error('ComfyUI run timed out');
    },
  };
}

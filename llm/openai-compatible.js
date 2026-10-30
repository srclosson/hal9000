// Any OpenAI-compatible /chat/completions endpoint: OpenAI, LiteLLM, Ollama, vLLM, Groq, OpenRouter...
// Env: LLM_BASE_URL (e.g. http://litellm.ollama.svc:4000/v1), LLM_MODEL, LLM_API_KEY (optional for Ollama).

// fastModel / fastEffort: used for calls marked { fast: true } (the opening call of a turn, background work):
// LLM_FAST_MODEL (default: the same model) with reasoning_effort LLM_FAST_EFFORT (default "low").
// model, fastEffort and hedge may be functions, read on every call (live settings).
// Mean token entropy in nats over the reply, from each token's top alternatives (renormalised): how unsure the model
// was of its own words. undefined when the provider gave no token probabilities.
function entropyOf(tokens) {
  if (!tokens?.length) return undefined;
  const per = tokens.map(t => {
    const ps = (t.top_logprobs?.length ? t.top_logprobs : [t]).map(x => Math.exp(x.logprob)), z = ps.reduce((a, b) => a + b, 0) || 1;
    return -ps.reduce((h, p) => h + (p / z) * Math.log(p / z || 1), 0);
  });
  return per.reduce((a, b) => a + b, 0) / per.length;
}

export function create({ baseUrl, model, apiKey, fastModel, fastEffort = 'low', hedge, label = 'openai-compatible' } = {}) {
  const val = v => (typeof v === 'function' ? v() : v);
  if (!baseUrl || !model) return null;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

  return {
    maxTools: label === 'openai' ? 128 : Infinity,   // OpenAI rejects a request offering more
    get name() { return `${label}:${val(model)}@${new URL(baseUrl).host}`; },

    // tools: [{ name, description, inputSchema }] (optional). Returns { reply, message, toolCalls? } or null.
    // Hedged: Ollama Cloud now and then takes a minute over a call that normally takes a second, at random. If a call
    // hasn't answered within LLM_HEDGE_MS (8 s for quick calls, 25 s otherwise), an identical one is sent and the
    // first answer wins; the other is cancelled.
    async send(system, messages, tools = [], { fast = false } = {}) {
      const hedgeMs = Number(process.env.LLM_HEDGE_MS) || (val(hedge)?.[fast ? 'quick' : 'full'] ?? (fast ? 8 : 25)) * 1000;
      const attempt = signal => this.sendOnce(system, messages, tools, { fast, signal });
      const a = new AbortController(), b = new AbortController();
      let hedged = false;
      const first = attempt(a.signal);
      const timer = new Promise(r => setTimeout(r, hedgeMs, 'hedge'));
      const early = await Promise.race([first.then(v => ({ v }), e => ({ e })), timer]);
      if (early !== 'hedge') { if (early.e) throw early.e; return early.v; }
      hedged = true;
      console.log(`LLM hedge: no answer after ${hedgeMs / 1000}s, sending a second request`);
      const second = attempt(b.signal);
      try {
        const win = await Promise.any([first.then(v => ['first', v]), second.then(v => ['second', v])]);
        (win[0] === 'first' ? b : a).abort();
        if (hedged) console.log(`LLM hedge: the ${win[0]} request answered`);
        return win[1];
      } catch (err) { throw err.errors?.[0] ?? err; }
    },

    async sendOnce(system, messages, tools = [], { fast = false, signal } = {}) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({
          model: fast && fastModel ? fastModel : val(model),
          // OpenAI's newest models take function tools on /chat/completions only without reasoning ("none").
          ...(label === 'openai' && tools.length ? { reasoning_effort: 'none' }
            : fast && val(fastEffort) && val(fastEffort) !== 'default' && { reasoning_effort: val(fastEffort) }),
          // Token probabilities, for the confusion signals (telemetry/index.js): OpenAI gives them only without reasoning.
          ...(label === 'openai' && tools.length && { logprobs: true, top_logprobs: 5 }),
          // Reasoning models spend part of this thinking; a story board's tool call is long. OpenAI's own API wants the newer name.
          ...(label === 'openai' ? { max_completion_tokens: 6000 } : { max_tokens: 6000 }),
          messages: [{ role: 'system', content: system }, ...messages],
          ...(tools.length && {
            tools: tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
          }),
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      const usage = { in: data.usage?.prompt_tokens ?? 0, out: data.usage?.completion_tokens ?? 0, entropy: entropyOf(data.choices?.[0]?.logprobs?.content) };

      if (msg.tool_calls?.length) {
        const toolCalls = msg.tool_calls.map(c => {
          let args = {};
          try { args = JSON.parse(c.function?.arguments || '{}'); } catch { /* model sent bad JSON: run with no args */ }
          return { id: c.id, name: c.function?.name, args };
        });
        return { toolCalls, usage, message: { role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls } };
      }

      const reply = msg.content?.trim();
      if (!reply) return { reply: '', usage, message: null };   // empty, not a refusal: the brain nudges for an answer
      return { reply, usage, message: { role: 'assistant', content: reply } };
    },

    // One look at an image (a JPEG from the eye): what the model sees, in words. Throws when the model takes no images.
    async see(jpegBase64, prompt) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey && { Authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({ model: val(model), ...(label === 'openai' ? { max_completion_tokens: 600 } : { max_tokens: 600 }),
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpegBase64}` } }] }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()).choices?.[0]?.message?.content?.trim() ?? '';
    },

    // Messages that hand tool results back to the model, in this API's format.
    toolResults: (calls, results) => calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: results[i] })),

    describeError: err => err.message,
  };
}

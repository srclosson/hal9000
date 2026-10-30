// Claude via the Anthropic SDK. Model, effort and key come from the settings (llm/index.js).

import Anthropic from '@anthropic-ai/sdk';

// Models that accept server-side refusal fallbacks (fallbacks: "default").
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

// The models the key can use, newest first, for the settings page.
export async function models(apiKey) {
  if (!apiKey) return [];
  const list = [];
  for await (const m of new Anthropic({ apiKey, timeout: 5000, maxRetries: 0 }).models.list()) list.push(m.id);
  return list;
}

export function create({ apiKey, model = 'claude-opus-5-5', effort = 'low' } = {}) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  const fallbacks = FALLBACK_MODELS.has(model);

  return {
    name: `anthropic:${model}`,

    // tools: [{ name, description, inputSchema }] (optional). Returns { reply, message, toolCalls? } or null.
    // One effort for every call: changing it between calls would throw away the prompt cache.
    async send(system, messages, tools = []) {
      const response = await client.beta.messages.create({
        model,
        max_tokens: 6000,   // a story board's tool call is long
        output_config: { effort },
        ...(fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
        cache_control: { type: 'ephemeral' },
        system,
        messages,
        ...(tools.length && { tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }),
      });
      if (response.stop_reason === 'refusal') return null;
      // Keep the full content (thinking and tool_use blocks included); the history must stay append-only.
      const message = { role: 'assistant', content: response.content };
      const toolCalls = response.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input }));
      if (response.stop_reason === 'tool_use' && toolCalls.length) return { toolCalls, message };
      const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
      if (!reply) return { reply: '', message: null };   // empty, not a refusal: the brain nudges for an answer
      return { reply, message };
    },

    // One look at an image (a JPEG from the eye): what Claude sees, in words.
    async see(jpegBase64, prompt) {
      const response = await client.messages.create({
        model, max_tokens: 1000, output_config: { effort: 'low' },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: prompt }] }],
      });
      if (response.stop_reason === 'refusal') return '';
      return response.content.filter(b => b.type === 'text').map(b => b.text).join(' ').trim();
    },

    // Tool results go back as one user message holding every tool_result block.
    toolResults: (calls, results) => [{
      role: 'user',
      content: calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: results[i] })),
    }],

    describeError(err) {
      if (err instanceof Anthropic.AuthenticationError) return 'invalid API key';
      if (err instanceof Anthropic.RateLimitError) return 'rate limited';
      if (err instanceof Anthropic.APIError) return `API error ${err.status}: ${err.message}`;
      return err.message;
    },
  };
}

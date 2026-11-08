// Steps on the screen: show_steps puts a card in the chat drawer with what a person should do, each step with the
// command to paste and what they should see. Commands never go in a reply's prose: they would be read aloud, and the
// speech cleaning would mangle them (_ > | and dots). The voice only says the steps are on the screen.
// A step is a Know-how runbook step ({ kind: look | act | check, text, command?, expect? }), so the drawer can save a
// card as a draft runbook as it is (knowhow/). A card holding what looks like a secret is refused, as Know-how refuses it.

import crypto from 'node:crypto';

const KINDS = ['look', 'act', 'check'], MAX_STEPS = 12;

// The same patterns as Know-how's lib/secrets.js: a card shows where a secret lives, never its value.
const SECRETS = [
  ['an AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ['a Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/],
  ['an API key', /\b(sk|rk|pk)_(live|test)?_?[A-Za-z0-9]{20,}\b/],
  ['a StackGen or Aiden key', /\b(aiden|sgi|kh)[-_][A-Za-z0-9_-]{24,}\b/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/i],
  ['a password or secret value', /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?(?!<|\$|\{\{|\*{3}|REDACTED|xxx)[^\s"'<>]{8,}/i],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:(?!<|\$|\*{3})[^\s/@]{6,}@/i],
];
export const secretsIn = text => SECRETS.filter(([, re]) => re.test(String(text ?? ''))).map(([what]) => what);

// { title, steps } from the model -> a card, or a string starting "Error" saying what to fix.
export function card(args = {}) {
  const title = String(args.title ?? '').trim().slice(0, 120);
  const steps = (Array.isArray(args.steps) ? args.steps : []).slice(0, MAX_STEPS).map(s => ({
    kind: KINDS.includes(String(s?.kind).toLowerCase()) ? String(s.kind).toLowerCase() : 'act',
    text: String(s?.text ?? '').trim().slice(0, 500),
    ...(s?.command && { command: String(s.command).replace(/\s+$/, '').slice(0, 4000) }),
    ...(s?.expect && { expect: String(s.expect).trim().slice(0, 300) }),
  })).filter(s => s.text);
  if (!title) return 'Error: give the card a title (what the steps achieve).';
  if (!steps.length) return 'Error: give at least one step, each with text (and a command when there is one to run).';
  const found = [...new Set([title, ...steps.flatMap(s => [s.text, s.command, s.expect])].flatMap(secretsIn))];
  if (found.length) return `Error: this looks like it contains ${found.join(', ')}. Say where the secret lives, or read it from an environment variable or a file, never its value.`;
  return { id: crypto.randomBytes(6).toString('hex'), title, steps };
}

export function tools() {
  return [{
    name: 'show_steps',
    description: 'Put steps for a person on the screen: a card in the chat with each step, the command to paste (with a copy button), and what they should see. ' +
      'Use it whenever the answer involves something a person runs: commands, queries, config, file edits. Never put those in your reply itself: ' +
      'say briefly that the steps are on the screen. Write each command for a junior engineer, with the real namespaces and names, ' +
      'a backup first before anything that could lose data, and never a secret\'s value (read it from an environment variable or a file). ' +
      'kind: look (read-only: it changes nothing), act (anything that writes: a change, and also a backup, which writes a file), check (how to tell it worked). ' +
      'The person can copy each command, and save the card as a runbook.',
    inputSchema: { type: 'object', required: ['title', 'steps'], properties: {
      title: { type: 'string', description: 'What the steps achieve, at most 10 words, e.g. "Release the Ghost migration lock".' },
      steps: { type: 'array', maxItems: MAX_STEPS, items: { type: 'object', required: ['text'], properties: {
        kind: { type: 'string', enum: KINDS },
        text: { type: 'string', description: 'What this step does and why, in plain words.' },
        command: { type: 'string', description: 'The exact command(s) to paste, several lines allowed. Omit when there is nothing to run.' },
        expect: { type: 'string', description: 'What they should see if it worked.' } } } } } },
  }];
}
export const has = name => name === 'show_steps';
export const describe = () => 'Putting the steps on your screen';

// hooks.cards: the answer's cards, shown with its reply in the chat drawer (none when there is no screen, as in a dig).
export async function call(name, args = {}, hooks = {}) {
  if (!Array.isArray(hooks.cards)) return 'Error: there is no screen to put steps on here; describe them in words instead.';
  const c = card(args);
  if (typeof c === 'string') return c;
  hooks.cards.push(c);
  return `The card "${c.title}" with ${c.steps.length} step${c.steps.length > 1 ? 's' : ''} is on the screen. Say so in a few words; don't read the commands.`;
}

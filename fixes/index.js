// Fixes: the only way the 9000 changes anything. It proposes a plan; the plan is shown on the monitors; a signed-in
// person approves it there (or by voice from a signed-in eye); only then does it run, step by step, and get checked.
//
// A plan's steps may only use "ask first" tools (Settings → MCP servers: tools set to "Ask first"), which are never
// offered to the model directly and can only be called for a step of an approved plan (mcp.call with approved).
// Each step's arguments are checked against the tool's schema. The plan is pinned by a hash of exactly what was shown,
// so what runs is what was approved; any change means a new plan and a new approval. Plans expire if not decided.
//
//   propose_fix { title, problem, steps: [{ tool, args, why }], expected, verify?, undo?, risk, incident? }
//   plan_status { id? }
//
// Lifecycle: pending → approved → running → (verifying →) verified | done | unverified | failed; or rejected | expired.

import crypto from 'node:crypto';
import * as mcp from '../mcp/index.js';
import * as config from '../config/index.js';
import { prom } from '../boards/index.js';

const MAX_STEPS = 6;
const plans = new Map();   // id -> plan
let seq = 0;
const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const DONE = new Set(['verified', 'done', 'unverified', 'failed', 'rejected', 'expired', 'replaced']);
const emit = plan => { if (DONE.has(plan.status) && !plan.finishedAt) plan.finishedAt = Date.now(); for (const fn of listeners) try { fn(plan); } catch (err) { console.error('Fixes listener:', err.message); } };

export const get = id => plans.get(id) ?? null;
export const pendingFor = room => [...plans.values()].filter(p => p.room === room && p.status === 'pending').at(-1) ?? null;
export const latestFor = room => [...plans.values()].filter(p => p.room === room).at(-1) ?? null;
export const available = () => mcp.approvalTools().length > 0;
// For timelines: the plans about an alert, or for an incident.
export const about = ({ alertUid, incident }) => [...plans.values()].filter(p => (alertUid && p.alertUid === alertUid) || (incident && p.incident === incident));
const OPEN = new Set(['pending', 'approved', 'running', 'verifying']);

// ---- checking a step against its tool's schema -----------------------------------------------------------
const TYPE = { string: v => typeof v === 'string', number: v => typeof v === 'number', integer: v => Number.isInteger(v), boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v), object: v => v && typeof v === 'object' && !Array.isArray(v) };
function checkStep(step, catalog) {
  const t = catalog.find(x => x.name === step.tool);
  if (!t) return `"${step.tool}" is not a tool that may be used in a plan (only tools set to "Ask first" in settings: ${catalog.map(x => x.name).join(', ') || 'none'}).`;
  const s = t.inputSchema ?? {}, args = step.args ?? {};
  if (!TYPE.object(args)) return `${step.tool}: args must be an object.`;
  for (const k of s.required ?? []) if (args[k] === undefined) return `${step.tool}: missing required argument "${k}".`;
  for (const [k, v] of Object.entries(args)) {
    const p = s.properties?.[k];
    if (!p) { if (s.additionalProperties === false) return `${step.tool}: unknown argument "${k}".`; continue; }
    const types = [].concat(p.type ?? []);
    if (types.length && !types.some(ty => TYPE[ty]?.(v) ?? true)) return `${step.tool}: argument "${k}" should be ${types.join(' or ')}.`;
    if (p.enum && !p.enum.includes(v)) return `${step.tool}: argument "${k}" must be one of ${p.enum.join(', ')}.`;
  }
  return null;
}

const hashOf = p => crypto.createHash('sha256').update(JSON.stringify([p.title, p.steps.map(s => [s.tool, s.args]), p.verify ?? null, (p.undo ?? []).map(s => [s.tool, s.args])])).digest('hex').slice(0, 16);

// ---- proposing ---------------------------------------------------------------------------------------------
// ctx: { room, alertUid } (the ship asking, and the alert it is alarming about, if any).
export function propose(input, ctx = {}) {
  const catalog = mcp.approvalTools();
  const steps = (input.steps ?? []).slice(0, MAX_STEPS + 1);
  if (!steps.length) return { error: 'A plan needs at least one step.' };
  if (steps.length > MAX_STEPS) return { error: `At most ${MAX_STEPS} steps; split it into smaller plans.` };
  for (const st of [...steps, ...(input.undo ?? [])]) { const e = checkStep(st, catalog); if (e) return { error: e }; }
  const v = input.verify;
  if (v && (!v.query || !['below', 'above'].includes(v.expect) || typeof v.value !== 'number')) return { error: 'verify needs { query (PromQL), expect: "below" | "above", value (number), minutes? }.' };
  // A new plan replaces this ship's undecided one.
  for (const p of plans.values()) if (p.room === ctx.room && p.status === 'pending') { p.status = 'replaced'; emit(p); }
  const now = Date.now(), server = name => catalog.find(x => x.name === name)?.server;
  const plan = {
    id: `P-${++seq}`, room: ctx.room, alertUid: ctx.alertUid ?? null, incident: input.incident ?? null,
    title: String(input.title ?? 'Fix').slice(0, 120), problem: String(input.problem ?? '').slice(0, 600),
    steps: steps.map(s => ({ tool: s.tool, server: server(s.tool), args: s.args ?? {}, why: String(s.why ?? '').slice(0, 200), status: 'pending', result: null })),
    expected: String(input.expected ?? '').slice(0, 300), risk: String(input.risk ?? '').slice(0, 300),
    verify: v ? { query: v.query, expect: v.expect, value: v.value, minutes: Math.min(15, Math.max(1, v.minutes ?? 5)), now: null, outcome: null } : null,
    undo: (input.undo ?? []).slice(0, MAX_STEPS).map(s => ({ tool: s.tool, server: server(s.tool), args: s.args ?? {}, why: String(s.why ?? '').slice(0, 200) })),
    destructive: steps.some(s => catalog.find(x => x.name === s.tool)?.destructive),
    status: 'pending', createdAt: now, expiresAt: now + config.get('fixes.expireMinutes') * 60_000, decidedBy: null, decidedAt: null, note: null,
  };
  plan.hash = hashOf(plan);
  plans.set(plan.id, plan);
  if (plans.size > 100) plans.delete(plans.keys().next().value);
  emit(plan);
  return { plan };
}

// ---- deciding ------------------------------------------------------------------------------------------------
// person: the signed-in person deciding (the server refuses anyone else). hash: what they saw.
export function decide(id, decision, person, hash) {
  const plan = plans.get(id);
  if (!plan) return 'There is no such plan.';
  if (plan.status !== 'pending') return `Plan ${plan.id} is already ${plan.status}.`;
  if (Date.now() > plan.expiresAt) { plan.status = 'expired'; emit(plan); return `Plan ${plan.id} has expired; ask for a fresh one.`; }
  if (hash && hash !== plan.hash) return `Plan ${plan.id} changed since it was shown; review it again.`;
  Object.assign(plan, { decidedBy: person, decidedAt: Date.now() });
  if (decision === 'reject') { plan.status = 'rejected'; emit(plan); return `Plan ${plan.id} rejected.`; }
  plan.status = 'approved';
  emit(plan);
  run(plan).catch(err => { Object.assign(plan, { status: 'failed', note: err.message }); emit(plan); });
  return `Plan ${plan.id} approved by ${person}. Running it now.`;
}

// Undecided plans expire (the situation may have moved on).
setInterval(() => { for (const p of plans.values()) if (p.status === 'pending' && Date.now() > p.expiresAt) { p.status = 'expired'; emit(p); } }, 30_000).unref();

// ---- running and checking -------------------------------------------------------------------------------
const failed = text => /^Error\b/.test(text);
async function run(plan) {
  plan.status = 'running';
  emit(plan);
  for (const step of plan.steps) {
    step.status = 'running';
    emit(plan);
    const out = await mcp.call(step.tool, step.args, { approved: true });
    step.result = String(out).slice(0, 600);
    step.status = failed(out) ? 'failed' : 'done';
    emit(plan);
    if (step.status === 'failed') {
      for (const rest of plan.steps.filter(s => s.status === 'pending')) rest.status = 'skipped';
      Object.assign(plan, { status: 'failed', note: `Step ${plan.steps.indexOf(step) + 1} failed: ${step.result.slice(0, 200)}` });
      return emit(plan);
    }
  }
  if (!plan.verify) { plan.status = 'done'; return emit(plan); }
  // Watch the expected signal for up to verify.minutes: verified as soon as it holds, else unverified.
  plan.status = 'verifying';
  emit(plan);
  const v = plan.verify, until = Date.now() + v.minutes * 60_000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 30_000));
    const r = await prom(v.query).catch(() => null);
    const now = r?.[0]?.value ? parseFloat(r[0].value[1]) : NaN;
    if (Number.isFinite(now)) v.now = now;
    if (Number.isFinite(now) && (v.expect === 'below' ? now < v.value : now > v.value)) { Object.assign(plan, { status: 'verified' }); v.outcome = 'held'; return emit(plan); }
    emit(plan);
  }
  v.outcome = 'not held';
  plan.status = 'unverified';
  emit(plan);
}

// An undo, as a new plan that needs its own approval.
export function proposeUndo(id) {
  const plan = plans.get(id);
  if (!plan?.undo?.length) return { error: 'That plan has no undo.' };
  return propose({ title: `Undo: ${plan.title}`, problem: `Reverses plan ${plan.id} (${plan.status}).`, steps: plan.undo,
    expected: 'Back to how things were before the plan ran.', risk: plan.risk, incident: plan.incident }, { room: plan.room, alertUid: plan.alertUid });
}

// ---- words ----------------------------------------------------------------------------------------------------
const STATUS_WORDS = { pending: 'awaiting approval', approved: 'approved', running: 'running', verifying: 'checking the result', verified: 'done and verified',
  done: 'done', unverified: 'done, but the expected result did not show', failed: 'failed', rejected: 'rejected', expired: 'expired unapproved', replaced: 'replaced by a newer plan' };
export const statusWords = p => STATUS_WORDS[p.status] ?? p.status;
export function describePlan(p) {
  const steps = p.steps.map((s, i) => `${i + 1}. ${s.tool}(${JSON.stringify(s.args)}) [${s.status}]${s.result && s.status !== 'pending' ? ` → ${s.result.slice(0, 160)}` : ''}`).join('\n');
  const v = p.verify ? `\nCheck: ${p.verify.query} ${p.verify.expect} ${p.verify.value} within ${p.verify.minutes} min${p.verify.now !== null ? `; latest ${p.verify.now}` : ''}${p.verify.outcome ? ` (${p.verify.outcome})` : ''}.` : '';
  return `Plan ${p.id} "${p.title}": ${statusWords(p)}${p.decidedBy ? ` (decided by ${p.decidedBy})` : ''}.\n${steps}${v}${p.note ? `\n${p.note}` : ''}`;
}

// ---- tools for the model ------------------------------------------------------------------------------------
function catalogText() {
  return mcp.approvalTools().slice(0, 40).map(t => {
    const s = t.inputSchema ?? {}, req = new Set(s.required ?? []);
    // Each argument with its allowed values, so what a tool can do is visible (create_command's action: …|replace|…).
    const args = Object.entries(s.properties ?? {}).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}${v?.enum ? `: ${v.enum.join('|')}` : ''}`).join(', ');
    return `${t.name}(${args}) [${t.server}${t.destructive ? ', destructive' : ''}]: ${t.description.replace(/\s+/g, ' ').slice(0, 320)}`;
  }).join('\n');
}
const STEP = { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' }, why: { type: 'string', description: 'One short sentence: what this step changes and why' } }, required: ['tool', 'args', 'why'] };

export function tools() {
  if (!available()) return [];
  return [
    { name: 'propose_fix',
      description: 'Propose a fix. This is the ONLY way you can change anything: the plan is shown on the monitors and runs only after a signed-in person approves it there. Investigate first, so every step rests on evidence; keep it minimal; prefer reversible steps and give the undo. Tools you may use in steps (and only these):\n' + catalogText(),
      inputSchema: { type: 'object', properties: {
        title: { type: 'string', description: 'What the fix does, in a few words, e.g. "Restart checkout-api"' },
        problem: { type: 'string', description: 'The problem and the evidence for it, two sentences' },
        steps: { type: 'array', items: STEP, maxItems: MAX_STEPS, description: 'Exact tool calls, in order' },
        expected: { type: 'string', description: 'What should change if it works, e.g. "error rate back under 1% within 5 minutes"' },
        verify: { type: 'object', properties: { query: { type: 'string', description: 'PromQL for one number' }, expect: { type: 'string', enum: ['below', 'above'] }, value: { type: 'number' }, minutes: { type: 'number' } },
          description: 'How to check it worked: a PromQL query that should go below (or above) a value within some minutes' },
        undo: { type: 'array', items: STEP, description: 'Tool calls that reverse the steps, if possible' },
        risk: { type: 'string', description: 'What could go wrong, one sentence' },
        incident: { type: 'string', description: 'The incident this is for, e.g. INC-0007, if any' } },
        required: ['title', 'problem', 'steps', 'expected', 'risk'] } },
    { name: 'plan_status', description: 'The state of a plan you proposed (the latest on this ship if no id): awaiting approval, running, verified, failed…',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  ];
}
export const has = name => name === 'propose_fix' || name === 'plan_status';
export const describe = name => (name === 'propose_fix' ? 'Drawing up a plan' : 'Checking the plan');

// ctx: the conversation hooks: board ({ room }) and alarm() (the alert this ship is alarming about, if any).
export async function call(name, args = {}, hooks = {}) {
  const ctx = { room: hooks.board?.room, alertUid: hooks.alarm?.()?.uid };
  if (name === 'plan_status') {
    const p = args.id ? get(args.id) : latestFor(ctx.room);
    return p ? describePlan(p) : 'No plan has been proposed on this ship.';
  }
  const r = propose(args, { room: ctx.room, alertUid: ctx.alertUid });
  if (r.error) return `The plan was not shown: ${r.error} Fix it and propose again.`;
  return `Plan ${r.plan.id} is on the monitors, awaiting approval by a signed-in person. Tell them in one or two sentences what it will do and that it needs their approval on the screen; ` +
    'do not say it has been done. You will be told the outcome; plan_status reports it.';
}

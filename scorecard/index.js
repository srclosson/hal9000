// The scorecard: how well the 9000 (and Aiden) do their work, so anyone can ask at any time.
//
// Each piece of work is a case: a board dig, an answer to a person, a plan, an Aiden investigation. A case is judged
// from what happens next, never assumed right:
//   dig     the problem cleared within 2 h → likely right; snoozed → disputed; still there after 2 h → unknown
//   answer  the person corrected it ("that's wrong") → disputed; otherwise unknown after 30 min
//   plan    its check held → likely right; it did not hold, or was undone → wrong; it failed → failed;
//           rejected → disputed
//   aiden   the 9000's review: good → likely right, partly right → disputed, wrong → wrong, failed → failed
//   forecast the confidence forecast before a dig (confidence/): within 0.2 of the dig's confusion → likely right,
//           else wrong
//   outlook  a metric forecast raised on the board (home/ahead.js): the series crossed its threshold → likely right;
//           still under it 2 h past the forecast time → wrong
// A thumbs up or down from a person (a chat answer, a situation card, or said aloud: rate) makes it right or wrong.
//
// Kept in memory (the last 1000 cases, for the details) and exported as counters through the 9000's own telemetry
// (hal9000_cases_total, hal9000_verdicts_total, hal9000_work_tokens_total, hal9000_work_milliseconds_total, by kind),
// so the totals survive restarts and the scorecard tool reads a week from the metrics store when it can.

import * as resume from '../resume/index.js';
import * as identity from '../identity/index.js';

export const KINDS = { dig: 'board digs', answer: 'answers', plan: 'plans', aiden: 'Aiden investigations', forecast: 'confidence forecasts', outlook: 'metric forecasts' };
export const VERDICTS = ['right', 'likely_right', 'disputed', 'wrong', 'failed', 'unknown'];
const SETTLE = { dig: 2 * 3600_000, answer: 30 * 60_000, plan: 24 * 3600_000, aiden: 0, forecast: 0, outlook: 3 * 86_400_000 };   // outlooks: judged by home/ahead.js; this catches ones left when forecasts are switched off
const MAX = 1000;

const cases = [];   // { id, kind, key, room, at, about, ms, tokens, model, verdict, why, judgedAt }
let seq = 0;
const counts = { cases: {}, verdicts: {}, tokens: {}, ms: {} };   // keyed "kind|model" (verdicts: "kind|model|verdict")
const bump = (o, k, n = 1) => { o[k] = (o[k] ?? 0) + n; };
// Kept across a restart (resume/): the cases, so ones still open are judged and the details survive. The counters
// aren't: they are cumulative since start and the metrics store already has the totals.
resume.register('scorecard', {
  save: () => resume.fit(cases.slice(-300), 150_000),
  restore: list => {
    if (cases.length) return;
    cases.push(...(list ?? []));
    seq = Math.max(seq, ...cases.map(c => Number(String(c.id).slice(1)) || 0));
  },
});

export function record(kind, { key = null, room = null, about = '', ms = 0, tokens = 0 } = {}) {
  // The model doing the work (identity/): each model is judged on its own record.
  const model = identity.now()?.model ?? 'unknown';
  const c = { id: `S${++seq}`, kind, key, room, at: Date.now(), about: String(about).slice(0, 200), ms: Math.round(ms), tokens: Math.round(tokens), model, verdict: null, why: '' };
  cases.push(c);
  if (cases.length > MAX) cases.shift();
  const k = `${kind}|${model}`;
  bump(counts.cases, k); bump(counts.tokens, k, c.tokens); bump(counts.ms, k, c.ms);
  return c;
}

// A verdict for a case (by id or the case itself). A person's thumbs (right / wrong) replace an earlier verdict, and
// so does force (strong evidence, such as being undone); anything else only settles a case still open.
export function judge(target, verdict, why = '', { force = false } = {}) {
  const c = typeof target === 'string' ? cases.find(x => x.id === target) : target;
  if (!c || !VERDICTS.includes(verdict)) return null;
  const person = ['right', 'wrong'].includes(verdict) && /^(by|from) /.test(why);
  if (c.verdict && !person && !force) return c;
  const k = `${c.kind}|${c.model ?? 'unknown'}`;
  if (c.verdict) bump(counts.verdicts, `${k}|${c.verdict}`, -1);
  Object.assign(c, { verdict, why: String(why).slice(0, 200), judgedAt: Date.now() });
  bump(counts.verdicts, `${k}|${verdict}`);
  console.log(`SCORE ${c.kind} ${c.id} ${verdict}${why ? ` (${c.why})` : ''}: ${c.about.slice(0, 100)}`);
  return c;
}

// For identity/'s probation: how many of a model's digs since a time have a verdict (unknown doesn't count).
export const judgedSince = (model, since) => cases.filter(c => c.kind === 'dig' && c.model === model && c.at >= since && c.verdict && c.verdict !== 'unknown').length;
identity.setJudged(judgedSince);

export const latest = (kind, match = () => true) => cases.findLast(c => c.kind === kind && match(c)) ?? null;
export const open = kind => cases.filter(c => c.kind === kind && !c.verdict);
export const get = id => cases.find(c => c.id === id) ?? null;

// Cases left open past their time are settled as unknown.
export function settle(now = Date.now()) {
  for (const c of cases) if (!c.verdict && SETTLE[c.kind] && now - c.at > SETTLE[c.kind]) judge(c, 'unknown', 'no sign either way');
}
setInterval(() => settle(), 60_000).unref?.();

// ---- what feeds it -----------------------------------------------------------------------------------------------

// The situation board, after each composition: open dig cases whose problem is gone, or snoozed.
export function board(onBoard, isSnoozed) {
  for (const c of open('dig')) {
    if (isSnoozed(c.key)) judge(c, 'disputed', 'snoozed: not worth attention');
    else if (!onBoard.has(c.key)) judge(c, 'likely_right', `the problem cleared ${Math.max(1, Math.round((Date.now() - c.at) / 60_000))} min after the finding`);
  }
}

// A plan as it moves (fixes/index.js): one case per plan, judged by how it ends.
const PLAN_VERDICT = { verified: ['likely_right', 'its check held'], unverified: ['wrong', 'its check did not hold'], failed: ['failed', 'a step failed'],
  rejected: ['disputed', 'rejected'], expired: ['unknown', 'expired before anyone decided'], done: ['unknown', 'ran, with no check'] };
export function plan(p) {
  let c = latest('plan', x => x.key === p.id);
  if (!c) c = record('plan', { key: p.id, room: p.room, about: p.title });
  if (p.status === 'running' && /^Undo: /.test(p.title)) {
    const of = String(p.problem ?? '').match(/plan (\S+?)[ .(]/)?.[1], was = of && latest('plan', x => x.key === of);
    if (was) judge(was, 'wrong', 'undone', { force: true });
  }
  const v = PLAN_VERDICT[p.status];
  if (v) judge(c, v[0], `${v[1]}${p.status === 'rejected' && p.decidedBy ? ` by ${p.decidedBy}` : ''}`);
}

// The 9000's review of an Aiden investigation (aiden/review.js).
export function aiden(run, verdict) {
  const c = record('aiden', { key: run.uid, about: run.title, ms: (run.finishedAt ?? Date.now()) - run.startedAt });
  const v = /^good/.test(verdict) ? 'likely_right' : /^partly/.test(verdict) ? 'disputed' : /^wrong/.test(verdict) ? 'wrong' : /^fail/.test(verdict) ? 'failed' : 'unknown';
  judge(c, v, `the 9000's review: ${verdict}`);
  return c;
}

// A person's next words after an answer: a plain correction disputes it.
const CORRECTION = /\b(that'?s|that is|you'?re|you are) (wrong|not right|incorrect|mistaken)\b|\bnot true\b|\bincorrect\b|\bwrong answer\b/i;
export function heard(room, text) {
  if (!CORRECTION.test(text)) return null;
  const c = latest('answer', x => x.room === room && !x.verdict && Date.now() - x.at < 15 * 60_000);
  return c ? judge(c, 'disputed', `corrected: "${String(text).slice(0, 80)}"`) : null;
}

// ---- the record, for metrics and for the 9000 -------------------------------------------------------------------

// Exported through telemetry/index.js (sum: its cumulative-counter maker).
export function metrics(sum, attr) {
  const out = [], models = new Set([identity.now()?.model ?? 'unknown', ...Object.keys(counts.cases).map(k => k.split('|')[1])]);
  for (const model of models) for (const kind of Object.keys(KINDS)) {
    const k = `${kind}|${model}`, a = [attr('kind', kind), attr('gen_ai.request.model', model)];
    out.push(sum('hal9000.cases', '{case}', counts.cases[k] ?? 0, a));
    out.push(sum('hal9000.work.tokens', '{token}', counts.tokens[k] ?? 0, a));
    out.push(sum('hal9000.work.milliseconds', 'ms', counts.ms[k] ?? 0, a));
    for (const v of VERDICTS) out.push(sum('hal9000.verdicts', '{case}', Math.max(0, counts.verdicts[`${k}|${v}`] ?? 0), [...a, attr('verdict', v)]));
  }
  return out;
}

const words = v => v.replace('_', ' ');
const fmtK = n => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString('en-US'));
const secs = ms => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
function line(kind, n, by, tokens, ms) {
  if (!n) return null;
  const judged = VERDICTS.filter(v => by[v]).map(v => `${by[v]} ${words(v)}`).join(', ');
  const open = n - VERDICTS.reduce((a, v) => a + (by[v] ?? 0), 0);
  return `${KINDS[kind][0].toUpperCase() + KINDS[kind].slice(1)}: ${n}${judged ? ` (${judged}${open > 0 ? `, ${open} not settled yet` : ''})` : open > 0 ? ` (${open} not settled yet)` : ''}` +
    `${ms ? `; ${secs(ms / n)} each on average` : ''}${tokens ? `, about ${fmtK(Math.round(tokens / n))} model tokens each` : ''}.`;
}

// prom(expr) -> Prometheus vector or null: the week from the metrics store; else what this run has seen.
export async function summary({ days = 7, prom } = {}) {
  const span = `${Math.round(days * 24)}h`;
  let source = `the last ${days === 1 ? 'day' : `${days} days`} (from the metrics store)`, data = null;
  if (prom) {
    const q = async (m, by) => (await prom(`sum by (${by}) (increase(${m}{job="hal9000"}[${span}]))`).catch(() => null)) ?? null;
    const [n, v, t, ms] = await Promise.all([q('hal9000_cases_total', 'kind'), q('hal9000_verdicts_total', 'kind, verdict'), q('hal9000_work_tokens_total', 'kind'), q('hal9000_work_milliseconds_total', 'kind')]);
    if (n?.length) {
      const val = x => Math.round(parseFloat(x.value?.[1]) || 0);
      data = Object.fromEntries(Object.keys(KINDS).map(k => [k, { n: val(n.find(x => x.metric.kind === k) ?? {}), by: {}, tokens: val(t?.find(x => x.metric.kind === k) ?? {}), ms: val(ms?.find(x => x.metric.kind === k) ?? {}) }]));
      for (const x of v ?? []) if (data[x.metric.kind]) data[x.metric.kind].by[x.metric.verdict] = val(x);
    }
  }
  if (!data) {
    source = 'since the 9000 last started (the metrics store had no record)';
    const since = Date.now() - days * 86_400_000;
    data = Object.fromEntries(Object.keys(KINDS).map(k => {
      const xs = cases.filter(c => c.kind === k && c.at >= since), by = {};
      for (const c of xs) if (c.verdict) by[c.verdict] = (by[c.verdict] ?? 0) + 1;
      return [k, { n: xs.length, by, tokens: xs.reduce((a, c) => a + c.tokens, 0), ms: xs.reduce((a, c) => a + c.ms, 0) }];
    }));
  }
  const lines = Object.keys(KINDS).map(k => line(k, data[k].n, data[k].by, data[k].tokens, data[k].ms)).filter(Boolean);
  // The cases worth a look: what was disputed or wrong, with why (details are kept since the last start).
  const bad = cases.filter(c => ['disputed', 'wrong', 'failed'].includes(c.verdict)).slice(-6).reverse()
    .map(c => `${c.id} ${KINDS[c.kind].replace(/s$/, '')} ${words(c.verdict)}: "${c.about.slice(0, 80)}" (${c.why})`);
  // Each model on its own record (identity/): board digs per model, when more than one did the work.
  const since = Date.now() - days * 86_400_000, perModel = {};
  for (const c of cases.filter(x => x.kind === 'dig' && x.at >= since)) {
    const m = (perModel[c.model ?? 'unknown'] ??= { n: 0, by: {} });
    m.n++; if (c.verdict) m.by[c.verdict] = (m.by[c.verdict] ?? 0) + 1;
  }
  const byModel = Object.keys(perModel).length > 1 ? ['Board digs by model (on record here):', ...Object.entries(perModel).map(([m, x]) =>
    `- ${m}: ${x.n}${Object.keys(x.by).length ? ` (${VERDICTS.filter(v => x.by[v]).map(v => `${x.by[v]} ${words(v)}`).join(', ')})` : ''}`)] : [];
  const mind = identity.describeMind();
  const extra = [...(mind ? [mind] : []), ...byModel, ...(await Promise.all(notes.map(fn => Promise.resolve().then(fn).catch(() => [])))).flat()];
  return [`Scorecard, ${source}:`, ...(lines.length ? lines : ['Nothing recorded yet.']),
    'Likely right means what happened next agreed (the problem cleared, the check held); it is not proof. Right and wrong come from a person.',
    ...(bad.length ? ['Recent cases that went badly:', ...bad.map(b => `- ${b}`)] : []), ...extra].join('\n');
}
// More lines for the summary from elsewhere (the confidence forecast's blind spots): fn() -> [line, ...].
const notes = [];
export const addNotes = fn => notes.push(fn);

// ---- tools for the model -------------------------------------------------------------------------------------------
let promSource = null;
export const setProm = fn => { promSource = fn; };

export function tools() {
  return [
    { name: 'scorecard',
      description: 'How well you and Aiden have been doing: board digs, answers, plans and Aiden investigations, each counted and judged from what happened next (likely right, disputed, wrong, failed, or not settled), with time and model tokens per piece of work, and recent cases that went badly. Use when asked how you are doing, how accurate you or Aiden are, or what your work costs.',
      inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Look-back in days, default 7' } } } },
    { name: 'rate',
      description: 'Record a person\'s verdict on your work when they say it was right or wrong: your last answer, a situation card (by its panel code), your last plan, or Aiden\'s last investigation. Only when the person says so, never on your own judgement.',
      inputSchema: { type: 'object', properties: { what: { type: 'string', enum: ['answer', 'card', 'plan', 'aiden'] }, code: { type: 'string', description: 'For a card: its panel code' },
        right: { type: 'boolean' }, note: { type: 'string' } }, required: ['what', 'right'] } },
  ];
}
export const has = name => name === 'scorecard' || name === 'rate';
export const describe = name => (name === 'rate' ? 'Noting that' : 'Checking my scorecard');

// keyOfCard(code) -> the dig key ("cluster:signal") of a situation card, set by the server.
let keyOfCard = () => null;
export const setCardKeys = fn => { keyOfCard = fn; };

export async function call(name, args = {}, hooks = {}) {
  if (name === 'scorecard') return summary({ days: Math.max(1, Math.min(90, Number(args.days) || 7)), prom: promSource });
  const room = hooks.board?.room, by = hooks.person ? `by ${hooks.person}` : 'from a person';
  const c = args.what === 'answer' ? latest('answer', x => x.room === room)
    : args.what === 'card' ? latest('dig', x => x.key === keyOfCard(String(args.code ?? '').toUpperCase()))
    : args.what === 'plan' ? latest('plan', x => x.room === room) : args.what === 'aiden' ? latest('aiden') : null;
  if (!c) return `There is no ${args.what === 'card' ? `dig for the card ${args.code ?? ''}` : args.what} on record to rate.`;
  judge(c, args.right ? 'right' : 'wrong', `${by}${args.note ? `: ${args.note}` : ''}`);
  return `Recorded ${c.id} as ${args.right ? 'right' : 'wrong'}.`;
}

// A critical review of each Aiden result. Aiden is StackGen's own AI SRE and has to be excellent, so when one of its
// investigations ends (finished, failed, or unable to find the alert) the 9000 checks it against the live data with
// read-only lookups (brain.digIn, passed in) and, when it falls short, files the feedback for engineering in
// StackGen Incidents: another case of an open "Aiden feedback:" incident is added to its timeline; a new kind of
// problem opens one (severity 4). Filing is done here, in code, so it always looks before it opens.
//
//   review(run, { digIn }) -> { verdict, say, ref, action: 'noted' | 'opened' | null } or null

import * as incidents from '../incidents/index.js';

export const PREFIX = 'Aiden feedback:';
const ACTOR = 'HAL 9000 (review of Aiden)';
const mins = run => Math.max(1, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 60_000));

export function question(run, open = []) {
  const what = run.summary ? `Its result:\n${run.summary}`
    : run.status === 'unmatched' ? 'It could not investigate: it had no record of the alert.'
    : `It did not finish${run.error ? ` (${run.error})` : ''}.`;
  return `[Automatic: a review of Aiden's work. Aiden is StackGen's own AI SRE, our main product, and it has to be excellent: your review goes to its engineers. ` +
    `Be a demanding, critical reviewer, and fair: every criticism must rest on evidence you checked, never on taste or wording. ` +
    `Aiden was asked to investigate the alert "${run.title}"${run.cluster ? ` on ${run.cluster}` : ''}${run.service ? ` (${run.service})` : ''}, uid ${run.uid}; it ended "${run.status}" after ${mins(run)} min. ${what}\n` +
    `Check it against the live data with your read-only tools, starting with investigate for that alert uid. Judge: is the cause right, and supported by what it cites? ` +
    `Do the pods, services, metrics and changes it names exist? Is the advice specific and safe enough to act on? Did it miss something you found? ` +
    `Was it too slow for what was asked? Did it fail to finish, or to find the alert?\n` +
    `Open Aiden feedback incidents: ${open.length ? open.map(i => `${i.ref} "${i.title}"`).join('; ') : 'none'}.\n` +
    `Reply with exactly these labelled parts and nothing else:\n` +
    `VERDICT: good, partly right, wrong or failed.\n` +
    `PROBLEMS: each problem with its evidence (what Aiden said, what you saw instead, where), at most 90 words; none if good.\n` +
    `FILE: the ref of the open feedback incident this is another case of (the same kind of problem), NEW for a new kind, or NONE if it was good.\n` +
    `TITLE: for NEW, the kind of problem in at most 10 words, e.g. "names pods that do not exist"; otherwise none.\n` +
    `SAY: one plain, specific sentence for the person about how Aiden did.]`;
}

export function read(text) {
  // Digs come back unformatted (brain.js keeps them raw for runbook commands); this reply is read aloud, so clean it as speech is.
  const flat = String(text ?? '').replace(/```[\s\S]*?(```|$)/g, '').replace(/[*_#`>|~]+/g, '').replace(/\s+/g, ' ').trim();
  const m = flat.match(/VERDICT:\s*(.+?)\s*PROBLEMS:\s*(.+?)\s*FILE:\s*(\S+?)\.?\s+TITLE:\s*(.+?)\s*SAY:\s*(.+)$/i);
  if (!m) return null;
  const verdict = m[1].toLowerCase().replace(/\.$/, ''), file = m[3].toUpperCase();
  return { verdict, problems: m[2].replace(/\.$/, ''), file: /^(NEW|NONE)$/.test(file) ? file : m[3], title: m[4].replace(/\.$/, ''), say: m[5].trim() };
}

// The case as engineering will read it.
function details(run, r) {
  return [`Alert: "${run.title}"${run.cluster ? ` on ${run.cluster}` : ''}${run.service ? ` (${run.service})` : ''}, uid ${run.uid}.`,
    `Aiden ended "${run.status}" after ${mins(run)} min, started ${new Date(run.startedAt).toISOString()}.${run.url ? ` Investigation: ${run.url}` : ''}`,
    run.summary ? `Aiden's result:\n${run.summary}` : run.error ? `Error: ${run.error}` : '',
    `HAL's verdict: ${r.verdict}.`, `Problems found: ${r.problems}`].filter(Boolean).join('\n\n');
}

export async function review(run, { digIn }) {
  if (!digIn) return null;
  const open = incidents.available() ? (await incidents.listOpen().catch(() => [])).filter(i => String(i.title ?? '').startsWith(PREFIX)) : [];
  const r = read((await digIn(question(run, open)))?.reply);
  if (!r) return null;
  if (/^good/.test(r.verdict) || r.file === 'NONE' || !incidents.available()) return { verdict: r.verdict, say: r.say, ref: null, action: null };
  const same = open.find(i => i.ref.toUpperCase() === String(r.file).toUpperCase());
  if (same) {
    await incidents.addEvent(same.ref, 'finding', `Another case.\n\n${details(run, r)}`, ACTOR);
    return { verdict: r.verdict, say: r.say, ref: same.ref, action: 'noted' };
  }
  const kind = /^none$/i.test(r.title) ? `${run.status === 'completed' || run.status === 'draft' ? 'result' : run.status} for "${run.title}"` : r.title;
  const i = await incidents.declare({ title: `${PREFIX} ${kind}`.slice(0, 120), severity: 4, summary: `Found reviewing Aiden's investigation of "${run.title}". ${r.problems}`.slice(0, 900) }, ACTOR);
  await incidents.addEvent(i.ref, 'finding', details(run, r), ACTOR);
  return { verdict: r.verdict, say: r.say, ref: i.ref, action: 'opened' };
}

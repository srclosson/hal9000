// Timelines: what happened, in order, around an alert or an incident, for the timeline panel (boards, kind
// "timeline"). One list of events from every source the 9000 knows:
//   alert      when the alert fired (Grafana's activeAt), and when it cleared (seen by the 9000)
//   change     deploys, scaling, config changes in its cluster (changes/index.js)
//   ack        who acknowledged it, when
//   aiden      Aiden started investigating; Aiden's finding
//   plan       a plan proposed, approved (by whom), and how it ended (worked, failed…)
//   incident   the incident's own timeline: declared, status and severity changes, findings, notes
// Events the incident already records (acknowledgement, Aiden, plans) are taken from the live sources when the
// incident doesn't have them, so nothing shows twice.

import { changes } from '../changes/index.js';
import * as alerts from '../alerts/index.js';
import * as aiden from '../aiden/index.js';
import * as fixes from '../fixes/index.js';
import * as incidents from '../incidents/index.js';

// Facts only the server holds (acknowledgements, alerts clearing), registered by it: uid -> [events].
let serverFacts = () => [];
export const configure = ({ facts }) => { serverFacts = facts ?? serverFacts; };

const short = (s, n = 90) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const firstSentence = s => short(String(s ?? '').match(/^[^.!?]+[.!?]?/)?.[0] ?? s, 110);

// INCIDENT EVENT KINDS -> timeline kinds (others are left out: memory, ai chatter).
const FROM_INCIDENT = { status: 'incident', severity: 'incident', role: 'incident', finding: 'incident', note: 'incident', ack: 'ack', change: 'plan', alert: 'alert', evidence: 'incident' };

// -> { from, to, rule, events: [{ t, kind, label, detail? }] } oldest first. minutes: the window when nothing anchors it.
export async function collect({ alertUid, incident: ref, cluster, minutes = 60 } = {}) {
  const [rule, inc] = await Promise.all([alertUid ? alerts.rule(alertUid).catch(() => null) : null, incidents.get(ref)]);
  const uid = alertUid ?? inc?.alert_uid ?? null;
  const events = [];
  const add = (t, kind, label, detail) => { const ms = typeof t === 'number' ? t : Date.parse(t); if (Number.isFinite(ms)) events.push({ t: ms, kind, label: short(label), ...(detail && { detail: String(detail).slice(0, 1200) }) }); };

  if (rule?.since) add(rule.since, 'alert', `Alert fired: ${rule.title}`, rule.error ? `The rule itself fails to evaluate: ${rule.error}` : rule.notes);
  for (const f of uid ? serverFacts(uid) : []) add(f.t, f.kind, f.label, f.detail);

  if (inc) {
    add(inc.detected_at ?? inc.created_at, 'incident', `${inc.ref} declared: ${inc.title}`, inc.summary);
    for (const e of inc.events ?? []) {
      const kind = FROM_INCIDENT[e.kind];
      if (!kind || (e.kind === 'note' && /^Declared/i.test(e.body))) continue;
      add(e.at, /^Aiden/.test(e.author ?? '') || /^Aiden \(deep/.test(e.body) ? 'aiden' : kind, e.kind === 'finding' ? firstSentence(e.body) : e.body, e.body);
    }
  }
  const have = kind => events.some(e => e.kind === kind);
  // Live sources, where the incident doesn't already record them.
  const run = uid && aiden.get(uid);
  if (run && !have('aiden')) {
    add(run.startedAt, 'aiden', 'Aiden started investigating');
    if (aiden.finished(run)) add(run.finishedAt, 'aiden', `Aiden: ${firstSentence(run.summary)}`, run.summary);
  }
  if (!have('plan')) for (const p of fixes.about({ alertUid: uid, incident: inc?.ref ?? ref })) {
    add(p.createdAt, 'plan', `Plan ${p.id} proposed: ${p.title}`, p.steps.map((s, i) => `${i + 1}. ${s.tool} ${JSON.stringify(s.args)}`).join('\n'));
    if (p.decidedAt) add(p.decidedAt, 'plan', `Plan ${p.id} ${p.status === 'rejected' ? 'rejected' : 'approved'} by ${p.decidedBy}`);
    if (p.finishedAt && p.status !== 'rejected') add(p.finishedAt, p.status === 'verified' ? 'resolve' : 'plan', `Plan ${p.id}: ${fixes.statusWords(p)}`, p.note ?? '');
  }

  // The window: from a little before the first event (or the given minutes) to now; at most a day.
  // Anchored on the last day's events (an alert firing for a week shouldn't stretch the axis to a week); an earlier
  // start is marked at the left edge below.
  // Sized to the events: from a little before the first (a quarter of the span, at least five minutes), at least
  // 15 minutes wide; with no events, the given minutes.
  const now = Date.now(), recent = events.map(e => e.t).filter(t => t > now - 24 * 3600_000);
  const first = recent.length ? Math.min(...recent) : now - minutes * 60_000;
  const pad = recent.length ? Math.max(5 * 60_000, (now - first) * .25) : 0;
  const from = Math.max(now - 24 * 3600_000, Math.min(first - pad, now - 15 * 60_000));
  // Changes in the cluster across that window.
  const where = cluster ?? rule?.cluster ?? inc?.clusters?.[0];
  if (where) for (const c of await changes(where, Math.ceil((now - from) / 60_000)).catch(() => [])) add(c.time, 'change', c.label, c.items?.map(i => i.text).join('\n'));

  // Already firing before the window opens: say so at its left edge.
  const firedAt = rule?.since ? Date.parse(rule.since) : NaN;
  if (Number.isFinite(firedAt) && firedAt < from) add(from, 'alert', `Firing since ${new Date(firedAt).toISOString().slice(5, 16).replace('T', ' ')} UTC`);
  const seen = new Set();
  const list = events.filter(e => e.t >= from).sort((a, b) => a.t - b.t)
    .filter(e => { const k = `${e.kind}|${Math.round(e.t / 60_000)}|${e.label.slice(0, 40)}`; return !seen.has(k) && seen.add(k); }).slice(-24);
  return { from, to: now, rule, incident: inc, events: list };
}

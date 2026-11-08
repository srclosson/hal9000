// Drilldown: questions worth asking about one panel on the screen.
// Quick questions come from the panel's own data at once (no LLM); the 9000 then suggests sharper ones, which
// replace them when ready. Suggestions are cached per panel and health state for a couple of minutes.

import * as boards from './boards/index.js';
import { complete } from './brain.js';

const CACHE_MS = 2 * 60_000;
const MAX = 4;
const cache = new Map();   // `${board}|${code}|${status}|${headline}` -> { at, questions }

const short = s => String(s ?? '').replace(/-prod(-cluster|-us-east-\d)?$|-cluster$/, '');
const lower = s => String(s ?? '').toLowerCase();

// Questions from the panel's kind and data: the worst item, the faulty service, the alerting cluster.
export function quick(info) {
  const { panel: p, spec, home, part } = info;
  // Situation panels read "Retail · Worst latency" (the signal last); other titles lead with the subject.
  const parts = String(p.title ?? '').split(' · ');
  const what = lower(home ? parts.at(-1) : parts[0]);
  const bad = p.status === 'crit' || p.status === 'warn';
  const q = [];

  if (home && spec.cluster) {
    const c = short(spec.cluster);
    q.push(bad ? `What is driving the ${what} on ${c}?` : `Is anything on ${c} close to a threshold?`);
    q.push(`How is the ${c} cluster doing?`);
    q.push(`What changed on ${c} in the last hour?`);
    q.push(`Are any alerts firing or pending on ${c}?`);
    return q.slice(0, MAX);
  }

  if (part?.kind === 'k8snode' || part?.kind === 'workload') {   // a node or a workload tile on a node map
    const nodes = p.nodes ?? [], cl = short(p.cluster);
    if (part.kind === 'k8snode') {
      const n = nodes.find(x => x.name === part.id), lit = (n?.workloads ?? []).filter(w => w.status !== 'ok').map(w => w.name);
      if (n && !n.ready) q.push(`Why is node ${part.id} not ready?`);
      if (n?.pct >= 85) q.push(`What is using the memory on ${part.id}?`, `Is ${part.id} overcommitted on memory?`);
      if (lit.length) q.push(`Why is ${lit[0]} unhealthy on ${part.id}?`);
      q.push(`What changed on node ${part.id} recently?`, `Which workloads on ${part.id} restart most?`, `How is ${cl} doing overall?`);
    } else {
      const [ns, rest] = part.id.split('/'), [name, node] = String(rest ?? '').split('@');
      const w = nodes.find(x => x.name === node)?.workloads.find(x => x.name === name && x.namespace === ns);
      if (w?.status !== 'ok' && w?.reason) q.push(`Why is ${name} ${w.reason.split(',')[0]}?`);
      q.push(`Show ${name} logs from the last 15 minutes`, `How much memory does ${name} use over time?`, `What changed on ${name} recently?`, `Where else does ${name} run?`);
    }
    return [...new Set(q)].slice(0, MAX);
  }

  if (part) {   // a box or arrow clicked on a flow diagram
    const bad = x => x && x.status !== 'ok';
    if (part.kind === 'edge') {
      const e = (p.edges ?? []).find(x => x.from === part.from && x.to === part.to), call = `from ${part.from} to ${part.to}`;
      if (bad(e)) q.push(`Show a failing call ${call}`, `Why are calls ${call} failing?`);
      q.push(`Show the slowest call ${call}`, `How fast are calls ${call} usually?`, `What changed on ${part.to} recently?`);
    } else {
      const n = (p.nodes ?? []).find(x => x.id === part.id), s = part.id;
      if (bad(n)) q.push(`Show a failing trace through ${s}`, `Why is ${s} failing?`);
      q.push(`Show the slowest trace through ${s}`, `Where does ${s} spend its time?`, `What does ${s} depend on?`, `What changed on ${s} recently?`);
    }
    return [...new Set(q)].slice(0, MAX);
  }

  switch (p.kind) {
    case 'aiden': {
      const a = p.aiden ?? {};
      if (a.done) q.push('What did Aiden find, in short?', 'Do you agree with Aiden\'s conclusion?', 'What should we do next, based on Aiden\'s findings?', 'Add Aiden\'s findings to the incident');
      else q.push('How far has Aiden got?', 'What do you think so far, while Aiden works?');
      break;
    }
    case 'trace': {
      const slow = p.critical?.[0]?.service, f = p.failures?.[0], root = p.root?.service;
      if (f) q.push(`Why does ${f.service} fail in this trace?`, `How often does ${f.service} fail like this?`);
      if (slow) q.push(`Why is ${slow} the slowest step here?`);
      if (root) q.push(f ? `Show the slowest trace for ${root}` : `Show a failing trace for ${root}`, `Is this trace typical for ${root}?`);
      break;
    }
    case 'flow': {
      const faulty = (p.nodes ?? []).filter(n => n.status !== 'ok');
      const busiest = [...(p.nodes ?? [])].sort((a, b) => b.value - a.value)[0];
      if (faulty[0]) q.push(`Why is ${faulty[0].label} failing?`, `When did ${faulty[0].label} start failing, and what changed?`, `What depends on ${faulty[0].label}?`);
      else q.push('Which call in this flow is slowest?', busiest ? `What does ${busiest.label} depend on most?` : 'Where would a failure here hurt most?');
      q.push('Show this flow as a story with the evidence');
      break;
    }
    case 'list': case 'bargauge': case 'table': {
      const top = p.items?.[0]?.label ?? p.rows?.[0]?.cells?.at(-1);
      if (top) q.push(`Why is ${top} the highest?`, `Show ${top} over the last few hours`);
      q.push('Has this ranking changed in the last hour?', 'Are there errors in the logs for the top entry?');
      break;
    }
    case 'graph': case 'timeseries':
      if (bad) q.push(`When did ${what} cross the threshold, and why?`);
      q.push('How does this compare with the same time yesterday?', `What is driving the latest change in ${what}?`, 'Show this over the last six hours');
      break;
    case 'histogram': case 'heatmap':
      q.push('Which requests are in the slowest buckets?', 'Has the p95 moved in the last hour?', 'What makes the slow tail slow?');
      break;
    case 'state': {
      const changed = (p.bands ?? []).find(b => b.segs.length > 1 || b.now.status !== 'ok');
      q.push(changed ? `What happened to ${changed.label}?` : 'Has anything here changed state today?', 'Which of these matters most if it goes down?');
      break;
    }
    case 'logs':
      q.push('What is causing these log lines?', 'When did these start, and how often do they happen?', 'Which service is affected?');
      break;
    case 'events': case 'note':
      q.push('What is the evidence for this?', 'What should I do next?');
      break;
    default:
      if (bad) q.push(`What is driving the ${what}?`);
      q.push(`What is ${what} usually?`, `Show ${what} as a trend over the last few hours`);
  }
  if (bad && !q.some(x => /changed|start/i.test(x))) q.push('What changed just before this started?');
  q.push('Explain what this panel shows');
  return [...new Set(q)].slice(0, MAX);
}

// Sharper questions from the 9000 itself, given the panel's live values. Null if the LLM is unavailable or slow.
export async function smart(room, info) {
  const key = `${info.board}|${info.panel.code}|${info.panel.status}|${info.panel.display}|${JSON.stringify(info.part ?? '')}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.questions;
  const text = await complete(
    'You suggest drilldown questions for a panel on an operations dashboard. The person is looking at the panel and wants to dig deeper into its data. ' +
    'Guess what they most likely want to know next, most useful first: causes of anything unhealthy, when it started, what changed, which item stands out, impact, comparisons over time. ' +
    'Each question must be answerable from metrics, logs, traces or alerts, at most ten words, and name the specific service, cluster or item it is about. ' +
    `Reply with exactly ${MAX} questions, one per line, nothing else.`,
    `Board "${info.board}". Panel: ${info.line}` + (info.part ? `\nThe person clicked on ${info.part.kind === 'edge' ? `the call from ${info.part.from} to ${info.part.to}` : info.part.kind === 'k8snode' ? `the Kubernetes node ${info.part.id}` : info.part.kind === 'workload' ? `the workload ${info.part.id.replace('@', ' on node ')} (namespace/name)` : `the service ${info.part.id}`} in this diagram: every question must be about it.${['k8snode', 'workload'].includes(info.part.kind) ? '' : ' Traces of single requests can be shown (e.g. "Show the slowest trace through X").'}` : ''),
    25_000,
  );
  const questions = String(text ?? '').split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^"|"$/g, '').trim())
    .filter(l => l.length > 8 && l.length < 120).slice(0, MAX);
  if (questions.length < 2) return null;
  cache.set(key, { at: Date.now(), questions });
  return questions;
}

// Send the quick questions at once, then the 9000's when ready. send(msg) goes to the asking monitor only.
export async function suggest(room, code, send, part = null) {
  const found = boards.panelInfo(room, code);
  if (!found) return send({ type: 'drill', code, part, questions: [], done: true });
  const info = { ...found, part };
  send({ type: 'drill', code, part, title: info.panel.title, questions: quick(info), done: false });
  const better = await smart(room, info).catch(() => null);
  send({ type: 'drill', code, part, title: info.panel.title, questions: better ?? quick(info), smart: !!better, done: true });
}

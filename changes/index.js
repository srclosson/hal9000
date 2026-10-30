// Change events: what changed in a cluster recently, for "what changed?" in stories and as marks on trends.
// Sources: rollouts (a new ReplicaSet per Deployment rollout, from kube-state-metrics, with its creation time) and
// Kubernetes event lines in the logs. Each is classified (deploy, rollback, scale, config, upgrade), named by its
// service, and grouped: eight "scaled" events for one service in a burst are one change. Events that repeat all
// through the window (controllers re-reconciling, "scaled up replica set … to desired count" every 30 s) are a
// heartbeat, not a change, and are dropped, as is pod scheduling. Cached per cluster for a minute.

import fs from 'node:fs';
import { prom, loki } from '../boards/index.js';

const CACHE_MS = 60_000;
const cache = new Map();   // `${cluster}|${minutes}` -> { at, list }
const esc = s => String(s).replace(/["\\]/g, '');
// A slow lookup gives way: null after ms.
export const within = (ms, p) => Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => setTimeout(() => r(null), ms))]);

const GROUP_MS = 5 * 60_000;   // events of one kind on one service this close together are one change
const WORD = { deploy: 'DEPLOY', rollback: 'ROLLBACK', scale: 'SCALE', config: 'CONFIG', upgrade: 'UPGRADE', change: 'CHANGE' };

// A workload's service name: without the ReplicaSet hash, the pod suffix and the replica index.
export const serviceOf = name => String(name ?? '').replace(/^(deployment|replicaset|configmap|statefulset|daemonset)[./]/i, '')
  .replace(/-[a-z0-9]{8,10}(-[a-z0-9]{5})?$/, '').replace(/-pod$/, '').replace(/-\d+$/, '').replace(/^ksm-deploy-/, '');

// One event line -> { kind, service, detail } or null (noise).
export function classify(text) {
  const t = String(text ?? '');
  if (/successfully assigned|probe|pulling|pulled|created container|started container|to desired count/i.test(t)) return null;
  let m;
  if ((m = t.match(/roll(?:ed|ing)? ?back\b.*?(?:deployment[./ ]|for )?([a-z0-9][a-z0-9.-]+)/i))) return { kind: 'rollback', service: serviceOf(m[1]), detail: '' };
  if ((m = t.match(/scaled (up|down) replica ?set (?:for )?([a-z0-9][a-z0-9.-]+) (?:to|from \d+ to) (\d+|desired count)/i)))
    return { kind: 'scale', service: serviceOf(m[2]), detail: /\d/.test(m[3]) ? `${m[1] === 'up' ? '↑' : '↓'} ${m[3]}` : m[1] === 'up' ? '↑' : '↓' };
  if ((m = t.match(/config ?map[./ :"]+([a-z0-9][a-z0-9.-]+)/i))) return { kind: 'config', service: m[1], detail: '' };
  if (/config ?map/i.test(t)) return { kind: 'config', service: '', detail: '' };
  if ((m = t.match(/(?:image|version)\D{0,20}?([a-z0-9][a-z0-9./-]*:[\w.-]+|v?\d+\.\d+[\w.-]*)/i)) || /roll(ed|ing)? ?out|deploy(ed|ment (updated|rolled))|new version/i.test(t)) {
    const svc = t.match(/(?:deployment|rollout of|deployed)[./ :"]+([a-z0-9][a-z0-9.-]+)/i)?.[1];
    return { kind: 'deploy', service: serviceOf(svc ?? ''), detail: m?.[1]?.split(/[/:]/).at(-1) ?? '' };
  }
  if (/upgrad/i.test(t)) return { kind: 'upgrade', service: '', detail: '' };
  return null;
}

// One change on a mark or in a card: "DEPLOY checkout-api v2.3", "SCALE cart-service ↑ 5 ×8".
export function labelOf(c) {
  return [WORD[c.kind] ?? 'CHANGE', c.service || c.namespace || '', c.detail || '', c.kind === 'scale' && c.count > 1 ? `×${c.count}` : ''].filter(Boolean).join(' ');
}

// -> [{ time (ms), until, kind, service, namespace?, detail, count, label, items: [{ time, text }] }], oldest first
export async function changes(cluster, minutes = 120) {
  if (!cluster) return [];
  const key = `${cluster}|${minutes}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.list;
  const C = `cluster="${esc(cluster)}"`;
  const [sets, lines] = await Promise.all([
    prom(`kube_replicaset_created{${C}} > (time() - ${minutes * 60})`).catch(() => null),
    // Only the Kubernetes event streams (a regex over every log in a cluster is far too slow), capped at 8 s.
    within(8000, loki(`{${C}, job=~".*(event|kube-state-metrics).*"} |~ "(?i)(deploy|roll(ed|ing)? ?(out|back)|scaled|config ?map|upgrad|new version|image)" !~ "(?i)(probe|pull|successfully assigned|to desired count)"`, 200, minutes)),
  ]);
  const events = [];
  for (const s of sets ?? []) {
    const rs = s.metric?.replicaset ?? '', t = parseFloat(s.value?.[1]) * 1000;
    if (Number.isFinite(t)) events.push({ time: t, kind: 'deploy', service: serviceOf(rs), namespace: s.metric?.namespace, detail: '', text: `New ReplicaSet ${rs}${s.metric?.namespace ? ` in ${s.metric.namespace}` : ''}`, sure: true });
  }
  // Local testing only: CHANGES_TEST_FILE names a JSON file of [{ cluster, minutesAgo, text }] event lines added to
  // the real ones (never set in the deployment), so marks, cards and story highlighting can be tried on a quiet estate.
  const extra = [];
  if (process.env.CHANGES_TEST_FILE) {
    try { for (const e of JSON.parse(fs.readFileSync(process.env.CHANGES_TEST_FILE, 'utf8'))) if (e.cluster === cluster) extra.push({ time: Date.now() - e.minutesAgo * 60_000, text: e.text }); } catch {}
  }
  for (const l of [...(lines ?? []), ...extra]) {
    const c = l.time && classify(l.text);
    if (c) events.push({ time: l.time, ...c, text: l.text.slice(0, 160) });
  }

  // Heartbeats: the same message (numbers aside) three or more times in the window isn't a change. A real rollout's
  // events differ (new ReplicaSet names, new counts). "… to desired count" reconciles are left out by the query, or
  // they would fill the line limit and push real changes out.
  const sig = e => `${e.kind}|${e.service}|${e.text.replace(/\d+/g, '#')}`;
  const seen = new Map();
  for (const e of events) seen.set(sig(e), (seen.get(sig(e)) ?? 0) + 1);
  const real = events.filter(e => e.sure || seen.get(sig(e)) < 3).sort((a, b) => a.time - b.time);

  // Group: one kind on one service within GROUP_MS of the previous event is the same change.
  const out = [];
  for (const e of real) {
    const g = out.findLast(x => x.kind === e.kind && x.service === e.service && e.time - x.until <= GROUP_MS);
    if (g) { g.until = e.time; g.count++; if (e.detail) g.detail = e.detail; if (g.items.length < 8) g.items.push({ time: e.time, text: e.text }); }
    else out.push({ time: e.time, until: e.time, kind: e.kind, service: e.service, namespace: e.namespace, detail: e.detail, count: 1, items: [{ time: e.time, text: e.text }] });
  }
  // A rollout scales the new ReplicaSet up and the old one down: that scaling is part of the deploy, not a change of its own.
  for (const s of out.filter(c => c.kind === 'scale')) {
    const d = out.find(c => (c.kind === 'deploy' || c.kind === 'rollback') && c.service === s.service && Math.abs(s.time - c.time) <= GROUP_MS);
    if (!d) continue;
    d.count += s.count; d.until = Math.max(d.until, s.until); d.items.push(...s.items.slice(0, 8 - d.items.length)); d.items.sort((a, b) => a.time - b.time);
    s.merged = true;
  }
  out.splice(0, out.length, ...out.filter(c => !c.merged));
  for (const c of out) c.label = labelOf(c);
  const list = out.slice(-12);
  cache.set(key, { at: Date.now(), list });
  return list;
}

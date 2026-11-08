// Evidence bundles: everything a story needs, gathered in code in one parallel sweep, so the model spends its
// calls on judgement and narration instead of on a dozen lookups.
//
// investigate({ uid } | { cluster, service? }) returns a short digest (what moved, what changed, what is failing
// nearby, what the logs say) and ready-made panels, already tested, to pass to show_story.

import * as alerts from '../alerts/index.js';
import { prom, loki } from '../boards/index.js';
import { changes, within } from '../changes/index.js';
import { gaps, problems, describeGap } from '../coverage/index.js';
import * as incidents from '../incidents/index.js';

// Services are named by k8s_deployment_name in most clusters and by service_name in others: group by both.
const SVC = 'k8s_deployment_name, service_name';
const svcOf = m => m?.k8s_deployment_name || m?.service_name;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : NaN; };
const r1 = v => (Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) >= 10 ? +v.toFixed(1) : +v.toFixed(2));
const bySvc = rows => new Map((rows ?? []).map(s => [svcOf(s.metric), num(s.value?.[1])]).filter(([k, v]) => k && Number.isFinite(v)));
const esc = s => String(s).replace(/["\\]/g, '');
const clock = t => new Date(t).toISOString().slice(11, 16) + 'Z';

async function signal(rule) {
  if (!rule?.query) return null;
  const r = await prom(rule.query, true, 60);
  const pts = (r?.[0]?.values ?? []).map(([t, v]) => [t * 1000, num(v)]).filter(([, v]) => Number.isFinite(v));
  if (!pts.length) return null;
  const now = pts.at(-1)[1], ago = pts.find(([t]) => t >= Date.now() - 31 * 60_000)?.[1] ?? pts[0][1];
  const crossed = Number.isFinite(rule.threshold) ? pts.find(([, v]) => (rule.below ? v < rule.threshold : v > rule.threshold)) : null;
  return { now, ago, max: Math.max(...pts.map(p => p[1])), crossedAt: crossed?.[0] ?? null };
}

// For each pod: "ns/pod (container): last ended OOMKilled, exit 137; its last lines: …". Loki's pod label differs by
// collector (pod, k8s_pod_name), so both are tried.
async function lastWords(C, pods) {
  const re = pods.map(p => esc(p.pod)).join('|');
  const [reasons, codes] = await Promise.all([
    prom(`max by (namespace, pod, container, reason) (kube_pod_container_status_last_terminated_reason{${C},pod=~"${re}"} == 1)`),
    prom(`max by (namespace, pod, container) (kube_pod_container_status_last_terminated_exitcode{${C},pod=~"${re}"})`),
  ]);
  return Promise.all(pods.map(async p => {
    const mine = r => (r ?? []).filter(x => x.metric.pod === p.pod);
    const why = mine(reasons).map(x => `${x.metric.container}: ${x.metric.reason}`), code = mine(codes).map(x => `exit ${num(x.value?.[1])}`);
    const [a, b] = await Promise.all([loki(`{${C},pod="${esc(p.pod)}"}`, 5, 60), loki(`{${C},k8s_pod_name="${esc(p.pod)}"}`, 5, 60)]);
    const lines = [...(a?.length ? a : b ?? [])].reverse().map(l => `${l.time ? clock(l.time) + ' ' : ''}${l.text.slice(0, 160)}`);
    return `${p.namespace}/${p.pod}: ${why.length || code.length ? `last ended ${[...why, ...code].join(', ')}` : 'no termination reason recorded'}; ` +
      (lines.length ? `its last log lines:\n    ${lines.join('\n    ')}` : 'no log lines from it in Loki in the last hour');
  }));
}

export async function investigate({ uid, cluster, service } = {}) {
  const rule = uid ? await alerts.rule(uid) : null;
  if (uid && !rule) return `Error: no alert rule with uid ${uid}.`;
  cluster = cluster || rule?.cluster;
  service = service || rule?.service;
  // A rule without a cluster label: run its query to see which cluster it matches.
  if (!cluster && rule?.query) cluster = (await prom(`count by (cluster) (${rule.query})`))?.find(x => x.metric?.cluster)?.metric?.cluster;
  if (rule?.error && !cluster) return `Alert "${rule.title}" is not reporting a real condition: the rule itself fails to evaluate (${rule.error}). It fires on that error. Fix the rule's data source in Grafana; nothing in the estate was checked.`;
  if (!cluster) return 'Error: investigate needs an alert uid, or a cluster (and optionally a service).';
  const C = `cluster="${esc(cluster)}"`, S = service ? esc(service) : null;
  const latencyStory = /duration|latency|_ms|seconds/.test(rule?.query ?? '');

  const [sig, errNow, errAgo, latNow, latAgo, rpsNow, rpsAgo, restarts, crash, notReady, edges, failed, errLogs, recent, rules] = await Promise.all([
    signal(rule),
    prom(`100 * max by (${SVC}) (http_error_ratio{${C}})`),
    prom(`100 * max by (${SVC}) (http_error_ratio{${C}} offset 30m)`),
    prom(`max by (${SVC}) (http_request_duration_ms_milliseconds{${C}})`),
    prom(`max by (${SVC}) (http_request_duration_ms_milliseconds{${C}} offset 30m)`),
    prom(`sum by (${SVC}) (rate(http_requests_total{${C}}[5m]))`),
    prom(`sum by (${SVC}) (rate(http_requests_total{${C}}[5m] offset 1h))`),
    prom(`topk(8, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${C}}[1h])) > 0)`),
    prom(`count by (namespace, pod) (kube_pod_container_status_waiting_reason{${C},reason="CrashLoopBackOff"} == 1)`),
    prom(`count by (node) (kube_node_status_condition{${C},condition="Ready",status="true"} == 0)`),
    S ? prom(`sum by (client, server) (rate(traces_service_graph_request_total{client="${S}"}[5m])) or sum by (client, server) (rate(traces_service_graph_request_total{server="${S}"}[5m]))`) : null,
    S ? prom(`sum by (client, server) (rate(traces_service_graph_request_failed_total{client="${S}"}[5m])) or sum by (client, server) (rate(traces_service_graph_request_failed_total{server="${S}"}[5m]))`) : null,
    within(10_000, loki(`{${C}} |~ "(?i)(error|exception|panic|fatal|timed? ?out|refused|unavailable)"${S ? ` |= "${S}"` : ''}`, 6, 30)),
    changes(cluster, 120),
    alerts.allRules(),
  ]);

  // Per service: now against 30 minutes ago (errors, latency) and an hour ago (traffic).
  const en = bySvc(errNow), ea = bySvc(errAgo), ln = bySvc(latNow), la = bySvc(latAgo), rn = bySvc(rpsNow), ra = bySvc(rpsAgo);
  // The label this cluster actually uses, for the panels.
  const label = [errNow, latNow, rpsNow].flat().find(x => x?.metric)?.metric?.k8s_deployment_name ? 'k8s_deployment_name' : 'service_name';
  const services = [...new Set([...en.keys(), ...ln.keys(), ...rn.keys()])];
  const moved = [];
  for (const s of services) {
    const notes = [];
    const e1 = en.get(s), e0 = ea.get(s), l1 = ln.get(s), l0 = la.get(s), q1 = rn.get(s), q0 = ra.get(s);
    if (Number.isFinite(e1) && e1 >= 1 && (!Number.isFinite(e0) || e1 - e0 >= .5)) notes.push(`errors ${r1(e0 ?? 0)}% → ${r1(e1)}%`);
    else if (Number.isFinite(e1) && e1 >= 1) notes.push(`errors steady at ${r1(e1)}%`);
    if (Number.isFinite(l1) && Number.isFinite(l0) && l0 > 0 && l1 / l0 >= 1.5 && l1 > 200) notes.push(`latency ${r1(l0)} → ${r1(l1)} ms`);
    if (Number.isFinite(q1) && Number.isFinite(q0) && q0 > .05 && (q1 / q0 <= .5 || q1 / q0 >= 2)) notes.push(`traffic ${r1(q0)} → ${r1(q1)} req/s`);
    if (notes.length) moved.push(`${s}: ${notes.join(', ')}${s === service ? ' (the alerting service)' : ''}`);
  }

  const failMap = new Map((failed ?? []).map(x => [`${x.metric.client}→${x.metric.server}`, num(x.value?.[1])]));
  const neighbours = (edges ?? []).filter(x => x.metric.client !== x.metric.server).map(x => {
    const k = `${x.metric.client}→${x.metric.server}`, rps = num(x.value?.[1]), f = failMap.get(k) ?? 0;
    return { k, rps, pct: rps > 0 ? (100 * f) / rps : f > 0 ? 100 : 0 };
  });
  const badEdges = neighbours.filter(n => n.pct >= 1);

  const others = (rules ?? []).filter(r => r.labels?.cluster === cluster && ['firing', 'pending'].includes(r.state) && r.uid !== uid);
  const restartRows = (restarts ?? []).map(x => `${x.metric.namespace}/${x.metric.pod} ${Math.round(num(x.value?.[1]))}`);
  const crashRows = (crash ?? []).map(x => `${x.metric.namespace}/${x.metric.pod}`);
  const nodeRows = (notReady ?? []).map(x => x.metric.node);
  // Why the restarting pods died: each container's last termination (reason, exit code) and its last log lines
  // before it ended, the same as "kubectl logs --previous" when the logs reach Loki.
  const dying = [...new Map([...(crash ?? []), ...(restarts ?? [])].map(x => [`${x.metric.namespace}/${x.metric.pod}`, x.metric])).values()].slice(0, 3);
  const deaths = dying.length ? await within(15_000, lastWords(C, dying)) : null;

  // ---- the digest the model reads ----
  const out = [];
  if (rule?.error) out.push(`Warning: this rule fails to evaluate in Grafana (${rule.error}), so its firing state comes from that error, not from the data. The evidence below is what the data actually shows.`);
  out.push(rule
    ? `Alert "${rule.title}" (${rule.state}, ${rule.severity ?? 'unknown'} severity) on ${cluster}${service ? `, service ${service}` : ''}; fires when the value is ${rule.below ? 'below' : 'above'} ${rule.threshold ?? '?'}${rule.since ? `; active since ${rule.since}` : ''}.`
    : `Investigation of ${cluster}${service ? `, service ${service}` : ''}.`);
  if (sig) out.push(`Alerting signal: now ${r1(sig.now)}, 30 minutes ago ${r1(sig.ago)}, peak ${r1(sig.max)} in the last hour${sig.crossedAt ? `; first crossed the threshold at ${clock(sig.crossedAt)}` : ''}.`);
  out.push(moved.length ? `What moved (vs 30 min ago for errors and latency, 1 h for traffic):\n- ${moved.join('\n- ')}` : 'No service in the cluster shows a notable change in errors, latency or traffic.');
  if (services.length) out.push(`Services watched in ${cluster}: ${services.length}.`);
  out.push(recent.length ? `Changes in the last 2 hours:\n- ${recent.map(c => `${clock(c.time)} ${c.label}`).join('\n- ')}` : 'No rollouts or config changes recorded in the last 2 hours.');
  if (restartRows.length) out.push(`Restarts in the last hour: ${restartRows.join(', ')}.`);
  if (crashRows.length) out.push(`Crash-looping now: ${crashRows.join(', ')}.`);
  if (deaths?.length) out.push(`Why they last ended:\n- ${deaths.join('\n- ')}`);
  if (nodeRows.length) out.push(`Nodes not ready: ${nodeRows.join(', ')}.`);
  if (S) out.push(neighbours.length
    ? `Calls to and from ${service} (traces): ${neighbours.map(n => `${n.k} ${r1(n.rps)}/s${n.pct >= .1 ? `, ${r1(n.pct)}% failing` : ''}`).join('; ')}.`
    : `No trace data for calls to or from ${service}.`);
  out.push(errLogs?.length ? `Recent error log lines:\n- ${errLogs.slice(0, 4).map(l => `${l.time ? clock(l.time) + ' ' : ''}${l.text.slice(0, 140)}`).join('\n- ')}` : 'No matching error log lines.');
  if (others.length) out.push(`Other active alerts in ${cluster}: ${others.map(r => `${r.title} (${r.state})`).join('; ')}.`);
  const uncovered = await within(15_000, gaps(problems(cluster)));
  if (uncovered?.length) out.push(`Alert coverage gaps in ${cluster} (mention these; offer the proposed rule for a person to add):\n- ${uncovered.map(describeGap).join('\n- ')}`);
  // What StackGen already knows about this (past incidents, fixes, chronic issues), within a small budget.
  const known = await within(8000, incidents.recall(
    [rule?.title, service, cluster, moved.slice(0, 3).join('; '), crashRows.length ? 'crash-looping pods' : '', nodeRows.length ? 'nodes not ready' : ''].filter(Boolean).join(' '),
    { services: service ? [service] : [], clusters: [cluster], budget: 500 }));
  if (known) out.push(known);
  if (rule?.notes) out.push(`Runbook notes (a hypothesis until the evidence above confirms it): ${rule.notes.slice(0, 400)}`);

  // ---- ready-made panels, each backed by data just seen ----
  const panels = [];
  if (rule?.query && sig) panels.push({ code: 'ALR', title: rule.title.slice(0, 40), kind: 'timeseries', query: rule.query, window: 60,
    ...(Number.isFinite(rule.threshold) && !rule.below ? { crit: rule.threshold } : {}), ...(rule.since ? { since: rule.since } : {}) });
  if (services.length) panels.push(latencyStory
    ? { code: 'BLR', title: 'Worst latency by service', kind: 'bargauge', unit: 'ms', warn: 500, crit: 1000, listLabel: label, query: `max by (${label}) (http_request_duration_ms_milliseconds{${C}})` }
    : { code: 'BLR', title: 'Error % by service', kind: 'bargauge', unit: '%', warn: 1, crit: 5, listLabel: label, query: `100 * max by (${label}) (http_error_ratio{${C}})` });
  const events = [
    ...recent.map(c => ({ t: c.time, label: c.label })),
    ...(rule?.since ? [{ t: Date.parse(rule.since), label: `Alert started: ${rule.title}` }] : []),
    ...(sig?.crossedAt && !rule?.since ? [{ t: sig.crossedAt, label: 'Signal crossed the threshold' }] : []),
  ].filter(e => Number.isFinite(e.t)).sort((a, b) => a.t - b.t).slice(-8);
  // About an alert: its whole story on one time axis (signal, changes, acknowledgement, Aiden, plans). Otherwise the
  // changes as a list.
  if (rule?.uid) panels.push({ code: 'TML', title: 'What happened', kind: 'timeline', alert_uid: rule.uid, ...(cluster ? { cluster } : {}) });
  else if (events.length) panels.push({ code: 'CHG', title: 'What changed', kind: 'events', events: events.map(e => ({ time: new Date(e.t).toISOString(), label: e.label })) });
  if (errLogs?.length) panels.push({ code: 'EVD', title: 'Error logs', kind: 'logs', status: 'warn',
    query: `{${C}} |~ "(?i)(error|exception|panic|fatal|timed? ?out|refused|unavailable)"${S ? ` |= "${S}"` : ''}` });
  if (S && neighbours.length) panels.push({ code: 'FLO', title: `Flow around ${service}`.slice(0, 40), kind: 'flow', services: [service] });
  if (restartRows.length) panels.push({ code: 'RST', title: 'Restarts, last hour', kind: 'table', unit: 'restarts', warn: 1, crit: 10, columns: ['namespace', 'pod'],
    query: `topk(8, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${C}}[1h])) > 0)` });

  out.push(`Ready-made panels (tested just now). For a story, pass the ones that tell it to show_story in narrative order, add a narration to each and a NXT note with the next step; drop any that add nothing:\n${JSON.stringify(panels)}`);
  const digest = out.join('\n\n');
  incidents.noteEvidence(digest.split('\n\nReady-made panels')[0]);   // attached if someone opens an incident
  return digest;
}

export function tools() {
  if (!alerts.available()) return [];
  return [{
    name: 'investigate',
    description: 'Gather all the evidence about an alert (by uid) or a cluster/service in one call: the alerting signal and when it crossed, which services moved, recent rollouts and config changes, restarts and crash loops, failing calls to and from the service (traces), error logs, other alerts, runbook notes; plus ready-made tested panels for show_story. Use this instead of many separate queries.',
    inputSchema: { type: 'object', properties: {
      uid: { type: 'string', description: 'Alert rule uid from list_alerts' },
      cluster: { type: 'string', description: 'Cluster name, when there is no alert' },
      service: { type: 'string', description: 'Service (deployment) name, optional' } } },
  }];
}
export const has = name => name === 'investigate';
export const describe = () => 'Gathering the evidence';
export async function call(name, args = {}) {
  try { return await investigate(args); } catch (err) { return `Error: the evidence could not be gathered (${err.message}).`; }
}

// nodes: a map of one cluster's nodes and the workloads running on them, from kube-state-metrics and cAdvisor.
//   - A node is a box sized by its allocatable memory; its fill is the memory its pods use (working set, else their
//     requests) against that, so an overcommitted node is plain to see. Not ready is critical; cordoned is a warning.
//   - Inside, one tile per workload (Deployment, StatefulSet, DaemonSet…: the pods' owner, with a ReplicaSet's hash
//     taken off), sized by the memory its pods on that node use. Crash loops, failed pods and image pulls are
//     critical; pending, other waiting reasons and restarts in the last hour are warnings.
//   - Pods no node has taken (Pending, unscheduled) go in their own box, so a scheduling problem shows too.
// read(prom, cluster) runs the queries; build(series) is the pure part, tested on its own.

const MAX_NODES = 12;
const CRIT_REASONS = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|InvalidImageName|OOMKilled/;
const RANK = { ok: 0, warn: 1, crit: 2 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);

export const queries = c => {
  const s = c ? `cluster=${JSON.stringify(c)}` : '';
  return {
    alloc: `kube_node_status_allocatable{resource="memory"${s ? ',' + s : ''}}`,
    ready: `kube_node_status_condition{condition="Ready",status="true"${s ? ',' + s : ''}}`,
    cordoned: `kube_node_spec_unschedulable{${s}} == 1`,
    pods: `kube_pod_info{${s}}`,
    owners: `kube_pod_owner{${s}}`,
    phase: `kube_pod_status_phase{${s}} == 1`,
    waiting: `kube_pod_container_status_waiting_reason{${s}} == 1`,
    restarts: `sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total{${s}}[1h]))`,
    used: `sum by (namespace, pod, node) (container_memory_working_set_bytes{container!=""${s ? ',' + s : ''}})`,
    requested: `sum by (namespace, pod) (kube_pod_container_resource_requests{resource="memory"${s ? ',' + s : ''}})`,
  };
};

// The workload a pod belongs to: a label naming it, else its owner (a ReplicaSet's pod-template hash taken off),
// else the pod's own name less its generated suffix.
export function workloadOf(pod, owner) {
  const m = pod.metric ?? {};
  const named = m.workload || m.deployment || m.statefulset || m.daemonset || m.created_by_name;
  let name = named, kind = m.deployment ? 'Deployment' : m.statefulset ? 'StatefulSet' : m.daemonset ? 'DaemonSet' : m.created_by_kind;
  if (!name && owner) {
    name = owner.owner_name;
    kind = owner.owner_kind;
    if (kind === 'ReplicaSet' && /-[a-z0-9]{5,10}$/.test(name ?? '')) { name = name.replace(/-[a-z0-9]{5,10}$/, ''); kind = 'Deployment'; }
  }
  if (!name || name === '<none>') name = String(m.pod ?? '').replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$|-[a-z0-9]{5}$|-\d+$/, '');
  return { name: name || m.pod || '?', kind: kind && kind !== '<none>' ? kind : 'Pod' };
}

const num = s => parseFloat(s?.value?.[1]);
const key = m => `${m.namespace ?? ''}/${m.pod ?? ''}`;
const byPod = list => new Map((list ?? []).map(s => [key(s.metric ?? {}), s]));

const GIB = 1024 ** 3;
export const bytes = v => (!Number.isFinite(v) ? '—' : v >= GIB ? `${(v / GIB).toFixed(v >= 10 * GIB ? 0 : 1)} GiB` : `${Math.round(v / 1024 ** 2)} MiB`);

// series: { alloc, ready, cordoned, pods, owners, phase, waiting, restarts, used, requested } (Prometheus instant
// results). p: { warn, crit } (% of a node's memory in use; default 85 and 100).
export function build(series, p = {}) {
  const warnAt = p.warn ?? 85, critAt = p.crit ?? 100;
  const owners = byPod(series.owners), used = byPod(series.used), req = byPod(series.requested), restarts = byPod(series.restarts);
  const phase = new Map((series.phase ?? []).map(s => [key(s.metric), s.metric.phase]));
  const waiting = new Map();
  for (const s of series.waiting ?? []) { const k = key(s.metric); if (!waiting.has(k) || CRIT_REASONS.test(s.metric.reason)) waiting.set(k, s.metric.reason); }
  const ready = new Map((series.ready ?? []).map(s => [s.metric.node, num(s) === 1]));
  const cordoned = new Set((series.cordoned ?? []).map(s => s.metric.node));

  const nodes = new Map();
  for (const s of series.alloc ?? []) if (s.metric?.node)
    nodes.set(s.metric.node, { name: s.metric.node, alloc: num(s), ready: ready.get(s.metric.node) ?? true, cordoned: cordoned.has(s.metric.node), work: new Map() });
  const unscheduled = { name: 'Not scheduled', alloc: NaN, ready: true, cordoned: false, work: new Map(), unscheduled: true };

  // Pods, once each (kube_pod_info may repeat a pod per container label).
  const seen = new Set();
  for (const s of series.pods ?? []) {
    const m = s.metric ?? {}, k = key(m);
    if (!m.pod || seen.has(k)) continue;
    seen.add(k);
    const ph = phase.get(k);
    if (ph === 'Succeeded') continue;   // finished jobs take no room
    // The pod's node: kube-state-metrics' word, unless that names no node we know and cAdvisor saw the pod on one.
    const seenOn = used.get(k)?.metric?.node, on = m.node && !nodes.has(m.node) && seenOn && nodes.has(seenOn) ? seenOn : m.node;
    const box = (on && nodes.get(on)) || (on ? nodes.set(on, { name: on, alloc: NaN, ready: ready.get(on) ?? true, cordoned: cordoned.has(on), unknown: true, work: new Map() }).get(on) : unscheduled);
    const w = workloadOf(s, owners.get(k)?.metric);
    const wk = `${m.namespace ?? ''}/${w.name}`;
    const tile = box.work.get(wk) ?? { name: w.name, kind: w.kind, namespace: m.namespace ?? '', pods: [], used: 0, requested: 0, restarts: 0, status: 'ok', reasons: new Set() };
    const u = num(used.get(k)), r = num(req.get(k)), rs = Math.round(num(restarts.get(k)) || 0), why = waiting.get(k);
    let st = 'ok';
    if (ph === 'Failed' || (why && CRIT_REASONS.test(why))) st = 'crit';
    else if (ph === 'Pending' || why || rs > 0) st = 'warn';
    if (why) tile.reasons.add(why); else if (ph && ph !== 'Running') tile.reasons.add(ph);
    if (rs > 0) tile.reasons.add(`${rs} restart${rs > 1 ? 's' : ''}`);
    tile.pods.push({ name: m.pod, phase: ph ?? 'Unknown', status: st, reason: why ?? null, restarts: rs, used: u, requested: r });
    if (Number.isFinite(u)) tile.used += u;
    if (Number.isFinite(r)) tile.requested += r;
    tile.restarts += rs;
    tile.status = worse(tile.status, st);
    box.work.set(wk, tile);
  }

  const finish = b => {
    const workloads = [...b.work.values()].map(t => {
      const mem = t.used || t.requested;
      return { name: t.name, kind: t.kind, namespace: t.namespace, pods: t.pods, restarts: t.restarts, status: t.status,
        reason: [...t.reasons].join(', '), mem, memShown: t.used ? 'in use' : t.requested ? 'requested' : '', display: mem ? bytes(mem) : '' };
    }).sort((a, b) => RANK[b.status] - RANK[a.status] || b.mem - a.mem || a.name.localeCompare(b.name));
    const used = workloads.reduce((a, w) => a + (w.mem || 0), 0);
    const pct = Number.isFinite(b.alloc) && b.alloc > 0 ? (100 * used) / b.alloc : NaN;
    let st = !b.ready ? 'crit' : b.cordoned ? 'warn' : 'ok';
    if (Number.isFinite(pct)) st = worse(st, pct >= critAt ? 'crit' : pct >= warnAt ? 'warn' : 'ok');
    if (b.unscheduled && workloads.length) st = worse(st, workloads.some(w => w.status === 'crit') ? 'crit' : 'warn');
    const notes = [!b.ready && 'NOT READY', b.cordoned && 'CORDONED', b.unknown && 'NO NODE DATA'].filter(Boolean);
    return { name: b.name, alloc: b.alloc, used, pct, ready: b.ready, cordoned: b.cordoned, unscheduled: !!b.unscheduled, unknown: !!b.unknown, status: st, notes,
      display: Number.isFinite(pct) ? `${Math.round(pct)}%` : '', workloads,
      podCount: workloads.reduce((a, w) => a + w.pods.length, 0), worst: workloads.reduce((a, w) => worse(a, w.status), 'ok') };
  };

  let list = [...nodes.values()].map(finish)
    .sort((a, b) => Math.max(RANK[b.status], RANK[b.worst]) - Math.max(RANK[a.status], RANK[a.worst]) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const more = Math.max(0, list.length - MAX_NODES);
  list = list.slice(0, MAX_NODES).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));   // shown in a stable order
  const pending = finish(unscheduled);
  if (pending.workloads.length) list.push(pending);

  const badNodes = list.filter(n => !n.unscheduled && n.status !== 'ok').length;
  const badWork = list.flatMap(n => n.workloads).filter(w => w.status !== 'ok').length;
  const status = list.reduce((a, n) => worse(worse(a, n.status), n.worst), 'ok');
  const display = badNodes || badWork
    ? `${[badNodes && `${badNodes} NODE${badNodes > 1 ? 'S' : ''}`, badWork && `${badWork} WORKLOAD${badWork > 1 ? 'S' : ''}`].filter(Boolean).join(' · ')} AT RISK`
    : 'NOMINAL';
  return { nodes: list, more, status, display, value: badNodes + badWork };
}

// The map in words, for the model: every node with its memory and state, the workloads in trouble, and what is on each.
export function describe(m) {
  return `cluster ${m.cluster || '?'}; ` + (m.nodes ?? []).map(n => {
    const head = n.unscheduled ? 'not scheduled' : `node ${n.name} ${Number.isFinite(n.pct) ? `${Math.round(n.pct)}% memory (${bytes(n.used)} of ${bytes(n.alloc)})` : 'memory unknown'}${n.notes.length ? ` ${n.notes.join(' ')}` : ''}${n.status !== 'ok' ? ` ${n.status}` : ''}`;
    const work = n.workloads.map(w => `${w.name}${w.pods.length > 1 ? ` x${w.pods.length}` : ''}${w.display ? ` ${w.display}` : ''}${w.status !== 'ok' ? ` ${w.status.toUpperCase()} (${w.reason})` : ''}`);
    return `${head}: ${work.join(', ') || 'no workloads'}`;
  }).join('; ') + (m.more ? `; ${m.more} more nodes not shown` : '');
}

// The cluster to draw when none was named: the one with the most trouble (nodes not ready, pods not running).
export const PICK_CLUSTER = 'sort_desc(count by (cluster) (kube_pod_status_phase{phase=~"Pending|Failed|Unknown"} == 1) or count by (cluster) (kube_node_status_condition{condition="Ready",status="true"} == 0))';

export async function read(prom, p = {}) {
  let cluster = p.cluster;
  if (!cluster) {
    const bad = await prom(PICK_CLUSTER);
    cluster = bad?.[0]?.metric?.cluster ?? (await prom('count by (cluster) (kube_node_info)'))?.[0]?.metric?.cluster;
  }
  const q = queries(cluster);
  const names = Object.keys(q);
  const results = await Promise.all(names.map(n => prom(q[n]).catch(() => null)));
  const series = Object.fromEntries(names.map((n, i) => [n, results[i] ?? []]));
  if (!series.alloc.length && !series.pods.length) return null;
  return { cluster: cluster ?? '', ...build(series, p) };
}

// Read-only alert access for the 9000, built on Grafana's alerting_manage_rules MCP tool.
//
// That tool can also create, update and delete rules, so it is configured as "internal" in MCP_SERVERS (never
// offered to the model). These wrappers only ever send operation "list" or "get".
//
//   list_alerts { state?: firing | pending | active | all, cluster?, search? }   what is alerting, compactly
//   get_alert { uid }                                                   one rule: query, threshold, instances, notes
//
// Rule write-ups in the acme estate are prepared in advance and often name the root cause outright, so they are
// handed to the model as "runbook notes" to weigh against live evidence, not as findings.

import fs from 'node:fs';
import * as mcp from '../mcp/index.js';

// Local testing only (see watch.js): ALERT_WATCH_OVERRIDES names a JSON file of { "<uid>": "<state>" } that is
// applied to every read, so the watcher, list_alerts and get_alert agree on a simulated incident.
export function testOverrides() {
  const file = process.env.ALERT_WATCH_OVERRIDES;
  if (!file) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
const applyOverrides = r => { const st = testOverrides()[r?.uid]; return st ? { ...r, state: st } : r; };

const RULES_TOOL = 'alerting_manage_rules';
const NOTES_MAX = 900;

// Alerts that come from elsewhere than Grafana: the booth game's (game/index.js), made from its ship's state. They are
// listed and described like Grafana's; with no Grafana configured, they are the only ones.
let extra = null;
export const setExtra = fn => { extra = fn; };
const grafana = () => mcp.hasInternal(RULES_TOOL);
export const available = () => grafana() || !!extra;

// Every alert rule, raw (for the watcher). null when Grafana can't be read.
export async function allRules() {
  const more = extra?.() ?? [];
  if (!grafana()) return extra ? more : null;
  const all = await rules({ operation: 'list', rule_limit: 500 });
  return Array.isArray(all) ? [...all.map(applyOverrides), ...more] : null;
}

async function rules(args) {
  const text = await mcp.call(RULES_TOOL, args, { internal: true });
  try { return JSON.parse(text); } catch { return null; }
}

const sevRank = { critical: 0, warning: 1 };
const short = (s = '', n = 220) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

async function listAlerts({ state = 'active', cluster, search } = {}) {
  const all = await allRules();
  if (!all) return 'Error: the alert rules could not be read right now.';
  // null = every rule. (Not "?? default": that would turn all's null back into the active filter.)
  const filters = { firing: ['firing'], pending: ['pending'], active: ['firing', 'pending'], all: null };
  const want = state in filters ? filters[state] : filters.active;
  let list = all.filter(r => !want || want.includes(r.state));
  if (cluster) list = list.filter(r => r.labels?.cluster === cluster);
  const term = String(search ?? '').toLowerCase().trim();
  const matches = r => !term || [r.title, r.labels?.service, r.labels?.cluster].some(v => String(v ?? '').toLowerCase().includes(term));
  list = list.filter(matches);
  list.sort((a, b) => (sevRank[a.labels?.severity] ?? 9) - (sevRank[b.labels?.severity] ?? 9));

  const watched = cluster ? all.filter(r => r.labels?.cluster === cluster).length : all.length;
  if (!list.length) {
    // Nothing active: say how many matching rules are quiet, so "no alert is firing" is never mistaken for
    // "no alert rule exists".
    const quiet = all.filter(r => (!cluster || r.labels?.cluster === cluster) && matches(r));
    return `No alerts are ${state === 'all' ? 'defined' : state === 'active' ? 'firing or pending' : state}${cluster ? ` in ${cluster}` : ''}${term ? ` matching "${search}"` : ''}. ${watched} alert rules are being watched` +
      (state !== 'all' && quiet.length ? `; ${quiet.length} matching rule(s) exist but are quiet. Call list_alerts with state "all" to see them and their uids.` : '.');
  }
  const lines = list.slice(0, 15).map(r => {
    const l = r.labels ?? {};
    return `- uid=${r.uid} [${r.state}] ${l.severity ?? 'unknown'}: ${r.title} (cluster ${l.cluster ?? '?'}, service ${l.service ?? '?'})`;
  });
  return `${list.length} alert(s) ${state === 'all' ? 'defined' : state}${cluster ? ` in ${cluster}` : ''} of ${watched} watched:\n${lines.join('\n')}` +
    (list.length > 15 ? `\n…and ${list.length - 15} more.` : '') +
    `\nUse get_alert with a uid for its query, threshold, start time and runbook notes.`;
}

// Every rule with its query and health, for alert coverage checks. Fetched rule by rule (the list carries no
// queries), eight at a time, and cached for 15 minutes: rules change rarely.
let details = { at: 0, list: null };
export async function ruleDetails() {
  if (details.list && Date.now() - details.at < 15 * 60_000) return details.list;
  const all = await allRules();
  if (!all) return details.list;
  const out = [];
  for (let i = 0; i < all.length; i += 8) {
    const batch = await Promise.all(all.slice(i, i + 8).map(r => rules({ operation: 'get', rule_uid: r.uid }).catch(() => null)));
    batch.forEach((d, j) => {
      const r = all[i + j];
      out.push({ uid: r.uid, title: r.title, health: r.health, state: r.state, cluster: r.labels?.cluster ?? null,
        error: d?.last_error || null, query: d?.data?.find(q => q.datasourceUid && q.datasourceUid !== '__expr__')?.model?.expr ?? '' });
    });
  }
  details = { at: Date.now(), list: out };
  return out;
}

// One rule, structured (for the evidence gatherer): its query, threshold, cluster, service and start time.
export async function rule(uid) {
  const r = applyOverrides(await rules({ operation: 'get', rule_uid: uid }));
  if (!r?.uid) return null;
  const l = r.labels ?? {}, a = r.annotations ?? {};
  const query = r.data?.find(q => q.datasourceUid && q.datasourceUid !== '__expr__')?.model?.expr;
  const ev = r.data?.flatMap(q => q.model?.conditions ?? []).find(c => c.evaluator)?.evaluator;
  const since = (r.alerts ?? []).map(i => i.activeAt).filter(Boolean).sort()[0] ?? null;
  // Cluster-wide rules carry the cluster (and service) on their firing instances instead of the rule.
  const inst = (r.alerts ?? []).map(i => i.labels ?? {});
  const cluster = l.cluster ?? inst.map(i => i.cluster).find(Boolean);
  const service = l.service ?? inst.map(i => i.service ?? i.k8s_deployment_name).find(Boolean);
  return { uid: r.uid, title: r.title, state: r.state, severity: l.severity, cluster, service, query,
    below: ev?.type === 'lt', threshold: ev?.params?.[0], since, notes: a.description ?? a.summary ?? '',
    // A rule that cannot evaluate (e.g. a missing data source) can "fire" on its own error.
    error: r.last_error || (r.alerts ?? []).map(i => i.annotations?.Error).find(Boolean) || null };
}

async function getAlert({ uid } = {}) {
  if (!uid) return 'Error: get_alert needs a uid from list_alerts.';
  const own = (extra?.() ?? []).find(r => r.uid === uid);
  if (own) return [`Alert "${own.title}" uid=${own.uid}`, `State: ${own.state}; severity ${own.labels.severity}; service ${own.labels.service}.`,
    `Summary: ${own.annotations.summary}`, 'This alert is raised from the ship\'s own device readings and self-tests; check the device itself for the detail.'].join('\n');
  const r = applyOverrides(await rules({ operation: 'get', rule_uid: uid }));
  if (!r?.uid) return `Error: no alert rule with uid ${uid}.`;
  const l = r.labels ?? {}, a = r.annotations ?? {};
  // The alerting query is the first datasource query; the threshold is the evaluator on the condition step.
  const query = r.data?.find(q => q.datasourceUid && q.datasourceUid !== '__expr__')?.model?.expr;
  const evaluator = r.data?.flatMap(q => q.model?.conditions ?? []).find(c => c.evaluator)?.evaluator;
  const threshold = evaluator ? `${evaluator.type === 'lt' ? 'below' : 'above'} ${evaluator.params?.join(' and ')}` : 'unknown';
  const instances = (r.alerts ?? []).map(i => `${i.state ?? r.state} since ${i.activeAt ?? '?'}${i.value ? ` (value ${i.value})` : ''}`);
  return [
    `Alert "${r.title}" uid=${r.uid}`,
    `State: ${r.state}; severity ${l.severity ?? 'unknown'}; cluster ${l.cluster ?? '?'}; service ${l.service ?? '?'}; must hold for ${r.for ?? '?'}.`,
    `Query (Prometheus datasource "metrics"): ${query ?? 'unknown'}`,
    `Fires when the value is ${threshold}.`,
    instances.length ? `Instances: ${instances.join('; ')}` : 'No active instances.',
    a.summary ? `Summary: ${short(a.summary, 300)}` : '',
    a.description ? `Runbook notes (written in advance; confirm against live data before stating as fact): ${short(a.description, NOTES_MAX)}` : '',
    a.runbook_url ? 'A runbook link exists.' : '',
  ].filter(Boolean).join('\n');
}

export function tools() {
  if (!available()) return [];
  return [
    { name: 'list_alerts',
      description: 'List alert rules that are firing or pending (default), or all of them, optionally for one cluster. Call this first when someone asks what is wrong, what is going on, or about an alert.',
      inputSchema: { type: 'object', properties: {
        state: { type: 'string', enum: ['active', 'firing', 'pending', 'all'], description: 'active = firing or pending (default)' },
        cluster: { type: 'string' },
        search: { type: 'string', description: 'Words to match in the alert title or service, e.g. "checkout"' } } } },
    { name: 'get_alert',
      description: 'Details of one alert rule: its query, threshold, when it started, and its runbook notes.',
      inputSchema: { type: 'object', properties: { uid: { type: 'string' } }, required: ['uid'] } },
  ];
}

export const has = name => name === 'list_alerts' || name === 'get_alert';
export const describe = name => (name === 'list_alerts' ? 'Checking the alerts' : 'Reading the alert');

export async function call(name, args = {}) {
  try {
    return name === 'list_alerts' ? await listAlerts(args) : await getAlert(args);
  } catch (err) {
    return `Error: alerts are unavailable right now (${err.message}).`;
  }
}

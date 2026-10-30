// Alert coverage: problems no working alert rule would catch, and the rule that would.
// A signal past its warning line in a cluster is covered when some healthy rule queries the same metric for that
// cluster (or for every cluster). Rules that exist but fail to evaluate do not count, and are reported as broken.
// The 9000 only proposes rules; a person reviews and adds them in Grafana.

import * as alerts from '../alerts/index.js';
import { SIGNALS, latest } from '../home/index.js';

const METRIC = {
  ERR: /http_error_ratio/, LAT: /http_request_duration/, CLB: /CrashLoopBackOff|waiting_reason/,
  RST: /restarts_total/, NOD: /kube_node_status_condition|NotReady|kube_node_info/,
};

// problems: [{ cluster, key, value, level, baseline }] -> [{ ...problem, broken: [titles], proposal }]
export async function gaps(problems) {
  const rules = await alerts.ruleDetails();
  if (!rules) return [];
  const out = [];
  for (const p of problems) {
    const re = METRIC[p.key];
    if (!re) continue;
    const covering = rules.filter(r => re.test(r.query) && (r.cluster === p.cluster || (!r.cluster && (!/cluster\s*=/.test(r.query) || r.query.includes(`"${p.cluster}"`)))));
    const healthy = covering.filter(r => r.health !== 'error' && !r.error);
    if (healthy.length) continue;
    const s = SIGNALS.find(x => x.key === p.key);
    out.push({
      ...p, broken: covering.filter(r => r.health === 'error' || r.error).map(r => r.title),
      proposal: { title: `${p.cluster}: ${s.name} ${p.level >= 2 ? 'critical' : 'high'}`, query: s.one(p.cluster),
        condition: `at or above ${p.level >= 2 ? s.crit : s.warn}`, for: '10m', severity: p.level >= 2 ? 'critical' : 'warning' },
    });
  }
  return out;
}

export function describeGap(g) {
  const s = SIGNALS.find(x => x.key === g.key);
  return `${g.cluster} ${s.name} (${+(+g.value).toFixed(2)} ${s.unit}${g.baseline && g.baseline !== 'normal' ? `, ${g.baseline}` : ''}): ` +
    (g.broken.length ? `the rule${g.broken.length > 1 ? 's' : ''} meant to catch it (${g.broken.slice(0, 2).join('; ')}) fail${g.broken.length > 1 ? '' : 's'} to evaluate` : 'no alert rule watches it') +
    `. Proposed rule: "${g.proposal.title}", ${g.proposal.severity}, when ${g.proposal.query} is ${g.proposal.condition} for ${g.proposal.for}.`;
}

// Problems on the situation board's last survey (optionally one cluster), as gap candidates.
export function problems(cluster) {
  return latest().filter(c => !cluster || c.cluster === cluster)
    .flatMap(c => c.signals.filter(s => s.level).map(s => ({ cluster: c.cluster, key: s.key, value: s.value, level: s.level, baseline: s.baseline })));
}

// ---- tool for the model ----
export function tools() {
  if (!alerts.available()) return [];
  return [{
    name: 'alert_coverage',
    description: 'Find problems that no working alert rule would catch (signals past their warning line where every matching rule is missing or fails to evaluate), with a proposed rule for each. Use when asked about alert coverage or gaps, what is not being alerted on, or whether an alert exists for something. You cannot create rules: offer the proposal for a person to add.',
    inputSchema: { type: 'object', properties: { cluster: { type: 'string', description: 'Limit to one cluster (optional)' } } },
  }];
}
export const has = name => name === 'alert_coverage';
export const describe = () => 'Checking alert coverage';
export async function call(name, { cluster } = {}) {
  try {
    const list = await gaps(problems(cluster));
    if (!list.length) return `Every current problem${cluster ? ` in ${cluster}` : ''} is covered by a working alert rule.`;
    return `${list.length} problem(s) no working rule would alert on:\n- ${list.map(describeGap).join('\n- ')}`;
  } catch (err) { return `Error: alert coverage could not be checked (${err.message}).`; }
}

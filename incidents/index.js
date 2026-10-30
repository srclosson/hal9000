// The StackGen Incidents service (https://incidents.stackgen.run), as tools for the 9000 and as memory for its
// investigations. INCIDENTS_URL (in-cluster service URL) and INCIDENTS_TOKEN (that service's AUTOMATION_TOKEN).
// The 9000 acts on behalf of whoever asked (X-Actor), so the incident timeline shows the person, via HAL/SAL.

const URL_ = (process.env.INCIDENTS_URL ?? '').replace(/\/$/, '');
const TOKEN = process.env.INCIDENTS_TOKEN;
export const available = () => !!(URL_ && TOKEN);

async function call(path, { method = 'GET', body, actor } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method, signal: AbortSignal.timeout(method === 'GET' && path.includes('copilot') ? 70_000 : 20_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, 'X-Actor': actor || 'HAL 9000' },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

// For Aiden's results: the open incident declared for an alert, a timeline entry, a memory.
export async function openForAlert(uid) {
  if (!available() || !uid) return null;
  return (await call('/api/incidents?status=open')).find(i => i.alert_uid === uid) ?? null;
}
// One incident with its timeline (events), or null.
export const get = ref => (available() && ref ? call(`/api/incidents/${encodeURIComponent(ref)}`).catch(() => null) : Promise.resolve(null));
export const listOpen = () => (available() ? call('/api/incidents?status=open') : Promise.resolve([]));
// acknowledge(ref, { by, at, detected_at }): kept once, with a timeline entry.
export const acknowledge = (ref, ack, actor) => call(`/api/incidents/${encodeURIComponent(ref)}`, { method: 'PATCH', actor, body: { acknowledge: ack } });
export const addEvent = (ref, kind, body, actor) => call(`/api/incidents/${encodeURIComponent(ref)}/events`, { method: 'POST', actor, body: { kind, body } });
export const remember = (m, actor) => call('/api/memory', { method: 'POST', actor, body: m });
// declared(incident, alertUid): an incident was just opened by the 9000 (Aiden adds its result if it has one).
let declared = () => {};
export const onDeclared = fn => { declared = fn; };

// Relevant memory for an investigation or a question, within a token budget ('' when none or unavailable).
export async function recall(question, { services = [], clusters = [], budget = 600 } = {}) {
  if (!available()) return '';
  try { return (await call('/api/memory/recall', { method: 'POST', body: { question, services, clusters, budget } })).context ?? ''; }
  catch { return ''; }
}

// The evidence the 9000 last gathered (evidence/index.js reports it here), attached when an incident is opened.
let lastEvidence = null;   // { at, text }
export const noteEvidence = text => { lastEvidence = { at: Date.now(), text }; };

const brief = i => `${i.ref} SEV${i.severity} ${i.status}: ${i.title}${i.commander ? ` (commander ${i.commander})` : ''}`;

export function tools() {
  if (!available()) return [];
  return [
    { name: 'open_incident',
      description: 'Declare an incident in StackGen Incidents when the person asks to open, declare or raise one. Attaches the evidence you most recently gathered. Confirm the title and severity in your reply.',
      inputSchema: { type: 'object', properties: {
        title: { type: 'string', description: 'What is happening, in a short sentence' },
        severity: { type: 'number', description: '1 critical (customers broadly affected), 2 major, 3 minor (default), 4 low' },
        services: { type: 'array', items: { type: 'string' } }, clusters: { type: 'array', items: { type: 'string' } },
        summary: { type: 'string', description: 'What is known so far, two or three sentences' },
        impact: { type: 'string' },
        alert_uid: { type: 'string', description: 'The alert rule uid when the incident is about an alert (from list_alerts); links the incident to the alert and to Aiden\'s investigation of it' } }, required: ['title'] } },
    { name: 'list_incidents',
      description: 'Open incidents in StackGen Incidents (or search all, including resolved, with a query).',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, include_resolved: { type: 'boolean' } } } },
    { name: 'update_incident',
      description: 'Change an incident: status (investigating, identified, monitoring, resolved), severity, cause or resolution. Only when the person asks.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'e.g. INC-0001' }, status: { type: 'string', enum: ['investigating', 'identified', 'monitoring', 'resolved'] },
        severity: { type: 'number' }, cause: { type: 'string' }, resolution: { type: 'string' }, note: { type: 'string' } }, required: ['ref'] } },
    { name: 'add_incident_note',
      description: 'Add a note or finding to an incident timeline, e.g. what you just found, or something the person dictates.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, note: { type: 'string' }, kind: { type: 'string', enum: ['note', 'finding'] } }, required: ['ref', 'note'] } },
    { name: 'recall_memory',
      description: 'What StackGen already knows from past incidents and investigations: causes, fixes, owners, chronic issues, lessons. Use for "have we seen this before?", "what fixed it last time?", "who owns X?".',
      inputSchema: { type: 'object', properties: { question: { type: 'string' }, services: { type: 'array', items: { type: 'string' } }, clusters: { type: 'array', items: { type: 'string' } } }, required: ['question'] } },
  ];
}
const NAMES = ['open_incident', 'list_incidents', 'update_incident', 'add_incident_note', 'recall_memory'];
export const has = name => NAMES.includes(name);
export const describe = name => ({ open_incident: 'Declaring the incident', list_incidents: 'Checking open incidents', update_incident: 'Updating the incident',
  add_incident_note: 'Adding to the incident timeline', recall_memory: 'Searching memory' })[name];

// hooks: { person } — who asked, for the incident timeline.
export async function call_(name, args = {}, hooks = {}) {
  const actor = hooks.person ? `${hooks.person} via HAL 9000` : 'HAL 9000';
  try {
    if (name === 'open_incident') {
      const ev = lastEvidence && Date.now() - lastEvidence.at < 30 * 60_000 ? lastEvidence.text : null;
      const i = await call('/api/incidents', { method: 'POST', actor, body: { ...args, source: 'hal9000', evidence: ev, evidence_author: 'HAL 9000' } });
      if (args.alert_uid) Promise.resolve(declared(i, args.alert_uid)).catch(() => {});
      return `Declared ${brief(i)}.${ev ? ' The evidence you gathered is on its timeline.' : ''}`;
    }
    if (name === 'list_incidents') {
      const list = await call(`/api/incidents?status=${args.include_resolved || args.query ? 'all' : 'open'}&q=${encodeURIComponent(args.query ?? '')}`);
      return list.length ? `${list.length} incident(s):\n- ${list.slice(0, 10).map(brief).join('\n- ')}` : (args.query ? `No incidents match "${args.query}".` : 'No open incidents.');
    }
    if (name === 'update_incident') {
      const { ref, ...patch } = args;
      const i = await call(`/api/incidents/${encodeURIComponent(ref)}`, { method: 'PATCH', actor, body: patch });
      return `Updated: ${brief(i)}.${patch.status === 'resolved' ? ' Its lessons will be remembered.' : ''}`;
    }
    if (name === 'add_incident_note') {
      await call(`/api/incidents/${encodeURIComponent(args.ref)}/events`, { method: 'POST', actor, body: { kind: args.kind ?? 'note', body: args.note } });
      return `Added to ${args.ref}'s timeline.`;
    }
    if (name === 'recall_memory') {
      const ctx = await recall(args.question, { services: args.services ?? [], clusters: args.clusters ?? [], budget: 700 });
      return ctx || 'Nothing relevant on record.';
    }
  } catch (err) {
    return `Error: StackGen Incidents is unavailable (${err.message}).`;
  }
}
export { call_ as call };

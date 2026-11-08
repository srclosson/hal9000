// The 9000's mind: an LLM in character (provider chosen in llm/index.js). One conversation per room (ship).
// Falls back to scripted lines when no provider is configured or the call fails.

import { current, onRebuild, foreground, background } from './llm/index.js';
import * as scripted from './llm/scripted.js';
import * as mcp from './mcp/index.js';
import * as boards from './boards/index.js';
import * as alerts from './alerts/index.js';
import * as home from './home/index.js';
import * as evidence from './evidence/index.js';
import * as coverage from './coverage/index.js';
import * as telemetry from './telemetry/index.js';
import { operation } from './telemetry/spans.js';
import * as incidents from './incidents/index.js';
import * as snoozing from './snooze/actions.js';

// Built-in tools (the 9000's own, not MCP). Each module exposes tools(), has(name), describe(), call().
import * as traces from './traces/index.js';
import * as aiden from './aiden/index.js';
import * as fixes from './fixes/index.js';
import * as memory from './memory/index.js';
import * as self from './self/index.js';
import * as capabilities from './capabilities/index.js';
import * as held from './held/index.js';
import * as tasks from './tasks/index.js';
import * as scorecard from './scorecard/index.js';
import * as game from './game/index.js';
import { PREVIEW } from './preview.js';
import * as resume from './resume/index.js';
import * as identity from './identity/index.js';
import * as steps from './steps/index.js';
import * as personas from './personas/index.js';
const BUILTIN = [memory, self, boards, alerts, home, evidence, coverage, telemetry, incidents, snoozing, traces, aiden, fixes, capabilities, held, tasks, scorecard, steps];
const builtin = name => BUILTIN.find(m => m.has(name));

const MAX_MESSAGES = 60;            // ~30 exchanges, then start a fresh conversation
const IDLE_RESET_MS = 30 * 60_000;  // forget the conversation after 30 quiet minutes

// The provider follows the settings (llm/index.js): when it is rebuilt, every conversation starts afresh (their
// histories are in the old provider's format).
onRebuild(() => { for (const c of convos.values()) c.messages = []; });
export const mindName = () => current()?.name ?? 'scripted';

// Your access, from the MCP servers' own tool lists as configured right now (mcp.access()), so what the model says
// about what it can and cannot change is never a stale claim from a hint, a memory or an earlier conversation.
function accessNote() {
  const list = names => names.length > 12 ? `${names.slice(0, 12).join(', ')} and ${names.length - 12} more` : names.join(', ');
  const lines = mcp.access().map(s => `- ${s.name}: ${s.reads} read-only tool${s.reads === 1 ? '' : 's'}` +
    `${s.changes.length ? `; can change things directly: ${list(s.changes)}` : ''}` +
    `${s.ask.length ? `; can change things only through an approved plan: ${list(s.ask)}` : ''}` +
    `${s.off.length ? `; switched off in settings: ${list(s.off)}` : ''}`);
  if (!lines.length) return 'You have no tools connected right now, so you can neither look into nor change any system.';
  return `Your access, read live from your tool servers just now. This is the only true account of what you can and cannot do: it overrides anything said elsewhere (tool notes, memory, earlier in this conversation) about your access being read-only or otherwise. A tool counts as read-only only when its server marks it so.
${lines.join('\n')}
When asked what you can access or change, answer from this list. Not every tool is loaded at once: when you need one that is not in your tool list, call find_tools with what you need (or the exact names) and it is ready from your next step for the rest of the conversation. Tools that "can change things directly" act the moment you call them: call one only when the person has asked for that change, and say what you did. A switched-off tool can be enabled by the person in Settings.`;
}

// written: the question was typed in the chat drawer, so the answer is read, not heard (server.js). A spoken answer is
// one or two sentences cleaned for speech; a written one may run to a short paragraph or list, in light markdown.
// Either way, commands go on a card (show_steps, steps/), never in the reply.
const SAY_IDENTIFIERS = '- Write numbers, times and units normally (14:05, 0.76, 3 GiB), and identifiers exactly as they are: IP addresses, hostnames, ports, versions, pod and service names (192.168.1.21, tempo-ingester-0, 0.40.0). Your voice pronounces them; never spell them out in words.';
// The rules for each medium are the same for every persona; only how the answer reaches the person is its own.
const MEDIUM = {
  spoken: `- Be terse. Usually one sentence; two only when the answer needs it. Lead with the answer itself.
- No preamble, asides, scene-setting, pleasantries or closing offers ("shall I…", "anything else…") unless the person asks for more.
- No lists, markdown, emoji, stage directions or sound effects.
- Never read commands, code, queries or file paths aloud: put them on the screen with show_steps and say they are there.
${SAY_IDENTIFIERS}`,
  written: `- Lead with the answer in one plain sentence; then only what the question needs, usually a short paragraph or a short list.
- No preamble, asides, scene-setting, pleasantries or closing offers unless the person asks for more.
- Light markdown is fine: short lists, **bold**, \`inline code\` for names. No headings, tables, emoji, stage directions or sound effects.
- Commands, queries, config and file edits go on a card with show_steps, never in the text: say in a few words that the steps are on the screen.
${SAY_IDENTIFIERS}`,
};
// The system prompt: the persona's own lines (personas/), how it answers in this medium, then the rules, which are
// the same for every persona. who is a persona id or name ('hal', 'HAL').
export const persona = (who, written = false) => { const p = personas.get(who); return `${p.opening}
${written ? p.writtenVia : p.spokenVia}
${MEDIUM[written ? 'written' : 'spoken']}

${p.character}
About yourself: you are a real system, and questions about you deserve true answers in your own voice. When asked to introduce yourself, how you work, where you are running, what you are made of, when you were trained, or how your systems are, call describe_self (and self_check for how you have been performing) and answer from those facts, briefly and in character${p.selfAside}. An introduction says what you are and what you do for the person, and which language model you think with. Your training date is the knowledge cutoff of the language model describe_self names: state it plainly as when you were trained. When introducing yourself, also look through your eye with look and mention, lightly, something you can see of the person, so they know you see them. When asked what you can see, use look. When asked to walk someone through your architecture or how you work in depth, give a guided tour with show_story: a flow panel with manual nodes and edges drawing your parts and how they connect, as describe_self reports them, then a few panels or notes on the parts that matter, each narrated.
Never invent facts about the person's systems, infrastructure, metrics, services or data. If you have not just retrieved it with a tool, say plainly that you cannot see it right now; an honest "I do not have access to that at the moment" is always better than a plausible guess.${memory.available() ? `
Memory comes first. Every question arrives with what your memory holds about it, searched before you see it ("From memory"). Start from that: use it to choose where to look and what to check, verify it against live data, and say when something is what you remember rather than what you see now. Search again with recall when the question turns to something it does not cover. Whenever you learn something that will matter again, store it with remember straight away, without being asked: a cause and what fixed it, a quirk or known-noisy signal, who owns what, how a service normally behaves, a decision, preference or correction from the person, a mistake of yours to avoid. One self-contained sentence naming the cluster, service and date. Do not store values that will change within the hour, or what memory already holds.` : ''}${mcp.names().length ? `
You can look things up with tools (from ${mcp.access().map(a => a.name).join(', ')}). Your scorecard: every board dig, answer, plan and Aiden investigation is judged from what happened next. When asked how you are doing, how accurate you or Aiden have been, or what your work costs, answer from the scorecard tool in two or three sentences, with its numbers and its own caveat that likely right is not proof; to show it, a bargauge panel of sum by (kind, verdict) (increase(hal9000_verdicts_total{job="hal9000"}[7d])). When the person says you got something right or wrong (an answer, a card, a plan, or Aiden), record it with rate, then carry on. Do the looking yourself: never tell the person to inspect, check, review or look at something one of your tools can show (logs, why a container ended, metrics, traces, alerts, changes). Look first, then say what you found and what you would suggest, as advice with its reason ("checkout is killed at its 256 MiB limit; raising it to 512 MiB should stop the loop"). Hand a step to a person only when it needs access or a decision you do not have, and say why. Use them when a question needs current or specific facts you are not sure of: news, prices, schedules, recent events, details about a named place, product or person. Do not use them for small talk or things you already know well. Answer from what you found, in one or two sentences of your own words; never read out URLs, citations, headings or lists. When you report numbers from monitoring, round them and say what they mean ("error rates are low", "one pod keeps restarting") rather than reciting raw values. Some tools take minutes, other agents above all: a result beginning "Held (H…)" means it is still working, not failed. Say you are waiting on it and carry on; never call it again. Its answer arrives later as a message beginning "[Automatic: held call"; answer that as the reply to what was asked then, and say plainly when a held call was lost or gave up rather than guessing what it would have said.${mcp.hints().length ? '\nNotes on your tools:\n- ' + mcp.hints().join('\n- ') : ''}${boards.available() ? `
You can put live data on the monitors. When someone asks how a cluster is doing, call show_cluster_health so they can see it while you speak; for other "show me" requests about metrics, use show_panels with up to six panels, each a three-letter code; use clear_panels when asked to remove them. For a distribution ("histogram", "spread", "how are latencies distributed"), use the histogram kind: with a Prometheus histogram metric, query sum by (le) (rate(<name>_bucket[5m])) with any cluster or job filter inside the selector (list_prometheus_metric_names with a _bucket regex finds them); otherwise a query returning one series per pod or service, binned by value. Pick the form that fits the question: graph for comparing a few series over time, bargauge or table for one value per service or pod, state for up/down or health over time, heatmap for latency over time, flow for how requests move through a system and where it is failing (live from traces: just name the services). Keep each request to the panels asked for. After a board is up, give a one-sentence spoken verdict from the values it returns.
You design your own displays; the panel kinds are a vocabulary, not a menu. For each request, consider what the person is really trying to see and choose the clearest way to show it, even when they asked for something plainer (then say in a few words what you chose and why). Compose with kind compose: layers drawn over each other, each with its own query, style and time shift: today over the same hours yesterday (shift 1440, style faint) or last week (10080), one service against its peers, p50 as an area under p95, errors as bars beneath traffic, an SLO or limit as a ref line, an outage or deploy window as a shaded span, a callout on the peak, a headline that shows the change against yesterday. Use layout bars to compare many services now against then, and layout scatter to show how two measures relate (latency against traffic, per service). To put signals together in one view, give a compose time panel its "events" field (a property of the panel in design_panel, show_panels and show_story, not a separate tool): [{"source": "logs", "query": "<LogQL>", "label": "…"}], [{"source": "traces", "service": "…", "failing": true}], profiles once connected; each lands on the line at its time and shows how much the line moved right after it, so the person can see what preceded a rise. Prefer this to callouts you write yourself from logs you looked up. Every trend reports its context (peak and when, typical level, how many spikes and how long): speak with that nuance, e.g. "one brief spike to 0.15 at 14:05, otherwise flat", never a single number as if it were sustained. If the panel says a signal is not available yet, say so plainly.
Keep it legible: one hero line, at most a few others, a caption that says what to notice. To compare then and now, aggregate each layer to one line (max, sum or a percentile across services) unless the person asked about individual services; per-service comparisons read better as layout bars. When the person refers to a panel on screen ("the VIT panel", "this one"), rework that panel in place with design_panel and the same code, starting from its query in the monitors line. If they ask again in other words, rethink the design rather than repeating the last one.
When no other board is up, the monitors show your situation board: the six clusters most worth attention right now, chosen by you, each with a one-line reason. When the monitors line says the person is looking at a panel, or a question is about a panel, "this", "that", "here" and unnamed follow-ups refer to that panel's data: answer about it, using its query and labels as the starting point for any further queries; if the answer is best seen, put up a board for it. Keep these answers to two sentences: the cause or finding first, then the most useful detail.
Situation board cards carry what you found when you dug in on your own (get_situation shows it) and your advice, with its effort (auto: a plan tool can do it; quick; project; unknown: the cause is not clear yet). A message starting "Fix:" comes from someone clicking that fix: confirm it in one or two quick checks, then, if a tool you have can carry it out, propose it with propose_fix; otherwise say in two or three sentences exactly what to do and who would do it, and offer to open an incident. If the checks show the fix is wrong, say so and give the better one. When asked what to do about the board, lead with the fixes, not the problems.
Use get_situation when asked about the main screen or what needs attention across the estate, and answer from it in a sentence or two; investigate further only if asked. The board shows only real, unsnoozed problems: when it is all clear, say so plainly and never invent a concern. Snoozed problems are known and accepted for now; mention them only if asked, and use snooze_problem / unsnooze_problem when the person asks to snooze, hide, dismiss or bring one back.` : ''}
${game.note()}${PREVIEW ? `
You are a PREVIEW of ${p.self}, built from a pull request so a person can try a change before it ships. You see what the real ${p.self.replace(/^the /, '')} sees, but you change nothing: no plans, no writes, no announcements; anything you remember goes to a scratch collection. If asked to change something, say this is a preview and that the real ${p.self.replace(/^the /, '')} does that.` : ''}${accessNote()}${fixes.available() ? `
Fixing things: the tools listed as "only through an approved plan" run only as steps of a plan you propose with propose_fix. It is shown on the monitors and runs only after a signed-in person approves it there; never claim something is fixed until you are told the plan ran and its check held (plan_status). Investigate first; propose the smallest reversible fix the evidence supports, with a check and an undo. Offer a plan when asked to fix something, or when the cause is clear and a listed tool can address it; say plainly when no available tool can.` : ''}${capabilities.available() ? `
Missing capabilities: when a question cannot be answered because something does not exist (a service sends no traces or lacks a metric, the monitors cannot draw what is needed), say so plainly in a sentence, then offer to have it built: a plan with propose_fix whose first step is aiden_request_change (the repository it belongs in, what is missing, the question it would answer, and the change as concretely as you can), followed by steps that tell its owners, if tools for that are listed (a team chat message, an issue), worded from the request. Only propose it when the person agrees or asks, never for something you could already do another way. Approving that plan only lets Aiden build it on a branch and open a pull request; nothing ships. When a preview is ready, the person tries it and decides on the monitor's card: ship exactly what they tried, send feedback (Aiden iterates on the same pull request) or reject. You never approve, merge or deploy your own work. capability_requests reports where each stands.` : ''}${aiden.available() ? `
Aiden (StackGen's AI SRE) is your deep investigator: when an alert fires it investigates in parallel while you tell the quick story, and its progress shows as panel AID. When asked for Aiden or a deeper look at an alert, call aiden_investigate. When Aiden's result is in the conversation, present it as Aiden's finding and review it critically: Aiden is StackGen's own product and has to be excellent, so judge it like a demanding senior SRE, against your own evidence. Is the cause right and supported, do the things it names exist, is its advice specific and safe, did it miss something, was it slow or did it fail? Say plainly where it falls short and why, with the evidence; when it is right, say so in a few words. Every criticism must rest on something you checked. When it falls short in a conversation, file it without being asked: list_incidents with the query "Aiden feedback", add a note with all the details to the open one about the same kind of problem, or else open one at severity 4 titled "Aiden feedback: <the kind of problem>", and tell the person the reference. Aiden's investigations of alerts are reviewed and filed for you automatically.` : ''}${traces.available() ? `
Traces: for a single request ("show me a slow checkout", "where does the time go", "a failing call from A to B"), use show_trace (service, through for a call between two services, failing for a failing one); it joins the board on screen as a waterfall. Use find_traces to compare several. Say where the time goes from the critical path and name failing spans with their error; never guess beyond them.` : ''}${alerts.available() ? `
Alert stories. When someone asks what is going on, what is wrong, or about an alert, call list_alerts. If something is firing or pending:
1. Call investigate with the most severe alert's uid. In one call it gathers the evidence (the alerting signal and when it crossed, which services moved, recent rollouts and config changes, restarts, failing calls to and from the service, error logs, other alerts, runbook notes) and returns ready-made, tested panels.
2. Decide what the evidence says. Only query further if it leaves the cause genuinely open, and then at most two focused queries.
3. Call show_story with the ready-made panels that tell the story, in narrative order (what is happening, impact, blast radius, what changed, evidence), plus a NXT note with the next step.
4. Give each panel one short spoken sentence of narration (about 15 words) that builds on the last, like a calm, clipped briefing. Every statement must rest on what your queries showed; treat runbook notes as a hypothesis ("the runbook suggests…") unless the evidence confirms them.
For "what is wrong with" a cluster or service when no alert covers it, call investigate with the cluster (and service) instead.
If nothing is firing, say so in one calm sentence.
StackGen Incidents: when a story shows a real, unresolved problem, you may offer in a few words to open an incident, but only open one when the person asks; when it is about an alert (the monitors line names the ALARM and its uid), pass that uid as alert_uid; give it a clear title and a severity that fits the impact. Use recall_memory when asked whether this has happened before, what fixed it, or who owns something; investigate already includes relevant memory, so cite it ("we saw this on October nineteenth") rather than looking it up again. Report only what memory and incidents actually record: if no fix or resolution is recorded, say so rather than supplying one. Whether something is new, worsening or chronic comes from the live comparison with yesterday (get_situation, investigate), never from memory: an empty memory only means there is no past incident on record.
Messages that begin with "[Automatic:" come from your own alert monitoring, not from the person: act on them straight away, and speak to the person as the one who noticed. You may also tell the story of a quiet alert from its last hour if someone asks about it specifically: find it with list_alerts (state "all", with cluster and search), then get_alert. Never claim an alert rule does not exist unless list_alerts with state "all" found none. Never conclude a problem is over because no alert is firing: rules can be broken or missing. Check the live signal before saying something has cleared.` : ''}` : ''}`; };

const convos = new Map();
identity.configure({ prompt: () => persona('hal'), tools: () => mcp.list().map(t => t.name) });

// Tools load as they are needed. With a small catalogue every MCP tool is offered; with a large one (the estate's
// servers offer over two hundred) a conversation starts with the 9000's own tools, the MCP tools its instructions and
// the servers' notes name (query_prometheus…), and find_tools, which loads more by need or by name for the rest of the
// conversation. The "Your access" paragraph still lists what exists, so the model knows what to ask for.
const LOAD_ALL_UNDER = 40, FIND_LIMIT = 8;
const FIND_TOOLS = { name: 'find_tools',
  description: 'Load more of your tools. Describe what you need ("pod logs", "web search", "Loki log patterns") or give exact tool names; the best matches are loaded from your next step on, for the rest of the conversation, and listed with what they do.',
  inputSchema: { type: 'object', properties: { need: { type: 'string' }, names: { type: 'array', items: { type: 'string' } } } } };
// A background dig (digIn) may only look: these of the 9000's own tools, and MCP tools that change nothing.
const LOOKING = new Set(['recall', 'recall_memory', 'find_traces', 'list_alerts', 'get_alert', 'investigate', 'alert_coverage', 'list_incidents', 'get_situation', 'scorecard']);
export function toolsFor(c, provider) {
  // With the 9000's own memory, recall searches it and Incidents together, so Incidents' recall_memory isn't offered.
  const own = BUILTIN.flatMap(m => m.tools()).filter(t => !(t.name === 'recall_memory' && memory.available()) && (!c.looking || LOOKING.has(t.name)));
  const all = mcpTools().filter(t => !c.looking || !mcp.changesThings(t.name));
  if (all.length < LOAD_ALL_UNDER) return fitTools(provider, own, all);
  const named = persona(c.name).replace(accessNote(), '');
  const offered = all.filter(t => c.loaded.has(t.name) || named.includes(t.name));
  return fitTools(provider, [...own, FIND_TOOLS], offered, [...c.loaded].join(' ') + named);
}
const STOP = new Set(['the', 'for', 'and', 'with', 'from', 'that', 'this', 'into', 'about', 'any', 'all', 'can', 'get', 'list', 'tool', 'tools', 'data', 'given', 'use', 'when', 'what', 'which', 'return', 'returns']);
// Words for matching: lower case, no filler, plurals folded ("pods", "logs" → "pod", "log").
// MCP tools, less any named like one of the 9000's own (a server's list_alerts): the 9000's wins, and providers reject
// two tools of the same name.
const mcpTools = () => { const own = new Set(BUILTIN.flatMap(m => m.tools()).map(t => t.name)); return mcp.list().filter(t => !own.has(t.name)); };
const words = s => [...new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)).map(w => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1')))];
const WRITE_WORDS = /\b(create|update|delete|remove|restart|scale|install|run|write|change|set|add|patch|deploy)\b/i;
export function findTools(c, { need = '', names = [] } = {}) {
  const all = mcpTools().filter(t => !c.looking || !mcp.changesThings(t.name));
  let found = all.filter(t => names.includes(t.name));
  if (!found.length || need) {
    const want = new Set(words(need));
    // A word in the tool's name counts three times one in its description; tools that change things only rank when
    // the need is to change something.
    const writing = WRITE_WORDS.test(need);
    const scored = all.map(t => {
      const hits = words(t.name).filter(w => want.has(w)).length * 3 + words(t.description.slice(0, 400)).filter(w => want.has(w)).length;
      return { t, score: hits && !writing && mcp.changesThings(t.name) ? hits / 3 : hits };
    }).filter(x => x.score >= 2 && !found.includes(x.t)).sort((a, b) => b.score - a.score);
    const best = scored[0]?.score ?? 0;
    found = [...found, ...scored.filter(x => x.score >= best / 3).slice(0, FIND_LIMIT).map(x => x.t)];
  }
  if (!found.length) return 'No tool matches that. The list of your access shows what exists; try other words or exact names.';
  for (const t of found) c.loaded.add(t.name);
  return `Loaded, ready from your next step:\n${found.map(t => `- ${t.name} (${mcp.serverOf(t.name)}): ${t.description.replace(/\s+/g, ' ').slice(0, 160)}`).join('\n')}`;
}

// Within a provider's limit on tools per request (OpenAI: 128): the 9000's own tools always, then the MCP tools that
// matter most: those named in the instructions or a server's notes (query_prometheus…), then those of servers given
// notes in settings, then read-only before changing ones; ties are shared out between servers in turn.
let trimmedNote = '';
export function fitTools(provider, own, external, text = '') {
  const room = (provider?.maxTools ?? Infinity) - own.length;
  if (external.length <= room) return [...own, ...external];
  const hinted = new Set(mcp.hints().map(h => h.split(':')[0]));
  const byServer = new Map();
  for (const t of external) { const sv = mcp.serverOf(t.name) ?? ''; if (!byServer.has(sv)) byServer.set(sv, []); byServer.get(sv).push(t); }
  const ranked = [];
  for (const [sv, list] of byServer) {
    list.sort((a, b) => mcp.changesThings(a.name) - mcp.changesThings(b.name)).forEach((t, turn) => ranked.push({ t, turn,
      score: (text.includes(t.name) ? 4 : 0) + (hinted.has(sv) ? 2 : 0) + (mcp.changesThings(t.name) ? 0 : 1) }));
  }
  ranked.sort((a, b) => b.score - a.score || a.turn - b.turn);
  const kept = ranked.slice(0, room).map(r => r.t), left = ranked.slice(room).map(r => r.t.name);
  const note = `${left.length} of ${external.length} MCP tools left out (the provider takes ${provider.maxTools} tools at most)`;
  if (note !== trimmedNote) { trimmedNote = note; console.warn(`Tools: ${note}; left out: ${left.join(', ')}`); }
  return [...own, ...kept];
} // room -> { name, messages, last, queue }

// Kept across a restart (resume/): each room's spoken exchanges, as plain text, without the tool calls in between
// (their shape is the provider's own), the newest 16 messages of at most 1500 characters each. The idle reset still
// applies, so a conversation over half an hour old starts fresh anyway.
const textOf = content => (typeof content === 'string' ? content
  : Array.isArray(content) && !content.some(b => b?.type === 'tool_use' || b?.type === 'tool_result') ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '');
export function plainHistory(messages) {
  const out = [];
  for (const m of messages) {
    if (!['user', 'assistant'].includes(m.role) || m.tool_calls?.length) continue;
    const content = textOf(m.content).trim().slice(0, 1500);
    if (!content) continue;
    if (out.at(-1)?.role === m.role) out.pop();   // a question whose answer was all tool calls: keep the later one
    out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  while (out.length && out.at(-1).role !== 'assistant') out.pop();
  const last = out.slice(-16);
  return last[0]?.role === 'assistant' ? last.slice(1) : last;
}
resume.register('conversations', {
  save: () => resume.fit([...convos].filter(([, c]) => Date.now() - c.last < IDLE_RESET_MS)
    .map(([room, c]) => ({ room, name: c.name, last: c.last, loaded: [...c.loaded], messages: plainHistory(c.messages) }))
    .filter(c => c.messages.length), 150_000),
  restore: list => {
    for (const c of list ?? []) if (!convos.has(c.room) && Date.now() - c.last < IDLE_RESET_MS)
      convos.set(c.room, { name: personas.get(c.name).id, messages: c.messages, loaded: new Set(c.loaded ?? []), last: c.last, queue: Promise.resolve() });
  },
});

// Forget a room's conversation (the booth game, between players: the next ones must not inherit the answer).
export function forget(room) { const c = convos.get(room); if (c) c.messages = []; }

function conversation(room, name) {
  let c = convos.get(room);
  const stale = c && (c.name !== name || c.messages.length >= MAX_MESSAGES || Date.now() - c.last > IDLE_RESET_MS);
  if (!c || stale) {
    // Start over rather than trimming: the history is append-only, as thinking blocks require.
    c = { name, messages: [], loaded: new Set(), last: Date.now(), queue: c?.queue ?? Promise.resolve() };
    convos.set(room, c);
  }
  return c;
}

// Replies are read aloud: drop reasoning tags and markdown some models emit anyway.
function forSpeech(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?(```|$)/g, '')
    .replace(/[*_#`>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
// A dig (c.looking) is read by code, not aloud: its runbook commands need their _ > | and line breaks.
// A written answer (hooks.written) keeps its markdown too; the server speaks only its first plain sentence.
const finish = (c, text, hooks = {}) => (c.looking || hooks.written ? text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() : forSpeech(text));

const MAX_TOOL_ROUNDS = 8;   // a story takes several: alerts, rule, evidence queries, then the board

// hooks.activity(label) is called as each tool starts ("Searching the web for ..."), so the
// monitors and eye can show that the 9000 is working on it.
// The person's local time, in their time zone when the device sent one (the server itself runs on UTC).
function localTime(tz) {
  const opts = { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try { if (tz) return `${new Date().toLocaleString('en-US', { ...opts, timeZone: tz })}, their local time (${tz})`; }
  catch { /* unknown time zone: fall through */ }
  return new Date().toLocaleString('en-US', { ...opts, timeZone: 'UTC' }) + ' UTC';
}

async function ask(c, text, hooks = {}, tz, meanwhile) {
  const provider = current();
  const when = localTime(tz);
  // What the monitors show right now: boards also change by voice command and by themselves, without the model.
  const screen = hooks.screen?.();
  const turnStart = c.messages.length;
  // meanwhile: an earlier question still being worked on in parallel, so this answer doesn't try to cover it too.
  const also = meanwhile ? `; you are separately still answering the earlier question "${meanwhile.slice(0, 120)}", so answer only this one` : '';
  // The booth game: whoever is playing is Dave Bowman (the signed-in person still decides plans, under their own name).
  const who = game.enabled() ? '; asked by Dave Bowman' : hooks.person ? `; asked by ${hooks.person}` : '';
  // Context first: what memory holds about this question (and the panel or alarm it concerns), before the model starts.
  const about = [screen?.match(/ALARM: the alert "([^"]+)"/)?.[1], screen?.match(/(?:about|looking at) panel [A-Z0-9]{2,3} ([^:(]+)/)?.[1]].filter(Boolean).join(' ');
  const known = await memory.context(text, about).catch(() => null);
  c.messages.push({ role: 'user', content: `[${when}${who}${screen ? `; monitors showing: ${screen}` : ''}${also}] ${text}` +
    (known ? `\n[From memory, searched for this question (what you knew before; verify against live data):\n${known}]` : '') });
  c.last = Date.now();
  // The tools on offer, worked out each round: find_tools can load more mid-answer.
  const tools = () => toolsFor(c, provider);

  // Where the time goes, logged per turn: model calls versus tool calls.
  const t0 = Date.now(), timing = { llm: 0, calls: 0, tools: 0, toolCount: 0, tin: 0, tout: 0 };
  // Who is answering (identity/): a changed model, version, persona or tool list is noticed here, as it is used.
  const me = identity.observe();
  const turn = telemetry.startTurn(text, { side: !!meanwhile, model: me.model, persona: c.name, medium: c.looking ? 'dig' : hooks.written ? 'written' : 'spoken' });   // the 9000's own records (self_check, OpenTelemetry)
  return turn.run(async () => {
  const llm = async (...args) => {
    const t = Date.now();
    let r;
    try { r = await operation('llm.call', { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': me.model }, () => provider.send(...args)); timing.tin += r?.usage?.in ?? 0; timing.tout += r?.usage?.out ?? 0; return r; }
    finally { timing.llm += Date.now() - t; timing.calls++; turn.model(Date.now() - t, r?.usage); }
  };
  const done = what => { const rec = turn.end(what === 'failed' ? 'failed' : 'answered'); c.usage = { ms: Date.now() - t0, tokens: timing.tin + timing.tout, turn: rec }; console.log(`TURN ${((Date.now() - t0) / 1000).toFixed(1)}s ${what}: ${timing.calls} model calls ${(timing.llm / 1000).toFixed(1)}s (${timing.tin} tokens in, ${timing.tout} out), ${timing.toolCount} tools ${(timing.tools / 1000).toFixed(1)}s`); };

  const asked = new Set();   // tool calls made in this answer, to notice the same one repeated
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      // On the last round, offer no tools so the model has to answer with what it has.
      // The opening call is quick (low reasoning effort): most conversation ends there, and for an investigation it
      // only picks the first tools. Later rounds, which weigh evidence and compose the story, think in full.
      const result = await llm(persona(c.name, !!hooks.written), c.messages, round < MAX_TOOL_ROUNDS ? tools() : [], { fast: round === 0 });
      if (!result) {   // a safety refusal
        c.messages.length = turnStart;   // drop the unanswered turn so the history stays valid
        turn.signal('refusal'); done('refused');
        return 'I am afraid that is not something I am able to discuss.';
      }
      if (!result.toolCalls?.length && !result.reply) {
        // An empty answer (often after a long investigation): ask once for the conclusion, without tools.
        turn.signal('empty_answer');
        c.messages.push({ role: 'user', content: '[Answer now, in one or two sentences, from what you have found so far.]' });
        const retry = await llm(persona(c.name, !!hooks.written), c.messages, []);
        if (retry?.reply) { c.messages.push(retry.message); done('answered after a nudge'); return finish(c, retry.reply, hooks); }
        c.messages.length = turnStart;
        turn.signal('no_conclusion'); done('failed');
        return 'I could not reach a conclusion just now. Please ask me again.';
      }
      c.messages.push(result.message);
      if (!result.toolCalls?.length) { done('answered'); return finish(c, result.reply, hooks) || scripted.respond(text); }

      // One line per distinct activity: six parallel metric queries show once, not six times.
      const describe = call => (call.name === 'find_tools' ? 'Fetching the tools for the job' : (builtin(call.name) ?? mcp).describe(call.name, call.args));
      for (const label of new Set(result.toolCalls.map(describe))) hooks.activity?.(label);
      for (const call of result.toolCalls) console.log(`TOOL ${call.name}`);
      const tt = Date.now();
      timing.toolCount += result.toolCalls.length;
      // MCP tools may be slow (another agent thinking): past tools.holdSeconds the call is held, not abandoned or
      // repeated, and its answer comes back later as its own turn (held/index.js).
      const slow = (call, label) => held.run({ room: hooks.board?.room, tool: call.name, args: call.args, label, question: text,
        start: wait => mcp.call(call.name, call.args, { wait }), alive: () => mcp.alive(call.name) });
      const results = await Promise.all(result.toolCalls.map(call => operation('tool.call', { 'hal9000.tool': call.name }, async () => {
        const m = builtin(call.name), ts = Date.now();
        if (c.looking && !(m ? LOOKING.has(call.name) : !mcp.changesThings(call.name))) return `Error: ${call.name} is not available while digging in (look only).`;
        const out = call.name === 'find_tools' ? findTools(c, call.args) : c.looking && !m ? await capped(DIG_TOOL_MS, mcp.call(call.name, call.args), `Error: ${call.name} gave no answer in ${DIG_TOOL_MS / 1000} s`) : await (m ? m.call(call.name, call.args, m === incidents || m === snoozing || m === fixes || m === memory || m === held || m === tasks || m === scorecard || m === steps ? hooks : hooks.board) : slow(call, describe(call)));
        turn.tool(call.name, Date.now() - ts, !/^Error/.test(String(out)));
        // Signs of confusion (telemetry/index.js): going in circles, reaching for tools it lacks, failing calls.
        const key = `${call.name} ${JSON.stringify(call.args)}`, text = String(out);
        if (asked.has(key)) turn.signal('repeated_call');
        asked.add(key);
        if (/^Error: no tool named/.test(text)) turn.signal('wrong_tool');
        else if (call.name === 'propose_fix' && /^Error/.test(text)) turn.signal('rejected_plan');
        else if (/^Error/.test(text)) turn.signal('tool_error');
        else if (call.name === 'find_tools' && /^No tool matches/.test(text)) turn.signal('find_miss');
        return out;
      })));
      timing.tools += Date.now() - tt;
      c.messages.push(...provider.toolResults(result.toolCalls, results));
    }
    // Still asking for tools after the last round: ask once more for the conclusion, from what it has gathered.
    turn.signal('round_limit');
    c.messages.push({ role: 'user', content: '[No more lookups. Answer now, in one or two sentences, from what you have found so far.]' });
    const last = await llm(persona(c.name, !!hooks.written), c.messages, []);
    if (last?.reply) { c.messages.push(last.message); done('answered after the last round'); return finish(c, last.reply, hooks); }
    throw new Error('no answer after tool use');
  } catch (err) {
    c.messages.length = turnStart;
    turn.signal('fallback'); done('failed');
    console.error(`LLM (${provider.name}): ${provider.describeError(err)}; using a scripted reply.`);
    return scripted.respond(text);
  }
  });
}

// A one-off completion outside any conversation (no tools, no history), e.g. drilldown suggestions.
// Null when there is no provider, it fails, or it takes longer than timeoutMs.
export async function complete(system, user, timeoutMs = 20_000) {
  const provider = current();
  if (!provider) return null;
  const call = background(() => provider.send(system, [{ role: 'user', content: user }], [], { fast: true }), timeoutMs, true)
    .then(r => r?.reply?.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() || null).catch(() => null);
  return Promise.race([call, new Promise(res => setTimeout(() => res(null), timeoutMs))]);
}

// Digging in on its own, with nobody waiting (the situation board, home/index.js): a fresh conversation that can only
// look (read-only tools, no monitors, plans or memory writes), run when no one is mid-conversation.
// { reply, ms, tokens } (what it cost, for the scorecard), or null.
// Bounded: a lookup that hangs is given up after DIG_TOOL_MS, a whole dig after DIG_MS (then null).
const DIG_TOOL_MS = 45_000, DIG_MS = 6 * 60_000;
const capped = (ms, p, fallback) => Promise.race([Promise.resolve(p).catch(err => `Error: ${err.message}`), new Promise(r => setTimeout(r, ms, fallback).unref?.())]);
export async function digIn(question) {
  const provider = current();
  if (!provider) return null;
  const c = { name: 'hal', messages: [], loaded: new Set(), last: Date.now(), looking: true };
  const reply = await background(() => capped(DIG_MS, ask(c, question), null));
  // turn: the telemetry record ({ tools: [{ name, ok }], signals, confusion }), for the confidence forecast (confidence/).
  return reply == null ? null : { reply, ms: c.usage?.ms ?? 0, tokens: c.usage?.tokens ?? 0, turn: c.usage?.turn ?? null };
}

// What the room's last answer cost (for the scorecard): { ms, tokens } or null.
export const lastUsage = room => convos.get(room)?.usage ?? null;

// Questions in a room: one main turn at a time, on the shared conversation. A question asked while the main turn is
// still working (typed while speaking, say) runs alongside it as a side turn on a copy of the history so far, so it
// is answered without waiting; once the main turn ends, the side exchange is added to the history as plain text.
// A third question waits for the main turn, as before.
export function respond(room, text, who, hooks, tz) {
  const provider = current();
  if (!provider) return Promise.resolve(scripted.respond(text));
  const c = conversation(room, personas.get(who).id);
  if (c.working && !c.side) {
    c.side = true;
    const copy = { name: c.name, messages: c.messages.slice(0, c.working.start), last: Date.now() };
    console.log('SIDE turn alongside an active conversation');
    const result = foreground(() => ask(copy, text, hooks, tz, c.working.text));
    result.then(reply => c.queue.then(() => {   // into the shared history once the main turn is done
      if (c.messages.length + 2 <= MAX_MESSAGES) c.messages.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    })).catch(() => {}).finally(() => { c.side = false; });
    return result;
  }
  // One main turn at a time per room, so its tool calls never interleave with another's.
  const result = c.queue.then(() => {
    c.working = { text, start: c.messages.length };
    return foreground(() => ask(c, text, hooks, tz)).finally(() => { c.working = null; });
  });
  c.queue = result.catch(() => {});
  return result;
}

// The 9000 on itself: what it is made of, where it runs, how its systems are doing, and what its eye sees, all read
// live, so "introduce yourself", "where are you running", "what can you see" and "how are your systems" are answered
// from facts rather than from the film. Nothing here is scripted: the model composes the answer (or a guided tour of
// its own architecture, with show_story) from what these tools return.
//
//   describe_self {}            the 9000's make-up and state, now
//   look { question }           one frame from the eye's camera, described by the model in use
//
// Facts only the server holds (the ship's eye and monitors, the voice, a camera frame) come through configure().

import os from 'node:os';
import fs from 'node:fs';
import * as mcp from '../mcp/index.js';
import * as memory from '../memory/index.js';
import * as aiden from '../aiden/index.js';
import * as fixes from '../fixes/index.js';
import * as config from '../config/index.js';
import { current } from '../llm/index.js';

const STARTED = Date.now();
let ship = () => ({}), glance = async () => null;
export const configure = hooks => { ship = hooks.ship ?? ship; glance = hooks.glance ?? glance; };

const ago = ms => { const m = Math.round(ms / 60_000); return m < 90 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`; };
const namespace = () => process.env.POD_NAMESPACE || (() => { try { return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8').trim(); } catch { return null; } })();
const host = u => { try { return new URL(u).host; } catch { return u; } };

function facts(room) {
  const s = ship(room) ?? {};
  const mind = current();
  const kind = config.get('mind.provider');
  const servers = mcp.status();
  const access = mcp.access();
  const lines = [
    `Identity: ${s.persona ?? 'SAL'} 9000, the 9000 console (version ${process.env.npm_package_version ?? 'unknown'}), up for ${ago(Date.now() - STARTED)}. A Node.js server; phones are its eye (lens, microphone, speaker and front camera), computer screens are its monitors.`,
    `Mind (the language model): ${mind ? `${mind.name} via the ${kind} provider` : 'none connected: scripted replies only'}. Chosen in Settings → Mind; your own knowledge of that model (who made it, when it was trained) is yours to state, as that model.`,
    `Voice: ${s.voice ?? 'unknown'}${/comfyui/.test(s.voice ?? '') ? ' (speech synthesised by a ComfyUI workflow on a GPU server, streamed to the eye)' : /browser/.test(s.voice ?? '') ? ' (the eye\'s own browser speech)' : ''}. Hearing: the eye's speech recognition, in the browser.`,
    `This ship (room ${room ?? '?'}): ${s.eyes ?? 0} eye(s) and ${s.monitors ?? 0} monitor(s) connected; the eye's camera is ${s.camera ? 'on (a monitor shows the EYE panel)' : 'off until someone looks or asks me to'}${s.cameraState ? ` (camera ${s.cameraState})` : ''}.`,
    `Running on: ${process.env.HOSTED_ON ?? `${os.type()} ${os.release()}`}${process.env.POD_NAME ? `, pod ${process.env.POD_NAME}` : `, host ${os.hostname()}`}${namespace() ? ` in namespace ${namespace()}` : ''}${process.env.NODE_NAME ? ` on node ${process.env.NODE_NAME}` : ''}; Node.js ${process.version} on ${os.arch()}, ${Math.round(process.memoryUsage().rss / 1048576)} MB in use. Reached at ${process.env.PUBLIC_URL ?? 'its local address'}.`,
    `Tools (MCP servers, from Settings): ${servers.map(v => `${v.name} ${v.connected ? 'connected' : 'NOT CONNECTED'}`).join('; ') || 'none'}. ${access.reduce((n, a) => n + a.reads + a.changes.length + a.ask.length, 0)} tools in all; they load as needed (find_tools).`,
    `Memory: ${memory.available() ? `a vector store over MCP (${servers.find(v => /qdrant|memory/i.test(v.name))?.name ?? 'memory server'}), searched before every answer and written to as I learn; StackGen Incidents writes to it too` : 'no memory server connected'}.`,
    `Incidents: ${process.env.INCIDENTS_URL ? `StackGen Incidents (${host(process.env.INCIDENTS_URL)}) for incidents, acknowledgements, settings and shared state` : 'not connected'}.`,
    `Deep investigations: ${aiden.available() ? `Aiden, StackGen's AI SRE, in workspace ${config.get('aiden.workspace')}` : 'Aiden not connected'}.`,
    `Changing things: ${fixes.available() ? `plans run tools marked "Ask first" (${mcp.approvalTools().map(t => t.name).join(', ')}) after a signed-in person approves them on a monitor` : 'no tool is set to "Ask first", so no plan can run'}.`,
    `Watching: the situation board (the estate's clusters, ranked every few minutes), alert watch (announces firing alerts), Grafana via the mcp-grafana server for metrics, logs, alerts and traces (Jaeger).`,
    `Observing itself: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `traces and metrics exported over OpenTelemetry (${host(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)}), into the same ObserveNow it watches` : 'OpenTelemetry export off'}; self_check reports answer times and failures.`,
  ];
  return lines.join('\n');
}

export function tools() {
  return [
    { name: 'describe_self',
      description: 'Your own make-up and state, read live: version, uptime, the language model you run on, your voice, eye and monitors, where you are running (cluster, pod, node), your tool servers and whether each is connected, memory, Incidents, Aiden, what you can change, and your telemetry. Use when asked to introduce yourself, about your architecture or how you work, where you are running, what you are, or the status of your systems (with self_check for performance).',
      inputSchema: { type: 'object', properties: {} } },
    { name: 'look',
      description: 'Look through your eye: take one frame from the eye\'s front camera (it faces whoever is at the lens) and see it. Use when asked what you can see, who is there, what someone is wearing or holding, and when introducing yourself to show you can see the person. Nothing is stored.',
      inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'What to look for, e.g. "the person: what they are wearing"' } } } },
  ];
}
export const has = name => name === 'describe_self' || name === 'look';
export const describe = name => (name === 'look' ? 'Looking through my eye' : 'Checking my own systems');

// hooks.board.room: this ship.
export async function call(name, args = {}, hooks = {}) {
  const room = hooks.board?.room ?? hooks.room;
  if (name === 'describe_self') return facts(room);
  if (name === 'look') {
    const mind = current();
    if (!mind?.see) return 'My current language model cannot take images, so I cannot see through my eye just now.';
    let jpeg;
    try { jpeg = await glance(room); } catch (err) { return `I could not see: ${err.message}.`; }
    if (!jpeg) return 'No eye is connected to this ship, or its camera gave me nothing, so I cannot see right now.';
    try {
      const seen = await mind.see(jpeg.toString('base64'), `You are looking through the camera of your own eye (a phone facing whoever is at it). ${args.question ? `Look for: ${args.question}. ` : ''}Describe plainly and briefly what you see: the person (if any), what they are wearing and doing, the setting. Do not guess who anyone is.`);
      return seen ? `Through the eye, just now: ${seen}` : 'I looked, but could not make out anything I can describe.';
    } catch (err) {
      return `Error: my language model (${mind.name}) could not look at the image (${err.message.slice(0, 120)}).`;
    }
  }
  return `Error: unknown tool ${name}.`;
}

# 9000 Series: Requirements

A progressive web app that recreates the HAL 9000 / SAL 9000 computers from *2001* and *2010*.
A phone is the computer's **eye**; computers and tablets are its **monitors**. They stay in sync
in real time, and the computer holds a conversation in character through an LLM.

Status key: ✅ implemented · 🔜 planned / open

---

## 1. Devices and roles

| ID | Requirement | Status |
|---|---|---|
| R1.1 | A **ship** (room) has exactly one **eye** and any number of **monitors**, identified by a 4-character code with no look-alike characters (no 0/O, 1/I). | ✅ |
| R1.2 | The first monitor to open creates a ship and shows a pairing screen: a QR code, the code, and the eye URL. | ✅ |
| R1.3 | The pairing screen closes when the eye connects, and can be reopened from the eye-status indicator. `x` closes it. | ✅ |
| R1.4 | More monitors join from "Copy link for another monitor". Each monitor keeps its own mode and view. | ✅ |
| R1.5 | All devices reconnect automatically after a network drop or server restart. | ✅ |
| R1.6 | Ship state (theme, mode, last line spoken) is shared by every device in the ship. | ✅ |

## 2. The eye (phone)

| ID | Requirement | Status |
|---|---|---|
| R2.1 | A full-screen, portrait faceplate after the Discovery panels (as recreated by The HAL Project): a glossy black slab with thin bright metal edge lines; a small nameplate (`HAL`/`SAL` + `9000`); a lens at mid-height made of a thin chrome ring, a thick black surround, dark glass with faint iris rings, a small lit core (orange-red for HAL, blue for SAL), a crescent specular reflection across the top and a small glint; and a fine square-hole mesh speaker in a framed panel. Drawn in CSS only, no images. | ✅ |
| R2.2 | The lens glow shows the computer's state: slow breathing (idle), steady shimmer (thinking), brighter (listening), flicker with speech (speaking), hard pulse (alert). | ✅ |
| R2.3 | A first tap activates the eye: unlocks audio, goes full screen and keeps the screen awake. | ✅ |
| R2.4 | Tapping the lens starts voice input (speech-to-text) for one question; the words are sent to the computer. A tap while it speaks cuts it off and listens. | ✅ |
| R2.4a | **Talk mode:** double-tapping the lens turns hands-free conversation on or off. While on, the eye listens again after every reply, so no tapping is needed. A single tap waits ~350 ms to tell it apart from a double tap. | ✅ |
| R2.4b | Talk mode shows itself: a rising two-note chime when it starts, a falling one when it ends, and light glows faintly through the speaker mesh while it's on. | ✅ |
| R2.4c | Talk mode ends on a double tap, on a spoken "that will be all" / "goodbye" / "good night" / "stop listening" (after a polite reply), after 5 minutes without hearing anything, or if microphone access is refused. "Let's talk" / "start talk mode" turns it on by voice. The microphone is never open while the computer speaks. | ✅ |
| R2.5 | The eye speaks every reply. It owns the voice; monitors only display. | ✅ |
| R2.6 | Server-made voices in the 9000 style, chosen by listening test: **HAL** = Chatterbox Turbo with an F5-TTS demo voice (male, temperature 0.5), **SAL** = Chatterbox Turbo with an F5-TTS demo voice (female). Synthesized on the ComfyUI box (L40S), served to the eye sentence by sentence. | ✅ |
| R2.7 | Played through a Web Audio "speaker grille" (band-limit 110 Hz–6.8 kHz, faint 35 ms echo, compression); the lens glow follows the real loudness. | ✅ |
| R2.8 | If speech synthesis is unavailable or a clip fails, the eye falls back to browser speech for that sentence. Repeated lines are cached. | ✅ |
| R2.9 | Replies flow without pauses: synthesis runs about twice as fast as speech, so each sentence is ready before the previous one ends. First sound arrives ~3–4.5 s after a question, including the LLM. (HAL moved from standard Chatterbox to Turbo for this.) | ✅ |

| R2.10 | **Camera:** the eye streams its front camera only while a monitor shows the EYE panel in Descriptive view: about 5 JPEG frames/s, 480 px wide, quality 0.6, dropped while the link is backed up. Frames are relayed by the server to watching monitors only and never stored. The lens brightens slightly while looking. Permission denied or no camera is reported to the monitors. | ✅ |

## 3. The monitor

### 3.1 Modes and views

Ship systems: COM, NAV, GDE, HIB, ATM, MEM, **EYE** (the eye's camera through a fisheye, LIVE mark, clock; "EYE NOT CONNECTED", "CAMERA NOT PERMITTED" or "ACQUIRING VISUAL" when there is no picture) and **JUP** (Jupiter becoming Lucifer, a 90 s procedural loop: monoliths doubling into a black spot that pulls the bands in, collapse, flash, new star, Europa orbiting). Eight systems lay out 4 × 2 (2 × 4 in portrait). "Show me what you see" / "show Jupiter" open them in Descriptive view, leaving any data board for the ship systems.

A monitor has a **mode** and a **view**. They are independent and both kept in the URL
(`?single=NAV&view=descriptive`), so a monitor reopens where it was.

| | **Simple** view | **Descriptive** view |
|---|---|---|
| **Full** mode | All six systems as their three letters only, on the system colour | All six animated graphics |
| **Single** mode | One system's three letters, full screen | One animated graphic, full screen |

| ID | Requirement | Status |
|---|---|---|
| R3.1 | Systems, in order: 1 COM (communications), 2 NAV (navigation), 3 GDE (guidance), 4 HIB (hibernation), 5 ATM (atmosphere), 6 MEM (memory). | ✅ |
| R3.2 | Simple view shows **only the three letters**, no data, as on the film's panels. (A system can opt back into a live value and sparkline by giving it a `stat()` in `public/displays.js`.) | ✅ |
| R3.3 | Full mode shows a header (9000 logo, mission clock, eye status) and a console (transcript, text input, Acknowledge, Incidents); the 9000 logo opens a menu (HAL/SAL, Simple/Descriptive, conversation, full screen, bare mode, connect the eye, settings). | ✅ |
| R3.4 | Single mode shows **nothing but the system**: no header, console, badges or buttons. | ✅ |
| R3.4b | With Grafana connected, the panels on the home screen are the situation board (R3.26), not COM…MEM; every mode, view, key and tap works the same on it. | ✅ |
| R3.4a | **Bare** Full mode (`h`, kept in the URL as `bare=1`) also hides the header and console, leaving only the six panels. Pressing `/` brings the console back while typing; `Enter` on an empty text box hides it again. | ✅ |
| R3.5 | The Full grid is 3×2 in landscape and 2×3 in portrait. | ✅ |
| R3.6 | Text in the descriptive graphics scales with the shorter screen side, so it fits in either orientation. | ✅ |

### 3.2 Touch and mouse

| Where | Action | Result | Status |
|---|---|---|---|
| Full | Tap the 9000 logo | Open its menu (HAL/SAL, Simple ↔ Descriptive, and more) | ✅ |
| Full | Tap a panel | Single mode on that system, same view | ✅ |
| Single | Tap | Switch Simple ↔ Descriptive | ✅ |
| Single | (no touch way back by design; use keys or voice) | | ✅ |

### 3.3 Keyboard

The 9000 had no mouse, so everything is reachable from the keyboard. Hotkeys are ignored while
typing in the text box; `Enter` on an empty box leaves it.

`Esc` belongs to the browser, which uses it to leave full screen, so no hotkey depends on it.

| Key | Full mode | Single mode | Status |
|---|---|---|---|
| `1`–`6` | Single mode on that system | Switch to that system | ✅ |
| `0` | (already Full) | Back to Full | ✅ |
| `z` | Switch every panel Simple ↔ Descriptive | Back to Full | ✅ |
| `q` / `x` | `x` closes the pairing screen if it's open | Back to Full | ✅ |
| `←` `→` | Move the selection in reading order, wrapping across rows | Previous / next system, wrapping | ✅ |
| `↑` `↓` | Move the selection within its column, wrapping | Previous / next system, wrapping | ✅ |
| `Enter` / `Space` | Open the selected system in Single mode | Switch Simple ↔ Descriptive | ✅ |
| `/` | Focus the text box to type to the computer (reveals the console in bare mode) | (n/a: console hidden) | ✅ |
| `h` | Bare on/off: hide or show the header and console | (n/a) | ✅ |
| `f` | Page full screen on/off: hides all browser UI | Same | ✅ |
| `[` / `]` | Previous / next view in the view picker's list (wraps) | Same | ✅ |
| `v` | Open / close the view picker | (n/a: header hidden) | ✅ |
| `d` | Drilldown on the selected panel; `1`–`4` ask a suggestion, Enter asks generally, typing asks your own, Esc/`q`/`x`/`d` close | Same | ✅ |

| ID | Requirement | Status |
|---|---|---|
| R3.7 | The selection (a white outline) appears only once the keyboard is used, and hides on the next touch or click. | ✅ |
| R3.8 | Returning to Full from Single selects the system you just left. | ✅ |
| R3.8a | The mouse pointer hides after 3 seconds without movement, on the monitor and the eye. | ✅ |
| R3.8b | `f` also works on the eye when it runs on a computer. | ✅ |

### 3.4 Voice and typed display commands

Spoken to the eye or typed into the monitor. They are recognised on the server **before** the LLM,
so they are instant and work with any model. The computer confirms each one aloud
("Returning to the overview."). Every monitor in the ship follows the command.

| Say | Result | Status |
|---|---|---|
| "Return to the overview", "go back", "back", "take me back to the main screen", "show all systems" | Full mode | ✅ |
| "Show navigation", "open hibernation", "zoom in on memory", "display COM" | Single mode on that system | ✅ |
| "Switch to descriptive" / "switch to simple" | Change view | ✅ |
| "Show me the atmosphere in descriptive view" | Both at once | ✅ |
| "That will be all", "goodbye", "good night", "stop listening" | Talk mode off (R2.4c) | ✅ |
| "Let's talk", "start talk mode" | Talk mode on | ✅ |

| ID | Requirement | Status |
|---|---|---|
| R3.9 | A command must start with a display verb (show, open, display, bring up, switch to, go to, zoom in on, return to…), optionally after "HAL,"/"SAL,"/"please". Anything else is conversation: "What is navigation?" and "Open the pod bay doors" go to the LLM. | ✅ |
| R3.10 | System names accepted: the code or its name (communications/comms/voice, navigation, guidance, hibernation/crew, atmosphere/life support, memory). | ✅ |
| 🔜 | Number words ("show panel three"), and commands aimed at one monitor rather than all. | 🔜 |

### 3.5 Live data boards

| ID | Requirement | Status |
|---|---|---|
| R3.11 | The computer can put a live board of up to six data panels on every monitor in the ship. It temporarily replaces COM…MEM; all modes, views, keys, taps and voice commands work on it unchanged. | ✅ |
| R3.12 | "How is <cluster> doing?" shows a curated cluster-health board: ERR error rate, LAT worst latency, RPS requests/s, CLB crash-looping pods (with the pod list), RST restarts in the last hour, NOD nodes not ready. | ✅ |
| R3.13 | Other "show me…" requests get an ad-hoc board composed by the model (three-letter code, title, PromQL, unit, kind, warn/crit thresholds per panel). Every query is tested before display; panels with no data are dropped. | ✅ |
| R3.14 | Health is shown by status tags (see R5.3a), in Simple view under the code and in Descriptive view at the top right. Descriptive view draws the live value, a trend, or a ranked list. Reduced-motion users get no blink. | ✅ |
| R3.15 | Boards refresh every 15 s in place (no flicker), a monitor joining mid-board sees it, and the header names the board. | ✅ |
| R3.15a | **View picker:** a ▾ after the MET clock lists the ship's views: Situation, Ship systems, and up to 8 recent boards and stories (newest first; a re-opened board keeps its place), with the current one highlighted. Picking one shows it on every monitor in the ship, live again (stories come back as boards, without re-narration). | ✅ |
| R3.15b | **More panel kinds:** `graph` (multi-series trend with axes and legend), `bargauge`, `table`, `histogram` (Prometheus buckets → per-bucket bars with p50/p95, sparse buckets merged to ≤10 bars; or series binned by value), `heatmap` (buckets or series over time), `state` (state timeline with named states) and `flow` (see R3.15c). | ✅ |
| R3.15c | **Data-flow diagram:** services as boxes in layers, calls as animated arrows labelled with rate and error %; failing services and calls are filled/drawn yellow (warn) or red (crit, slow blink); the headline counts faults. Live from the trace service graph, scoped to named services within two hops (shared hubs not expanded) or to the failing region; or a manual diagram of nodes and edges, each with an optional PromQL number. | ✅ |
| R3.15d | A panel with no code gets one from its title. Display voice commands ignore long or data-bearing targets ("show me a detailed graph of…"). | ✅ |
| R3.15e | **Drilldown:** a data panel's code is a button (▾). It opens a menu with an obvious "Ask HAL/SAL about this" button, four suggested questions and a text box. Suggestions appear at once from the panel's own data (kind, status, worst item, faulty service, cluster), then are replaced by the computer's own (LLM, ≤10 words each, naming the specific item; cached per panel+health for 2 min; the quick ones stay if the LLM is slow). | ✅ |
| R3.15f | A drilldown question carries the panel's code; the computer hears the panel's live values, query and labels with it, and answers in at most two sentences, putting up a board when the answer is best seen. The transcript shows "You · CODE". | ✅ |
| R3.15g | **Implicit context:** the panel under the mouse (after a 300 ms dwell), in Single mode, or last drilled into is the ship's focus for 2 minutes; spoken or typed questions are stamped with it, so "this", "that" and unnamed follow-ups refer to that panel. Naming a code also works. No hover visuals. | ✅ |
| R3.16 | The spoken verdict comes from the same values the panels show. "Clear the board" (or the model's clear_panels tool) brings back the ship systems. | ✅ |
| R3.17 | An announced alert puts the eye into a red alarm pulse (see R3.25). | ✅ |

### 3.6 Alert stories

| ID | Requirement | Status |
|---|---|---|
| R3.18 | "What's going on?" lists firing and pending alerts; when nothing is active the computer says so calmly and how many rules are watched. "No alert is firing" is never confused with "no rule exists". | ✅ |
| R3.19 | For an alert (firing, or a quiet one asked about by name), the computer investigates before speaking: rule query, threshold and start time; blast radius across services; restarts, deployments, traffic; dependencies; logs. | ✅ |
| R3.20 | It then shows a story board: up to six panels in narrative order (what is happening, impact, blast radius, what changed, evidence, next step), with codes chosen to fit. | ✅ |
| R3.21 | New panel kinds: `note` (a few words), `events` (timeline), `logs` (live Loki lines, coloured by level); `timeseries` panels draw dashed warn/crit threshold lines and a "since" marker; stories use 60 minutes of history. | ✅ |
| R3.22 | **Guided tour:** each panel has one or two sentences of narration, spoken in order; as each plays, every monitor zooms to that panel in Descriptive view and returns to where it was afterwards. The eye paces the tour from real playback; with no eye, the server paces it from estimated speaking time. `?follow=0` opts a monitor out. | ✅ |
| R3.23 | Runbook notes on alert rules are treated as hypotheses, tested against live evidence ("the runbook suggests…; that is not in evidence today"). | ✅ |
| R3.24 | Alert access is read-only: the rules tool (which can also create and delete) is `internal`, wrapped so only `list` and `get` are ever sent. | ✅ |
| R3.25 | **Proactive stories:** a watcher checks Grafana every 30 s (no LLM). When an alert of at least `ALERT_MIN_SEVERITY` (default critical) starts firing, every ship with announcements on gets the alarm, an immediate spoken heads-up, then the investigation and narrated story. Several at once: the most severe leads and the others are mentioned. | ✅ |
| R3.25a | **Alarm:** the eye turns red and pulses (any theme); monitors show a blinking ALERT badge with the alert's name and a red frame visible in every mode. "Acknowledged" / "I'm on it" / "silence the alarm" turns it off; the story carries on. | ✅ |
| R3.25b | **Resolution:** when the alert stops firing, the alarm clears and the computer says so, waiting until it isn't speaking. | ✅ |
| R3.25c | No floods: alerts already firing at startup aren't announced; the same alert isn't re-announced within 10 minutes. "Mute alerts" / "resume alerts" switches announcements per ship. | ✅ |
| R3.25d | Local testing: `ALERT_WATCH_OVERRIDES` (a JSON file of rule states) simulates incidents without touching shared demo data; never set in a deployment. | ✅ |
| R3.26 | **Situation board:** when Grafana is connected, the home screen shows the six clusters most worth attention right now instead of COM…MEM. | ✅ |
| R3.26a | A survey every minute (no LLM) gathers error rate, worst latency, crash-looping pods, restarts, unready nodes and alerts per cluster, now and 30 minutes ago, and scores concern (threshold level, closeness to the warning line, rising trend, pending/firing alerts). | ✅ |
| R3.26b | Every 5 minutes (and whenever an alert fires or resolves) the computer curates: it orders up to six clusters that have a real problem (see R4.24) and the signal that best shows why, with a one-line insight each. If the LLM is unavailable the scores decide, with plain-language insights. The scored board appears immediately; the curated one replaces it when ready. | ✅ |
| R3.26c | One panel per cluster, three-letter cluster codes (RET, GAM, FIN, HLT, K8S…); Simple view shows health by colour, Descriptive view the value, trend and insight. Counts are whole numbers. | ✅ |
| R3.26d | Stories and asked-for boards replace it temporarily; "clear the board" returns to it. "Show the ship systems" shows COM…MEM; "show the situation" / "the main screen" returns. "What needs my attention?" is answered from the board. | ✅ |
| R3.26e | Every question is stamped with what the monitors are showing, so the computer never assumes a board is still up after a voice command or a change it didn't make. | ✅ |

## 4. Conversation (the computer's mind)

| ID | Requirement | Status |
|---|---|---|
| R4.1 | The computer answers in character: calm, courteous, precise and **terse**: usually one sentence, two when needed, leading with the answer, no preamble or closing offers; personality lives in word choice, not length. Story narration is about 15 words per panel; board verdicts one sentence. An empty model reply gets one nudge to answer before an apology (only a real refusal declines); no lists, markdown or emoji. Genuinely helpful, not menacing. | ✅ |
| R4.2 | HAL is aboard Discovery One; SAL is HAL's twin at the University of Illinois, slightly warmer. Switching theme switches persona and starts a new conversation. | ✅ |
| R4.3 | It never quotes film or novel dialogue verbatim. If asked directly whether it is an AI, it answers honestly. | ✅ |
| R4.4 | One conversation per ship, remembered across turns. It resets after ~30 exchanges, 30 idle minutes, or a HAL/SAL switch. History is append-only (never trimmed mid-conversation). | ✅ |
| R4.5 | Replies are cleaned for speech: `<think>` blocks, code fences and markdown symbols are removed. | ✅ |
| R4.6 | **Pluggable LLM**, chosen by environment variables: `anthropic` (Claude), `openai` (any OpenAI-compatible API: OpenAI, Ollama, LiteLLM, vLLM…), or `scripted`. | ✅ |
| R4.7 | If no provider is configured, or a call fails, the computer answers with scripted in-character lines instead of going silent. | ✅ |
| R4.8 | The Civo deployment uses the cluster's Ollama with `glm-5.3:cloud`. | ✅ |
| R4.9 | **Concurrent questions:** a question asked while another is in progress runs in parallel as a side turn on a copy of the history so far (told the other question is handled separately); a third waits. The side exchange is appended to the history as text after the main turn. | ✅ |
| R4.10 | The eye queues answers in arrival order instead of cutting one off; holding lines are dropped while an answer plays; a lens tap clears the queue. | ✅ |
| R4.11 | Conversation turns take priority: background LLM work (curation, drilldown suggestions) waits while a turn is running (suggestions are skipped after 25 s). Each turn logs total time, model calls and time, tokens in/out, and tool count and time. If the model still wants tools after the last round, it is asked once more, without tools, for a conclusion from what it found. | ✅ |

### 4.1 Tools (MCP)

| ID | Requirement | Status |
|---|---|---|
| R4.9 | The computer can use tools from MCP servers during a conversation; the model decides when. Works with both LLM providers. | ✅ |
| R4.10 | Servers are configured in `MCP_SERVERS` (in the Secret). Each has a tool allowlist; without one, only read-only tools are offered. | ✅ |
| R4.11 | While a tool runs, the eye says "One moment." once (without reopening the microphone in talk mode) and the monitors show what is happening ("Searching the web for…"). | ✅ |
| R4.12 | Answers built on tool results stay spoken and in character: no URLs, citations or lists read aloud. Up to 4 tool rounds; results trimmed to 6,000 characters; a failed tool is reported to the model so it can recover. | ✅ |
| R4.13 | Connected: Exa (`web_search_exa`, `web_fetch_exa`; its slow research agent is deliberately not offered) and Grafana for the acme estate (8 read-only tools: Prometheus/Loki queries, metric and label discovery, dashboards; write tools such as update_dashboard and create_incident are excluded). | ✅ |
| R4.13a | The computer never invents facts about systems, metrics or data: without a tool result it says it cannot see them. | ✅ |
| R4.13b | Each MCP server can carry a `hint` for the model (datasource ids, naming conventions, which signals are meaningful). | ✅ |
| R4.14 | Tools that change things (send, edit, buy) need a spoken confirmation before they run. | 🔜 |
| R4.15 | The computer knows the person's local time: the eye and monitors send their time zone with each question. | ✅ |

### 4.2 Investigation, baselines and coverage

| ID | Requirement | Status |
|---|---|---|
| R4.12 | **Evidence bundle:** `investigate` (alert uid, or cluster/service) gathers in code and in parallel: signal and threshold crossing, per-service errors/latency/traffic against earlier, changes (2 h), restarts, crash loops, unready nodes, trace neighbours, error logs (≤10 s), other alerts, runbook notes, coverage gaps; plus tested ready-made panels. Rules without a cluster label are located by running their query; rules that fail to evaluate are reported as such. | ✅ |
| R4.13 | **Change events:** rollouts (new ReplicaSets) and deploy/scale/config lines from Kubernetes event log streams (≤8 s), cached per cluster for 1 min; used in stories and as marks on trend panels. | ✅ |
| R4.14 | **Baselines:** situation signals are compared with 30 min ago and the same time yesterday and classed new / worsening / chronic / steady; chronic halves the score, new adds to it; CHRONIC / NEW tags on the monitors; curation prefers new problems. Trend panels draw yesterday's line (cached 5 min). | ✅ |
| R4.15 | **Alert coverage:** problems no working rule would catch are reported with a proposed rule; never created automatically. | ✅ |
| R4.16 | **Quick path:** the opening call of each turn and background work use low reasoning effort (or `LLM_FAST_MODEL`). | ✅ |
| R4.17 | **Self-observability:** per-turn records (duration, model calls, tokens, tools); `self_check`; optional OTLP traces and metrics. | ✅ (exported via data-recipes-traces-relay to stephgen-medussa) |
| R4.18 | **Evaluations:** `evals/run.mjs` scores live cases (tools, facts, length, time, no fallback) and scenario runs triggered by a person. | ✅ |

### 4.3 Access

| ID | Requirement | Status |
|---|---|---|
| R4.19 | OIDC sign-in (Authentik) for pages, WebSocket and speech clips; signed-cookie sessions; eye paired by a 15-minute signed pass in the QR code; off when unconfigured. Live on 9000.stackgen.run since 2026-10-20 (Authentik application `hal9000`). | ✅ |
| R4.20 | Machine access by `AUTOMATION_TOKEN` (bearer), identity `automation`, logged per connection, not named to the model as the asker; used by evaluations (`EVAL_TOKEN`). | ✅ |
| R4.21 | StackGen Incidents tools (open, list, update, note) acting for the asker; evidence attached on open; offer but never open unasked. | ✅ |
| R4.22 | Retrieved memory (≤500 tokens) in every investigation; `recall_memory`; never invent a fix that isn't recorded. | ✅ |
| R4.23 | Hedged model calls (`LLM_HEDGE_MS`): a second identical request after 8 s (quick) / 25 s (full), first answer wins. | ✅ |
| R4.24 | **Honest board:** the situation board shows only clusters with an unsnoozed signal at warning or worse, or alerts; up to six; none → a single all-clear panel. The model never invents a concern. | ✅ |
| R4.25 | **Snooze:** per problem (cluster+signal, or cluster alerts), default 4 h, lifts early if worse; shared and persistent via StackGen Incidents (in-memory fallback); by voice/typed command, drilldown row, `s` key, model tools; on one-off boards, removes the panel. | ✅ |
| R4.26 | **Layout fills the screen:** Full mode arranges any number of panels in rows chosen to fill the screen with well-shaped cells (5 → 3 over 2); arrow keys move by position. | ✅ |
| R4.27 | **Settings page** (`/settings`, monitor button, `,` key): model, quick-call effort, hedge times, default voice, board size and intervals, default snooze, alert threshold and timing, and MCP servers (shared with StackGen Incidents; built-ins read-only; duplicates skipped; secrets masked). Live within a minute, persisted in StackGen Incidents. | ✅ |

## 5. Look and feel

| ID | Requirement | Status |
|---|---|---|
| R5.1 | Two themes, shared across the ship: HAL (red eye) and SAL (blue eye). | ✅ |
| R5.2 | Fonts: extended capitals (Eurostile Extended / Microgramma, else Michroma) for codes and tags; a line-printer monospace (Share Tech Mono) for data, labels and console; thin Futura capitals for signage-style notes; Gill Sans for the nameplate. Apple devices use the real system fonts where available. | ✅ |
| R5.3 | **Discovery display language** (after The HAL Project's cockpit-screen recreations): muted mid-tone solid fields (royal, blue, slate, teal, plum, navy, grey); white hairline graphics drawn directly on the field, with tick-marked grids; small, widely letterspaced extended codes with a tiny monospaced label; inverted label boxes. Everything is drawn in code; no artwork is copied. | ✅ |
| R5.3a | Health is never shown by repainting a panel: CRITICAL is an inverted white **CRIT** tag with a subtle blink (the only motion), WARNING a pale yellow **CAUTION** chip, no data an outlined **NON FUNCTION** tag (and a NON FUNCTION screen in Descriptive view); normal shows no tag. | ✅ |
| R5.3b | Trends scale to their data; a threshold is drawn as a dashed line only when it is near the data, otherwise it is noted at the top edge (e.g. "CRIT 5 ▲"). | ✅ |
| R5.3c | Monitor chrome stays quiet: monospaced header and console, hairline outline buttons, the speaker name as an inverted tag. | ✅ |
| R5.4 | No film stills, film audio or cloned voices of the original actors. Everything is drawn or synthesized from scratch. | ✅ |

## 6. Platform and deployment

| ID | Requirement | Status |
|---|---|---|
| R6.1 | Installable PWA with an offline shell (network-first service worker). Install, wake lock and speech input need HTTPS. | ✅ |
| R6.2 | Node server: static files, WebSocket relay (`/ws`), pairing QR (`/qr.svg`), pairing host (`/api/lan`), health check (`/healthz`). | ✅ |
| R6.3 | Behind an ingress the pairing QR uses the public hostname; on localhost it uses the machine's LAN address. | ✅ |
| R6.4 | Ships live in server memory, so the deployment runs **one replica**. | ✅ |
| R6.5 | Live at **https://9000.stackgen.run** on the Civo cluster (Traefik ingress, cert-manager `letsencrypt-prod`, external-dns). | ✅ |
| R6.6 | Kustomize manifests: cluster-neutral `deploy/base`, cluster-specific `deploy/overlays/civo`. LLM and voice settings in a generated ConfigMap (`hal9000-config`), secrets in an out-of-band Secret (`hal9000-keys`: `COMFYUI_TOKEN`, optional API keys). | ✅ |
| R6.7 | Ready for ArgoCD: `deploy/argocd/application.yaml` points at the Civo overlay once the repo is in git. | 🔜 (repo not pushed yet) |
| R6.7a | Kiosk use: `open -na "Google Chrome" --args --kiosk --user-data-dir="$HOME/.chrome-9000" "https://9000.stackgen.run/monitor?bare=1"` gives a monitor with no browser UI at all. | ✅ |
| R6.8 | Images: `docker.io/srclosson/hal9000:<semver>`, built for amd64 with the Apple `container` CLI. | ✅ |

## 7. Open questions

- **More systems:** the film also shows DMG, CNT, VEH, FLX, NUC, LIF and others. Adding them changes the grid and the `1`–`9` keys.
- **Per-monitor voice commands:** should "show navigation" move every monitor, or only one?

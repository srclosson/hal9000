# 9000 Series

HAL/SAL 9000 as a PWA. Full behaviour (modes, views, hotkeys, voice commands) is specified in [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md). A phone is the **eye**. Computers and tablets are **monitors**. They stay in sync through a small Node WebSocket server.

```
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm start
```

## Using it
1. On the computer, open http://localhost:9000/monitor. It creates a ship (a 4-letter room code) and shows a QR code.
2. Scan the QR with the phone and tap to activate. The phone becomes the eye and speaks the replies.
3. For more monitors, use "Copy link for another monitor". Each monitor keeps its own mode and view.

Talk to the computer by tapping the lens on the phone (needs HTTPS), or type on a monitor (`/`).
**Double-tap the lens for talk mode:** hands-free conversation where the eye listens again after every reply.
A chime and a faintly glowing grille show it's on; double-tap again (or say "that will be all") to end it.
It also ends by itself after 5 minutes of silence.
HAL/SAL switches the red or blue theme on every screen. Alert pulses the eye.

### Modes and views
A monitor shows either all the systems (**Full** mode) or one system filling the screen (**Single** mode),
each as just its three letters (**Simple** view) or as an animated graphic (**Descriptive** view).
Systems, in order: 1 COM, 2 NAV, 3 GDE, 4 HIB, 5 ATM, 6 MEM, 7 EYE, 8 JUP (eight systems lay out 4 × 2).

- **EYE** is what the 9000 sees: the phone's front camera through a fisheye, with a blinking LIVE mark. The eye only
  turns its camera on while some monitor shows this panel in Descriptive view (and the tab is visible), sends about
  five small JPEG frames a second through the server, which passes them straight to those monitors and stores
  nothing; the lens brightens slightly while it is looking. The phone asks for camera permission the first time
  (after the activation tap on browsers that need one). Say **"show me what you see"** or "show the camera".
- **JUP** is Jupiter becoming Lucifer, after *2010*: a 90-second loop in which monoliths double across the planet into
  a black spot that swallows its bands, Jupiter collapses, flashes, and a small new sun burns in its place, with Europa
  orbiting throughout. Drawn in code, no film footage. Say **"show Jupiter"** or "show Lucifer".
- Both open in Descriptive view when asked for by voice, and switch from a data board back to the ship systems.

### Hotkeys
The 9000 had no mouse, so everything works from the keyboard. Hotkeys pause while you type in the text box.

| Key | Full mode | Single mode |
|---|---|---|
| `1`–`6` | Open that system | Switch to that system |
| `0` | — | Back to Full |
| `q` / `x` | `x` closes the pairing screen | Back to Full |
| `z` | Switch every panel Simple ↔ Descriptive | Back to Full |
| `←` `→` | Move the selection in reading order (wraps) | Previous / next system (wraps) |
| `↑` `↓` | Move the selection up / down its column (wraps) | Previous / next system (wraps) |
| `Enter` / `Space` | Open the selected system | Switch Simple ↔ Descriptive |
| `/` | Type to the computer (shows the console in bare mode) | — |
| `h` | Bare: hide / show the header and console | — |
| `t` | Chat: open / close the conversation drawer (also: click or drag the transcript line up; Esc closes) | — |
| `a` | Acknowledge the alarm (also: the Acknowledge button, or say "acknowledged" / "I've got it") | Same |
| `i` | Open / close the incidents menu | — |
| `m` | Open / close the 9000 logo menu | Same |
| `n` | Open / close the metric browser (drag a metric onto a panel; Esc closes) | Same |
| `p` | Open / close the plan card (a fix waiting for approval, or the latest) | Same |
| `f` | Full screen on / off (no browser UI) | Full screen on / off |
| `[` / `]` | Previous / next view (situation, ship systems, recent boards and stories) | Same |
| `v` | Open / close the view picker | — |
| `d` | Drill down: suggested questions about the selected (or open) data panel; then `1`–`4` asks one, Enter asks generally, typing asks your own, Esc/`q`/`x`/`d` closes | Same |

In the text box, `Enter` sends; `Enter` on an empty box leaves it and returns to hotkeys.
`Esc` is left to the browser, which uses it to exit full screen. On the eye, `f` toggles full screen too.
The pointer hides after 3 seconds without movement.

### View picker
The ▾ after the MET clock lists every view the ship can show: **Situation**, **Ship systems**, and each board or
story shown recently (up to 8), with the current one highlighted. Picking one shows it on every monitor in the
ship, live again; `[` and `]` step back and forward through the same list.

### Touch
| Where | Tap | Result |
|---|---|---|
| Full | The 9000 logo | Its menu: HAL or SAL, Simple ↔ Descriptive, conversation, full screen, hide header and console, connect the eye, settings |
| Full | A panel | Open it in Single mode |
| Single | Anywhere | Switch Simple ↔ Descriptive (use a key or your voice to go back) |

### Voice (or typed) commands
Start with a display verb, optionally after "HAL," or "SAL,". Every monitor in the ship follows, and the computer confirms aloud.

| Say | Result |
|---|---|
| "Return to the overview", "go back", "show all systems" | Full mode |
| "Show navigation", "open hibernation", "zoom in on memory" | Single mode on that system |
| "Switch to descriptive" / "switch to simple" | Change view |
| "Show me the atmosphere in descriptive view" | Both at once |
| "That will be all", "goodbye", "stop listening" | Talk mode off |
| "Let's talk", "start talk mode" | Talk mode on |
| "Clear the board", "dismiss the panels" | Remove a live data board (back to the situation board) |
| "Show the ship systems" / "show the situation" | COM…MEM instead of the situation board / back again |
| "Acknowledged" / "mute alerts" / "resume alerts" | Silence an alarm / stop or resume alert announcements |

Anything else ("What is navigation?") is conversation and goes to the LLM.

### URL options
A monitor reopens as it was left: `?room=ABCD&single=NAV&view=descriptive&bare=1`.
For a dedicated screen with no browser UI at all:

```bash
open -na "Google Chrome" --args --kiosk --user-data-dir="$HOME/.chrome-9000" "https://9000.stackgen.run/monitor?bare=1"
```

## LLM providers
Chosen on the settings page (MIND), without a redeploy; the environment variables are the defaults (`llm/index.js`):

| Provider | Settings | Defaults from |
|---|---|---|
| `openai-compatible` | model, endpoint, API key | `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` (Ollama, vLLM, LiteLLM, OpenRouter…) |
| `openai` | model, API key | `OPENAI_MODEL`, `OPENAI_API_KEY` (api.openai.com; sends `max_completion_tokens`) |
| `anthropic` | model, effort, API key | `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `LLM_EFFORT` (default `low`), `ANTHROPIC_API_KEY` |

Before settings, `LLM_PROVIDER=openai` meant any OpenAI-style endpoint, so it maps to `openai-compatible` unless
`LLM_BASE_URL` is api.openai.com. `LLM_PROVIDER=scripted` still forces the canned lines (tests); they are also the
fallback whenever a provider fails or isn't configured.

The model field suggests the saved provider's own models (its `/models`, or Anthropic's Models API) and takes any id.
**API keys are write-only**: the page never receives them, only whether one is set; leaving a key blank keeps it,
Clear removes it, and "Reset to defaults" keeps keys. They are stored in the hal9000 settings document in StackGen
Incidents (served only to its API token, like MCP server headers). Changing the provider, model, endpoint or key
rebuilds the model on every ship within a minute and starts every conversation afresh (histories are in the old
provider's format). Claude runs at one effort for every call, so the prompt cache stays warm.

**Two questions at once.** Ask something while the 9000 is still working on an earlier question (type while you
talk, or ask again) and it answers both: the new question runs alongside, from the conversation so far, and is told
the earlier one is being handled separately. A third waits its turn. The eye speaks answers one after another in the
order they're ready, never cutting one off (a tap on the lens still stops everything); "One moment." is skipped while
an answer is playing. Both exchanges land in the conversation history.

**Conversation first.** Background model work (situation curation, drilldown suggestions) waits while anyone is in a
conversation turn; drilldown suggestions that would wait more than 25 s are skipped (the quick ones stay).

**Timing.** Every turn logs `TURN <s> answered: <n> model calls <s> (<tokens in, out>), <n> tools <s> — "<question>"`.
Slow answers are almost always model time, not tools: on Ollama Cloud an occasional call takes up to a minute even for
a one-line reply, while the same prompt a moment later takes under a second; a long investigation makes many calls.

To add another provider, drop a module in `llm/` exposing `create(config)` → `{ name, send(system, messages, tools), toolResults(calls, results), describeError(err) }` and register it in `llm/index.js`. `send` returns `{ reply, message }`, or `{ toolCalls, message }` when the model wants tools.

## Tools (MCP)
The 9000 can use tools from MCP servers mid-conversation. The model decides when (current facts, news,
weather, specific details), the eye says "One moment." and the monitor shows what's happening ("Searching the web for…").
Servers are managed on the settings page (`/settings`, TOOLS·MCP), stored in StackGen Incidents and shared with it;
the 9000 picks up changes within a minute, and the situation board and alert watch start as soon as Grafana's tools
arrive. `MCP_SERVERS` (in the `hal9000-keys` Secret) can still add built-in servers for local runs; on Civo it is unset.

```
MCP_SERVERS=[{"name":"exa","url":"https://mcp.exa.ai/mcp?exaApiKey=...","tools":["web_search_exa","web_fetch_exa"]}]
```

`tools` is an allowlist; without one, only tools the server marks read-only are offered. `internal` lists tools
only the 9000's own code may call (wrapped so only safe operations are used). Optional `headers`
(e.g. `{"Authorization":"Bearer ..."}`) are sent with every request, and an optional `hint` tells the model how to
use that server (datasource ids, cluster names, which metrics are meaningful). Up to 4 tool rounds per question; results are
trimmed to 6,000 characters. Works with both LLM providers. Currently configured in settings include **exa-search** (web search, page reading), **mcp-grafana** for the acme
demo estate (`mcp-grafana-acme.stackgen.run`; internal: `alerting_manage_rules`), **k8s** (the estate's `kubernetes` cluster) and **aiden-for-sre**.

**Tools load as they are needed** (`brain.js`). With under 40 MCP tools all are offered. With more (the estate's
servers offer over two hundred) a conversation starts with the 9000's own tools plus the MCP tools its instructions
and the servers' notes name (`query_prometheus`, `pods_log`…), and `find_tools`: the model describes what it needs
("pod logs", "search the web") or gives names, and the best matches (plurals folded, filler ignored, a tool's name
weighing more than its description, tools that change things only when the need is to change something) load from
its next step for the rest of the conversation. Smaller requests are faster and cheaper, and OpenAI's limit of 128
tools per request is never reached; past any provider's limit, the most-needed tools are kept and the rest logged.
An MCP tool named like one of the 9000's own (a server's `list_alerts`) is never offered: the 9000's wins.

**What the 9000 can do comes from the servers, not from prose.** Every turn, the persona gets a live "Your access"
paragraph built from the connected servers' own tool lists and the settings (`mcp.access()`): per server, how many
tools only read, which can change things directly, which only through an approved plan, and which changing tools are
switched off. A tool only reads when its server marks it read-only or its name says so (`list_`, `get_`, `search_`…;
many servers mark nothing, and Aiden marks every tool destructive). The paragraph overrides anything a hint, memory or
earlier conversation says about access, so hints should describe how to use a server, never what it may do.

## Situation board (the home screen)
When Grafana is connected, the monitors' home screen is no longer the fixed COM…MEM: it's the **situation board**,
the six clusters most worth attention right now. `home/index.js` surveys the estate every minute (error rate, worst
latency, crash-looping pods, restarts, unready nodes and pending/firing alerts per cluster, plus 30-minute trends),
scores each cluster's concern, and every 5 minutes the 9000 picks the six panels and writes a one-line insight for
each ("13 nodes not ready; latency down 40% suggests possible traffic loss"). Without an LLM the scores decide.

- One panel per cluster, coded RET, GAM, FIN, HLT, K8S…, showing its most telling signal; Simple view shows health
  by colour, Descriptive view the live value, trend and insight.
- It recomposes straight away when an alert fires or resolves. Stories and asked-for boards replace it temporarily;
  **"clear the board"** comes back to it.
- **"Show the ship systems"** brings back COM…MEM; **"show the situation"** / "the main screen" returns.
- Ask "what needs my attention?" and the 9000 explains the board (`get_situation`).

## Live data boards
Ask "how is the retail cluster doing?" and the 9000 puts a live six-panel board on every monitor while it answers:
ERR (error rate), LAT (worst latency), RPS (traffic), CLB (crash-looping pods), RST (restarts, last hour), NOD (nodes not
ready). Other "show me…" requests get an ad-hoc board of up to six panels the model composes from PromQL (each query is
tested first; empty panels are dropped). Boards refresh every 15 s and work with all the usual keys, taps and views:

- **Simple** view: the letters with a status tag: an inverted **CRIT** box (subtle blink), a yellow **CAUTION** chip, or **NON FUNCTION**.
- **Descriptive** view: the live value, a 30-minute trend, or a ranked list (e.g. which pods are crash-looping).
- Say **"clear the board"** / **"show the ship systems"** to bring back COM…MEM.

Panel kinds (the 9000 picks one per panel; ask by name, e.g. "show me a heatmap of API server latency"):

| Kind | Shows |
|---|---|
| `stat` | One live number |
| `timeseries` | Number plus a trend, with warn/crit lines and a "since" marker |
| `graph` | Detailed trend: up to five series with axes, time scale and a legend |
| `list` | One ranked row per series |
| `bargauge` | Segmented gauge per series against a scale, warn/crit marked |
| `table` | Label columns plus the value, worst first, with fault chips |
| `histogram` | A distribution as bars: Prometheus `_bucket` histograms (headline p95, with p50) or many series binned by value |
| `heatmap` | A distribution over time: histogram buckets per time step, or one row per series |
| `state` | State timeline: one band per series, coloured by state (e.g. up/down) |
| `flow` | Data-flow diagram: services as boxes, calls as moving arrows with rate and error %, faults lit yellow/red. Live from the trace service graph (`traces_service_graph_request_total` / `_failed_total`), centred on named services (two hops; shared hubs like redis aren't expanded) or, with none named, on the failing part; or nodes and edges the 9000 writes itself, each with an optional query |
| `trace` | One request as a waterfall: a bar per span, nested by caller, failing spans red, the critical path bright, and a CRITICAL PATH line saying where the time goes by service. From Jaeger (see Traces below), picked once and pinned by id: the slowest recent trace through a service, a failing one, one that also visits another service, or a given id |
| `logs`, `note`, `events` | Live Loki lines; a few words; a timeline |

**Drilldown.** Every data panel's code (with a small ▾) is a button. Click it (or press `d`) for an **Ask SAL/HAL about
this** button, four likely questions, and a box for your own. The first questions come straight from the panel's data
(the faulty service, the top item, the alerting cluster); a few seconds later the 9000 replaces them with sharper ones
of its own (cached per panel and health for two minutes). A question asked this way carries the panel's code, its live
values and its query, so the answer is about that data, and the transcript shows `You · ERR`.

On a `flow` diagram the boxes and arrows are clickable too: a service box opens questions about that service ("Show the
slowest trace through payment-gateway", "Why is it failing?"), an arrow about that call ("Show a failing call from
checkout-api to payment-gateway"). Trace questions put a `TRC` waterfall next to the flow.

**Traces.** `show_trace { service, through?, failing?, traceId? }` adds a `trace` panel to the board on screen (or opens
its own); `find_traces` lists recent slow or failing traces for the model to compare. Both read Jaeger (Grafana
datasource `TRACE_DATASOURCE`, default `jaeger`) through Grafana's `grafana_api_request` MCP tool, which is set as
*internal* on the `mcp-grafana` server in settings: the 9000's code only sends GETs to the Jaeger datasource's read
endpoints, and jq on the MCP server trims each answer. Duplicate spans (the acme Jaeger stores every span twice) are
dropped before layout.

You don't have to click: the monitor tells the 9000 which panel you're looking at (the one under your mouse after a
moment's pause, the one open in Single mode, or the last one you drilled into), for two minutes. So "why is that so
high?" spoken to the eye or typed into the console is answered about that panel; naming its code works too.

A panel without a code gets one from its title's initials. Display voice commands only apply to short targets with no
data words, so "show me a detailed graph of memory by pod" reaches the 9000 instead of switching views.

Implemented in `boards/index.js` (curated boards live there); queries go through the Grafana MCP `query_prometheus` tool.

### Panels the 9000 designs (`compose`)
The panel kinds are a vocabulary, not a menu: for each request the 9000 decides how best to show the data, and may
choose something better than what was asked (and says why). Its own designs use kind `compose`, a small visual grammar
the monitors draw in the house style (`boards/compose.js` reads the data, `displays.js` draws it). The model writes a
description, never code, so anything it can describe is safe to draw and looks like it belongs on the ship.

- **layers** (up to five), each a PromQL query with a `label`, `by` (the label naming each series), `unit`, `axis`
  (`right`: its own scale at the right, for a metric in other units, e.g. dBm beside degrees), `shift`
  (minutes back, laid over the present: 1440 = this time yesterday, 10080 = last week), `style` and `hero` (the line
  the eye goes to). Other layers show the hero's series where they have them, so yesterday's telem-api sits under today's.
- **layout** `time` (styles line, dotted, faint, area, step, bars, points), `bars` (one row per series, one bar per
  layer, e.g. every service now against last week; solid, outline, faint) or `scatter` (layer 1 on x, layer 2 on y,
  one point per series, outliers named).
- **headline** `last`, `max`, `min`, `avg`, `change` (the hero against another layer, e.g. "+1.2% VS YESTERDAY") or
  `none`; **refs** (an SLO or limit line), **spans** (a shaded outage or deploy window, times ISO or `-90m`),
  **callouts** (words pinned to the line), **y** (fix the axis), **caption** (what to notice).

**Signals together, with nuance.** Time panels draw ~240 points, each the max (or `over`: avg/min) of its step, so a
30-second spike in an hour is never sampled away. Every trend reports its **context** (peak and when, typical level,
spikes and the longest), drawn above the plot and given to the model, so a spike reads as a spike. **`events`** lays
other signals on the hero line at their times: `logs` (LogQL), `traces` (a service's failing or slow traces; a click
opens the waterfall), `profiles` (reserved for Pyroscope; until it is connected the panel says so). Each marker sits on
the line, so the ones before a rise are at its foot, and its label shows how far the line moved after it (↑0.2).
Labels take separate lanes; crowded ones are grouped (+4).

**Story cards** (`layout: "story"`, `elements`): a card that tells a data story in up to four stacked elements, each
drawn by the same code as a full panel: `trend` (a time chart with layers and events), `trace` (a waterfall),
`logs` (matching lines), `stat` (one number), `note`. Hover, markers and clicks reach the element under the pointer.

**Replay.** During a story tour, the narrated panel's trends draw themselves left to right in step with the
narration (about 0.4 s a word), events appearing as the line reaches them, behind a bright "now" cursor.

**Hover (spec 2.0: function first, design language second).** On trends, a crosshair with a dot on each line and a
tooltip plate: the time, every line's value then, and the events and changes near it. Markers, change marks and fix
strips show their full text and what clicking does. Anything shortened to "…" shows in full on hover (log lines and
labels are sent whole; the screen shortens them), as do panel titles and the footer line.

**Metric browser** (`n`, or Metrics in the 9000 logo menu). Every metric name Prometheus has, for one cluster or all,
filtered as you type (plain text or a regex), each marked counter, histogram or gauge by its name. **Drag a metric onto
a panel** that charts numbers and the 9000 is asked to work it into that panel: he decides how (rate a counter, match
the panel's labels, give it its own scale at the right) and redesigns the panel in place, then says what the two show
together. Drop it anywhere else, or click it, and he shows it on its own. The question goes into the conversation like
any other, so it is clear what was asked. (`GET /api/metrics?cluster=` serves the list, through the Grafana MCP
server's `list_prometheus_label_values`.)

`design_panel` puts one panel up, or with the code of a panel on screen redesigns it in place ("superimpose
yesterday on the VIT panel"); on the situation board, the board becomes the ship's own with that panel replaced.
Naming a panel's code in a question makes it the panel the question is about, with its queries. `show_panels` and
`show_story` take `compose` panels too.

## Alert stories
Ask "what's going on?" or about a specific alert, and the 9000 investigates before it speaks: the alert's query,
threshold and start time, the same signal across the cluster (blast radius), restarts and traffic, dependencies, and
logs. It then builds a story board of up to six panels in narrative order (what is happening, impact, blast radius,
what changed, evidence, next step) and **narrates it as a guided tour**: as each sentence plays, every monitor zooms to
the panel it's about, then returns to where it was. Add `?follow=0` to a monitor's URL to keep it out of tours.

- Story panels can be `timeseries` (with dashed warn/crit threshold lines and a "since" marker), `list`, `stat`,
  `logs` (live Loki lines), `note` (a few words) or `events` (a timeline).
- Alerts come from Grafana via `list_alerts` / `get_alert` (`alerts/index.js`), a read-only wrapper over the
  `alerting_manage_rules` MCP tool, which is configured as `internal` (never offered to the model) because it can
  also create and delete rules.
- Rule write-ups are treated as runbook notes: the 9000 says "the runbook suggests…" and checks them against live data.
- Tool calls are logged on the server (`TOOL name args`).

### Speaking up unprompted
`alerts/watch.js` checks Grafana every 30 s (no LLM involved). When an alert **starts** firing, every ship with
announcements on gets:
1. the alarm: the eye turns red and pulses (even in SAL's blue theme), monitors show a blinking **ALERT** badge and a
   red frame;
2. an immediate heads-up: "Excuse me. The Checkout API High Error Rate alert has just started firing in the retail
   cluster. I am looking into it now.";
3. the investigation and narrated story tour, as if you had asked.

When it **resolves**, the alarm clears and the 9000 says so, waiting until it isn't mid-sentence. Alerts already
firing when the server starts aren't announced, and the same alert isn't re-announced within 10 minutes.

| Say | Result |
|---|---|
| "Acknowledged", "I'm on it", "silence the alarm" | Alarm off (the story carries on) |
| "Mute alerts", "stop announcing alerts", "quiet mode" | No unprompted announcements for this ship |
| "Resume alerts", "turn on alert announcements" | Announcements back on |

Settings: `ALERT_WATCH` (on/off), `ALERT_WATCH_SECONDS` (30), `ALERT_MIN_SEVERITY` (`critical`; or `warning`).
For local testing without touching shared demo data, `ALERT_WATCH_OVERRIDES` names a JSON file
(`{"<rule uid>": "firing"}`) applied to every alert read; never set it in a deployment.

## Fixes, not just problems
Every situation card carries its most likely fix and what it takes, in a strip along the bottom:

| Effort | Meaning |
|---|---|
| **AUTO** (white) | a tool set to "Ask first" can do it: one approval runs it |
| **QUICK** (yellow) | a known small change, minutes of someone's time |
| **PROJECT** (outlined) | real engineering or many steps |
| **INVESTIGATE** (dim) | nothing points to a cause yet; the fix is the one most telling check |

They come from the same curation call that ranks the board, run in full reasoning every few minutes, which now gets,
per cluster: **what is behind each signal** (the worst three services by errors or latency, the crash-looping
containers with their restarts, the nodes not ready: `detail` queries in `home/index.js`), **memory** searched with
those names (score ≥ 0.5, so "hubble-relay crash-looping" finds the expired certificate HAL stored earlier), Aiden's
**runbooks** (`aiden__search_runbooks`, when connected), and the **tools a plan may run**. The model gives the single
likeliest fix even when it is not yet confirmed, names the service, pod or node, says what it rests on (memory,
runbook, signals), and only says "investigate" when nothing points to a cause; AUTO is only allowed when an Ask-first
tool exists. Clicking the strip asks the 9000 ("Fix: …"): it confirms the fix with a quick check or two, proposes a
plan when a tool can do it, otherwise says exactly what to do and who would do it, and offers an incident.
`get_situation` and the monitors line include each card's fix, so "what should I do about the board?" leads with
fixes. `DEBUG_FIXES=1` logs the evidence per cluster.

## Snoozing, and an honest board
**The situation board shows only real problems**: a cluster earns a panel with a signal at warning or worse, or
alerts firing or pending, that nobody has snoozed; up to six, most important first. Calm clusters never fill space.
When nothing qualifies, one panel says so: "Nothing needs attention" (or "Nothing new needs attention. N known issues
snoozed"). The 9000 is told the same and never invents a concern.

**Snooze** a known irritant so something else can take its place:

| How | |
|---|---|
| Voice or typed | "snooze gaming for two hours", "snooze this" (the panel you're looking at), "hide GAM until tomorrow", "dismiss the healthtech panel", "snooze the kubernetes alerts for a day"; "unsnooze gaming", "bring gaming back", "unsnooze everything" |
| Drilldown menu | the Snooze row on a panel's menu: 1 hour, 4 hours, 1 day |
| Keyboard | `s` snoozes the selected (or open) panel for 4 hours |
| In conversation | the model's `snooze_problem` / `unsnooze_problem` tools |

A snooze covers one problem: a cluster's signal (or, for a cluster shown only for its alerts, its alerts). It
lasts 4 hours by default, and lifts early if the problem gets worse than when it was snoozed. Snoozes live in StackGen
Incidents (`/api/snoozes`), so every ship shares them and they survive restarts, with who and why; the 9000 keeps an
in-memory copy if that service is unreachable. On a one-off data board, "snooze" or "dismiss" removes that panel; an
empty board returns to the situation board. `get_situation` lists what is snoozed.

**Screen space**: in Full mode panels are laid out in rows that always fill the screen (`layoutRows`): for each
possible number of rows, panels are spread with the extra ones in earlier rows, and the arrangement whose cells come
closest to a comfortable shape wins. On a 16:10 screen: 2 side by side, 3 → 2 over 1, 4 → 2×2, 5 → 3 over 2, 6 → 3×3
rows of 3, 7 → 4 over 3, 8 → 4×2; portrait screens stack. Arrow keys move by position (up/down goes to the nearest
panel in the next row).

## Investigations: evidence first, then judgement
Stories no longer cost a dozen model round trips. One tool, `investigate` (`evidence/index.js`), takes an alert uid
(or a cluster and service) and gathers in parallel, in code, in a few seconds:

- the alerting signal over the last hour and when it crossed its threshold;
- every service's errors and latency against 30 minutes ago and traffic against an hour ago, flagging what moved;
- rollouts and config changes in the last 2 hours (`changes/index.js`: new ReplicaSets from kube-state-metrics, and
  deploy/scale/config lines from the Kubernetes event log streams);
- restarts, crash-looping pods and unready nodes; failing calls to and from the service from the trace service graph;
- recent error log lines; other active alerts; runbook notes (treated as a hypothesis);
- **alert coverage gaps** (below); and whether the rule itself is broken (a rule that cannot evaluate "fires" on its error).

It hands the model that digest plus ready-made, tested panels (ALR signal, BLR blast radius, CHG what changed, EVD
error logs, FLO data flow, RST restarts), so the model only decides what it means and narrates. A rule with no cluster
label has its cluster found by running its query. A kubernetes story now takes ~7 model calls instead of ~9–12 and
names a cause (for example, storage full on VictoriaLogs starving Tempo, SkyWalking and Hubble).

## Baselines: new, worsening or chronic
The situation board reads every signal now, 30 minutes ago **and at the same time yesterday**, and classes each problem:
*new* (fine yesterday), *worsening* (up 25% in 30 minutes), *chronic* (just as bad yesterday) or *steady*. Chronic
problems rank lower; new ones higher. On the monitors a chronic warning shows an outlined **CHRONIC** tag instead of
the yellow CAUTION chip, a chronic critical shows **CRIT CHRONIC**, and a new one adds **NEW**. Every trend panel
draws yesterday's line faintly (dotted) under today's, and marks changes in its cluster. Ask "is this new?" and the
9000 answers from the comparison.

## Changes on trends
`changes/index.js` turns rollouts (new ReplicaSets) and Kubernetes event lines into changes: each is classified
(DEPLOY, ROLLBACK, SCALE, CONFIG, UPGRADE) and named by its service, a burst of events for one service is one change, a
rollout's own scaling is folded into its deploy, and noise is dropped: pod scheduling, probes, and heartbeats (the same
message three or more times in the window, such as the estate's "scaled up replica set … to desired count" every 30 s).
On a trend, each change is tied to what the panel's line did in the ten minutes after it against the ten before. Only
changes that matter to the panel get words: on a service the panel's query names, or followed by a move (30% or a
threshold crossed), e.g. `DEPLOY CHECKOUT-API V2.4.0 · ↑ +3 MIN`; the rest are short dotted ticks. Click a mark for its
card: when, what kind, each event with its time, what the line did next ("rose 0.4% → 3.1% within 3 min"), and *Ask
SAL/HAL: did this cause it?*. The model hears the marked changes with each panel. In a story tour, a narration about a
change lights its mark (or its row on a "What changed" timeline) and dims the others; the eye sends it as `focusMark`
alongside `focus`. For local testing only, `CHANGES_TEST_FILE` names a JSON file of `[{ cluster, minutesAgo, text }]`
event lines to add (never set in the deployment).

## Timelines: the story over time
Panel kind `timeline` (`timeline/index.js` collects, `boards` reads, `displays.js` draws) puts what happened around an
alert (`alert_uid`) or an incident (`incident`) on one time axis: the signal on top (the alert's own query unless
`query` is given, with its threshold), and below it a lane of events, each with its own mark and colour: the alert firing
(▲ red; "Firing since …" at the left edge when it started before the window), changes in its cluster (◆ yellow), the
alarm on the monitors, the acknowledgement (●), Aiden starting and its finding (○ blue), plans proposed, approved and how
they ended (■ amber; a check that held ▼ green), and the incident's own timeline (status, severity, findings, notes).
The window runs from a little before the first event to now (at least 15 minutes, at most a day). Labels go into the first
lane with room; click an event (mark or words) for its card (the detail behind it: Aiden's finding, a plan's steps, a
change's events) and *Ask SAL/HAL about this*. `investigate` offers it as panel **TML** in alert stories (in place of the
"What changed" list), and a narration about an event lights it.

## Fixing things: plans, approved on the monitors
The 9000 changes nothing on its own. Its only way to change anything is `propose_fix`: a **plan** of exact tool calls
(at most six), with the problem and its evidence, what should change, a PromQL **check** (a value that should go below
or above a threshold within some minutes), the risk, and an **undo**. Steps may only use tools set to **Ask first** on
the settings page (Off / Use / Ask first per tool); those are never offered to the model directly, and `mcp.call` refuses
them unless they run as a step of an approved plan. Each step's arguments are checked against the tool's schema.

The plan goes on the board as panel **PLN** (one place beyond the usual six) and the **plan card** opens on the
monitors: every call with its server and arguments, the check, the risk and the undo. A **signed-in person** approves it
there (two clicks: the first arms the button) or by voice from an eye signed in as them ("approve the plan" / "reject the
plan"); never the automation token (with sign-in off, only when `ALLOW_UNSIGNED_APPROVAL=1`, for local testing). The
approval is for exactly the plan shown (a hash); a changed plan is a new plan. Undecided plans expire after
`fixes.expireMinutes` (default 15); a new plan replaces the ship's undecided one. Once approved, the steps run in order
(a failed step stops the rest), then the check is watched; the 9000 says what happened (worked, ran but the change hasn't
shown, failed) and the card offers to propose the undo, as a new plan that needs its own approval. The approval and the
outcome go on the incident it is for (named, or the open one for the alarm's alert); a plan whose check held is
remembered as a fix. `plan_status` lets the model report on it. Code: `fixes/index.js`.

## Acknowledging the alarm
When an announced alert fires, the ship alarms: a blinking red **ALERT** badge and frame, the eye's lens blinking red.
**Acknowledge** (the lit footer button, `a`, or saying "acknowledged" / "I've got it"; a corner button appears when the
footer is hidden, as during a story tour) says someone has it. It is one acknowledgement per alert, shared by every
ship: the badge reads `ACK <who> <time>`, the frame and lens calm to a steady glow, and the story, board and Aiden carry
on. It goes on the open incident for that alert (or on one opened for it later, by `alert_uid`) as a timeline entry and
in the incident's `acknowledged_at` / `acknowledged_by` / `detected_at`, so StackGen Incidents shows the **median time
to acknowledge** next to identify and resolve (all measured from detection where known). The alarm comes back when a
new alert fires, or when this one is still firing `alerts.ackMinutes` (default 30) after it was acknowledged and its
incident hasn't moved on to identified or monitoring. Resolving the alert clears it.

The footer's **Incidents** button shows the alarm's own incident (`INC-0007 · SEV2`), else how many are open (checked
every 30 s); its menu lists them, each opening in StackGen Incidents, and offers to declare one for an alarm without one.

## Aiden, the deep investigator
`aiden/index.js` connects Aiden for SRE (StackGen's AI SRE) as the 9000's deep investigator. The 9000 answers in seconds;
Aiden takes minutes, with several agents and its own verification. When an alert fires, the 9000 tells the quick story
and, in parallel, asks Aiden to investigate the same alert (once, whichever ships hear it). Panel **AID** joins the
story board (one place beyond the usual six) and follows it: finding the alert, queued, investigating with a clock,
then its findings. The result is spoken on every ship that heard the alert or shows the panel, goes into the chat with
*Open in Aiden* and the full findings, onto the open incident for that alert (incidents carry `alert_uid`; one declared
later gets the result too), and into memory. `aiden_investigate { alert_uid }` lets the model start one on request.

Aiden is an MCP server configured in settings (any name). Aiden's alerts don't carry the Grafana rule uid, so the 9000
matches on the title (Aiden's read `<rule title> : <summary>`), preferring the same service and namespace; when Aiden
hasn't ingested a new alert yet, the 9000 asks it to sync and keeps looking for five minutes. Four of its tools must be
set as **internal** on that server (only the 9000's code calls them): `sre__sre_list_alerts`, `sre__sre_sync_alerts`,
`sre__sre_start_investigation`, `sre__sre_get_investigation`. Every Aiden tool is marked destructive, so none is offered
to the model unless allowlisted. Settings: `aiden.workspace` (default `steph-aiden-observe-now`) and
`aiden.autoInvestigate` (on / off).

## The chat drawer
Drag the transcript line at the bottom of a monitor up (or click it, or press `t`) to open the conversation as a
thread. It takes its own slot, so the board shrinks and re-lays itself out instead of being covered, and it docks at
the bottom, left or right (drag its grip to a side of the screen, or back to the bottom; or use the buttons in its
corner). A side dock starts at the width a square board leaves over on a wide monitor. In the thread: your questions on the right (typed or spoken, and the panel they were about), SAL/HAL's replies on the left
with the steps taken ("Searching the traces for checkout-api") and a chip that brings back the board the answer put
up. While the 9000 works, a reply-in-progress bubble lists its steps. The drawer snaps to a third, two-thirds or most
of the screen, and each monitor remembers its height. The thread comes from the server (the last 100 messages per
ship, in memory), so every monitor in a ship shows the same conversation, including a late joiner.

## Alert coverage
`alert_coverage` (`coverage/index.js`) finds problems no *working* alert rule would catch: a signal past its warning
line in a cluster where every rule querying that metric for that cluster is missing or fails to evaluate. Each gap
comes with a proposed rule (query, threshold, `for`, severity) for a person to review and add in Grafana; the 9000
never creates rules. Gaps also appear in every investigation. Rule details are fetched once (8 at a time) and cached
for 15 minutes, warmed after each survey.

## Speed
The opening model call of each turn uses low reasoning effort (`LLM_FAST_EFFORT`, default `low`; or a separate
`LLM_FAST_MODEL`). Most conversation ends there; investigations think in full from the second call on. Situation
curation and drilldown suggestions use the quick path too. Typical times: chat 0.6–2 s, cluster health ~5 s,
"what needs attention" ~2.5 s, a full story 35–80 s (mostly model time).

## The 9000 on itself (`self/index.js`)
"Introduce yourself", "where are you running", "when were you trained", "what can you see", "what is the status of
your systems" and "walk me through your architecture" are answered from live facts, not scripted lines:

- `describe_self` reads the 9000's make-up now: version and uptime, the language model in use (Settings → Mind), the
  voice, the ship's eye and monitors, where it runs (`HOSTED_ON` in the overlay plus pod, namespace and node from the
  downward API), each tool server and whether it is connected, memory, Incidents, Aiden, which tools a plan may run,
  and its telemetry. The training date is the knowledge cutoff of the model it names.
- `look` turns the eye's front camera on just long enough for one settled frame (the first few are skipped while
  exposure adjusts; six seconds at most), has the language model in use describe it, and puts the camera back as it
  was. Nothing is stored; the frame does go to the model provider. Introductions use it to mention something about
  the person ("I can see you're in a blue shirt"). Models without vision say so.
- A tour of its architecture is composed by the model with `show_story`: a flow diagram of its parts (manual nodes
  and edges, as `describe_self` reports them) and narrated notes, so it changes by itself when the model, voice or
  servers do. Flow diagrams with loops (eye ⇄ server) are laid out without them, and note panels shrink their text to fit.

## The 9000 observing itself
Every turn is recorded (`telemetry/index.js`): duration, model calls and tokens, each tool call's time and success.
`self_check` answers "are you operational?" / "why were you slow?" from those numbers. Set
`OTEL_EXPORTER_OTLP_ENDPOINT` to also export a trace per turn (`conversation.turn` with `llm.call` and `tool …` child
spans, GenAI token attributes) and metrics every 30 s (`hal9000.turns`, `hal9000.turn.duration`,
`hal9000.model.calls`, `hal9000.model.tokens`, `hal9000.tool.calls`) as OTLP/HTTP JSON.
On Civo it exports to `data-recipes-traces-relay` (the collector that feeds the stephgen-medussa ObserveNow instance the
9000 reads), so the 9000's own telemetry is queryable from its own tools: metrics arrive as `hal9000_*` with
`service_name="hal9000"`, traces in the Traces (Jaeger) datasource under service `hal9000`.

## Confusion: the 9000 watching its own mind
Every answer gets a **confusion score**, 0 (clear) to 1 (lost), from signs counted while it works
(`telemetry/index.js`, counted in `brain.js`): long reasoning loops and hitting the round limit, the same tool call
repeated, calls to tools it does not have (an approval-only tool called directly is a directive conflict), failed
tools, `find_tools` misses, empty answers that needed a nudge, scripted fallbacks, refusals, proposed fixes that failed
validation, and **token entropy** where the model reports token probabilities (OpenAI does without reasoning, which is
how the 9000 calls it with tools; the mean entropy over a reply above 1 nat counts as uncertain). Signs combine as
independent chances, `1 - Π(1 - weight)^count`, so several small ones add up but never pass 1.

Exported with the rest of its telemetry: `ai_confusion_score` (the worst answer in each 30 s), the `ai_confusion`
histogram (score per answer), `ai_confusion_signals_total{signal}`, `ai_completion_token_entropy`; each turn's trace
carries the score and its signs, and everything the 9000 prints goes to Loki as OTLP logs with the trace id of the answer it belongs to (`{k8s_cluster_name="fe-apps-discovery-one", service_name="hal9000"}`; `|= "CONFUSION"` for the confused answers). `self_check` reports it ("confusion: median 0.03…"), and a turn scoring 0.5 or more
is logged as `CONFUSION`. The **HAL 9000 · Mind** dashboard and the alerts "HAL 9000: confused" and "HAL 9000: lost
(circuit breaker)" are in `~/src/discovery-one/observability`.

## Evaluations
`node evals/run.mjs [ws://host]` asks the cases in `evals/cases.json` against the live estate and scores each: the
right tools used, the answer mentions what it must, length and time limits, no fallback reply. It writes
`evals/report-<time>.json`. `--only id,id` runs some; `--scenario "cause,words" [--ask "..."]` scores one question
after someone has triggered a data-recipes scenario (the script never triggers one). With sign-in on, set `EVAL_TOKEN`
to the automation token (or `EVAL_COOKIE` to a session cookie). Baseline (2026-10-20): 10/10 passed (including `slow-trace`).

## Settings (`/settings`)
Open it from the monitor's **Settings** button (or the `,` key), or go to https://9000.stackgen.run/settings. Changes
apply within a minute on every ship, without a restart. They're stored in StackGen Incidents (`/api/settings/hal9000`)
and survive restarts; anything left at its default follows the deployment's environment variables (`config/index.js`).

| Section | Settings |
|---|---|
| Mind | language model (from the models Ollama offers), reasoning on quick calls, when to re-send a stalled quick or full call |
| Persona | voice for new ships (SAL or HAL) |
| Situation board | most panels at once, survey interval, re-ranking interval, default snooze length |
| Alerts | announce from (critical or warning), check interval, don't repeat an announcement within |
| Tools · MCP servers | any built-in servers from `MCP_SERVERS` (read-only here), and the servers configured in settings (with their internal tools shown), shared with StackGen Incidents: add, test, choose tools (read-only allowed by default), turn off, remove |

Settings servers are read every minute: new ones connect, changed ones reconnect, removed or turned-off ones are
dropped. One with the same name or address as a built-in server is a duplicate and isn't used (so the model never
sees the same tools twice). Keys and tokens in URLs and headers are masked for people; only the 9000's service token
reads them. Currently configured: **k8s**, read-only access to the `kubernetes` cluster (pod logs, events, nodes,
resources, Helm).

## StackGen Incidents and memory
With `INCIDENTS_URL` and `INCIDENTS_TOKEN` set (`incidents/index.js`), the 9000 works with
[StackGen Incidents](https://incidents.stackgen.run) (`~/src/stackgen-incidents`):

- **"Open a SEV2 incident for this"**: `open_incident` declares it, attaching the evidence the 9000 last gathered
  (within 30 minutes), credited to "<you> via HAL 9000". Also `list_incidents`, `update_incident` (status, severity,
  cause, resolution) and `add_incident_note`. It offers an incident when a story shows a real problem, and only opens
  one when asked.
- **Memory in every investigation**: `investigate` adds "What StackGen already knows" (past incidents, causes, fixes,
  chronic issues, other agents' investigations), retrieved within a 500-token budget. `recall_memory` answers "have we
  seen this before?" and "what fixed it?". It reports only what is recorded and says when no fix is.
- **Memory first** (`memory/index.js`): with a memory MCP server in settings (`mcp-qdrant`, tools `qdrant_find` /
  `qdrant_store`; names set under MEMORY, `qdrant-find` spelling works too), every question is preceded by a memory
  search (the question plus the alarm and the panel it is about, at most 2.5 s, typically under 1 s) and the results go
  in front of it, so each answer starts from what is already known. Incidents writes its memories to the same store,
  so one search covers both. The model gets `recall` (search again) and `remember` (store a fact, with kind, cluster,
  service, date and author in Incidents' metadata shape) and is told to store anything that will matter again without
  being asked; Aiden's findings and what each approved plan did are stored automatically. The memory server's raw tools
  are taken as internal whatever its allowlist, so the model only reaches memory through those two (and Incidents'
  `recall_memory` is not offered alongside). Without a memory server, answers start as before.
- **Hedged model calls**: if a call hasn't answered within `LLM_HEDGE_MS` (8 s quick, 25 s otherwise), an identical
  second request is sent and the first answer wins. Ollama Cloud occasionally stalls one call for a minute.

## Sign-in
With `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `SESSION_SECRET` set (`auth.js`), every page, the
WebSocket and speech clips need a session; pages redirect to the identity provider (authorization code flow with PKCE)
and back. The session is a signed cookie (12 hours; no server-side store). The phone doesn't sign in itself: the
pairing QR on a signed-in monitor carries a 15-minute signed pass (renewed every 10 minutes) that signs the eye in as
that person for 30 days. The 9000 is told who is asking. `/auth/logout` signs out; `/auth/me` shows who you are.
**Machine access:** `AUTOMATION_TOKEN` (in `hal9000-keys`, at least 32 characters) is accepted as
`Authorization: Bearer <token>` on pages and the WebSocket. It acts as the identity `automation`, never as a person,
each connection is logged (`AUTH automation token: …`), and rotating it means replacing the Secret value and
restarting. It's what evaluations and post-deploy checks use.
Unset, the app is open as before (local development). Live on https://9000.stackgen.run: the client ID and issuer are in the
Civo overlay's ConfigMap, `OIDC_CLIENT_SECRET` and `SESSION_SECRET` in the `hal9000-keys` Secret. In Authentik: an OAuth2/OpenID provider (confidential client
`hal9000`, redirect `https://9000.stackgen.run/auth/callback`, scopes openid/email/profile) and an application
`hal9000` bound to the `stackgen-email-domain` policy, like Grafana.

## Voice
Chosen by `TTS_PROVIDER` (see `tts/index.js`):

| `TTS_PROVIDER` | Needs | Notes |
|---|---|---|
| `comfyui` | `COMFYUI_URL`, `COMFYUI_TOKEN` | Chatterbox nodes on a ComfyUI server. HAL: Chatterbox Turbo + `voices/hal-9000.wav`; SAL: Chatterbox Turbo + `voices/sal-9000.wav` (both F5-TTS demo voices, chosen by listening test) |
| `browser` | nothing | The eye's built-in speech synthesis; also the fallback for any clip that fails |

The server splits each reply into sentences, synthesizes them in order and serves them at `/tts/<id>`; the eye
plays them through a Web Audio speaker grille and drives the lens glow from their loudness. Repeated lines are cached.
On the ComfyUI box (`/opt/comfyui`), the speech nodes' Python deps are baked into the image via
`requirements-tts.txt` + `constraints-base.txt` (which pins torch/numpy/pydantic/transformers).

## Layout
- `server.js`: static files, `/qr.svg`, `/api/lan`, and the `/ws` room relay (state merge + broadcast)
- `brain.js`: the 9000's persona + per-room conversation history (append-only; resets after 30 exchanges, 30 idle minutes, or a HAL/SAL switch)
- `commands.js`: voice/typed display commands, handled before the LLM
- `fixes/`: plans (propose_fix), approval by a signed-in person, running the steps, the check, records
- `aiden/`: Aiden for SRE as the deep investigator (match alerts, start and follow investigations, the AID panel)
- `traces/`: Jaeger traces through Grafana (find_traces; the waterfall layout and critical path for `trace` panels)
- `alerts/`: read-only alert access (list_alerts, get_alert) for alert stories; `watch.js` speaks up when alerts fire
- `home/`: the situation board: estate survey, concern scoring, curation
- `boards/`: live data boards (curated cluster health, ad-hoc panels) refreshed from Grafana
- `mcp/`: MCP client: connects to `MCP_SERVERS` and the servers in settings (synced every minute), exposes allowed tools, runs them
- `tts/`: pluggable speech (`comfyui.js`; browser speech is the fallback)
- `llm/`: pluggable providers (`anthropic.js`, `openai-compatible.js`, `scripted.js`)
- `public/eye.html`: the faceplate: black slab, metal trim, layered lens, mesh speaker (CSS only, no images)
- `public/monitor.html`, `public/displays.js`: Discovery-style displays, modes, views and hotkeys
- `docs/REQUIREMENTS.md`: the full specification

## Look and fonts
The monitors follow the Discovery cockpit screens as recreated by The HAL Project: muted solid fields, white hairline
graphics, small extended-face codes, monospaced data, and health as inverted tags (CRIT, CAUTION, NON FUNCTION)
rather than flashing panels. Fonts: extended capitals for codes and tags (Eurostile Extended where installed, else
Michroma), Share Tech Mono for data and the console, thin Futura (or Jost) for signage, Gill Sans for the nameplate.
Palette and font tokens are in `public/base.css`; all drawing is in `public/displays.js`.

## HTTPS
Over plain `http://<lan-ip>` the phone works as an eye, but browsers block these without HTTPS:
installing it as an app, the offline cache, keeping the screen awake, and voice input.
Serve it behind TLS to unlock all of them.

## Deploying (aboard Discovery One, https://9000.stackgen.run)
Since 2026-10-30 the 9000 runs aboard Discovery One: Civo cluster `fe-apps-discovery-one`, namespace `hal9000`, beside
the ship's own services (`~/src/discovery-one`). Kustomize manifests live in `deploy/`: `base/` is cluster-neutral,
`overlays/discovery/` adds the ingress (Civo's Traefik DaemonSet, no IngressClass), cert-manager TLS and the image
tag, and reaches everything else over public addresses (Incidents, memory, the telemetry relay at
`otlp.stackgen.run` with basic auth). DNS for `9000.stackgen.run` is a DNSEndpoint on `fe-stackgen-run`
(`~/src/discovery-one/deploy/fe-stackgen-run/dns.yaml`). Rooms live in memory, so keep **one replica**.
`overlays/civo/` (the old home on `fe-stackgen-run`) is retired and kept for rollback: that Deployment is scaled to 0.

```
# build + push (Apple container CLI; the cluster is amd64)
container build --arch amd64 -t docker.io/srclosson/hal9000:<tag> .
container image push docker.io/srclosson/hal9000:<tag>
# bump newTag in deploy/overlays/discovery/kustomization.yaml, then
KUBECONFIG=~/.kube/config.discovery-one kubectl apply -k deploy/overlays/discovery
```

Secrets are never committed. They live in the `hal9000-keys` Secret, created once in the cluster
(the pod still runs without it: scripted replies, browser speech). It currently holds `COMFYUI_TOKEN`;
add keys with `--from-literal` the same way:

```
KUBECONFIG=~/.kube/config.discovery-one kubectl -n hal9000 create secret generic hal9000-keys \
  --from-literal=COMFYUI_TOKEN=... --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
  --dry-run=client -o yaml | kubectl apply -f -
KUBECONFIG=~/.kube/config.civo kubectl -n hal9000 rollout restart deploy/hal9000
```

The Civo overlay uses the cluster's Ollama (`glm-5.3:cloud` via `http://ollama.ollama.svc.cluster.local/v1`, the same
server as https://ollama.stackgen.run). Switch LLMs or the voice by editing the `hal9000-config` literals in
`deploy/overlays/civo/kustomization.yaml`.

**ArgoCD:** once this is in git, set `repoURL` in `deploy/argocd/application.yaml` and apply it to the `argocd` namespace.
The secret stays out of git; move it to Sealed Secrets or External Secrets later if you want it managed too.

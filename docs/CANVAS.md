# Views and the canvas (spec 2.0, draft for markup)

Status: **agreed design, 2026-10-30**. Nothing here is built yet. Lines marked **Decided** record the choices made
in review; mark up anything else.

## Progress

**Phase 1 built (2026-10-30), not yet deployed.** `boards/view.js` is the v2 view: `toView` lifts any panel spec into a
view, `toPanel` lowers it back to exactly the spec the readers already take, `compile` writes PromQL for structured
layers, and `applyDiff` / `undo` / `redo` / `at` keep its history. A query becomes structured only when recompiling
it gives back the same text (and HAL's own wording is kept while it still says the same thing); anything else stays
opaque. Every panel the boards module reads now carries its `view` (the monitors ignore it until phase 2), and
`design_panel` / `show_panels` / `show_story` accept v2 views (checked, then validated as the spec they lower to,
history kept). Nothing drawn changes: `node --test boards/` checks that every panel shape round-trips exactly, that
real queries in the codebase never change meaning, and that diffs undo and redo exactly. The same panel as v1 and as
v2 drew identical data against live Prometheus.

**Phase 2 built (2026-10-30), not yet deployed.** Any board panel whose view has data layers shows ⧉ in its title bar
(or press `o` on the selected panel). It opens in place: it grows within its row, gets a white outline, and the metric
browser opens beside it. The bar on the panel shows its parts as chips: each line (HAL's own marked HAL), the split, the
Only filters, a window picker, and Undo / Redo / Discard / Put up. While something is dragged, the zones appear: Split by
(top), Add (left scale), Add (middle), Add (own scale, right), Only (bottom), Remove (bottom right). Each says what a
drop would do, or why not, before you let go. In the metric browser, ▸ lists a metric's labels to drag. Dropping a label
on Only asks which value. ✕ on a chip, or dragging it to Remove, takes it out; ⌘Z / ⇧⌘Z undo and redo.
- Rules: `public/drops.js`, one table, used by the server to apply a drop and by the monitor to refuse one while
  hovering. Tests: `node --test boards/`.
- Drafts: `boards/canvas.js`. A draft is the opening monitor's own, read live for it alone and refreshed every 15 s.
  Other monitors show "EDITING · name" on the panel. Put up replaces the panel for everyone, keeping its history.
- APIs: `/api/metrics/labels?metric=&cluster=` and `/api/metrics/values?label=&metric=&cluster=`.
- Known limits: a draft belongs to its monitor's connection, so a reload or a dropped connection loses it. Opening a
  panel from a v1 query kind (a plain trend) makes it a compose panel on its first drop, so it is drawn in the compose
  style from then on. A panel not open on the canvas still takes a metric drop as a question for HAL (0.30.0).
- Series colours (`public/inks.js`, added after review): each non-hero line gets a light tint that passes 3:1 contrast
  and a clear hue gap against its own panel's background. The hero, and shifted copies of it, keep the panel's ink.
  No reds, oranges or yellows, since those mean crit and caution. A value's first choice comes from the value itself,
  so it's the same on every panel and monitor; it moves only on a clash with the background or another line. Dashes
  stay as a second cue. Used for lines, legends, hover dots and tooltip rows (time layouts and the graph kind).
  A card remembers how it drew each line (`keep`): refreshes re-sort lines by value and lines come and go, but each
  keeps its colour and dash. The hero is always the server's, so the bright line is the one the headline describes. A remembered colour gives
  way only when the card moves to a background it doesn't suit.
  Tests: `boards/inks.test.js` (every board background keeps at least 4 usable colours).

Not yet: HAL is not told about v2 (his prompts still write v1; v1 stays valid shorthand), and v1 `by` (the label
naming each series) is kept as `seriesBy`, separate from `by` (aggregation labels), until phase 3 merges it into
`encode.color`.

## 1. The idea in one paragraph

Every panel the 9000 draws is the result of a **view**: a description of what data to read, what to do to it and how
to draw it. Today that description is the `compose` grammar (`boards/compose.js`): HAL writes it, the monitor draws
it. A **canvas** is not a new kind of panel. It is a view you can hold in your hands: any panel can be *opened*, its
description shows up as drop zones, and dragging things onto it edits the description. A blank canvas is an empty
view. One model, used by HAL and by people alike, so nothing is built twice: a canvas can go on a board, into a
story, be narrated, replayed, snoozed, drilled into.

## 2. Principles

1. **The view is the only state.** A canvas is its description. Every drag, every HAL suggestion, every edit is a
   *diff* to that description, recorded with who made it and why. Undo, history and replay come from that list.
2. **People's drops are instant and deterministic; HAL collaborates, he does not interpret.** A drop applies a rule
   from §6 at once (no model in the loop, no waiting). HAL watches the diffs and offers judgement ("that's a counter,
   I've rated it"; "these two only join on pod"). He can rewrite the view, and his rewrite is itself a diff you can
   undo. The rules only give a sensible starting point; they never decide what HAL may think.
3. **Types choose the defaults.** Metric kind (counter, gauge, histogram), unit, cardinality and shared labels decide
   what a drop does: a counter is rated, mismatched units get their own scale, high cardinality gets a top N, two
   metrics can only form a scatter if they share a label to join on.
4. **Refuse before the drop, not after.** A zone that can't take what is being dragged says so while you hover
   ("logs can't be an x axis"), and nothing changes if you let go there.
5. **Function first, design language second** (spec 2.0). The house style stays, but never at the cost of being
   able to read the data.
6. **Growing the grammar is a capability request.** When a view asks for something the grammar can't draw, that is
   a gap HAL can propose to fill, and the fix arrives as something you try before it ships (§10).

## 3. The view (description), version 2

An evolution of today's `compose` spec, not a replacement: every compose panel converts to a v2 view without loss.

```js
view = {
  v: 2,
  title, caption,
  scope: {                       // applies to every layer unless a layer overrides it
    window: '-60m',              // or { from, to }; ISO or relative
    filters: [{ label: 'cluster', op: '=', value: 'fe-apps-discovery-one' }],
  },
  layers: [{
    id: 'L1',
    source: 'metrics',           // metrics | logs | traces | profiles
    // Structured (editable by drops):
    metric: 'http_requests_total', fn: 'rate', agg: 'sum', by: ['service'], top: 5,
    // ...or opaque (HAL-written PromQL/LogQL; drops that restructure it go through HAL, see §6.4):
    query: undefined,
    shift: 0, over: 'max', unit: 'req/s', axis: 'left', style: 'auto', hero: true,
    role: 'y',                   // y | x | size | events
  }],
  encode: {                      // what each visual channel carries
    x: 'time',                   // 'time' | a layer id | a label name
    color: 'service',            // a label name, or null
    facet: null,                 // a label name: small multiples, or null
  },
  mark: 'auto',                  // auto | line | area | step | bars | points | heatmap | histogram | …
  refs: [], spans: [], callouts: [], events: [],   // as today
  headline: { show: 'last' },
  history: [{ at, by: 'Stephanie Closson' | 'HAL 9000', diff, why }],
}
```

- **Structured layers** (`metric`, `fn`, `agg`, `by`, `top`) are what make drops deterministic: the canvas can add
  a `by`, change the `agg` or switch `rate` on without understanding PromQL. They compile to PromQL on the server.
- **Opaque layers** (`query`) are HAL's freehand: anything PromQL can say. They can be moved, styled, shifted,
  scoped and deleted by drops, but a drop that would change their *meaning* (split by a label, change aggregation)
  is handed to HAL as a request (§6.4) instead of guessed at.
- **`mark: 'auto'`** means "choose from what's in the view" (§5). Anything explicit wins.

**Decided:** `layout` (time, bars, scatter, story) stays as a shorthand that sets `encode` and `mark`; v1 specs are
read as v2, so existing HAL prompts and saved boards keep working.

## 4. Where it lives

- **Open in place.** Any panel on a board gets an "open" action (key `o`, or double-click): it grows, its drop
  zones appear, and the metric browser opens beside it. Close it and it is a panel again, with your changes.
- **A blank canvas** is "New view" in the view picker (or drag a metric into empty board space).
- **Story cards** are opened one element at a time; the card is the frame.

**Decided:** in place, not a separate workbench. The board is the context, and a canvas that leaves it loses it.

**Decided:** a canvas is personal while open ("drafting") and shared when you close it or press "Put up". Other
monitors see a "being edited by …" tag on the panel meanwhile, so two people never fight over one view.

## 5. Choosing the picture (mark: auto)

What is in the view decides how it is drawn. First match wins; HAL may override (as a diff, with a reason).

| x | y layers | color / facet | Drawn as |
|---|---|---|---|
| time | 1+ metrics | – | trend (lines; area if one layer and it's a share) |
| time | 1+ metrics | label | trend, one line per value (top N, the rest as "other") |
| time | metrics + events | – | trend with events on the hero line (as today) |
| layer A | layer B (joined on a shared label) | – | scatter, one point per joined series, outliers named |
| label | 1 metric | – | bars, one per value, sorted |
| label | 1 metric, 2 layers (now / shifted) | – | paired bars: now against then |
| time | histogram metric (`_bucket`) | – | heatmap of the distribution over time |
| – | histogram metric | – | histogram (now) with p50 / p95 marked |
| any | any | facet label | small multiples of the above, shared scales, one per value (max 6) |

Not drawable yet (each would be a capability request, §10): part-of-whole (pie, treemap), topology (beyond today's
flow panel), maps, tables with sparklines.

## 6. Drops

### 6.1 What can be dragged

| Draggable | From |
|---|---|
| a metric | the metric browser (built in 0.30.0) |
| a label (dimension: service, pod, cluster…) | the metric browser, which gains a "labels" tab for the selected metric |
| a time: a window (last 6 h), a shift (yesterday, last week), a moment (a point on any trend) | a time palette, and any trend's x axis |
| a signal: logs (a query, or a line), traces (a service), profiles (a service) | the logs panel, the trace panel, a palette |
| a panel | its tag (drag the "VIT" chip) |
| a value | any number on screen, to become a reference line |

### 6.2 The drop zones

```
┌─────────────────────────────────────────────────────┐
│  COLOR / SPLIT                              FACET ⧉ │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Y ↕                                    RIGHT Y ↕│ │
│ │                                                 │ │
│ │                  the plot                       │ │
│ │                                                 │ │
│ └─────────────────────────────────────────────────┘ │
│   X ↔                                               │
│   SCOPE: window · filters                   🗑 out   │
└─────────────────────────────────────────────────────┘
```

Zones appear only while something is being dragged, and only the ones that can take it light up.

### 6.3 Rules (deterministic, instant)

| Drop | On | Effect (the diff) |
|---|---|---|
| metric | plot or Y | add a layer; counter → `fn: rate`; histogram → p95 by default; same unit as the hero → left axis, else right |
| metric | RIGHT Y | add a layer on the right scale |
| metric | X | x becomes that metric: scatter, joined on the best shared label (the one both have with the most values in common); refused if none |
| label | COLOR | `by` += label on every structured layer; `encode.color` = label; top 5 |
| label | X | x becomes the label: bars |
| label | FACET | `encode.facet` = label (max 6 panels) |
| label | SCOPE | a filter on that label; the value picker opens |
| window | SCOPE or X | `scope.window` = it |
| shift | plot | duplicate the hero layer with that shift, style faint |
| moment | plot | a callout at that time ("from 14:02") |
| logs / traces / profiles | plot | an `events` entry |
| value | plot | a reference line |
| panel | plot | merge: its layers join this view (scopes reconciled; a conflict asks) |
| anything | 🗑 out (or dragged off the canvas) | remove it |

Every rule is an entry in one table in code, so it is readable, testable and changeable in one place.

### 6.4 When a rule can't apply

Some drops need judgement: splitting an opaque layer by a label, joining two metrics with no shared label, a metric
whose kind can't be told from its name. The drop is then sent to HAL as a request ("add pod as colour to L2"), the
zone shows "asking HAL…", and his answer arrives as a diff with a reason. If he can't, he says why, and nothing changes.

## 7. HAL as collaborator

- **He sees the diffs**, with who made them, and the resulting view (live values included, as `panelLine` does today).
- **He may suggest**: one line, on the canvas, with Apply / Dismiss. Suggestions are at most one per drop, and only
  when they change what the view says (a better aggregation, a misleading axis, a stronger comparison). No chatter.
- **He may rewrite** when asked ("make this clearer", "what's this telling me?") or for a §6.4 request. A rewrite is
  one diff, with a reason, undoable.
- **He narrates on request**, using the history ("you added pod as colour; one pod carries 80% of the errors").
- **Latency budget:** drops never wait for him. Suggestions arrive when they arrive; a stale one (the view moved on)
  is dropped.

**Decided:** HAL suggests unprompted, but only in the cases above (at most one per drop), with a setting to turn it
off.

## 8. History, undo, replay

- `history` holds every diff: who, when, why. `⌘Z` / `⇧⌘Z` step through it.
- **Replay** (built in 0.29.0 for tours) extends to building: "show me how this view was made" plays the diffs in
  order, HAL narrating his own.
- **Save** keeps the view with its history; boards keep views, so a board is a set of views.

## 9. What a view is not

- Not a dashboard editor: no pixel layout, no free placement. The board still lays panels out.
- Not code: neither people nor HAL write drawing code. Anything the grammar can't express is a capability request.
- Not a query editor: opaque queries stay HAL's. (A "show query" affordance for reading is fine.)

## 10. Growing the grammar: capability requests, tried before they ship

When a view needs something the grammar can't draw (a pie chart), or data that isn't there (no spans past the
gateway), HAL can propose to fill the gap. The loop (being built in the "Aiden capability-gap loop" session):

1. **Gate 1, "may I build it?"** HAL proposes it on a plan card: what's missing, why it matters, which repository,
   who owns it. Approving only lets Aiden work on a branch and open a PR; owners are told a request is in progress.
2. **Built, then tried.** Depending on the kind of change:
   - a view preset or drop rule (data only): tried in place on your monitor, marked TRIAL, one-click revert;
   - monitor, grammar or server code: a preview HAL at its own address (e.g. `pr-12.9000.stackgen.run`);
   - instrumentation: a preview copy of the service, its telemetry tagged as preview.
   The preview can look but not act (no write tools, plans, announcements or Incidents writes; memory writes go to
   a scratch collection). The eval suite runs against it, and the "ready to try" card carries the score against
   production and anything that regressed.
3. **Gate 2, "ship what you tried?"** Approve, and the exact build you tried (pinned by digest) merges and rolls
   out; or send feedback, and Aiden iterates on the same PR. Untried previews expire; rejection closes the PR. HAL
   never approves, merges or deploys his own work.

**Decided:** a GitHub Action in each repository builds the PR's image and applies a preview overlay, with a deploy
credential scoped to preview namespaces only. Never HAL.

## 11. Build in phases (each one usable on its own)

| Phase | What | Proves |
|---|---|---|
| 1 | v2 view schema; compose specs read as v2; structured layers compiled to PromQL; history of diffs | the model holds; nothing visible changes |
| 2 | "Open" a panel in place; Y, RIGHT Y, COLOR, SCOPE, out; metric and label drops; undo | the core loop: drag → instant change |
| 3 | X and FACET; scatter by join; bars by label; time palette (window, shift, moment) | the picture evolves with what's in it |
| 4 | HAL as collaborator: suggestions, §6.4 requests, narrated history, replay of building | judgement on top of determinism |
| 5 | Signals and panels as draggables; merge two views | everything in one view |
| 6 | New marks via capability requests (heatmap, histogram, part-of-whole) | the grammar grows, tried before it ships |

**Decided:** phases in the order listed: HAL's suggestions are worth more once there are real choices (scatter vs
bars) for him to weigh in on.

## 12. How we'll know it works

- A person with no PromQL builds "errors by service over the last 6 h, against yesterday" in under 30 seconds by
  dragging alone.
- Every drop applies in under 200 ms; nothing waits on the model.
- Undo returns any view exactly to any earlier state; replay rebuilds it.
- HAL's suggestions are accepted more often than dismissed (tracked like the confusion metrics).
- Every existing compose panel opens as a canvas and closes unchanged.

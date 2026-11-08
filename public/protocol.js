// The contract between the 9000 and its screens: every message a screen may send over the ship's WebSocket, and every
// one the 9000 sends back. Any UI talks to the 9000 only through shared.js, which speaks exactly this; the server and
// shared.js are checked against it (protocol.test.js), so a new message can't be added on one side only.
// PROTOCOL goes up when a message changes in a way an older screen would misread; the 9000 sends it in hello.
// Plain data, no DOM: the server imports it too.

export const PROTOCOL = 1;

// From a screen to the 9000 (JSON). The eye also sends camera frames as binary messages.
export const TO_SERVER = {
  set: 'merge into the ship\'s state: { state }. persona, voice and theme are settled together (personas/)',
  say: 'the eye speaks a line: { text }',
  ask: 'a question: { text, about?: panel code, tz }',
  drill: 'suggested questions about a panel: { code, part? }',
  focus: 'the panel being looked at: { code | null }',
  watch: 'this monitor shows the camera: { on }',
  snooze: 'snooze or remove a board panel: { code, minutes }',
  ack: 'acknowledge the alarm',
  runbook: 'save a steps card from the chat as a Know-how draft: { chat, card }',
  rate: 'right or wrong, for the scorecard: { case } or { code }, right',
  trial: 'a capability preview: { id, decision, digest?, text? }',
  plan: 'approve, reject or undo a plan: { id, decision, hash }',
  view: 'show a view: { id }',
  panel: 'which panel this monitor shows: { panel }',
  canvas: 'edit a panel: { op, ... }',
};

// From the 9000 to its screens (JSON). Binary messages are camera frames, to monitors that watch.
export const TO_SCREENS = {
  hello: 'on joining: { id, state, roster, protocol, personas: [{ id, name, product, voice }] }',
  state: 'part of the ship\'s state changed: { state, from? }',
  say: 'a line to speak and show: { text, parts?, interim? }',
  display: 'a panel to show: { display }',
  views: 'the views to choose from: { views, current }',
  board: 'the board on the monitors: { board }',
  activity: 'what the 9000 is doing now: { text }',
  talk: 'listening on or off: { on }',
  heard: 'a question was heard: { text, about? }',
  camera: 'the eye\'s camera on or off: { on }',
  drill: 'suggested questions about a panel: { code, part, title?, questions, smart?, done }',
  chat: 'the chat drawer: { history } on joining, then { entry }',
  roster: 'who is connected: { roster }',
  draft: 'to the monitor editing a panel: { code, panel?, view?, why?, refused?, closed? }',
  editing: 'who is editing which panel: { code, by }',
  rated: 'a rating was recorded: { case, code, right, ok }',
};

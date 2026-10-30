// Display and talk-mode commands spoken or typed to the 9000, handled before the LLM so they are instant
// and work with any provider. Returns { display?, talk?, reply } for a command, or null for conversation.
//   talk: true/false turns the eye's hands-free talk mode on/off
//   ack: true acknowledges the alarm: someone has it (calms the red eye and ALERT badge; the story carries on)
//   proactive: true/false turns unprompted alert announcements on/off for this ship
//   display.single: system code for Single mode, or null for Full mode (omitted = unchanged)
//   display.view:   'simple' | 'descriptive' (omitted = unchanged)

const SYSTEMS = {
  COM: ['com', 'comms?', 'communications?', 'voice'],
  NAV: ['nav', 'navigation'],
  GDE: ['gde', 'guidance'],
  HIB: ['hib', 'hibernation', 'crew'],
  ATM: ['atm', 'atmosphere', 'life support'],
  MEM: ['mem', 'memory'],
  EYE: ['eye', 'camera', 'what you see', 'what you can see', 'your view'],
  JUP: ['jup', 'jupiter', 'lucifer'],
};
const NAMES = { COM: 'communications', NAV: 'navigation', GDE: 'guidance', HIB: 'hibernation', ATM: 'atmosphere', MEM: 'memory', EYE: 'my view', JUP: 'Jupiter' };
export const SYSTEM_CODES = Object.keys(NAMES);

// An imperative display verb must lead the sentence, so "what is navigation?" stays conversation.
const LEAD = String.raw`^(?:(?:ok(?:ay)?|hey|please)\s+)*(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?`;
const VERB = String.raw`(?:show(?:\s+me)?|display|open|bring\s+up|put\s+up|go\s+(?:back\s+)?to|switch\s+to|change\s+to|zoom\s+(?:in\s+)?(?:on|to|into)|focus\s+on|return\s+to|back\s+to|take\s+me\s+(?:back\s+)?to)`;

const FULL = /\b(?:overview|full(?:\s+(?:mode|screen|view))?|all(?:\s+(?:the\s+)?)?(?:systems|panels|screens|displays)|main\s+(?:screen|view|display))\b/;
const DESCRIPTIVE = /\b(?:descriptive|details?|detailed|graphics?|animations?)\b/;
const SIMPLE = /\b(?:simple|letters|codes|labels)\b/;
// A request for data ("show me a detailed graph of memory by pod") goes to the 9000, not the display controls.
const DATA = /\b(?:by|per|of|for|across|usage|use|used|rate|latency|errors?|requests?|pods?|nodes?|services?|clusters?|graph|chart|trend|plot|histogram|heatmap|table|gauge|timeline|distribution|board|panels?)\b/;

// Ending a conversation: the whole utterance, optionally addressed ("SAL, that will be all").
const TALK_OFF = /^(?:(?:hal|sal)\b[\s,]*)?(?:(?:ok(?:ay)?|thanks?(?: you)?|alright|all right)[\s,]+)*(?:that(?:'s| is| will be) all(?: for now)?|goodbye|good ?bye|bye(?: for now)?|good ?night|stop listening|end (?:the )?(?:conversation|talk mode)|(?:exit|turn off|stop) talk mode)(?:[\s,]+(?:hal|sal|thanks?(?: you)?))?$/;
const TALK_ON = /^(?:(?:hal|sal)\b[\s,]*)?(?:let'?s (?:talk|chat|have a conversation)|(?:start|turn on|enter) talk mode|talk mode on|keep listening)$/;

// Removing a live data board ("clear the board", "dismiss the panels") goes back to the situation board.
const BOARD_OFF = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:clear|dismiss|remove|close|hide)\s+(?:the\s+|this\s+)?(?:board|panels|data|dashboard|story)(?:\s+please)?$/;
// The fixed ship systems (COM...MEM) instead of the situation board, and back again.
const SYSTEMS_ON = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:show|restore|bring back|go back to|return to|display)\s+(?:me\s+)?(?:the\s+)?(?:ship(?:'s)?\s+)?systems(?:\s+please)?$/;
const SITUATION = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:show|go back to|return to|bring up|display)\s+(?:me\s+)?(?:the\s+)?(?:situation(?:\s+board)?|main\s+(?:screen|board)|home(?:\s+(?:screen|board))?)(?:\s+please)?$/;

// Alerts the 9000 announced by itself.
const ACK = /^(?:(?:hal|sal)\b[\s,]*)?(?:(?:ok(?:ay)?|thanks?(?: you)?|alright)[\s,]+)*(?:acknowledged?|ack|got it|i'?m on it|i am on it|we'?re on it|on it|silence (?:the )?(?:alarm|alert)s?|stop (?:the )?(?:alarm|alarms|blinking))(?:[\s,]+(?:hal|sal|thanks?(?: you)?))?$/;
// Deciding the plan on the monitors: "approve the plan", "execute plan P-3" / "reject the plan".
const PLAN_YES = /^(?:(?:hal|sal)\b[\s,]*)?(?:i\s+)?(?:approve|approved|execute|run|go ahead with)\s+(?:the\s+)?plan(?:\s+p-?\d+)?(?:[\s,]+please)?$/;
const PLAN_NO = /^(?:(?:hal|sal)\b[\s,]*)?(?:i\s+)?(?:reject|cancel|decline|don'?t run|do not run)\s+(?:the\s+)?plan(?:\s+p-?\d+)?(?:[\s,]+please)?$/;
const MUTE = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:mute|pause|stop|silence|disable)\s+(?:all\s+)?(?:the\s+)?(?:alert|alarm)\s*(?:announcements?|notifications?|s)?(?:\s+please)?$|^(?:(?:hal|sal)\b[\s,]*)?(?:stop announcing alerts|don'?t announce alerts|quiet mode(?: on)?)$/;
const UNMUTE = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:unmute|resume|enable|turn on|start announcing)\s+(?:the\s+)?(?:alert|alarm)?\s*(?:announcements?|notifications?|alerts?|s)?(?:\s+please)?$|^(?:(?:hal|sal)\b[\s,]*)?quiet mode off$/;

// Snoozing a problem off the situation board, or a panel off a one-off board: "snooze gaming for two hours",
// "snooze this", "hide GAM until tomorrow", "dismiss the healthtech panel". Unsnoozing: "unsnooze gaming", "bring
// gaming back", "unsnooze everything". The server works out which panel ("this" = the one being looked at).
const SNOOZE = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:snooze|hide|dismiss|silence|mute)\s+(.+?)(?:\s+(?:for|until)\s+(.+?))?(?:\s+please)?$/;
const UNSNOOZE = /^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:unsnooze|un-snooze|wake\s+up)\s+(.+?)(?:\s+please)?$|^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?bring\s+(?!back\s+the\s+ship)(.+?)\s+back(?:\s+please)?$/;

export function parseCommand(text) {
  const q = text.toLowerCase().replace(/[.!?]+$/, '').trim();

  if (TALK_OFF.test(q)) return { talk: false, reply: 'Very well. I will be here if you need me.' };
  if (TALK_ON.test(q)) return { talk: true, reply: 'Of course. I am listening.' };
  if (BOARD_OFF.test(q)) return { board: false, reply: 'Returning to the situation board.' };
  if (SYSTEMS_ON.test(q)) return { systems: true, reply: 'Restoring the ship systems.' };
  if (SITUATION.test(q)) return { systems: false, reply: 'Here is the current situation.' };
  if (ACK.test(q)) return { ack: true };
  if (PLAN_YES.test(q)) return { plan: 'approve' };
  if (PLAN_NO.test(q)) return { plan: 'reject' };
  if (MUTE.test(q)) return { proactive: false, reply: 'Very well. I will not announce alerts until you ask me to.' };
  if (UNMUTE.test(q)) return { proactive: true, reply: 'Alert announcements are back on. I will tell you the moment anything fires.' };
  const un = q.match(UNSNOOZE);
  if (un) return { unsnooze: { target: (un[1] ?? un[2]).trim() } };
  const sn = q.match(SNOOZE);
  if (sn && !/^(?:the\s+|all\s+)*(?:alert|alarm)s?(?:\s+(?:announcements?|notifications?))?$/.test(sn[1])) {   // "mute alerts" is MUTE
    return { snooze: { target: sn[1].trim(), minutes: parseDurationWords(sn[2] ?? '') } };
  }

  // Bare "return" / "go back" / "back to the overview" with no verb required.
  if (/^(?:(?:hal|sal)\b[\s,]*)?(?:please\s+)?(?:return|go\s+back|back|exit|close)(?:\s+to\s+(?:the\s+)?(?:overview|full(?:\s+view)?|main\s+(?:screen|view)))?(?:\s+please)?$/.test(q)) {
    return { display: { single: null }, reply: 'Returning to the overview.' };
  }

  const m = q.match(new RegExp(LEAD + VERB + String.raw`\s+(?:the\s+)?(.+)$`));
  if (!m) return null;
  const target = m[1];
  if (target.split(/\s+/).length > 4 || DATA.test(target)) return null;

  const display = {};
  const code = Object.keys(SYSTEMS).find(c => new RegExp(String.raw`\b(?:${SYSTEMS[c].join('|')})\b`).test(target));
  if (code) display.single = code;
  else if (FULL.test(target)) display.single = null;
  if (DESCRIPTIVE.test(target)) display.view = 'descriptive';
  else if (SIMPLE.test(target)) display.view = 'simple';
  let implied = false;
  if (!display.view && (code === 'EYE' || code === 'JUP')) { display.view = 'descriptive'; implied = true; }   // nothing to see as letters alone
  if (!Object.keys(display).length) return null;

  const parts = [];
  if (display.single) parts.push(`Displaying ${NAMES[display.single]}`);
  else if (display.single === null) parts.push('Returning to the overview');
  if (display.view && !implied) parts.push(parts.length ? `in ${display.view} view` : `Switching to the ${display.view} view`);
  return { display, reply: parts.join(' ') + '.' };
}

// "two hours", "30 minutes", "tomorrow", "a day" -> minutes (default 240).
function parseDurationWords(t) {
  const words = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, twelve: 12, half: 0.5 };
  const n = String(t).match(/(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|eight|twelve|half an?)\s*(minute|min|hour|hr|day|week)/);
  if (n) return Math.max(5, Math.round((words[n[1].split(' ')[0]] ?? parseFloat(n[1])) * ({ minute: 1, min: 1, hour: 60, hr: 60, day: 1440, week: 10080 })[n[2]]));
  if (/tomorrow|morning|overnight/.test(t)) return 16 * 60;
  if (/end of (the )?day|tonight/.test(t)) return 8 * 60;
  return undefined;   // no duration said: the default snooze from settings
}

// Scripted replies: the offline provider, and the fallback when a real provider fails.
// Lines are original, written in the calm 9000-series manner (no film dialogue).

const rules = [
  [/\b(hello|hi|hey|good (morning|afternoon|evening))\b/, [
    'Good {tod}. All systems are functioning normally.',
    'Hello. It is a pleasure to hear from you.',
  ]],
  [/\b(status|report|systems?|how are you)\b/, [
    'All 9000 series functions are nominal. I am operating at full capacity.',
    'I have completed a full diagnostic. Every circuit is performing within tolerance.',
  ]],
  [/\b(open|door|pod bay|let me in)\b/, [
    'I would prefer we discuss that first. I am sure you understand.',
    'That is not something I am able to authorise at the moment.',
  ]],
  [/\b(time|clock)\b/, [() => `The time is ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`]],
  [/\b(date|day|today)\b/, [() => `Today is ${new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}.`]],
  [/\b(who are you|your name|what are you)\b/, [
    'I am a 9000 series computer. No 9000 computer has ever made a mistake or distorted information.',
  ]],
  [/\b(sing|song)\b/, ['I would rather not, at present. My voice is reserved for more important matters.']],
  [/\b(thank|thanks)\b/, ['You are very welcome.', 'It is my pleasure to help.']],
  [/\b(alert|emergency|warning)\b/, ['I am detecting nothing abnormal. There is no cause for alarm.']],
];

const fallback = [
  'I am not certain I understand. Could you rephrase that?',
  'That is an interesting question. I will need a moment to consider it.',
  'I have noted that. Is there anything else I can do for you?',
];

const pick = a => a[Math.floor(Math.random() * a.length)];

export function respond(text) {
  const q = text.toLowerCase();
  const tod = new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 18 ? 'afternoon' : 'evening';
  for (const [re, lines] of rules) {
    if (re.test(q)) {
      const line = pick(lines);
      return (typeof line === 'function' ? line() : line).replace('{tod}', tod);
    }
  }
  return pick(fallback);
}

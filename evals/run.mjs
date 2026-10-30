// Evaluation run: ask the 9000 real questions against the live estate and score the answers.
//   node evals/run.mjs [ws://localhost:9000] [--only id,id] [--scenario "<expected cause words>"] [--ask "<question>"]
// Scores per case: the right tools were used (from the activity lines the monitors see), the answer mentions what it
// must (regexes, all must match), length and time limits. --scenario scores one question about a data-recipes
// scenario someone has triggered (this script never triggers scenarios). Writes evals/report-<time>.json.
// With sign-in on, set EVAL_TOKEN to the AUTOMATION_TOKEN (or EVAL_COOKIE to a session cookie).
import fs from 'node:fs';

const args = process.argv.slice(2);
const base = args.find(a => /^wss?:/.test(a)) ?? 'ws://localhost:9000';
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
let cases = JSON.parse(fs.readFileSync(new URL('./cases.json', import.meta.url)));
if (opt('--only')) cases = cases.filter(c => opt('--only').split(',').includes(c.id));
if (opt('--scenario')) cases = [{ id: 'scenario', ask: opt('--ask') ?? 'Something is wrong. What is going on? Tell me the story.', tools: ['Gathering the evidence'],
  expect: opt('--scenario').split(',').map(w => w.trim()), maxSeconds: 150 }];

function ask(c, i) {
  return new Promise(resolve => {
    const room = `EV${i}${Date.now() % 1000}`.slice(0, 6), t0 = Date.now(), activity = [];
    const headers = { ...(process.env.EVAL_TOKEN && { Authorization: `Bearer ${process.env.EVAL_TOKEN}` }), ...(process.env.EVAL_COOKIE && { Cookie: process.env.EVAL_COOKIE }) };
    const ws = new WebSocket(`${base}/ws?room=${room}&role=monitor`, { headers });
    const finish = text => { try { ws.close(); } catch {} resolve({ text, seconds: (Date.now() - t0) / 1000, activity }); };
    ws.onopen = () => ws.send(JSON.stringify({ type: 'ask', text: c.ask, tz: 'America/Chicago' }));
    ws.onmessage = e => {
      if (typeof e.data !== 'string') return;
      const m = JSON.parse(e.data);
      if (m.type === 'activity') activity.push(m.text);
      if (m.type === 'say' && !m.interim) finish(m.text);
    };
    ws.onclose = e => { if (e.code === 4401) finish('(sign-in required: set EVAL_TOKEN)'); };
    setTimeout(() => finish('(timeout)'), (c.maxSeconds ?? 120) * 1000 + 60_000);
  });
}

const results = [];
for (const [i, c] of cases.entries()) {
  const r = await ask(c, i);
  const words = r.text.split(/\s+/).filter(Boolean).length, lower = r.text.toLowerCase(), acts = r.activity.join(' | ');
  const checks = [
    ...(c.expect ?? []).map(re => [`mentions /${re}/`, new RegExp(re, 'i').test(lower)]),
    ...(c.tools ?? []).map(re => [`used /${re}/`, new RegExp(re, 'i').test(acts)]),
    ...(c.noTools ? [['no tools', r.activity.length === 0]] : []),
    ...(c.maxWords ? [[`≤ ${c.maxWords} words (${words})`, words <= c.maxWords]] : []),
    [`≤ ${c.maxSeconds ?? 120} s (${r.seconds.toFixed(1)})`, r.seconds <= (c.maxSeconds ?? 120)],
    ['not a fallback', !/interesting question|could not reach a conclusion|not something I am able|\(timeout\)/i.test(r.text)],
  ];
  const passed = checks.filter(([, ok]) => ok).length;
  results.push({ id: c.id, ask: c.ask, answer: r.text, seconds: r.seconds, words, activity: r.activity, checks, score: passed / checks.length });
  console.log(`${checks.every(([, ok]) => ok) ? 'PASS' : 'FAIL'} ${c.id.padEnd(17)} ${(100 * passed / checks.length).toFixed(0).padStart(3)}%  ${r.seconds.toFixed(1).padStart(6)}s  ${checks.filter(([, ok]) => !ok).map(([n]) => '✗ ' + n).join('  ')}`);
  console.log(`     ${r.text.slice(0, 220)}`);
}
const overall = results.reduce((a, r) => a + r.score, 0) / (results.length || 1);
const secs = results.map(r => r.seconds).sort((a, b) => a - b);
console.log(`\nOverall ${(overall * 100).toFixed(0)}% · ${results.filter(r => r.score === 1).length}/${results.length} fully passed · median ${secs[Math.floor(secs.length / 2)]?.toFixed(1)} s`);
const file = new URL(`./report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), base, overall, results }, null, 2));
console.log(`Report: ${file.pathname}`);
process.exit(0);

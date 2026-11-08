// The preview workflow's side of the 9000's capability requests (capabilities/index.js), with no dependencies.
// The 9000 never deploys: this workflow builds and applies previews and reports them back through the deployer API.
//
//   node .github/preview/hal.mjs evals <prod.json> <preview.json>        -> evals JSON on stdout ({prod, preview, regressed})
//   node .github/preview/hal.mjs preview <pr> <url> <digest> [evals.json] record a preview on the request for this PR
//   node .github/preview/hal.mjs torn-down <pr> [url]                     the preview for this PR is gone
//   node .github/preview/hal.mjs teardowns                                 "<pr> <url>" per preview of this repo the 9000 wants removed
//   node .github/preview/hal.mjs comment <pr> <markdown file>             create or update the workflow's comment on the PR
//
// Env: HAL_URL, HAL_DEPLOYER_TOKEN (Settings → Capabilities → Deployer token), GITHUB_REPOSITORY, GITHUB_TOKEN.
// A PR that no capability request opened (a person's own PR) still gets its preview and comment; there is just no
// request to record it on.
import fs from 'node:fs';

const [cmd, ...args] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const HAL = (process.env.HAL_URL ?? '').replace(/\/$/, '');

async function hal(path, body) {
  if (!HAL || !process.env.HAL_DEPLOYER_TOKEN) throw new Error('HAL_URL and HAL_DEPLOYER_TOKEN are needed');
  const res = await fetch(`${HAL}${path}`, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${process.env.HAL_DEPLOYER_TOKEN}`, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${data.error ?? ''}`);
  return data;
}
const requestFor = async pr => (await hal('/api/capabilities')).requests.filter(q => q.repository === repo && q.pr?.number === Number(pr))
  .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

if (cmd === 'evals') {
  // Each report: { overall, results: [{ id, score }] }. A case regressed if it fully passed in production and not here.
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const [prod, prev] = args.map(read);
  const tally = r => (r ? `${r.results.filter(x => x.score === 1).length}/${r.results.length}` : '?');
  const regressed = prod && prev ? prev.results.filter(x => x.score < 1 && prod.results.find(p => p.id === x.id)?.score === 1).map(x => x.id) : [];
  console.log(JSON.stringify({ prod: tally(prod), preview: tally(prev), regressed }));
} else if (cmd === 'preview') {
  const [pr, url, digest, evalsFile] = args;
  const q = await requestFor(pr);
  if (!q) { console.log(`No capability request for ${repo}#${pr}; nothing to record.`); process.exit(0); }
  const evals = evalsFile && fs.existsSync(evalsFile) ? JSON.parse(fs.readFileSync(evalsFile, 'utf8')) : undefined;
  await hal(`/api/capabilities/${q.id}/preview`, { url, digest, ...(evals && { evals }) });
  console.log(`${q.id} is ready to try: ${url} (${digest})`);
} else if (cmd === 'torn-down') {
  const [pr, url] = args;
  const q = await requestFor(pr);
  if (q) { await hal(`/api/capabilities/${q.id}/torn-down`, url ? { url } : {}); console.log(`${q.id}: preview torn down`); }
} else if (cmd === 'teardowns') {
  for (const q of (await hal('/api/capabilities')).requests.filter(x => x.repository === repo))
    for (const w of q.wants ?? []) if (w.action === 'teardown' && w.pr) console.log(`${w.pr} ${w.url}`);
} else if (cmd === 'comment') {
  const [pr, file] = args, marker = '<!-- preview-workflow -->', body = `${marker}\n${fs.readFileSync(file, 'utf8')}`;
  const gh = (path, init = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, { ...init,
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } }).then(r => r.json());
  const mine = (await gh(`/issues/${pr}/comments?per_page=100`)).find?.(c => c.body?.startsWith(marker));
  await gh(mine ? `/issues/comments/${mine.id}` : `/issues/${pr}/comments`, { method: mine ? 'PATCH' : 'POST', body: JSON.stringify({ body }) });
} else {
  console.error('usage: hal.mjs evals|preview|torn-down|teardowns|comment …');
  process.exit(2);
}

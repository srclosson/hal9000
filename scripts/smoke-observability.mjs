// Opt-in real-browser smoke test. Uses Chrome's DevTools protocol, no extra test dependencies.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const received = [], failures = [];
const collector = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  received.push({ path: req.url, body: JSON.parse(raw) });
  res.setHeader('Content-Type', 'application/json'); res.end('{}');
});
collector.listen(0, '127.0.0.1'); await once(collector, 'listening');
const base = `http://127.0.0.1:${collector.address().port}`;
const reservation = http.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const app = spawn(process.execPath, ['--import', './telemetry/bootstrap.js', 'server.js'], { env: {
  PATH: process.env.PATH, PORT: String(port), LLM_PROVIDER: 'scripted', FARO_COLLECTOR_URL: `${base}/collect`,
  OTEL_EXPORTER_OTLP_ENDPOINT: base, DEPLOYMENT_ENV: 'test',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let appOutput = ''; app.stdout.on('data', data => { appOutput += data; }); app.stderr.on('data', data => { appOutput += data; });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hal-faro-smoke-'));
let chrome, socket;
const deadline = setTimeout(() => { console.error('Browser smoke timed out', appOutput, failures); app.kill('SIGKILL'); chrome?.kill('SIGKILL'); process.exit(1); }, 30000);
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await wait(50);
  }
  chrome = spawn(process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${temp}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const debuggerUrl = await new Promise((resolve, reject) => {
    let output = '';
    chrome.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
    chrome.on('error', reject);
  });
  socket = new WebSocket(debuggerUrl); await once(socket, 'open');
  let id = 0; const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method === 'Network.loadingFailed') failures.push(message.params);
    const handler = pending.get(message.id);
    if (handler) { pending.delete(message.id); message.error ? handler.reject(new Error(JSON.stringify(message.error))) : handler.resolve(message.result); }
  });
  const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id; pending.set(n, { resolve, reject }); socket.send(JSON.stringify({ id: n, method, params, ...(sessionId && { sessionId }) }));
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => call(method, params, sessionId);
  await page('Runtime.enable'); await page('Page.enable'); await page('Network.enable');
  await page('Page.navigate', { url: `http://127.0.0.1:${port}/monitor?room=PRIVATE` });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    const result = await page('Runtime.evaluate', { expression: 'Boolean(window.HALObservability)' });
    if (result.result.value) { ready = true; break; } await wait(50);
  }
  assert(ready, 'Faro did not initialize');
  const result = await page('Runtime.evaluate', { expression: `(async () => {
    await fetch('/api/observability?token=PRIVATE');
    const {connect} = await import('/shared.js');
    const c = connect({ room: 'PRIVATE', role: 'monitor' });
    await new Promise(r => setTimeout(r, 100)); c.ask('PRIVATE QUESTION');
    window.HALObservability.record('smoke.safe');
    setTimeout(() => { throw new Error('PRIVATE ERROR'); }, 0);
    return true;
  })()`, awaitPromise: true, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  await wait(6500);
  const faro = received.filter(item => item.path === '/collect');
  assert(faro.length, `No Faro batches; network failures: ${JSON.stringify(failures)}`);
  assert(!JSON.stringify(faro).includes('PRIVATE'), 'Private browser content leaked');
  assert(faro.some(item => item.body.exceptions?.length), 'Missing captured frontend error');
  assert(faro.some(item => item.body.traces?.resourceSpans?.length), 'Missing browser traces');
  const browserSpans = faro.flatMap(item => (item.body.traces?.resourceSpans || []).flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert(browserSpans.some(span => span.name === 'websocket.ask'), 'Missing WebSocket action span');
  const serverSpans = received.filter(item => item.path === '/v1/traces').flatMap(item => item.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
  assert(serverSpans.some(span => browserSpans.some(parent => parent.traceId === span.traceId && parent.spanId === span.parentSpanId)), 'Browser/server trace not correlated');
  console.log(`Chrome Faro smoke passed: ${faro.length} batches; errors, browser spans, WebSocket actions, server correlation and privacy verified`);

  // Browser privacy preference must prevent Faro initialization entirely, independently of backend tracing.
  await page('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator, 'doNotTrack', {get: () => '1'})" });
  await page('Page.navigate', { url: `http://127.0.0.1:${port}/settings` });
  await wait(1000);
  const disabled = await page('Runtime.evaluate', { expression: 'window.HALObservability === undefined' });
  assert.equal(disabled.result.value, true, 'Do Not Track did not disable Faro');
  console.log('Do Not Track smoke passed');
} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  app.kill('SIGTERM'); if (app.exitCode === null) await once(app, 'close');
  collector.close(); await fs.rm(temp, { recursive: true, force: true });
  clearTimeout(deadline);
}

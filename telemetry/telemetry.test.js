import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { endpoint, headers, publicConfig, routeOf, redact } from './settings.js';
import { browserUrl, scrubItem } from '../public/observability-privacy.js';

test('route labels and URLs cannot include room codes, clip IDs or secrets', () => {
  assert.equal(routeOf('/tts/abcdef?token=secret'), '/tts/:id');
  assert.equal(routeOf('/ws?room=PRIVATE'), '/ws');
  assert.equal(routeOf('/arbitrary-user-input'), '/:unmatched');
  assert.equal(routeOf('/api/capabilities/CR-123/preview'), '/api/capabilities/:action');
  assert.equal(browserUrl('https://hal.test/monitor?room=PRIVATE#token'), 'https://hal.test/monitor');
  assert.equal(browserUrl('https://hal.test/auth/callback?code=SECRET'), 'https://hal.test/:resource');
  assert(!redact('Bearer PRIVATE https://user:password@hal.test/ws?room=PRIVATE token=PRIVATE').includes('PRIVATE'));
});

test('Faro payload privacy removes identities, query strings and error contents', () => {
  const cleaned = scrubItem({ type: 'exception', meta: { user: { email: 'private@test' }, page: { url: 'https://hal.test/eye?room=PRIVATE' } },
    payload: { value: 'chat PRIVATE', type: 'TypeError', stacktrace: { frames: [{ filename: 'https://hal.test/shared.js?token=PRIVATE', lineno: 10 }] },
      context: { text: 'PRIVATE', title: 'PRIVATE' } } });
  assert(!JSON.stringify(cleaned).includes('PRIVATE'));
  assert(!cleaned.meta.user);
  assert.equal(cleaned.payload.type, 'TypeError');
  assert.equal(cleaned.payload.stacktrace.frames[0].lineno, 10);
});

test('per-signal endpoints/headers and public Faro config use explicit allowlists', () => {
  const old = { ...process.env };
  try {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://collector:4318/';
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = 'http://logs/v1/logs';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=Basic%20PRIVATE,broken=%xx,tenant=a=b';
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS;
    assert.equal(endpoint('metrics'), 'http://collector:4318/v1/metrics');
    assert.equal(endpoint('logs'), 'http://logs/v1/logs');
    assert.deepEqual(headers('logs'), { Authorization: 'Basic PRIVATE', tenant: 'a=b' });
    process.env.FARO_COLLECTOR_URL = 'https://faro.test/collect/public-id';
    process.env.FARO_SESSION_SAMPLE_RATE = '0.25';
    const config = publicConfig();
    assert.equal(config.sampleRate, .25);
    assert.equal(config.enabled, true);
    assert(!JSON.stringify(config).includes('PRIVATE'));
    process.env.FARO_COLLECTOR_URL = 'https://user:PRIVATE@faro.test/collect';
    assert.deepEqual(publicConfig(), { enabled: false });
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
function run(source, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: new URL('..', import.meta.url), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`telemetry child timed out: ${stderr}`)); }, 15000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`child exit ${code}: ${stderr}\n${stdout}`)); });
  });
}

test('real OTLP export correlates browser context, model/tool/outbound spans and logs; flushes metrics', async t => {
  const received = [];
  const collector = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, body: JSON.parse(raw), auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  const target = http.createServer((req, res) => res.end('ok'));
  t.after(() => { collector.close(); target.close(); });
  const collectorUrl = await listen(collector), targetUrl = await listen(target);
  const result = await run(`
    await import('./telemetry/bootstrap.js');
    const { startTurn, shutdown } = await import('./telemetry/index.js');
    const { operation, context, remoteContext } = await import('./telemetry/spans.js');
    const { observeHttp } = await import('./telemetry/http.js');
    const http = await import('node:http');
    const app = http.createServer(observeHttp(async (req, res) => {
      const turn = startTurn('PRIVATE QUESTION', { model: 'test-model' });
      await turn.run(async () => {
        const start = Date.now();
        await operation('llm.call', { 'gen_ai.request.model': 'test-model' }, async () => {
          await fetch(process.env.TARGET_URL + '/private-id?token=PRIVATE');
          return { usage: { in: 10, out: 5 } };
        });
        turn.model(Date.now() - start, { in: 10, out: 5 });
        await operation('tool.call', { 'hal9000.tool': 'test' }, async () => 'Error: unavailable');
        turn.tool('test', 2, false);
        console.info('correlated log Bearer PRIVATE');
        turn.end('answered');
      });
      res.end('ok');
    }));
    app.listen(0, '127.0.0.1'); await new Promise(resolve => app.once('listening', resolve));
    await fetch('http://127.0.0.1:' + app.address().port + '/api/settings?token=PRIVATE', {
      headers: { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01' }
    });
    await new Promise(resolve => app.close(resolve));
    await shutdown();
  `, { OTEL_EXPORTER_OTLP_ENDPOINT: collectorUrl, OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20TEST',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    OTEL_SDK_DISABLED: 'false', PYROSCOPE_SERVER_ADDRESS: '', TARGET_URL: targetUrl, LOG_FORMAT: 'json' });
  const spans = received.filter(x => x.path === '/v1/traces').flatMap(x => x.body.resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans)));
  assert(spans.length >= 5, `expected HTTP/turn/model/tool/outbound spans, got ${spans.map(s => s.name)}; ${result.stderr}`);
  const turn = spans.find(s => s.name === 'conversation.turn'), model = spans.find(s => s.name === 'llm.call');
  assert.equal(turn.traceId, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(model.parentSpanId, turn.spanId);
  assert.equal(spans.find(s => s.name === 'tool.call').status.code, 2);
  const logs = received.filter(x => x.path === '/v1/logs').flatMap(x => x.body.resourceLogs.flatMap(r => r.scopeLogs.flatMap(s => s.logRecords)));
  assert(logs.some(log => log.traceId === turn.traceId && log.spanId === turn.spanId));
  const metrics = received.filter(x => x.path === '/v1/metrics').flatMap(x => x.body.resourceMetrics.flatMap(r => r.scopeMetrics.flatMap(s => s.metrics)));
  for (const name of ['hal9000.turns', 'hal9000.model.tokens', 'process.memory.usage', 'http.server.request.duration']) assert(metrics.some(m => m.name === name), name);
  assert(received.every(x => x.auth === 'Basic TEST'));
  assert(!JSON.stringify(received).includes('PRIVATE'));
  assert(!result.stdout.includes('PRIVATE'));
});

test('HTTP error boundaries return 500 rather than rejecting out of the server', async () => {
  await run(`
    const http = await import('node:http');
    const { observeHttp } = await import('./telemetry/http.js');
    const { shutdown } = await import('./telemetry/index.js');
    const app = http.createServer(observeHttp(() => { throw new TypeError('PRIVATE'); }));
    app.listen(0, '127.0.0.1'); await new Promise(resolve => app.once('listening', resolve));
    const r = await fetch('http://127.0.0.1:' + app.address().port + '/bad');
    if (r.status !== 500 || await r.text() !== 'Internal server error') throw new Error('missing HTTP error boundary');
    await new Promise(resolve => app.close(resolve)); await shutdown();
  `, { OTEL_SDK_DISABLED: 'true', PYROSCOPE_SERVER_ADDRESS: '' });
});

test('WebSocket metrics count both directions and errors without room labels', async () => {
  const { observeSocket, runtimeMetrics } = await import('./runtime.js');
  const socket = new EventEmitter(); socket.role = 'eye'; socket.code = 'PRIVATE'; socket.send = () => {};
  observeSocket(socket);
  socket.emit('message', Buffer.from('abc'));
  socket.send('hello'); socket.emit('error', new Error('PRIVATE')); socket.emit('close');
  const collected = runtimeMetrics((name, unit, value, attributes) => ({ name, value, attributes }), (key, value) => ({ key, value }));
  assert.equal(collected.find(m => m.name === 'hal9000.websocket.received').value, 1);
  assert.equal(collected.find(m => m.name === 'hal9000.websocket.inBytes').value, 3);
  assert.equal(collected.find(m => m.name === 'hal9000.websocket.outBytes').value, 5);
  assert.equal(collected.find(m => m.name === 'hal9000.websocket.errors').value, 1);
  assert.equal(collected.find(m => m.name === 'hal9000.websocket.active').gauge.dataPoints[0].asDouble, 0);
  assert(!JSON.stringify(collected).includes('PRIVATE'));
});

test('collector outages are non-fatal and log storms have bounded buffers and drop counters', async t => {
  let requests = 0;
  const collector = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* drain */ }
    requests++; res.writeHead(503); res.end('unavailable');
  });
  t.after(() => collector.close());
  const url = await listen(collector);
  const result = await run(`
    const { shutdown, metrics } = await import('./telemetry/index.js');
    for (let i = 0; i < 520; i++) console.info('storm', i);
    await shutdown();
    const all = metrics();
    const value = name => all.find(m => m.name === name).sum.dataPoints[0].asDouble;
    process.stdout.write(JSON.stringify({ failures: value('hal9000.telemetry.export.failures'), dropped: value('hal9000.telemetry.logs.dropped') }) + '\\n');
  `, { OTEL_EXPORTER_OTLP_ENDPOINT: url, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: '', OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: '',
    OTEL_SDK_DISABLED: 'false', PYROSCOPE_SERVER_ADDRESS: '', LOG_FORMAT: 'json' });
  const counts = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(counts.failures, 2); assert.equal(counts.dropped, 20); assert.equal(requests, 2);
  assert.equal(result.stderr.trim().split('\n').length, 1, 'outage diagnostics should be rate limited');
});

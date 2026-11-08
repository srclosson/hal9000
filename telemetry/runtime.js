import { performance, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import { profiling } from './bootstrap.js';

const started = Date.now(), delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
let gcCount = 0, gcMs = 0, previousELU = performance.eventLoopUtilization();
const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcCount++; gcMs += entry.duration; } });
observer.observe({ entryTypes: ['gc'] });
const requests = new Map(), sockets = new Map();
const bounds = [.005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, 120];
export function recordRequest(method, route, status, seconds) {
  const safeMethod = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : '_OTHER';
  const key = `${safeMethod} ${route} ${status}`;
  if (!requests.has(key)) requests.set(key, { method: safeMethod, route, status, count: 0, sum: 0, buckets: bounds.map(() => 0).concat(0) });
  const r = requests.get(key); r.count++; r.sum += seconds;
  const index = bounds.findIndex(b => seconds <= b); r.buckets[index < 0 ? bounds.length : index]++;
}
const socketStats = role => {
  const key = role === 'eye' ? 'eye' : 'monitor';
  if (!sockets.has(key)) sockets.set(key, { active: 0, connections: 0, errors: 0, received: 0, sent: 0, inBytes: 0, outBytes: 0 });
  return sockets.get(key);
};
export function observeSocket(ws) {
  const stats = socketStats(ws.role); stats.active++; stats.connections++;
  ws.once('close', () => stats.active--);
  ws.on('error', () => { stats.errors++; });
  ws.on('message', raw => { stats.received++; stats.inBytes += raw.byteLength ?? raw.length ?? 0; });
  const send = ws.send;
  ws.send = function(data, ...args) {
    stats.sent++; stats.outBytes += typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength ?? data.length ?? 0;
    return send.call(this, data, ...args);
  };
}
export function runtimeMetrics(sum, attr) {
  const now = String(BigInt(Date.now()) * 1_000_000n), start = String(BigInt(started) * 1_000_000n);
  const gauge = (name, unit, value, attributes = []) => ({ name, unit, gauge: { dataPoints: [{ timeUnixNano: now, asDouble: Number.isFinite(value) ? value : 0, attributes }] } });
  const memory = process.memoryUsage(), cpu = process.cpuUsage(), heap = v8.getHeapStatistics();
  const elu = performance.eventLoopUtilization(previousELU); previousELU = performance.eventLoopUtilization();
  const out = [gauge('process.uptime', 's', process.uptime()), gauge('process.memory.usage', 'By', memory.rss),
    gauge('v8js.memory.heap.limit', 'By', heap.heap_size_limit), gauge('nodejs.eventloop.utilization', '1', elu.utilization),
    gauge('nodejs.eventloop.delay.p99', 's', delay.percentile(99) / 1e9), gauge('nodejs.eventloop.delay.max', 's', delay.max / 1e9),
    sum('process.cpu.time', 's', cpu.user / 1e6, [attr('state', 'user')]), sum('process.cpu.time', 's', cpu.system / 1e6, [attr('state', 'system')]),
    sum('nodejs.gc.collections', '{collection}', gcCount), sum('nodejs.gc.duration', 's', gcMs / 1000),
    gauge('hal9000.profiling.enabled', '1', Number(profiling.enabled))];
  delay.reset();
  for (const key of ['heapUsed', 'heapTotal', 'external', 'arrayBuffers']) out.push(gauge('nodejs.memory.usage', 'By', memory[key], [attr('type', key)]));
  for (const r of requests.values()) out.push({ name: 'http.server.request.duration', unit: 's', histogram: {
    aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: start, timeUnixNano: now, count: String(r.count), sum: r.sum,
      explicitBounds: bounds, bucketCounts: r.buckets.map(String), attributes: [attr('http.request.method', r.method), attr('http.route', r.route), attr('http.response.status_code', r.status)] }] } });
  for (const [role, stats] of sockets) {
    const attrs = [attr('role', role)];
    out.push(gauge('hal9000.websocket.active', '{connection}', stats.active, attrs));
    for (const key of ['connections', 'errors', 'received', 'sent', 'inBytes', 'outBytes']) out.push(sum(`hal9000.websocket.${key}`, key.endsWith('Bytes') ? 'By' : '{event}', stats[key], attrs));
  }
  return out;
}

import fs from 'node:fs';

export const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const service = process.env.OTEL_SERVICE_NAME || 'hal9000';
export const environment = process.env.DEPLOYMENT_ENV || 'production';
export const enabled = process.env.OTEL_SDK_DISABLED !== 'true';
export const resourceAttributes = {
  'service.name': service, 'service.version': version, 'deployment.environment': environment,
  'deployment.environment.name': environment,
  ...(process.env.CLUSTER_NAME && { cluster: process.env.CLUSTER_NAME, 'k8s.cluster.name': process.env.CLUSTER_NAME }),
  ...(process.env.POD_NAME && { 'service.instance.id': process.env.POD_NAME, 'k8s.pod.name': process.env.POD_NAME }),
  ...(process.env.POD_NAMESPACE && { 'k8s.namespace.name': process.env.POD_NAMESPACE }),
  ...(process.env.CLUSTER_NAME && { 'k8s.deployment.name': 'hal9000' }),
  ...(process.env.NODE_NAME && { 'k8s.node.name': process.env.NODE_NAME }),
};
export function endpoint(signal) {
  if (!enabled) return '';
  return process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] ||
    (process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, '')}/v1/${signal}` : '');
}
export function headers(signal) {
  const raw = process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`] ?? process.env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
  return Object.fromEntries(raw.split(',').flatMap(pair => {
    const i = pair.indexOf('=');
    if (i < 1) return [];
    try { return [[pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1).trim())]]; } catch { return []; }
  }));
}

// Only bounded route templates become metric labels or server span names. Never room codes, clip IDs or queries.
const routes = new Set(['/', '/index.html', '/eye', '/eye.html', '/monitor', '/monitor.html', '/dashboard', '/dashboard.html',
  '/settings', '/settings.html', '/healthz', '/ws', '/qr.svg', '/favicon.ico', '/api/lan', '/api/settings',
  '/api/metrics', '/api/metrics/labels', '/api/metrics/values', '/api/observability']);
export function routeOf(value) {
  const path = String(value || '/').split(/[?#]/, 1)[0];
  if (routes.has(path)) return path;
  if (path.startsWith('/auth/')) return '/auth/:action';
  if (path.startsWith('/tts/')) return '/tts/:id';
  if (path.startsWith('/try/')) return '/try/:id';
  if (path.startsWith('/api/capabilities')) return '/api/capabilities/:action';
  if (path.startsWith('/api/mcp-servers')) return '/api/mcp-servers/:id';
  if (/^\/(?:icons|assets)\//.test(path) || /^\/[\w-]+\.(?:js|css|webmanifest)$/.test(path)) return '/:asset';
  return '/:unmatched';
}
export function safeUrl(value) {
  try { const u = new URL(value); return `${u.origin}${routeOf(u.pathname)}`; } catch { return routeOf(value); }
}
export function redact(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, safeUrl)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.%-]+/gi, '$1 [REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function publicConfig() {
  const url = process.env.FARO_COLLECTOR_URL;
  if (!url) return { enabled: false };
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return { enabled: false };
  } catch { return { enabled: false }; }
  const rate = Number(process.env.FARO_SESSION_SAMPLE_RATE ?? 1);
  return { enabled: true, url, app: { name: `${service}-web`, version, environment },
    sampleRate: Number.isFinite(rate) ? Math.max(0, Math.min(1, rate)) : 1 };
}

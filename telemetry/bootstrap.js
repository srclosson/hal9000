// Preloaded before application modules so core HTTP and fetch are instrumented before first use.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { endpoint, headers, resourceAttributes, safeUrl, routeOf, redact, service, environment } from './settings.js';

let sdk, profiler;
export const profiling = { enabled: false, available: false };
const traceEndpoint = endpoint('traces');
const collectorOrigins = new Set([endpoint('traces'), endpoint('metrics'), endpoint('logs'), process.env.PYROSCOPE_SERVER_ADDRESS]
  .filter(Boolean).flatMap(url => { try { return [new URL(url).origin]; } catch { return []; } }));
const isCollector = value => { try { return collectorOrigins.has(new URL(value).origin); } catch { return false; } };

// Sanitize at the export boundary too: HTTP instrumentations can add attributes after request hooks.
export function sanitizeSpan(span) {
  const attributes = Object.fromEntries(Object.entries(span.attributes).filter(([key]) => !/header|body|query|cookie|authorization/i.test(key))
    .map(([key, value]) => [key, typeof value !== 'string' ? value : /url|uri/i.test(key) ? safeUrl(value)
      : key === 'http.target' ? routeOf(value) : redact(value)]));
  // Preserve ReadableSpan's prototype methods (notably spanContext) for the SDK exporter.
  return Object.create(span, {
    attributes: { value: attributes },
    events: { value: span.events.map(event => ({ ...event,
      attributes: Object.fromEntries(Object.entries(event.attributes ?? {}).filter(([key]) => !/exception\.(message|stacktrace)/.test(key))) })) },
  });
}
if (traceEndpoint) {
  const exporter = new OTLPTraceExporter({ url: traceEndpoint, headers: headers('traces'), timeoutMillis: 5000 });
  sdk = new NodeSDK({
    resource: resourceFromAttributes(resourceAttributes), autoDetectResources: false,
    // HAL exports its existing domain/runtime metrics and logs itself; don't start duplicate SDK exporters.
    metricReaders: [], logRecordProcessors: [],
    traceExporter: {
      export: (spans, callback) => exporter.export(spans.map(sanitizeSpan), callback),
      shutdown: () => exporter.shutdown(), forceFlush: () => exporter.forceFlush(),
    },
    instrumentations: [new HttpInstrumentation({
      // Server spans are created in our handler, with bounded routes and an explicit async-error boundary.
      disableIncomingRequestInstrumentation: true,
      ignoreOutgoingRequestHook: req => isCollector(`${req.protocol || 'http:'}//${req.hostname || req.host}`),
    }), new UndiciInstrumentation({ ignoreRequestHook: req => isCollector(req.origin) })],
  });
  sdk.start();
}

if (process.env.PYROSCOPE_SERVER_ADDRESS && process.env.PYROSCOPE_ENABLED !== 'false') {
  try {
    profiler = (await import('@pyroscope/nodejs')).default;
    profiler.setLogger({ error: () => console.error('Profiling export failed'), warn: () => console.warn('Profiling warning'),
      fatal: () => console.error('Profiling failure'), info() {}, debug() {}, trace() {} });
    profiler.init({ appName: process.env.PYROSCOPE_APPLICATION_NAME || service,
      serverAddress: process.env.PYROSCOPE_SERVER_ADDRESS,
      basicAuthUser: process.env.PYROSCOPE_BASIC_AUTH_USER,
      basicAuthPassword: process.env.PYROSCOPE_BASIC_AUTH_PASSWORD,
      authToken: process.env.PYROSCOPE_AUTH_TOKEN,
      tags: { 'service.name': service, 'service.version': resourceAttributes['service.version'], environment,
        ...(process.env.CLUSTER_NAME && { cluster: process.env.CLUSTER_NAME }) },
      wall: { collectCpuTime: true },
    });
    profiler.start(); // wall/CPU and allocation sampling (not heap snapshots)
    profiling.enabled = profiling.available = true;
  } catch {
    profiler = undefined;
    console.warn('Profiling unavailable on this runtime/platform; HAL will continue without profiles');
  }
}
export async function shutdownTracing() {
  await Promise.allSettled([sdk?.shutdown(), profiler?.stop()]);
}

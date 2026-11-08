import { initializeFaro, getWebInstrumentations } from '@grafana/faro-web-sdk';
import { TracingInstrumentation } from '@grafana/faro-web-tracing';
import { pageName, scrubItem } from '../public/observability-privacy.js';

async function start() {
  // Privacy preference is honored before contacting the collector or creating session identifiers.
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
  const response = await fetch('/api/observability', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
  if (!response.ok) return;
  const config = await response.json();
  if (!config.enabled) return;
  const faro = initializeFaro({
    url: config.url, app: config.app,
    sessionTracking: { enabled: true, persistent: false, samplingRate: config.sampleRate },
    trackResources: true,
    // Do not capture console arguments or DOM-derived action names (chat and settings contain sensitive text).
    instrumentations: [
      ...getWebInstrumentations({ captureConsole: false }).filter(i => !/user-action|frustration/i.test(i.name)),
      new TracingInstrumentation({ omitTraceContextForUnsampledSessions: true,
        instrumentationOptions: { propagateTraceHeaderCorsUrls: [new RegExp(`^${location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)] } }),
    ],
    beforeSend: scrubItem,
  });
  faro.api.setView({ name: pageName(location.pathname) });
  window.HALObservability = {
    record(name, attributes = {}) { faro.api.pushEvent(name, attributes); },
    send(message, transmit) {
      if (!['ask', 'drill', 'plan', 'trial', 'canvas'].includes(message.type)) return transmit(message);
      const otel = faro.api.getOTEL();
      if (!otel) return transmit(message);
      return otel.trace.getTracer('hal9000-web').startActiveSpan(`websocket.${message.type}`, span => {
        try {
          const ctx = span.spanContext();
          // Unsampled Faro sessions must not suppress independently sampled backend traces.
          return transmit(ctx.traceFlags & 1 ? { ...message, traceparent: `00-${ctx.traceId}-${ctx.spanId}-01` } : message);
        } finally { span.end(); }
      });
    },
  };
  faro.api.pushEvent('hal.frontend.ready', { page: pageName(location.pathname) });
}
// Observability is never on the critical path: blocked collectors/offline mode must not break the UI.
start().catch(() => {});

# HAL observability

HAL emits backend metrics, logs and traces using OTLP/HTTP JSON; continuous profiles go directly to
Pyroscope. The browser uses a locally bundled Grafana Faro SDK. No endpoints are enabled by default,
and no new credentials are required for local scripted operation. Existing conversation self-diagnostics
and scorecard metrics remain available.

## Enable the signals

Install with `npm ci`, then run `npm start`. Startup builds the browser bundle and preloads telemetry
before application imports. The Docker image does the build in a separate stage. If invoking Node
directly, build with `npm run build` and run:

```sh
node --env-file-if-exists=.env --import ./telemetry/bootstrap.js server.js
```

Example non-secret settings (copy the relevant entries to `.env` or your deployment ConfigMap):

```dotenv
OTEL_SERVICE_NAME=hal9000
DEPLOYMENT_ENV=development
OTEL_EXPORTER_OTLP_ENDPOINT=http://alloy:4318
LOG_FORMAT=json
PYROSCOPE_SERVER_ADDRESS=http://pyroscope:4040
FARO_COLLECTOR_URL=https://faro.example.com/collect
FARO_SESSION_SAMPLE_RATE=1
```

The OTLP setting is a **base** URL; HAL appends `/v1/traces`, `/v1/metrics`, and `/v1/logs`.
It must accept OTLP/HTTP JSON, not gRPC or protobuf-only ingestion. For different destinations, set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, and
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` to complete signal URLs. Their corresponding `_HEADERS` settings
override `OTEL_EXPORTER_OTLP_HEADERS`. Headers use comma-separated, URL-encoded OTel key/value pairs.
Store authorization headers in a Secret, never the ConfigMap or a frontend setting.

Trace sampling follows the OpenTelemetry SDK conventions. For example,
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` and `OTEL_TRACES_SAMPLER_ARG=0.1` sample 10% of new
backend traces while respecting upstream sampling. Use `OTEL_SDK_DISABLED=true` to disable backend
OTLP export; this does not disable the independently configured profiler or Faro.

### Profiles

`PYROSCOPE_SERVER_ADDRESS` enables sampled wall time, CPU time and heap/allocation profiles through
the optional native Node SDK. This does **not** expose heap snapshots or record object contents.
For Grafana Cloud Profiles, use its Pyroscope URL and set `PYROSCOPE_BASIC_AUTH_USER` and
`PYROSCOPE_BASIC_AUTH_PASSWORD` from a Secret. Bearer-based installations can use `PYROSCOPE_AUTH_TOKEN`.
The application name defaults to the OTel service name and can be overridden with
`PYROSCOPE_APPLICATION_NAME`. Set `PYROSCOPE_ENABLED=false` to stop enabling the profiler at startup.

The SDK normally uploads every 60 seconds; its `PYROSCOPE_FLUSH_INTERVAL_MS` setting can tune this.
The profiling-enabled metric reports whether the native profiler actually started. An unavailable
native binary is a warning, not a fatal startup error. Check that metric after each runtime/architecture
upgrade and load-test profiling overhead against your resource budget. HAL's default image is Node 24
on Alpine; local Node versions/architectures may differ.

Profiles and traces share service/version/environment labels. Configure Grafana Tempo's trace-to-profile
mapping to the Pyroscope service and time window. This is **service/time correlation**, not span-specific
profiling: the Node profiler does not currently provide the span-profile integration available in some
other languages, and HAL does not claim exact per-span profiles.

### Faro / Frontend Observability

Create a Grafana Cloud Frontend Observability application and use its public collector URL, or deploy
the optional self-hosted Alloy receiver in [config.alloy](../deploy/observability/config.alloy). A backend
OTLP endpoint is not a Faro endpoint. The URL must be reachable by users' browsers, support HTTPS when
HAL uses HTTPS, and allow HAL's exact origin through CORS. Use `FARO_SESSION_SAMPLE_RATE` (0–1) for
session-based sampling. Restart HAL after changing these settings.

Only the public collector URL, application metadata and sample rate are exposed at
`/api/observability` (subject to the same authentication as the other application APIs). Backend OTLP
headers and profile credentials never enter this response. Do not put reusable backend credentials
in the Faro URL. Public RUM ingestion URLs are intentionally visible to clients: restrict origins,
payload sizes and rate limits at the collector/ingress.

The SDK collects errors/unhandled rejections, Core Web Vitals, navigation/resource timing, sessions,
fetch/XHR spans and safe explicit WebSocket lifecycle events. All five pages load the bundle. Fetch/XHR
propagate trace context to same-origin requests only. Selected WebSocket actions (ask, drill, plan,
trial, canvas) add a W3C traceparent to the message envelope so HAL's conversation/model/tool spans can
join the browser trace. Old clients remain supported. Camera frames and high-rate pulse updates do
not create spans. The WebSocket client span measures sending the action, **not** the full answer latency;
use the server conversation duration for that. Unsampled browser sessions do not force backend sampling off.

Console capture and DOM-derived user/frustration action tracking are disabled, avoiding chat text and
settings values. Browser error messages are masked; error types and stack-frame locations remain.
URL queries/fragments, identities and DOM text are scrubbed before transport. Sessions are volatile,
not stored in local storage. Do Not Track or Global Privacy Control disables Faro completely. Review
your organization's notice/consent requirements before enabling RUM; privacy scrubbing is a safeguard,
not a substitute for a telemetry data review. Ad blockers and offline collectors must not break HAL.

## What is instrumented

| Signal | Coverage |
| --- | --- |
| Metrics | Existing turns/outcomes, model calls/tokens, tool calls/errors, confusion and scorecard counters; turn/model/tool latency histograms; HTTP duration by bounded route/method/status; process RSS, JS heap/external/array buffers and heap limit; user/system CPU time; event-loop utilization and p99/max delay; GC count/time; WebSocket active connections, reconnect connections, traffic bytes/messages and errors by role; log drops/export failures and profiler-enabled state. |
| Logs | Bounded console export in five-second batches with severity, timestamp, resource metadata and active trace/span IDs. JSON stdout when log export is enabled or `LOG_FORMAT=json`; `LOG_FORMAT=pretty` retains readable output. |
| Traces | HTTP server requests including failures, outbound core HTTP and fetch/Undici, conversation turns, model calls with usage, tool calls and browser actions. No request/response bodies, prompts or tool arguments are added. |
| Profiles | Continuous sampled wall, CPU and allocation/heap profiles, labeled by service/version/environment and optional cluster. |
| Browser | Faro errors, performance, vitals, volatile sessions, browser tracing and explicit connection events. |

HTTP metrics are cumulative histograms in seconds; existing HAL duration histograms use milliseconds.
Resource metadata includes service/version/environment and Kubernetes pod/node/namespace/cluster when
available. Do not use room IDs, user IDs, arbitrary URLs or prompts as metric/Loki labels. HTTP route
labels use a fixed set of templates; unmatched paths collapse to one label.

The logger redacts credential patterns and URLs as defense in depth. Existing domain modules can still
log operational incident or answer summaries; audit those modules and your retention/access policy
before exporting logs from sensitive environments. Do not treat generic redaction as a guarantee that
all possible free-form domain data is safe. HAL no longer logs question snippets or tool argument bodies
from its conversation loop.

## Collection and Kubernetes

Backend OTLP → Alloy/OTel Collector → Mimir/Prometheus, Loki and Tempo. Profiles → Pyroscope.
Browsers → Grafana Cloud Frontend Observability, or self-hosted Faro receiver → Loki and Tempo.

The optional Alloy example forwards all backend signals to an authenticated unified OTLP gateway and
self-hosted Faro logs to Loki. Supply `OTLP_UPSTREAM_URL`, `OTLP_UPSTREAM_AUTHORIZATION`,
`HAL_PUBLIC_ORIGIN` (origin only, no path), `LOKI_PUSH_URL`, `LOKI_USER`, and `LOKI_TOKEN` to Alloy.
It is not automatically deployed and does not configure a Grafana Cloud Frontend Observability app.
Expose only the Faro HTTPS ingress publicly; keep the backend OTLP listener internal. Do not use wildcard
CORS. Sourcemap fetching is disabled to prevent untrusted payloads causing collector-side URL fetches.

HAL's Deployment already imports `hal9000-config` and the optional `hal9000-keys` Secret. Add non-secret
URLs/sample rates to the environment-specific ConfigMap and auth headers/profile credentials to that
Secret out of band. Existing overlay OTLP URLs continue to work unchanged. No new Service port or public
metrics endpoint is required. Allow outbound traffic to your OTLP and Pyroscope endpoints, and permit
the Faro collector in any browser CSP `connect-src`. Do not collect both HAL's OTLP logs and the same
stdout logs into Loki unless you intentionally want duplicate records.

Metrics export every 30 seconds, logs every five, traces use the SDK's bounded batch queue. OTLP custom
export requests have five-second deadlines and do not overlap per signal. Failures do not interrupt
application work; diagnostics are rate-limited and counters expose drops/failures. Custom metrics/log
exports are best-effort and have no disk queue; use a collector with durable buffering if required.
SIGTERM/SIGINT closes listeners and WebSockets, then flushes telemetry with a ten-second total deadline.
Kubernetes' default 30-second termination grace period is sufficient. Sampling and disabled signals
limit volume; inspect CPU/RSS before tightening memory limits or enabling profiles under load.

## Validation

Run `npm run build` and `npm test`. The telemetry integration test uses a local fake OTLP receiver and
checks HTTP/browser parent IDs, model/tool/outbound spans, correlated logs, runtime/request metrics,
secret redaction and final flushing. It needs no external Grafana account.

`npm run test:browser` runs an opt-in Chrome DevTools smoke test against local fake collectors. It
verifies actual Faro exports, captured browser errors, WebSocket action spans, HTTP trace correlation,
privacy redaction and Do Not Track behavior. It defaults to macOS Chrome; set `CHROME_BIN` for another
Chrome/Chromium installation. The test creates and removes its own temporary browser profile.

After configuring real collectors:

1. Open a monitor, ask a question, open settings and reconnect the page.
2. Find the frontend application by its `-web` service suffix and the backend by `OTEL_SERVICE_NAME`.
3. Confirm Core Web Vitals and WebSocket events, then follow a browser action to the conversation trace.
4. Confirm request/runtime metrics after 30 seconds, correlated logs after five, and profiles after roughly
   a minute. Verify the profiling-enabled metric is 1; a running service alone does not prove profiling works.
5. Check that room query strings, auth callback codes and chat contents are absent from the new instrumentation.
6. Stop HAL gracefully and verify the final short-lived trace/log batches arrive. Validate collector access
   controls, retention, alerting and production overhead separately before rolling out broadly.

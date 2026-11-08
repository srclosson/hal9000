import { context, trace, tracer, remoteContext, SpanKind, SpanStatusCode } from './spans.js';
import { routeOf } from './settings.js';
import { recordRequest } from './runtime.js';

export function observeHttp(handler) {
  return (req, res) => {
    const route = routeOf(req.url), started = performance.now();
    const span = tracer.startSpan(`${req.method} ${route}`, { kind: SpanKind.SERVER,
      attributes: { 'http.request.method': req.method, 'http.route': route } }, remoteContext(req.headers));
    let ended = false;
    const end = () => {
      if (ended) return; ended = true;
      const status = res.writableFinished ? res.statusCode : 499;
      span.setAttribute('http.response.status_code', status);
      if (status >= 500 || status === 499) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(); recordRequest(req.method, route, status, (performance.now() - started) / 1000);
    };
    res.once('finish', end); res.once('close', end);
    context.with(trace.setSpan(context.active(), span), () => Promise.resolve().then(() => handler(req, res)).catch(error => {
      span.setAttribute('error.type', error?.name || 'Error'); span.setStatus({ code: SpanStatusCode.ERROR });
      console.error('HTTP request failed', { route, error: error?.name || 'Error' });
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Internal server error');
    }));
  };
}

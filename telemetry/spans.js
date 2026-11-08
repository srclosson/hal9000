import { context, propagation, trace, SpanKind, SpanStatusCode, ROOT_CONTEXT } from '@opentelemetry/api';
export const tracer = trace.getTracer('hal9000');
export { context, trace, SpanKind, SpanStatusCode };

export function remoteContext(carrier) {
  // Browser clients send only W3C traceparent, not arbitrary baggage or identity data.
  return propagation.extract(ROOT_CONTEXT, { traceparent: typeof carrier?.traceparent === 'string' ? carrier.traceparent.slice(0, 55) : '' });
}
export async function operation(name, attributes, fn, parent = context.active()) {
  return tracer.startActiveSpan(name, { attributes }, parent, async span => {
    try {
      const result = await fn();
      if (result?.usage) span.setAttributes({ 'gen_ai.usage.input_tokens': result.usage.in ?? 0, 'gen_ai.usage.output_tokens': result.usage.out ?? 0 });
      if (typeof result === 'string' && /^Error/.test(result)) span.setStatus({ code: SpanStatusCode.ERROR });
      return result;
    } catch (error) {
      span.setAttribute('error.type', error?.name || 'Error');
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally { span.end(); }
  });
}

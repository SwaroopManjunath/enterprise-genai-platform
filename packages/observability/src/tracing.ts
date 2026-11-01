import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { safeAttributes } from './sanitize';

/** One tracer per service. Before telemetry is initialised this is a no-op, so libraries can call it freely. */
export const getTracer = (service: string): Tracer => trace.getTracer(service);

export interface SpanOptions {
  attributes?: Record<string, unknown>;
  kind?: SpanKind;
}

/**
 * Runs `fn` inside a span that ends when it finishes. A failure marks the span as an error and
 * records only the error's type: its message can quote a URL, a document or a token, and a span is
 * read by more people, for longer, than the response ever was.
 */
export function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  const span = tracer.startSpan(name, {
    ...(options.kind !== undefined && { kind: options.kind }),
    attributes: safeAttributes(options.attributes),
  });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await fn(span);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Adds attributes to a span, keeping only what telemetry may carry. */
export function setAttributes(span: Span, attributes: Record<string, unknown>): void {
  span.setAttributes(safeAttributes(attributes));
}

/** The trace and span the current code is running in, for correlating logs. */
export function currentTrace(): { traceId: string; spanId: string } | undefined {
  const span = trace.getSpan(context.active());
  const { traceId, spanId } = span?.spanContext() ?? {};
  return traceId && spanId && traceId !== '00000000000000000000000000000000'
    ? { traceId, spanId }
    : undefined;
}

export { SpanKind, SpanStatusCode };
export type { Attributes, Span, Tracer };

import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { HttpJsonClient } from './http-json-client';

// a new exporter each time: shutting a provider down stops its exporter for good
let exporter: InMemorySpanExporter;
let provider: TracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});
afterEach(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});

const client = (fetchImpl: jest.Mock) =>
  new HttpJsonClient({
    service: 'retrieval',
    baseUrl: 'http://svc.test',
    timeoutMs: 1000,
    fetchImpl,
  });
const ok = () => new Response('{}', { status: 200 });

describe('HttpJsonClient tracing', () => {
  it('sends the trace on, so the service it calls continues the same trace', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());
    const tracer = trace.getTracer('test');

    await tracer.startActiveSpan('parent', async (parent) => {
      await client(fetchImpl).post('/v1/search', 'tok', {});
      parent.end();
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const [clientSpan, parentSpan] = exporter.getFinishedSpans();
    const header = (init.headers as Record<string, string>)['traceparent'];
    expect(header).toBe(
      `00-${parentSpan?.spanContext().traceId}-${clientSpan?.spanContext().spanId}-01`,
    );
    expect(clientSpan?.parentSpanContext?.spanId).toBe(parentSpan?.spanContext().spanId);
    expect(clientSpan?.name).toBe('POST retrieval');
    expect(clientSpan?.kind).toBe(2);
    expect(clientSpan?.attributes).toMatchObject({
      'genai.downstream': 'retrieval',
      'http.response.status_code': 200,
    });
  });

  it('records a failed call as an error with its kind, and nothing else about it', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(new Response('{"error":{"code":"upstream_secret"}}', { status: 503 }));

    await expect(client(fetchImpl).get('/v1/runs/run-12345', 'tok')).rejects.toThrow();

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(2);
    expect(span?.attributes).toMatchObject({
      'error.type': 'http',
      'http.response.status_code': 503,
    });
  });

  it('never puts the path, the token or the body on the span', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(ok());

    await client(fetchImpl).post('/v1/runs/run-12345?q=refunds', 'secret-token-value', {
      question: 'How long do refunds take?',
    });

    const text = JSON.stringify(
      exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.events]),
    );
    for (const leaked of ['run-12345', 'refunds', 'secret-token-value'])
      expect(text).not.toContain(leaked);
  });

  it('ends the span for a stream, including one the consumer stops reading', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: a\ndata: 1\n\n'));
      },
    });
    const fetchImpl = jest.fn().mockResolvedValue(new Response(stream, { status: 200 }));

    for await (const _message of client(fetchImpl).postEventStream('/v1/stream', 'tok', {})) {
      break;
    }

    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it('works unchanged when no tracing is set up', async () => {
    trace.disable();
    context.disable();
    propagation.disable();
    const fetchImpl = jest.fn().mockResolvedValue(ok());

    await expect(client(fetchImpl).post('/v1/x', 'tok', {})).resolves.toEqual({});

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty('traceparent');
  });
});

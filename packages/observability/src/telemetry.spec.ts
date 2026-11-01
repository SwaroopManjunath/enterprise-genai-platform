import { context, propagation, trace } from '@opentelemetry/api';
import { optionsFromEnv } from './config';
import { initTelemetry, type Telemetry } from './telemetry';
import { metricsFor } from './metrics';
import { getTracer, setAttributes, withSpan } from './tracing';

let telemetry: Telemetry;
const start = (overrides = {}) => {
  telemetry = initTelemetry({
    serviceName: 'test',
    traces: 'memory',
    metrics: 'memory',
    ...overrides,
  });
  return telemetry.memory!;
};
afterEach(async () => {
  await telemetry?.shutdown();
});

describe('optionsFromEnv', () => {
  it('exports nothing by default', () => {
    expect(optionsFromEnv('assistant', {})).toEqual({
      serviceName: 'assistant',
      traces: 'off',
      metrics: 'off',
    });
  });

  it('sends traces and metrics to a collector when one is configured', () => {
    expect(
      optionsFromEnv('assistant', { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }),
    ).toMatchObject({
      traces: 'otlp',
      metrics: 'otlp',
      otlpEndpoint: 'http://collector:4318',
    });
  });

  it('exposes a scrape port for metrics when asked, and honours the standard switches', () => {
    expect(
      optionsFromEnv('a', { METRICS_PORT: '9464', OTEL_SERVICE_NAME: 'renamed' }),
    ).toMatchObject({
      serviceName: 'renamed',
      metrics: 'prometheus',
      metricsPort: 9464,
    });
    expect(
      optionsFromEnv('a', {
        OTEL_SDK_DISABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x',
        METRICS_PORT: '9464',
      }),
    ).toMatchObject({
      traces: 'off',
      metrics: 'off',
    });
  });

  it('refuses a nonsense metrics port', () => {
    expect(() => optionsFromEnv('a', { METRICS_PORT: 'abc' })).toThrow(/METRICS_PORT/);
    expect(() => optionsFromEnv('a', { METRICS_PORT: '70000' })).toThrow(/METRICS_PORT/);
  });
});

describe('the metrics endpoint', () => {
  it('is reachable over IPv4, not only on the IPv6 loopback, so another host can scrape it', async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    telemetry = initTelemetry({
      serviceName: 'test',
      traces: 'off',
      metrics: 'prometheus',
      metricsPort: port,
    });
    metricsFor('test').count('answers', { outcome: 'grounded' });

    const response = await fetch(`http://127.0.0.1:${port}/metrics`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('genai_assistant_answers_total');
  });

  it('reads the address to listen on from the environment', () => {
    expect(optionsFromEnv('a', { METRICS_PORT: '9464', METRICS_HOST: '127.0.0.1' })).toMatchObject({
      metricsHost: '127.0.0.1',
    });
  });
});

describe('spans', () => {
  it('records a span with its safe attributes, and nested spans as children', async () => {
    const memory = start();
    const tracer = getTracer('assistant');

    await withSpan(
      tracer,
      'ask',
      async () => {
        await withSpan(tracer, 'retrieve', () => 'ok', {
          attributes: { 'genai.sources.count': 3 },
        });
      },
      { attributes: { 'genai.outcome': 'answered' } },
    );

    const [retrieve, ask] = memory.spans();
    expect(ask?.name).toBe('ask');
    expect(retrieve?.parentSpanContext?.spanId).toBe(ask?.spanContext().spanId);
    expect(retrieve?.spanContext().traceId).toBe(ask?.spanContext().traceId);
    expect(retrieve?.attributes).toEqual({ 'genai.sources.count': 3 });
    expect(retrieve?.instrumentationScope.name).toBe('assistant');
  });

  it('marks a failure as an error and records only its type, never its message', async () => {
    const memory = start();

    await expect(
      withSpan(getTracer('s'), 'work', () => {
        throw new TypeError('could not read https://internal.example/doc?token=SECRET-VALUE');
      }),
    ).rejects.toThrow(TypeError);

    const [span] = memory.spans();
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['error.type']).toBe('TypeError');
    expect(JSON.stringify([span?.attributes, span?.status, span?.events])).not.toContain(
      'SECRET-VALUE',
    );
    expect(span?.events).toEqual([]);
  });

  it('drops attributes that are not allowed, both when set and when exported', async () => {
    const memory = start();

    await withSpan(getTracer('s'), 'work', (span) => {
      setAttributes(span, { 'genai.outcome': 'ok', question: 'How long do refunds take?' });
      // a developer bypassing the helper does not get past the exporter
      span.setAttribute('answer', 'Refunds take five working days.');
      span.setAttribute('genai.note', 'Refunds take five working days.');
      span.addEvent('debug', { text: 'Refunds take five working days.' });
      span.recordException(new Error('Refunds take five working days.'));
      span.setStatus({ code: 2, message: 'Refunds take five working days.' });
    });

    const [span] = memory.spans();
    expect(span?.attributes).toEqual({ 'genai.outcome': 'ok' });
    expect(span?.events).toEqual([]);
    expect(span?.status).toEqual({ code: 2 });
    expect(JSON.stringify(span?.attributes)).not.toContain('Refunds');
  });
});

describe('trace context between services', () => {
  it('travels in the W3C traceparent header, and the receiving side continues the same trace', async () => {
    const memory = start();
    const tracer = getTracer('assistant');
    const headers: Record<string, string> = {};

    await withSpan(tracer, 'caller', () => propagation.inject(context.active(), headers));
    const remote = propagation.extract(context.active(), headers);
    const child = tracer.startSpan('callee', {}, remote);
    child.end();

    const caller = memory.spans().find((s) => s.name === 'caller');
    const callee = memory.spans().find((s) => s.name === 'callee');
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(callee?.spanContext().traceId).toBe(caller?.spanContext().traceId);
    expect(callee?.parentSpanContext?.spanId).toBe(caller?.spanContext().spanId);
  });

  it('does not carry baggage, which can hold arbitrary data', async () => {
    start();
    const headers: Record<string, string> = {};
    const ctx = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({ secret: { value: 'v' } }),
    );

    propagation.inject(ctx, headers);

    expect(Object.keys(headers)).not.toContain('baggage');
  });

  it('is a harmless no-op before telemetry is initialised', async () => {
    await expect(withSpan(getTracer('s'), 'work', () => 42)).resolves.toBe(42);
    expect(trace.getActiveSpan()).toBeUndefined();
  });
});

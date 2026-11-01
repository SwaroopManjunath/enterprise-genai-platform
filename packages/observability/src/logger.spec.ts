import { JsonLogger, scrubSecrets } from './logger';
import { initTelemetry, type Telemetry } from './telemetry';
import { getTracer, withSpan } from './tracing';

const make = (minLevel?: 'debug' | 'log' | 'warn') => {
  const lines: Record<string, unknown>[] = [];
  const logger = new JsonLogger({
    service: 'assistant',
    write: (line) => lines.push(JSON.parse(line)),
    now: () => new Date('2026-11-01T12:00:00Z'),
    ...(minLevel && { minLevel }),
  });
  return { lines, logger };
};

describe('JsonLogger', () => {
  it('writes one JSON object per line, with a time, level, service and message', () => {
    const { lines, logger } = make();

    logger.log('listening on :3004', 'Bootstrap');
    logger.warn('prompt registry unavailable', 'AskService');

    expect(lines).toEqual([
      {
        ts: '2026-11-01T12:00:00.000Z',
        level: 'info',
        service: 'assistant',
        context: 'Bootstrap',
        message: 'listening on :3004',
      },
      {
        ts: '2026-11-01T12:00:00.000Z',
        level: 'warn',
        service: 'assistant',
        context: 'AskService',
        message: 'prompt registry unavailable',
      },
    ]);
  });

  it('carries the trace and span it was written in, so a log line leads to its trace', async () => {
    const telemetry: Telemetry = initTelemetry({
      serviceName: 't',
      traces: 'memory',
      metrics: 'off',
    });
    const { lines, logger } = make();

    await withSpan(getTracer('assistant'), 'ask', () => logger.log('answered'));
    logger.log('outside any span');

    const [span] = telemetry.memory!.spans();
    expect(lines[0]).toMatchObject({
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });
    expect(lines[1]).not.toHaveProperty('traceId');
    await telemetry.shutdown();
  });

  it('scrubs anything that looks like a credential from messages and fields', () => {
    const { lines, logger } = make();
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJlc2lnbmF0dXJl';

    logger.error(`call failed with Bearer ${jwt}`);
    logger.error(new Error('upstream said: api_key=abcd1234efgh5678 was rejected'));
    logger.event('http_request', { route: `/x?token=sk-live-abcdefghijklmnopqrstuvwx` });

    const text = JSON.stringify(lines);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain('abcd1234efgh5678');
    expect(text).not.toContain('sk-live-abcdefghijklmnopqrstuvwx');
    expect(text).toContain('[redacted');
  });

  it('logs named events with identifier-like fields', () => {
    const { lines, logger } = make();

    logger.event('http_request', {
      method: 'POST',
      route: '/v1/ask',
      status: 200,
      durationMs: 12,
      skipped: undefined,
    });

    expect(lines[0]).toMatchObject({
      message: 'http_request',
      method: 'POST',
      route: '/v1/ask',
      status: 200,
      durationMs: 12,
    });
  });

  it('honours the minimum level, and bounds a message', () => {
    const { lines, logger } = make('warn');

    logger.log('quiet');
    logger.debug('quieter');
    logger.error('x'.repeat(5000));

    expect(lines).toHaveLength(1);
    expect((lines[0]?.['message'] as string).length).toBe(2000);
  });
});

describe('scrubSecrets', () => {
  it.each([
    ['Authorization: Bearer abcdefgh12345678', 'Bearer [redacted]'],
    ['password=hunter22222', 'password=[redacted]'],
    ['{"secret": "topsecretvalue"}', '"secret": "[redacted]'],
  ])('%s', (input, expected) => expect(scrubSecrets(input)).toContain(expected));

  it('leaves ordinary text alone', () => {
    expect(scrubSecrets('answered 3 sources in 120 ms')).toBe('answered 3 sources in 120 ms');
  });
});

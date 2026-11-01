import {
  Controller,
  Get,
  Module,
  Param,
  Post,
  UnauthorizedException,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JsonLogger } from './logger';
import { TelemetryModule } from './nest';
import { initTelemetry, type Telemetry } from './telemetry';

@Controller()
class DemoController {
  @Get('runs/:id')
  run(@Param('id') id: string) {
    return { id };
  }

  @Post('ask')
  ask() {
    throw new UnauthorizedException();
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail: password=hunter22222');
  }
}

let telemetry: Telemetry;
let app: INestApplication;
let lines: Record<string, unknown>[];

beforeEach(async () => {
  telemetry = initTelemetry({ serviceName: 'test', traces: 'memory', metrics: 'memory' });
  lines = [];
  const logger = new JsonLogger({ service: 'demo', write: (l) => lines.push(JSON.parse(l)) });
  @Module({ imports: [TelemetryModule.forService('demo', logger)], controllers: [DemoController] })
  class AppModule {}
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});
afterEach(async () => {
  await app.close();
  await telemetry.shutdown();
});

const waitForSpans = async (n: number) => {
  for (let i = 0; i < 50 && telemetry.memory!.spans().length < n; i++)
    await new Promise((r) => setTimeout(r, 10));
  return telemetry.memory!.spans();
};

describe('request telemetry', () => {
  it('counts a request by route template, not by the real id', async () => {
    await request(app.getHttpServer()).get('/runs/abc-123').expect(200);
    await request(app.getHttpServer()).get('/runs/def-456').expect(200);
    await waitForSpans(2);

    const points = (await telemetry.memory!.metrics()).filter(
      (p) => p.name === 'http.server.requests',
    );
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      attributes: { service: 'demo', route: '/runs/:id', method: 'GET', status_class: '2xx' },
      value: 2,
    });
    expect(JSON.stringify(await telemetry.memory!.metrics())).not.toContain('abc-123');
  });

  it('sees requests that never reach a controller: a 401 is counted', async () => {
    await request(app.getHttpServer()).post('/ask').expect(401);
    await waitForSpans(1);

    const points = (await telemetry.memory!.metrics()).filter(
      (p) => p.name === 'http.server.requests',
    );
    expect(points[0]?.attributes).toMatchObject({ route: '/ask', status_class: '4xx' });
  });

  it('counts a route that does not exist as "unmatched", so scanners cannot create series', async () => {
    await request(app.getHttpServer()).get('/wp-admin/some-path').expect(404);
    await request(app.getHttpServer()).get('/another/random/path').expect(404);
    await waitForSpans(2);

    const routes = (await telemetry.memory!.metrics())
      .filter((p) => p.name === 'http.server.requests')
      .map((p) => p.attributes['route']);
    expect(routes).toEqual(['unmatched']);
  });

  it('marks a 500 as an error on the span, and the response header names the trace', async () => {
    const res = await request(app.getHttpServer()).get('/boom').expect(500);
    const [span] = await waitForSpans(1);

    expect(span?.status.code).toBe(2);
    expect(span?.name).toBe('GET /boom');
    expect(res.headers['x-trace-id']).toBe(span?.spanContext().traceId);
    expect(span?.kind).toBe(1);
  });

  it('continues the caller’s trace', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    await request(app.getHttpServer())
      .get('/runs/1')
      .set('traceparent', `00-${traceId}-00f067aa0ba902b7-01`)
      .expect(200);
    const [span] = await waitForSpans(1);

    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe('00f067aa0ba902b7');
  });

  it('logs one line per request with the trace, and nothing from the request itself', async () => {
    await request(app.getHttpServer())
      .get('/runs/1?question=How+long+do+refunds+take')
      .set('authorization', 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.c2lnbmF0dXJl')
      .set('x-request-id', 'req-42')
      .expect(200);
    const [span] = await waitForSpans(1);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      message: 'http_request',
      method: 'GET',
      route: '/runs/:id',
      status: 200,
      requestId: 'req-42',
      traceId: span?.spanContext().traceId,
    });
    const text = JSON.stringify(lines) + JSON.stringify(span?.attributes);
    expect(text).not.toContain('refunds');
    expect(text).not.toContain('eyJ');
  });

  it('does not accept a request id that could carry text', async () => {
    await request(app.getHttpServer())
      .get('/runs/1')
      .set('x-request-id', 'How long do refunds take?')
      .expect(200);
    await waitForSpans(1);

    expect(lines[0]).not.toHaveProperty('requestId');
  });
});

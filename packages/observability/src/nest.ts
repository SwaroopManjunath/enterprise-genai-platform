import { SpanKind, SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import {
  Inject,
  Injectable,
  Module,
  RequestMethod,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestMiddleware,
  type NestModule,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { getActiveLogger, type JsonLogger } from './logger';
import { metricsFor, statusClass } from './metrics';
import { pseudonym, safeAttributes } from './sanitize';

const CATCH_ALL = '{*splat}';
export const TELEMETRY_SERVICE = Symbol('TELEMETRY_SERVICE');
export const TELEMETRY_LOGGER = Symbol('TELEMETRY_LOGGER');

/**
 * Observes every request the service handles, including the ones that never reach a controller
 * (a missing or bad token is a 401 an on-call engineer needs to see). For each request it:
 *  - continues the caller's trace from the `traceparent` header, or starts one;
 *  - counts it and times it, by route template (`/v1/runs/:id`, never the real id) and status class;
 *  - returns `x-trace-id`, so a user can quote it and an operator can find the whole story;
 *  - writes one access log line: method, route, status, duration. Never a body, a query or a header.
 */
@Injectable()
export class TelemetryMiddleware implements NestMiddleware {
  constructor(
    @Inject(TELEMETRY_SERVICE) private readonly service: string,
    @Inject(TELEMETRY_LOGGER) private readonly logger: JsonLogger | undefined,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const parent = propagation.extract(context.active(), req.headers);
    const tracer = trace.getTracer(this.service);
    const startedAt = performance.now();
    const method = req.method;
    // The route is only known once the request has been matched; it is read when the response ends.
    const span = tracer.startSpan(
      `${method} request`,
      { kind: SpanKind.SERVER, attributes: { 'http.request.method': method } },
      parent,
    );
    const ctx = trace.setSpan(parent, span);
    const { traceId } = span.spanContext();
    if (traceId !== '00000000000000000000000000000000') res.setHeader('x-trace-id', traceId);

    res.on('finish', () => {
      const route = routeTemplate(req);
      const status = res.statusCode;
      const duration = performance.now() - startedAt;
      const labels = { route, method, status_class: statusClass(status) };

      span.updateName(`${method} ${route}`);
      span.setAttributes(
        safeAttributes({
          'http.route': route,
          'http.response.status_code': status,
          service: this.service,
          'genai.request_id': requestId(req),
        }),
      );
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();

      const metrics = metricsFor(this.service);
      metrics.count('httpRequests', labels);
      metrics.observe('httpDuration', labels, duration);
      context.with(ctx, () =>
        this.logger?.event('http_request', {
          method,
          route,
          status,
          durationMs: Math.round(duration),
          requestId: requestId(req),
        }),
      );
    });

    context.with(ctx, () => next());
  }
}

/** The route pattern, so `/v1/runs/123` and `/v1/runs/456` are one series, not thousands. */
function routeTemplate(req: Request): string {
  const path = req.route?.path as string | undefined;
  // Nest runs this middleware on a catch-all route; if nothing else matched, that is what is left.
  return path && path !== `/${CATCH_ALL}` ? `${req.baseUrl ?? ''}${path}` : 'unmatched';
}

const requestId = (req: Request): string | undefined => {
  const header = req.headers['x-request-id'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined;
};

/** Adds request telemetry to a service. `TelemetryModule.forService('assistant')` in its AppModule. */
@Module({})
export class TelemetryModule implements NestModule {
  static forService(service: string, logger?: JsonLogger): DynamicModule {
    return {
      module: TelemetryModule,
      providers: [
        { provide: TELEMETRY_SERVICE, useValue: service },
        { provide: TELEMETRY_LOGGER, useFactory: () => logger ?? getActiveLogger() },
        TelemetryMiddleware,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TelemetryMiddleware).forRoutes({ path: CATCH_ALL, method: RequestMethod.ALL });
  }
}

export { pseudonym };

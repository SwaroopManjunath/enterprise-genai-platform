import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type MetricReader,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import type { TelemetryOptions } from './config';
import { resetInstruments } from './metrics';
import { METRIC_LABELS, isAllowedKey, isSafeValue, setPseudonymSalt } from './sanitize';

/** What a test or a demo can read back without any collector. */
export interface MemoryTelemetry {
  spans(): ReadableSpan[];
  /** Every data point, as it would be exported now (cumulative). */
  metrics(): Promise<MetricPoint[]>;
  reset(): void;
}

export interface MetricPoint {
  name: string;
  attributes: Record<string, unknown>;
  /** The value of a counter, or the count of a histogram. */
  value: number;
  /** For a histogram: the sum and the count in each bucket, with the upper bounds. */
  histogram?: { sum: number; count: number; boundaries: number[]; counts: number[] };
}

export interface Telemetry {
  memory?: MemoryTelemetry;
  shutdown(): Promise<void>;
}

/**
 * Wraps an exporter so that nothing leaves the process unless it passes the sanitizer, whatever
 * the code that created the span put in it: attributes are filtered to what telemetry may carry,
 * and events (an exception event carries its message and stack) are dropped.
 */
export class SanitizingSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter) {}

  export(spans: ReadableSpan[], done: Parameters<SpanExporter['export']>[1]): void {
    this.inner.export(spans.map(clean), done);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

function clean(span: ReadableSpan): ReadableSpan {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (isAllowedKey(key) && isSafeValue(value)) attributes[key] = value;
  }
  return Object.create(span, {
    attributes: { value: attributes },
    events: { value: [] },
    // a status message is free text, so only the code survives
    status: { value: { code: span.status.code } },
    // a link's attributes are dropped for the same reason
    links: { value: span.links.map((l) => ({ context: l.context, attributes: {} })) },
  }) as ReadableSpan;
}

/**
 * Sets up tracing and metrics for this process. Trace context travels between services in the
 * W3C `traceparent` header (and nothing else: baggage can carry arbitrary data, so it is not
 * propagated). Metric labels are limited to a fixed list.
 */
export function initTelemetry(options: TelemetryOptions): Telemetry {
  setPseudonymSalt(options.pseudonymSalt);
  const resource = resourceFromAttributes({
    'service.name': options.serviceName,
    ...(options.serviceVersion && { 'service.version': options.serviceVersion }),
    ...(options.environment && { 'deployment.environment.name': options.environment }),
  });

  const contextManager = new AsyncLocalStorageContextManager();
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  // --- traces
  const memorySpans = new InMemorySpanExporter();
  const spanProcessors = [];
  if (options.traces === 'memory') {
    spanProcessors.push(
      new SimpleSpanProcessor({ exporter: new SanitizingSpanExporter(memorySpans) }),
    );
  } else if (options.traces === 'otlp') {
    const exporter = new OTLPTraceExporter({
      url: `${options.otlpEndpoint?.replace(/\/+$/, '')}/v1/traces`,
    });
    spanProcessors.push(new BatchSpanProcessor({ exporter: new SanitizingSpanExporter(exporter) }));
  }
  const tracerProvider = new TracerProvider({ resource, spanProcessors });
  trace.setGlobalTracerProvider(tracerProvider);

  // --- metrics
  const memoryMetrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const readers: MetricReader[] = [];
  let memoryReader: PeriodicExportingMetricReader | undefined;
  if (options.metrics === 'memory') {
    memoryReader = new PeriodicExportingMetricReader({
      exporter: memoryMetrics,
      exportIntervalMillis: 3_600_000,
    });
    readers.push(memoryReader);
  } else if (options.metrics === 'prometheus') {
    readers.push(
      new PrometheusExporter({
        host: options.metricsHost ?? '0.0.0.0',
        port: options.metricsPort ?? 9464,
      }),
    );
  } else if (options.metrics === 'otlp') {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${options.otlpEndpoint?.replace(/\/+$/, '')}/v1/metrics`,
        }),
        exportIntervalMillis: 30_000,
      }),
    );
  }
  const meterProvider = new MeterProvider({
    resource,
    readers,
    views: [
      {
        instrumentName: '*',
        attributesProcessors: [createAllowListAttributesProcessor([...METRIC_LABELS])],
      },
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  resetInstruments();

  const memory: MemoryTelemetry | undefined =
    options.traces === 'memory' || options.metrics === 'memory'
      ? {
          spans: () => memorySpans.getFinishedSpans(),
          metrics: async () => {
            if (!memoryReader) return [];
            memoryMetrics.reset();
            await meterProvider.forceFlush();
            return memoryMetrics.getMetrics().slice(-1).flatMap(flatten);
          },
          reset: () => memorySpans.reset(),
        }
      : undefined;

  return {
    ...(memory && { memory }),
    shutdown: async () => {
      await tracerProvider.shutdown();
      await meterProvider.shutdown();
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
      resetInstruments();
    },
  };
}

function flatten(resourceMetrics: ResourceMetrics): MetricPoint[] {
  return resourceMetrics.scopeMetrics.flatMap((scope) =>
    scope.metrics.flatMap((metric) =>
      metric.dataPoints.map((point): MetricPoint => {
        const value = point.value as unknown;
        if (typeof value === 'number')
          return { name: metric.descriptor.name, attributes: { ...point.attributes }, value };
        const h = value as {
          sum?: number;
          count: number;
          buckets: { boundaries: number[]; counts: number[] };
        };
        return {
          name: metric.descriptor.name,
          attributes: { ...point.attributes },
          value: h.count,
          histogram: {
            sum: h.sum ?? 0,
            count: h.count,
            boundaries: h.buckets.boundaries,
            counts: h.buckets.counts,
          },
        };
      }),
    ),
  );
}

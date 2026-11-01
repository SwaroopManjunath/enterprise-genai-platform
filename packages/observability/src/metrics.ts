import { metrics as otelMetrics, type Counter, type Histogram } from '@opentelemetry/api';

const DURATION_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 1500, 2500, 5000, 10000, 30000];

/**
 * Every metric the platform emits, in one place. Code records against these names, and the SLO
 * rules and dashboards are generated from them, so a metric cannot be renamed without the alerts
 * built on it noticing. Labels are few on purpose, and never carry free text.
 */
export const CATALOG = {
  httpRequests: {
    name: 'http.server.requests',
    kind: 'counter',
    unit: '{request}',
    description: 'HTTP requests handled, by route and the class of the status code',
    labels: ['route', 'method', 'status_class'],
  },
  httpDuration: {
    name: 'http.server.duration',
    kind: 'histogram',
    unit: 'ms',
    description: 'How long HTTP requests took, by route and status class',
    labels: ['route', 'method', 'status_class'],
    buckets: DURATION_MS,
  },
  answers: {
    name: 'genai.assistant.answers',
    kind: 'counter',
    unit: '{answer}',
    description:
      'Answers by outcome: grounded, ungrounded, no_sources, blocked, cache_hit or error',
    labels: ['outcome', 'cache'],
  },
  firstToken: {
    name: 'genai.assistant.first_token',
    kind: 'histogram',
    unit: 'ms',
    description: 'Time until a streamed answer started to arrive',
    labels: ['mode'],
    buckets: DURATION_MS,
  },
  guardrailEvents: {
    name: 'genai.guardrails.events',
    kind: 'counter',
    unit: '{event}',
    description: 'Guardrail decisions: what was checked (kind) and what was done about it (action)',
    labels: ['kind', 'action'],
  },
  llmCalls: {
    name: 'genai.llm.calls',
    kind: 'counter',
    unit: '{call}',
    description:
      'Model calls by deployment and outcome (ok, fallback_served, error, or rejected before any call)',
    labels: ['provider', 'outcome'],
  },
  llmDuration: {
    name: 'genai.llm.duration',
    kind: 'histogram',
    unit: 'ms',
    description: 'How long a model call took, including retries and fallback',
    labels: ['provider', 'mode'],
    buckets: DURATION_MS,
  },
  llmTokens: {
    name: 'genai.llm.tokens',
    kind: 'counter',
    unit: '{token}',
    description: 'Tokens used, by deployment and direction (prompt or completion)',
    labels: ['provider', 'direction'],
  },
  llmCost: {
    name: 'genai.llm.cost',
    kind: 'counter',
    unit: 'uUSD',
    description: 'Spend in micro-dollars, by tenant (a pseudonym) and deployment',
    labels: ['provider', 'tenant'],
  },
  retrievalResults: {
    name: 'genai.retrieval.results',
    kind: 'histogram',
    unit: '{result}',
    description: 'How many results a search returned to the caller',
    labels: ['mode'],
    buckets: [0, 1, 2, 3, 4, 6, 8, 12, 20],
  },
  ingestionJobs: {
    name: 'genai.ingestion.jobs',
    kind: 'counter',
    unit: '{job}',
    description: 'Ingestion jobs by result (succeeded, unchanged, retried, failed, dead_lettered)',
    labels: ['result'],
  },
  ingestionDuration: {
    name: 'genai.ingestion.duration',
    kind: 'histogram',
    unit: 'ms',
    description: 'How long processing one queued document took, by result',
    labels: ['result'],
    buckets: DURATION_MS,
  },
  agentRuns: {
    name: 'genai.agent.runs',
    kind: 'counter',
    unit: '{run}',
    description:
      'Agent runs by how they ended (completed, failed, awaiting_approval) and why they failed',
    labels: ['status', 'failure'],
  },
  agentToolCalls: {
    name: 'genai.agent.tool_calls',
    kind: 'counter',
    unit: '{call}',
    description: 'Tool calls by tool and outcome (ok, error, denied, withheld)',
    labels: ['tool', 'outcome'],
  },
  mcpCalls: {
    name: 'genai.mcp.calls',
    kind: 'counter',
    unit: '{call}',
    description:
      'Everything the MCP gateway audited, by action and outcome (ok, denied, tool_changed, ...)',
    labels: ['action', 'outcome'],
  },
} as const;

export type MetricKey = keyof typeof CATALOG;
type LabelsOf<K extends MetricKey> = Partial<Record<(typeof CATALOG)[K]['labels'][number], string>>;

const counters = new Map<string, Counter>();
const histograms = new Map<string, Histogram>();

/** Instruments are created from the global meter, so they must be re-created when telemetry is (re)initialised. */
export function resetInstruments(): void {
  counters.clear();
  histograms.clear();
}

/** Records metrics for one service. Every data point carries the service name. */
export class Metrics {
  constructor(private readonly service: string) {}

  count<K extends MetricKey>(key: K, labels: LabelsOf<K> = {}, value = 1): void {
    const def = CATALOG[key];
    const id = `${this.service}/${key}`;
    let counter = counters.get(id);
    if (!counter) {
      counter = otelMetrics.getMeter(this.service).createCounter(def.name, {
        description: def.description,
        unit: def.unit,
      });
      counters.set(id, counter);
    }
    counter.add(value, { service: this.service, ...labels });
  }

  observe<K extends MetricKey>(key: K, labels: LabelsOf<K>, value: number): void {
    const def = CATALOG[key];
    const id = `${this.service}/${key}`;
    let histogram = histograms.get(id);
    if (!histogram) {
      histogram = otelMetrics.getMeter(this.service).createHistogram(def.name, {
        description: def.description,
        unit: def.unit,
        ...('buckets' in def && { advice: { explicitBucketBoundaries: [...def.buckets] } }),
      });
      histograms.set(id, histogram);
    }
    histogram.record(value, { service: this.service, ...labels });
  }
}

export const metricsFor = (service: string): Metrics => new Metrics(service);

/** `2xx`, `4xx`, `5xx`: a label with few values, unlike the status code. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

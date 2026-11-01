import { CATALOG, metricsFor, statusClass } from './metrics';
import { METRIC_LABELS } from './sanitize';
import { initTelemetry, type MemoryTelemetry, type Telemetry } from './telemetry';

let telemetry: Telemetry;
let memory: MemoryTelemetry;
beforeEach(() => {
  telemetry = initTelemetry({ serviceName: 'test', traces: 'off', metrics: 'memory' });
  memory = telemetry.memory!;
});
afterEach(async () => {
  await telemetry.shutdown();
});

describe('the metric catalog', () => {
  it('has unique names, and only labels that are allowed', () => {
    const names = Object.values(CATALOG).map((m) => m.name);

    expect(new Set(names).size).toBe(names.length);
    for (const def of Object.values(CATALOG)) {
      for (const label of def.labels) expect(METRIC_LABELS).toContain(label);
    }
  });

  it('describes every metric, and gives histograms the buckets an SLO threshold needs', () => {
    for (const def of Object.values(CATALOG)) expect(def.description.length).toBeGreaterThan(10);
    expect(CATALOG.httpDuration.buckets).toEqual(expect.arrayContaining([1500, 5000]));
    expect(CATALOG.firstToken.buckets).toContain(1500);
  });
});

describe('recording', () => {
  it('counts, labelled with the service and what was passed', async () => {
    const metrics = metricsFor('assistant');

    metrics.count('answers', { outcome: 'grounded', cache: 'miss' });
    metrics.count('answers', { outcome: 'grounded', cache: 'miss' });
    metrics.count('answers', { outcome: 'blocked', cache: 'miss' });

    const points = (await memory.metrics()).filter((p) => p.name === 'genai.assistant.answers');
    expect(points.map((p) => [p.attributes, p.value])).toEqual(
      expect.arrayContaining([
        [{ service: 'assistant', outcome: 'grounded', cache: 'miss' }, 2],
        [{ service: 'assistant', outcome: 'blocked', cache: 'miss' }, 1],
      ]),
    );
  });

  it('records a histogram with the catalog’s buckets', async () => {
    const metrics = metricsFor('assistant');

    metrics.observe('httpDuration', { route: '/v1/ask', method: 'POST', status_class: '2xx' }, 120);
    metrics.observe(
      'httpDuration',
      { route: '/v1/ask', method: 'POST', status_class: '2xx' },
      6000,
    );

    const point = (await memory.metrics()).find((p) => p.name === 'http.server.duration');
    expect(point?.histogram).toMatchObject({
      count: 2,
      sum: 6120,
      boundaries: CATALOG.httpDuration.buckets,
    });
    expect(point?.histogram?.counts.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('drops a label that is not on the list, even if code adds one', async () => {
    const metrics = metricsFor('assistant');

    // a developer adds a label by casting around the types
    metrics.count('answers', {
      outcome: 'grounded',
      question: 'How long do refunds take?',
    } as never);

    const point = (await memory.metrics()).find((p) => p.name === 'genai.assistant.answers');
    expect(point?.attributes).toEqual({ service: 'assistant', outcome: 'grounded' });
  });

  it('keeps services apart, since several can share a process in tests', async () => {
    metricsFor('assistant').count('answers', { outcome: 'grounded' });
    metricsFor('agents').count('answers', { outcome: 'grounded' });

    const services = (await memory.metrics())
      .filter((p) => p.name === 'genai.assistant.answers')
      .map((p) => p.attributes['service']);
    expect(services.sort()).toEqual(['agents', 'assistant']);
  });

  it('is a harmless no-op before telemetry is initialised, and picks up once it is', async () => {
    await telemetry.shutdown();
    metricsFor('assistant').count('answers', { outcome: 'grounded' }); // nowhere to go, and no error

    telemetry = initTelemetry({ serviceName: 'test', traces: 'off', metrics: 'memory' });
    metricsFor('assistant').count('answers', { outcome: 'grounded' });

    const point = (await telemetry.memory!.metrics()).find(
      (p) => p.name === 'genai.assistant.answers',
    );
    expect(point?.value).toBe(1);
  });
});

describe('statusClass', () => {
  it('keeps the label to a few values', () => {
    expect([200, 204, 301, 404, 429, 500, 503].map(statusClass)).toEqual([
      '2xx',
      '2xx',
      '3xx',
      '4xx',
      '4xx',
      '5xx',
      '5xx',
    ]);
  });
});

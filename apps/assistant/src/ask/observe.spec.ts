import { initTelemetry, type Telemetry } from '@genai/observability';
import type { AskResult } from './ask.service';
import { GuardrailBlockedError } from './errors';
import { observeAnswer, observeFailure, outcomeOf } from './observe';

const report = (over: Partial<AskResult['guardrails']> = {}): AskResult['guardrails'] => ({
  mode: 'enforce',
  question: {
    injectionScore: 0,
    injectionSignals: [],
    redactions: [],
    blocked: false,
    wouldBlock: false,
  },
  sources: { scanned: 1, quarantined: 0, wouldQuarantine: 0, signals: [] },
  output: { blocked: false, wouldBlock: false, reasons: [], redactions: [], sanitized: 0 },
  ...over,
});

const result = (over: Partial<AskResult> = {}): AskResult => ({
  requestId: 'r1',
  answer: 'Refunds take five working days. [1]',
  citations: [],
  grounded: true,
  sourcesRetrieved: 1,
  droppedCitations: [],
  guardrails: report(),
  timings: { totalMs: 10, retrievalMs: 2 },
  ...over,
});

let telemetry: Telemetry;
beforeEach(() => {
  telemetry = initTelemetry({ serviceName: 't', traces: 'off', metrics: 'memory' });
});
afterEach(async () => {
  await telemetry.shutdown();
});

const counts = async (name: string) =>
  (await telemetry.memory!.metrics())
    .filter((p) => p.name === name)
    .map((p) => ({ ...p.attributes, value: p.value }));

describe('outcomeOf', () => {
  it.each([
    ['a cited answer', result(), 'grounded'],
    ['an answer with no citation', result({ grounded: false }), 'ungrounded'],
    [
      'nothing permitted to retrieve',
      result({ sourcesRetrieved: 0, grounded: false }),
      'no_sources',
    ],
    [
      'an answer the output check blocked',
      result({
        grounded: false,
        guardrails: report({
          output: {
            blocked: true,
            wouldBlock: true,
            reasons: ['canary_leak'],
            redactions: [],
            sanitized: 0,
          },
        }),
      }),
      'blocked',
    ],
    ['a cached answer', result({ cache: { status: 'hit', kind: 'exact' } }), 'cache_hit'],
  ])('%s is %s', (_label, input, expected) => expect(outcomeOf(input)).toBe(expected));
});

describe('observeAnswer', () => {
  it('counts the outcome with the cache status, and the guardrail decisions behind it', async () => {
    observeAnswer(
      result({
        cache: { status: 'miss' },
        guardrails: report({
          sources: { scanned: 3, quarantined: 1, wouldQuarantine: 0, signals: [] },
          output: {
            blocked: false,
            wouldBlock: false,
            reasons: [],
            redactions: [{ kind: 'iban' } as never],
            sanitized: 0,
          },
        }),
      }),
      'sync',
    );

    expect(await counts('genai.assistant.answers')).toEqual([
      { service: 'assistant', outcome: 'grounded', cache: 'miss', value: 1 },
    ]);
    const guard = await counts('genai.guardrails.events');
    expect(guard).toEqual(
      expect.arrayContaining([
        { service: 'assistant', kind: 'sources', action: 'quarantined', value: 1 },
        { service: 'assistant', kind: 'output', action: 'masked', value: 1 },
      ]),
    );
  });

  it('measures first token only for a stream that has one', async () => {
    observeAnswer(result({ timings: { totalMs: 9, retrievalMs: 1, firstTokenMs: 420 } }), 'stream');
    observeAnswer(result(), 'sync');

    const first = (await telemetry.memory!.metrics()).filter(
      (p) => p.name === 'genai.assistant.first_token',
    );
    expect(first).toHaveLength(1);
    expect(first[0]?.histogram).toMatchObject({ count: 1, sum: 420 });
  });
});

describe('observeFailure', () => {
  it('counts a guardrail refusal as a decision, not a fault', async () => {
    observeFailure(new GuardrailBlockedError(report().question));

    expect(await counts('genai.assistant.answers')).toEqual([
      { service: 'assistant', outcome: 'blocked', cache: 'off', value: 1 },
    ]);
    expect(await counts('genai.guardrails.events')).toEqual([
      { service: 'assistant', kind: 'question', action: 'blocked', value: 1 },
    ]);
  });

  it('counts anything else as an error, which is what the availability SLO reads', async () => {
    observeFailure(new Error('retrieval unreachable'));

    expect(await counts('genai.assistant.answers')).toEqual([
      { service: 'assistant', outcome: 'error', cache: 'off', value: 1 },
    ]);
  });
});

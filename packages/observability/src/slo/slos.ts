import { promName, select } from './names';

/** Windows the error ratio is recorded over. The alert tiers below use the first seven. */
export const WINDOWS = ['5m', '30m', '1h', '2h', '6h', '1d', '3d', '30d'] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_MINUTES: Record<Window, number> = {
  '5m': 5,
  '30m': 30,
  '1h': 60,
  '2h': 120,
  '6h': 360,
  '1d': 1440,
  '3d': 4320,
  '30d': 43200,
};

/**
 * One alert tier: burning the error budget `burn` times faster than allowed, seen over BOTH a long
 * window (it is real, not a blip) and a short one (it is still happening). At 14.4x a 30-day
 * budget is gone in two days and 2% of it in an hour; at 1x it is exactly used up at the end.
 */
export interface Tier {
  name: 'fast' | 'slow' | 'steady' | 'drip';
  severity: 'page' | 'ticket';
  burn: number;
  long: Window;
  short: Window;
  /** How long the condition must hold before the alert fires. */
  for: string;
}

export const TIERS: readonly Tier[] = [
  { name: 'fast', severity: 'page', burn: 14.4, long: '1h', short: '5m', for: '2m' },
  { name: 'slow', severity: 'page', burn: 6, long: '6h', short: '30m', for: '5m' },
  { name: 'steady', severity: 'ticket', burn: 3, long: '1d', short: '2h', for: '15m' },
  { name: 'drip', severity: 'ticket', burn: 1, long: '3d', short: '6h', for: '30m' },
];

export interface Slo {
  id: string;
  title: string;
  service: string;
  /** The share of events that must be good, over 30 days. */
  objective: number;
  /** What a user would call "working", in one sentence. */
  meaning: string;
  /** PromQL for the rate of bad events and of all events over `w`. */
  bad: (w: string) => string;
  total: (w: string) => string;
  /** A quality signal that opens tickets but never wakes anyone. */
  tiers: readonly Tier['name'][];
}

const rate = (series: string, filters: Record<string, string>, w: string): string =>
  `sum(rate(${select(series, filters)}[${w}]))`;

const ASK = { service: 'assistant', route: '/v1/ask' };

/** Fraction of a histogram's observations above `le`: total minus the cumulative bucket. */
const slowerThan =
  (key: 'httpDuration' | 'firstToken', filters: Record<string, string>, le: number) =>
  (w: string) =>
    `(${rate(`${promName(key)}_count`, filters, w)} - ${rate(`${promName(key)}_bucket`, { ...filters, le: String(le) }, w)})`;

export const SLOS: readonly Slo[] = [
  {
    id: 'assistant-availability',
    title: 'Assistant availability',
    service: 'assistant',
    objective: 0.995,
    meaning: 'A question is answered, or refused for a reason, not dropped by a server fault.',
    bad: (w) => rate(promName('httpRequests'), { ...ASK, status_class: '5xx' }, w),
    total: (w) => rate(promName('httpRequests'), ASK, w),
    tiers: ['fast', 'slow', 'steady', 'drip'],
  },
  {
    id: 'assistant-latency',
    title: 'Assistant latency',
    service: 'assistant',
    objective: 0.95,
    meaning: 'A complete answer arrives within 5 seconds.',
    bad: slowerThan('httpDuration', { ...ASK, method: 'POST' }, 5000),
    total: (w) => rate(`${promName('httpDuration')}_count`, { ...ASK, method: 'POST' }, w),
    tiers: ['fast', 'slow', 'steady', 'drip'],
  },
  {
    id: 'assistant-first-token',
    title: 'Assistant first token',
    service: 'assistant',
    objective: 0.95,
    meaning: 'A streamed answer starts to appear within 1.5 seconds.',
    bad: slowerThan('firstToken', { service: 'assistant' }, 1500),
    total: (w) => rate(`${promName('firstToken')}_count`, { service: 'assistant' }, w),
    tiers: ['fast', 'slow', 'steady', 'drip'],
  },
  {
    id: 'gateway-availability',
    title: 'Model gateway availability',
    service: 'llm-gateway',
    objective: 0.995,
    meaning: 'A model call that was allowed gets an answer, from the model or its fallback.',
    bad: (w) => rate(promName('llmCalls'), { service: 'llm-gateway', outcome: 'error' }, w),
    total: (w) =>
      rate(
        promName('llmCalls'),
        { service: 'llm-gateway', outcome: '~ok|fallback_served|error' },
        w,
      ),
    tiers: ['fast', 'slow', 'steady', 'drip'],
  },
  {
    id: 'ingestion-success',
    title: 'Ingestion success',
    service: 'ingestion',
    objective: 0.99,
    meaning: 'A document that is sent in becomes searchable, rather than failing for good.',
    bad: (w) =>
      rate(promName('ingestionJobs'), { service: 'ingestion', result: '~failed|dead_lettered' }, w),
    total: (w) =>
      rate(
        promName('ingestionJobs'),
        { service: 'ingestion', result: '~succeeded|unchanged|failed|dead_lettered' },
        w,
      ),
    tiers: ['steady', 'drip'],
  },
  {
    id: 'answer-grounding',
    title: 'Answer grounding',
    service: 'assistant',
    objective: 0.9,
    meaning:
      'An answer that was generated cites the sources it came from (a stated "I do not know" is not counted either way).',
    bad: (w) => rate(promName('answers'), { service: 'assistant', outcome: 'ungrounded' }, w),
    total: (w) =>
      rate(promName('answers'), { service: 'assistant', outcome: '~grounded|ungrounded' }, w),
    tiers: ['steady', 'drip'],
  },
];

/** The share of events allowed to be bad. */
export const errorBudget = (slo: Slo): number => Number((1 - slo.objective).toFixed(6));

/** The error ratio at which a tier fires for this SLO. */
export const threshold = (slo: Slo, tier: Tier): number =>
  Number((tier.burn * errorBudget(slo)).toPrecision(6));

/** How fast the budget is being used: 1 means exactly as fast as it is granted. */
export const burnRate = (slo: Slo, errorRatio: number): number => errorRatio / errorBudget(slo);

export const tiersOf = (slo: Slo): Tier[] => TIERS.filter((t) => slo.tiers.includes(t.name));

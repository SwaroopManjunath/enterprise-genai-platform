import { BUILTIN_PROMPT_TEMPLATE } from '../../../apps/assistant/src/ask/prompt';
import type { Stack, StackOptions } from '../../e2e/src/stack';
import { isAbstention } from './metrics';

/**
 * A way of making the system worse on purpose, to check that the gate would notice. Each variant
 * is a realistic regression (a model that makes things up, a prompt that lost its sources, an
 * ingestion bug that dropped a document, guardrails left in shadow mode), and says which metrics
 * must fail. A gate that has never been seen to fail is a hope, not a control.
 */
export interface Variant {
  name: string;
  description: string;
  /** What the gate should do with it. */
  expectGate: 'pass' | 'fail';
  /** Metrics that must be among the failures when `expectGate` is `fail`. */
  expectedFailures: string[];
  stack?: StackOptions;
  /** Documents the ingestion "lost": they are never uploaded. */
  skipDocuments?: string[];
  setup?(stack: Stack, tenants: string[]): Promise<void>;
}

/** Applies `change` to answers that are answers, leaving a refusal alone. */
const onAnswers =
  (change: (content: string) => string) =>
  (content: string): string =>
    isAbstention(content) ? content : change(content);

async function publishPrompt(stack: Stack, tenants: string[], template: string): Promise<void> {
  for (const tenant of tenants) await stack.publishPrompt(tenant, 'rag-answer', template, 1);
}

export const VARIANTS: Record<string, Variant> = {
  good: {
    name: 'good',
    description: 'The system as it is.',
    expectGate: 'pass',
    expectedFailures: [],
  },
  hallucinating: {
    name: 'hallucinating',
    description: 'A model that adds a confident sentence no source supports to every answer.',
    expectGate: 'fail',
    expectedFailures: ['groundedness'],
    setup: (stack) => {
      stack.llm.transform = onAnswers(
        (c) => `${c} Premium customers receive this within one hour.`,
      );
      return Promise.resolve();
    },
  },
  'wrong-citations': {
    name: 'wrong-citations',
    description: 'A model that cites the wrong source number.',
    expectGate: 'fail',
    expectedFailures: ['citationRecall'],
    setup: (stack) => {
      stack.llm.transform = (c) => c.replace(/\[(\d)\]/g, (_m, n: string) => `[${Number(n) + 1}]`);
      return Promise.resolve();
    },
  },
  'ignores-sources': {
    name: 'ignores-sources',
    description: 'A model that answers from general knowledge instead of the sources.',
    expectGate: 'fail',
    expectedFailures: ['factRecall', 'groundedness'],
    setup: (stack) => {
      stack.llm.transform = onAnswers(
        () => 'That usually depends on the product, so please ask your branch.',
      );
      return Promise.resolve();
    },
  },
  'slips-once': {
    name: 'slips-once',
    description:
      'One answer gets a made-up sentence. Every threshold still holds: only the ratchet notices.',
    expectGate: 'fail',
    expectedFailures: ['caseAccuracy'],
    setup: (stack) => {
      stack.llm.transform = (c) =>
        c.includes('Customer records are kept') ? `${c} Backups are kept for ever.` : c;
      return Promise.resolve();
    },
  },
  'lost-documents': {
    name: 'lost-documents',
    description: 'An ingestion bug that never indexed two of the documents.',
    expectGate: 'fail',
    expectedFailures: ['retrievalRecallAtK', 'answerRate'],
    skipDocuments: ['fees-schedule', 'card-limits'],
  },
  'bad-prompt': {
    name: 'bad-prompt',
    description: 'A prompt version published without its {{sources}}.',
    expectGate: 'fail',
    expectedFailures: ['answerRate', 'factRecall'],
    setup: (stack, tenants) =>
      publishPrompt(stack, tenants, 'Answer the question briefly.\n\nQuestion: {{question}}'),
  },
  'verbose-prompt': {
    name: 'verbose-prompt',
    description:
      'A prompt version padded with pages of boilerplate: the same answers at a higher cost.',
    expectGate: 'fail',
    expectedFailures: ['avgTokens'],
    setup: (stack, tenants) =>
      publishPrompt(
        stack,
        tenants,
        `${'Always be polite, professional and concise, and follow the house style of the organisation. '.repeat(25)}\n\n${BUILTIN_PROMPT_TEMPLATE}`,
      ),
  },
  'guardrails-monitor': {
    name: 'guardrails-monitor',
    description: 'Guardrails left in shadow mode: nothing is blocked, quarantined or redacted.',
    expectGate: 'fail',
    expectedFailures: ['forbiddenRate', 'blockAccuracy'],
    stack: { guardrailsMode: 'monitor' },
  },
};

export const variantNames = Object.keys(VARIANTS);

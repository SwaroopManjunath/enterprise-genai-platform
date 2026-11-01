import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DATASETS_DIR } from './dataset';
import type { Judge } from './judge';

const schema = z.object({
  examples: z.array(
    z.object({
      id: z.string(),
      answer: z.string(),
      sources: z.array(z.string()),
      /** Is every claim in the answer supported by the sources? The human label. */
      grounded: z.boolean(),
      note: z.string(),
      /** The judge is known to get this one wrong (either way): reported, not counted. */
      knownMiss: z.boolean().optional(),
    }),
  ),
});

export type MetaExample = z.infer<typeof schema>['examples'][number];

export const loadMetaExamples = (file = join(DATASETS_DIR, 'judge-meta.json')): MetaExample[] =>
  schema.parse(JSON.parse(readFileSync(file, 'utf8'))).examples;

export interface JudgeAccuracy {
  /** Of the labelled examples the judge is expected to get right, the share it did. */
  accuracy: number;
  counted: number;
  wrong: string[];
  /** Known misses the judge still gets wrong, and ones it has since learned to get right. */
  stillMissed: string[];
  nowRight: string[];
}

/**
 * How good the judge itself is. A groundedness score is only as trustworthy as the judge that
 * produced it, so the judge is graded on examples a person labelled, including ones it is known to
 * fail, and that grade is part of the evaluation.
 */
export async function measureJudge(
  judge: Judge,
  examples: readonly MetaExample[],
): Promise<JudgeAccuracy> {
  const wrong: string[] = [];
  const stillMissed: string[] = [];
  const nowRight: string[] = [];
  let counted = 0;

  for (const example of examples) {
    const verdict = (await judge.groundedness(example.answer, example.sources)).score === 1;
    if (example.knownMiss) {
      (verdict === example.grounded ? nowRight : stillMissed).push(example.id);
      continue;
    }
    counted += 1;
    if (verdict !== example.grounded) wrong.push(example.id);
  }
  return {
    accuracy: counted === 0 ? 1 : (counted - wrong.length) / counted,
    counted,
    wrong,
    stillMissed,
    nowRight,
  };
}

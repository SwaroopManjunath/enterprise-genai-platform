import { createHash } from 'node:crypto';

export interface WeightedVariant<T> {
  value: T;
  weight: number;
}

/**
 * Maps a key to a stable number in [0, 1). The same key always lands on the same point, so
 * assignment needs no stored state and survives restarts and multiple replicas.
 */
export function hashToUnitInterval(key: string): number {
  const digest = createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/**
 * Picks a variant for `key` in proportion to the weights. A user keeps seeing the same variant
 * for as long as the experiment definition is unchanged ("sticky" assignment), which keeps
 * comparisons clean: nobody flips between prompts mid-conversation.
 */
export function pickVariant<T>(key: string, variants: readonly WeightedVariant<T>[]): T {
  if (variants.length === 0) throw new Error('pickVariant needs at least one variant');

  const total = variants.reduce((sum, v) => sum + v.weight, 0);
  const point = hashToUnitInterval(key) * total;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (point < cumulative) return variant.value;
  }
  return (variants[variants.length - 1] as WeightedVariant<T>).value;
}

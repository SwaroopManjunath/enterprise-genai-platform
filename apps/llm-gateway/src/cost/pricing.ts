import type { Usage } from '../llm/types';

/** US dollars per million tokens, as providers publish them. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface Cost {
  /** Millionths of a US dollar. Integers, so sums never drift. */
  microUsd: number;
  /** False when the provider has no price on file: the spend is real but unknown, and is counted apart. */
  priced: boolean;
}

/**
 * What each deployment costs, by the label the gateway reports for it. A price is dollars per
 * million tokens, so one token at $2.50/MTok costs exactly 2.5 micro-dollars: tokens x price is
 * already in micro-dollars, with no division.
 */
export class PriceBook {
  constructor(private readonly prices: Readonly<Record<string, ModelPrice>>) {}

  cost(provider: string, usage: Pick<Usage, 'promptTokens' | 'completionTokens'>): Cost {
    const price = this.prices[provider];
    if (!price) return { microUsd: 0, priced: false };
    return {
      microUsd: Math.round(
        usage.promptTokens * price.inputPerMTok + usage.completionTokens * price.outputPerMTok,
      ),
      priced: true,
    };
  }
}

export const PRICE_BOOK = Symbol('PRICE_BOOK');

export const usdToMicro = (usd: number): number => Math.round(usd * 1_000_000);
export const microToUsd = (micro: number): number => micro / 1_000_000;

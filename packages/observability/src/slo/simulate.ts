import { WINDOW_MINUTES, threshold, tiersOf, type Slo, type Tier, type Window } from './slos';

/**
 * Plays a stretch of traffic against an SLO's alert tiers, the way Prometheus would evaluate them.
 * `errorRatios[i]` is the share of bad events during minute i, at a steady request rate, so a
 * window's ratio is just the mean of the minutes in it. Returns the minute each tier first fires.
 */
export function firstFiring(
  slo: Slo,
  errorRatios: readonly number[],
): Partial<Record<Tier['name'], number>> {
  const fired: Partial<Record<Tier['name'], number>> = {};
  const mean = (end: number, w: Window): number => {
    const from = Math.max(0, end - WINDOW_MINUTES[w] + 1);
    let sum = 0;
    for (let i = from; i <= end; i++) sum += errorRatios[i] ?? 0;
    // A window not yet full counts the missing minutes as good, as Prometheus does for new series.
    return sum / WINDOW_MINUTES[w];
  };
  const held = new Map<Tier['name'], number>();
  for (let minute = 0; minute < errorRatios.length; minute++) {
    for (const tier of tiersOf(slo)) {
      const limit = threshold(slo, tier);
      if (mean(minute, tier.long) > limit && mean(minute, tier.short) > limit) {
        const since = held.get(tier.name) ?? minute;
        held.set(tier.name, since);
        if (minute - since >= parseMinutes(tier.for) && fired[tier.name] === undefined) {
          fired[tier.name] = minute;
        }
      } else {
        held.delete(tier.name);
      }
    }
  }
  return fired;
}

const parseMinutes = (text: string): number => Number(text.slice(0, -1));

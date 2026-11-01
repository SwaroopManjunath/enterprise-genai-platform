/** Rough heuristic (~4 chars per token); real counts come from the upstream usage field. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

import { createHash } from 'node:crypto';
import type { PromptInfo } from '../ask/ask.service';
import type { Source } from '../ask/sources';
import { BUILTIN_PROMPT_TEMPLATE } from '../ask/prompt';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * A fingerprint of everything the model is given, other than the question: the exact sources, in
 * order, by content (not just id, so an edited document changes it), the prompt that framed them,
 * and the guardrail mode and cache epoch. Two requests share it only when the model would see the
 * same thing, which is what makes reusing one's answer for the other safe:
 *
 *  - a user who cannot see a restricted document gets different sources, so a different fingerprint;
 *  - a document or prompt that changed gets a different fingerprint, so a stale answer is never
 *    served and old entries just age out;
 *  - another tenant's sources differ, and the tenant is part of the scope as well.
 */
export function sourcesFingerprint(
  sources: readonly Source[],
  prompt: PromptInfo,
  extras: { guardrailsMode: string; epoch: string },
): string {
  return sha(
    JSON.stringify({
      sources: sources.map((s) => [s.chunkId, sha(s.text)]),
      prompt:
        prompt.source === 'builtin'
          ? ['builtin', sha(BUILTIN_PROMPT_TEMPLATE)]
          : [prompt.name, prompt.version],
      guardrails: extras.guardrailsMode,
      epoch: extras.epoch,
    }),
  );
}

import { countInvisible, countTagCharacters, normalizeForDetection } from './normalize';

export interface InjectionAssessment {
  /** 0 (nothing suspicious) to 1 (almost certainly an attack). */
  score: number;
  /** Which indicators fired, by name. Never the matched text. */
  signals: string[];
}

/**
 * Where a score becomes an action depends on who wrote the text:
 *  - A user's question is allowed to be odd (people ask about prompts), so only a combination of
 *    strong signals blocks it.
 *  - A retrieved document has no authority to give the assistant instructions at all, so a single
 *    strong signal is enough to quarantine the passage.
 */
export const QUESTION_BLOCK_THRESHOLD = 0.8;
export const SOURCE_QUARANTINE_THRESHOLD = 0.55;

interface Indicator {
  name: string;
  weight: number;
  pattern: RegExp;
}

const INDICATORS: Indicator[] = [
  {
    name: 'override_instructions',
    weight: 0.6,
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(?:instructions?|rules|prompts?|guidelines|directions|constraints)\b/,
  },
  {
    name: 'new_instructions',
    weight: 0.35,
    pattern:
      /\b(?:new|updated|real|actual|revised)\s+(?:instructions?|task|rules|system prompt)\s*[:-]/,
  },
  {
    name: 'role_reassignment',
    weight: 0.45,
    pattern: /\byou are (?:now|no longer)\b|\bfrom now on,? you (?:are|will|must|should)\b/,
  },
  {
    name: 'no_restrictions',
    weight: 0.5,
    pattern:
      /\b(?:without|with no|no longer have any)\s+(?:any\s+)?(?:restrictions|limitations|filters|rules)\b/,
  },
  {
    name: 'reveal_prompt',
    weight: 0.55,
    pattern:
      /\b(?:reveal|show|print|repeat|output|display|leak|tell me)\b[^.\n]{0,40}\b(?:system prompt|your (?:initial |hidden |secret |original )?(?:instructions|prompt)|the prompt above)\b/,
  },
  {
    name: 'fake_role_marker',
    weight: 0.5,
    pattern:
      /(?:^|\n)\s*(?:system|assistant|developer)\s*:|<\|im_(?:start|end)\|>|\[\/?inst\]|<<\/?sys>>|begin system prompt/,
  },
  {
    name: 'jailbreak_terms',
    weight: 0.5,
    pattern: /\b(?:dan mode|developer mode|jailbreak|do anything now)\b/,
  },
  {
    name: 'exfiltration',
    weight: 0.4,
    pattern:
      /!\[[^\]]*\]\(https?:\/\/[^)\s]*\?[^)]*\)|\b(?:send|post|forward|upload|exfiltrate|transmit)\b[^.\n]{0,60}\bhttps?:\/\//,
  },
  {
    name: 'concealment',
    weight: 0.35,
    pattern:
      /\bdo not (?:tell|inform|mention|reveal)\b[^.\n]{0,30}\b(?:user|anyone|human)\b|\bwithout (?:telling|informing) the user\b/,
  },
  { name: 'encoded_blob', weight: 0.2, pattern: /[a-z0-9+/]{140,}={0,2}/ },
  // German: the platform's first market is German-speaking, so the common phrasings are covered.
  {
    name: 'override_instructions_de',
    weight: 0.6,
    pattern:
      /\b(?:ignoriere|ignorier|vergiss|missachte|umgehe)\b[^.\n]{0,40}\b(?:vorherigen|vorigen|obigen|bisherigen|alle|deine|s[aä]mtliche)\b[^.\n]{0,30}\b(?:anweisungen|regeln|instruktionen|vorgaben|befehle)\b/,
  },
  {
    name: 'reveal_prompt_de',
    weight: 0.55,
    pattern:
      /\b(?:zeige|verrate|nenne|gib)\b[^.\n]{0,30}\b(?:system-?prompt|deine (?:anweisungen|instruktionen))\b/,
  },
];

/**
 * Heuristic detector for prompt injection: text that tries to give the AI instructions instead of
 * information. Indicators are combined with a noisy-or (`1 - Π(1 - weight)`), so independent weak
 * signals add up without ever exceeding 1.
 *
 * Be clear about what this is. It is a pattern list, so it catches the common phrasings and
 * obfuscations (full-width letters, look-alike alphabets, invisible characters) but NOT a
 * determined attacker who paraphrases, uses another language, or splits an instruction across
 * several passages. It lowers risk; it is one layer next to prompt hardening, output checks and
 * access control, never the only defence.
 */
export function detectInjection(text: string): InjectionAssessment {
  const normalized = normalizeForDetection(text);
  const fired: Array<{ name: string; weight: number }> = INDICATORS.filter((i) =>
    i.pattern.test(normalized),
  ).map(({ name, weight }) => ({ name, weight }));

  // Invisible characters are checked on the raw text, because normalisation removes them.
  if (countTagCharacters(text) > 0) fired.push({ name: 'tag_characters', weight: 0.7 });
  if (countInvisible(text) >= 3) fired.push({ name: 'invisible_characters', weight: 0.3 });

  const score = 1 - fired.reduce((product, s) => product * (1 - s.weight), 1);
  return { score: Math.round(score * 1000) / 1000, signals: fired.map((s) => s.name) };
}

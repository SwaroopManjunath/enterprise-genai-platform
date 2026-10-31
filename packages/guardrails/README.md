# @genai/guardrails

Checks for the three places untrusted text crosses into or out of the model: the **question**, the
**retrieved documents** and the **answer**. Pure functions with no I/O and no dependencies, so they are
easy to test and safe to call anywhere.

> **Honest limits.** These are pattern-based checks. They catch the common attacks and obfuscations,
> not a determined attacker who paraphrases, uses another language, or splits an instruction across
> passages. They are one layer next to prompt hardening and access control, never the only defence.
> See [ADR 0010](../../docs/adr/0010-guardrails.md).

## What it does

| Boundary     | Check                                                         | Action when enforcing                                |
| ------------ | ------------------------------------------------------------- | ---------------------------------------------------- |
| Question in  | Prompt-injection score (blocks at 0.8: needs several signals) | Refuse (generic 422)                                 |
| Question in  | PII and secrets                                               | Mask before search, prompt and model                 |
| Documents in | Injection score (quarantine at 0.55: one strong signal)       | Drop the passage from the prompt                     |
| Answer out   | Per-request canary, repeated instruction text                 | Replace with a fixed message that says nothing why   |
| Answer out   | Markdown images, HTML, link destinations                      | Remove (a client would fetch an image automatically) |
| Answer out   | Cards, IBANs, secrets (configurable)                          | Redact as `[REDACTED:TYPE]`                          |

Documents get a lower threshold than questions on purpose: a document has no authority to instruct the
assistant, while a user may legitimately ask odd questions.

## Use

```ts
import { Guardrails } from '@genai/guardrails';

const guardrails = new Guardrails({ mode: 'enforce' }); // or 'monitor' (shadow mode)

const q = guardrails.checkQuestion(question); // { blocked, text (masked), report }
const s = guardrails.screenSources(retrievedChunks); // { kept, report }
const o = guardrails.checkOutput(answer, { canary, instructionText }); // { blocked, text, report }
```

The building blocks are exported too: `detectInjection`, `redactPii`, `detectPii`, `sanitizeOutput`,
`containsCanary`, `leaksInstructions`.

## Modes

- **`enforce`**: block, quarantine and redact.
- **`monitor`**: shadow mode. Detect everything and report what _would_ happen, change nothing. Use it to
  learn the false-positive rate on real traffic before enforcing.

There is no "off".

## Reports never contain the text

Every report holds kinds, counts and signal names only (`{ type: 'iban', count: 1 }`,
`signals: ['override_instructions']`), so a report cannot leak the sensitive data or the attack text it
describes. Tests assert this.

## PII and secrets

Cards are validated with Luhn and IBANs with mod-97, so ordinary long numbers, dates, ticket numbers and
version strings are left alone. Secrets cover common key and token formats (AWS, GitHub, API keys, JWTs,
private-key headers) and labelled credentials (`password = ...`). No names or addresses: that needs entity
recognition and is not built.

## Injection detection

Independent indicators (override and reveal phrasing, fake role markers, jailbreak terms, exfiltration,
concealment, hidden characters, in English and German) are combined with a noisy-or. Text is normalised
first, so full-width letters, look-alike Cyrillic or Greek letters, and zero-width or Unicode tag
characters do not dodge it. The tests include an attack corpus, a benign corpus, and the **known evasions**
asserted as documented limitations.

## Tests

```bash
npm test -w @genai/guardrails
```

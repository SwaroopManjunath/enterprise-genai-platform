# Answer grounding

**Alerts:** `AnswerGrounding{Steady,Drip}Burn` (tickets, never pages). **SLO:** 90% of generated answers
cite the sources they came from. It counts `grounded` against `ungrounded`; refusals, cache hits and
"no sources" answers are left out.

This is a quality signal. It cannot say an answer is true, only that it carries citations that map to
retrieved sources. The evaluation gate (ADR 0014) is what judges truth.

## Check

1. Did the prompt change? `genai.prompt.version` is on every ask span. A bad prompt version is the most
   common cause: roll it back in the prompt registry.
2. Did the model change (`genai.model.provider`, `genai.model.fallback`)? A fallback model may cite
   less reliably.
3. Run `npm run eval` against the same configuration. If the gate fails, the answer quality really
   dropped; if it passes, look at which questions real users ask that the dataset does not cover, and
   add them to the dataset.

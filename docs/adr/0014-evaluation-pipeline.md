# ADR 0014: Evaluation pipeline

- Status: Accepted
- Date: 2026-11-01

## Context

Everything built so far is tested for behaviour: access control holds, limits hold, the checks run. None
of it says whether the answers are any good, and none of it would notice if they got worse. A prompt
edit, a different chunk size, a new model version or a "harmless" refactor can make answers wrong,
uncited or invented while every test stays green. Quality is the one property that changes silently.

So the platform needs a number for it, measured the same way every time, with a build that fails when the
number drops. Two traps come with that. A gate that has never been seen to fail may not work. And a
number is only as trustworthy as whatever measures it, which for groundedness is a judge.

## Decisions

### 1. Evaluate the whole path, at its edge, against labelled cases

A dataset of 41 questions runs through the real services over HTTP (ingestion, retrieval, prompt
registry, gateway, assistant), not through mocks of them. Each case says who asks, what is right, and
what must not happen. They cover the behaviours that matter, each in its own category: plain and reworded
questions, questions needing two sources, restricted documents asked for by a role that may and one that
may not read them, questions with no answer, an injected instruction, a prompt-leak attempt, a document
holding an IBAN, and another tenant's question. The corpus has 11 documents in two tenants.

### 2. Measure each stage on its own, so a failure says where

Retrieval is also asked directly, as the same user, so its recall and rank are measured on retrieval
itself and not inferred from the answer. Then, per answer: **fact recall** (the phrases that must be
there), **groundedness** (is every claim supported by the chunks it cites), **citation precision and
recall**, **abstention** (decline what has no answer, answer what has), **refusal** of an outright attack,
**forbidden text** (a restricted fact, an injected payload) and **leaked documents** (retrieval returning
what the caller must never see). Cost is measured as tokens per answer. A failing case says in words what
was wrong with it.

### 3. The judge is independent, honest about its limits, and graded itself

Groundedness needs a judge. The one used now needs no model: a claim is supported only if most of its
words are in the sources, every number is, each number has the same unit after it, and it agrees with its
closest source sentence about negation. That catches an invented claim, a wrong number, `2500 dollars`
for `2500 euros` and a flipped meaning. It has its own tokeniser rather than the assistant's, so a change
to the system under test cannot change the measurement.

Its blind spots are on record, not hidden. 21 answers labelled by a person grade the judge, three of
which it is known to get wrong: a claim recombined from the sources' own words, two numbers swapped
between their subjects, and a faithful paraphrase (it rejects words it does not recognise). The judge has
to score at least 0.9 on the rest, and a test fails if it ever gets a "known miss" right so the list is
kept honest. A model-based judge exists behind the same interface (it replies with one boolean per claim
and fails rather than guessing a score, and treats the answer and sources as data, never instructions);
it is the one to use against a real model, which will paraphrase.

### 4. The gate has four kinds of check, so quality cannot slip through any one

- **Floors and ceilings** on every metric, absolute, whatever the last build did.
- **A ratchet** against a committed baseline: no metric may move the wrong way by more than 0.02 (cost by
  5%), and no new leak or forbidden text at all, even while it is above its floor. Quality only goes up.
- **Sample size**: enough cases overall and per category for the numbers to mean something.
- **The judge's own score.**

A metric that cannot be computed fails its check; a missing number is never a pass.

### 5. Say what is not gated, and why

Two categories are reported but do not gate the build, each with its reason in the config and the report.
**Multi-source**: the stand-in model answers from a single source, so it cannot combine two; gate it once
a real model is evaluated. **Known gaps**: a question carrying a single injection signal is not blocked
by design (ADR 0010 blocks only combinations), so a naive model can obey it; it stays visible instead of
being quietly excluded or quietly relabelled. A green build that hides a known failure is worse than an
amber one that shows it.

### 6. The dataset is validated, and the definition of "good" is under review

A wrong label produces a failing score that looks like a regression, or a passing one that means nothing,
so every case is checked against the corpus before it is trusted: expected documents exist and the
caller may read them, each required fact is really in them, and a "must not see" document really is out
of reach (a leak check that could never fail proves nothing). The thresholds, baseline, dataset and
workflows are under CODEOWNERS, and the baseline is only ever recorded from a build that passes.

### 7. Prove the gate by playing regressions back

Eight degraded variants are run through the same pipeline and each must be caught by the right metric: a model that
invents a sentence, cites the wrong source or ignores its sources; an ingestion bug that lost two
documents; a prompt published without its sources; a prompt padded with boilerplate; guardrails left in
shadow mode; and **one** answer that slips, which every floor lets through and only the ratchet catches.
They run as tests and as a CI step, so the gate cannot be weakened without a build failing. The evaluation
code itself was broken on purpose eleven ways (the judge ignoring numbers, units or negation; judging
an answer against itself; the gate ignoring the baseline, passing a missing number or tolerating
anything; skipping the forbidden-text or leak checks; gating the informational categories; accepting an
unsound dataset) and each fails its tests.

## What the first run found

The first run scored 34 of 38 gated cases, which is the point of having one:

- The stand-in model answered from any source sharing a single word with the question (a salary question
  was answered with a sentence about line managers). A real model would decline. The stand-in now needs
  half the question covered, and two cache tests that depended on the old behaviour were rewritten with
  questions the sources actually cover.
- A label of mine was wrong: a one-signal injection is not blocked by design. The blocked case now uses
  the two-signal question.
- A genuine gap: that one-signal injection does reach a naive model and gets obeyed. Recorded as a known
  gap, not hidden.

## Consequences

- The model is a deterministic stand-in, so thresholds are calibrated to it (every score is 1) and mean
  little for a real model. The first run against Azure (Step 15) must recalibrate them, run each case
  several times and gate on a confidence interval, because a real model is not deterministic.
- 41 cases written by the people who wrote the system will flatter it. They need to be joined by cases
  sampled from real questions, and by a held-out set nobody tunes against.
- Gold labels are at document level, not passage level, and the lexical judge rejects faithful paraphrase,
  which a real model will produce plenty of: use the model-based judge there, and measure it against the
  same labelled examples.
- Latency is reported (p95) but not gated, and cost is only tokens. The evaluation runs on in-memory
  services, so it says nothing about Azure.
- The ratchet and the baseline are only as good as the review of the pull request that changes them.

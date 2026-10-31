# ADR 0001: Record architecture decisions

- Status: Accepted
- Date: 2026-10-31

## Context

This platform has many cross-cutting choices (search strategy, ingestion model, tenancy, caching).
Without a written trail, the reasoning behind them is lost and gets re-litigated.

## Decision

We record significant decisions as short ADRs in `docs/adr/`, using Context / Decision /
Alternatives / Consequences, and review them in the same pull request as the code.

## Alternatives considered

- **Wiki or Notion pages:** drift away from the code and are not versioned with it.
- **No records:** cheapest now, expensive every time someone asks "why did we do it this way?".

## Consequences

- Small overhead per significant change.
- New contributors can read the history of the design in order.

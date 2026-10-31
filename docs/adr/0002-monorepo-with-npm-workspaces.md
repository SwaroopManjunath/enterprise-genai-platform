# ADR 0002: Monorepo with npm workspaces

- Status: Accepted
- Date: 2026-10-31

## Context

The platform is several services (gateway, retrieval, ingestion, agents, MCP gateway) that share
types such as tenant identity, error shapes and telemetry helpers. We need atomic cross-service
changes, one CI pipeline and one place to enforce standards, while keeping each service
independently deployable as its own container.

## Decision

One repository, npm workspaces: deployable services in `apps/*`, shared libraries in `packages/*`.
Each app builds to its own Docker image; shared code is consumed as `@genai/*` packages.

## Alternatives considered

- **Polyrepo:** clean ownership boundaries, but shared-type changes need coordinated releases
  across repos, and CI/standards drift.
- **Nx or Turborepo:** better task caching and affected-only builds. Worth adopting if CI time
  becomes a problem; deferred to avoid tooling weight before it earns its place.
- **pnpm workspaces:** stricter dependency isolation and faster installs; npm chosen because it
  ships with Node and has zero setup for contributors. Revisit if install time hurts.

## Consequences

- A single `npm ci` and a single CI workflow cover everything.
- A bad change to `@genai/shared` can break every service, so it needs strong tests.
- If the repo grows large we may adopt Nx/Turborepo for affected-only builds (new ADR).

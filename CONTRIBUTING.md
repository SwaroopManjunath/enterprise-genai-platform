# Contributing

## Workflow

1. Branch from `main`: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`, `docs/<topic>`.
2. Make small, focused commits.
3. Open a pull request using the template; CI must be green.
4. Squash or rebase merge so `main` stays a clean, linear history.

## Commit messages: Conventional Commits

```
<type>(<scope>): <imperative summary, max 72 chars>

<body: why this change, not what; wrap at 72>

<footer: BREAKING CHANGE, issue links>
```

- **Types:** `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `chore`
- **Scopes:** see `commitlint.config.mjs` (`gateway`, `retrieval`, `agents`, ...)
- Summary is lowercase, imperative ("add rate limiter", not "Added rate limiter").

A `commit-msg` hook (husky + commitlint) enforces this locally and CI enforces it on PRs.

## Local setup

```bash
nvm use            # Node 22
npm install        # also installs git hooks
npm run lint && npm run typecheck && npm test
```

## Definition of done

Tests for new behavior, docs updated, no secrets in the diff, and an ADR for any decision that
would be expensive to reverse.

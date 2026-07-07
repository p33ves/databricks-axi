# Contributing

## Setup

```bash
corepack enable
pnpm install
pnpm test
```

Node 24 is what CI runs; `engines` allows >= 20.

## Ship through no-mistakes (required)

Human PRs to `main` must be raised via
[no-mistakes](https://github.com/kunchenguid/no-mistakes) — a local git proxy
that runs review, tests, lint, and docs checks in an isolated worktree before
anything reaches the remote. CI rejects PRs without its signature
(`.github/workflows/no-mistakes-required.yml`); release/dependency bots are
exempt.

One-time setup in your clone (install per the no-mistakes README — note the
npm package named `no-mistakes` is an unrelated project):

```bash
no-mistakes init
```

Then ship every change with:

```bash
git push no-mistakes        # instead of: git push origin
```

Working from a fork requires no-mistakes >= 1.30.1.

## Conventions

- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`).
- `skills/databricks-axi/SKILL.md` is generated — edit `src/skill.ts` /
  `src/cli.ts` and run `pnpm run build:skill`. CI fails on a stale copy.
- Everything else: see [AGENTS.md](AGENTS.md).

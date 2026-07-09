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
[no-mistakes](https://github.com/kunchenguid/no-mistakes), a local git proxy
that runs review, tests, lint, and docs checks in an isolated worktree before
anything reaches the remote. Its test/lint/format commands are pinned in
`.no-mistakes.yaml` (trusted only from the default branch) to the full gate
documented in [AGENTS.md](AGENTS.md). CI rejects PRs without its signature
(`.github/workflows/no-mistakes-required.yml`); release/dependency bots are
exempt.

`main` itself is protected by the `protect-main` ruleset: PR-only, no
force-pushes or deletion, four required status checks. The ruleset applied
on GitHub is recorded as config-as-code in `.github/rulesets/main.json`
(importable via GitHub's ruleset import UI).

One-time setup in your clone (install per the no-mistakes README; note the
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
- `skills/databricks-axi/SKILL.md` is generated. Edit `src/skill.ts` or
  `src/cli.ts` and run `pnpm run build:skill`. CI fails on a stale copy.
- Never hand-bump `package.json`'s `version`; release-please sets it in its
  own release PR from your conventional commits.
- Everything else: see [AGENTS.md](AGENTS.md).

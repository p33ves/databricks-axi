# AGENTS.md

Conventions for agents (and humans) working on databricks-axi. This file is
canonical; CLAUDE.md defers here.

## What this is

AXI-compliant wrapper around the official `databricks` CLI (Go, >= 0.298;
v1.x is fine — the guard only rejects 0.x below 0.298).
The [AXI standard](https://github.com/kunchenguid/axi) defines 10 principles —
they are requirements, not suggestions.

## Commands

| Command                                   | Purpose                                     |
| ----------------------------------------- | ------------------------------------------- |
| `pnpm test`                               | vitest run (unit + stub-driven e2e)         |
| `pnpm run lint` / `pnpm run format:check` | eslint / prettier                           |
| `pnpm run build`                          | tsc to `dist/`                              |
| `pnpm run build:skill`                    | regenerate `skills/databricks-axi/SKILL.md` |
| `pnpm run dev -- <args>`                  | run the CLI from source                     |

The full gate (pinned in `.no-mistakes.yaml`, so the no-mistakes gate runs
these instead of auto-detecting): `pnpm test`,
`pnpm run lint && pnpm run build && pnpm run build:skill -- --check`
(`--check` fails on a stale SKILL.md), and `pnpm run format`.

## Architecture

`bin/databricks-axi.ts` → `src/cli.ts` (`runAxiCli` from axi-sdk-js) →
`src/commands/<domain>.ts`. Support modules: `src/databricks.ts`
(spawn wrapper), `src/errors.ts` (taxonomy), `src/commands/shared.ts`
(`domainHelpers(domain)` — the shared `parseArgs`/`parseIntFlag`/`requireId`/
`renderRows`, built on `node:util`'s `parseArgs` in strict mode); planned:
`src/suggestions.ts`, `src/context.ts`, `src/fields.ts`. Internal logic stays
on JSON; TOON conversion happens only at the output boundary.

Tests mirror `src/` under `test/`. Domain tests call `setupCli()` from
`test/helpers/fake-databricks.ts` for the standard rig (fresh fake
`databricks` on PATH each test, `t.run(argv)` to invoke the CLI and capture
stdout/exit code); seed canned JSON with `respond(prefix, json)`, assert
exact argv with `calls()`.

## Sharp edges (learned the hard way — do not rediscover)

- The official CLI has **no statement-execution subcommand**
  (databricks/cli#3896). `sql exec` must poll
  `POST /api/2.0/sql/statements` → `GET /statements/{id}` via the api
  passthrough; `wait_timeout` <= 50s per call; INLINE results cap ~25MB.
  Watch #3896: if `databricks query sql` ships upstream, `sql exec` can
  delegate instead of polling.
- There is **no `clusters stop` upstream** — the terminate verb is
  `databricks clusters delete` (keeps config, restartable). Never
  `permanent-delete`, which destroys the cluster. Our `clusters stop` maps to
  `clusters delete`.
- `jobs run-now` and `clusters start` **block by default** (20-min timeout).
  Mutations are async by default here: pass `--no-wait` upstream, return the
  id + a follow-up suggestion.
- `INVALID_STATE` on start/stop means already-running/stopped → exit-0 no-op.
  Note `clusters start` on a non-TERMINATED cluster is already a no-op
  upstream.
- Don't assume that pattern carries to every domain: `sql warehouses
start/stop` on an already-in-state warehouse exits 0 silently upstream
  (pinned live 2026-07-07) — no `INVALID_STATE` no-op mapping needed there.
- There is no `logs` subcommand upstream: `jobs logs <run_id>` =
  `jobs get-run` → per-task `get-run-output` fan-out.
- CLI >= 0.298 removed `--page-token`; `--limit` is a client-side result
  cap. A full page → `has_more: true` + a rerun-with-`--limit <2N>`
  suggestion, never auto-paginate unboundedly.
- Legacy CLI 0.18.x is incompatible; the spawn layer version-guards >= 0.298.
- int64 ids (`job_id`/`run_id`) can exceed 2^53, where `JSON.parse` silently
  rounds; `runDatabricks` quotes 16+-digit `*_id` values so they stay exact
  strings. Treat ids as `number | string` downstream.
- The Go CLI emits plain-text stderr errors; map them to the structured
  taxonomy in `src/errors.ts`. Never leak raw stack traces or token-shaped
  strings.
- Spawn with array argv only, `stdin: 'ignore'`, hard timeout, always
  `-o json`. Auth prompts must never hang an agent.
- Secret values: stdin-only, never argv, never stdout.
- Exit codes: 0 success (incl. no-ops), 1 upstream error, 2 usage error.
  Errors are structured TOON on stdout (`code`, `error`, `help`).
- No interactive prompts, ever. Fail loud on unknown flags.
- TypeScript 6 defaults `types` to `[]` (was: all `node_modules/@types`);
  `tsconfig.json` pins `"types": ["node"]`, so a new `@types/*` package must
  be added there or it is silently ignored.
- Flag parsing (`domainHelpers(domain).parseArgs`) is `node:util`'s
  `parseArgs` in strict mode, not a hand-rolled loop — usage-error wording
  follows node's own messages (`Unknown option '--x'`, `argument missing`),
  and `--flag=value` works alongside `--flag value`. Don't hand-write flag
  parsing in a new domain; call `domainHelpers`.

## Generated files — never hand-edit

- `skills/databricks-axi/SKILL.md` (regenerate: `pnpm run build:skill`)
- later: `CHANGELOG.md`, `.release-please-manifest.json` (release-please)

## Development lifecycle

| Stage    | Role                    | Scope                                                                        |
| -------- | ----------------------- | ---------------------------------------------------------------------------- |
| Design   | architecture reviewer   | validates specs/design changes; researches best practice; never touches code |
| Build    | domain implementer      | implements one command domain, TDD against the fake stub                     |
| Review   | AXI compliance reviewer | reviews code against the 10 AXI principles + spec drift                      |
| Validate | benchmarker             | measures vs raw `databricks` CLI and MCP; LLM-judge graded task success      |

## Shipping (required)

Commit on a feature branch, then `git push no-mistakes` — never push to
`origin` directly. See CONTRIBUTING.md. Evidence artifacts for shipped
changes live under `.no-mistakes/evidence/`.

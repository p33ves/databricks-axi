# AGENTS.md

Conventions for agents (and humans) working on databricks-axi. This file is
canonical; CLAUDE.md defers here.

## What this is

AXI-compliant wrapper around the official `databricks` CLI (Go, >= 0.205).
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

## Architecture

`bin/databricks-axi.ts` → `src/cli.ts` (`runAxiCli` from axi-sdk-js) →
`src/commands/<domain>.ts`. Planned support modules: `src/databricks.ts`
(spawn wrapper), `src/errors.ts` (taxonomy), `src/suggestions.ts`,
`src/context.ts`, `src/fields.ts`. Internal logic stays on JSON; TOON
conversion happens only at the output boundary.

Tests mirror `src/` under `test/`. Domain tests use
`test/helpers/fake-databricks.ts` — prepend its `binDir` to PATH, seed
canned JSON with `respond(prefix, json)`, assert exact argv with `calls()`.

## Sharp edges (learned the hard way — do not rediscover)

- The official CLI has **no statement-execution subcommand**
  (databricks/cli#3896). `sql exec` must poll
  `POST /api/2.0/sql/statements` → `GET /statements/{id}` via the api
  passthrough; `wait_timeout` <= 50s per call; INLINE results cap ~25MB.
- `jobs run-now` and `clusters start` **block by default** (20-min timeout).
  Mutations are async by default here: pass `--no-wait` upstream, return the
  id + a follow-up suggestion.
- `INVALID_STATE` on start/stop means already-running/stopped → exit-0 no-op.
- There is no `logs` subcommand upstream: `jobs logs <run_id>` =
  `jobs get-run` → per-task `get-run-output` fan-out.
- Pagination is manual (`--page-token`); surface `has_more` + a next-page
  suggestion, never auto-paginate unboundedly.
- Legacy CLI 0.18.x is incompatible; the spawn layer version-guards >= 0.205.
- The Go CLI emits plain-text stderr errors; map them to the structured
  taxonomy in `src/errors.ts`. Never leak raw stack traces or token-shaped
  strings.
- Spawn with array argv only, `stdin: 'ignore'`, hard timeout, always
  `-o json`. Auth prompts must never hang an agent.
- Secret values: stdin-only, never argv, never stdout.
- Exit codes: 0 success (incl. no-ops), 1 upstream error, 2 usage error.
  Errors are structured TOON on stdout (`code`, `error`, `help`).
- No interactive prompts, ever. Fail loud on unknown flags.

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

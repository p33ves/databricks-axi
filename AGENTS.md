# AGENTS.md

Conventions for agents (and humans) working on databricks-axi. This file is
canonical; CLAUDE.md defers here.

## What this is

AXI-compliant wrapper around the official `databricks` CLI (Go, >= 0.298;
v1.x is fine; the guard only rejects 0.x below 0.298).
The [AXI standard](https://github.com/kunchenguid/axi) defines 10 principles.
They are requirements, not suggestions.

## Commands

| Command                                   | Purpose                                                |
| ----------------------------------------- | ------------------------------------------------------ |
| `pnpm test`                               | vitest run (unit + stub-driven e2e + arena self-check) |
| `pnpm run lint` / `pnpm run format:check` | eslint / prettier                                      |
| `pnpm run build`                          | tsc to `dist/`                                         |
| `pnpm run build:skill`                    | regenerate `skills/databricks-axi/SKILL.md`            |
| `pnpm run dev -- <args>`                  | run the CLI from source                                |

The full gate (pinned in `.no-mistakes.yaml`, so the no-mistakes gate runs
these instead of auto-detecting): `pnpm test`,
`pnpm run lint && pnpm run build && pnpm run build:skill -- --check`
(`--check` fails on a stale SKILL.md), and `pnpm run format`.

## Architecture

`bin/databricks-axi.ts` → `src/cli.ts` (`runAxiCli` from axi-sdk-js) →
`src/commands/<domain>.ts`. Support modules: `src/databricks.ts`
(spawn wrapper), `src/errors.ts` (taxonomy), `src/truncate.ts` (line/char
truncation for view/cat/logs), `src/commands/shared.ts`
(`domainHelpers(domain)`: the shared `parseArgs`/`parseIntFlag`/`requireId`/
`renderRows`, built on `node:util`'s `parseArgs` in strict mode; plus
`listResult` for the empty-state/count/has_more list envelope and
`runWithNotFoundHelp` for domain-flavored NOT_FOUND suggestions). Field
selection, suggestions, and pagination rendering live in `shared.ts`; the
separate `fields.ts`/`suggestions.ts` files from the original design were
dropped at CP2 (2026-07-10) as needless splitting. `src/context.ts` holds
`home`'s panel-fetch layer (auth context, recent runs, warehouses, running
clusters); rendering/assembly stays in `src/commands/home.ts`. Internal
logic stays on JSON; TOON conversion happens only
at the output boundary. Don't re-inline the list envelope or a private
NOT_FOUND wrapper in a new domain; call `listResult`/`runWithNotFoundHelp`.
(`fs ls` is the deliberate exception to `listResult`: upstream `fs` has no
`--limit`, so it knows the true total and reports exact truncation instead
of `has_more`.)

Per-component detail (exports, sharp edges, test coverage) for every
command and the shared core layer lives under
[docs/components/](docs/components/), one file per domain or top-level
verb (e.g. `whoami`) plus `core.md` for the shared/support modules.

`tools/arena/` is separate from the CLI: a local demo web app (stdlib
`node:http` + one static page, no deps) that runs one task against a
workspace three ways (raw CLI, MCP, databricks-axi) side by side. It is
excluded from the npm package (`files` allowlist) and its `results/` dir is
gitignored. Setup, safety model, and API contract live in
[tools/arena/README.md](tools/arena/README.md); its hermetic self-check
(`tools/arena/parse.test.mjs`) runs as part of `pnpm test`.

Tests mirror `src/` under `test/`. Domain tests call `setupCli()` from
`test/helpers/fake-databricks.ts` for the standard rig (fresh fake
`databricks` on PATH each test, `t.run(argv)` to invoke the CLI and capture
stdout/exit code); seed canned JSON with `respond(prefix, json)`, assert
exact argv with `calls()`. Inline `--json` bodies never land on argv (see
below), so `calls()` only shows the `@path` reference; assert the actual
body content with `bodies()`, which the stub captures before the temp file
is deleted.

## Sharp edges (learned the hard way; do not rediscover)

- The official CLI has **no statement-execution subcommand**
  (databricks/cli#3896). `sql exec` must poll
  `POST /api/2.0/sql/statements` → `GET /statements/{id}` via the api
  passthrough; `wait_timeout` <= 50s per call; INLINE results cap ~25MB.
  Watch #3896: if `databricks query sql` ships upstream, `sql exec` can
  delegate instead of polling.
- There is **no `clusters stop` upstream**; the terminate verb is
  `databricks clusters delete` (keeps config, restartable). Never
  `permanent-delete`, which destroys the cluster. Our `clusters stop` maps to
  `clusters delete`.
- `jobs run-now` and `clusters start` **block by default** (20-min timeout).
  Mutations are async by default here: pass `--no-wait` upstream, return the
  id + a follow-up suggestion.
- `INVALID_STATE` on `jobs cancel` means already-terminated → exit-0 no-op.
  That mapping does **not** carry to `clusters start`: a non-TERMINATED
  cluster is **not** an upstream no-op — it exits 1 with `Error: Cluster
<id> is in unexpected state Running.` (also `Pending.`), which maps to
  `UPSTREAM_ERROR`, not `INVALID_STATE`. Catch it by the `/is in unexpected
state/i` message regex, not the error code, and convert to an exit-0
  no-op. `clusters stop` (`clusters delete`) has no such conversion:
  upstream is silently idempotent there (exit 0, empty output on an
  already-terminated cluster), so `stop` always returns exit-0 without
  inspecting the error.
- Don't assume the no-op pattern carries to every domain: `sql warehouses
start/stop` on an already-in-state warehouse exits 0 silently upstream
  (pinned live 2026-07-07); no `INVALID_STATE` no-op mapping needed there.
- There is no `logs` subcommand upstream: `jobs logs <run_id>` =
  `jobs get-run` → per-task `get-run-output` fan-out.
- CLI >= 0.298 removed `--page-token`; `--limit` is a client-side result
  cap. A full page → `has_more: true` + a rerun-with-`--limit <2N>`
  suggestion, never auto-paginate unboundedly.
- Exception: `query-history list` still has real server-side pagination
  (`--max-results`/`--page-token`, `has_next_page` in the response). `sql
history` maps its own `--limit` to `--max-results`, sources `has_more`
  from `has_next_page`, and never exposes the raw page token. It also
  doesn't route through `listResult` (unlike every other list domain) —
  the real `has_next_page` flag and two distinct empty states (truly-empty
  vs. `--status`-filtered-empty) don't fit that helper's `rows.length >=
limit` heuristic. `fs ls` is the only other documented `listResult`
  exemption; this is the second. `sql warehouses` is a third: it has no
  `--limit` flag at all (a workspace has a handful of warehouses, per the
  sql domain spec) and hand-builds its own `count`-only envelope — the
  one list command in the repo with no client-side cap safeguard.
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
- `runDatabricksApi` never puts an inline body on child argv (visible in
  `ps`): it writes to a 0600 temp file and passes `--json @path`, deleting
  the file after the call. A body already given as `@path` passes through
  untouched (the `api` command's documented file-passthrough).
- Exit codes: 0 success (incl. no-ops), 1 upstream error, 2 usage error.
  Errors are structured TOON on stdout (`code`, `error`, `help`).
- No interactive prompts, ever. Fail loud on unknown flags.
- TypeScript 6 defaults `types` to `[]` (was: all `node_modules/@types`);
  `tsconfig.json` pins `"types": ["node"]`, so a new `@types/*` package must
  be added there or it is silently ignored.
- Flag parsing (`domainHelpers(domain).parseArgs`) is `node:util`'s
  `parseArgs` in strict mode, not a hand-rolled loop. Usage-error wording
  follows node's own messages (`Unknown option '--x'`, `argument missing`),
  and `--flag=value` works alongside `--flag value`. Don't hand-write flag
  parsing in a new domain; call `domainHelpers`.
- `fs` bare absolute paths (`/Volumes/...`, `/databricks-datasets/...`) read
  the _local_ filesystem upstream, not DBFS — `withScheme` in
  `src/commands/fs.ts` prepends `dbfs:` to any schemeless absolute path
  (live-verified). `workspace` paths need no such prefix.
- `fs cat` runs `runDatabricks` in `raw: true` mode: no `-o json`, no
  `JSON.parse`, no int64 `*_id` quoting — file content is data, not a
  structured response, and is deliberately never redacted (matches the
  `sql` rule that only error/log text is a redaction surface). Raw mode
  streams stdout and SIGKILLs the child past a 5MB cap (`TOO_LARGE`), since
  file content is unbounded and must never be buffered whole.
- `workspace view` always exports with `--format SOURCE`; language and size
  come from the export payload itself (base64 `content` + `file_type`), no
  separate `get-status` call. A directory path exports as a ZIP archive
  upstream — detected by the full local-file-header/EOCD signature (not
  just a `"PK"` prefix, which a source file could start with) and rendered
  as an exit-0 note pointing at `workspace ls`, not an error.
- `workspace view` / `fs cat` output is head-truncated at 200 lines _and_
  clamped at 100k chars (`src/truncate.ts`) — line limits alone don't bound
  a minified one-liner. `--full` is the unbounded escape hatch. The invalid
  upstream-JSON error never echoes any stdout snippet (even redacted),
  since stdout can carry exported file content.
- `mapUpstreamError` strips a trailing run of `Profile:`/`Host:`/
  `Auth type:`/`Username:` lines, in any order, before classification —
  its `Auth type: OAuth (...)` line otherwise trips the `AUTH_ERROR`
  branch on every auth mode, not just real auth failures.
- `NOT_FOUND` matching covers both "does not exist" and the contraction
  "doesn't exist" (real upstream string, seen from `fs`/`workspace`), plus
  "was not found" (real upstream string from `pipelines get` on an unknown
  id).
  "Public DBFS root is disabled" is a Free Edition platform restriction, not
  a missing-object 403/404 — it gets its own `PERMISSION_DENIED` branch with
  a hint toward paths that are actually readable.
- Upstream `pipelines stop`/`start-update`/`get` are dual-mode: a non-UUID
  argument is treated as a bundle resource KEY resolved against cwd project
  config (confusing errors), not a pipeline id. axi validates every
  `<pipeline_id>` arg is a UUID before it ever reaches argv.
- `pipelines stop` (`pipelines stop --no-wait`) is silently idempotent
  upstream — exit 0, empty stdout on both an already-IDLE pipeline and a
  mid-update one (which it cancels). No rejection shape to inspect, so
  unlike `start` there is no conflict branch; always exit 0 (same shape as
  `clusters stop` → `clusters delete`).
- `pipelines start` (`pipelines start-update`) has no wait flags upstream
  (naturally async). A conflicting active update is not a distinct error
  code — it's `UPSTREAM_ERROR` with `An active update '<id>' already
exists` in the message; catch it by regex (same pattern as `clusters`
  "is in unexpected state") and convert to an exit-0 no-op that surfaces the
  active `update_id`.
- `pipelines get`'s `latest_updates` and `serving-endpoints get`'s
  `config.served_entities` are nested, not top-level — both must be
  extracted/flattened before rendering; don't assume a flat response shape
  for a new domain.
- `serving-endpoints list` has `--limit` upstream (unlike `fs ls`), so
  `serving list` goes through the standard `listResult` envelope — it is
  not a candidate for the `fs ls`-style has_more exemption.
- `serving-endpoints` responses have no `entity_name` field on
  foundation-model served entities — only custom-served-model entities set
  it. Entity display name falls back through
  `foundation_model.display_name` → `foundation_model.name` →
  `entity_name` → `name`, never assume `entity_name` is always present.
- `home`'s panels spawn in parallel (`Promise.allSettled`) with a 4s
  per-panel timeout override; a degraded panel renders as one
  `<panel>: unavailable (<reason>)` line and never fails the whole command
  (exit 0) — the one exception is an `AUTH_ERROR` on the auth panel, which
  swaps the whole dashboard body for the structured error (still exit 0)
  since every other workspace panel would fail the same way.
- `setup hooks` delegates entirely to `installSessionStartHooks()` from
  `axi-sdk-js` (`src/commands/setup.ts`) — never hand-roll per-agent
  JSON/TOML editing. It writes all three agents (Claude Code, Codex,
  OpenCode) unconditionally; there is no `--agent` selector. Eligibility
  (`process.argv[1]` matching a packaged `dist/bin/<marker>.js` path, or a
  bin literally named `<marker>`) is pre-checked with the SDK's own
  exported `shouldInstallHooksForNodeAxiExecPath`, using explicit
  `marker`/`binaryNames`/`distEntrypoints` passed to both the check and the
  install call so behavior is deterministic rather than relying on the
  SDK's internal path-shape inference. An ineligible entrypoint returns a
  `"not installed: unrecognized entrypoint"` result — never a false
  "installed" — but it's still a real limitation: `pnpm run dev`
  (`tsx bin/databricks-axi.ts`) always fails the check, since the `.ts`
  entrypoint can't be matched. Build and run `dist/bin/databricks-axi.js`
  (or a real install) to test hook installation for real.

## Generated files (never hand-edit)

- `skills/databricks-axi/SKILL.md` (regenerate: `pnpm run build:skill`)
- `CHANGELOG.md` (release-please, simple mode; the bot's release PR is the
  only place it changes; no `.release-please-manifest.json` exists because
  manifest mode would need it hand-committed first, which the guard forbids)
- `package.json`'s `version` field: release-please computes it from
  conventional commits and bumps it in its own release PR; never hand-bump
  it in a feature commit. `guard-generated-files.yml` fails human PRs that
  change it.

## Development lifecycle

| Stage        | Role                    | Scope                                                                |
| ------------ | ----------------------- | -------------------------------------------------------------------- |
| Design draft | domain architect        | drafts spec, researches upstream feasibility; never touches code     |
| Design gate  | spec reviewer           | independently re-verifies feasibility, GO/NO-GO before build starts  |
| Build        | domain implementer      | implements one command domain, TDD against the fake stub             |
| Review       | AXI compliance reviewer | reviews code against the 10 AXI principles + spec drift              |
| Validate     | benchmarker             | measures vs raw `databricks` CLI and MCP; hybrid-graded task success |
| Ship         | release manager         | release-please runbook, ship gate                                    |

Cross-cutting (not tied to one lifecycle stage): security auditor
(leak/credential audit, per-domain before ship and at CP4), docs
maintainer (README/AGENTS.md/CONTRIBUTING.md accuracy and style).

## Shipping (required)

Commit on a feature branch, then `git push no-mistakes`; never push to
`origin` directly. See CONTRIBUTING.md. Evidence artifacts for shipped
changes live under `.no-mistakes/evidence/`.

After any merge to `main` lands, check whether the `release-please` run on
`main` failed. If it did, invoke the `release-manager` agent: its
post-merge self-heal runbook handles the expected "Actions not permitted to
create or approve pull requests" failure without needing to be asked.

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
(A handful of commands are deliberate exemptions from `listResult`; the
full list with reasons lives in
[docs/components/core.md](docs/components/core.md).)

Per-component detail (exports, sharp edges, test coverage) for every
command and the shared core layer lives under
[docs/components/](docs/components/), one file per domain or top-level
verb (e.g. `whoami`) plus `core.md` for the shared/support modules.

`tools/arena/` is separate from the CLI: a local demo web app (stdlib
`node:http` + one static page, no deps) that runs one task against a
workspace three ways (CLI + agent-skills, MCP, databricks-axi) side by side.
It is excluded from the npm package (`files` allowlist) and its `results/`
dir is gitignored. Setup, safety model, and API contract live in
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
- `AUTH_ERROR`'s `help[]` is sub-typed (expired/revoked/invalid token →
  re-login; `cannot configure default credentials` → pass `--profile
<name>` or log in; else the generic login line), not one static message.
  The sub-type regexes are deliberately narrow — concrete phrasings, not
  broad word-proximity gaps — since a loose match (e.g. any "profile" or
  bare "oauth" mention) would misroute an unrelated NOT_FOUND/
  PERMISSION_DENIED error that merely names something containing that
  word (a resource called `profile-xyz`, an unstrippable `Auth type:
OAuth (...)` trailer with trailing content after it).
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
- Lakeview `dashboard_id` is **32 hex chars, no dashes** — upstream's own
  `--help` calls it a "UUID", but that's wrong (live-verified twice,
  2026-07-16). A dashed-UUID guard (the `pipelines` pattern) would reject
  every real dashboard id; `dashboards.ts` instead uses
  `/^[0-9a-fA-F][0-9a-fA-F-]{31,35}$/`, anchored on a hex first char so the
  leading-dash rejection is real. Because that id is exactly 32 lowercase
  hex chars, `redactSecrets` (`errors.ts:26`) rewrites it to `[redacted]`
  in error text — and that redaction runs _before_ classification — so a
  live missing-dashboard error renders as `Unable to find dashboard
[[redacted]]`, not the id the agent typed. Classification still lands on
  `NOT_FOUND` (the anchor phrase survives), and success rows
  (`dashboard_id` on `list`/`view`) are untouched — `redactSecrets` never
  runs on result data. Do not loosen the 32-hex redaction rule to spare
  dashboard ids; that would unredact real hex secrets everywhere else.
- Two more `NOT_FOUND` phrasings live in `mapUpstreamError`'s alternation
  since 1.2.0: `Unable to find (?:published )?dashboard` (`lakeview
get`/`get-published`) and `Could not find principal` (`grants
get-effective --principal`). Both are anchored on a literal noun, same
  shape as the pre-existing alternatives — a broader "unable to
  find"/"could not find" gap would risk misrouting an unrelated error.
  Format errors on a malformed (not missing) id/name — `invalid resource
name […]`, `is not a valid object`, `For input string: "…"` — stay
  `UPSTREAM_ERROR` on purpose; they aren't a missing-object miss. A bad
  `--principal` has the same redaction collision as the dashboard-id one:
  the principal is an email, `redactSecrets`' email rule fires before
  classification, so the rendered message is `Could not find principal
with name [redacted-email].` — cosmetic, classification still lands
  `NOT_FOUND`. This applies only to _error text_; a principal in a
  successful `catalog grants`/`permissions` row is never redacted (see the
  grants entry below).
- Two more `listResult` exemptions beyond `fs ls`/`sql history`/`sql
warehouses`: `permissions` (upstream `permissions get` has no `--limit`
  or pagination at all — a hand-built `{ object_type, object_id,
permissions, count, help }` envelope) and `catalog grants` (upstream
  `grants get-effective` has real server-side pagination via
  `--max-results`/`--page-token`, same family as `query-history list` —
  the page loop drains every page into a hand-built `{ grants, count,
help }` envelope with no agent-facing `--limit`).
- `permissions`'s five-type allow-list (`jobs`, `clusters`, `pipelines`,
  `warehouses`, `dashboards`) deliberately excludes `serving-endpoints`:
  `permissions get serving-endpoints` rejects the endpoint name and wants
  an internal id that `serving-endpoints get` never returns (no top-level
  `id` on a foundation-model endpoint) — there is no id an agent can
  obtain through the CLI for this type at all. It also excludes
  `dbsql-dashboards` (legacy DBSQL dashboards, a different id space that
  rejects Lakeview ids) — only `dashboards` (AI/BI Lakeview) is
  allow-listed. `permissions get dashboards <32-hex Lakeview id>` succeeds
  but echoes `object_type: "dashboard"` and an `object_id` that is a
  **numeric legacy workspace-object id** (e.g. `/dashboards/570857400383840`),
  not the 32-hex id passed in — the two id spaces are different and
  upstream silently resolves between them. axi echoes the response's own
  values verbatim (the honest report of what upstream actually resolved);
  that numeric id is not a valid input to `dashboards view`.
- Standing watch (unverified as of 1.2.0): the `\b403\b|PERMISSION_DENIED`
  branch has never been observed live on `permissions get` or `grants
get-effective` — the bench principal has admin on every reachable
  workspace. Both commands' tests pin fixtures for both plausible shapes
  (bare `403` and a `PERMISSION_DENIED` token) rather than a live-observed
  string. Re-check the first time a non-admin principal is available; no
  doc or help text may describe that path as verified until then.
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
- A package-runner exec path (`npx`/`pnpm dlx`/`yarn dlx`/`bunx`, matched on
  a `_npx`, `dlx*` or `bunx-*` path segment) is refused earlier, with
  `"not installed: ephemeral package-runner entrypoint"`. The check runs
  _before_ the eligibility check on purpose: those paths end in
  `dist/bin/databricks-axi.js` and would otherwise install cleanly, baking a
  version-pinned, prunable cache path into all four hook configs. Hooks need
  a durable install (`npm i -g databricks-axi`).

## Generated files (never hand-edit)

- `skills/databricks-axi/SKILL.md` (regenerate: `pnpm run build:skill`;
  CI fails a stale copy via `build:skill -- --check`)
- `pnpm-lock.yaml` (pnpm rewrites it on dependency changes; prettier
  ignores it so Dependabot's raw lockfile output passes `format:check`)
- `CHANGELOG.md` is frozen at 1.0.2 and no longer maintained. Release notes
  live on GitHub Releases, auto-generated from merged PR titles.

## Development lifecycle

| Stage        | Role                    | Scope                                                                |
| ------------ | ----------------------- | -------------------------------------------------------------------- |
| Design draft | domain architect        | drafts spec, researches upstream feasibility; never touches code     |
| Design gate  | spec reviewer           | independently re-verifies feasibility, GO/NO-GO before build starts  |
| Build        | domain implementer      | implements one command domain, TDD against the fake stub             |
| Review       | AXI compliance reviewer | reviews code against the 10 AXI principles + spec drift              |
| Validate     | benchmarker             | measures vs competing CLI and MCP setups; hybrid-graded task success |
| Ship         | release manager         | version bump PR, tag, GitHub release, npm publish                    |

Cross-cutting (not tied to one lifecycle stage): security auditor
(leak/credential audit, per-domain before ship and at CP4), docs
maintainer (README/AGENTS.md/CONTRIBUTING.md accuracy and style).

## Shipping (required)

Commit on a feature branch, then `git push no-mistakes`; never push to
`origin` directly. See CONTRIBUTING.md. Evidence artifacts for shipped
changes live under `.no-mistakes/evidence/`.

## Cutting a release

Releases are cut by hand. Nothing runs on a schedule, no bot opens a PR, and
merging to `main` never triggers a release on its own.

```bash
# 1. Bump the version on a branch, then ship it like any other change.
pnpm version 1.0.3 --no-git-tag-version   # only touches package.json
# Also bump the "version" field by hand in .claude-plugin/plugin.json and
# .claude-plugin/marketplace.json — pnpm version does not touch them.
git commit -am "chore: release 1.0.3"
git push no-mistakes        # normal PR, normal checks, merge it

# 2. Tag main and publish the release. Creates the tag and the notes.
git checkout main && git pull
gh release create v1.0.3 --generate-notes

# 3. Publish to npm (2FA, so this stays interactive).
pnpm publish
```

`--generate-notes` builds the notes from the PR titles merged since the last
tag, which is why conventional-commit PR titles matter. There is no
`.github/release.yml` grouping config: it categorizes by PR _label_, and this
repo does not label PRs, so the default flat list is what we get.

**Why it works this way.** Releases used to run on release-please, which
opens the version-bump PR itself. That needs the repo setting "Allow GitHub
Actions to create and approve pull requests", which is deliberately kept OFF
here. So every release needed that setting toggled on and back off by hand,
and in between, every push to `main` painted a failed release-please run.
Making the version bump an ordinary PR removes the bot, and with it the
permission toggle and the recurring red X. The tradeoff we accepted: the
version number and the release moment are now a human decision instead of
being computed from conventional commits.

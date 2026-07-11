# core (shared/support layer)

Covers `src/cli.ts`, `src/databricks.ts`, `src/errors.ts`,
`src/truncate.ts`, `src/context.ts`, and `src/commands/shared.ts` — the
modules every domain command depends on. Tests:
`test/cli.test.ts`, `test/databricks.test.ts`, `test/errors.test.ts`,
`test/truncate.test.ts` (`src/context.ts` and `src/commands/shared.ts`
have no dedicated test files; they're exercised indirectly through every
domain's own test suite, plus `test/home.test.ts` for `context.ts`).

## `src/cli.ts`

Wires every domain command into `runAxiCli` (from `axi-sdk-js`): the
`COMMANDS` map (`home`, `jobs`, `clusters`, `sql`, `catalog`, `workspace`,
`fs`, `pipelines`, `serving`, `setup`, `api`), the top-level help text
(`TOP_HELP`), and per-command help lookup (`COMMAND_HELP`). Also resolves
the package version by reading `package.json` from either one or two
directories up from the compiled/source location (`readPackageVersion`),
since `dist/` and source layouts differ by one directory level. `main()`
is the single entrypoint `bin/databricks-axi.ts` calls, and the same
entrypoint the test rig (`setupCli()`) calls directly with a captured
`stdout`.

## `src/databricks.ts`

The spawn wrapper — every domain command reaches the upstream `databricks`
CLI only through this file's two exports:

- `runDatabricks(args, opts)`: spawns `databricks` with array argv only
  (never a shell), `stdin: 'ignore'`, a hard timeout (default 30s,
  overridable per call), and always appends `-o json` unless `opts.raw` is
  set. Parses stdout as JSON, with a regex pass that quotes 16+-digit
  `*_id` values before `JSON.parse` so int64 ids (`job_id`/`run_id`) that
  exceed 2^53 don't silently round. All failure modes (`ENOENT`, timeout,
  nonzero exit, malformed JSON) become a structured `AxiError`, never a
  raw exception. A version guard (`diagnoseFailure`/`detectVersion`) fires
  only on the failure path — an "unknown command/flag" stderr shape
  triggers a one-off `databricks -v` check, producing `CLI_TOO_OLD` if the
  installed CLI is below the `0.298` minor-version floor, instead of a
  confusing generic error.
- `runDatabricksApi(method, path, body, opts)`: the `api` subcommand
  passthrough used by `sql exec`/`sql statement view` (statements API) and
  the `api` domain command. An inline body is never placed on child argv
  (visible in `ps`) — it's written to a 0600 temp file in
  `mkdtemp(tmpdir())` and passed as `--json @<path>`, with the temp dir
  removed in a `finally`. A body already given as `@path` (user-supplied
  file reference) passes through untouched.
- `spawnCollect` (internal): the actual `child_process.spawn`, with raw
  mode's `maxBytes` cap streaming stdout as Buffer chunks and SIGKILLing
  the child the instant the running total exceeds the cap, rather than
  buffering an unbounded response — chunks are concatenated and decoded
  once at the end so a multi-byte UTF-8 sequence split across pipe reads
  is never mangled by incremental decoding.

## `src/errors.ts`

The error taxonomy and secret redaction, shared by every domain:

- `redactSecrets(text)`: strips token-shaped strings (dapi tokens, dkea
  OAuth tokens, long hex runs, long base64-ish runs) before they can reach
  stdout. Order matters — dapi tokens are matched first since they'd
  otherwise also match the generic long-hex rule. Also masks a workspace
  host URL or account email when either appears inline in an error's
  classified first line — not just in the trailing `Profile:`/`Host:`/
  `Auth type:` block `mapUpstreamError` already strips.
- `mapUpstreamError(stderr)`: pattern-matches the Go CLI's plain-text
  stderr into one `AxiError` with a taxonomy code (`AUTH_ERROR`,
  `PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_STATE`, or the
  `UPSTREAM_ERROR` fallback). Strips a trailing `Profile:`/`Host:`/
  `Auth type:` block before classification, since its own
  `Auth type: OAuth (...)` line would otherwise trip the `AUTH_ERROR`
  branch on every auth mode, not just genuine auth failures. Has a
  dedicated branch for "Public DBFS root is disabled" (a Free Edition
  platform restriction, not a missing object) mapped to
  `PERMISSION_DENIED` with a path hint, checked before the generic 403
  branch. `NOT_FOUND` matching covers "does not exist", the contraction
  "doesn't exist" (workspace/fs), and "was not found" (pipelines) — three
  distinct real upstream phrasings, not one canonical string.

## `src/truncate.ts`

`truncate(text, opts)`: the single line/char truncation function shared
by `workspace view`, `fs cat`, and `jobs logs`. `head` mode keeps the
first N lines (notebooks: the imports/markdown preamble is what
summarization needs); `tail` mode keeps the last N (logs: the failure is
at the end). Exact-boundary input is never marked truncated, and a
trailing newline doesn't count as an extra line. The kept slice is then
clamped to `opts.maxChars` (default unbounded) — `MAX_VIEW_CHARS` (100k)
is the constant `workspace view`/`fs cat` pass in, since a line-only limit
doesn't bound a minified one-liner. The result's `clipped` flag tells the
caller whether the char clamp (not the line count) did the cutting, so
callers can report the right truncation reason.

## `src/context.ts`

Panel-fetch layer for `home` (rendering/assembly stays in
`src/commands/home.ts`; see `home.md`). Exports `PANEL_TIMEOUT_MS` (4s, the
override every panel spawn uses instead of the default 30s) and four fetch
functions, each spawned in parallel by the caller via
`Promise.allSettled` — none of them retry or extend that budget
themselves:

- `fetchAuthContext`: `auth describe`, unpacking the nested response shape
  (`username` top-level; `host`/`auth_type` under `details`; `profile`
  under `details.configuration.profile.value`, falling back to the passed
  `--profile` flag). Never passes `--sensitive`.
- `fetchRecentRuns`: `jobs list-runs --limit 5`, sorted FAILED-first, each
  row carrying a `next: "jobs logs <run_id>"` follow-up when failed.
- `fetchWarehouses`: `warehouses list`, flattened to `{ id, name, state }`.
- `fetchRunningClusters`: `clusters list`, filtered to non-`TERMINATED`.

## `src/commands/shared.ts`

The common building blocks every `src/commands/<domain>.ts` file is built
on:

- `domainHelpers(domain)`: returns `{ usage, parseArgs, parseIntFlag,
requireId, renderRows }` bound to that domain's name (so usage errors
  point at `databricks-axi <domain> --help`). `parseArgs` wraps
  `node:util`'s `parseArgs` in strict mode — not a hand-rolled flag
  loop — so usage-error wording follows Node's own messages
  (`Unknown option '--x'`, `argument missing`) and `--flag=value` works
  alongside `--flag value`. `renderRows` applies `--fields` (raw top-level
  key selection, validated against the actual keys present in the result
  set) or a domain-supplied default field list.
- `LIST_FLAGS`: the `{ profile, limit, fields }` flag spec every
  list-shaped subcommand shares.
- `listResult(key, rows, limit, opts)`: the shared list-result tail —
  empty state, `count` envelope, and the full-page `has_more` +
  rerun-with-double-limit suggestion. This is the standard shape for every
  list subcommand except the three documented exemptions: `fs ls` (upstream
  has no `--limit` at all, so it reports exact truncation instead of
  `has_more`), `sql history` (real server-side `has_next_page` pagination
  plus two distinct empty states that don't fit this helper's
  `rows.length >= limit` heuristic), and `sql warehouses` (no `--limit` flag
  at all, by deliberate spec decision, so it hand-builds its own `count`-only
  envelope with no client-side cap safeguard).
- `foldNotFoundHelp(promise, notFoundHelp)`: folds a bare `NOT_FOUND` (no
  suggestions already attached) into a domain-flavored one. Shared by
  `runWithNotFoundHelp` and callers that go through `runDatabricksApi`
  instead of `runDatabricks` (e.g. `sql statement view`).
- `runWithNotFoundHelp(args, opts, notFoundHelp)`: `runDatabricks` piped
  through `foldNotFoundHelp`, so every domain gets domain-flavored
  NOT_FOUND suggestions instead of reinventing its own catch-and-rewrap
  logic.
- `asList(parsed, key)`: tolerates both response shapes the Go CLI can
  emit — a bare item array (CLI >= 0.298) or the wrapped `{ items, ... }`
  object, depending on version.
- `assertObject<T>(parsed, label)`: guards endpoints whose result gets
  dereferenced — turns empty stdout (`null`) into a structured
  `UPSTREAM_ERROR` instead of letting a raw `TypeError` escape.
- `spawnOpts(flags)` / `profileSuffix(profile)`: turn a parsed `--profile`
  flag into `RunDatabricksOptions`, and into the ` --profile <name>`
  string suffix appended to every follow-up command suggestion so
  suggested commands keep hitting the same workspace.
- `parentPath(path)` / `looksBinary(text)`: small path/binary-detection
  helpers reused by `workspace`/`fs`.
- `renderFileContent(text, size, full)`: binary check + head-truncate
  (200 lines, clamped at `MAX_VIEW_CHARS`) for exported/read file content —
  shared by `workspace view` and `fs cat`. `size` is caller-computed (the
  two callers use different byte-count sources) and only used for the
  binary-sentinel text.
- `compactState(item)` / `isFailed(item)` (with the shared `RunState`
  type): terminal-state helpers — `compactState` prefers `result_state`
  over `life_cycle_state`, falling back to `"UNKNOWN"`; `isFailed` is true
  for any terminal `result_state` other than `SUCCESS`. Shared by
  `jobs.ts`'s run rendering and `context.ts`'s home-panel `fetchRecentRuns`.
- `WAIT_TIMEOUT_MS` (25 min): the `--wait` budget for async start/stop/run
  mutations, since upstream blocks up to ~20 min. Shared by `jobs`,
  `clusters`, and `sql` (`warehouses start`/`stop`).

### Why there's no separate `fields.ts`/`suggestions.ts`

The original per-domain design split field selection and follow-up
suggestion logic into their own modules. That split was dropped at CP2
(2026-07-10): with the actual usage patterns in hand across several
domains, `listResult`/`runWithNotFoundHelp`/`LIST_FLAGS`/`renderRows`
living together in one `shared.ts` turned out to be the right level of
abstraction — the separate files would have been needless splitting for
what each ended up being a handful of small, tightly related functions.
Current domains call these helpers directly rather than re-inlining the
list envelope or a private NOT_FOUND wrapper.

## Tests

- `test/cli.test.ts`: version/help printing, unknown-command and
  unknown-flag usage errors (exit 2), and the bare-invocation home
  rendering — installs a fake `databricks` on PATH even for cases that
  don't otherwise spawn, since `home` now always does.
- `test/databricks.test.ts`: `-o json` appending and parsing, int64 id
  quoting, `-p <profile>` prepending, null-on-empty-stdout, error-taxonomy
  mapping on nonzero exit, temp-file body cleanup, `CLI_MISSING` on a
  missing binary, spawn errno surfacing (e.g. `EACCES`), hung-process
  `TIMEOUT` + SIGKILL, caller-supplied `timeoutHelp`, `CLI_TOO_OLD`
  diagnosis on both unknown-command and legacy no-such-option failures,
  multibyte UTF-8 decoding split across pipe-chunk boundaries, malformed-
  JSON wrapping, and raw mode's skip of `-o json`/int64-quoting plus its
  5MB streaming cap.
- `test/errors.test.ts`: every `redactSecrets` pattern (dapi, dkea, hex,
  base64-ish, an inline host URL, an inline email) including edge cases (a
  dkea token preceded by a word character, keeping workspace paths and SQL
  UUIDs/SQLSTATEs readable), and every `mapUpstreamError` branch including
  the Profile/Host/Auth-type trailer strip and the disabled-public-DBFS-root
  special case.
- `test/truncate.test.ts`: head/tail truncation, exact-boundary
  non-truncation, trailing-newline non-counting, char-clamping
  independent of line count, and short-input passthrough.
- `test/helpers/fake-databricks.ts` (not itself a `core` module, but the
  shared test rig every domain suite uses): `installFakeDatabricks()`
  drops an executable Node stub onto a temp PATH entry that records every
  invocation's argv to a JSONL file and replays a canned response matched
  by token-wise argv prefix (so `jobs get` never matches `jobs get-run`).
  `setupCli()` wraps this in `beforeEach`/`afterEach` and exposes
  `t.run(argv)` to invoke `main()` and capture stdout/exit code. Supports
  `respond`/`respondSeq`/`respondRaw`/`respondError`/`respondHang` for
  canned success, sequential replies, raw (unparsed) stdout, error stderr,
  and hang-until-killed. `bodies()` captures `--json @path` temp-file
  contents before the file is deleted, since inline JSON bodies never land
  on argv and `calls()` would otherwise only show the `@path` reference.

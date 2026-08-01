# jobs

Source: `src/commands/jobs.ts`. Tests: `test/jobs.test.ts`.

Read and control Databricks Jobs: list jobs, view a job's config, trigger a
run, list/view runs, roll up recent run history, fetch run logs, and cancel
a run.

## Subcommands

From `JOBS_HELP` in the source:

- `jobs list [--limit N] [--total] [--fields a,b]`
- `jobs view <job_id>`
- `jobs run <job_id> [--wait]`
- `jobs runs [job_id] [--limit N] [--total] [--fields a,b]`
- `jobs runs view <run_id>`
- `jobs runs summary [job_id] [--limit N]`
- `jobs logs <run_id> [--full]`
- `jobs cancel <run_id>`

All subcommands accept `--profile <name>`. `<job_id>` and `<run_id>` must be
all-digits (`requireId` with `/^\d+$/`); anything else is a usage error
before it reaches argv.

## Upstream calls

- `list` → `databricks jobs list --limit N` (N = the agent's `--limit`,
  default 30; `TOTAL_FETCH_CEILING` 1000 from `shared.ts` when `--total` is
  passed, and then `--limit` caps DISPLAY only) — see Output shape below
- `view` → `databricks jobs get <job_id>`
- `run` → `databricks jobs run-now <job_id>` (plus `--no-wait` unless
  `--wait` is passed)
- `runs` → `databricks jobs list-runs --limit N [--job-id <job_id>]` (same
  opt-in ceiling fetch as `list`; note `list-runs` has no `--page-size`, so
  a `--total` drain there is many sequential server pages — the reason it
  is opt-in and not the default)
- `runs view` → `databricks jobs get-run <run_id>`
- `runs summary` → `databricks jobs list-runs --limit <window>
[--job-id <job_id>]`, plus (only when a failure is found) one
  `jobs get-run <run_id>` on the most recent failing run and one
  `jobs get-run-output <task_run_id>` on its first failing task — a fixed
  small number of calls regardless of window size or failure count, never
  a walk over every failing run. `common_error` adds no calls of its own:
  it is tallied from the run-level `state_message` the window's `list-runs`
  already returns
- `logs` → no upstream `logs` subcommand exists. It's built from
  `jobs get-run <run_id>` for the task list, then one
  `jobs get-run-output <task_run_id>` call per task (sequential, not
  parallel — a run has a handful of tasks, so the fan-out is kept simple).
- `cancel` → `databricks jobs cancel-run <run_id> --no-wait`

`run` and `cancel` are async by default (`--no-wait`); pass `--wait` to
block, which raises the client-side timeout to 25 minutes to clear
upstream's own ~20-minute block on `run-now`.

## Output shape

- `list`: envelope via `listResult` — default fields `job_id`, `name`
  (flattened out of `settings.name`), `creator_user_name`. Without
  `--total` that's the legacy `count`/full-page `has_more` shape over one
  fetched page. With `--total` (`opts.fetched` set to the bound the fetch
  was allowed to reach) the rows are sliced to
  the display `--limit` (default 30) out of the full ceiling-bounded fetch:
  `count` is rows shown; `total` is the exact fetched count, numeric even
  at `TOTAL_FETCH_CEILING`, where a `truncated` note says the true total
  may be higher; `has_more` is `count < total || truncated` (a ceiling-hit
  fetch flags `has_more` even when the page showed every fetched row). The
  rerun suggestion on a
  truncated page names `nextLimit(limit, rows.length)` — a quadrupled page
  bounded by the true count, carrying `--total` forward — and once the
  display `--limit` already covers the whole fetch it quadruples past the
  bound instead (`--limit 1000 --total` → `--limit 4000 --total`), since
  raising `--limit` raises the fetch bound with it. No `has_more: true`
  ships without a follow-up.
- `view`: `job_id`, `name`, `creator_user_name` (same key as `jobs list`), an
  optional `schedule` string
  (`"<cron> (<pause_status>)"`) when a schedule exists, and `tasks` reduced
  to `{ task_key, type, depends_on }` (`type` is derived from
  `notebook_task`/`spark_python_task` or a generic `<x>_task` key name;
  `depends_on` is the task's `settings.tasks[].depends_on[].task_key` list,
  filtered to drop any entry with no `task_key`, read straight off the
  response with no extra call, and joined with `"|"` — a scalar, not a
  nested array, so the tasks array stays uniform and TOON keeps its compact
  tabular form. It is emitted on every task or none: `""` for a root task
  in a job that has a DAG, and omitted entirely from a job whose tasks have
  no dependencies at all).
- `run`: `run_id` (+ `state` if upstream returns one) and a `runs view`
  follow-up.
- `runs`: same `listResult`/`--total` treatment as `list`, except the
  display `--limit` defaults to 20 here, not 30. Rows are
  the raw upstream items with the derived display fields (`state`,
  `start_time` as ISO, `duration_s`) merged in, so `--fields` can select
  either raw upstream keys or the derived ones, from the full
  ceiling-bounded fetch. Default fields depend on mode: in bulk mode (no
  `job_id`) they are `job_id`, `run_id`, `state`, `start_time`, `duration_s`
  so runs map back to their jobs in one call (cross-job questions otherwise
  force an N+1 walk); filtered to one `job_id` the `job_id` column is
  redundant and dropped, leaving `run_id`, `state`, `start_time`,
  `duration_s`. The `jobs logs <run_id>` follow-up for the first failing run
  is searched only over the displayed `--limit` page, not the full
  ceiling-bounded fetch — a failure beyond the display page was never shown
  to the agent, so it isn't suggested.
- `runs view`: `run_id`, `job_id`, `state`, `start_time` (ISO),
  `duration_s`, and a flattened `tasks` array (`task_key`, `state`,
  `duration_s`).
- `runs summary`: hand-built envelope (not `listResult` — its shape isn't a
  rows array), `{ job_id?, window, success, failed, other, running,
truncated?, first_failed?, common_error?, common_error_count?, help }`.
  `failed` counts genuine failures only
  (`FAILED`, `UPSTREAM_FAILED`, ...) plus the `result_state`-less
  `INTERNAL_ERROR` life cycle; the cancel/timeout/skip states listed
  in `shared.ts`'s `NOT_FAILURE_STATES` (`CANCELED`, `UPSTREAM_CANCELED`,
  `TIMEDOUT`, `EXCLUDED`, `MAXIMUM_CONCURRENT_RUNS_REACHED`, `DISABLED`)
  are terminal but not broken, so they tally as `other` instead of
  inflating a reported audit number, and so does the `SKIPPED` life cycle,
  which is terminal with no `result_state` of its own. The four tallies
  add up to `window`. `window` is the number of runs actually fetched
  within the bounded window (`--limit`, default 50, capped at the internal
  ceiling 200). `running` is still a remainder, but of `isTerminal` rather
  than of `result_state` alone, so it covers only genuinely in-flight runs:
  actively RUNNING plus PENDING/QUEUED/BLOCKED, not runs that finished
  without a `result_state`. `truncated` is present whenever the fetch
  filled the requested window (`runs.length >= window`), not just at the
  200-run ceiling: a full window means the tallies only cover the newest
  `window` runs, so `failed: 0` there is not an authoritative "nothing ever
  failed". Below the ceiling the note points at a bigger `--limit`; at the
  ceiling it says more runs may exist beyond it. Same note style as
  `listResult`'s ceiling-hit case, no separate `total_available` field. `first_failed` is omitted when no genuine
  failure is found in the window; otherwise it's `{ run_id, task_key?,
error? }` — the most recent failing run (`jobs list-runs` returns
  newest-first), its first failing task (from one `get-run` call), and that
  task's redacted first error line (from one `get-run-output` call).
  `task_key`/`error` are omitted rather than emitted empty when they can't
  be resolved (a run that never started its tasks), leaving just the
  `run_id` the `jobs logs` follow-up points at. Resolving
  `first_failed` is entirely best-effort: either upstream call failing
  (a transient `get-run` error, or `get-run-output` failing on the resolved
  task) just omits `first_failed` from the envelope rather than discarding
  the tallies already computed — the rollup never sinks over one detail
  fetch. `common_error` is the first line of the failure `state_message`
  shared by the most runs in the window, redacted through `redactSecrets`
  like `first_failed.error`, with `common_error_count` giving how many of
  the `failed` runs share it (`failed` is the denominator, so the count
  stays a plain number rather than an "N of M" string). Both keys are
  emitted only when more than one failure shares a line: a single failure's
  message is already `first_failed.error`, and calling a sample of one
  "common" would overstate it. Ties go to the newest run. A
  `state_message` that isn't a string is skipped rather than parsed,
  same best-effort stance as the detail fetches above.
- `logs`: per-task entries with `state`, and either `error`/`error_trace`
  (tail-truncated to the last 50 lines unless `--full`) or `output` (same
  truncation). Failed tasks sort first. Text passed through
  `redactSecrets` before truncation, since it's upstream log/trace content
  headed straight into agent context.
- `cancel`: `run_id`, `status`, and a `runs view` follow-up.

## Errors

- `list`/`runs`/`view`/`runs view`/`logs` route through a local `runJobs`
  wrapper (`runWithNotFoundHelp`) that folds bare `NOT_FOUND` into
  suggestions pointing at `jobs list`/`jobs runs`.
- `view`, `run`, `runs view` deref the parsed response, so they go through
  `runJobsObject` (`assertObject`), turning an empty upstream response into
  a structured `UPSTREAM_ERROR` instead of a raw `TypeError`.
- `cancel`: an `INVALID_STATE` code, or a message matching
  `/cannot be canceled|already (terminated|completed)/i`, converts to an
  exit-0 no-op (`isAlreadyTerminated`) rather than propagating the error.
- One task's `get-run-output` failing during `logs` doesn't sink the whole
  fan-out — it's captured per-entry as `error: "output fetch failed: ..."`.
- `runs summary`'s `first_failed` resolution is best-effort at both steps:
  the `get-run` call that resolves the failing task is wrapped so a
  transient failure there just omits `first_failed` (tallies already
  computed still render); the nested `get-run-output` call for that task's
  error line is wrapped the same way, dropping the `error` key rather than
  sinking either call over one detail fetch.

## Sharp edges

- `run-now`/`cancel-run` are async by default here (`--no-wait`); upstream
  blocks by default for up to ~20 minutes on `run-now`, so agents should
  avoid `--wait`.
- `INVALID_STATE` on `cancel` is a genuine upstream no-op signal for jobs —
  this mapping does not carry over to `clusters start` (see `clusters.md`).
- There is no upstream `logs` subcommand; this is a `get-run` +
  `get-run-output` fan-out, not a single call.
- int64 `job_id`/`run_id` values are quoted by `runDatabricks` before
  `JSON.parse` so they survive as exact strings past the 2^53 float
  boundary — this domain's ids are treated as `number | string`.
- `list`/`runs` fetch one `--limit` page by default; `--total` swaps that
  for a `totalFetch(limit)` fetch (`TOTAL_FETCH_CEILING` 1000, or `--limit`
  itself when it's above the ceiling, so `--total` never shrinks a bigger
  page the caller asked for) with `--limit` capping DISPLAY only — never
  auto-paginating past that bound (AGENTS.md sharp edge). A fetch that
  fills the bound still reports a numeric `total` but adds a `truncated`
  note, so the count is never claimed as exact. `--total` also passes
  `TOTAL_TIMEOUT_MS` (5 min) instead of the 30s spawn default, since the
  drain is many sequential server pages (`list-runs` has no `--page-size`).
- `runs summary`'s window fetch is the same shape of drain (`list-runs` has
  no `--page-size`, so 200 runs is several sequential server pages) at a
  fifth of the scale, so it passes `RUNS_SUMMARY_TIMEOUT_MS` (60s, a fifth
  of `TOTAL_TIMEOUT_MS`) rather than sitting on the 30s spawn default. The
  `get-run`/`get-run-output` detail calls keep the default: they're single
  object fetches, not drains.
- `runs summary`'s window is capped at 200 (`RUNS_SUMMARY_CEILING`)
  independent of `TOTAL_FETCH_CEILING` — a smaller bound since the command
  also fans out one `get-run`/`get-run-output` pair on top of the window
  fetch.
- `runs summary`'s `running` count is a remainder (`window - success -
failed - other`), so it absorbs PENDING/QUEUED/BLOCKED alongside actively
  RUNNING. It is a remainder of `isTerminal`, not of `result_state`:
  `SKIPPED` and `INTERNAL_ERROR` are terminal life cycles that carry no
  `result_state`, so a `result_state`-only remainder would report finished
  runs as in-flight (and never count an `INTERNAL_ERROR` as a failure).
  Documented in `JOBS_HELP` and here rather than silently overloading the
  name.

## Tests

`test/jobs.test.ts` uses the standard `setupCli()`/`fake-databricks.ts` rig:
a fresh fake `databricks` on PATH per test, `respond`/`respondError` to seed
canned JSON or stderr, `t.run(argv)` to invoke the CLI, and `calls()` to
assert exact argv. Covers the default one-page argv (`--limit 30`/`20`
upstream) vs. the `--total` ceiling-fetch argv (`--limit 1000`),
`total`/`has_more` (including the numeric-`total`-plus-`truncated`
ceiling-hit case and the exact-`--limit`, not-doubled, rerun suggestion
that carries `--total` forward), field selection and rejection, the bulk
vs single-job `runs` default columns (`job_id` leads only in bulk mode), the
first-failed-run `jobs logs` suggestion scoped to the displayed `--limit`
page (a failure beyond it isn't suggested), empty states, auth-error
mapping, job/run views (including the joined `depends_on` scalar per task,
empty for a root task, omitted entirely for a job with no DAG, and dropping
a `depends_on` entry with no `task_key`), the `--wait`
timeout path, log truncation and `--full`, the already-terminated cancel
no-op, the decimal-only `--limit` guard (rejecting `1e3`), an unknown-flag
rejection, and `runs summary`'s window/ceiling math, tallies (including
cancelled/timed-out runs landing in `other`, not `failed`), `first_failed`
(including both best-effort failure paths — a failing `get-run` and a
failing `get-run-output` — the unresolved-task shape, and the
no-failures/no-runs envelopes), and `common_error`/`common_error_count`
(the redacted winning line and its count with no extra upstream calls, its
suppression when only one failure carries a message, and a non-string
`state_message` leaving the tallies intact).

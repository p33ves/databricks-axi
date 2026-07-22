# jobs

Source: `src/commands/jobs.ts`. Tests: `test/jobs.test.ts`.

Read and control Databricks Jobs: list jobs, view a job's config, trigger a
run, list/view runs, fetch run logs, and cancel a run.

## Subcommands

From `JOBS_HELP` in the source:

- `jobs list [--limit N] [--fields a,b]`
- `jobs view <job_id>`
- `jobs run <job_id> [--wait]`
- `jobs runs [job_id] [--limit N] [--fields a,b]`
- `jobs runs view <run_id>`
- `jobs runs summary [job_id] [--limit N]`
- `jobs logs <run_id> [--full]`
- `jobs cancel <run_id>`

All subcommands accept `--profile <name>`. `<job_id>` and `<run_id>` must be
all-digits (`requireId` with `/^\d+$/`); anything else is a usage error
before it reaches argv.

## Upstream calls

- `list` → `databricks jobs list --limit 1000` (`TOTAL_FETCH_CEILING`,
  `shared.ts`) — the agent's own `--limit` caps DISPLAY only; see Output
  shape below
- `view` → `databricks jobs get <job_id>`
- `run` → `databricks jobs run-now <job_id>` (plus `--no-wait` unless
  `--wait` is passed)
- `runs` → `databricks jobs list-runs --limit 1000 [--job-id <job_id>]`
  (same ceiling-fetch shift as `list`)
- `runs view` → `databricks jobs get-run <run_id>`
- `runs summary` → `databricks jobs list-runs --limit <window>
[--job-id <job_id>]`, plus (only when a failure is found) one
  `jobs get-run <run_id>` on the most recent failing run and one
  `jobs get-run-output <task_run_id>` on its first failing task — a fixed
  small number of calls regardless of window size or failure count, never
  a walk over every failing run
- `logs` → no upstream `logs` subcommand exists. It's built from
  `jobs get-run <run_id>` for the task list, then one
  `jobs get-run-output <task_run_id>` call per task (sequential, not
  parallel — a run has a handful of tasks, so the fan-out is kept simple).
- `cancel` → `databricks jobs cancel-run <run_id> --no-wait`

`run` and `cancel` are async by default (`--no-wait`); pass `--wait` to
block, which raises the client-side timeout to 25 minutes to clear
upstream's own ~20-minute block on `run-now`.

## Output shape

- `list`: envelope via `listResult` with `opts.total: true` —
  default fields `job_id`, `name` (flattened out of `settings.name`),
  `creator_user_name`, sliced to the display `--limit` (default 30) out of
  the full ceiling-bounded fetch. `count` is rows shown; `total` is the
  exact fetched count (or `"1000+"` plus a `truncated` note if the fetch
  hit `TOTAL_FETCH_CEILING`); `has_more` is `count < total`. The rerun
  suggestion on a truncated page names `nextLimit(limit, rows.length)` —
  a quadrupled page bounded by the true count, never the whole ceiling
  fetch (an agent following it shouldn't render 1000 rows at once) — and is
  omitted entirely once the display `--limit` already covers everything the
  ceiling fetch got (a bigger `--limit` can't get past that pinned fetch).
- `view`: `job_id`, `name`, `creator_user_name` (same key as `jobs list`), an
  optional `schedule` string
  (`"<cron> (<pause_status>)"`) when a schedule exists, and `tasks` reduced
  to `{ task_key, type, depends_on }` (`type` is derived from
  `notebook_task`/`spark_python_task` or a generic `<x>_task` key name;
  `depends_on` is the task's `settings.tasks[].depends_on[].task_key` list,
  filtered to drop any entry with no `task_key`, read straight off the
  response with no extra call — `[]` for a root task with no upstream
  dependencies).
- `run`: `run_id` (+ `state` if upstream returns one) and a `runs view`
  follow-up.
- `runs`: same `listResult`/`opts.total: true` treatment as `list`. Rows are
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
  rows array), `{ job_id?, window, success, failed, running, truncated?,
first_failed?, help }`. `window` is the number of runs actually fetched
  within the bounded window (`--limit`, default 50, capped at the internal
  ceiling 200). `running` is a remainder, not "actively running": it's every
  run with no terminal `result_state` yet, which also catches
  PENDING/QUEUED/BLOCKED states. `truncated` is present whenever the fetch
  filled the requested window (`runs.length >= window`), not just at the
  200-run ceiling: a full window means the tallies only cover the newest
  `window` runs, so `failed: 0` there is not an authoritative "nothing ever
  failed". Below the ceiling the note points at a bigger `--limit`; at the
  ceiling it says more runs may exist beyond it. Same note style as
  `listResult`'s ceiling-hit case, no separate `total_available` field. `first_failed` is omitted when no
  failure is found in the window; otherwise it's `{ run_id, task_key, error
}` — the most recent failing run (`jobs list-runs` returns newest-first),
  its first failing task (from one `get-run` call), and that task's redacted
  first error line (from one `get-run-output` call). Resolving
  `first_failed` is entirely best-effort: either upstream call failing
  (a transient `get-run` error, or `get-run-output` failing on the resolved
  task) just omits `first_failed` from the envelope rather than discarding
  the tallies already computed — the rollup never sinks over one detail
  fetch.
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
  error line is wrapped the same way, falling back to `error: ""` rather
  than sinking either call over one detail fetch.

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
- `list`/`runs` always fetch `TOTAL_FETCH_CEILING` (1000) rows upstream
  regardless of the agent's own `--limit`, which now caps DISPLAY only —
  never auto-paginates past that bound (AGENTS.md sharp edge); a fetch that
  hits the ceiling renders `total: "1000+"` rather than claiming a false
  precise count.
- `runs summary`'s window is capped at 200 (`RUNS_SUMMARY_CEILING`)
  independent of `TOTAL_FETCH_CEILING` — a smaller bound since the command
  also fans out one `get-run`/`get-run-output` pair on top of the window
  fetch.
- `runs summary`'s `running` count is a remainder (`window - success -
failed`), not "actively running": it also absorbs PENDING/QUEUED/BLOCKED
  states, which have no terminal `result_state` either. Documented in
  `JOBS_HELP` and here rather than silently overloading the name.

## Tests

`test/jobs.test.ts` uses the standard `setupCli()`/`fake-databricks.ts` rig:
a fresh fake `databricks` on PATH per test, `respond`/`respondError` to seed
canned JSON or stderr, `t.run(argv)` to invoke the CLI, and `calls()` to
assert exact argv. Covers list/runs ceiling-fetch argv (`--limit 1000`
upstream regardless of the display `--limit`), `total`/`has_more`
(including the `"1000+"` ceiling-hit case and the exact-`--limit`,
not-doubled, rerun suggestion), field selection and rejection, the bulk
vs single-job `runs` default columns (`job_id` leads only in bulk mode), the
first-failed-run `jobs logs` suggestion scoped to the displayed `--limit`
page (a failure beyond it isn't suggested), empty states, auth-error
mapping, job/run views (including `depends_on` per task, empty for a root
task, and dropping a `depends_on` entry with no `task_key`), the `--wait`
timeout path, log truncation and `--full`, the already-terminated cancel
no-op, the decimal-only `--limit` guard (rejecting `1e3`), an unknown-flag
rejection, and `runs summary`'s window/ceiling math, tallies, `first_failed`
(including both best-effort failure paths — a failing `get-run` and a
failing `get-run-output` — and the no-failures/no-runs envelopes).

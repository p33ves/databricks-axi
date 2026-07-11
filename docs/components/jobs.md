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
- `jobs logs <run_id> [--full]`
- `jobs cancel <run_id>`

All subcommands accept `--profile <name>`. `<job_id>` and `<run_id>` must be
all-digits (`requireId` with `/^\d+$/`); anything else is a usage error
before it reaches argv.

## Upstream calls

- `list` → `databricks jobs list --limit N`
- `view` → `databricks jobs get <job_id>`
- `run` → `databricks jobs run-now <job_id>` (plus `--no-wait` unless
  `--wait` is passed)
- `runs` → `databricks jobs list-runs --limit N [--job-id <job_id>]`
- `runs view` → `databricks jobs get-run <run_id>`
- `logs` → no upstream `logs` subcommand exists. It's built from
  `jobs get-run <run_id>` for the task list, then one
  `jobs get-run-output <task_run_id>` call per task (sequential, not
  parallel — a run has a handful of tasks, so the fan-out is kept simple).
- `cancel` → `databricks jobs cancel-run <run_id> --no-wait`

`run` and `cancel` are async by default (`--no-wait`); pass `--wait` to
block, which raises the client-side timeout to 25 minutes to clear
upstream's own ~20-minute block on `run-now`.

## Output shape

- `list`: envelope via `listResult`, default fields `job_id`, `name`
  (flattened out of `settings.name`), `creator_user_name`.
- `view`: `job_id`, `name`, `creator_user_name` (same key as `jobs list`), an
  optional `schedule` string
  (`"<cron> (<pause_status>)"`) when a schedule exists, and `tasks` reduced
  to `{ task_key, type }` (`type` is derived from `notebook_task`/
  `spark_python_task` or a generic `<x>_task` key name).
- `run`: `run_id` (+ `state` if upstream returns one) and a `runs view`
  follow-up.
- `runs`: rows are the raw upstream items with the derived display fields
  (`state`, `start_time` as ISO, `duration_s`) merged in, so `--fields` can
  select either raw upstream keys or the derived ones. Default fields are
  `run_id`, `state`, `start_time`, `duration_s`.
- `runs view`: `run_id`, `job_id`, `state`, `start_time` (ISO),
  `duration_s`, and a flattened `tasks` array (`task_key`, `state`,
  `duration_s`).
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

## Tests

`test/jobs.test.ts` uses the standard `setupCli()`/`fake-databricks.ts` rig:
a fresh fake `databricks` on PATH per test, `respond`/`respondError` to seed
canned JSON or stderr, `t.run(argv)` to invoke the CLI, and `calls()` to
assert exact argv. Covers list pagination (`has_more`), field selection and
rejection, empty states, auth-error mapping, job/run views, the `--wait`
timeout path, log truncation and `--full`, the already-terminated cancel
no-op, the decimal-only `--limit` guard (rejecting `1e3`), and an
unknown-flag rejection.

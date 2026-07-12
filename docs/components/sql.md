# sql

Source: `src/commands/sql.ts`. Tests: `test/sql.test.ts`.

SQL warehouses management, ad hoc query execution via the statements API,
statement polling/resume, and read-only query history.

## Subcommands

From `SQL_HELP`:

- `sql warehouses [--fields a,b]`
- `sql warehouses view <id>`
- `sql warehouses start|stop <id> [--wait]`
- `sql exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]`
- `sql statement view <statement_id>`
- `sql history [--limit N] [--status S] [--full] [--fields a,b]`

All accept `--profile <name>`.

## Upstream calls

- `warehouses` / `warehouses view` / `warehouses start|stop` →
  `databricks warehouses list|get|start|stop`.
- `exec` and `statement view` do **not** use a CLI subcommand — there is no
  statement-execution subcommand upstream (databricks/cli#3896). They go
  through `runDatabricksApi` (the `api` passthrough) against
  `POST /api/2.0/sql/statements` to submit, then poll
  `GET /api/2.0/sql/statements/{id}` every 2s (`POLL_INTERVAL_MS`) until a
  terminal state. The submit call's own `wait_timeout` is clamped to
  `max(5, min(budgetS, 50))` seconds (the API enforces <= 50s per call);
  the client-side `--timeout` budget (default 120s) governs the overall
  poll loop, independent of that per-call cap. `sqlPoll.sleep` is
  exported/injectable so tests can run the poll loop at full speed.
- `history` → `databricks query-history list --max-results N`. This is the
  one list endpoint with genuine server-side pagination
  (`has_next_page`/page tokens), unlike everything else in this CLI.

## Output shape

- `warehouses`: no `listResult` envelope (bespoke empty state + `count`
  inline) — default fields `id`, `name`, `state`, `size` (derived:
  `cluster_size` + `" (serverless)"` when `enable_serverless_compute`).
- `warehouses view`: `id`, `name`, `state`, `size`, `auto_stop_mins`,
  `creator_name`, plus `start`/`stop` and an `sql exec --warehouse <id>`
  follow-up.
- `warehouses start`/`stop`: async by default, status `"start requested"` /
  `"stop requested"`. With `--wait` upstream blocks until the state is
  reached and only then exits 0, so the reported status is the reached
  state: `"started, warehouse RUNNING"` / `"stopped, warehouse STOPPED"`.
- `exec` / `statement view`: on success, `{ statement_id, columns
(name:type_text pairs), rows, total_row_count }`, plus a `help` array with
  `sql exec "<query>"` and `sql history` follow-ups. A non-`SUCCEEDED`
  terminal state throws `SQL_ERROR` with the redacted error detail. A
  still-`PENDING`/`RUNNING` statement past the `--timeout` budget returns
  exit 0 with `status: "still running..."` and a `sql statement view`
  follow-up — the statement itself keeps running server-side. `--full` on
  a multi-chunk result fetches the remaining
  `.../result/chunks/{n}` pages sequentially and concatenates them;
  otherwise `truncated` reports `showing X of Y rows`. A server-side
  `row_limit` truncation (`manifest.truncated`) always adds a
  `rerun with --limit <2x>` note, since `--full` can never exceed the
  submitted cap.
- `history`: `listResult`-shaped by hand (does not call `listResult` — see
  Sharp edges). Default fields `query_id`, `status`, `query_text`
  (clipped to 120 chars unless `--full`), `error` (first line of
  `error_message` unless `--full`). `has_more` is sourced from the real
  `has_next_page` flag, not a `rows.length >= limit` heuristic. Two
  distinct empty states: truly-empty vs. empty-after-a-`--status` filter
  (client-side filter over the fetched window, never a warehouse
  interaction).

## Errors

- `exec`/`statement view` responses are `assertObject`-guarded at every
  submit/poll/chunk step.
- `resolveWarehouse` throws `NOT_FOUND` when the workspace has zero
  warehouses, or a usage error listing every warehouse id/name when more
  than one exists and `--warehouse` wasn't passed.
- `warehouses view`/`start`/`stop` route through a local `runSql`
  (`runWithNotFoundHelp`), folding a bare NOT_FOUND into a
  `sql warehouses` suggestion.
- `statement view` goes through `runDatabricksApi`, not `runDatabricks`, so
  it folds NOT_FOUND via `foldNotFoundHelp` directly (not `runSql`),
  suggesting `sql history` instead.
- Error/log-adjacent text (`error_message`, statement error detail) goes
  through `redactSecrets` before it can reach output.

## Sharp edges

- `sql exec` polls instead of calling a native exec subcommand — watch
  databricks/cli#3896; if `databricks query sql` ships upstream, this can
  delegate instead.
- `sql warehouses start/stop` on an already-in-state warehouse exits 0
  silently upstream (live-verified 2026-07-07) — no `INVALID_STATE` no-op
  mapping is needed or present here, unlike `clusters start`.
- `sql history` is one of three documented exemptions from `listResult`
  (the others are `fs ls` and `sql warehouses`): the real `has_next_page`
  flag and the two distinct empty states don't fit that helper's
  `rows.length >= limit` heuristic, so it builds its own envelope by hand.
- `sql warehouses` is the third exemption: it has no `--limit` flag at
  all, by deliberate spec decision (a workspace has a handful of
  warehouses), and hand-builds its own `count`-only envelope — the one
  list command in the repo with no client-side cap safeguard.
- `--status` filtering is always client-side over the already-fetched
  page, never a second server call.

## Tests

`test/sql.test.ts` stubs `sqlPoll.sleep` to a no-op in `beforeEach`/
restores it in `afterEach` so poll-loop tests run at full speed instead of
waiting 2s per iteration. Uses `setupCli()`/`fake-databricks.ts`, plus
local helpers `succeededStmt()` and `submittedBody()` for canned statement
responses. Covers warehouse list/view/start/stop, the NOT_FOUND-to-
`sql warehouses` mapping on `warehouses view`/`start` and the NOT_FOUND-to-
`sql history` mapping on `statement view`, exec submit/poll/timeout/
chunk-fetch paths, wait_timeout clamping (both the 50s ceiling and the 5s
floor), row_limit truncation, the two `history` empty states plus its
`has_next_page`-sourced pagination, the `help` follow-up on a successful
`exec`, and an unknown-flag rejection.

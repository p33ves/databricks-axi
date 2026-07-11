# home

Source: `src/commands/home.ts` (rendering/assembly) +
`src/context.ts` (panel fetch logic, see `core.md`). Tests:
`test/home.test.ts`.

The ambient dashboard shown on a bare `databricks-axi` invocation (or
`databricks-axi home`), and on every hooked agent session start (via
`setup hooks`). Assembles auth context, recent job runs, SQL warehouses,
running clusters, and a command/verb summary in one shot.

## Subcommand

- `(none)` / `home [--profile <name>]` — no other flags, no positional
  arguments (`homeCommand` throws a usage error if any positional is
  given).

## Upstream calls

Four spawns fire in parallel via `Promise.allSettled`, each individually
overridden to a `PANEL_TIMEOUT_MS` (4s) timeout instead of the default
30s:

- `databricks auth describe` (via `fetchAuthContext` in `context.ts`)
- `databricks jobs list-runs --limit 5` (via `fetchRecentRuns`)
- `databricks warehouses list` (via `fetchWarehouses`)
- `databricks clusters list` (via `fetchRunningClusters`)

Rendering only starts once every panel has settled (succeeded, failed, or
hit its own 4s timeout) — the whole command never blocks on the default
30s spawn timeout.

## Output shape

- `context`: `{ user, host, auth_type, profile }` from `fetchAuthContext`,
  or an `unavailable(reason)` string if that panel failed/timed out.
- `recent_runs`: up to 5 rows, FAILED-first (`fetchRecentRuns` sorts by
  `isFailedRun` descending), each `{ run_id, state, start_time, next? }` —
  `next` is a `jobs logs <run_id>` follow-up, present only on failed runs.
- `warehouses`: `{ id, name, state }` rows — "the compute panel that
  actually has content" on Free Edition, per the source comment.
- `running_clusters`: `{ cluster_id, cluster_name, state }` rows, filtered
  to non-`TERMINATED`. **Omitted entirely** (not even an empty array) when
  there are zero non-terminated clusters, so serverless/Free-Edition
  workspaces don't pay a "no clusters" line every session.
- `commands`: a flat one-line summary of every wired domain and its
  subcommands (`AVAILABLE_COMMANDS` in the source).
- `help`: three fixed top-level suggestions (`jobs list`, `sql exec`,
  `catalog catalogs`).

## Errors

- A degraded (failed or timed-out) panel never fails the whole command —
  it renders as one `<panel>: unavailable (<reason>)` line via
  `unavailable()`, and the command still exits 0.
- The one exception: if the **auth** panel specifically rejects with an
  `AUTH_ERROR` `AxiError`, the entire dashboard body is swapped for the
  structured error (`error`, `code`, `help`) instead of rendering the other
  panels — since every other workspace-dependent panel would fail with the
  same root cause. `commands` is still included even in this branch; exit
  code stays 0.
- Any other panel-level error (timeout, non-auth upstream error) is
  swallowed into its own `unavailable(...)` line, not surfaced as a command
  failure.

## Sharp edges

- The 4s per-panel timeout is a hard override on every panel spawn, not
  the CLI's usual 30s default — this is the "time-boxed, degrade
  independently" budget referenced in `HOME_HELP`.
- Never pass `--sensitive` to `auth describe` — it exists upstream and
  would put a token on stdout; `fetchAuthContext` deliberately never does.
- `auth describe -o json`'s shape is nested (live-verified on CLI v1.6.0):
  `user` is the top-level `username`, `host`/`auth_type` are under
  `details`, and `profile` is under
  `details.configuration.profile.value` (falling back to the `--profile`
  flag passed in, if any) — not a flat object.

## Tests

`test/home.test.ts` uses `setupCli()`/`fake-databricks.ts` with a local
`seedAll()` helper to canned all four panel responses at once. Covers the
exact parallel argv for all four spawns (asserting `--sensitive` is never
passed), the nested `auth describe` shape, FAILED-first run sorting with
per-row `jobs logs` suggestions, the running-clusters TERMINATED filter and
its zero-rows omission, one degraded/timed-out panel leaving the others
intact (exit 0), the 4s-per-panel budget actually running in parallel (not
serially), the whole-body swap on an `AUTH_ERROR`, bare-invocation parity
with explicit `home`, `--profile` threading to every panel, and dispatch-
level usage errors.

# pipelines

Source: `src/commands/pipelines.ts`. Tests: `test/pipelines.test.ts`.

Lakeflow (Delta Live Tables) pipeline management: list, view, start, stop,
and event browsing.

## Subcommands

From `PIPELINES_HELP`:

- `pipelines list [--limit N] [--fields a,b]`
- `pipelines view <pipeline_id>`
- `pipelines start <pipeline_id>`
- `pipelines stop <pipeline_id>`
- `pipelines events <pipeline_id> [--limit N] [--fields a,b] [--full]`

All accept `--profile <name>`. Every `<pipeline_id>` argument is validated
against a UUID pattern
(`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) before
it can reach argv.

## Upstream calls

- `list` → `databricks pipelines list-pipelines --limit N`
- `view` → `databricks pipelines get <pipeline_id>`
- `start` → `databricks pipelines start-update <pipeline_id>` — no wait
  flags exist upstream for this call (`--help` only shows
  `--cause`/`--full-refresh`/`--json`/`--validate-only`), so it's naturally
  async; there's no `--wait` option on `pipelines start` here either.
- `stop` → `databricks pipelines stop <pipeline_id> --no-wait`
- `events` → `databricks pipelines list-pipeline-events <pipeline_id>
--limit N`

## Output shape

- `list`: `listResult` envelope, default fields `pipeline_id`, `name`,
  `state`. The raw response key is `statuses` (via `asList(parsed,
"statuses")`), rendered under the `pipelines` output key.
- `view`: `pipeline_id`, `name`, `state`, `latest_updates` (sliced to the
  first 3, flattened to `{ update_id, state, creation_time }`),
  `catalog`/`schema`/`continuous` (pulled out of the nested `spec` object).
  `help` includes a `pipelines events` suggestion when the latest update is
  `FAILED`, plus a `stop`/`start` suggestion based on current state.
- `start`: on success, `pipeline_id`, `update_id`, `status: "update
requested"`. On a conflicting active update (see Errors), an exit-0 no-op
  carrying the active `update_id` instead.
- `stop`: always `pipeline_id`, `status: "stop requested"` — no branching
  on upstream response shape (see Sharp edges).
- `events`: `listResult` envelope. Rows are sorted `ERROR` level first,
  then by timestamp descending within each partition (no `--order-by`
  upstream, so this is done client-side, mirroring the failed-first
  principle `jobs logs` uses for tasks). `message` text is redacted, then
  clipped to 200 chars unless `--full`; a clip anywhere in the page adds a
  `pipelines events <id> --full` help line and a top-level `truncated: "N
message(s) clipped to 200 chars — rerun with --full"` field, same as every
  sibling domain's truncation signal. Default fields (also the only fields
  `--fields` may select among): `timestamp`, `level`, `event_type`,
  `message` — other upstream event fields are dropped before rendering.

## Errors

- `list`/`view`/`events` route through a local `runPipelines`
  (`runWithNotFoundHelp`), suggesting `pipelines list` on NOT_FOUND.
- `view` derefs via `assertObject`.
- `start`: a conflicting active update is not a distinct upstream error
  code — it's `UPSTREAM_ERROR` with `An active update '<id>' already
exists` in the message. Caught by the `CONFLICT` regex (the same pattern
  `clusters.ts` uses for "is in unexpected state") and converted to an
  exit-0 no-op that surfaces the active `update_id`. Any other error (e.g.
  a nonexistent pipeline) propagates as-is.
- `stop`: upstream `stop --no-wait` is silently idempotent — exit 0, empty
  stdout, on both an already-`IDLE` pipeline and a mid-update one (which it
  cancels). There is no rejection shape to inspect, so unlike `start` there
  is no conflict branch — `pipelinesStop` always returns exit 0 (same
  pattern as `clusters stop` → `clusters delete`).

## Sharp edges

- Upstream `pipelines stop`/`start-update`/`get` are dual-mode: a non-UUID
  argument is resolved as a bundle resource KEY against cwd project config
  instead of a pipeline id, producing confusing errors. The UUID guard here
  exists specifically to keep a non-UUID string from ever reaching argv.
- `pipelines get`'s `latest_updates` is nested, not top-level — must be
  extracted/flattened before rendering.
- `NOT_FOUND` matching includes "was not found" specifically because
  that's the real string `pipelines get` returns on an unknown id (a
  different phrasing than `workspace`/`fs`'s "does(n't) exist").

## Tests

`test/pipelines.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
list pagination and field selection, `view`'s `latest_updates` slicing and
state-based help suggestions, the UUID-format guard for `<pipeline_id>`
(rejected before spawning), the live "was not found" NOT_FOUND mapping, the
active-update conflict-to-no-op conversion for `start`, and the always-exit-0
`stop` behavior.

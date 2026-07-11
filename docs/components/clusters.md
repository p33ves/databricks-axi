# clusters

Source: `src/commands/clusters.ts`. Tests: `test/clusters.test.ts`.

List, view, start, and stop all-purpose clusters.

## Subcommands

From `CLUSTERS_HELP`:

- `clusters list [--limit N] [--fields a,b]`
- `clusters view <cluster_id>`
- `clusters start <cluster_id> [--wait]`
- `clusters stop <cluster_id> [--wait]`

All accept `--profile <name>`. Cluster ids are opaque strings (e.g.
`1234-567890-abc123`), so `requireId` only rejects a leading `-` (to stop
one being smuggled onto argv as a flag), not a strict id pattern.

## Upstream calls

- `list` → `databricks clusters list --limit N`
- `view` → `databricks clusters get <cluster_id>`
- `start` → `databricks clusters start <cluster_id>` (+ `--no-wait` unless
  `--wait`)
- `stop` → `databricks clusters delete <cluster_id>` (+ `--no-wait` unless
  `--wait`) — there is **no** upstream `clusters stop`; `delete` is the
  terminate verb that keeps the cluster's config and leaves it restartable.
  `clusters stop` never calls `permanent-delete`, which destroys the
  cluster outright.

`start`/`stop` are async by default; `--wait` raises the client timeout to
25 minutes to clear upstream's own ~20-minute block.

## Output shape

- `list`: `listResult` envelope, default fields `cluster_id`,
  `cluster_name`, `state`. If any row is `TERMINATED`, a `clusters start
<id>` follow-up is appended to `help`.
- `view`: `cluster_id`, `cluster_name`, `state`, optional `state_message`
  (only when non-empty), `spark_version`, `node_type_id`,
  `num_workers` (rendered as `"<min>-<max>"` when `autoscale` has both
  bounds, else the raw `num_workers`), `autotermination_minutes`,
  `creator_user_name`, and a `help` suggestion (`stop` if `RUNNING`, else
  `start`).
- `start`/`stop`: with `--no-wait` upstream returns empty stdout
  (`runDatabricks` yields `null`); the code calls `runClusters` and
  discards the result rather than `assertObject`-ing it, and takes
  `cluster_id` from the argv positional, never from a response.

## Errors

- All calls route through a local `runClusters` (`runWithNotFoundHelp`)
  that folds bare `NOT_FOUND` into a `clusters list` suggestion.
- `view` derefs the response via `assertObject`, mapping an empty upstream
  response to `UPSTREAM_ERROR`.
- `start` on a non-`TERMINATED` cluster is **not** an upstream no-op: it
  exits 1 with `Error: Cluster <id> is in unexpected state Running.` (or
  `Pending.`), which `mapUpstreamError` classifies as `UPSTREAM_ERROR`, not
  `INVALID_STATE`. `clustersStart` catches this by matching
  `/is in unexpected state/i` on the error message (not the error code) and
  converts it to an exit-0 no-op. Any other error (e.g. `NOT_FOUND`, 403)
  propagates unchanged.
- `stop` (`clusters delete`) has no such conversion at all: upstream is
  silently idempotent on an already-terminated cluster (exit 0, empty
  output, byte-identical to a fresh terminate), so `clustersStop` always
  returns exit-0 without inspecting the result.

## Sharp edges

- Don't assume the "no-op on already-in-state" pattern is uniform: `jobs
cancel`'s `INVALID_STATE` no-op does not carry to `clusters start` (which
  needs the message-regex catch instead), and `clusters stop` needs no
  catch at all (upstream is already silent).
- Never call `permanent-delete` for `stop` — it is destructive, unlike
  `delete`.

## Tests

`test/clusters.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
list/view/start/stop argv shape, autoscale min-max vs. fixed `num_workers`
fallback logic, the `state_message` presence/absence branches, the
"is in unexpected state" no-op conversion for `start`, the silent-idempotent
`stop` path, 403 → `PERMISSION_DENIED` mapping, and an unknown-flag
rejection.

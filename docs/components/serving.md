# serving

Source: `src/commands/serving.ts`. Tests: `test/serving.test.ts`.

Read-only browsing of model serving endpoints. This CLI never invokes an
endpoint; it only reports on configuration and readiness.

## Subcommands

From `SERVING_HELP`:

- `serving list [--limit N] [--fields a,b]`
- `serving view <name>`

Both accept `--profile <name>`. `<name>` uses the same shape guard as
`clusters`' id: only a leading `-` is rejected, since endpoint names are
opaque strings.

## Upstream calls

- `list` → `databricks serving-endpoints list --limit N`
- `view` → `databricks serving-endpoints get <name>`

## Output shape

- `list`: `listResult` envelope, default fields `name`, `state`, `task`.
  `state` in the raw response is a `{ ready, config_update }` object, not a
  string — it's flattened to a compact string (`compactState`) before
  rendering: `READY`/`NOT_READY` etc., with `" (updating)"` appended when
  `config_update` is not `NOT_UPDATING`. This mirrors the pattern
  `clusters.ts` uses for its own `autoscale` object.
- `view`: `name`, `state` (same compact form), `task`, `served_entities`
  (flattened from the nested `config.served_entities`), and an
  `invocation_url_path` (`/serving-endpoints/<name>/invocations`) — a path
  string only, never an actual call. `help` explicitly states that this
  CLI does not invoke endpoints.
- Each served-entity row (`entityRow`): `name` resolved through a fallback
  chain — `foundation_model.display_name` → `foundation_model.name` →
  `entity_name` → `name` — plus `entity_version`/`workload_size`/
  `scale_to_zero`, each included only when present (they apply only to
  custom-served-model entities, not foundation-model ones).

## Errors

- Both subcommands route through a local `runServing`
  (`runWithNotFoundHelp`), suggesting `serving list` on NOT_FOUND.
- `view` derefs via `assertObject`.

## Sharp edges

- `serving-endpoints list` **does** have a real upstream `--limit`, unlike
  `fs ls` — so `serving list` uses the standard `listResult` envelope and
  is not a candidate for the `fs ls`-style has_more exemption.
- Foundation-model served entities have no `entity_name` field at all —
  only custom-served-model entities set it. The display-name fallback
  chain exists specifically so a foundation-model row still gets a
  sensible name instead of `undefined`.
- `config.served_entities` is nested, not top-level, in the `get` response
  — same shape trap as `pipelines get`'s `latest_updates`.
- This domain is read-only by design (documented in `SERVING_HELP`): no
  invoke command exists or is planned for this release.

## Tests

`test/serving.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers list
pagination from a bare-array response, field selection, the
foundation-model vs. custom-endpoint served-entity rendering (including the
absent-`entity_version`/`workload_size` case), the "(updating)" compact
state suffix, the live serving-404 NOT_FOUND mapping, and dispatch-level
usage errors (unknown subcommand, bare invocation, extra positionals).

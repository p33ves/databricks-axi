# dashboards

Source: `src/commands/dashboards.ts`. Tests: `test/dashboards.test.ts`.

Read-only AI/BI (Lakeview) dashboard browsing: `list` and `view`. No
mutation (`create`/`update`/`publish`/`unpublish`/`trash`/`revert`/
`migrate` and schedule/subscription verbs are out of scope — see
`docs/superpowers/specs/2026-07-16-databricks-axi-1.2.0-dashboards-grants-design.md`
§6 for the full excluded list, reachable via `api get`).

## Subcommands

From `DASHBOARDS_HELP`:

- `dashboards list [--limit N] [--trashed] [--fields a,b]`
- `dashboards view <dashboard_id> [--full]`

Both accept `--profile <name>`.

## Upstream calls

- `list` → `databricks lakeview list --limit N` (+ `--show-trashed` under
  `--trashed`). `--page-size`/`--view` are transport knobs, not exposed —
  the default `list` response already omits `serialized_dashboard`, so
  `--view DASHBOARD_VIEW_BASIC` would be a no-op.
- `view` → `databricks lakeview get <dashboard_id>`.

## Dashboard ids are 32 hex chars, not dashed UUIDs

Upstream's own `--help` calls `DASHBOARD_ID` a "UUID", but the real id
(live-verified twice, 2026-07-16) is 32 lowercase hex chars, no dashes:
`01f18184706f11da846a179c97fcc018`. The id guard is

```
/^[0-9a-fA-F][0-9a-fA-F-]{31,35}$/
```

anchored on a hex first character so the leading-dash rejection is real (a
naive `/^[0-9a-fA-F-]{32,36}$/` would wrongly accept a leading dash or an
all-dash string of the right length). Both the live 32-hex shape and a
dashed 36-char UUID (in case upstream's docs are ever right) pass; anything
else is rejected before it reaches argv, pointing at `dashboards list`.
This is a shape guard, not an existence check — a well-formed but missing
id is upstream's `NOT_FOUND` to report, not axi's to pre-empt.

## Output shape

- `list`: standard `listResult` envelope (upstream `--limit` is a real
  client-side cap — same family as `serving list`, not the `fs ls`/`sql
history`/`sql warehouses` exemptions). Default fields: `dashboard_id`,
  `display_name`, `lifecycle_state`, `update_time`. Empty state without
  `--trashed` points at `dashboards list --trashed` (a trashed dashboard
  disappears from the default list and reappears there with
  `lifecycle_state: TRASHED`); empty state with `--trashed` gets its own
  distinct status.
- `view`: `dashboard_id`, `display_name`, `lifecycle_state`, `path`,
  optional `warehouse_id` (omitted when the dashboard has none bound),
  `update_time`, then `pages`/`datasets` — pre-computed counts from a
  defensive `JSON.parse(serialized_dashboard)` (`pages = spec.pages?.length
?? 0`, `datasets = spec.datasets?.length ?? 0`). `serialized_dashboard`
  itself (the whole dashboard spec — pages/layout/widgets/datasets/
  queries, easily 100 KB+ on a real dashboard) is dropped by default; this
  is the entire point of the command, since the raw `lakeview get` payload
  is dominated by that one field.
- `--full` adds the key `serialized_dashboard` holding the raw string
  **verbatim** — no `renderFileContent` call (that helper's only real job
  is a binary-sentinel check that can never fire on a JSON string field, so
  calling it here would just introduce a `{content, truncated?}` key-shape
  ambiguity for zero benefit). Unbounded, same contract as `workspace
view`/`fs cat --full`.
- Unparseable (or non-object) `serialized_dashboard` → `pages`/`datasets`
  are omitted and a `note: "dashboard spec unparseable — rerun with --full
for the raw definition"` row is added instead. Never an error, never a
  guessed count.

## Errors

- `view` routes through `runWithNotFoundHelp`, suggesting both
  `dashboards list` and `dashboards list --trashed` on `NOT_FOUND`.
- The live missing-dashboard stderr (`Error: Unable to find dashboard
[<id>]`) and `get-published`'s `Unable to find published dashboard [<id>]`
  are mapped to `NOT_FOUND` in `src/errors.ts` (they didn't match the
  pre-1.2.0 alternation at all). `invalid resource name [dashboards/…]` /
  `is not a valid object` (format errors on a malformed id) stay
  `UPSTREAM_ERROR` on purpose — see the redaction note below and the
  AGENTS.md sharp edge.

## Sharp edges

- **`redactSecrets` eats the dashboard id in error text.** A Lakeview
  dashboard id is exactly 32 lowercase hex chars, the same shape
  `redactSecrets` treats as a leaked secret and rewrites to `[redacted]` —
  and that redaction runs _before_ classification. So a live
  `NOT_FOUND` on a missing dashboard renders as `Unable to find dashboard
[[redacted]]`, not the id the agent just typed. This is cosmetic (the
  anchor phrase survives, the code is still `NOT_FOUND`, and the `help[]`
  still points at `dashboards list`) and deliberate — do not loosen the
  32-hex redaction rule to spare dashboard ids; that would unredact real
  hex secrets elsewhere. Success rows (`dashboard_id` on `list`/`view`) are
  never touched by this — `redactSecrets` only runs on error/log text.
- `dashboards` vs. `dbsql-dashboards` (relevant on `permissions`, see
  `docs/components/permissions.md`): only `dashboards` (this domain, AI/BI
  Lakeview) is covered. Legacy DBSQL dashboards are a different id space
  entirely and are out of scope.

## Tests

`test/dashboards.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
exact argv (including `--show-trashed` and `--profile` threading),
`--fields` selection/rejection, `has_more` pagination, both empty states,
the `pages`/`datasets` derivation (including the unparseable/non-object
cases), `warehouse_id` omission, the `--full` raw-string passthrough, the
full id-guard matrix (rejecting `foo`, `--evil`, `../x`, a 32-char
leading-dash string, and a 32-dash string, plus a leading dash smuggled
past `--`; accepting both the live 32-hex shape and a dashed 36-char UUID),
the live `Unable to find dashboard` NOT_FOUND mapping asserting the
redacted `[[redacted]]` form, and the `invalid resource name` format error
staying `UPSTREAM_ERROR`.

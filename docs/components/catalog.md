# catalog

Source: `src/commands/catalog.ts`. Tests: `test/catalog.test.ts`.

Read-only Unity Catalog browsing: catalogs, schemas, tables, volumes, and
functions.

## Subcommands

From `CATALOG_HELP`:

- `catalog catalogs [--limit N] [--fields a,b]`
- `catalog schemas <catalog> [--limit N] [--fields a,b]`
- `catalog tables <catalog>.<schema> [--limit N] [--fields a,b]`
- `catalog table view <catalog>.<schema>.<table>`
- `catalog volumes <catalog>.<schema> [--limit N] [--fields a,b]`
- `catalog volume view <catalog>.<schema>.<volume>`
- `catalog functions <catalog>.<schema> [--limit N] [--fields a,b]`
- `catalog function view <catalog>.<schema>.<function>`

All accept `--profile <name>`. `<catalog>` args reject a leading `-`
(`/^[^-]/`); dotted refs (`schema`/`tables`/`volumes`/`functions` list
subcommands and the `view` variants) are validated with patterns like
`/^[^.-][^.]*\.[^.-].*$/` (two-part) or `/^[^.-][^.]*\.[^.]+\.[^.]+$/`
(three-part) before being split on the first/last `.` — this both rejects
a leading dash smuggled past `--` and enforces the expected arity.

## Upstream calls

- `catalogs` → `databricks catalogs list --limit N`
- `schemas` → `databricks schemas list <catalog> --limit N`
- `tables` → `databricks tables list <catalog> <schema> --limit N
--omit-columns --omit-properties` (the default payload carries full
  column/property blobs; those belong to `table view`, not the list)
- `table view` → `databricks tables get <full_name>`
- `volumes` → `databricks volumes list <catalog> <schema> --limit N`
- `volume view` → `databricks volumes read <full_name>`
- `functions` → `databricks functions list <catalog> <schema> --limit N`
- `function view` → `databricks functions get <full_name>`

## Output shape

- All list subcommands go through `listResult`, each with its own default
  field set: `catalogs` → `name, owner, catalog_type`; `schemas` →
  `name, owner` (upstream's `name` here is already the bare schema name,
  not `full_name`); `tables` → `name, table_type, data_source_format`;
  `volumes` → `name, volume_type`; `functions` →
  `name, data_type, comment`.
- `table view`: `full_name`, `table_type`, `owner`, optional `comment`,
  and `columns` flattened to `{ name, type_text, nullable }`. `help`
  suggests an `sql exec "SELECT * FROM <full_name> LIMIT 10"`.
- `volume view`: `full_name`, `volume_type`, `owner`, optional `comment`
  and `storage_location`. `help` points at `fs ls
/Volumes/<catalog>/<schema>/<volume>`.
- `function view`: `full_name`, `data_type`, `routine_definition`,
  optional `comment`, `params` flattened to `{ name, type_text }`, and
  optional `sql_data_access`/`is_deterministic`/`external_language` (only
  rendered when present).

## Errors

- Every list/get call except `catalogs` (which has nowhere upstream to
  point) routes through `runWithNotFoundHelp` with a domain-specific
  suggestion: schemas errors point at `catalog catalogs`; tables/volumes/
  functions errors point at `catalog schemas <catalog>`; the three `*
view` commands point back at their own list command with the parent ref.
- `table view`/`volume view`/`function view` deref the response via
  `assertObject`.

## Sharp edges

- `tables` deliberately omits column/property payloads
  (`--omit-columns --omit-properties`) — use `table view` for schema.
- `volumes`/`functions` are metadata browse only; actual volume file
  contents are read through `fs ls`/`fs cat`, not this domain.
- Free Edition workspaces have a `workspace` catalog, not `main` — the
  empty-catalogs help text calls this out so an agent doesn't assume a
  permissions problem when `main` is simply absent.

## Tests

`test/catalog.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
bare-array vs. wrapped-object response tolerance, `has_more` pagination,
empty states (including the Free Edition catalog note), `--fields`
validation, dotted-arg splitting with the `--omit-columns`/
`--omit-properties` flags for tables, leading-dash-smuggling rejection for
both single and dotted refs, and NOT_FOUND-to-suggestion mapping at each
level (catalog → schema → table/volume/function).

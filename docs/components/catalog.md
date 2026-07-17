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
- `catalog grants <securable-type> <name> [--principal P] [--full] [--fields a,b]`

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
- `grants` → `databricks grants get-effective <TYPE> <FULL_NAME> --max-results
0` (+ `--principal P`, + `--page-token <t>` on subsequent pages)

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
- `grants`: hand-built envelope `{ grants: rows, count, help }` — no
  agent-facing `--limit`, the page loop drains every page and concats
  `privilege_assignments`, continuing while `next_page_token` is present
  (a zero-result page carrying a token still continues — this is
  upstream's documented pagination-deprecation contract, not a bug).
  Default row `{ principal, privileges }` (comma-joined privilege names);
  `--full` row `{ principal, privilege, inherited_from_type,
inherited_from_name }`. Unlike `permissions`, `--fields` **is** kept
  here — not because these rows are a raw spread (they're a hand-built
  projection, same as `permissions`'), but because `--full` gives it four
  real columns worth picking between; the plain two-column default is the
  same shape `--fields` was dropped from on `permissions`, and stays there
  for the same reason. Empty (both a bare `{}` and `{
privilege_assignments: [] }`) renders a definitive
  `"no effective grants on <type> <name> for the caller's visibility"`
  status plus a walk-up-the-hierarchy suggestion (table/volume/function →
  parent schema's grants, schema → parent catalog's grants, catalog →
  `catalog schemas <name>`).

## Errors

- Every list/get call except `catalogs` (which has nowhere upstream to
  point) routes through `runWithNotFoundHelp` with a domain-specific
  suggestion: schemas errors point at `catalog catalogs`; tables/volumes/
  functions errors point at `catalog schemas <catalog>`; the three `*
view` commands point back at their own list command with the parent ref.
- `table view`/`volume view`/`function view` deref the response via
  `assertObject`.
- `grants` maps two live phrasings via the shared `src/errors.ts`
  alternation: a missing securable (`Error: Table '<name>' does not
exist.` / `Error: Catalog '<name>' does not exist.`) and a bad
  `--principal` (`Error: Could not find principal with name <p>.`). Both
  fold into a bare `NOT_FOUND` upstream; **help selection happens at the
  call site**, by whether `--principal` was passed on this invocation, not
  by re-parsing the error text — with `--principal`, the help leads with
  "drop `--principal` to list every principal with grants" plus `whoami`;
  without it, only the walk-up-the-hierarchy suggestion.
- `PERMISSION_DENIED` on a 403 uses the existing shared branch — **not
  live-observed** for this endpoint (standing AGENTS.md watch item);
  fixtures pin both plausible shapes (bare `403` and a `PERMISSION_DENIED`
  token).

## Sharp edges

- `tables` deliberately omits column/property payloads
  (`--omit-columns --omit-properties`) — use `table view` for schema.
- `volumes`/`functions` are metadata browse only; actual volume file
  contents are read through `fs ls`/`fs cat`, not this domain.
- Free Edition workspaces have a `workspace` catalog, not `main` — the
  empty-catalogs help text calls this out so an agent doesn't assume a
  permissions problem when `main` is simply absent.
- `grants`'s `<securable-type>` allow-list (`catalog`, `schema`, `table`,
  `volume`, `function`) is lowercase-only and **rejects rather than
  normalizes** a different case, even though upstream itself accepts any
  case (`CATALOG`/`Table` are both silently normalized server-side, live-
  verified). This is deliberate: one canonical spelling keeps axi's own
  output/help/docs/bench fixtures from having to track whatever casing an
  agent typed, and the allow-list doubles as the leading-dash/argv guard
  on the type. A rejected `TABLE` costs one turn and teaches the canonical
  form via the exit-2 message.
- `grants get-effective` has real server-side pagination
  (`--max-results`/`--page-token`, like `sql history`'s `query-history
list`) — this and `sql history` are the only two commands in the repo
  that use it; every other list command's `--limit` is purely a
  client-side cap.
- Grant principals (emails, 44-char `_workspace_users_workspace_…` group
  ids) are never redacted in success rows — `redactSecrets` only runs on
  error/log text, never on result data.

## Tests

`test/catalog.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
bare-array vs. wrapped-object response tolerance, `has_more` pagination,
empty states (including the Free Edition catalog note), `--fields`
validation, dotted-arg splitting with the `--omit-columns`/
`--omit-properties` flags for tables, leading-dash-smuggling rejection for
both single and dotted refs, and NOT_FOUND-to-suggestion mapping at each
level (catalog → schema → table/volume/function). `grants` coverage
includes exact argv (with and without `--principal`), the zero-result-
page-with-a-token pagination drain, `--full`/`--fields` rendering, both
empty-response shapes, the non-lowercase securable-type rejection, the
`--principal`-present-vs-absent help-selection split, both plausible 403
fixture shapes, and an unredacted-principal leak test.

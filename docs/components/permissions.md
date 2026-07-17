# permissions

Source: `src/commands/permissions.ts`. Tests: `test/permissions.test.ts`.

Read-only workspace-object ACLs: `databricks-axi permissions <object-type>
<id>`. A single top-level verb, not a subcommand of `jobs`/`clusters`/etc —
one upstream call (`permissions get`), one row shape, five object types: one
file and one help block beats the same code pasted into five domains. The
type is the first positional, mirroring `api <method> <path>`.

Unity Catalog grants are a different surface (different API, different id
space, different pagination model) — see `docs/components/catalog.md`'s
`grants` section, not this file.

## Usage

`databricks-axi permissions <object-type> <id> [--full] [--profile <name>]`

No `--fields`: the default rows have exactly two keys (`principal`,
`permissions`), so there's nothing meaningful to select between, and any
richer field (e.g. `inherited`) only exists under `--full`, which would make
`--fields` validity depend on another flag. `--full` is the disclosure axis
here; `--fields` was dropped rather than documented as a quirk.

## Object-type allow-list

```
jobs, clusters, pipelines, warehouses, dashboards
```

This is a deliberately small allow-list, not the full 28-entry upstream
enum (`permissions get --help`'s docstring lists 24; the live invalid-type
error lists 28 — the error enum is the source of truth, since it's what the
server actually accepts). A type is in the allow-list iff (a) an existing
axi command already prints its id and (b) a well-formed-but-missing id of
that type classifies as `NOT_FOUND` upstream (i.e. the server says
`"<type> <id> does not exist"`-shaped text, not a raw format-error leak).

Ids come from: `jobs list` → `job_id`, `clusters list` → `cluster_id`,
`pipelines list` → `pipeline_id`, `sql warehouses` → `id`, `dashboards
list` → `dashboard_id`.

**Why `serving-endpoints` is absent.** `permissions get serving-endpoints`
rejects the endpoint _name_ and wants an internal id that
`serving-endpoints get` never returns (no top-level `id` field on a
foundation-model endpoint) — there is no id an agent can obtain through the
CLI at all, so this type fails condition (a) structurally.

**Why `dashboards` and not `dbsql-dashboards`.** Both are valid upstream
enum values with no disambiguation in `--help`. `dashboards` is the correct
type for AI/BI (Lakeview) dashboards — the same 32-hex Lakeview id fed to
`dbsql-dashboards` returns `Error: dbsql-dashboards/<id> is not a valid
object`. `dbsql-dashboards` is the legacy DBSQL dashboard surface, a
different id space this release doesn't cover at all (no axi command
prints its ids) — reachable via `api get
/api/2.0/permissions/dbsql-dashboards/<id>` if ever needed.

Everything else not in the five (`alerts`, `apps`, `experiments`,
`notebooks`, `repos`, `serving-endpoints`, … 23 total) routes to `api get
/api/2.0/permissions/<type>/<id>` — the exit-2 message on a rejected type
names the five plus this escape line; the 28-entry upstream enum dump never
reaches an agent, and neither does the raw Java `For input string: "…"`
leak some of those types produce on a malformed id.

`<id>` is validated only for a non-empty leading-dash guard (`/^[^-]/`) —
no per-type id-shape table. Upstream's own `"<x> does not exist"` is
already the right message for a well-formed-but-missing id; a shape table
for five different id formats would be code nobody needs.

## Upstream call

`databricks permissions get <type> <id>` — both positional, no flags at
all beyond the globals. No pagination, no `--limit`.

## Output shape

Hand-built envelope (documented `listResult` exemption — `permissions get`
has no `--limit`/pagination, so there's no full-page state to report and
`listResult`'s `rows.length >= limit` heuristic has nothing to key on):

```
{ object_type, object_id, permissions: rows, count, help }
```

`object_type`/`object_id` are echoed **from the response**, not
reconstructed from the input — see the surprising dashboard case below.

- Default row, one per principal: `{ principal, permissions }` —
  `principal` = `user_name ?? group_name ?? service_principal_name`,
  `permissions` = comma-joined `permission_level`s (e.g. `"CAN_MANAGE,
CAN_RUN"`).
- `--full` row, one per (principal, level): `{ principal, type, level,
inherited, inherited_from }` — `type` is `user`/`group`/
  `service_principal`; `inherited_from` is `inherited_from_object.join(",
")` (empty when the grant is direct, not inherited).
- Empty `access_control_list` (or absent): `permissions: []`, a definitive
  `status: "no access control entries visible on <type> <id>"`, help
  pointing at `--full` and `doctor` (the caller may simply lack
  `CAN_MANAGE`, which is a distinct case from a 403 — see Errors).
- Non-empty help: a `--full` suggestion, plus (for `dashboards` only) a
  `dashboards view <id>` suggestion.

## The `permissions dashboards` id-space surprise

`permissions get dashboards <32-hex Lakeview id>` works, but the response
echoes an `object_id` that is **not** the id you passed in:

```json
{
  "object_id": "/dashboards/570857400383840",
  "object_type": "dashboard"
}
```

Upstream silently resolves the 32-hex Lakeview id to a numeric legacy
workspace-object id and echoes that instead. axi echoes the response's own
`object_id`/`object_type` verbatim — that's the honest report of what
upstream actually resolved — but an agent (or a human) reading it should
not mistake `570857400383840` for a typo of the id it passed, and should
never try to feed that numeric id back into `dashboards view` (it's a
different id space entirely). This command is the _only_ place an agent
can get that numeric id from the CLI at all; there's no reverse lookup.

A brand-new dashboard's ACL is typically entirely inherited from its parent
directory (no direct entries) — `--full` is the informative mode there.

## Errors

- Routes through `runWithNotFoundHelp`, folding a bare `NOT_FOUND` into the
  matching list-command suggestion from the allow-list table above.
- A malformed id (not missing, wrong shape) gets a type-specific format
  error from upstream that stays `UPSTREAM_ERROR` (e.g. `Error:
0000-000000-bogus99 is not a valid endpoint id.`) — honest, and the
  `NOT_FOUND` help already points at the list command that prints real
  ids for the well-formed-but-missing case.
- `PERMISSION_DENIED` on a 403 uses the existing shared branch
  (`\b403\b|PERMISSION_DENIED`) — **not live-observed** for this endpoint
  (see the AGENTS.md standing watch item); fixtures pin both plausible
  shapes so a future real 403 string matching neither surfaces as a real
  gap, not a silent regression.

## Sharp edges

- Never redact a principal in a success row: `redactSecrets` would destroy
  both an email principal and a 44-char `_workspace_users_workspace_…`
  group id. Grant/ACL principals are data, like `query_text` or `fs cat`
  content — only error/log text is a redaction surface.

## Tests

`test/permissions.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers
exact argv, compact vs. `--full` row rendering, the live dashboard
id-space surprise (asserting the echoed `object_id` is upstream's numeric
value, not the 32-hex input), the `service_principal_name` fallthrough,
the object-type allow-list (rejecting `experiments`, `serving-endpoints`,
`dbsql-dashboards`, and a flag-shaped type, each with no stub call), the
dropped `--fields` flag (asserting `Unknown option`, not a silent no-op),
each live per-type `NOT_FOUND` string mapped to its list-command help, a
malformed-id format error staying `UPSTREAM_ERROR`, the empty
`access_control_list` state, an unredacted-principal leak test, and both
403 fixture shapes.

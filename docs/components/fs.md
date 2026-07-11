# fs

Source: `src/commands/fs.ts`. Tests: `test/fs.test.ts`.

Read-only DBFS/Volumes file access: directory listing and file content.

## Subcommands

From `FS_HELP`:

- `fs ls <path> [--limit N] [--fields a,b]`
- `fs cat <path> [--full]`

Both accept `--profile <name>`. Both require exactly one path positional
rejecting a leading `-`.

## Upstream calls

- `ls` → `databricks fs ls <scoped-path> --absolute -l`. The `fs` group has
  **no** upstream `--limit` and no pagination at all — it always returns
  everything in one shot, so any capping here is entirely client-side
  (`items.slice(0, limit)`).
- `cat` → `databricks fs cat <scoped-path>`, run in `raw: true` mode (see
  `src/databricks.ts`): no `-o json`, no `JSON.parse`, no int64 id
  quoting — file content is data, not a structured response.

`withScheme()` prepends `dbfs:` to any bare absolute path (one starting
with `/` and no existing scheme prefix) before it reaches argv, since a
bare absolute path (`/Volumes/...`, `/databricks-datasets/...`) would
otherwise read the _local_ filesystem upstream, not DBFS (live-verified).
An already-scoped path (e.g. `dbfs:/...`) passes through unchanged.
`parentDbfsDir()` is a scheme-aware `parentPath` so `dbfs:/nope`'s parent
is `dbfs:/`, not the bare `"dbfs:"` that naive string-splitting would
produce.

## Output shape

- `ls`: **not** routed through `listResult` — this is the domain's one
  deliberate exemption. Because upstream returns the true full list with
  no `--limit` of its own, the code knows the _exact_ total
  (`items.length`) and reports precise truncation
  (`showing N of TOTAL entries — rerun with --limit TOTAL`) instead of the
  usual `has_more: true` heuristic every other list domain uses.
  Default fields: `name`, `is_directory`, `size` (human-readable, via
  `humanSize()`, applied before `renderRows` so `--fields size` also picks
  up the formatted string — there's no separate raw-byte field).
- `cat`: `path`, `size` (`Buffer.byteLength` of the decoded text — exact
  for text, approximate for binary since binary content is never
  rendered anyway), `content` (head-truncated at 200 lines, clamped at
  100k chars, unless `--full`). Binary content (via `looksBinary`) renders
  as a `<binary, N bytes — not rendered>` note instead.

## Errors

- Both subcommands route through `runWithNotFoundHelp`, suggesting
  `fs ls <parent-dir>` on NOT_FOUND.
- `mapUpstreamError` has a dedicated branch for "Public DBFS root is
  disabled" (a Free Edition platform restriction, not a missing object) —
  it maps to `PERMISSION_DENIED` with a hint toward
  `dbfs:/databricks-datasets` or a `/Volumes/<catalog>/<schema>/<volume>`
  path instead.

## Sharp edges

- `fs ls` is the deliberate exception to `listResult`: it reports exact
  truncation, not `has_more`, because upstream has no server-side limit at
  all to be capped by.
- `fs cat`'s raw mode streams stdout and SIGKILLs the child once it exceeds
  a 5MB cap (`TOO_LARGE`), since file content is unbounded and must never
  be buffered whole in memory.
- `fs cat` output is deliberately never redacted — matches the `sql` rule
  that only error/log text is a redaction surface, not arbitrary file
  content.
- Bare absolute paths need the `dbfs:` prefix; `workspace` paths (a
  different domain) need no such prefix.

## Tests

`test/fs.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers the
`dbfs:` auto-prefix vs. already-scoped passthrough, bare-array tolerance,
the exact client-side truncation message (not `has_more`), the disabled
public-DBFS-root PERMISSION_DENIED mapping, leading-dash rejection,
`--fields` selection, `--profile` threading, raw-mode `cat` (asserting
`-o json` is skipped), binary/NUL-byte detection, 200-line head truncation
with `--full`, char-clamp truncation on a low-newline file, and an
unknown-flag rejection.

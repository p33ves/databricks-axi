# workspace

Source: `src/commands/workspace.ts`. Tests: `test/workspace.test.ts`.

Read-only browsing and viewing of Databricks Workspace objects (notebooks,
directories, files stored in the workspace tree, not DBFS/Volumes).

## Subcommands

From `WORKSPACE_HELP`:

- `workspace ls [path] [--limit N] [--fields a,b]`
- `workspace view <path> [--full]`

Both accept `--profile <name>`. `ls` takes at most one positional path
(defaults to `/`); a path starting with `-` is rejected as a usage error.
`view` requires exactly one path, also rejecting a leading `-`.

## Upstream calls

- `ls` → `databricks workspace list <path> --limit N`
- `view` → `databricks workspace export <path> --format SOURCE`. Always
  `--format SOURCE`; there is no separate `get-status` call for language or
  size — both come from the export payload itself (base64 `content` +
  `file_type`).

## Output shape

- `ls`: `listResult` envelope, default fields `path`, `object_type`,
  `language`. `help` includes a `workspace view <path>` suggestion for the
  first `NOTEBOOK` entry found and a `workspace ls <path>` suggestion for
  the first `DIRECTORY` entry found.
- `view`: decodes `content` from base64.
  - A directory path exports as a ZIP archive upstream (SOURCE/DBC/AUTO
    all support directory export). Detected by checking the full local
    file-header/end-of-central-directory magic bytes (`PK\x03` or `PK\x05`
    at offset 0), not just a `"PK"` prefix (which a source file's own text
    could coincidentally start with). Rendered as an exit-0 note
    (`<directory archive — use workspace ls <path>>`), not file content and
    not an error.
  - Binary content (detected via `looksBinary`) renders as a
    `<binary, N bytes — not rendered>` note.
  - Otherwise: `path`, `language` (mapped from `file_type` via
    `LANGUAGE_BY_EXT`, e.g. `py` → `PYTHON`, else the upper-cased raw
    `file_type`), `size`, `content` (head-truncated at 200 lines and
    clamped at 100k chars via `src/truncate.ts`, unless `--full`).
    `truncated` reports whichever bound actually fired (char clamp vs.
    line count).

## Errors

- Both subcommands route through `runWithNotFoundHelp`: `ls` failures
  suggest `workspace ls` (root); `view` failures suggest
  `workspace ls <parent>`.
- `view` derefs the export payload via `assertObject`.
- The invalid-upstream-JSON error path (`databricks.ts`) never echoes any
  stdout snippet, redacted or not — stdout here can carry exported file
  content.

## Sharp edges

- `NOT_FOUND` matching covers both "does not exist" and the workspace
  CLI's own contraction "doesn't exist".
- Directory export-as-ZIP is a deliberate exit-0 note, not an error —
  don't treat it as a failure case when reasoning about this command.
- Head-truncation is 200 lines **and** a 100k-char clamp; a minified
  one-liner would blow past a line-only limit, hence the char clamp.
- This domain is read-only by design: no import/mkdirs/rm — writes go
  through bundles or the workspace UI.

## Tests

`test/workspace.test.ts` uses `setupCli()`/`fake-databricks.ts` plus a
local `b64()` helper to build base64 export payloads. Covers bare-array
tolerance, `has_more` pagination, the "doesn't exist" NOT_FOUND mapping,
leading-dash/extra-positional rejection, `--fields` selection, `--profile`
threading into both argv and suggestions, 200-line head truncation with and
without `--full`, ZIP-archive-as-note rendering, binary-content detection,
and an unknown-flag rejection.

# api

Source: `src/commands/api.ts`. Tests: `test/api.test.ts`.

Raw REST passthrough over the `databricks` CLI's own `api` subcommand —
the escape hatch for endpoints no domain command covers yet.

## Subcommand

- `api <method> <path> [--body <json>] [--profile <name>]`

`method` must be one of `get, post, put, patch, delete, head` (case-
insensitive). `path` must start with `/api/`. `--body` accepts either an
inline JSON string (validated with `JSON.parse` before spawning — an
invalid inline body is rejected without ever spawning the CLI) or an
`@path/to/file.json` reference, which is passed through unvalidated.

## Upstream calls

- `runDatabricksApi(method, path, body, opts)` →
  `databricks api <method> <path> [--json <body-or-@path>]`. An inline
  (non-`@`) body is never placed on child argv: `runDatabricksApi` writes
  it to a private 0600 temp file and passes `--json @<tempfile>`, deleting
  the file after the call. A body already given as `@path` (user-supplied
  file reference) passes through untouched, matching the `api` command's
  own documented file-passthrough behavior.

## Output shape

No reshaping happens here — this is the one command in the CLI that
doesn't editorialize the response. A JSON object response is returned
as-is; a non-object response (array, string, number, null) is wrapped as
`{ response: parsed }` purely so TOON has a key to hang it on. Responses
over 1MB (`MAX_RENDER_BYTES`, measured in UTF-8 bytes via
`Buffer.byteLength`, not JS string length) are not rendered at all —
instead a `truncated` note reports the byte count and suggests narrowing
the request.

## Errors

- Usage errors: missing method/path, extra positionals, unknown method,
  a path not starting with `/api/`, or invalid inline JSON — all rejected
  before any spawn happens.
- Beyond that, errors flow through the same `mapUpstreamError` taxonomy as
  every other domain (via `runDatabricksApi` → `runDatabricks`); this
  command adds no domain-specific error mapping of its own.

## Sharp edges

- Prefer the domain commands (`jobs`, `sql`, ...) when one exists — `api`
  is explicitly the fallback, not the default.
- Never send secret values through `api`: responses land on stdout
  unredacted (this command does no redaction of its own), so an endpoint
  that echoes a secret would leak it verbatim.
- The 1MB render cap is a hard cutoff on the JSON-stringified response
  size, not a truncation of content within it — a response just over the
  cap gets no data at all, only the byte count.

## Tests

`test/api.test.ts` uses `setupCli()`/`fake-databricks.ts`. Covers a GET
passthrough rendered as TOON, an inline `--body` going through a temp file
never visible on argv, `@file` bodies passing through without JSON
validation, `--profile` threading as `-p`, rejection of an unknown method
or a non-`/api/` path (asserting no spawn happens), rejection of invalid
inline JSON, wrapping a non-object response, and the 1MB truncation
including a UTF-8-byte-accurate (not UTF-16-length) count.

# whoami

Source: `src/commands/whoami.ts`. Tests: `test/whoami.test.ts`.

Top-level verb, not a domain: wraps upstream `databricks current-user me`,
the caller's own SCIM identity. No subcommands, no mutation, no admin SCIM
surface (users/groups/service-principals stay out of scope, per the
roadmap).

## Surface

`databricks-axi whoami [--profile <name>]`

## Upstream call

`databricks current-user me` → SCIM Me:
`userName`, `displayName` (may be absent), `active`, `groups[]` (each:
`display`, `type` direct|indirect, `value` id, `$ref`), `entitlements[]`
(each `{ value }`), `emails[]`, `id`, `schemas`.

## Output shape

Single-object view — no `--fields` (house convention: the object is ~8
keys, every useful one already ships in the default). Hand-enumerated,
snake_case keys, a deliberate rename off SCIM's camelCase:

- `user_name` (from `userName`)
- `display_name` (from `displayName`) — omitted entirely when absent
- `active`
- `groups` — rendered as `{display, type}` rows; `value`/`$ref` (ids)
  dropped
- `entitlements` — flattened from `[{ value }]` to plain value strings
- `help` — suggests `home`, `--profile`-suffixed when the caller passed one

`id`, `emails`, and `schemas` are omitted; the rare caller wanting full SCIM
uses `api get /api/2.0/preview/scim/v2/Me`.

## Errors

Standard `mapUpstreamError` path via `runDatabricks` — no command-specific
NOT_FOUND shape (SCIM Me cannot 404 for an authenticated caller). Auth
failures classify as `AUTH_ERROR`. Any positional argument is a usage
error (exit 2).

## Tests

`test/whoami.test.ts` covers exact argv both without and with `--profile`
(profile precedes args, per `src/databricks.ts`), default rendering,
absent-`display_name` omission, positional rejection, unknown-flag
rejection, and `AUTH_ERROR` passthrough without leaking the token in the
error text.

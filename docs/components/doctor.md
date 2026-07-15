# doctor

Source: `src/commands/doctor.ts` (assembly/rendering) + `src/context.ts`
(`fetchAuthContext`/`fetchRecentRuns`/`fetchWarehouses`/`fetchClusters`,
see `core.md`) + `src/databricks.ts` (`probeCli`). Tests:
`test/doctor.test.ts` (command level), `test/databricks.test.ts`
(`probeCli` unit tests).

Spec:
`docs/superpowers/specs/2026-07-15-databricks-axi-1.1.0-doctor-design.md`.

Top-level verb, not a domain: a deterministic preflight health check in
place of agent-skills' `commands/doctor.md` slash-command prompt (several
raw-CLI turns, hand-formatted table). ~90% reuse over `home`, `whoami`,
and the version guard.

## Surface

`databricks-axi doctor [--profile <name>] [--full]`

## Upstream calls

All spawns fire in one `Promise.allSettled` batch, each with the same 4s
`PANEL_TIMEOUT_MS` override `home` uses:

- `databricks -v` (via `probeCli` in `src/databricks.ts`) — `cli` check.
- `databricks auth describe -o json` (`fetchAuthContext`) — `profile` check,
  shared with the `auth` check's account-host classification (fired once,
  never twice, even under `--full`).
- `databricks current-user me -o json` (a local `fetchMe`, same shape
  `whoami` uses) — `auth` check.
- `--full` only: `databricks jobs list-runs --limit 5`, `databricks
warehouses list`, `databricks clusters list` (unfiltered — see below).

## Output shape

```
checks[n]{check,status,detail}:
  cli,<PASS|WARN|FAIL>,<detail>
  profile,<PASS|FAIL>,<detail>
  auth,<PASS|FAIL|INFO>,<detail>
  warehouse,WARN,<detail>        # --full only, prediction
  compute,INFO,<detail>          # --full only, prediction
overall: healthy|warn|fail
code: <TAXONOMY_CODE>            # omitted when no coded check fired
help[n]: <best next action>
warehouses: [...]                # --full only, or "unavailable (<reason>)"
running_clusters: [...]          # --full only, non-TERMINATED rows, omitted at zero
recent_runs: [...]               # --full only, or "unavailable (<reason>)"
```

Each rendered check row is trimmed to exactly `{check, status, detail}` —
the `code`/`help` an internal check object carries stay out of the
rendered row (only used to compute the top-level `code`/`help`), otherwise
TOON would render `checks[]` as a per-row block instead of a compact grid
the moment one row has an extra key.

### `cli`

From `probeCli(timeoutMs)` (`src/databricks.ts`, called with
`PANEL_TIMEOUT_MS` so its budget matches every other probe):
`{found, version?, ok?}`. `!found` → FAIL `CLI_MISSING` (install URL
help). `found` with no parseable version → WARN `"version unknown"`,
code `CLI_VERSION_UNKNOWN` (a targeted "run `databricks -v`" help line —
distinct from a definitely-too-old version, since we can't tell if an
unparseable output is actually old). `found` + `version` + `ok` → PASS
`v<raw>`. `found` + `version` + `!ok` → WARN `CLI_TOO_OLD` (upgrade URL
help). `.raw` is normalized to always show exactly one leading `v`
(upstream `-v` output sometimes includes it, sometimes doesn't).

### `profile` / `auth` — §6 account-host carve-out

Both come from the same `fetchAuthContext` + `fetchMe` (current-user me)
pair, classified after both settle (§6 Decision 3). A rejected probe's own
`AxiError` code drives its FAIL row (`errorDetail` in `doctor.ts`) — a
TIMEOUT/UPSTREAM_ERROR/PERMISSION_DENIED rejection is never relabeled
`AUTH_ERROR` just because it happened on an auth probe; `AUTH_ERROR` is
only the fallback for a non-`AxiError` reason:

- `auth describe` **rejected** — no host to classify, so the carve-out
  never applies. `profile` FAILs with that rejection's own code (typically
  `AUTH_ERROR` for "cannot configure default credentials", but `TIMEOUT`/
  `UPSTREAM_ERROR` etc. render and select correctly too); `auth` FAILs too
  (from the current-user-me rejection, which fires blind regardless of
  host — its own code, not necessarily the same one as `profile`'s).
- `auth describe` fulfilled, host anchored `/^https?:\/\/accounts\./` —
  account-level console. `profile` PASSes with the host/profile/auth_type.
  `auth` is INFO ("account-level host — validated via auth describe
  (<auth_type>); current-user me not applicable") even if `current-user
me` rejected (expected there, not a failure).
- `auth describe` fulfilled, host NOT account-level — normal workspace.
  `profile` PASSes. `auth` PASSes (`<user> active`) or FAILs (that
  rejection's own code — `AUTH_ERROR` with sub-typed help from
  `mapUpstreamError` for a real auth failure, `TIMEOUT`/`UPSTREAM_ERROR`
  otherwise) depending on `current-user me`.

The anchored regex is deliberate: a host merely containing "accounts" as
a non-first label (e.g. `my-accounts.cloud.databricks.com`) must NOT trip
the carve-out.

### `warehouse` / `compute` predictions (`--full` only)

- **`warehouse`** (§5.2): from the `warehouses` panel. No `RUNNING` row
  **and at least one warehouse exists** → WARN with a `sql warehouses
start <id>` suggestion (a concrete id, never a placeholder). Any
  `RUNNING` row, a degraded panel, or a zero-length list → no row (an
  empty list is not itself a fault, and there'd be no real id to name).
- **`compute`** (§5.1, the serverless-only correction): from one
  **unfiltered** `fetchClusters` call — never the filtered
  `fetchRunningClusters` `home` uses, since an empty _filtered_ list can't
  distinguish "nothing running" from "no classic clusters exist at all".
  Definite three-outcome rule over the unfiltered rows:
  - zero rows → INFO "serverless-only workspace (no classic clusters
    exist)".
  - ≥1 non-TERMINATED row → the `running_clusters` panel renders those
    rows; no `compute` row (the panel is the signal).
  - all rows TERMINATED → INFO "`<n>` classic cluster(s), all stopped —
    `clusters start <id>`" (a concrete id from the list).
  - the panel rejected/timed out → no `compute` row at all (never a false
    prediction).

## `code`/`help` selection — fixed fix-order (§4.1)

`overall` is `fail` if any check is FAIL, else `warn` if any is WARN, else
`healthy`. The top-level `code`/`help` name the single check to fix first,
by a **fixed order, FAIL tier strictly ahead of WARN tier** — a WARN is
never selected while any FAIL exists:

- FAIL tier: `CLI_MISSING` → `AUTH_ERROR` → `PERMISSION_DENIED`/
  `UPSTREAM_ERROR`/`TIMEOUT` (first match wins — reachable now that
  `profile`/`auth` FAIL rows carry their rejection's real code instead of
  a hardcoded `AUTH_ERROR`).
- WARN tier (only when no FAIL exists): a coded `cli` WARN (`CLI_TOO_OLD`
  or `CLI_VERSION_UNKNOWN`) → `warehouse` WARN (no code) → otherwise the
  first WARN's help, uncoded (`compute` never emits WARN — INFO-only).

So an old CLI (WARN `CLI_TOO_OLD`) plus a failed auth (FAIL `AUTH_ERROR`)
always yields `overall: fail`, `code: AUTH_ERROR` — never `CLI_TOO_OLD`.
A prediction-only WARN (`warehouse`) carries no top-level `code` (only
taxonomy-mapped errors get one); `help` is still the prediction's action.

## Errors

doctor never throws for a failed check — the entire handler body runs on
`Promise.allSettled` results; every probe rejection is caught and rendered
as a check row or an `unavailable(...)` panel line. **doctor always exits
0** except for a usage error (positional argument or unknown flag →
`VALIDATION_ERROR`, exit 2, before any probe fires). Unlike `home`, doctor
never swaps its whole body for a bare structured error on an `AUTH_ERROR`
— the `checks[]` table _is_ the diagnostic output, so `profile`/`auth`
just render as FAIL rows and the top-level `code`/`help` still surface.

## Codes emitted

| Code                                               | Tier | Check                                                                  |
| -------------------------------------------------- | ---- | ---------------------------------------------------------------------- |
| `CLI_MISSING`                                      | FAIL | `cli` (not found on PATH)                                              |
| `AUTH_ERROR`                                       | FAIL | `profile` / `auth` (real auth failure, or the non-`AxiError` fallback) |
| `PERMISSION_DENIED` / `UPSTREAM_ERROR` / `TIMEOUT` | FAIL | `profile` / `auth` (whatever the rejection's own `AxiError` code is)   |
| `CLI_TOO_OLD`                                      | WARN | `cli` (found, version below 0.298)                                     |
| `CLI_VERSION_UNKNOWN`                              | WARN | `cli` (found, `-v` output unparseable)                                 |
| _(none)_                                           | WARN | `warehouse` prediction (no taxonomy code)                              |
| _(none)_                                           | INFO | `auth` (account-level host), `compute` (serverless-only / all-stopped) |

## Sharp edges

- `current-user me` fires in parallel unconditionally, even for an
  account-level host — classification happens only after both auth probes
  settle, never gating the spawn itself.
- No new upstream surface: every call here is already issued by `home` or
  `whoami`. `auth describe` fires exactly once even under `--full` (shared
  between the `profile` check and, in this implementation, is not
  re-fetched for any panel).
- Never passes `--sensitive` to `auth describe` (would put a token on
  stdout) — inherited from `fetchAuthContext`.
- `probeCli` reuses the module-private `spawnCollect` and a shared
  `parseVersion` helper (also used by `detectVersion`) in `databricks.ts`,
  and the same `MIN_MINOR_VERSION` floor, but does NOT replace
  `detectVersion` — the `runDatabricks` failure-path guard
  (`diagnoseFailure`) is untouched.
- No separate `--full` "context panel" off `auth describe` — the
  `profile` check row is the sole surface for host/profile/auth_type
  (dropped from the spec at review; see the spec's Decision 2 note).

## Tests

`test/doctor.test.ts`: exact argv per probe (including the version probe
never receiving `-p <profile>`), base-mode exactly renders `cli`/`profile`/
`auth` with no workspace calls beyond auth/current-user, the §4.1
precedence worked example (old CLI WARN + failed auth FAIL →
`AUTH_ERROR`, never `CLI_TOO_OLD`), a TIMEOUT on the auth probe rendering
and selecting `TIMEOUT` rather than a hardcoded `AUTH_ERROR`, the
unparseable-version WARN carrying `CLI_VERSION_UNKNOWN`, the account-host
carve-out (including the non-first-label negative case), the
auth-describe-rejected double-FAIL sharing one code, the serverless-only
three-outcome rule (empty / all-TERMINATED / has-running), the
RUNNING-warehouse WARN (including the zero-warehouse case emitting no row
and no placeholder `<id>`), a degraded `--full` panel producing an
`unavailable` line with no false prediction, the always-exit-0 invariant
under an all-probes-reject sweep, and dispatch-level usage errors.
`test/databricks.test.ts` unit-tests `probeCli` directly: ENOENT,
new-enough version, too-old version, and an unparseable `-v` output.

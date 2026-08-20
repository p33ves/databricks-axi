# bundle

Source: `src/commands/bundle.ts`. Tests: `test/bundle.test.ts`. Shared-core
support: `runDatabricksCaptured`/`CapturedResult` in `src/databricks.ts` (see
`core.md`), and the exported `CONFLICT` regex from `src/commands/pipelines.ts`.

Declarative Automation Bundles (DABs): `validate`, `plan`, `summary`,
`deploy`, `run`, `destroy`. Design spec:
`docs/superpowers/specs/2026-08-16-databricks-axi-1.4.0-bundle-design.md`
(gitignored, local-only — not in the shipped repo).

Two properties make this domain unlike every other one:

- **cwd-scoped, no id.** The CLI resolves `databricks.yml` upward from the
  working directory; axi never parses the file itself and spawns with the
  inherited cwd. There is no `--dir` flag (YAGNI, and it would fight
  upstream's own model).
- **Diagnostics are a first-class output channel**, on stderr, separate from
  the payload on stdout. `validate`/`plan`/`summary` all need both streams at
  once (a payload can coexist with warnings, even on a nonzero exit), which
  is why this domain needed a shared-core addition.

## Shared-core addition: `runDatabricksCaptured`

`runDatabricks` throws on any nonzero exit and discards stdout — the wrong
shape for a command whose diagnostics and payload can both be present
simultaneously. `runDatabricksCaptured(args, opts)` (a second named export,
not a widened return type on `runDatabricks`) returns
`{ exitCode, stdout, stderr, stderrTruncated }` verbatim — no `JSON.parse`,
no int64 id-quoting — and never throws on a nonzero exit code. Both
functions delegate to one shared internal (`runGuarded`) for the
ENOENT/TIMEOUT/TOO_LARGE guard ladder, so it exists exactly once and can't
drift between entry points. `runDatabricksCaptured` still throws
`CLI_TOO_OLD` on a nonzero exit whose stderr looks like an unknown-flag
failure — a pre-0.298 CLI's "unknown flag" text must not be handed to the
diagnostic parser as if it were a bundle config problem. `stderrTruncated`
is set once stderr crosses the shared 64KB capture cap (`STDERR_CAP_BYTES`);
`bundle deploy`/`destroy` surface it as a `truncated:` note in the error
help rather than silently dropping the tail.

## Not reused, deliberately

- **`listResult`** — `bundle summary`/`plan` are the sixth and seventh
  documented exemptions (see `core.md`'s table): no `--limit`-shaped
  surface, every resource in the bundle is returned (bounded by the file on
  disk, not workspace size).
- **`--total`** — meaningless without pagination.
- **`runWithNotFoundHelp`** for validate/plan/summary — bundle's
  not-found/not-deployed cases are structural (no `id` in the payload), not
  upstream `NOT_FOUND` codes. `bundle run`'s dispatch to `jobs run-now`/
  `pipelines start-update` does use `runWithNotFoundHelp`, same as those two
  domains.
- **The `api` escape hatch** — bundles are a client-side CLI construct, no
  `/api/2.x/bundles` REST surface exists. Help says so plainly; the escape
  hatch here is raw `databricks bundle`, not `databricks-axi api`.

## Shared guards

- **Not-in-a-bundle** (`checkNotInBundle`): a bundle-local regex catch on
  `Error: unable to locate bundle root: databricks.yml not found`, never
  folded into the shared `mapUpstreamError` (a shared regex there would risk
  reclassifying unrelated cwd-context failures in other domains). Rethrown
  as `VALIDATION_ERROR`, exit 2. Checked on every subcommand that spawns
  (`validate`, `plan`, `summary`/`run` via `fetchBundleSummary`, `deploy`,
  `destroy`).
- **`--var` guards** (`scanVarGuards`, on `validate` and `deploy` — the two
  upstream signatures that document `[--var k=v]`): a raw-argv scan, before
  `parseArgs` ever runs. A comma in a `--var` value is real silent data
  loss upstream (`--var "a=1,b=2"` exits 0 having silently set two
  variables) — rejected with `VALIDATION_ERROR`, no spawn. A repeated
  `--var` is also rejected — `parseArgs` in strict mode silently keeps only
  the last occurrence rather than throwing, so the count comes from an
  explicit occurrence scan (matching both `--var value` and `--var=value`
  forms) rather than relying on `parseArgs`. Single `--var k=v` forwards as
  one upstream `--var=k=v`. Repeatable `--var` is deferred (raw
  `databricks ... --var a --var b`, or `BUNDLE_VAR_<name>`, cover the rest).
- **`bundle run`'s `--` guard** (`rejectDoubleDash`): upstream `bundle run --
<cmd>` executes an arbitrary local command with the bundle's Databricks
  credentials injected into its environment — a credential-bearing
  arbitrary-command executor. axi never spawns `bundle run` at all (see
  below), so this is defense in depth, but it stays: agents type
  `-- --param v` reflexively (it's in upstream's own `--help`), and node's
  `parseArgs` silently swallows a bare trailing `--`
  (`["x","--"] -> ["x"]`), so the check has to run on the raw argv before
  `parseArgs` ever sees it. `bundle run` also requires exactly one
  positional (the resource key) not starting with `-`.

## `validate [--strict] [--full] [--target <name>] [--var k=v]`

Upstream: `bundle validate -o json [-t target] [--var k=v]`, via
`runDatabricksCaptured`, 60s. `--strict` never reaches upstream argv (C4):
forwarding it would inject a synthetic `Error: N warnings were found.
Warnings are not allowed in strict mode` into the diagnostics, making
`errors: N` a lie about the bundle's actual config. Instead `valid` is
computed client-side from the parsed counts (`errors > 0 || (strict &&
warnings > 0)`); warnings keep `severity: "Warning"` under `--strict` — axi
never manufactures a severity it didn't read.

**Always exits 0 when it produces a verdict** (doctor precedent, D3):
severity lives in the payload (`valid`), never the exit code.

### Diagnostic parser

Bundle-local (not hoisted to `errors.ts` — the block shape is unique to this
domain's stderr channel), ~15 lines. Splits stderr on the line-start
boundary `/^(?:Error|Warning|Recommendation): /m`; each entry is
`{ severity, message, at? }` (field is `message`, not `summary` — it
collides with the sibling subcommand). `at` comes from an indented `  at
<config.path>` continuation line; unmatched lines (the logger's own `Warn:
[hostmetadata] …`) are dropped, not counted. Every message goes through
`redactSecrets`. Zero boundary matches on non-empty stderr means the shape
wasn't recognized at all — falls back to `{ diagnostics: [], parse_failed:
true, raw_stderr: <redacted, tail-truncated> }` with `valid` derived from
the exit code in that branch only, never inventing a severity. Diagnostics
are capped at 10, errors sorted first, with a `truncated` note when
clipped; `--full` returns every diagnostic and the raw resolved `config`.

### Classification order (on a nonzero exit)

1. `checkNotInBundle` first — structural, `VALIDATION_ERROR` exit 2.
2. Parse diagnostics. A parse failure renders the degraded fallback above
   (still exit 0).
3. Otherwise, the first `Error`-severity diagnostic is classified via
   `mapUpstreamError`. `AUTH_ERROR`/`PERMISSION_DENIED` are thrown as-is
   (exit 1) — genuine operational failures, not a config verdict.
4. A first-Error message matching `no such target. Available targets:`
   (upstream's own malformed-target-selector text, which carries its own
   recovery info) is thrown as `UPSTREAM_ERROR` verbatim — the response in
   this case is the _unresolved_ config tree (no `workspace`, no expanded
   `resources`), so building the normal digest from it would be misleading
   rather than a real "config errors" verdict.
5. Anything else (a real config validation `Error`, e.g. an undefined
   required variable) falls through to the normal digest: `valid: false`,
   the diagnostics array, exit 0.

### Digest fields

`bundle`/`target`/`mode` from the resolved config's `bundle.{name,target,
mode}`; `user` from `workspace.current_user.userName` (one scalar out of
the full SCIM blob — the object itself, and `workspace.host` (which doesn't
exist even with auth fully resolved) are never rendered); `root_path` from
`workspace.root_path`. `workspace` is read with optional chaining, not
`assertObject` — the whole object is absent when auth fails. `resources`
rows carry `{type, count, keys}` (keys capped at 20 per type, `+N more`
suffix) — exactly what `bundle run <key>` takes. `config_bytes` is the byte
length of the raw stdout payload, in the default digest, so an agent can
price `--full` before spending it (the resolved config is otherwise
unbounded by bundle size).

## `plan [--select <type>.<name>] [--full] [--fields a,b] [--target <name>]`

Upstream: `bundle plan -o json [-t target] [--select r]`, via
`runDatabricksCaptured`, 60s. The best read-only surface in the domain — it
answers "what will deploy actually change?" without changing anything.

On a nonzero exit: `checkNotInBundle` first, then throw
`mapUpstreamError(stderr)` unconditionally (no diagnostic-block parsing for
plan — the `--select is only supported with the direct engine` rejection on
terraform-engine bundles (C9) passes through this way as a normal
`UPSTREAM_ERROR`, deliberately not pre-empted by a client-side engine
check).

### Key form (C1)

Upstream's plan map key is `resources.<type>.<name>`, but `--select` parses
with `strings.Cut(selector, ".")` and only matches `<type>.<name>` — the
`resources.` prefix is rejected (`no such resource: resources.jobs.my_job`).
Rows emit the qualified `<type>.<name>` form (the prefix stripped), so a key
printed by `plan` can be pasted straight into `--select`.

### Row filtering and `nested` (C3)

The plan map can contain child entries (e.g.
`resources.jobs.my_job.permissions`) that aren't addressable via `--select`
at all. `resources` rows are filtered to 3-segment keys only; `actions`
tallies only those rows. Upstream's own summary line counts children too,
so a separate `nested` field carries the child-entry count, making the
reconciliation explicit rather than leaving the numbers silently
disagreeing.

### `changed_fields` (not `id`)

Plan entries carry no `id` at all, even when updating an already-deployed
resource. Each row instead carries `changed_fields`: the field paths from
the entry's `changes` map whose sub-action is not `skip` — free (the data
is already in hand from the plan response) and high-signal, since a real
diff is typically mostly `skip` noise (inherited defaults). `--full` carries
the whole `changes` map (including skips) plus `new_state`/`remote_state`.

### Other rendering rules

`skip`-action rows are excluded by default (the no-change majority), still
counted in `actions`; `--full` includes them. `recreate`/`delete` counts
greater than zero add a `warning:` line — the data-losing actions, so the
`deploy --yes` gate is predictable rather than a surprise. An empty/all-skip
addressable set renders `status: "no changes for target <t>"`, exit 0 — not
an error. An all-`create` plan (never-deployed bundle) is a normal plan,
not an error (C2, live-confirmed). `plan_version` is rendered only when
present — terraform-engine bundles omit it entirely, never defaulted to 2
(which would misreport the engine). `plan_bytes` is in the default digest,
same rationale as validate's `config_bytes`.

## `summary [--force-pull] [--full] [--fields a,b] [--target <name>]`

Upstream: `bundle summary -o json [-t target] [--force-pull]`, via
`runDatabricksCaptured`, 60s. `fetchBundleSummary` (shared with `run`'s
resolution step) parses the whole redacted bundle config and flattens
`resources.<type>.<key>` into rows: `{type, key, name, id, url,
modified_status}` (`--full` adds `modified_status`; `--fields` selects over
all six).

**Not-yet-deployed (C2) is detected structurally**: no resource carries an
`id` → `status: "no deployment for target <t>"`, exit 0, no message regex
anywhere (confirmed live: `bundle summary` on a never-deployed bundle exits
0 with the config tree and no `id`/`url` fields). `id` arrives as a JSON
**string** already (live-verified) — the int64 2^53 hazard doesn't apply,
and `runDatabricksCaptured` returns raw stdout so `runDatabricks`'s
id-quoting regex never runs either; it is not "restored" here. Hand-built
`{resources, count, config_bytes, help}` envelope, no `listResult`.

## `deploy [--yes] [--full] [--target <name>] [--var k=v] [--force-lock]`

Upstream: `bundle deploy [-t target] [--var k=v] [--auto-approve]
[--force-lock]`, via `runDatabricksCaptured` in raw mode, 600s
(`DEPLOY_TIMEOUT_MS`). Stdout is 0 bytes on both success and failure in
`-o json` mode; all progress is on stderr.

- Success → `{status: "deployed", target, help}`.
- Failure → a structured `UPSTREAM_ERROR` built from the `capture` result
  directly (never from `mapUpstreamError`, which returns only the first
  line and would drop the failure an agent needs to debug a DAB deploy):
  the redacted tail of `stdout + "\n" + stderr`, last 50 lines
  (`truncate(mode:"tail")`, same tail length as `jobs logs`), `--full` for
  everything. `stderrTruncated` (past the shared 64KB capture cap) adds its
  own help note.
- The interactive-approval refusal (`stdin: 'ignore'` means it can never
  actually prompt, so it fails loud instead of hanging) is detected by a
  `requires destructive actions` regex on stderr and gets dedicated help:
  `bundle deploy --yes` and `bundle plan` (which shows exactly which
  resources are `recreate`/`delete`).
- `--yes` maps to upstream `--auto-approve`, **never** `--force` (a
  Git-branch-validation override, an unrelated flag the pre-1.4.0 draft
  conflated) — `--force` never appears on argv regardless of `--yes`.
- `--force-lock` forwards only when explicitly passed — overriding a lock
  held by a live deployment is exactly the conflict upstream warns about.
- `timeoutHelp` carries two lines: check state with `bundle summary`, and
  the `--force-lock` note (scoped: `mode: development` targets disable the
  deployment lock entirely, live-confirmed — the stale-lock hazard is a
  non-dev-target concern, and most agent work happens on dev).

The 600s timeout is not "deploys are typically slow" — our timeout is a
hard `SIGKILL` and upstream has no deferred unlock on signal death, so a
timed-out deploy leaves an unknown partial apply _and_ a stale deployment
lock blocking every retry (C8).

## `run <resource_key> [--wait] [--target <name>]`

**Never spawns `databricks bundle run`** — the strongest possible form of
the `--` guard above. `--no-wait` prints nothing upstream and the blocking
form carries no run id, so there's nothing to parse from it anyway; not
spawning it also closes the credential-bearing local-exec hazard entirely.

1. `bundle summary` resolves `<resource_key>` to `{type, id}` (`bundle
summary`'s `id` is the real Jobs/Pipelines API id, live-confirmed).
2. `jobs` type → `["jobs", "run-now", id, "--no-wait"]` (`--wait` drops
   `--no-wait` and widens the timeout to `WAIT_TIMEOUT_MS`) →
   `{run_id, state?}`. `id` is already a string from summary; passed
   through verbatim.
3. `pipelines` type → `["pipelines", "start-update", id]` →
   `{update_id}`, including the existing "an active update already exists"
   → exit-0 no-op conversion (the `CONFLICT` regex exported from
   `pipelines.ts` — the only piece of that module reused here; `jobsRun`/
   `pipelinesStart` stay private, `bundle.ts` builds the two argvs itself
   rather than widening either domain's public surface for one caller).
4. Any other type (`apps`, …) → `VALIDATION_ERROR`, exit 2, naming raw
   `databricks bundle run <key>`. There is no apps domain.
5. Key present but no `id` (C7, the not-yet-deployed case) → a definitive
   error steering to `bundle deploy` — `jobs run-now`/`pipelines
start-update` is never called with an empty id.
6. Unknown key → `NOT_FOUND` listing the valid keys straight from the
   summary already fetched — one upstream call total, no extra round trip.

Output: `{resource, type, id, run_id | update_id, state?, help}`.

## `destroy --yes [--target <name>] [--force-lock]`

**The only intentionally destructive verb in the axi surface** — permanently
deletes every resource _and workspace file_ this bundle deployed to the
target. Not undoable.

- Without `--yes`: `VALIDATION_ERROR`, exit 2, **no spawn**. Upstream's own
  refusal text (also seen only when `--yes` is passed but the real
  `--auto-approve` still isn't set — not reachable through axi, since axi's
  own gate fires first) carries an AgentNotice telling agents not to
  auto-retry with the flag unless the user has explicitly approved it.
  Since axi's gate means an agent would never see that upstream text, axi's
  own gate message carries the equivalent warning itself (its own wording,
  not a mirror of a string that can drift upstream).
- With `--yes`: forwards `--auto-approve` (plus `--force-lock` if passed).
  Success → `{status: "destroyed", target}` (stdout is 0 bytes). Failure →
  the same redacted-tail error shape as `deploy`, without a `--full` escape
  (destroy's failure surface is smaller in practice; not exposed here).
- Same 600s timeout and stale-lock `timeoutHelp` rationale as `deploy`.

## Errors

Taxonomy codes actually emitted: `VALIDATION_ERROR` (not-in-a-bundle, the
`--var`/`--`/positional guards, `destroy` without `--yes`, an unsupported
`bundle run` resource type, a not-yet-deployed `bundle run` target),
`AUTH_ERROR`/`PERMISSION_DENIED` (a first-Error validate diagnostic, or any
plan/summary/deploy/destroy failure, that classifies that way),
`UPSTREAM_ERROR` (validate's unknown-target case; any other plan/summary
failure; deploy/destroy failures, redacted-tail wrapped), `NOT_FOUND` (an
unknown `bundle run` key, or a `jobs`/`pipelines` NOT_FOUND folded through
`runWithNotFoundHelp`).

## Tests

`test/bundle.test.ts` uses `setupCli()`/`fake-databricks.ts`'s
`respondWith` (added for this domain — the only helper that can seed
stdout AND stderr AND a nonzero exit together, the exact shape every
validate/plan/deploy fixture needs). Covers: the exact argv per subcommand
including `--target`/`--profile`/`--var` threading; the §0b.1 regression
(the real `Error` renders, not the first `Warning`, at exit 0); `--strict`
computed client-side and absent from argv; the unknown-target and
not-in-a-bundle special cases; the diagnostic parse-failure fallback; the
logger-line drop; missing-`workspace` no-crash; the 10-diagnostic cap and
`--full` escape; C1's key-form transform; C3's nested-count reconciliation;
C2's structural not-deployed detection on both `plan` (all-create) and
`summary`; `changed_fields` filtering a real 11-entry `changes` map down to
two; the terraform-engine `plan_version`-omission and `--select` rejection
passthrough (C9); deploy's 0-byte-stdout success shape, redacted 50-line
tail with `--full` unbounding it, `>64KB` `stderrTruncated` note, the
approval-required help, and `--force` never appearing on argv; `run`'s
jobs/pipelines dispatch, the C7 no-id steer with zero mutation calls, the
non-jobs/pipelines type rejection, the unknown-key `NOT_FOUND` with one
upstream call total, and the four `--`/extra-positional guard rejections
(`calls()` empty in every case); `destroy`'s gate message and `--auto-approve`
forwarding. `test/databricks.test.ts` covers `runDatabricksCaptured`
directly: nonzero-exit-returns-object, ENOENT/TIMEOUT/TOO_LARGE/CLI_TOO_OLD
still throwing, `-o json` still appended without `raw`, and the
`stderrTruncated` cap.

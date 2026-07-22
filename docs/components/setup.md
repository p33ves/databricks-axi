# setup

Source: `src/commands/setup.ts`. Tests: `test/setup.test.ts`.

Installs session-start ambient-context hooks (so `home` renders
automatically at the start of an agent session) for Claude Code, Codex, and
OpenCode.

## Subcommand

- `setup hooks` — the only subcommand; no flags (in particular, no
  `--agent` selector). An unknown subcommand, a bare `setup` invocation, or
  any positional/flag on `hooks` is a usage error.

## How it works

`setupCommand` delegates entirely to `installSessionStartHooks()` from
`axi-sdk-js` — this file never hand-rolls per-agent JSON/TOML editing.
Before calling it, eligibility is pre-checked with the SDK's own exported
`shouldInstallHooksForNodeAxiExecPath`, using an explicit policy object
(`marker: "databricks-axi"`, `binaryNames: ["databricks-axi"]`,
`distEntrypoints: ["dist/bin/databricks-axi.js"]`) passed to both the
eligibility check and the install call, so behavior is deterministic
instead of relying on the SDK's own path-shape inference from
`process.argv[1]`.

Targets written (four paths, always all of them):

- `~/.claude/settings.json`
- `~/.codex/hooks.json`
- `~/.codex/config.toml`
- `~/.config/opencode/plugins/axi-databricks-axi.js`

## Output shape

- Success: `{ paths: [...four paths...], status: "hooks installed or
already up to date" }`.
- Ineligible entrypoint: `{ status: "not installed: unrecognized
entrypoint", help: [...] }` — never a false "installed" result.
- npx cache entrypoint: `{ status: "not installed: npx cache
entrypoint", help: [...] }` — see Sharp edges.

## Errors

- `installSessionStartHooks` collects per-target failures via an
  `onError` callback rather than throwing per-target. If any target
  failed, `setupHooks()` throws a single `UPSTREAM_ERROR` aggregating all
  failure messages, with a help line noting that other targets may
  already have been written and are **not rolled back**. One concrete
  failure mode: a hand-written (not axi-managed) OpenCode plugin file at
  the target path — the SDK refuses to overwrite it rather than clobber
  unrelated user content, and that refusal surfaces through `onError`.

## Sharp edges

- Installs for all three agents unconditionally — there is no `--agent`
  selector (a human-confirmed dropped decision, referenced in the source
  as "C3").
- `npx -y databricks-axi setup hooks` is refused. The exec path is written
  verbatim into all four hook configs, and npm's `_npx` cache path is
  pinned to whatever version was current at setup time and can be pruned
  out from under the hooks. The check is a `_npx` path segment, tested
  before the eligibility check because an npx path otherwise matches
  `dist/bin/databricks-axi.js` and would install silently. Install
  globally (`npm i -g databricks-axi`) first.
- Eligibility is checked against a real packaged entrypoint. `pnpm run dev`
  (`tsx bin/databricks-axi.ts`) always fails the check, since the `.ts`
  dev entrypoint can't match `dist/bin/databricks-axi.js` or the bin-name
  pattern — build and run `dist/bin/databricks-axi.js` (or do a real
  install) to test hook installation for real.
- Writes are not rolled back if a later target fails; the error message
  lists every failing target so the caller knows what's still
  inconsistent.

## Tests

`test/setup.test.ts` uses `main()` directly (not the `setupCli()` rig,
since there's no `databricks` spawn here) plus its own
`beforeEach`/`afterEach` that redirect `HOME` to a fresh temp directory
(`mkdtempSync`) so hook files are never written to the real developer
home. It also pins `process.argv[1]` to a fake
`/fake/project/dist/bin/databricks-axi.js` string so the eligibility check
passes under vitest — no test builds and runs the real
`dist/bin/databricks-axi.js`, so the "eligible, real packaged binary"
path is verified structurally (the path-matching logic), not via an
actual install. Covers writing all four targets and reporting their
paths, idempotent re-runs being byte-stable, aggregating an `onError`
from an unmanaged OpenCode plugin (the SDK's actual refusal message:
"refusing to overwrite unmanaged OpenCode plugin") into one exit-1 error
without rolling back other targets, reporting non-installation (not false
success) on an unrecognized entrypoint, rejecting a `--agent` flag, and
dispatch-level usage errors.

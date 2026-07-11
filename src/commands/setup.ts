import { homedir } from "node:os";
import {
  AxiError,
  installSessionStartHooks,
  shouldInstallHooksForNodeAxiExecPath,
} from "axi-sdk-js";
import { domainHelpers, type AxiRenderable } from "./shared.js";

const { usage, parseArgs } = domainHelpers("setup");

// The marker `installSessionStartHooks` uses to (a) tag managed config it
// writes and (b) infer install eligibility from `process.argv[1]` — only a
// packaged `dist/bin/databricks-axi.js` entrypoint, or a bin literally named
// `databricks-axi`, matches. Passed explicitly here (along with
// binaryNames/distEntrypoints below) so eligibility is deterministic instead
// of relying on the SDK's path-shape inference, and so setupHooks() can
// pre-check it with the same values before claiming success (kk:code-review
// P2: don't report "installed" when nothing was eligible to install — e.g.
// the `.ts` dev entrypoint via `pnpm run dev`, or a vitest/tsx argv0).
const MARKER = "databricks-axi";
const BINARY_NAMES = [MARKER];
const DIST_ENTRYPOINTS = [`dist/bin/${MARKER}.js`];

export const SETUP_HELP = `usage: databricks-axi setup <subcommand>
subcommands[1]:
  hooks   install session-start ambient-context hooks for Claude Code, Codex, OpenCode
examples:
  databricks-axi setup hooks
notes:
  installs for all three agents unconditionally — no --agent selector
  idempotent and path-repairing; already-installed targets are left as-is
  writes are not rolled back if a later target fails — errors list every failing target
`;

export async function setupCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  if (sub !== "hooks") {
    throw usage(
      sub ? `Unknown setup subcommand: ${sub}` : "setup requires a subcommand",
    );
  }
  // No flags at all here — in particular no --agent selector (dropped,
  // human-confirmed decision C3): installSessionStartHooks writes all three
  // agents unconditionally. Route through the shared parser anyway so an
  // unknown flag gets the standard usage-error wording instead of a
  // hand-rolled check.
  const { positional } = parseArgs(rest, {});
  if (positional.length > 0) {
    throw usage(`setup hooks takes no arguments, got: ${positional[0]}`);
  }
  return setupHooks();
}

function setupHooks(): AxiRenderable {
  const home = homedir();
  const execPath = process.argv[1] ?? "";
  const policy = {
    marker: MARKER,
    binaryNames: BINARY_NAMES,
    distEntrypoints: DIST_ENTRYPOINTS,
  };
  if (!shouldInstallHooksForNodeAxiExecPath(execPath, policy)) {
    return {
      status: "not installed: unrecognized entrypoint",
      help: [
        "run the installed databricks-axi binary directly, not via a dev/test harness",
      ],
    };
  }
  const errors: string[] = [];
  installSessionStartHooks({
    homeDir: home,
    execPath,
    ...policy,
    onError: (message) => errors.push(message),
  });
  const paths = [
    `${home}/.claude/settings.json`,
    `${home}/.codex/hooks.json`,
    `${home}/.codex/config.toml`,
    `${home}/.config/opencode/plugins/axi-${MARKER}.js`,
  ];
  if (errors.length > 0) {
    // installSessionStartHooks does not roll back targets it already wrote
    // before a later one failed — say so whenever more than one target was
    // attempted (four here, always).
    throw new AxiError(
      `Failed to install hooks for ${errors.length} of ${paths.length} targets`,
      "UPSTREAM_ERROR",
      [
        ...errors,
        "Other targets may already have been written — not rolled back",
      ],
    );
  }
  return {
    paths,
    status: "hooks installed or already up to date",
  };
}

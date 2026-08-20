// Declarative Automation Bundles (DABs). Two properties make this domain
// unlike every prior one: it's cwd-scoped (no id; the "object" is the
// project on disk — axi never parses databricks.yml itself, and there is no
// --dir flag, YAGNI), and diagnostics are a first-class output channel on
// stderr, separate from the payload on stdout. See
// docs/superpowers/specs/2026-08-16-databricks-axi-1.4.0-bundle-design.md.
import { AxiError } from "axi-sdk-js";
import { runDatabricksCaptured, type CapturedResult } from "../databricks.js";
import { mapUpstreamError, redactSecrets } from "../errors.js";
import { truncate } from "../truncate.js";
import { CONFLICT } from "./pipelines.js";
import {
  assertObject,
  domainHelpers,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  WAIT_TIMEOUT_MS,
  type AxiRenderable,
  type AxiStructuredOutput,
  type Flags,
} from "./shared.js";

const { usage, parseArgs, renderRows } = domainHelpers("bundle");

export const BUNDLE_HELP = `usage: databricks-axi bundle <subcommand> [args] [flags]
subcommands[6]:
  validate [--strict] [--full] [--target <name>] [--var k=v]
  plan [--select <type>.<name>] [--full] [--fields a,b] [--target <name>]
  summary [--force-pull] [--full] [--fields a,b] [--target <name>]
  deploy [--yes] [--full] [--target <name>] [--var k=v] [--force-lock]
  run <resource_key> [--wait] [--target <name>]
  destroy --yes [--full] [--target <name>] [--force-lock]
flags:
  --profile <name>  databricks auth profile passthrough
  --target <name>   bundle target (upstream -t), e.g. dev/prod
examples:
  databricks-axi bundle validate
  databricks-axi bundle plan --target dev
  databricks-axi bundle deploy --yes --target dev
  databricks-axi bundle run probe_job --target dev
notes:
  cwd-scoped: resolves databricks.yml upward from the working directory,
  same as upstream — there is no --dir flag
  validate/plan always exit 0 when they produce a verdict (severity lives in
  the payload, never the exit code) — don't branch on $? alone, check "valid"
  run never spawns \`databricks bundle run\`: it resolves <resource_key> via
  \`bundle summary\` and delegates to \`jobs run-now\`/\`pipelines start-update\`.
  Upstream's \`bundle run -- <cmd>\` executes arbitrary local commands with the
  bundle's credentials injected into the environment — axi rejects \`--\` and
  any extra positional before parsing flags, even though it never reaches
  that code path
  destroy permanently deletes every resource this bundle deployed, including
  workspace files, and is not undoable — --yes only after explicit user
  approval, never retried automatically on your own initiative
  no REST API for bundles: the escape hatch is raw \`databricks bundle\`, not
  \`databricks-axi api\`
  plan/--select keys use the "<type>.<name>" form (e.g. jobs.my_job) —
  upstream's own map key ("resources.<type>.<name>") is rejected by --select
  terraform-engine bundles: plan omits plan_version and --select is rejected
  upstream (direct engine only)
`;

// --- shared guards & helpers ---

const NOT_IN_BUNDLE =
  /unable to locate bundle root: databricks\.yml not found/i;

/** Structural, bundle-local catch — never folded into the shared
 * mapUpstreamError (a shared regex there would risk reclassifying other
 * cwd-context failures in other domains). */
function checkNotInBundle(stderr: string): void {
  if (NOT_IN_BUNDLE.test(stderr)) {
    throw usage("not inside a bundle: databricks.yml not found", [
      "Run from a directory containing databricks.yml, or a subdirectory of one",
    ]);
  }
}

/** Pre-parse raw-argv scan for the two --var hazards (C5/C6). Both close
 * silent data loss: a comma in a --var value is real data loss upstream
 * (exits 0 having silently set two variables), and node's parseArgs in
 * strict mode silently keeps only the last of a repeated --var — it never
 * throws — so the count has to come from an explicit occurrence scan, run
 * before parseArgs ever sees the args. */
function scanVarGuards(args: string[]): void {
  let count = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let pair: string | undefined;
    if (arg === "--var") {
      pair = args[i + 1];
      count++;
    } else if (arg.startsWith("--var=")) {
      pair = arg.slice("--var=".length);
      count++;
    } else {
      continue;
    }
    if (typeof pair === "string" && pair.includes(",")) {
      const key = pair.slice(0, pair.indexOf("="));
      throw usage(
        `--var value for "${key}" contains a comma — upstream silently splits it into multiple variable assignments`,
        [
          "Pass raw `databricks bundle ... --var a=1 --var b=2` (repeatable, comma-free) instead",
          "Or set the BUNDLE_VAR_<name> environment variable, which takes the value verbatim with no splitting",
        ],
      );
    }
  }
  if (count > 1) {
    throw usage(
      "--var passed more than once — only the last occurrence would silently apply",
      [
        "Pass raw `databricks bundle ... --var a=1 --var b=2` for multiple variables",
      ],
    );
  }
}

/** BUNDLE_VAR_<name> env delivery for --var (C5/F1): never lands on child
 * argv, which /proc/<pid>/cmdline would expose for the whole 600s a deploy
 * can run. `varFlag` is the "key=value" pair; scanVarGuards has already
 * rejected a comma in it. */
function bundleVarEnv(varFlag: string): Record<string, string> {
  const eq = varFlag.indexOf("=");
  const key = eq === -1 ? varFlag : varFlag.slice(0, eq);
  const value = eq === -1 ? "" : varFlag.slice(eq + 1);
  return { [`BUNDLE_VAR_${key}`]: value };
}

// The credential-bearing local-exec hazard (§4.6): a bare trailing `--`
// makes upstream `bundle run` execute an arbitrary local command with the
// bundle's Databricks credentials injected into its environment. axi never
// spawns `bundle run` at all (§4.5), but the guard stays as defense in
// depth — agents type `-- --param v` reflexively (it's in upstream's own
// --help) and silently dropping those args would run the wrong job
// parameters. node's parseArgs silently swallows a bare trailing `--`
// (`["x","--"] -> ["x"]`), so this has to run on the raw argv, first.
function rejectDoubleDash(args: string[]): void {
  if (args.includes("--")) {
    throw usage(
      "bundle run does not accept `--` or extra arguments after the resource key",
      [
        "axi never spawns `databricks bundle run` — see `databricks-axi bundle --help`",
        "Usage: databricks-axi bundle run <resource_key> [--wait]",
      ],
    );
  }
}

function targetSuffix(target: unknown): string {
  return typeof target === "string" ? ` --target ${target}` : "";
}

function targetArgv(target: unknown): string[] {
  return typeof target === "string" ? ["-t", target] : [];
}

const TAIL_LINES = 50;

/** Shared stale-lock timeoutHelp for deploy/destroy (both spawn with the
 * same DEPLOY_TIMEOUT_MS hard SIGKILL and leave the same stale-lock
 * hazard, C8). */
function staleLockTimeoutHelp(tf: string, p: string): string[] {
  return [
    `databricks-axi bundle summary${tf}${p}`,
    "If a retry reports the deploy lock held, pass --force-lock only if you know the other deployment isn't active (mode: development targets disable the lock entirely)",
  ];
}

/** Shared deploy/destroy failure renderer: the redacted tail of stderr
 * (stdout is 0 bytes in practice in `-o json` mode), same tail length as
 * `jobs logs`. Built from the `capture` result directly — never from
 * `mapUpstreamError`, which returns only the first line and would drop the
 * failure an agent actually needs to debug a DAB deploy. `help` is the
 * per-caller portion (composed at the call site); this only adds the
 * shared `--full`/`stderrTruncated` notes. */
function deployFailure(
  label: string,
  captured: CapturedResult,
  full: boolean,
  tf: string,
  p: string,
  help: string[],
): AxiError {
  const redacted = redactSecrets(captured.stderr);
  const t = full
    ? { text: redacted, truncated: false }
    : truncate(redacted, { lines: TAIL_LINES, mode: "tail" });
  const allHelp = [...help];
  if (t.truncated) {
    allHelp.unshift(`databricks-axi ${label} --full${tf}${p}`);
  }
  if (captured.stderrTruncated) {
    allHelp.push(
      "stderr exceeded the 64KB capture cap — some diagnostic output may be missing",
    );
  }
  return new AxiError(
    `${label} failed (exit ${captured.exitCode}):\n${t.text}`,
    "UPSTREAM_ERROR",
    allHelp,
  );
}

function parseJsonObject(stdout: string): AxiStructuredOutput {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as AxiStructuredOutput)
      : {};
  } catch {
    return {};
  }
}

// --- validate ---

type Diagnostic = {
  severity: "Error" | "Warning" | "Recommendation";
  message: string;
  at?: string;
};

const SEVERITY_ORDER: Diagnostic["severity"][] = [
  "Error",
  "Warning",
  "Recommendation",
];

// Severity prefixes are exactly these three (src: libs/diag) — a
// `Warn: [hostmetadata] …` line comes from the logger, not the diag
// system, and is dropped (not counted) rather than misparsed.
const DIAG_BOUNDARY = /(?=^(?:Error|Warning|Recommendation): )/m;
const DIAG_HEAD = /^(Error|Warning|Recommendation): ([\s\S]*)/;

/** ~15-line bundle-local diagnostic-block parser (kept local, not hoisted
 * to errors.ts — the whole point is that this shape is unique to bundle
 * validate/plan/summary's stderr channel). Splits on the severity-prefixed
 * line boundary; each entry's `at`/`in` come from indented continuation
 * lines. Zero boundary matches on non-empty stderr means the shape wasn't
 * recognized at all — the caller falls back to `parse_failed: true` rather
 * than inventing a severity. */
function parseDiagnostics(stderr: string): {
  diagnostics: Diagnostic[];
  parseFailed: boolean;
} {
  const trimmed = stderr.trim();
  if (!trimmed) {
    return { diagnostics: [], parseFailed: false };
  }
  const diagnostics: Diagnostic[] = [];
  for (const block of trimmed.split(DIAG_BOUNDARY)) {
    const match = DIAG_HEAD.exec(block.trim());
    if (!match) {
      continue;
    }
    const [, severity, rest] = match;
    const lines = rest.split("\n");
    const message = redactSecrets(lines[0].trim());
    const diag: Diagnostic = {
      severity: severity as Diagnostic["severity"],
      message,
    };
    for (const line of lines.slice(1)) {
      const atMatch = /^\s*at (.+)/.exec(line);
      if (atMatch) {
        diag.at = redactSecrets(atMatch[1].trim());
      }
    }
    diagnostics.push(diag);
  }
  return { diagnostics, parseFailed: diagnostics.length === 0 };
}

// A malformed target selector, not a config-validity verdict — upstream
// resolves the target before it can even attempt validation, so the
// digest's usual "config errors -> valid:false" payload would be
// misleading here (the config it returns is the raw, unresolved tree).
// It carries its own recovery info ("Available targets: ..."), so axi
// surfaces the whole first Error: line verbatim as a thrown UPSTREAM_ERROR.
const NO_SUCH_TARGET = /no such target\.\s*Available targets:/i;

const DIAGNOSTICS_CAP = 10;

async function bundleValidate(args: string[]): Promise<AxiRenderable> {
  scanVarGuards(args);
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    target: "value",
    strict: "boolean",
    full: "boolean",
    var: "value",
  });
  if (positional.length > 0) {
    throw usage(`bundle validate takes no arguments, got: ${positional[0]}`);
  }
  const strict = flags.get("strict") === true;
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  const argv = ["bundle", "validate", ...targetArgv(target)];
  const varFlag = flags.get("var");
  const varEnv =
    typeof varFlag === "string" ? bundleVarEnv(varFlag) : undefined;
  // --strict never reaches upstream argv (C4): forwarding it would inject a
  // synthetic top-level "N warnings were found" Error that has no config
  // problem behind it, making `errors: 1` a lie. `valid` is computed
  // client-side instead, from the real parsed counts.
  const captured = await runDatabricksCaptured(argv, {
    ...spawnOpts(flags),
    ...(varEnv ? { env: varEnv } : {}),
    timeoutMs: 60_000,
    timeoutHelp: [`Rerun — validate is read-only and idempotent`],
  });

  if (captured.exitCode !== 0) {
    checkNotInBundle(captured.stderr);
  }
  const { diagnostics: allDiagnostics, parseFailed } = parseDiagnostics(
    captured.stderr,
  );
  if (!parseFailed && captured.exitCode !== 0) {
    const firstError = allDiagnostics.find((d) => d.severity === "Error");
    if (firstError) {
      const classified = mapUpstreamError(firstError.message);
      if (
        classified.code === "AUTH_ERROR" ||
        classified.code === "PERMISSION_DENIED"
      ) {
        throw classified;
      }
      if (NO_SUCH_TARGET.test(firstError.message)) {
        throw new AxiError(`Error: ${firstError.message}`, "UPSTREAM_ERROR");
      }
    }
  }
  if (parseFailed) {
    return {
      diagnostics: [],
      parse_failed: true,
      raw_stderr: truncate(redactSecrets(captured.stderr), {
        lines: TAIL_LINES,
        mode: "tail",
      }).text,
      valid: captured.exitCode === 0,
      help: [`databricks-axi bundle validate${tf}${p}`],
    };
  }

  const config = parseJsonObject(captured.stdout);
  const bundleCfg = (config.bundle ?? {}) as AxiStructuredOutput;
  const workspaceCfg = config.workspace as AxiStructuredOutput | undefined;
  const user = workspaceCfg?.current_user as AxiStructuredOutput | undefined;
  const resourcesCfg = (config.resources ?? {}) as Record<
    string,
    Record<string, unknown>
  >;

  const errors = allDiagnostics.filter((d) => d.severity === "Error").length;
  const warnings = allDiagnostics.filter(
    (d) => d.severity === "Warning",
  ).length;
  const valid = errors === 0 && !(strict && warnings > 0);

  const resourceRows = Object.entries(resourcesCfg).map(([type, byKey]) => {
    const keys = Object.keys(byKey ?? {});
    const shown = keys.slice(0, 20);
    const more = keys.length > 20 ? ` +${keys.length - 20} more` : "";
    return { type, count: keys.length, keys: `${shown.join(",")}${more}` };
  });

  const sorted = [...allDiagnostics].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
  );
  const project = (d: Diagnostic) => ({
    severity: d.severity,
    message: d.message,
    at: d.at ?? "",
  });

  const out: AxiStructuredOutput = {};
  if (typeof bundleCfg.name === "string") {
    out.bundle = bundleCfg.name;
  }
  const targetName =
    typeof bundleCfg.target === "string" ? bundleCfg.target : target;
  if (typeof targetName === "string") {
    out.target = targetName;
  }
  if (typeof bundleCfg.mode === "string") {
    out.mode = bundleCfg.mode;
  }
  // workspace is read with optional chaining, not assertObject — the whole
  // object is absent when auth fails.
  if (typeof user?.userName === "string") {
    out.user = user.userName;
  }
  if (typeof workspaceCfg?.root_path === "string") {
    out.root_path = workspaceCfg.root_path;
  }
  out.valid = valid;
  out.errors = errors;
  out.warnings = warnings;
  out.config_bytes = Buffer.byteLength(captured.stdout, "utf8");
  out.resources = resourceRows;
  out.diagnostics = (full ? sorted : sorted.slice(0, DIAGNOSTICS_CAP)).map(
    project,
  );
  if (!full && sorted.length > DIAGNOSTICS_CAP) {
    out.truncated = `showing ${DIAGNOSTICS_CAP} of ${sorted.length} diagnostics — rerun with --full`;
  }
  if (full) {
    out.config = config;
  }
  out.help = [`databricks-axi bundle plan${tf}${p}`];
  return out;
}

// --- plan ---

type PlanChange = { action?: string };
type PlanEntry = {
  action?: string;
  changes?: Record<string, PlanChange>;
  new_state?: unknown;
  remote_state?: unknown;
} & Record<string, unknown>;

const PLAN_ACTIONS = [
  "create",
  "update",
  "recreate",
  "delete",
  "skip",
] as const;

async function bundlePlan(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    target: "value",
    select: "value",
    full: "boolean",
    fields: "value",
  });
  if (positional.length > 0) {
    throw usage(`bundle plan takes no arguments, got: ${positional[0]}`);
  }
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  const argv = ["bundle", "plan", ...targetArgv(target)];
  const select = flags.get("select");
  if (typeof select === "string") {
    // Terraform-engine bundles reject --select outright ("--select is only
    // supported with the direct engine") — let it pass through as a normal
    // UPSTREAM_ERROR rather than pre-empting it with a client-side engine
    // check we'd have to keep in sync (C9).
    argv.push("--select", select);
  }
  const captured = await runDatabricksCaptured(argv, {
    ...spawnOpts(flags),
    timeoutMs: 60_000,
    timeoutHelp: [`Rerun — plan is read-only and idempotent`],
  });

  if (captured.exitCode !== 0) {
    checkNotInBundle(captured.stderr);
    throw mapUpstreamError(captured.stderr);
  }

  const parsed = parseJsonObject(captured.stdout);
  const planMap = (parsed.plan ?? {}) as Record<string, PlanEntry>;
  const entries = Object.entries(planMap);
  // Addressable rows are 3-segment keys only (resources.<type>.<name>) —
  // child entries like resources.jobs.my_job.permissions aren't selectable
  // via --select at all (C3).
  const addressable = entries.filter(([key]) => key.split(".").length === 3);
  const nested = entries.length - addressable.length;

  const actionCounts: Record<string, number> = {};
  for (const action of PLAN_ACTIONS) {
    actionCounts[action] = 0;
  }
  for (const [, entry] of addressable) {
    const action = typeof entry.action === "string" ? entry.action : "skip";
    actionCounts[action] = (actionCounts[action] ?? 0) + 1;
  }

  const rows = addressable
    .filter(([, entry]) => full || (entry.action ?? "skip") !== "skip")
    .map(([key, entry]) => {
      const shortKey = key.replace(/^resources\./, ""); // C1: upstream's own key is rejected by --select
      const changedFields = Object.entries(entry.changes ?? {})
        .filter(([, change]) => change.action !== "skip")
        .map(([field]) => field);
      const row: AxiStructuredOutput = {
        key: shortKey,
        action: entry.action ?? "skip",
        changed_fields: changedFields.join(","),
      };
      if (full) {
        row.changes = entry.changes ?? {};
        if (entry.new_state !== undefined) {
          row.new_state = entry.new_state;
        }
        if (entry.remote_state !== undefined) {
          row.remote_state = entry.remote_state;
        }
      }
      return row;
    });

  const out: AxiStructuredOutput = {};
  if (typeof target === "string") {
    out.target = target;
  }
  // Terraform-engine bundles have no plan_version at all — render it only
  // when present, never default it (that would misreport the engine, C9).
  if (typeof parsed.plan_version === "number") {
    out.plan_version = parsed.plan_version;
  }
  out.actions = actionCounts;
  out.nested = nested;
  const fields = full
    ? [
        "key",
        "action",
        "changed_fields",
        "changes",
        "new_state",
        "remote_state",
      ]
    : ["key", "action", "changed_fields"];
  const selected = renderRows(rows, flags, fields);
  out.resources = selected;
  out.count = selected.length;
  out.plan_bytes = Buffer.byteLength(captured.stdout, "utf8");
  if (actionCounts.recreate > 0 || actionCounts.delete > 0) {
    out.warning = `plan includes ${actionCounts.recreate} recreate + ${actionCounts.delete} delete action(s) — data-losing; review before deploy`;
  }
  const nonSkip = addressable.length - actionCounts.skip;
  if (addressable.length === 0 || nonSkip === 0) {
    out.status = `no changes for target ${typeof target === "string" ? target : "default"}`;
  }
  const help = [`databricks-axi bundle deploy${tf}${p}`];
  if (!full && rows.length < addressable.length) {
    help.push(`databricks-axi bundle plan --full${tf}${p}`);
  }
  out.help = help;
  return out;
}

// --- summary ---

type SummaryRow = {
  type: string;
  key: string;
  name?: string;
  id?: string;
  url?: string;
  modified_status?: string;
};

async function fetchBundleSummary(
  flags: Flags,
): Promise<{ captured: CapturedResult; rows: SummaryRow[] }> {
  const target = flags.get("target");
  const argv = ["bundle", "summary", ...targetArgv(target)];
  if (flags.get("force-pull") === true) {
    argv.push("--force-pull");
  }
  const captured = await runDatabricksCaptured(argv, {
    ...spawnOpts(flags),
    timeoutMs: 60_000,
    timeoutHelp: [`Rerun — summary is read-only and idempotent`],
  });
  if (captured.exitCode !== 0) {
    checkNotInBundle(captured.stderr);
    throw mapUpstreamError(captured.stderr);
  }
  const parsed = parseJsonObject(captured.stdout);
  const resourcesCfg = (parsed.resources ?? {}) as Record<
    string,
    Record<string, AxiStructuredOutput>
  >;
  const rows: SummaryRow[] = [];
  for (const [type, byKey] of Object.entries(resourcesCfg)) {
    for (const [key, res] of Object.entries(byKey ?? {})) {
      rows.push({
        type,
        key,
        name: typeof res.name === "string" ? res.name : undefined,
        // id arrives as a JSON string already (live-verified) — the int64
        // 2^53 hazard doesn't apply, and capture mode returns raw stdout so
        // runDatabricks's id-quoting regex never runs either. Passed
        // through verbatim; never "restored" through that regex here.
        id: typeof res.id === "string" ? res.id : undefined,
        url: typeof res.url === "string" ? res.url : undefined,
        modified_status:
          typeof res.modified_status === "string"
            ? res.modified_status
            : undefined,
      });
    }
  }
  return { captured, rows };
}

async function bundleSummary(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    target: "value",
    "force-pull": "boolean",
    full: "boolean",
    fields: "value",
  });
  if (positional.length > 0) {
    throw usage(`bundle summary takes no arguments, got: ${positional[0]}`);
  }
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  const { captured, rows } = await fetchBundleSummary(flags);
  const configBytes = Buffer.byteLength(captured.stdout, "utf8");
  // Not-deployed detection (C2) is structural — no resource carries an id —
  // never a message regex. Confirmed live: summary exits 0 with the config
  // tree and no id/url fields on a never-deployed bundle.
  if (rows.length === 0 || !rows.some((r) => r.id)) {
    return {
      status: `no deployment for target ${typeof target === "string" ? target : "default"}`,
      config_bytes: configBytes,
      help: [`databricks-axi bundle deploy${tf}${p}`],
    };
  }

  const fields = full
    ? ["type", "key", "name", "id", "url", "modified_status"]
    : ["type", "key", "name", "id", "url"];
  const selected = renderRows(rows, flags, fields);
  return {
    resources: selected,
    count: selected.length,
    config_bytes: configBytes,
    help: [`databricks-axi bundle run <resource_key>${tf}${p}`],
  };
}

// --- deploy ---

// Our own hard SIGKILL timeout has no deferred unlock on signal death — a
// timed-out deploy/destroy leaves an unknown partial apply and a stale
// deployment lock blocking every retry (C8). 600s is the constant, not a
// statement that deploys are typically slow.
const DEPLOY_TIMEOUT_MS = 600_000;

const APPROVAL_REQUIRED = /requires destructive actions/i;

async function bundleDeploy(args: string[]): Promise<AxiRenderable> {
  scanVarGuards(args);
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    target: "value",
    yes: "boolean",
    var: "value",
    "force-lock": "boolean",
    full: "boolean",
  });
  if (positional.length > 0) {
    throw usage(`bundle deploy takes no arguments, got: ${positional[0]}`);
  }
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  const argv = ["bundle", "deploy", ...targetArgv(target)];
  const varFlag = flags.get("var");
  const varEnv =
    typeof varFlag === "string" ? bundleVarEnv(varFlag) : undefined;
  // --yes maps to upstream --auto-approve, never --force (Git-branch-
  // validation override, an unrelated flag the 2026-07-07 draft conflated).
  if (flags.get("yes") === true) {
    argv.push("--auto-approve");
  }
  if (flags.get("force-lock") === true) {
    // Forwarded only when the agent explicitly passes it — overriding a
    // lock held by a live deployment is exactly the conflict upstream
    // warns about.
    argv.push("--force-lock");
  }

  const captured = await runDatabricksCaptured(argv, {
    ...spawnOpts(flags),
    ...(varEnv ? { env: varEnv } : {}),
    raw: true,
    timeoutMs: DEPLOY_TIMEOUT_MS,
    timeoutHelp: staleLockTimeoutHelp(tf, p),
  });

  if (captured.exitCode !== 0) {
    checkNotInBundle(captured.stderr);
    const help = APPROVAL_REQUIRED.test(captured.stderr)
      ? [
          `databricks-axi bundle deploy --yes${tf}${p}`,
          `databricks-axi bundle plan${tf}${p}`,
        ]
      : [`databricks-axi bundle summary${tf}${p}`];
    throw deployFailure("bundle deploy", captured, full, tf, p, help);
  }

  return {
    status: "deployed",
    target: typeof target === "string" ? target : undefined,
    help: [
      `databricks-axi bundle summary${tf}${p}`,
      `databricks-axi bundle run <resource_key>${tf}${p}`,
    ],
  };
}

// --- run ---

async function bundleRun(rawArgs: string[]): Promise<AxiRenderable> {
  rejectDoubleDash(rawArgs);
  const { positional, flags } = parseArgs(rawArgs, {
    profile: "value",
    target: "value",
    wait: "boolean",
  });
  if (positional.length !== 1 || positional[0].startsWith("-")) {
    throw usage("Usage: databricks-axi bundle run <resource_key> [--wait]");
  }
  const key = positional[0];
  const wait = flags.get("wait") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  // Resolve via bundle summary (§4.5) — never spawn `databricks bundle run`
  // (the credential-bearing local-exec hazard, §4.6). `bundle summary`'s id
  // is the real Jobs/Pipelines API id (live-confirmed).
  const { rows } = await fetchBundleSummary(flags);
  const match = rows.find((r) => r.key === key);
  if (!match) {
    throw new AxiError(`no such resource: ${key}`, "NOT_FOUND", [
      rows.length > 0
        ? `Available keys: ${rows.map((r) => r.key).join(", ")}`
        : "This bundle has no resources",
      `databricks-axi bundle summary${tf}${p}`,
    ]);
  }
  if (!match.id) {
    // Key present but no id (C7) — the not-yet-deployed case. Never call
    // run-now/start-update with an empty id.
    throw usage(`resource "${key}" is not deployed yet — deploy it first`, [
      `databricks-axi bundle deploy${tf}${p}`,
    ]);
  }

  if (match.type === "jobs") {
    const runArgv = ["jobs", "run-now", match.id];
    if (!wait) {
      runArgv.push("--no-wait");
    }
    const result = assertObject<{
      run_id?: unknown;
      state?: { result_state?: string; life_cycle_state?: string };
    }>(
      await runWithNotFoundHelp(
        runArgv,
        {
          ...spawnOpts(flags),
          ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
          timeoutHelp: [
            "The run may have started despite the timeout — check before retrying:",
            `databricks-axi jobs runs ${match.id}${p}`,
          ],
        },
        [`databricks-axi bundle summary${tf}${p}`],
      ),
      "jobs run-now",
    );
    const out: AxiStructuredOutput = {
      resource: key,
      type: "jobs",
      id: match.id,
      run_id: result.run_id,
    };
    const state = result.state?.result_state ?? result.state?.life_cycle_state;
    if (state) {
      out.state = state;
    }
    out.help = [`databricks-axi jobs runs view ${String(result.run_id)}${p}`];
    return out;
  }

  if (match.type === "pipelines") {
    try {
      const result = assertObject<{ update_id?: unknown }>(
        await runWithNotFoundHelp(
          ["pipelines", "start-update", match.id],
          {
            ...spawnOpts(flags),
            timeoutHelp: [
              "The start may have applied despite the timeout — check state:",
              `databricks-axi pipelines view ${match.id}${p}`,
            ],
          },
          [`databricks-axi bundle summary${tf}${p}`],
        ),
        "pipelines start-update",
      );
      return {
        resource: key,
        type: "pipelines",
        id: match.id,
        update_id: result.update_id,
        help: [`databricks-axi pipelines view ${match.id}${p}`],
      };
    } catch (error) {
      if (error instanceof AxiError) {
        const conflict = CONFLICT.exec(error.message);
        if (conflict) {
          return {
            resource: key,
            type: "pipelines",
            id: match.id,
            update_id: conflict[1],
            status: "update already in progress (no-op)",
            help: [`databricks-axi pipelines view ${match.id}${p}`],
          };
        }
      }
      throw error;
    }
  }

  throw usage(`bundle run does not support resource type "${match.type}"`, [
    `Run raw: databricks bundle run ${key}${tf}${p}`,
    "Never pass `--` to it — upstream `bundle run` executes an arbitrary local command with the bundle's credentials injected into its environment after `--`; see `databricks-axi bundle --help` instead",
  ]);
}

// --- destroy ---

async function bundleDestroy(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    target: "value",
    yes: "boolean",
    "force-lock": "boolean",
    full: "boolean",
  });
  if (positional.length > 0) {
    throw usage(`bundle destroy takes no arguments, got: ${positional[0]}`);
  }
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const target = flags.get("target");
  const tf = targetSuffix(target);

  if (flags.get("yes") !== true) {
    // The only intentionally destructive verb in the axi surface —
    // permanently deletes every resource AND workspace file this bundle
    // deployed to this target, not undoable. Our gate fires before any
    // spawn at all, so an agent would never see upstream's own AgentNotice
    // ("do not retry ... unless the user has explicitly approved it") —
    // axi's own gate message carries the equivalent instead of stripping it.
    throw usage(
      "bundle destroy permanently deletes every resource (and workspace file) this bundle deployed to this target — not undoable. Do not retry with --yes unless the user has explicitly approved it; the flag bypasses this safety check and the operation may be irreversible.",
      [
        `Review what would be destroyed first: databricks-axi bundle plan${tf}${p}`,
        `Then, only with explicit user approval: databricks-axi bundle destroy --yes${tf}${p}`,
      ],
    );
  }

  const argv = ["bundle", "destroy", "--auto-approve", ...targetArgv(target)];
  if (flags.get("force-lock") === true) {
    argv.push("--force-lock");
  }
  const captured = await runDatabricksCaptured(argv, {
    ...spawnOpts(flags),
    raw: true,
    timeoutMs: DEPLOY_TIMEOUT_MS,
    timeoutHelp: staleLockTimeoutHelp(tf, p),
  });

  if (captured.exitCode !== 0) {
    checkNotInBundle(captured.stderr);
    throw deployFailure("bundle destroy", captured, full, tf, p, [
      `databricks-axi bundle summary${tf}${p}`,
    ]);
  }

  return {
    status: "destroyed",
    target: typeof target === "string" ? target : undefined,
  };
}

// --- dispatch ---

export async function bundleCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "validate":
      return bundleValidate(rest);
    case "plan":
      return bundlePlan(rest);
    case "summary":
      return bundleSummary(rest);
    case "deploy":
      return bundleDeploy(rest);
    case "run":
      return bundleRun(rest);
    case "destroy":
      return bundleDestroy(rest);
    default:
      throw usage(
        sub
          ? `Unknown bundle subcommand: ${sub}`
          : "bundle requires a subcommand",
      );
  }
}

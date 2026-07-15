// Preflight health check (AXI §7 ambient context, §6 structured errors). One
// deterministic command in place of agent-skills' `commands/doctor.md`
// slash-command prompt (several raw-CLI turns, hand-formatted table). See
// docs/superpowers/specs/2026-07-15-databricks-axi-1.1.0-doctor-design.md.
//
// Hard invariant: doctor always exits 0. The whole body runs on
// Promise.allSettled results; nothing here may let a probe rejection
// propagate as an uncaught throw (that would leak exit 1 from the SDK and
// break the report contract). The only throw is parseArgs' usage error
// (VALIDATION_ERROR, exit 2), before any probe fires.
import { AxiError } from "axi-sdk-js";
import {
  fetchAuthContext,
  fetchClusters,
  fetchRecentRuns,
  fetchWarehouses,
  PANEL_TIMEOUT_MS,
  type AuthContext,
  type ClusterRow,
  type RecentRun,
  type WarehouseRow,
} from "../context.js";
import {
  INSTALL_HELP,
  probeCli,
  runDatabricks,
  UPGRADE_HELP,
  type RunDatabricksOptions,
} from "../databricks.js";
import {
  assertObject,
  domainHelpers,
  profileSuffix,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { parseArgs, usage } = domainHelpers("doctor");

export const DOCTOR_HELP = `usage: databricks-axi doctor [--profile <name>] [--full]
Preflight health check: CLI version, resolved profile/host, auth validity, and
(with --full) compute/warehouse/recent-run panels plus failure predictions.
A report — always exit 0; FAIL rows carry a machine code + the next action.
examples:
  databricks-axi doctor
  databricks-axi doctor --full
  databricks-axi doctor --profile AWS --full
`;

// Anchored on the URL authority's first label — not `.includes("accounts")`,
// which would also match a workspace host that merely contains that
// substring somewhere else.
const ACCOUNT_HOST = /^https?:\/\/accounts\./;

type Status = "PASS" | "WARN" | "FAIL" | "INFO";

type Check = {
  check: string;
  status: Status;
  detail: string;
  code?: string;
  help?: string[];
};

type MeProbe = { userName?: string; active?: boolean };

async function fetchMe(opts: RunDatabricksOptions): Promise<MeProbe> {
  const parsed = assertObject<MeProbe>(
    await runDatabricks(["current-user", "me"], opts),
    "current-user me",
  );
  return { userName: parsed.userName, active: parsed.active };
}

function unavailable(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `unavailable (${message})`;
}

/** Root-cause fix (F1): the rejection's own AxiError code drives the FAIL
 * row — a TIMEOUT/UPSTREAM_ERROR/PERMISSION_DENIED rejection must not get
 * mislabeled AUTH_ERROR just because it happened on an auth probe.
 * AUTH_ERROR is only the fallback for a non-AxiError reason. */
function errorDetail(reason: unknown): {
  detail: string;
  help: string[];
  code: string;
} {
  if (reason instanceof AxiError) {
    return {
      detail: reason.message,
      help: reason.suggestions,
      code: reason.code,
    };
  }
  return { detail: unavailable(reason), help: [], code: "AUTH_ERROR" };
}

function cliCheck(cli: Awaited<ReturnType<typeof probeCli>>): Check {
  if (!cli.found) {
    return {
      check: "cli",
      status: "FAIL",
      detail: "not found on PATH",
      code: "CLI_MISSING",
      help: [INSTALL_HELP],
    };
  }
  if (!cli.version) {
    return {
      check: "cli",
      status: "WARN",
      detail: "version unknown",
      code: "CLI_VERSION_UNKNOWN",
      help: [
        "Could not read the CLI version; run `databricks -v` to check it's >= 0.298",
      ],
    };
  }
  // `.raw` already carries a leading "v" when the CLI's own -v output did;
  // normalize so the rendered detail always shows exactly one.
  const version = `v${cli.version.raw.replace(/^v/, "")}`;
  if (cli.ok) {
    return { check: "cli", status: "PASS", detail: version };
  }
  return {
    check: "cli",
    status: "WARN",
    detail: `${version} — upgrade to >= 0.298`,
    code: "CLI_TOO_OLD",
    help: [UPGRADE_HELP],
  };
}

/** §6 Decision 3: the account-host carve-out, resolved after both probes
 * have settled. `current-user me` always fires in parallel regardless of
 * host — classification never blocks or skips the probe. */
function authAndProfileChecks(
  authR: PromiseSettledResult<AuthContext>,
  meR: PromiseSettledResult<MeProbe>,
): { profile: Check; auth: Check } {
  if (authR.status === "rejected") {
    // No host to classify — the carve-out never applies here. Both rows
    // fail for the same underlying reason (its own code, e.g. AUTH_ERROR or
    // TIMEOUT — see errorDetail).
    const profileErr = errorDetail(authR.reason);
    const authErr =
      meR.status === "rejected" ? errorDetail(meR.reason) : profileErr;
    return {
      profile: { check: "profile", status: "FAIL", ...profileErr },
      auth: { check: "auth", status: "FAIL", ...authErr },
    };
  }

  const ctx = authR.value;
  const host = ctx.host ?? "";
  const profile: Check = {
    check: "profile",
    status: "PASS",
    detail: [ctx.profile, ctx.host, ctx.auth_type].filter(Boolean).join("  "),
  };

  if (ACCOUNT_HOST.test(host)) {
    return {
      profile,
      auth: {
        check: "auth",
        status: "INFO",
        detail: `account-level host — validated via auth describe (${ctx.auth_type ?? "unknown"}); current-user me not applicable`,
      },
    };
  }

  if (meR.status === "fulfilled") {
    const me = meR.value;
    return {
      profile,
      auth: {
        check: "auth",
        status: "PASS",
        detail: `${me.userName ?? "unknown"}  ${me.active ? "active" : "inactive"}`,
      },
    };
  }
  return {
    profile,
    auth: { check: "auth", status: "FAIL", ...errorDetail(meR.reason) },
  };
}

/** §5.2 — no row when there are no warehouses at all, one is RUNNING, or the
 * panel is degraded (an empty list is not itself a fault to warn about, and
 * `rows[0].id` below would otherwise be a made-up placeholder). */
function warehousePrediction(
  rows: WarehouseRow[],
  p: string,
): Check | undefined {
  if (rows.length === 0 || rows.some((w) => w.state === "RUNNING")) {
    return undefined;
  }
  const id = rows[0]?.id;
  const action = `databricks-axi sql warehouses start ${id ?? "<id>"}${p}`;
  return {
    check: "warehouse",
    status: "WARN",
    detail: `no RUNNING warehouse — ${action}`,
    help: [action],
  };
}

/** §5.1 — the definite three-outcome rule over the UNFILTERED cluster list. */
function computePrediction(rows: ClusterRow[], p: string): Check | undefined {
  if (rows.length === 0) {
    return {
      check: "compute",
      status: "INFO",
      detail: "serverless-only workspace (no classic clusters exist)",
    };
  }
  if (rows.some((c) => c.state !== "TERMINATED")) {
    return undefined; // the running-clusters panel is the signal
  }
  const id = rows[0]?.cluster_id;
  const action = `databricks-axi clusters start ${id ?? "<id>"}${p}`;
  return {
    check: "compute",
    status: "INFO",
    detail: `${rows.length} classic cluster(s), all stopped — ${action}`,
    help: [action],
  };
}

// §4.1 fixed root-cause fix-order: FAIL tier strictly ahead of WARN tier.
const FAIL_CODE_ORDER = [
  "CLI_MISSING",
  "AUTH_ERROR",
  "PERMISSION_DENIED",
  "UPSTREAM_ERROR",
  "TIMEOUT",
];

function summarize(checks: Check[]): {
  overall: string;
  code?: string;
  help: string[];
} {
  const fails = checks.filter((c) => c.status === "FAIL");
  if (fails.length > 0) {
    for (const code of FAIL_CODE_ORDER) {
      const hit = fails.find((c) => c.code === code);
      if (hit) {
        return { overall: "fail", code, help: hit.help ?? [] };
      }
    }
    const first = fails[0];
    return { overall: "fail", code: first.code, help: first.help ?? [] };
  }
  const warns = checks.filter((c) => c.status === "WARN");
  if (warns.length > 0) {
    // Both CLI_TOO_OLD and CLI_VERSION_UNKNOWN land here — either way a cli
    // WARN with a code outranks the uncoded warehouse prediction.
    const cliWarn = warns.find((c) => c.check === "cli" && c.code);
    if (cliWarn) {
      return { overall: "warn", code: cliWarn.code, help: cliWarn.help ?? [] };
    }
    const warehouseWarn = warns.find((c) => c.check === "warehouse");
    if (warehouseWarn) {
      return { overall: "warn", help: warehouseWarn.help ?? [] };
    }
    // No other check currently emits WARN (compute is INFO-only), but fall
    // back to the first WARN's help rather than dropping it silently.
    return { overall: "warn", help: warns[0].help ?? [] };
  }
  return { overall: "healthy", help: [] };
}

export async function doctorCommand(
  args: string[] = [],
): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  if (positional.length > 0) {
    throw usage(`doctor takes no arguments, got: ${positional[0]}`);
  }
  const full = flags.get("full") === true;
  const profileFlag = flags.get("profile");
  const p = profileSuffix(profileFlag);
  const opts = { ...spawnOpts(flags), timeoutMs: PANEL_TIMEOUT_MS };

  const [cliR, authR, meR, runsR, warehousesR, clustersR] =
    await Promise.allSettled([
      probeCli(PANEL_TIMEOUT_MS),
      fetchAuthContext(
        opts,
        typeof profileFlag === "string" ? profileFlag : undefined,
      ),
      fetchMe(opts),
      full ? fetchRecentRuns(opts) : Promise.resolve(undefined),
      full ? fetchWarehouses(opts) : Promise.resolve(undefined),
      full ? fetchClusters(opts) : Promise.resolve(undefined),
    ]);

  const checks: Check[] = [];
  checks.push(
    cliR.status === "fulfilled"
      ? cliCheck(cliR.value)
      : // ponytail: probeCli's own Promise never rejects (spawnCollect only
        // resolves) — kept for type safety against Promise.allSettled's
        // result type, not reachable in practice.
        { check: "cli", status: "FAIL", ...errorDetail(cliR.reason) },
  );

  const { profile, auth } = authAndProfileChecks(authR, meR);
  checks.push(profile, auth);

  const panels: AxiStructuredOutput = {};

  if (full) {
    if (warehousesR.status === "fulfilled" && warehousesR.value) {
      const rows = warehousesR.value as WarehouseRow[];
      panels.warehouses = rows;
      const prediction = warehousePrediction(rows, p);
      if (prediction) {
        checks.push(prediction);
      }
    } else if (warehousesR.status === "rejected") {
      panels.warehouses = unavailable(warehousesR.reason);
    }

    if (clustersR.status === "fulfilled" && clustersR.value) {
      const rows = clustersR.value as ClusterRow[];
      const running = rows.filter((c) => c.state !== "TERMINATED");
      if (running.length > 0) {
        panels.running_clusters = running;
      }
      const prediction = computePrediction(rows, p);
      if (prediction) {
        checks.push(prediction);
      }
    } else if (clustersR.status === "rejected") {
      panels.running_clusters = unavailable(clustersR.reason);
    }

    if (runsR.status === "fulfilled" && runsR.value) {
      panels.recent_runs = runsR.value as RecentRun[];
    } else if (runsR.status === "rejected") {
      panels.recent_runs = unavailable(runsR.reason);
    }
  }

  // Rendered rows are trimmed to {check,status,detail} only — code/help stay
  // internal to `checks` so the TOON table renders as a uniform compact grid
  // instead of a per-row block (which a stray extra field per row forces).
  const out: AxiStructuredOutput = {
    checks: checks.map(({ check, status, detail }) => ({
      check,
      status,
      detail,
    })),
  };
  const { overall, code, help } = summarize(checks);
  out.overall = overall;
  if (code) {
    out.code = code;
  }
  out.help = help.length > 0 ? help : [`databricks-axi home${p}`];
  return { ...out, ...panels };
}

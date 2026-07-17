// Ambient workspace dashboard (AXI §7). Panel fetch logic lives in
// src/context.ts; this file only assembles/renders. Runs on every hooked
// agent session start via `setup hooks` — the budget is the design
// constraint: partial output over completeness, never an error exit for a
// degraded panel.
import { AxiError } from "axi-sdk-js";
import {
  fetchAuthContext,
  fetchRecentRuns,
  fetchRunningClusters,
  fetchWarehouses,
  PANEL_TIMEOUT_MS,
  type AuthContext,
  type ClusterRow,
  type RecentRun,
  type WarehouseRow,
} from "../context.js";
import {
  domainHelpers,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { parseArgs, usage } = domainHelpers("home");

const AVAILABLE_COMMANDS =
  "jobs (list, view, run, runs, logs, cancel), clusters (list, view, start, stop), sql (warehouses, exec, statement, history), catalog (catalogs, schemas, tables, table view, volumes, volume view, functions, function view, grants), dashboards (list, view), permissions <type> <id>, workspace (ls, view), fs (ls, cat), pipelines (list, view, start, stop, events), serving (list, view), setup (hooks), api, whoami, doctor [--full]";

const TOP_SUGGESTIONS = [
  "databricks-axi jobs list",
  'databricks-axi sql exec "<query>"',
  "databricks-axi catalog catalogs",
];

/** Per-panel failure/timeout: one line, never a hard error for the whole
 * dashboard (a broken panel must never suppress the others). */
function unavailable(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return `unavailable (${message})`;
}

export async function homeCommand(args: string[] = []): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  if (positional.length > 0) {
    throw usage(`home takes no arguments, got: ${positional[0]}`);
  }
  const opts = { ...spawnOpts(flags), timeoutMs: PANEL_TIMEOUT_MS };
  const profileFlag = flags.get("profile");

  // All spawns fire in parallel; rendering starts only once every panel has
  // settled (success, failure, or its own 4s timeout).
  const [authR, runsR, warehousesR, clustersR] = await Promise.allSettled([
    fetchAuthContext(
      opts,
      typeof profileFlag === "string" ? profileFlag : undefined,
    ),
    fetchRecentRuns(opts),
    fetchWarehouses(opts),
    fetchRunningClusters(opts),
  ]);

  if (
    authR.status === "rejected" &&
    authR.reason instanceof AxiError &&
    authR.reason.code === "AUTH_ERROR"
  ) {
    // Every other workspace panel needs the same auth, so it would fail the
    // same way — swap the whole dashboard body for the structured error,
    // but still print the one panel that needs no workspace call.
    return {
      error: authR.reason.message,
      code: authR.reason.code,
      help: [...authR.reason.suggestions, ...TOP_SUGGESTIONS],
      commands: AVAILABLE_COMMANDS,
    };
  }

  const out: AxiStructuredOutput = {
    context:
      authR.status === "fulfilled"
        ? (authR.value as AuthContext)
        : unavailable(authR.reason),
    recent_runs:
      runsR.status === "fulfilled"
        ? (runsR.value as RecentRun[])
        : unavailable(runsR.reason),
    warehouses:
      warehousesR.status === "fulfilled"
        ? (warehousesR.value as WarehouseRow[])
        : unavailable(warehousesR.reason),
  };
  if (clustersR.status === "fulfilled") {
    // Zero non-terminated clusters omits the panel entirely — serverless
    // workspaces shouldn't pay a "no clusters" line every session.
    const rows = clustersR.value as ClusterRow[];
    if (rows.length > 0) {
      out.running_clusters = rows;
    }
  } else {
    out.running_clusters = unavailable(clustersR.reason);
  }
  out.commands = AVAILABLE_COMMANDS;
  out.help = TOP_SUGGESTIONS;
  return out;
}

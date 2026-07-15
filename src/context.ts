// Panel fetchers for the `home` ambient dashboard (rendering lives in
// src/commands/home.ts). Every fetch here is spawned in parallel by the
// caller via Promise.allSettled with a 4s per-panel timeout override — none
// of these functions retry or extend that budget themselves.
import { runDatabricks, type RunDatabricksOptions } from "./databricks.js";
import {
  asList,
  assertObject,
  compactState,
  isFailed,
  type RunState,
} from "./commands/shared.js";

/** Wall-clock budget for each parallel home panel spawn. */
export const PANEL_TIMEOUT_MS = 4_000;

export type AuthContext = {
  user?: string;
  host?: string;
  auth_type?: string;
  profile?: string;
};

type AuthDescribe = {
  username?: string;
  details?: {
    host?: string;
    auth_type?: string;
    configuration?: { profile?: { value?: string } };
  };
};

/**
 * `auth describe -o json` is nested, not flat (live-verified on v1.6.0):
 * user = top-level `username`, host = `details.host`, auth type =
 * `details.auth_type`, profile = `details.configuration.profile.value`
 * (falls back to the `--profile` flag we passed, if any). Never pass
 * `--sensitive` — it exists upstream and would put a token on stdout.
 */
export async function fetchAuthContext(
  opts: RunDatabricksOptions,
  profileFlag?: string,
): Promise<AuthContext> {
  const parsed = assertObject<AuthDescribe>(
    await runDatabricks(["auth", "describe"], opts),
    "auth describe",
  );
  return {
    user: parsed.username,
    host: parsed.details?.host,
    auth_type: parsed.details?.auth_type,
    profile: parsed.details?.configuration?.profile?.value ?? profileFlag,
  };
}

export type RecentRun = {
  run_id: unknown;
  state: string;
  start_time: unknown;
  next?: string;
};

type RawRun = {
  run_id?: unknown;
  state?: RunState;
  start_time?: unknown;
};

/** FAILED rows first, each carrying its own `jobs logs <run_id>` follow-up. */
export async function fetchRecentRuns(
  opts: RunDatabricksOptions,
): Promise<RecentRun[]> {
  const parsed = await runDatabricks(
    ["jobs", "list-runs", "--limit", "5"],
    opts,
  );
  const runs = asList(parsed, "runs") as RawRun[];
  const sorted = [...runs].sort(
    (a, b) => Number(isFailed(b)) - Number(isFailed(a)),
  );
  return sorted.map((run) => {
    const row: RecentRun = {
      run_id: run.run_id,
      state: compactState(run),
      start_time: run.start_time,
    };
    if (isFailed(run)) {
      row.next = `databricks-axi jobs logs ${String(run.run_id)}`;
    }
    return row;
  });
}

export type WarehouseRow = { id: unknown; name: unknown; state: unknown };

/** On Free Edition this is the compute panel that actually has content. */
export async function fetchWarehouses(
  opts: RunDatabricksOptions,
): Promise<WarehouseRow[]> {
  const parsed = await runDatabricks(["warehouses", "list"], opts);
  const items = asList(parsed, "warehouses") as {
    id?: unknown;
    name?: unknown;
    state?: unknown;
  }[];
  return items.map((w) => ({ id: w.id, name: w.name, state: w.state }));
}

export type ClusterRow = {
  cluster_id: unknown;
  cluster_name: unknown;
  state: unknown;
};

/** Unfiltered — every cluster regardless of state. `doctor` needs this to
 * tell "nothing running" apart from "no classic clusters exist" (a filtered
 * empty result means either); `home` still only wants the filtered view. */
export async function fetchClusters(
  opts: RunDatabricksOptions,
): Promise<ClusterRow[]> {
  const parsed = await runDatabricks(["clusters", "list"], opts);
  const items = asList(parsed, "clusters") as {
    cluster_id?: unknown;
    cluster_name?: unknown;
    state?: unknown;
  }[];
  return items.map((c) => ({
    cluster_id: c.cluster_id,
    cluster_name: c.cluster_name,
    state: c.state,
  }));
}

/** Filtered to non-TERMINATED; the caller omits the panel entirely on zero
 * rows (serverless workspaces shouldn't pay a "no clusters" line). */
export async function fetchRunningClusters(
  opts: RunDatabricksOptions,
): Promise<ClusterRow[]> {
  return (await fetchClusters(opts)).filter((c) => c.state !== "TERMINATED");
}

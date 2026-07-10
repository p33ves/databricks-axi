import { AxiError } from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";
import {
  asList,
  assertObject,
  domainHelpers,
  profileSuffix,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const {
  usage,
  parseArgs,
  parseIntFlag,
  requireId: requireIdArg,
  renderRows,
} = domainHelpers("clusters");

// Cluster ids are opaque strings ("1234-567890-abc123"), not numeric — just
// reject a leading "-" so one can never be smuggled onto child argv as a flag.
const requireId = (positional: string[], usageText: string) =>
  requireIdArg(positional, usageText, /^[^-]/);

export const CLUSTERS_HELP = `usage: databricks-axi clusters <subcommand> [args] [flags]
subcommands[4]:
  list [--limit N] [--fields a,b]
  view <cluster_id>
  start <cluster_id> [--wait]
  stop <cluster_id> [--wait]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi clusters list
  databricks-axi clusters view <cluster_id>
  databricks-axi clusters start <cluster_id>
notes:
  stop maps to upstream \`clusters delete\` (keeps config, restartable) —
  never permanent-delete, which destroys the cluster
  start/stop are async by default; --wait blocks up to ~20 min upstream (agents: avoid)
`;

type RawCluster = {
  cluster_id?: string;
  cluster_name?: string;
  state?: string;
  state_message?: string;
  spark_version?: string;
  node_type_id?: string;
  num_workers?: number;
  autoscale?: { min_workers?: number; max_workers?: number };
  autotermination_minutes?: number;
  creator_user_name?: string;
} & Record<string, unknown>;

export async function clustersCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return clustersList(rest);
    case "view":
      return clustersView(rest);
    case "start":
      return clustersStart(rest);
    case "stop":
      return clustersStop(rest);
    default:
      throw usage(
        sub
          ? `Unknown clusters subcommand: ${sub}`
          : "clusters requires a subcommand",
      );
  }
}

// --- subcommands ---

async function clustersList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    limit: "value",
    fields: "value",
  });
  if (positional.length > 0) {
    throw usage(`clusters list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
  const parsed = await runClusters(
    ["clusters", "list", "--limit", String(limit)],
    spawnOpts(flags),
  );
  const items = asList(parsed, "clusters") as RawCluster[];
  const rows = renderRows(items, flags, [
    "cluster_id",
    "cluster_name",
    "state",
  ]);
  const p = profileSuffix(flags.get("profile"));
  if (rows.length === 0) {
    return {
      clusters: [],
      status:
        "no clusters in this workspace — serverless/Free Edition workspaces never show clusters here",
      help: ["Create one in the workspace UI: Compute > Create compute"],
    };
  }
  const help = [`databricks-axi clusters view <cluster_id>${p}`];
  const terminated = items.find((c) => c.state === "TERMINATED");
  if (terminated) {
    help.push(`databricks-axi clusters start ${terminated.cluster_id}${p}`);
  }
  const out: AxiStructuredOutput = { clusters: rows, count: rows.length };
  // CLI >= 0.298 caps results client-side at --limit; a full page means
  // there may be more.
  if (rows.length >= limit) {
    out.has_more = true;
    help.unshift(`databricks-axi clusters list --limit ${limit * 2}${p}`);
  }
  out.help = help;
  return out;
}

async function clustersView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const clusterId = requireId(positional, "clusters view <cluster_id>");
  const p = profileSuffix(flags.get("profile"));
  const cluster = assertObject<RawCluster>(
    await runClusters(["clusters", "get", clusterId], spawnOpts(flags)),
    "clusters get",
  );
  const out: AxiStructuredOutput = {
    cluster_id: cluster.cluster_id ?? clusterId,
    cluster_name: cluster.cluster_name,
    state: cluster.state,
  };
  if (cluster.state_message) {
    out.state_message = cluster.state_message;
  }
  out.spark_version = cluster.spark_version;
  out.node_type_id = cluster.node_type_id;
  out.num_workers =
    cluster.autoscale?.min_workers != null
      ? `${cluster.autoscale.min_workers}-${cluster.autoscale.max_workers}`
      : cluster.num_workers;
  out.autotermination_minutes = cluster.autotermination_minutes;
  out.creator_user_name = cluster.creator_user_name;
  out.help = [
    cluster.state === "RUNNING"
      ? `databricks-axi clusters stop ${clusterId}${p}`
      : `databricks-axi clusters start ${clusterId}${p}`,
  ];
  return out;
}

const WAIT_TIMEOUT_MS = 25 * 60_000; // upstream blocks up to 20 min on --wait

async function clustersStart(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    wait: "boolean",
  });
  const clusterId = requireId(
    positional,
    "clusters start <cluster_id> [--wait]",
  );
  const wait = flags.get("wait") === true;
  const p = profileSuffix(flags.get("profile"));
  const argv = ["clusters", "start", clusterId];
  if (!wait) {
    argv.push("--no-wait");
  }
  try {
    // With --no-wait upstream emits EMPTY stdout (runDatabricks yields
    // null) — call it directly and ignore the result; never assertObject
    // it, and take cluster_id from the argv positional, not any response.
    await runClusters(argv, {
      ...spawnOpts(flags),
      ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
      timeoutHelp: [
        "The start may have applied despite the timeout — check state:",
        `databricks-axi clusters view ${clusterId}${p}`,
      ],
    });
  } catch (error) {
    // clusters start on a non-TERMINATED cluster is NOT an upstream no-op:
    // it exits 1 with "Cluster <id> is in unexpected state Running." (also
    // "Pending."), which maps to UPSTREAM_ERROR — not INVALID_STATE. Key on
    // the message, not the code. NOT_FOUND/403 must not match and propagate.
    if (
      error instanceof AxiError &&
      /is in unexpected state/i.test(error.message)
    ) {
      return {
        cluster_id: clusterId,
        status: "cluster not startable in current state (no-op)",
        help: [`databricks-axi clusters view ${clusterId}${p}`],
      };
    }
    throw error;
  }
  return {
    cluster_id: clusterId,
    status: "start requested",
    help: [`databricks-axi clusters view ${clusterId}${p}`],
  };
}

async function clustersStop(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    wait: "boolean",
  });
  const clusterId = requireId(
    positional,
    "clusters stop <cluster_id> [--wait]",
  );
  const wait = flags.get("wait") === true;
  const p = profileSuffix(flags.get("profile"));
  // The terminate verb upstream is `delete` (keeps config, restartable) —
  // never `permanent-delete`, which destroys the cluster.
  const argv = ["clusters", "delete", clusterId];
  if (!wait) {
    argv.push("--no-wait");
  }
  // Upstream `delete` on an already-TERMINATED/TERMINATING cluster is a
  // genuine no-op: exit 0, empty output, byte-identical to a fresh
  // terminate — no stderr to convert, so there is no no-op branch here.
  // With --no-wait stdout is EMPTY (null) — call directly, ignore the
  // result, never assertObject it.
  await runClusters(argv, {
    ...spawnOpts(flags),
    ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
    timeoutHelp: [
      "The stop may have applied despite the timeout — check state:",
      `databricks-axi clusters view ${clusterId}${p}`,
    ],
  });
  return {
    cluster_id: clusterId,
    status: "stop requested",
    help: [`databricks-axi clusters view ${clusterId}${p}`],
  };
}

/** runDatabricks, folding clusters-flavored suggestions into bare NOT_FOUND. */
async function runClusters(
  args: string[],
  opts: RunDatabricksOptions,
): Promise<unknown> {
  try {
    return await runDatabricks(args, opts);
  } catch (error) {
    if (
      error instanceof AxiError &&
      error.code === "NOT_FOUND" &&
      error.suggestions.length === 0
    ) {
      const p = profileSuffix(opts.profile);
      throw new AxiError(error.message, "NOT_FOUND", [
        `databricks-axi clusters list${p}`,
      ]);
    }
    throw error;
  }
}

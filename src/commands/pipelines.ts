import { AxiError } from "axi-sdk-js";
import type { RunDatabricksOptions } from "../databricks.js";
import { truncate } from "../truncate.js";
import {
  asList,
  assertObject,
  domainHelpers,
  LIST_FLAGS,
  listResult,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  type AxiRenderable,
} from "./shared.js";

const {
  usage,
  parseArgs,
  parseIntFlag,
  requireId: requireIdArg,
  renderRows,
} = domainHelpers("pipelines");

// Upstream `pipelines stop`/`start-update`/`get` are dual-mode: a non-UUID
// argument is resolved as a bundle resource KEY against cwd project config
// instead of an id, with confusing errors (--help confirms it). Reject
// anything that isn't a UUID before it ever reaches argv — same mechanism
// clusters.ts uses for its own id guard, on every <pipeline_id> arg here.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requireId = (positional: string[], usageText: string) =>
  requireIdArg(positional, usageText, UUID);

export const PIPELINES_HELP = `usage: databricks-axi pipelines <subcommand> [args] [flags]
subcommands[5]:
  list [--limit N] [--fields a,b]
  view <pipeline_id>
  start <pipeline_id>
  stop <pipeline_id>
  events <pipeline_id> [--limit N] [--full]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi pipelines list
  databricks-axi pipelines view <pipeline_id>
  databricks-axi pipelines events <pipeline_id>
notes:
  pipeline_id must be a UUID — upstream treats a non-UUID argument as a
  bundle resource KEY, not a pipeline id
  start maps to upstream \`start-update\`; stop passes --no-wait and always
  exits 0 (upstream has no rejection shape to inspect, same as clusters stop)
`;

type RawUpdate = {
  update_id?: string;
  state?: string;
  creation_time?: string;
};
type RawPipeline = {
  pipeline_id?: string;
  name?: string;
  state?: string;
  latest_updates?: RawUpdate[];
  spec?: {
    catalog?: string;
    schema?: string;
    continuous?: boolean;
  } & Record<string, unknown>;
} & Record<string, unknown>;
type RawEvent = {
  timestamp?: string;
  level?: string;
  event_type?: string;
  message?: string;
} & Record<string, unknown>;

export async function pipelinesCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return pipelinesList(rest);
    case "view":
      return pipelinesView(rest);
    case "start":
      return pipelinesStart(rest);
    case "stop":
      return pipelinesStop(rest);
    case "events":
      return pipelinesEvents(rest);
    default:
      throw usage(
        sub
          ? `Unknown pipelines subcommand: ${sub}`
          : "pipelines requires a subcommand",
      );
  }
}

// --- subcommands ---

async function pipelinesList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`pipelines list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
  const parsed = await runPipelines(
    ["pipelines", "list-pipelines", "--limit", String(limit)],
    spawnOpts(flags),
  );
  const items = asList(parsed, "statuses") as RawPipeline[];
  const rows = renderRows(items, flags, ["pipeline_id", "name", "state"]);
  const p = profileSuffix(flags.get("profile"));
  return listResult("pipelines", rows, limit, {
    rerun: `databricks-axi pipelines list --limit ${limit * 2}${p}`,
    empty: {
      status: "no pipelines in this workspace",
      help: [
        "Create one in the workspace UI: Data Engineering > Create pipeline",
      ],
    },
    help: [`databricks-axi pipelines view <pipeline_id>${p}`],
  });
}

async function pipelinesView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const pipelineId = requireId(positional, "pipelines view <pipeline_id>");
  const p = profileSuffix(flags.get("profile"));
  const pipeline = assertObject<RawPipeline>(
    await runPipelines(["pipelines", "get", pipelineId], spawnOpts(flags)),
    "pipelines get",
  );
  const latestUpdates = (pipeline.latest_updates ?? [])
    .slice(0, 3)
    .map((u) => ({
      update_id: u.update_id,
      state: u.state,
      creation_time: u.creation_time,
    }));
  const help: string[] = [];
  if (latestUpdates[0]?.state === "FAILED") {
    help.push(`databricks-axi pipelines events ${pipelineId}${p}`);
  }
  help.push(
    pipeline.state === "RUNNING"
      ? `databricks-axi pipelines stop ${pipelineId}${p}`
      : `databricks-axi pipelines start ${pipelineId}${p}`,
  );
  return {
    pipeline_id: pipeline.pipeline_id ?? pipelineId,
    name: pipeline.name,
    state: pipeline.state,
    latest_updates: latestUpdates,
    catalog: pipeline.spec?.catalog,
    schema: pipeline.spec?.schema,
    continuous: pipeline.spec?.continuous,
    help,
  };
}

const CONFLICT = /An active update '([^']+)' already exists/;

async function pipelinesStart(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const pipelineId = requireId(positional, "pipelines start <pipeline_id>");
  const p = profileSuffix(flags.get("profile"));
  // start-update has no wait flags upstream (naturally async: --help shows
  // only --cause/--full-refresh/--json/--validate-only).
  let updateId: unknown;
  try {
    const result = assertObject<{ update_id?: string }>(
      await runPipelines(
        ["pipelines", "start-update", pipelineId],
        spawnOpts(flags),
      ),
      "pipelines start-update",
    );
    updateId = result.update_id;
  } catch (error) {
    // A conflicting active update maps to UPSTREAM_ERROR upstream (not a
    // distinct error code) — catch it by message regex, same pattern
    // clusters.ts uses for "is in unexpected state", and convert to an
    // exit-0 no-op carrying the active update_id.
    if (error instanceof AxiError) {
      const match = CONFLICT.exec(error.message);
      if (match) {
        return {
          pipeline_id: pipelineId,
          update_id: match[1],
          status: "update already in progress",
          help: [`databricks-axi pipelines view ${pipelineId}${p}`],
        };
      }
    }
    throw error;
  }
  return {
    pipeline_id: pipelineId,
    update_id: updateId,
    status: "update requested",
    help: [`databricks-axi pipelines view ${pipelineId}${p}`],
  };
}

async function pipelinesStop(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const pipelineId = requireId(positional, "pipelines stop <pipeline_id>");
  const p = profileSuffix(flags.get("profile"));
  // Live-verified: `stop --no-wait` is silently idempotent — exit 0, empty
  // stdout, both already-IDLE and mid-update (which cancels). No rejection
  // shape to inspect, so unlike start there is no conflict branch here;
  // always exit 0 (same shape as clusters stop -> clusters delete).
  await runPipelines(
    ["pipelines", "stop", pipelineId, "--no-wait"],
    spawnOpts(flags),
  );
  return {
    pipeline_id: pipelineId,
    status: "stop requested",
    help: [`databricks-axi pipelines view ${pipelineId}${p}`],
  };
}

async function pipelinesEvents(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    limit: "value",
    fields: "value",
    full: "boolean",
  });
  const pipelineId = requireId(
    positional,
    "pipelines events <pipeline_id> [--limit N] [--full]",
  );
  const limit = parseIntFlag(flags, "limit", 25);
  const full = flags.get("full") === true;
  const parsed = await runPipelines(
    ["pipelines", "list-pipeline-events", pipelineId, "--limit", String(limit)],
    spawnOpts(flags),
  );
  const items = asList(parsed, "events") as RawEvent[];
  // No --order-by upstream — sort newest first ourselves, then stable-
  // partition ERROR rows to the front (same failed-first principle jobs
  // logs uses for tasks), timestamp descending within each partition.
  const sorted = [...items].sort((a, b) => {
    const errDiff = Number(a.level !== "ERROR") - Number(b.level !== "ERROR");
    return errDiff !== 0
      ? errDiff
      : (b.timestamp ?? "").localeCompare(a.timestamp ?? "");
  });
  const flattened = sorted.map((e) => ({
    timestamp: e.timestamp,
    level: e.level,
    event_type: e.event_type,
    message: full
      ? (e.message ?? "")
      : truncate(e.message ?? "", {
          lines: Infinity,
          mode: "head",
          maxChars: 200,
        }).text,
  }));
  const rows = renderRows(flattened, flags, [
    "timestamp",
    "level",
    "event_type",
    "message",
  ]);
  const p = profileSuffix(flags.get("profile"));
  return listResult("events", rows, limit, {
    rerun: `databricks-axi pipelines events ${pipelineId} --limit ${limit * 2}${p}`,
    empty: {
      status: "no events for this pipeline",
      help: [`databricks-axi pipelines view ${pipelineId}${p}`],
    },
    help: [`databricks-axi pipelines view ${pipelineId}${p}`],
  });
}

/** runDatabricks, folding pipelines-flavored suggestions into bare NOT_FOUND. */
function runPipelines(
  args: string[],
  opts: RunDatabricksOptions,
): Promise<unknown> {
  return runWithNotFoundHelp(args, opts, [
    `databricks-axi pipelines list${profileSuffix(opts.profile)}`,
  ]);
}

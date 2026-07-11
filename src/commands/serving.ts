import type { RunDatabricksOptions } from "../databricks.js";
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
  type AxiStructuredOutput,
} from "./shared.js";

const {
  usage,
  parseArgs,
  parseIntFlag,
  requireId: requireIdArg,
  renderRows,
} = domainHelpers("serving");

// Endpoint names are opaque strings, same shape guard as clusters ids: just
// reject a leading "-" so one can never be smuggled onto child argv as a flag.
const requireId = (positional: string[], usageText: string) =>
  requireIdArg(positional, usageText, /^[^-]/);

export const SERVING_HELP = `usage: databricks-axi serving <subcommand> [args] [flags]
subcommands[2]:
  list [--limit N] [--fields a,b]
  view <name>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi serving list
  databricks-axi serving view <name>
notes:
  read-only in this release — axi does not invoke serving endpoints
`;

type RawState = { ready?: string; config_update?: string };
type RawServedEntity = {
  name?: string;
  entity_name?: string;
  entity_version?: string;
  workload_size?: string;
  scale_to_zero?: boolean;
  foundation_model?: {
    name?: string;
    display_name?: string;
  } & Record<string, unknown>;
} & Record<string, unknown>;
type RawEndpoint = {
  name?: string;
  state?: RawState;
  task?: string;
  config?: { served_entities?: RawServedEntity[] } & Record<string, unknown>;
} & Record<string, unknown>;

export async function servingCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return servingList(rest);
    case "view":
      return servingView(rest);
    default:
      throw usage(
        sub
          ? `Unknown serving subcommand: ${sub}`
          : "serving requires a subcommand",
      );
  }
}

// --- subcommands ---

/** e.g. READY / NOT_READY (updating). */
function compactState(state?: RawState): string {
  const ready = state?.ready ?? "UNKNOWN";
  return state?.config_update && state.config_update !== "NOT_UPDATING"
    ? `${ready} (updating)`
    : ready;
}

async function servingList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`serving list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
  const parsed = await runServing(
    ["serving-endpoints", "list", "--limit", String(limit)],
    spawnOpts(flags),
  );
  const items = asList(parsed, "endpoints") as RawEndpoint[];
  // renderRows selects top-level keys verbatim (no nested flattening) — the
  // response's own `state` is a {ready, config_update} object, so it must be
  // pre-flattened into a synthetic string before rendering, same pattern
  // clusters.ts uses for `autoscale`.
  const flattened = items.map((e) => ({ ...e, state: compactState(e.state) }));
  const rows = renderRows(flattened, flags, ["name", "state", "task"]);
  const p = profileSuffix(flags.get("profile"));
  return listResult("endpoints", rows, limit, {
    rerun: `databricks-axi serving list --limit ${limit * 2}${p}`,
    empty: {
      status: "no serving endpoints in this workspace",
      help: [
        "Create one in the workspace UI: Serving > Create serving endpoint",
      ],
    },
    help: [`databricks-axi serving view <name>${p}`],
  });
}

async function servingView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const name = requireId(positional, "serving view <name>");
  const p = profileSuffix(flags.get("profile"));
  const endpoint = assertObject<RawEndpoint>(
    await runServing(["serving-endpoints", "get", name], spawnOpts(flags)),
    "serving-endpoints get",
  );
  const servedEntities = (endpoint.config?.served_entities ?? []).map(
    entityRow,
  );
  return {
    name: endpoint.name ?? name,
    state: compactState(endpoint.state),
    task: endpoint.task,
    served_entities: servedEntities,
    invocation_url_path: `/serving-endpoints/${endpoint.name ?? name}/invocations`,
    help: [
      "databricks-axi does not invoke endpoints — use the URL path above with your own HTTP client",
      `databricks-axi serving list${p}`,
    ],
  };
}

/** Per-entity label: foundation-model display name > model name > custom
 * entity_name > raw entity name. Version/size/scale-to-zero only apply to
 * custom-served-model entities and only render when present. */
function entityRow(entity: RawServedEntity): AxiStructuredOutput {
  const name =
    entity.foundation_model?.display_name ??
    entity.foundation_model?.name ??
    entity.entity_name ??
    entity.name;
  const row: AxiStructuredOutput = { name };
  if (entity.entity_version !== undefined) {
    row.entity_version = entity.entity_version;
  }
  if (entity.workload_size !== undefined) {
    row.workload_size = entity.workload_size;
  }
  if (entity.scale_to_zero !== undefined) {
    row.scale_to_zero = entity.scale_to_zero;
  }
  return row;
}

/** runDatabricks, folding serving-flavored suggestions into bare NOT_FOUND. */
function runServing(
  args: string[],
  opts: RunDatabricksOptions,
): Promise<unknown> {
  return runWithNotFoundHelp(args, opts, [
    `databricks-axi serving list${profileSuffix(opts.profile)}`,
  ]);
}

import { runDatabricks } from "../databricks.js";
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

const { usage, parseArgs, parseIntFlag, requireId, renderRows } =
  domainHelpers("dashboards");

// Upstream's own --help calls DASHBOARD_ID a "UUID", but the real id is 32
// hex chars, no dashes (live-verified twice, 2026-07-16) — a dashed-UUID
// guard would reject every real dashboard id. Anchoring the first char to
// hex keeps the leading-dash guarantee real (a bare `/^[0-9a-fA-F-]{32,36}$/`
// would wrongly accept a leading dash or an all-dash string).
// ponytail: shape guard, not an existence check — a well-formed missing id
// is upstream's NOT_FOUND to report.
const DASHBOARD_ID = /^[0-9a-fA-F][0-9a-fA-F-]{31,35}$/;

export const DASHBOARDS_HELP = `usage: databricks-axi dashboards <subcommand> [args] [flags]
subcommands[2]:
  list [--limit N] [--trashed] [--fields a,b]
  view <dashboard_id> [--full]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi dashboards list
  databricks-axi dashboards view 01f18184706f11da846a179c97fcc018
notes:
  read-only AI/BI (Lakeview) dashboards; view summarizes the dashboard
  spec (pages/datasets) — --full returns the whole serialized definition
  and can be very large
  dashboard ids are 32 hex chars (from dashboards list), not dashed UUIDs
  ACLs: databricks-axi permissions dashboards <dashboard_id>
`;

type RawDashboard = {
  dashboard_id?: string;
  display_name?: string;
  lifecycle_state?: string;
  path?: string;
  warehouse_id?: string;
  update_time?: string;
  serialized_dashboard?: string;
} & Record<string, unknown>;

const UNPARSEABLE_NOTE =
  "dashboard spec unparseable — rerun with --full for the raw definition";

export async function dashboardsCommand(
  args: string[],
): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return dashboardsList(rest);
    case "view":
      return dashboardsView(rest);
    default:
      throw usage(
        sub
          ? `Unknown dashboards subcommand: ${sub}`
          : "dashboards requires a subcommand",
      );
  }
}

// --- subcommands ---

async function dashboardsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    ...LIST_FLAGS,
    trashed: "boolean",
  });
  if (positional.length > 0) {
    throw usage(`dashboards list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 20);
  const trashed = flags.get("trashed") === true;
  const argv = ["lakeview", "list", "--limit", String(limit)];
  if (trashed) {
    argv.push("--show-trashed");
  }
  const parsed = await runDatabricks(argv, spawnOpts(flags));
  const rows = renderRows(asList(parsed, "dashboards"), flags, [
    "dashboard_id",
    "display_name",
    "lifecycle_state",
    "update_time",
  ]);
  const p = profileSuffix(flags.get("profile"));
  const trashedFlag = trashed ? " --trashed" : "";
  return listResult("dashboards", rows, limit, {
    rerun: `databricks-axi dashboards list${trashedFlag} --limit ${limit * 2}${p}`,
    empty: trashed
      ? {
          status: "no dashboards in this workspace, including trash",
          help: [`databricks-axi workspace ls /Users${p}`],
        }
      : {
          status: "no dashboards in this workspace",
          help: [
            `databricks-axi dashboards list --trashed${p}`,
            `databricks-axi workspace ls /Users${p}`,
          ],
        },
    help: [`databricks-axi dashboards view <dashboard_id>${p}`],
  });
}

async function dashboardsView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const id = requireId(
    positional,
    "dashboards view <dashboard_id>",
    DASHBOARD_ID,
  );
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const dashboard = assertObject<RawDashboard>(
    await runWithNotFoundHelp(["lakeview", "get", id], spawnOpts(flags), [
      `databricks-axi dashboards list${p}`,
      `databricks-axi dashboards list --trashed${p}`,
    ]),
    "lakeview get",
  );
  const out: AxiStructuredOutput = {
    dashboard_id: dashboard.dashboard_id ?? id,
    display_name: dashboard.display_name,
    lifecycle_state: dashboard.lifecycle_state,
    path: dashboard.path,
  };
  if (dashboard.warehouse_id) {
    out.warehouse_id = dashboard.warehouse_id;
  }
  out.update_time = dashboard.update_time;

  if (typeof dashboard.serialized_dashboard === "string") {
    try {
      const spec = JSON.parse(dashboard.serialized_dashboard) as {
        pages?: unknown[];
        datasets?: unknown[];
      };
      if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
        out.pages = Array.isArray(spec.pages) ? spec.pages.length : 0;
        out.datasets = Array.isArray(spec.datasets) ? spec.datasets.length : 0;
      } else {
        out.note = UNPARSEABLE_NOTE;
      }
    } catch {
      out.note = UNPARSEABLE_NOTE;
    }
  }

  // --full is the unbounded escape hatch (same contract as workspace
  // view / fs cat) — the raw string passes through verbatim, no
  // renderFileContent: that helper only does a binary-sentinel check that
  // can never fire on a JSON string field, so calling it here would earn
  // nothing but a key-shape ambiguity ({content, truncated?} vs. a bare
  // string).
  if (full) {
    out.serialized_dashboard = dashboard.serialized_dashboard;
  }

  out.help = [
    `databricks-axi permissions dashboards ${String(out.dashboard_id)}${p}`,
  ];
  return out;
}

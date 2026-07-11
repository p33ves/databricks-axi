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
  domainHelpers("catalog");

export const CATALOG_HELP = `usage: databricks-axi catalog <subcommand> [args] [flags]
subcommands[8]:
  catalogs [--limit N] [--fields a,b]
  schemas <catalog> [--limit N] [--fields a,b]
  tables <catalog>.<schema> [--limit N] [--fields a,b]
  table view <catalog>.<schema>.<table>
  volumes <catalog>.<schema> [--limit N] [--fields a,b]
  volume view <catalog>.<schema>.<volume>
  functions <catalog>.<schema> [--limit N] [--fields a,b]
  function view <catalog>.<schema>.<function>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi catalog catalogs
  databricks-axi catalog schemas workspace
  databricks-axi catalog tables workspace.default
  databricks-axi catalog table view workspace.default.axi_bench_trips
  databricks-axi catalog volumes workspace.default
  databricks-axi catalog function view workspace.axi_bench.axi_fare_with_tip
notes:
  read-only Unity Catalog browsing; tables omits column payloads —
  use table view for the column schema
  volumes/functions are metadata browse only — volume contents read via
  fs ls/cat, not this domain
`;

type RawTable = {
  full_name?: string;
  table_type?: string;
  owner?: string;
  comment?: string;
  columns?: { name?: string; type_text?: string; nullable?: boolean }[];
} & Record<string, unknown>;

type RawVolume = {
  full_name?: string;
  volume_type?: string;
  owner?: string;
  comment?: string;
  storage_location?: string;
} & Record<string, unknown>;

type RawFunction = {
  full_name?: string;
  data_type?: string;
  comment?: string;
  routine_definition?: string;
  sql_data_access?: string;
  is_deterministic?: boolean;
  external_language?: string;
  input_params?: { parameters?: { name?: string; type_text?: string }[] };
} & Record<string, unknown>;

export async function catalogCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "catalogs":
      return catalogsList(rest);
    case "schemas":
      return schemasList(rest);
    case "tables":
      return tablesList(rest);
    case "table":
      if (rest[0] !== "view") {
        throw usage(
          "Usage: databricks-axi catalog table view <catalog>.<schema>.<table>",
        );
      }
      return tableView(rest.slice(1));
    case "volumes":
      return volumesList(rest);
    case "volume":
      if (rest[0] !== "view") {
        throw usage(
          "Usage: databricks-axi catalog volume view <catalog>.<schema>.<volume>",
        );
      }
      return volumeView(rest.slice(1));
    case "functions":
      return functionsList(rest);
    case "function":
      if (rest[0] !== "view") {
        throw usage(
          "Usage: databricks-axi catalog function view <catalog>.<schema>.<function>",
        );
      }
      return functionView(rest.slice(1));
    default:
      throw usage(
        sub
          ? `Unknown catalog subcommand: ${sub}`
          : "catalog requires a subcommand",
      );
  }
}

// --- subcommands ---

async function catalogsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`catalog catalogs takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
  const parsed = await runDatabricks(
    ["catalogs", "list", "--limit", String(limit)],
    spawnOpts(flags),
  );
  const rows = renderRows(asList(parsed, "catalogs"), flags, [
    "name",
    "owner",
    "catalog_type",
  ]);
  const p = profileSuffix(flags.get("profile"));
  return listResult("catalogs", rows, limit, {
    rerun: `databricks-axi catalog catalogs --limit ${limit * 2}${p}`,
    empty: {
      status: "no catalogs visible to this principal",
      help: [
        "Free Edition workspaces have a `workspace` catalog (not `main`) — check permissions if none appear",
      ],
    },
    help: [`databricks-axi catalog schemas <name>${p}`],
  });
}

async function schemasList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  // Patterns reject a leading "-" so an identifier smuggled past strict
  // parseArgs via `--` can never reach child argv as a flag.
  const catalog = requireId(positional, "catalog schemas <catalog>", /^[^-]/);
  const limit = parseIntFlag(flags, "limit", 30);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWithNotFoundHelp(
    ["schemas", "list", catalog, "--limit", String(limit)],
    spawnOpts(flags),
    [`databricks-axi catalog catalogs${p}`],
  );
  // Upstream `name` is already the bare schema name (full_name carries the
  // redundant catalog.schema).
  const rows = renderRows(asList(parsed, "schemas"), flags, ["name", "owner"]);
  return listResult("schemas", rows, limit, {
    rerun: `databricks-axi catalog schemas ${catalog} --limit ${limit * 2}${p}`,
    empty: {
      status: `no schemas in catalog ${catalog}`,
      help: [`databricks-axi catalog catalogs${p}`],
    },
    help: [`databricks-axi catalog tables ${catalog}.<name>${p}`],
  });
}

async function tablesList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  // Split on the first "." — agents think in `workspace.default`, not
  // positional pairs.
  const ref = requireId(
    positional,
    "catalog tables <catalog>.<schema>",
    /^[^.-][^.]*\.[^.-].*$/,
  );
  const dot = ref.indexOf(".");
  const catalog = ref.slice(0, dot);
  const schema = ref.slice(dot + 1);
  const limit = parseIntFlag(flags, "limit", 30);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWithNotFoundHelp(
    [
      "tables",
      "list",
      catalog,
      schema,
      "--limit",
      String(limit),
      // The default payload carries full column/property blobs — columns
      // belong to `table view`.
      "--omit-columns",
      "--omit-properties",
    ],
    spawnOpts(flags),
    [`databricks-axi catalog schemas ${catalog}${p}`],
  );
  const rows = renderRows(asList(parsed, "tables"), flags, [
    "name",
    "table_type",
    "data_source_format",
  ]);
  return listResult("tables", rows, limit, {
    rerun: `databricks-axi catalog tables ${ref} --limit ${limit * 2}${p}`,
    empty: {
      status: `no tables in ${ref}`,
      help: [`databricks-axi catalog schemas ${catalog}${p}`],
    },
    help: [`databricks-axi catalog table view ${ref}.<name>${p}`],
  });
}

async function tableView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const fullName = requireId(
    positional,
    "catalog table view <catalog>.<schema>.<table>",
    /^[^.-][^.]*\.[^.]+\.[^.]+$/,
  );
  const parent = fullName.slice(0, fullName.lastIndexOf("."));
  const p = profileSuffix(flags.get("profile"));
  const table = assertObject<RawTable>(
    await runWithNotFoundHelp(["tables", "get", fullName], spawnOpts(flags), [
      `databricks-axi catalog tables ${parent}${p}`,
    ]),
    "databricks tables get",
  );
  const out: AxiStructuredOutput = {
    full_name: table.full_name ?? fullName,
    table_type: table.table_type,
    owner: table.owner,
  };
  if (table.comment) {
    out.comment = table.comment;
  }
  out.columns = (table.columns ?? []).map((c) => ({
    name: c.name,
    type_text: c.type_text,
    nullable: c.nullable,
  }));
  out.help = [
    `databricks-axi sql exec "SELECT * FROM ${String(out.full_name)} LIMIT 10"${p}`,
    `databricks-axi catalog tables ${parent}${p}`,
  ];
  return out;
}

async function volumesList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  const ref = requireId(
    positional,
    "catalog volumes <catalog>.<schema>",
    /^[^.-][^.]*\.[^.-].*$/,
  );
  const dot = ref.indexOf(".");
  const catalog = ref.slice(0, dot);
  const schema = ref.slice(dot + 1);
  const limit = parseIntFlag(flags, "limit", 30);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWithNotFoundHelp(
    ["volumes", "list", catalog, schema, "--limit", String(limit)],
    spawnOpts(flags),
    [`databricks-axi catalog schemas ${catalog}${p}`],
  );
  const rows = renderRows(asList(parsed, "volumes"), flags, [
    "name",
    "volume_type",
  ]);
  return listResult("volumes", rows, limit, {
    rerun: `databricks-axi catalog volumes ${ref} --limit ${limit * 2}${p}`,
    empty: {
      status: `no volumes in ${ref}`,
      help: [`databricks-axi catalog schemas ${catalog}${p}`],
    },
    help: [
      `databricks-axi catalog volume view ${ref}.<name>${p}`,
      `databricks-axi fs ls /Volumes/${catalog}/${schema}/<name>${p}`,
    ],
  });
}

async function volumeView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const fullName = requireId(
    positional,
    "catalog volume view <catalog>.<schema>.<volume>",
    /^[^.-][^.]*\.[^.]+\.[^.]+$/,
  );
  const parent = fullName.slice(0, fullName.lastIndexOf("."));
  const p = profileSuffix(flags.get("profile"));
  const volume = assertObject<RawVolume>(
    await runWithNotFoundHelp(["volumes", "read", fullName], spawnOpts(flags), [
      `databricks-axi catalog volumes ${parent}${p}`,
    ]),
    "databricks volumes read",
  );
  const out: AxiStructuredOutput = {
    full_name: volume.full_name ?? fullName,
    volume_type: volume.volume_type,
    owner: volume.owner,
  };
  if (volume.comment) {
    out.comment = volume.comment;
  }
  if (volume.storage_location) {
    out.storage_location = volume.storage_location;
  }
  out.help = [
    `databricks-axi fs ls /Volumes/${fullName.replace(/\./g, "/")}${p}`,
    `databricks-axi catalog volumes ${parent}${p}`,
  ];
  return out;
}

async function functionsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  const ref = requireId(
    positional,
    "catalog functions <catalog>.<schema>",
    /^[^.-][^.]*\.[^.-].*$/,
  );
  const dot = ref.indexOf(".");
  const catalog = ref.slice(0, dot);
  const schema = ref.slice(dot + 1);
  const limit = parseIntFlag(flags, "limit", 30);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWithNotFoundHelp(
    ["functions", "list", catalog, schema, "--limit", String(limit)],
    spawnOpts(flags),
    [`databricks-axi catalog schemas ${catalog}${p}`],
  );
  const rows = renderRows(asList(parsed, "functions"), flags, [
    "name",
    "data_type",
    "comment",
  ]);
  return listResult("functions", rows, limit, {
    rerun: `databricks-axi catalog functions ${ref} --limit ${limit * 2}${p}`,
    empty: {
      status: `no functions in ${ref}`,
      help: [`databricks-axi catalog schemas ${catalog}${p}`],
    },
    help: [`databricks-axi catalog function view ${ref}.<name>${p}`],
  });
}

async function functionView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const fullName = requireId(
    positional,
    "catalog function view <catalog>.<schema>.<function>",
    /^[^.-][^.]*\.[^.]+\.[^.]+$/,
  );
  const parent = fullName.slice(0, fullName.lastIndexOf("."));
  const p = profileSuffix(flags.get("profile"));
  const fn = assertObject<RawFunction>(
    await runWithNotFoundHelp(
      ["functions", "get", fullName],
      spawnOpts(flags),
      [`databricks-axi catalog functions ${parent}${p}`],
    ),
    "databricks functions get",
  );
  const out: AxiStructuredOutput = {
    full_name: fn.full_name ?? fullName,
    data_type: fn.data_type,
    routine_definition: fn.routine_definition,
  };
  if (fn.comment) {
    out.comment = fn.comment;
  }
  out.params = (fn.input_params?.parameters ?? []).map((param) => ({
    name: param.name,
    type_text: param.type_text,
  }));
  if (fn.sql_data_access) {
    out.sql_data_access = fn.sql_data_access;
  }
  if (fn.is_deterministic !== undefined) {
    out.is_deterministic = fn.is_deterministic;
  }
  if (fn.external_language) {
    out.external_language = fn.external_language;
  }
  out.help = [`databricks-axi catalog functions ${parent}${p}`];
  return out;
}

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
subcommands[9]:
  catalogs [--limit N] [--fields a,b]
  schemas <catalog> [--limit N] [--fields a,b]
  tables <catalog>.<schema> [--limit N] [--fields a,b]
  table view <catalog>.<schema>.<table>
  volumes <catalog>.<schema> [--limit N] [--fields a,b]
  volume view <catalog>.<schema>.<volume>
  functions <catalog>.<schema> [--limit N] [--fields a,b]
  function view <catalog>.<schema>.<function>
  grants <securable-type> <name> [--principal P] [--full] [--fields a,b]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi catalog catalogs
  databricks-axi catalog schemas workspace
  databricks-axi catalog tables workspace.default
  databricks-axi catalog table view workspace.default.axi_bench_trips
  databricks-axi catalog volumes workspace.default
  databricks-axi catalog function view workspace.axi_bench.axi_fare_with_tip
  databricks-axi catalog grants table workspace.default.axi_bench_trips
notes:
  read-only Unity Catalog browsing; tables omits column payloads —
  use table view for the column schema
  volumes/functions are metadata browse only — volume contents read via
  fs ls/cat, not this domain
  grants securable-type is one of catalog, schema, table, volume, function —
  lowercase only, rejected (not re-cased) even though upstream accepts any
  case; --principal answers "can this principal read this?" including
  privileges derived via group membership
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
    case "grants":
      return grantsGet(rest);
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

/** Shared skeleton for the three <catalog>.<schema>-scoped list commands
 * (tables/volumes/functions): split on the first "." — agents think in
 * `workspace.default`, not positional pairs — then list, render, envelope. */
async function scopedList(
  args: string[],
  cfg: {
    noun: "tables" | "volumes" | "functions";
    argv: (catalog: string, schema: string, limit: number) => string[];
    fields: string[];
    help: (ref: string, catalog: string, schema: string, p: string) => string[];
  },
): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  const ref = requireId(
    positional,
    `catalog ${cfg.noun} <catalog>.<schema>`,
    /^[^.-][^.]*\.[^.-].*$/,
  );
  const dot = ref.indexOf(".");
  const catalog = ref.slice(0, dot);
  const schema = ref.slice(dot + 1);
  const limit = parseIntFlag(flags, "limit", 30);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWithNotFoundHelp(
    cfg.argv(catalog, schema, limit),
    spawnOpts(flags),
    [`databricks-axi catalog schemas ${catalog}${p}`],
  );
  const rows = renderRows(asList(parsed, cfg.noun), flags, cfg.fields);
  return listResult(cfg.noun, rows, limit, {
    rerun: `databricks-axi catalog ${cfg.noun} ${ref} --limit ${limit * 2}${p}`,
    empty: {
      status: `no ${cfg.noun} in ${ref}`,
      help: [`databricks-axi catalog schemas ${catalog}${p}`],
    },
    help: cfg.help(ref, catalog, schema, p),
  });
}

function tablesList(args: string[]): Promise<AxiRenderable> {
  return scopedList(args, {
    noun: "tables",
    argv: (catalog, schema, limit) => [
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
    fields: ["name", "table_type", "data_source_format"],
    help: (ref, _catalog, _schema, p) => [
      `databricks-axi catalog table view ${ref}.<name>${p}`,
    ],
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

function volumesList(args: string[]): Promise<AxiRenderable> {
  return scopedList(args, {
    noun: "volumes",
    argv: (catalog, schema, limit) => [
      "volumes",
      "list",
      catalog,
      schema,
      "--limit",
      String(limit),
    ],
    fields: ["name", "volume_type"],
    help: (ref, catalog, schema, p) => [
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

function functionsList(args: string[]): Promise<AxiRenderable> {
  return scopedList(args, {
    noun: "functions",
    argv: (catalog, schema, limit) => [
      "functions",
      "list",
      catalog,
      schema,
      "--limit",
      String(limit),
    ],
    fields: ["name", "data_type", "comment"],
    help: (ref, _catalog, _schema, p) => [
      `databricks-axi catalog function view ${ref}.<name>${p}`,
    ],
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

// --- grants ---

// Case matters (F4): upstream normalizes any case, but axi rejects
// non-lowercase rather than re-casing — one canonical spelling in, one
// spelling out, so axi's own output/help/docs/bench fixtures never have to
// track whatever casing an agent typed. Also doubles as the leading-dash
// guard on <securable-type>.
const SECURABLE_TYPES = [
  "catalog",
  "schema",
  "table",
  "volume",
  "function",
] as const;
type SecurableType = (typeof SECURABLE_TYPES)[number];

function isSecurableType(value: string): value is SecurableType {
  return (SECURABLE_TYPES as readonly string[]).includes(value);
}

type RawPrivilege = {
  privilege?: string;
  inherited_from_type?: string;
  inherited_from_name?: string;
};
type RawAssignment = {
  principal?: string;
  privileges?: RawPrivilege[];
};
type RawGrantsResponse = {
  privilege_assignments?: RawAssignment[];
  next_page_token?: string;
};

/** Empty-grants-state suggestion (securable exists, nothing visible here):
 * walk up to the parent's *grants*, since inherited privileges come from a
 * broader scope — table/volume/function -> parent schema's grants, schema
 * -> parent catalog's grants, catalog -> browse its schemas. */
function emptyGrantsHelp(
  type: SecurableType,
  name: string,
  p: string,
): string[] {
  const dot = name.lastIndexOf(".");
  if (type === "catalog" || dot < 0) {
    return [`databricks-axi catalog schemas ${name}${p}`];
  }
  const parentName = name.slice(0, dot);
  const parentType: SecurableType = type === "schema" ? "catalog" : "schema";
  return [`databricks-axi catalog grants ${parentType} ${parentName}${p}`];
}

const LIST_SUBCOMMAND: Record<SecurableType, string> = {
  catalog: "catalogs",
  schema: "schemas",
  table: "tables",
  volume: "volumes",
  function: "functions",
};

/** NOT_FOUND-state suggestion (the securable itself failed to resolve):
 * point at the list command for the level that failed, same idiom as
 * schemasList/scopedList's own NOT_FOUND help — never re-derive a
 * suggestion from the missing name itself, which fails identically (a
 * missing catalog's "browse its schemas" line names that same catalog). */
function notFoundGrantsHelp(
  type: SecurableType,
  name: string,
  p: string,
): string[] {
  if (type === "catalog") {
    return [`databricks-axi catalog catalogs${p}`];
  }
  const dot = name.lastIndexOf(".");
  const parent = dot < 0 ? name : name.slice(0, dot);
  return [`databricks-axi catalog ${LIST_SUBCOMMAND[type]} ${parent}${p}`];
}

async function grantsGet(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    principal: "value",
    full: "boolean",
    fields: "value",
  });
  const type = positional[0];
  if (!type || !isSecurableType(type)) {
    throw usage(
      type
        ? `Unknown securable type: ${type}`
        : "catalog grants requires <securable-type> <name>",
      [`Valid securable types: ${SECURABLE_TYPES.join(", ")}`],
    );
  }
  const name = requireId(
    positional.slice(1),
    `catalog grants ${type} <name>`,
    /^[^-]/,
  );
  const principal = flags.get("principal");
  const p = profileSuffix(flags.get("profile"));
  const notFoundBase = notFoundGrantsHelp(type, name, p);
  // F2 — help selection at the call site, by the flag we passed, not by
  // re-parsing the error: a bad --principal and a missing securable are
  // both "Could not find X" upstream, but only the --principal path can
  // usefully say "drop --principal to list every principal with grants".
  // Either way this is the NOT_FOUND-state help (the securable/principal
  // failed to resolve) — distinct from emptyGrantsHelp below (the
  // securable resolved fine, it just has nothing visible here).
  const notFoundHelp =
    typeof principal === "string"
      ? [
          `databricks-axi catalog grants ${type} ${name}${p}  (drop --principal to list every principal with grants)`,
          `databricks-axi whoami${p}`,
          ...notFoundBase,
        ]
      : notFoundBase;

  const assignments: RawAssignment[] = [];
  let pageToken: string | undefined;
  for (;;) {
    const argv = ["grants", "get-effective", type, name, "--max-results", "0"];
    if (typeof principal === "string") {
      argv.push("--principal", principal);
    }
    if (pageToken) {
      argv.push("--page-token", pageToken);
    }
    const page = assertObject<RawGrantsResponse>(
      await runWithNotFoundHelp(argv, spawnOpts(flags), notFoundHelp),
      "grants get-effective",
    );
    assignments.push(...(page.privilege_assignments ?? []));
    // Deprecation notice: "a page may contain zero results while still
    // providing a next_page_token; clients must continue reading pages
    // until next_page_token is absent" — so a zero-result page with a
    // token must not stop the loop. But a constant/cycling token from a
    // server bug must not spin forever either (AGENTS.md: never
    // auto-paginate unboundedly) — each spawn has its own timeout, so
    // nothing else would trip on a runaway loop.
    if (!page.next_page_token || page.next_page_token === pageToken) {
      break;
    }
    pageToken = page.next_page_token;
  }

  const full = flags.get("full") === true;
  const flattened = full
    ? assignments.flatMap((a) =>
        (a.privileges ?? []).map((pr) => ({
          principal: a.principal,
          privilege: pr.privilege,
          inherited_from_type: pr.inherited_from_type,
          inherited_from_name: pr.inherited_from_name,
        })),
      )
    : assignments.map((a) => ({
        principal: a.principal,
        privileges: (a.privileges ?? [])
          .map((pr) => pr.privilege)
          .filter(Boolean)
          .join(", "),
      }));
  const rows = renderRows(
    flattened,
    flags,
    full
      ? ["principal", "privilege", "inherited_from_type", "inherited_from_name"]
      : ["principal", "privileges"],
  );

  // Hand-built envelope (documented listResult exemption #5): no agent-
  // facing --limit, the page loop drains every page.
  const out: AxiStructuredOutput = { grants: rows, count: rows.length };
  if (rows.length === 0) {
    out.status = `no effective grants on ${type} ${name} for the caller's visibility`;
    out.help = emptyGrantsHelp(type, name, p);
    return out;
  }
  // --full is dead advice to a caller who already passed it.
  out.help = full
    ? emptyGrantsHelp(type, name, p)
    : [
        `databricks-axi catalog grants ${type} ${name} --full${p}`,
        ...emptyGrantsHelp(type, name, p),
      ];
  return out;
}

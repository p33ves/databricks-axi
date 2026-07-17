import {
  assertObject,
  domainHelpers,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs } = domainHelpers("permissions");

// Allow-list = the inclusion rule (spec §4.3): an object type is in only if
// (a) an existing axi command prints its id and (b) a well-formed missing id
// classifies as NOT_FOUND upstream. This also doubles as the leading-dash
// guard on <object-type> — none of these five literal strings starts with
// "-", so a smuggled flag can never pass as a type.
const OBJECT_TYPES = [
  "jobs",
  "clusters",
  "pipelines",
  "warehouses",
  "dashboards",
] as const;
type ObjectType = (typeof OBJECT_TYPES)[number];

const LIST_COMMAND: Record<ObjectType, string> = {
  jobs: "databricks-axi jobs list",
  clusters: "databricks-axi clusters list",
  pipelines: "databricks-axi pipelines list",
  warehouses: "databricks-axi sql warehouses",
  dashboards: "databricks-axi dashboards list",
};

const API_ESCAPE_HATCH =
  "Other object types: databricks-axi api get /api/2.0/permissions/<type>/<id>";

export const PERMISSIONS_HELP = `usage: databricks-axi permissions <object-type> <id> [flags]
object-types[5]:
  jobs, clusters, pipelines, warehouses, dashboards
flags:
  --full            one row per (principal, level) with inheritance
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi permissions jobs 88440223843221
  databricks-axi permissions dashboards 01f18184706f11da846a179c97fcc018 --full
notes:
  read-only workspace-object ACLs; ids come from jobs list / clusters list /
  pipelines list / sql warehouses / dashboards list
  dashboards means AI/BI (Lakeview); legacy DBSQL dashboards and the other
  object types: databricks-axi api get /api/2.0/permissions/<type>/<id>
  Unity Catalog grants are a different surface — use
  databricks-axi catalog grants <type> <name>
`;

type RawPrincipalPermission = {
  inherited?: boolean;
  inherited_from_object?: string[];
  permission_level?: string;
};
type RawAcl = {
  user_name?: string;
  group_name?: string;
  service_principal_name?: string;
  all_permissions?: RawPrincipalPermission[];
};
type RawPermissions = {
  access_control_list?: RawAcl[];
  object_id?: string;
  object_type?: string;
};

function isObjectType(value: string): value is ObjectType {
  return (OBJECT_TYPES as readonly string[]).includes(value);
}

function principalOf(entry: RawAcl): string | undefined {
  return entry.user_name ?? entry.group_name ?? entry.service_principal_name;
}

function principalType(entry: RawAcl): string {
  if (entry.user_name) {
    return "user";
  }
  if (entry.group_name) {
    return "group";
  }
  if (entry.service_principal_name) {
    return "service_principal";
  }
  return "unknown";
}

function compactRows(acl: RawAcl[]): AxiStructuredOutput[] {
  return acl.map((entry) => ({
    principal: principalOf(entry),
    permissions: (entry.all_permissions ?? [])
      .map((perm) => perm.permission_level)
      .filter(Boolean)
      .join(", "),
  }));
}

function fullRows(acl: RawAcl[]): AxiStructuredOutput[] {
  const rows: AxiStructuredOutput[] = [];
  for (const entry of acl) {
    const principal = principalOf(entry);
    const type = principalType(entry);
    for (const perm of entry.all_permissions ?? []) {
      rows.push({
        principal,
        type,
        level: perm.permission_level,
        inherited: perm.inherited,
        inherited_from: (perm.inherited_from_object ?? []).join(", "),
      });
    }
  }
  return rows;
}

// The single read verb — no subcommand dispatch (spec §3): the type is the
// first positional, mirroring `api <method> <path>`.
export async function permissionsCommand(
  args: string[],
): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const type = positional[0];
  if (!type || !isObjectType(type)) {
    throw usage(
      type
        ? `Unknown permissions object type: ${type}`
        : "permissions requires <object-type> <id>",
      [`Valid object types: ${OBJECT_TYPES.join(", ")}`, API_ESCAPE_HATCH],
    );
  }
  const id = positional[1];
  // Non-empty, leading-dash guard only (spec §4.3) — no per-type id-shape
  // validation: upstream's own "<x> does not exist" is already the right
  // message for a well-formed-but-missing id, and 5 id formats aren't worth
  // a shape table.
  if (!id || positional.length > 2 || !/^[^-]/.test(id)) {
    throw usage(`Usage: databricks-axi permissions ${type} <id>`);
  }
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const parsed = assertObject<RawPermissions>(
    await runWithNotFoundHelp(
      ["permissions", "get", type, id],
      spawnOpts(flags),
      [`${LIST_COMMAND[type]}${p}`],
    ),
    "permissions get",
  );
  const acl = parsed.access_control_list ?? [];
  const rows = full ? fullRows(acl) : compactRows(acl);

  const out: AxiStructuredOutput = {
    object_type: parsed.object_type,
    object_id: parsed.object_id,
    permissions: rows,
    count: rows.length,
  };
  // Empty state is keyed on the ACL itself, not on rows.length: fullRows
  // emits nothing for an entry whose all_permissions is absent/empty while
  // compactRows still emits a row for it, so keying on rows.length made
  // --full report "empty" on an ACL that plainly has entries.
  if (acl.length === 0) {
    out.status = `no access control entries visible on ${type} ${id}`;
    // --full is dead advice to a caller who already passed it.
    out.help = full
      ? [`databricks-axi doctor${p}`]
      : [
          `databricks-axi permissions ${type} ${id} --full${p}`,
          `databricks-axi doctor${p}`,
        ];
    return out;
  }
  const help: string[] = [];
  if (!full) {
    help.push(`databricks-axi permissions ${type} ${id} --full${p}`);
  }
  if (type === "dashboards") {
    help.push(`databricks-axi dashboards view ${id}${p}`);
  }
  if (help.length > 0) {
    out.help = help;
  }
  return out;
}

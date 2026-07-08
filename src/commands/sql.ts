import { AxiError } from "axi-sdk-js";
import {
  runDatabricks,
  runDatabricksApi,
  type RunDatabricksOptions,
} from "../databricks.js";
import { redactSecrets } from "../errors.js";

type AxiStructuredOutput = Record<string, unknown>;
type AxiRenderable = string | AxiStructuredOutput;

export const SQL_HELP = `usage: databricks-axi sql <subcommand> [args] [flags]
subcommands[6]:
  warehouses [--fields a,b]
  warehouses view <id>
  warehouses start <id> [--wait]
  warehouses stop <id> [--wait]
  exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]
  statement view <statement_id>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi sql warehouses
  databricks-axi sql exec "SELECT count(*) FROM workspace.default.my_table"
  databricks-axi sql statement view <statement_id>
notes:
  exec picks the warehouse automatically when the workspace has exactly one
  exec waits up to --timeout seconds (default 120), then exits 0 with the
  statement id — resume with sql statement view
  warehouse start/stop are async by default; --wait blocks up to ~20 min
`;

// Injectable so poll tests run at full speed.
export const sqlPoll = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

const STATEMENTS_PATH = "/api/2.0/sql/statements";
const SUBMIT_TIMEOUT_MS = 60_000; // must exceed the API-side 50s wait_timeout
const WAIT_TIMEOUT_MS = 25 * 60_000; // upstream blocks up to 20 min on --wait
const POLL_INTERVAL_MS = 2_000;
const DEFAULT_ROW_LIMIT = 100;
const DEFAULT_BUDGET_S = 120;

type RawWarehouse = {
  id?: string;
  name?: string;
  state?: string;
  cluster_size?: string;
  enable_serverless_compute?: boolean;
  auto_stop_mins?: number;
  creator_name?: string;
} & Record<string, unknown>;

type RawStatement = {
  statement_id?: string;
  status?: {
    state?: string;
    sql_state?: string;
    error?: { error_code?: string; message?: string };
  };
  manifest?: {
    schema?: { columns?: { name?: string; type_text?: string }[] };
    total_chunk_count?: number;
    total_row_count?: number;
    truncated?: boolean;
  };
  result?: { data_array?: unknown[][] };
};

export async function sqlCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "warehouses":
      switch (rest[0]) {
        case "view":
          return warehousesView(rest.slice(1));
        case "start":
        case "stop":
          return warehousesStartStop(rest[0], rest.slice(1));
        default:
          return warehousesList(rest);
      }
    case "exec":
      return sqlExec(rest);
    case "statement":
      if (rest[0] !== "view") {
        throw usage("Usage: databricks-axi sql statement view <statement_id>");
      }
      return statementView(rest.slice(1));
    default:
      throw usage(
        sub ? `Unknown sql subcommand: ${sub}` : "sql requires a subcommand",
      );
  }
}

// --- warehouses ---

function warehouseSize(w: RawWarehouse): string {
  const size = w.cluster_size ?? "";
  return w.enable_serverless_compute ? `${size} (serverless)`.trim() : size;
}

async function listWarehouses(
  opts: RunDatabricksOptions,
): Promise<RawWarehouse[]> {
  const parsed = await runDatabricks(["warehouses", "list"], opts);
  if (Array.isArray(parsed)) {
    return parsed as RawWarehouse[];
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  return (obj["warehouses"] as RawWarehouse[] | undefined) ?? [];
}

async function warehousesList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    fields: "value",
  });
  if (positional.length > 0) {
    throw usage(`sql warehouses takes no arguments, got: ${positional[0]}`);
  }
  const items = await listWarehouses(spawnOpts(flags));
  const p = profileSuffix(flags.get("profile"));
  if (items.length === 0) {
    return {
      warehouses: [],
      status: "no SQL warehouses in this workspace",
      help: ["Create one in the workspace UI: SQL Warehouses > Create"],
    };
  }
  const flattened = items.map((w) => ({ ...w, size: warehouseSize(w) }));
  const rows = renderRows(flattened, flags, ["id", "name", "state", "size"]);
  const help = [`databricks-axi sql exec "<query>" --warehouse <id>${p}`];
  const stopped = items.find((w) => w.state === "STOPPED");
  if (stopped) {
    help.push(`databricks-axi sql warehouses start ${stopped.id}${p}`);
  }
  return { warehouses: rows, count: rows.length, help };
}

async function warehousesView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const id = requireId(positional, "sql warehouses view <id>");
  const w = (await runDatabricks(
    ["warehouses", "get", id],
    spawnOpts(flags),
  )) as RawWarehouse;
  const p = profileSuffix(flags.get("profile"));
  return {
    id: w.id,
    name: w.name,
    state: w.state,
    size: warehouseSize(w),
    auto_stop_mins: w.auto_stop_mins,
    creator_name: w.creator_name,
    help: [
      w.state === "RUNNING"
        ? `databricks-axi sql warehouses stop ${id}${p}`
        : `databricks-axi sql warehouses start ${id}${p}`,
      `databricks-axi sql exec "<query>" --warehouse ${id}${p}`,
    ],
  };
}

async function warehousesStartStop(
  verb: "start" | "stop",
  args: string[],
): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    wait: "boolean",
  });
  const id = requireId(positional, `sql warehouses ${verb} <id> [--wait]`);
  const wait = flags.get("wait") === true;
  const p = profileSuffix(flags.get("profile"));
  const argv = ["warehouses", verb, id];
  if (!wait) {
    argv.push("--no-wait");
  }
  // Upstream is already idempotent here: start-on-RUNNING / stop-on-STOPPED
  // exit 0 with no output (pinned live 2026-07-07), so no no-op mapping.
  await runDatabricks(argv, {
    ...spawnOpts(flags),
    ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
    timeoutHelp: [
      `The ${verb} may have applied despite the timeout — check state:`,
      `databricks-axi sql warehouses view ${id}${p}`,
    ],
  });
  return {
    id,
    status: `${verb} requested`,
    help: [`databricks-axi sql warehouses view ${id}${p}`],
  };
}

// --- exec / statement view ---

async function sqlExec(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    warehouse: "value",
    limit: "value",
    timeout: "value",
    full: "boolean",
  });
  const query = positional[0];
  if (!query || positional.length > 1) {
    throw usage('Usage: databricks-axi sql exec "<query>" [--warehouse <id>]');
  }
  const limit = parsePositiveInt(flags, "limit", DEFAULT_ROW_LIMIT);
  const budgetS = parseNonNegativeInt(flags, "timeout", DEFAULT_BUDGET_S);
  const full = flags.get("full") === true;
  const opts = spawnOpts(flags);
  const p = profileSuffix(flags.get("profile"));
  const warehouseId = await resolveWarehouse(flags.get("warehouse"), opts);

  const deadline = Date.now() + budgetS * 1000;
  let stmt = (await runDatabricksApi(
    "post",
    STATEMENTS_PATH,
    JSON.stringify({
      statement: query,
      warehouse_id: warehouseId,
      wait_timeout: "50s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      row_limit: limit,
    }),
    { ...opts, timeoutMs: SUBMIT_TIMEOUT_MS },
  )) as RawStatement;

  while (isPendingState(stmt)) {
    if (Date.now() >= deadline) {
      return {
        statement_id: stmt.statement_id,
        state: stmt.status?.state,
        status: `still running — stopped waiting after ${budgetS}s (statement continues server-side)`,
        help: [`databricks-axi sql statement view ${stmt.statement_id}${p}`],
      };
    }
    await sqlPoll.sleep(POLL_INTERVAL_MS);
    stmt = (await runDatabricksApi(
      "get",
      `${STATEMENTS_PATH}/${stmt.statement_id}`,
      undefined,
      opts,
    )) as RawStatement;
  }
  return renderTerminalStatement(stmt, { full, limit, opts, p });
}

async function statementView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const id = requireId(positional, "sql statement view <statement_id>");
  const opts = spawnOpts(flags);
  const p = profileSuffix(flags.get("profile"));
  const stmt = (await runDatabricksApi(
    "get",
    `${STATEMENTS_PATH}/${id}`,
    undefined,
    opts,
  )) as RawStatement;
  if (isPendingState(stmt)) {
    return {
      statement_id: stmt.statement_id ?? id,
      state: stmt.status?.state,
      help: [`databricks-axi sql statement view ${id}${p}`],
    };
  }
  return renderTerminalStatement(stmt, {
    full: flags.get("full") === true,
    opts,
    p,
  });
}

function isPendingState(stmt: RawStatement): boolean {
  const state = stmt.status?.state;
  return state === "PENDING" || state === "RUNNING";
}

async function resolveWarehouse(
  flagValue: unknown,
  opts: RunDatabricksOptions,
): Promise<string> {
  if (typeof flagValue === "string") {
    return flagValue;
  }
  const warehouses = await listWarehouses(opts);
  if (warehouses.length === 1 && warehouses[0].id) {
    return warehouses[0].id;
  }
  if (warehouses.length === 0) {
    throw new AxiError("no SQL warehouses in this workspace", "NOT_FOUND", [
      "Create one in the workspace UI: SQL Warehouses > Create",
    ]);
  }
  throw usage(
    "multiple SQL warehouses — pick one with --warehouse <id>",
    warehouses.map((w) => `${w.id}: ${w.name}`),
  );
}

async function renderTerminalStatement(
  stmt: RawStatement,
  ctx: {
    full: boolean;
    limit?: number;
    opts: RunDatabricksOptions;
    p: string;
  },
): Promise<AxiStructuredOutput> {
  const state = stmt.status?.state ?? "UNKNOWN";
  const id = stmt.statement_id;
  if (state !== "SUCCEEDED") {
    const detail = stmt.status?.error?.message ?? `statement ${state}`;
    throw new AxiError(
      redactSecrets(detail),
      "SQL_ERROR",
      id ? [`databricks-axi sql statement view ${id}${ctx.p}`] : [],
    );
  }
  const manifest = stmt.manifest ?? {};
  const columns = (manifest.schema?.columns ?? []).map(
    (c) => `${c.name}:${c.type_text}`,
  );
  let rows = stmt.result?.data_array ?? [];
  const totalChunks = manifest.total_chunk_count ?? 1;
  const totalRows = manifest.total_row_count ?? rows.length;
  if (ctx.full && totalChunks > 1 && id) {
    for (let chunk = 1; chunk < totalChunks; chunk++) {
      const next = (await runDatabricksApi(
        "get",
        `${STATEMENTS_PATH}/${id}/result/chunks/${chunk}`,
        undefined,
        ctx.opts,
      )) as { data_array?: unknown[][] };
      rows = rows.concat(next.data_array ?? []);
    }
  }
  const out: AxiStructuredOutput = {
    statement_id: id,
    columns,
    rows,
    total_row_count: totalRows,
  };
  if (!ctx.full && totalChunks > 1) {
    out.truncated = `showing ${rows.length} of ${totalRows} rows — rerun with --full`;
  } else if (manifest.truncated) {
    // Server-side row_limit hit: --full can never exceed the submitted cap.
    out.truncated = `result capped at ${totalRows} rows — rerun with --limit ${
      (ctx.limit ?? totalRows) * 2
    }`;
  }
  return out;
}

// --- shared helpers (jobs-pattern; extraction into a module is CP2) ---

type FlagSpec = Record<string, "value" | "boolean">;
type Flags = Map<string, string | boolean>;

function parseArgs(
  args: string[],
  spec: FlagSpec,
): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (!kind) {
      const valid = Object.keys(spec)
        .map((f) => `--${f}`)
        .join(", ");
      throw usage(`Unknown flag: --${name}`, [`Valid flags: ${valid}`]);
    }
    if (kind === "boolean") {
      flags.set(name, true);
      continue;
    }
    const value = args[++i];
    if (value === undefined) {
      throw usage(`Flag --${name} requires a value`);
    }
    flags.set(name, value);
  }
  return { positional, flags };
}

function usage(message: string, extraHelp: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [
    ...extraHelp,
    "Run `databricks-axi sql --help`",
  ]);
}

function parsePositiveInt(
  flags: Flags,
  name: string,
  fallback: number,
): number {
  const value = parseNonNegativeInt(flags, name, fallback);
  if (value < 1) {
    throw usage(`--${name} must be a positive integer`);
  }
  return value;
}

function parseNonNegativeInt(
  flags: Flags,
  name: string,
  fallback: number,
): number {
  const raw = flags.get(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw usage(
      `--${name} must be a non-negative integer, got: ${String(raw)}`,
    );
  }
  return value;
}

function requireId(positional: string[], usageText: string): string {
  const id = positional[0];
  if (!id || positional.length > 1) {
    throw usage(`Usage: databricks-axi ${usageText}`);
  }
  return id;
}

function spawnOpts(flags: Flags): RunDatabricksOptions {
  const profile = flags.get("profile");
  return typeof profile === "string" ? { profile } : {};
}

/** Suffix for suggested follow-up commands so they hit the same workspace. */
function profileSuffix(profile: unknown): string {
  return typeof profile === "string" ? ` --profile ${profile}` : "";
}

/** Apply --fields (raw top-level keys) or the default field list. */
function renderRows(
  items: Record<string, unknown>[],
  flags: Flags,
  defaults: string[],
): Record<string, unknown>[] {
  const spec = flags.get("fields");
  const fields =
    typeof spec === "string"
      ? spec
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : defaults;
  if (typeof spec === "string" && items.length > 0) {
    const known = new Set(items.flatMap((item) => Object.keys(item)));
    for (const field of fields) {
      if (!known.has(field)) {
        throw usage(`Unknown field: ${field}`, [
          `Available fields: ${[...known].sort().join(", ")}`,
        ]);
      }
    }
  }
  return items.map((item) =>
    Object.fromEntries(fields.map((field) => [field, item[field] ?? ""])),
  );
}

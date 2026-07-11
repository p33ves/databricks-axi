import { AxiError } from "axi-sdk-js";
import {
  runDatabricks,
  runDatabricksApi,
  type RunDatabricksOptions,
} from "../databricks.js";
import { redactSecrets } from "../errors.js";
import {
  asList,
  assertObject,
  domainHelpers,
  profileSuffix,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs, parseIntFlag, requireId, renderRows } =
  domainHelpers("sql");

export const SQL_HELP = `usage: databricks-axi sql <subcommand> [args] [flags]
subcommands[7]:
  warehouses [--fields a,b]
  warehouses view <id>
  warehouses start <id> [--wait]
  warehouses stop <id> [--wait]
  exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]
  statement view <statement_id>
  history [--limit N] [--status S] [--full] [--fields a,b]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi sql warehouses
  databricks-axi sql exec "SELECT count(*) FROM workspace.default.my_table"
  databricks-axi sql statement view <statement_id>
  databricks-axi sql history --status FAILED
notes:
  exec picks the warehouse automatically when the workspace has exactly one
  exec waits up to --timeout seconds (default 120), then exits 0 with the
  statement id — resume with sql statement view
  warehouse start/stop are async by default; --wait blocks up to ~20 min
  history is read-only diagnosis over recent query activity; --status
  filters client-side within the fetched window; it never starts a warehouse
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
const DEFAULT_HISTORY_LIMIT = 20;
const QUERY_TEXT_CLIP = 120;

type RawWarehouse = {
  id?: string;
  name?: string;
  state?: string;
  cluster_size?: string;
  enable_serverless_compute?: boolean;
  auto_stop_mins?: number;
  creator_name?: string;
} & Record<string, unknown>;

type RawHistoryEntry = {
  query_id?: string;
  status?: string;
  query_text?: string;
  duration?: number;
  error_message?: string;
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
    case "history":
      return sqlHistory(rest);
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
  return asList(parsed, "warehouses") as RawWarehouse[];
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
  const w = assertObject<RawWarehouse>(
    await runDatabricks(["warehouses", "get", id], spawnOpts(flags)),
    "warehouses get",
  );
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
  const limit = parseIntFlag(flags, "limit", DEFAULT_ROW_LIMIT);
  const budgetS = parseIntFlag(flags, "timeout", DEFAULT_BUDGET_S, 0);
  const full = flags.get("full") === true;
  const opts = spawnOpts(flags);
  const p = profileSuffix(flags.get("profile"));
  const warehouseId = await resolveWarehouse(flags.get("warehouse"), opts);

  const deadline = Date.now() + budgetS * 1000;
  const waitTimeoutS = Math.max(5, Math.min(budgetS, 50));
  let stmt = assertObject<RawStatement>(
    await runDatabricksApi(
      "post",
      STATEMENTS_PATH,
      JSON.stringify({
        statement: query,
        warehouse_id: warehouseId,
        wait_timeout: `${waitTimeoutS}s`,
        on_wait_timeout: "CONTINUE",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: limit,
      }),
      { ...opts, timeoutMs: SUBMIT_TIMEOUT_MS },
    ),
    "sql statement submit",
  );

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
    stmt = assertObject<RawStatement>(
      await runDatabricksApi(
        "get",
        `${STATEMENTS_PATH}/${stmt.statement_id}`,
        undefined,
        opts,
      ),
      "sql statement poll",
    );
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
  const stmt = assertObject<RawStatement>(
    await runDatabricksApi("get", `${STATEMENTS_PATH}/${id}`, undefined, opts),
    "sql statement get",
  );
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
      const next = assertObject<{ data_array?: unknown[][] }>(
        await runDatabricksApi(
          "get",
          `${STATEMENTS_PATH}/${id}/result/chunks/${chunk}`,
          undefined,
          ctx.opts,
        ),
        "sql statement chunk fetch",
      );
      rows = rows.concat(next.data_array ?? []);
    }
  }
  const out: AxiStructuredOutput = {
    statement_id: id,
    columns,
    rows,
    total_row_count: totalRows,
  };
  const notes: string[] = [];
  if (!ctx.full && totalChunks > 1) {
    notes.push(
      `showing ${rows.length} of ${totalRows} rows — rerun with --full`,
    );
  }
  if (manifest.truncated) {
    // Server-side row_limit hit: --full can never exceed the submitted cap,
    // so report what was actually delivered, not the true upstream total.
    notes.push(
      `result capped at ${rows.length} rows — rerun with --limit ${
        (ctx.limit ?? rows.length) * 2
      }`,
    );
  }
  if (notes.length > 0) {
    out.truncated = notes.join("; ");
  }
  return out;
}

// --- history ---

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Spread-raw row (keeps upstream keys reachable via --fields), then
 * override/add the derived display fields — the `warehouseSize` precedent. */
function flattenHistoryEntry(
  entry: RawHistoryEntry,
  full: boolean,
): AxiStructuredOutput {
  const { duration, ...rest } = entry;
  const rawErrorMessage = entry.error_message;
  const errorMessage =
    typeof rawErrorMessage === "string"
      ? redactSecrets(rawErrorMessage)
      : rawErrorMessage;
  const queryText = entry.query_text ?? "";
  return {
    ...rest,
    query_text: full ? queryText : clip(queryText, QUERY_TEXT_CLIP),
    duration_ms: duration,
    error_message: errorMessage,
    error: errorMessage
      ? full
        ? errorMessage
        : String(errorMessage).split("\n")[0]
      : "",
  };
}

async function sqlHistory(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    limit: "value",
    status: "value",
    full: "boolean",
    fields: "value",
  });
  if (positional.length > 0) {
    throw usage(`sql history takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", DEFAULT_HISTORY_LIMIT);
  const full = flags.get("full") === true;
  const statusFilter = flags.get("status");
  const p = profileSuffix(flags.get("profile"));
  // query-history is the one endpoint with real server-side pagination
  // (has_next_page/next_page_token) — unlike the dual-mode bare-array-or-
  // object list responses elsewhere, it's always object-enveloped, so
  // assertObject (not asList) is the correct shape guard here.
  const parsed = assertObject<{
    res?: RawHistoryEntry[];
    has_next_page?: boolean;
  }>(
    await runDatabricks(
      ["query-history", "list", "--max-results", String(limit)],
      spawnOpts(flags),
    ),
    "query-history list",
  );
  const raw = parsed.res ?? [];
  if (raw.length === 0) {
    return {
      history: [],
      status: "no queries in this workspace's query history",
      help: [
        "only warehouse / serverless SQL queries are recorded here",
        `databricks-axi sql exec "<query>"${p}`,
      ],
    };
  }

  const flattened = raw.map((entry) => flattenHistoryEntry(entry, full));
  const filtered =
    typeof statusFilter === "string"
      ? flattened.filter(
          (row) =>
            String(row.status).toUpperCase() === statusFilter.toUpperCase(),
        )
      : flattened;

  if (filtered.length === 0 && typeof statusFilter === "string") {
    return {
      history: [],
      status: `no ${statusFilter.toUpperCase()} queries in the most recent ${raw.length}`,
      help: [
        `databricks-axi sql history --limit ${limit * 2}${p}`,
        `databricks-axi sql history${p}`,
      ],
    };
  }

  const rows = renderRows(filtered, flags, [
    "query_id",
    "status",
    "query_text",
    "error",
  ]);
  const help: string[] = [];
  if (parsed.has_next_page) {
    help.push(`databricks-axi sql history --limit ${limit * 2}${p}`);
  }
  if (
    typeof statusFilter !== "string" &&
    filtered.some((row) => row.status === "FAILED")
  ) {
    help.push(`databricks-axi sql history --status FAILED${p}`);
  }
  help.push(`databricks-axi sql exec "<query>"${p}`);
  const out: AxiStructuredOutput = { history: rows, count: rows.length };
  if (parsed.has_next_page) {
    out.has_more = true;
  }
  if (!full) {
    const truncatedCount = filtered.filter((row) =>
      String(row.query_text).endsWith("…"),
    ).length;
    if (truncatedCount > 0) {
      out.truncated = `${truncatedCount} row(s) have longer query_text — rerun with --full`;
    }
  }
  out.help = help;
  return out;
}

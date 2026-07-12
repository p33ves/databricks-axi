import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sqlPoll } from "../src/commands/sql.js";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();
const realSleep = sqlPoll.sleep;

beforeEach(() => {
  sqlPoll.sleep = async () => {};
});
afterEach(() => {
  sqlPoll.sleep = realSleep;
});

// Shapes pinned against a live Free Edition workspace on 2026-07-07.
const WH_ID = "43dc9c412f8e5b4c";
const WAREHOUSE = {
  id: WH_ID,
  name: "Starter Warehouse",
  state: "STOPPED",
  cluster_size: "2X-Small",
  enable_serverless_compute: true,
  auto_stop_mins: 10,
  creator_name: "a@b.c",
  jdbc_url: "jdbc:spark://host:443/default;transportMode=http",
};
const STMT_ID = "01f17a90-ff14-1510-9417-45fa23940d1a";
const STMT_PATH = `/api/2.0/sql/statements/${STMT_ID}`;

function succeededStmt(overrides: Record<string, unknown> = {}) {
  return {
    manifest: {
      chunks: [{ chunk_index: 0, row_count: 2, row_offset: 0 }],
      format: "JSON_ARRAY",
      schema: {
        column_count: 2,
        columns: [
          { name: "one", position: 0, type_name: "INT", type_text: "INT" },
          { name: "s", position: 1, type_name: "STRING", type_text: "STRING" },
        ],
      },
      total_chunk_count: 1,
      total_row_count: 2,
      truncated: false,
      ...(overrides["manifest"] as object),
    },
    result: (overrides["result"] as object) ?? {
      chunk_index: 0,
      data_array: [
        ["1", "x"],
        ["2", "y"],
      ],
      row_count: 2,
      row_offset: 0,
    },
    statement_id: STMT_ID,
    status: { state: "SUCCEEDED" },
  };
}

function submittedBody(): Record<string, unknown> {
  const [json] = t.fake.bodies();
  expect(json).toBeDefined();
  return JSON.parse(json) as Record<string, unknown>;
}

describe("sql warehouses", () => {
  it("lists with default fields and a serverless size marker", async () => {
    t.fake.respond("warehouses list", [WAREHOUSE]);
    const { out, exitCode } = await t.run(["sql", "warehouses"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["warehouses", "list", "-o", "json"]]);
    expect(out).toContain("warehouses[1]{id,name,state,size}:");
    expect(out).toContain("2X-Small (serverless)");
  });

  it("suggests starting STOPPED warehouses", async () => {
    t.fake.respond("warehouses list", [WAREHOUSE]);
    const { out } = await t.run(["sql", "warehouses"]);
    expect(out).toContain(`sql warehouses start ${WH_ID}`);
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("warehouses list", []);
    const { out, exitCode } = await t.run(["sql", "warehouses"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no SQL warehouses in this workspace");
  });

  it("rejects unknown --fields keys listing the known ones", async () => {
    t.fake.respond("warehouses list", [WAREHOUSE]);
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "--fields",
      "id,bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("bogus");
    expect(out).toContain("Available fields");
  });

  it("views one warehouse without jdbc_url", async () => {
    t.fake.respond("warehouses get", { ...WAREHOUSE, state: "RUNNING" });
    const { out, exitCode } = await t.run(["sql", "warehouses", "view", WH_ID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["warehouses", "get", WH_ID, "-o", "json"],
    ]);
    expect(out).toContain("auto_stop_mins: 10");
    expect(out).not.toContain("jdbc");
    expect(out).toContain(`sql warehouses stop ${WH_ID}`);
  });

  it("suggests start when the viewed warehouse is stopped", async () => {
    t.fake.respond("warehouses get", WAREHOUSE);
    const { out } = await t.run(["sql", "warehouses", "view", WH_ID]);
    expect(out).toContain(`sql warehouses start ${WH_ID}`);
  });

  it("maps an empty warehouses get response to a structured UPSTREAM_ERROR", async () => {
    t.fake.respondRaw("warehouses get", "");
    const { out, exitCode } = await t.run(["sql", "warehouses", "view", WH_ID]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });

  it("starts async by default (upstream no-op friendly)", async () => {
    t.fake.respondRaw("warehouses start", "");
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "start",
      WH_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["warehouses", "start", WH_ID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("start requested");
    expect(out).toContain(`sql warehouses view ${WH_ID}`);
  });

  it("stops async by default", async () => {
    t.fake.respondRaw("warehouses stop", "");
    const { out, exitCode } = await t.run(["sql", "warehouses", "stop", WH_ID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["warehouses", "stop", WH_ID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("stop requested");
  });

  it("omits --no-wait with --wait and reports the reached state on start", async () => {
    t.fake.respondRaw("warehouses start", "");
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "start",
      WH_ID,
      "--wait",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["warehouses", "start", WH_ID, "-o", "json"],
    ]);
    expect(out).toContain("started, warehouse RUNNING");
    expect(out).not.toContain("start requested");
  });

  it("reports the reached state on stop --wait", async () => {
    t.fake.respondRaw("warehouses stop", "");
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "stop",
      WH_ID,
      "--wait",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["warehouses", "stop", WH_ID, "-o", "json"],
    ]);
    expect(out).toContain("stopped, warehouse STOPPED");
    expect(out).not.toContain("stop requested");
  });

  it("maps a genuine 403 to PERMISSION_DENIED, exit 1", async () => {
    t.fake.respondError(
      "warehouses start",
      "Error: PERMISSION_DENIED: no manage permission\n",
    );
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "start",
      WH_ID,
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("PERMISSION_DENIED");
  });

  it("maps a missing warehouse to NOT_FOUND with a warehouses-list suggestion", async () => {
    t.fake.respondError(
      "warehouses get",
      "Error: Warehouse 999 does not exist.",
    );
    const { out, exitCode } = await t.run(["sql", "warehouses", "view", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("sql warehouses");
  });

  it("maps a missing warehouse to NOT_FOUND on start", async () => {
    t.fake.respondError(
      "warehouses start",
      "Error: Warehouse 999 does not exist.",
    );
    const { out, exitCode } = await t.run([
      "sql",
      "warehouses",
      "start",
      "999",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("sql warehouses");
  });
});

describe("sql exec", () => {
  it("maps an empty submit response to a structured UPSTREAM_ERROR", async () => {
    t.fake.respondRaw("api post", "");
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });

  it("submits inline and renders columns, rows and total_row_count", async () => {
    t.fake.respond("api post", succeededStmt());
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(0);
    const body = submittedBody();
    expect(body).toEqual({
      statement: "SELECT 1",
      warehouse_id: WH_ID,
      wait_timeout: "50s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      row_limit: 100,
    });
    expect(out).toContain("one:INT");
    expect(out).toContain("s:STRING");
    expect(out).toContain('"1",x');
    expect(out).toContain("total_row_count: 2");
  });

  it("clamps wait_timeout to the --timeout budget", async () => {
    t.fake.respond("api post", succeededStmt());
    await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--timeout",
      "10",
    ]);
    expect(submittedBody()["wait_timeout"]).toBe("10s");
  });

  it("floors wait_timeout at the API's 5s minimum", async () => {
    t.fake.respond("api post", {
      statement_id: STMT_ID,
      status: { state: "RUNNING" },
    });
    await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--timeout",
      "0",
    ]);
    expect(submittedBody()["wait_timeout"]).toBe("5s");
  });

  it("passes --limit as row_limit", async () => {
    t.fake.respond("api post", succeededStmt());
    await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--limit",
      "5",
    ]);
    expect(submittedBody()["row_limit"]).toBe(5);
  });

  it("auto-picks the only warehouse when --warehouse is omitted", async () => {
    t.fake.respond("warehouses list", [WAREHOUSE]);
    t.fake.respond("api post", succeededStmt());
    const { exitCode } = await t.run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()[0]).toEqual(["warehouses", "list", "-o", "json"]);
    expect(submittedBody()["warehouse_id"]).toBe(WH_ID);
  });

  it("exits 1 NOT_FOUND with zero warehouses", async () => {
    t.fake.respond("warehouses list", []);
    const { out, exitCode } = await t.run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("NOT_FOUND");
  });

  it("exits 2 listing id: name pairs with multiple warehouses", async () => {
    t.fake.respond("warehouses list", [
      WAREHOUSE,
      { ...WAREHOUSE, id: "aaaabbbbccccdddd", name: "Other" },
    ]);
    const { out, exitCode } = await t.run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(2);
    expect(out).toContain(`${WH_ID}: Starter Warehouse`);
    expect(out).toContain("aaaabbbbccccdddd: Other");
  });

  it("polls until terminal and renders the result", async () => {
    t.fake.respond("api post", {
      statement_id: STMT_ID,
      status: { state: "PENDING" },
    });
    t.fake.respondSeq(`api get ${STMT_PATH}`, [
      { statement_id: STMT_ID, status: { state: "RUNNING" } },
      succeededStmt(),
    ]);
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toHaveLength(3);
    expect(t.fake.calls()[1]).toEqual(["api", "get", STMT_PATH, "-o", "json"]);
    expect(out).toContain("total_row_count: 2");
  });

  it("exits 0 with a resume hint when the --timeout budget expires", async () => {
    t.fake.respond("api post", {
      statement_id: STMT_ID,
      status: { state: "RUNNING" },
    });
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--timeout",
      "0",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toHaveLength(1);
    expect(out).toContain(STMT_ID);
    expect(out).toContain("state: RUNNING");
    expect(out).toContain(`sql statement view ${STMT_ID}`);
  });

  it("maps FAILED to SQL_ERROR exit 1 with the upstream message", async () => {
    t.fake.respond("api post", {
      statement_id: STMT_ID,
      status: {
        error: {
          error_code: "BAD_REQUEST",
          message:
            "[TABLE_OR_VIEW_NOT_FOUND] The table `nope` cannot be found. SQLSTATE: 42P01",
        },
        sql_state: "42P01",
        state: "FAILED",
      },
    });
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("SQL_ERROR");
    expect(out).toContain("TABLE_OR_VIEW_NOT_FOUND");
  });

  it("marks a server-side row cap with a --limit hint", async () => {
    t.fake.respond(
      "api post",
      succeededStmt({ manifest: { truncated: true, total_row_count: 2 } }),
    );
    const { out } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--limit",
      "2",
    ]);
    expect(out).toContain("capped at 2 rows");
    expect(out).toContain("--limit 4");
  });

  it("reports rows actually delivered, not the true upstream total, when capped", async () => {
    // total_row_count (50000) is the true upstream total; only 2 rows came
    // back inline because row_limit capped delivery — the message must say 2.
    t.fake.respond(
      "api post",
      succeededStmt({ manifest: { truncated: true, total_row_count: 50000 } }),
    );
    const { out } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--limit",
      "2",
    ]);
    expect(out).toContain("capped at 2 rows");
    expect(out).toContain("--limit 4");
    expect(out).not.toContain("capped at 50000");
  });

  it("shows both hints when a result is chunked and row-capped", async () => {
    t.fake.respond(
      "api post",
      succeededStmt({
        manifest: { total_chunk_count: 2, total_row_count: 3, truncated: true },
      }),
    );
    const { out } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--limit",
      "2",
    ]);
    expect(out).toContain("showing 2 of 3 rows");
    expect(out).toContain("--full");
    expect(out).toContain("capped at 2 rows");
    expect(out).toContain("--limit 4");
  });

  it("marks extra chunks with a --full hint", async () => {
    t.fake.respond(
      "api post",
      succeededStmt({ manifest: { total_chunk_count: 2, total_row_count: 3 } }),
    );
    const { out } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(out).toContain("showing 2 of 3 rows");
    expect(out).toContain("--full");
  });

  it("fetches remaining chunks with --full", async () => {
    t.fake.respond(
      "api post",
      succeededStmt({ manifest: { total_chunk_count: 2, total_row_count: 3 } }),
    );
    t.fake.respond(`api get ${STMT_PATH}/result/chunks/1`, {
      chunk_index: 1,
      data_array: [["3", "z"]],
      row_count: 1,
      row_offset: 2,
    });
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()[1]).toEqual([
      "api",
      "get",
      `${STMT_PATH}/result/chunks/1`,
      "-o",
      "json",
    ]);
    expect(out).toContain('"3",z');
    expect(out).toContain("rows[3]");
  });

  it("requires a query", async () => {
    const { exitCode } = await t.run(["sql", "exec"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a non-integer --timeout", async () => {
    const { exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--timeout",
      "abc",
    ]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("sql history", () => {
  const FAILED_ENTRY = {
    query_id: "01f1aaaa-0000-1111-2222-333344445555",
    status: "FAILED",
    query_text: "SELECT * FROM workspace.default.axi_bench_missing_src",
    duration: 1234,
    error_message:
      "[TABLE_OR_VIEW_NOT_FOUND] The table or view `axi_bench_missing_src` cannot be found. SQLSTATE: 42P01\nmore detail on line two",
    statement_type: "SELECT",
    warehouse_id: "43dc9c412f8e5b4c",
    query_start_time_ms: 1751900000000,
  };
  const FINISHED_ENTRY = {
    query_id: "01f1bbbb-0000-1111-2222-333344445555",
    status: "FINISHED",
    query_text: "SELECT count(*) FROM workspace.default.axi_bench_trips",
    duration: 512,
    error_message: "",
    statement_type: "SELECT",
    warehouse_id: "43dc9c412f8e5b4c",
    query_start_time_ms: 1751900001000,
  };

  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY, FINISHED_ENTRY],
      has_next_page: false,
    });
    const { out, exitCode } = await t.run(["sql", "history"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["query-history", "list", "--max-results", "20", "-o", "json"],
    ]);
    expect(out).toContain("history[2]{query_id,status,query_text,error}:");
  });

  it("filters client-side with --status, redacting the error's first line", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY, FINISHED_ENTRY],
      has_next_page: false,
    });
    const { out, exitCode } = await t.run([
      "sql",
      "history",
      "--status",
      "FAILED",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("history[1]");
    expect(out).toContain("axi_bench_missing_src");
    expect(out).toContain("TABLE_OR_VIEW_NOT_FOUND");
    expect(out).not.toContain("more detail on line two");
    expect(out).not.toContain("axi_bench_trips");
  });

  it("shows untrimmed query_text and full error_message under --full", async () => {
    const longText = `SELECT ${"x".repeat(200)} FROM workspace.default.t`;
    t.fake.respond("query-history list", {
      res: [{ ...FAILED_ENTRY, query_text: longText }],
      has_next_page: false,
    });
    const { out } = await t.run(["sql", "history", "--full"]);
    expect(out).toContain(longText);
    expect(out).toContain("more detail on line two");
  });

  it("clips a long query_text without --full", async () => {
    const longText = `SELECT ${"x".repeat(200)} FROM workspace.default.t`;
    t.fake.respond("query-history list", {
      res: [{ ...FAILED_ENTRY, query_text: longText }],
      has_next_page: false,
    });
    const { out } = await t.run(["sql", "history"]);
    expect(out).not.toContain(longText);
  });

  it("renders the truly-empty state", async () => {
    t.fake.respond("query-history list", { res: [], has_next_page: false });
    const { out, exitCode } = await t.run(["sql", "history"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no queries in this workspace's query history");
    expect(out).toContain("only warehouse / serverless SQL queries");
    expect(out).toContain("sql exec");
    expect(out).toContain("<query>");
  });

  it("flags has_next_page with a rerun-with-double-limit suggestion", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY],
      has_next_page: true,
    });
    const { out } = await t.run(["sql", "history"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("sql history --limit 40");
  });

  it("redacts a token-shaped error_message, leaving query_text intact", async () => {
    const token = "a".repeat(45);
    t.fake.respond("query-history list", {
      res: [{ ...FAILED_ENTRY, error_message: token }],
      has_next_page: false,
    });
    const { out } = await t.run(["sql", "history", "--full"]);
    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
    expect(out).toContain("axi_bench_missing_src");
  });

  it("rejects unknown --fields keys", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY],
      has_next_page: false,
    });
    const { out, exitCode } = await t.run([
      "sql",
      "history",
      "--fields",
      "bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: bogus");
  });

  it("allows --fields to reach a raw spread key", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY],
      has_next_page: false,
    });
    const { out, exitCode } = await t.run([
      "sql",
      "history",
      "--fields",
      "query_start_time_ms",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("1751900000000");
  });

  it("renders the filtered-empty state (not the truly-empty message) when --status matches nothing", async () => {
    t.fake.respond("query-history list", {
      res: [FINISHED_ENTRY],
      has_next_page: false,
    });
    const { out, exitCode } = await t.run([
      "sql",
      "history",
      "--status",
      "FAILED",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no FAILED queries in the most recent 1");
    expect(out).not.toContain("no queries in this workspace's query history");
  });

  it("suggests --status FAILED when a FAILED row is present and unfiltered", async () => {
    t.fake.respond("query-history list", {
      res: [FAILED_ENTRY, FINISHED_ENTRY],
      has_next_page: false,
    });
    const { out } = await t.run(["sql", "history"]);
    expect(out).toContain("sql history --status FAILED");
  });

  it("threads --profile into the exec suggestion", async () => {
    t.fake.respond("-p dev query-history list", {
      res: [FINISHED_ENTRY],
      has_next_page: false,
    });
    const { out } = await t.run(["sql", "history", "--profile", "dev"]);
    expect(out).toContain("sql exec");
    expect(out).toContain("<query>");
    expect(out).toContain("--profile dev");
  });
});

describe("sql statement view", () => {
  it("renders a terminal statement's results", async () => {
    t.fake.respond(`api get ${STMT_PATH}`, succeededStmt());
    const { out, exitCode } = await t.run([
      "sql",
      "statement",
      "view",
      STMT_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["api", "get", STMT_PATH, "-o", "json"]]);
    expect(out).toContain("total_row_count: 2");
  });

  it("shows state and a rerun hint while non-terminal", async () => {
    t.fake.respond(`api get ${STMT_PATH}`, {
      statement_id: STMT_ID,
      status: { state: "RUNNING" },
    });
    const { out, exitCode } = await t.run([
      "sql",
      "statement",
      "view",
      STMT_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("state: RUNNING");
    expect(out).toContain(`sql statement view ${STMT_ID}`);
  });

  it("maps a missing statement to NOT_FOUND with a history suggestion", async () => {
    t.fake.respondError(
      `api get ${STMT_PATH}`,
      "Error: RESOURCE_DOES_NOT_EXIST: Statement not found",
    );
    const { out, exitCode } = await t.run([
      "sql",
      "statement",
      "view",
      STMT_ID,
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("sql history");
  });

  it("rejects unknown sql subcommands", async () => {
    const { exitCode } = await t.run(["sql", "frobnicate"]);
    expect(exitCode).toBe(2);
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["sql", "history", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });

  it("attaches next-step help to a successful exec result", async () => {
    t.fake.respond("api post", succeededStmt());
    const { out, exitCode } = await t.run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("databricks-axi sql history");
  });
});

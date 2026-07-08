import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { sqlPoll } from "../src/commands/sql.js";
import {
  installFakeDatabricks,
  type FakeDatabricks,
} from "./helpers/fake-databricks.js";

let fake: FakeDatabricks;
let prevPath: string | undefined;
const realSleep = sqlPoll.sleep;

beforeEach(() => {
  fake = installFakeDatabricks();
  prevPath = process.env.PATH;
  process.env.PATH = `${fake.binDir}:${prevPath ?? ""}`;
  process.exitCode = undefined;
  sqlPoll.sleep = async () => {};
});
afterEach(() => {
  process.env.PATH = prevPath;
  process.exitCode = undefined;
  sqlPoll.sleep = realSleep;
});

async function run(argv: string[]): Promise<{ out: string; exitCode: number }> {
  let out = "";
  await main({ argv, stdout: { write: (c: string) => ((out += c), true) } });
  return {
    out,
    exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode),
  };
}

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
  const post = fake.calls().find((argv) => argv.includes("--json"));
  expect(post).toBeDefined();
  const json = post![post!.indexOf("--json") + 1];
  return JSON.parse(json) as Record<string, unknown>;
}

describe("sql warehouses", () => {
  it("lists with default fields and a serverless size marker", async () => {
    fake.respond("warehouses list", [WAREHOUSE]);
    const { out, exitCode } = await run(["sql", "warehouses"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([["warehouses", "list", "-o", "json"]]);
    expect(out).toContain("warehouses[1]{id,name,state,size}:");
    expect(out).toContain("2X-Small (serverless)");
  });

  it("suggests starting STOPPED warehouses", async () => {
    fake.respond("warehouses list", [WAREHOUSE]);
    const { out } = await run(["sql", "warehouses"]);
    expect(out).toContain(`sql warehouses start ${WH_ID}`);
  });

  it("renders a definitive empty state", async () => {
    fake.respond("warehouses list", []);
    const { out, exitCode } = await run(["sql", "warehouses"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no SQL warehouses in this workspace");
  });

  it("rejects unknown --fields keys listing the known ones", async () => {
    fake.respond("warehouses list", [WAREHOUSE]);
    const { out, exitCode } = await run([
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
    fake.respond("warehouses get", { ...WAREHOUSE, state: "RUNNING" });
    const { out, exitCode } = await run(["sql", "warehouses", "view", WH_ID]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([["warehouses", "get", WH_ID, "-o", "json"]]);
    expect(out).toContain("auto_stop_mins: 10");
    expect(out).not.toContain("jdbc");
    expect(out).toContain(`sql warehouses stop ${WH_ID}`);
  });

  it("suggests start when the viewed warehouse is stopped", async () => {
    fake.respond("warehouses get", WAREHOUSE);
    const { out } = await run(["sql", "warehouses", "view", WH_ID]);
    expect(out).toContain(`sql warehouses start ${WH_ID}`);
  });

  it("starts async by default (upstream no-op friendly)", async () => {
    fake.respondRaw("warehouses start", "");
    const { out, exitCode } = await run(["sql", "warehouses", "start", WH_ID]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["warehouses", "start", WH_ID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("start requested");
    expect(out).toContain(`sql warehouses view ${WH_ID}`);
  });

  it("stops async by default", async () => {
    fake.respondRaw("warehouses stop", "");
    const { out, exitCode } = await run(["sql", "warehouses", "stop", WH_ID]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["warehouses", "stop", WH_ID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("stop requested");
  });

  it("omits --no-wait with --wait", async () => {
    fake.respondRaw("warehouses start", "");
    await run(["sql", "warehouses", "start", WH_ID, "--wait"]);
    expect(fake.calls()).toEqual([
      ["warehouses", "start", WH_ID, "-o", "json"],
    ]);
  });

  it("maps a genuine 403 to PERMISSION_DENIED, exit 1", async () => {
    fake.respondError(
      "warehouses start",
      "Error: PERMISSION_DENIED: no manage permission\n",
    );
    const { out, exitCode } = await run(["sql", "warehouses", "start", WH_ID]);
    expect(exitCode).toBe(1);
    expect(out).toContain("PERMISSION_DENIED");
  });
});

describe("sql exec", () => {
  it("submits inline and renders columns, rows and total_row_count", async () => {
    fake.respond("api post", succeededStmt());
    const { out, exitCode } = await run([
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

  it("passes --limit as row_limit", async () => {
    fake.respond("api post", succeededStmt());
    await run([
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
    fake.respond("warehouses list", [WAREHOUSE]);
    fake.respond("api post", succeededStmt());
    const { exitCode } = await run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()[0]).toEqual(["warehouses", "list", "-o", "json"]);
    expect(submittedBody()["warehouse_id"]).toBe(WH_ID);
  });

  it("exits 1 NOT_FOUND with zero warehouses", async () => {
    fake.respond("warehouses list", []);
    const { out, exitCode } = await run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("NOT_FOUND");
  });

  it("exits 2 listing id: name pairs with multiple warehouses", async () => {
    fake.respond("warehouses list", [
      WAREHOUSE,
      { ...WAREHOUSE, id: "aaaabbbbccccdddd", name: "Other" },
    ]);
    const { out, exitCode } = await run(["sql", "exec", "SELECT 1"]);
    expect(exitCode).toBe(2);
    expect(out).toContain(`${WH_ID}: Starter Warehouse`);
    expect(out).toContain("aaaabbbbccccdddd: Other");
  });

  it("polls until terminal and renders the result", async () => {
    fake.respond("api post", {
      statement_id: STMT_ID,
      status: { state: "PENDING" },
    });
    fake.respondSeq(`api get ${STMT_PATH}`, [
      { statement_id: STMT_ID, status: { state: "RUNNING" } },
      succeededStmt(),
    ]);
    const { out, exitCode } = await run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toHaveLength(3);
    expect(fake.calls()[1]).toEqual(["api", "get", STMT_PATH, "-o", "json"]);
    expect(out).toContain("total_row_count: 2");
  });

  it("exits 0 with a resume hint when the --timeout budget expires", async () => {
    fake.respond("api post", {
      statement_id: STMT_ID,
      status: { state: "RUNNING" },
    });
    const { out, exitCode } = await run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--timeout",
      "0",
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toHaveLength(1);
    expect(out).toContain(STMT_ID);
    expect(out).toContain("state: RUNNING");
    expect(out).toContain(`sql statement view ${STMT_ID}`);
  });

  it("maps FAILED to SQL_ERROR exit 1 with the upstream message", async () => {
    fake.respond("api post", {
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
    const { out, exitCode } = await run([
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
    fake.respond(
      "api post",
      succeededStmt({ manifest: { truncated: true, total_row_count: 2 } }),
    );
    const { out } = await run([
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

  it("marks extra chunks with a --full hint", async () => {
    fake.respond(
      "api post",
      succeededStmt({ manifest: { total_chunk_count: 2, total_row_count: 3 } }),
    );
    const { out } = await run([
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
    fake.respond(
      "api post",
      succeededStmt({ manifest: { total_chunk_count: 2, total_row_count: 3 } }),
    );
    fake.respond(`api get ${STMT_PATH}/result/chunks/1`, {
      chunk_index: 1,
      data_array: [["3", "z"]],
      row_count: 1,
      row_offset: 2,
    });
    const { out, exitCode } = await run([
      "sql",
      "exec",
      "SELECT 1",
      "--warehouse",
      WH_ID,
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()[1]).toEqual([
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
    const { exitCode } = await run(["sql", "exec"]);
    expect(exitCode).toBe(2);
    expect(fake.calls()).toEqual([]);
  });

  it("rejects a non-integer --timeout", async () => {
    const { exitCode } = await run([
      "sql",
      "exec",
      "SELECT 1",
      "--timeout",
      "abc",
    ]);
    expect(exitCode).toBe(2);
    expect(fake.calls()).toEqual([]);
  });
});

describe("sql statement view", () => {
  it("renders a terminal statement's results", async () => {
    fake.respond(`api get ${STMT_PATH}`, succeededStmt());
    const { out, exitCode } = await run(["sql", "statement", "view", STMT_ID]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([["api", "get", STMT_PATH, "-o", "json"]]);
    expect(out).toContain("total_row_count: 2");
  });

  it("shows state and a rerun hint while non-terminal", async () => {
    fake.respond(`api get ${STMT_PATH}`, {
      statement_id: STMT_ID,
      status: { state: "RUNNING" },
    });
    const { out, exitCode } = await run(["sql", "statement", "view", STMT_ID]);
    expect(exitCode).toBe(0);
    expect(out).toContain("state: RUNNING");
    expect(out).toContain(`sql statement view ${STMT_ID}`);
  });

  it("rejects unknown sql subcommands", async () => {
    const { exitCode } = await run(["sql", "frobnicate"]);
    expect(exitCode).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const CATALOG = {
  name: "workspace",
  owner: "a@b.c",
  catalog_type: "MANAGED_CATALOG",
};

describe("catalog catalogs", () => {
  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("catalogs list", [
      CATALOG,
      { name: "system", owner: "System", catalog_type: "SYSTEM_CATALOG" },
    ]);
    const { out, exitCode } = await t.run(["catalog", "catalogs"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["catalogs", "list", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("catalogs[2]{name,owner,catalog_type}:");
    expect(out).toContain("workspace,a@b.c,MANAGED_CATALOG");
    expect(out).toContain("count: 2");
    expect(out).toContain("catalog schemas <name>");
  });

  it("tolerates a wrapped {catalogs:[...]} response", async () => {
    t.fake.respond("catalogs list", { catalogs: [CATALOG] });
    const { out } = await t.run(["catalog", "catalogs"]);
    expect(out).toContain("catalogs[1]");
    expect(out).toContain("workspace");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("catalogs list", [CATALOG]);
    const { out } = await t.run(["catalog", "catalogs", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("catalog catalogs --limit 2");
  });

  it("renders a definitive empty state noting Free Edition", async () => {
    t.fake.respond("catalogs list", []);
    const { out, exitCode } = await t.run(["catalog", "catalogs"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no catalogs");
    expect(out).toContain("workspace");
  });

  it("rejects unknown --fields keys listing the known ones", async () => {
    t.fake.respond("catalogs list", [CATALOG]);
    const { out, exitCode } = await t.run([
      "catalog",
      "catalogs",
      "--fields",
      "name,bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: bogus");
    expect(out).toContain("catalog_type");
  });

  it("rejects a positional argument", async () => {
    const { exitCode } = await t.run(["catalog", "catalogs", "extra"]);
    expect(exitCode).toBe(2);
  });
});

describe("catalog schemas", () => {
  const SCHEMAS = [
    { name: "default", owner: "a@b.c" },
    { name: "information_schema", owner: "System" },
  ];

  it("passes catalog as a positional and renders default fields", async () => {
    t.fake.respond("schemas list", SCHEMAS);
    const { out, exitCode } = await t.run(["catalog", "schemas", "workspace"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["schemas", "list", "workspace", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("schemas[2]{name,owner}:");
    expect(out).toContain("default,a@b.c");
    expect(out).toContain("catalog tables workspace.<name>");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("schemas list", [SCHEMAS[0]]);
    const { out } = await t.run([
      "catalog",
      "schemas",
      "workspace",
      "--limit",
      "1",
    ]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("catalog schemas workspace --limit 2");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("schemas list", []);
    const { out, exitCode } = await t.run(["catalog", "schemas", "workspace"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no schemas");
  });

  it("maps a missing catalog to NOT_FOUND with a catalogs suggestion", async () => {
    t.fake.respondError(
      "schemas list",
      "Error: Catalog 'does_not_exist_cat_xyz' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "schemas",
      "does_not_exist_cat_xyz",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog catalogs");
  });

  it("requires a catalog argument", async () => {
    const { exitCode } = await t.run(["catalog", "schemas"]);
    expect(exitCode).toBe(2);
  });

  it("rejects unknown --fields keys", async () => {
    t.fake.respond("schemas list", SCHEMAS);
    const { out, exitCode } = await t.run([
      "catalog",
      "schemas",
      "workspace",
      "--fields",
      "bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: bogus");
  });

  it("rejects a leading-dash catalog smuggled past `--`", async () => {
    const { exitCode } = await t.run(["catalog", "schemas", "--", "-x"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("catalog tables", () => {
  const TABLES = [
    {
      name: "axi_bench_trips",
      table_type: "MANAGED",
      data_source_format: "DELTA",
    },
    { name: "other", table_type: "VIEW", data_source_format: "" },
  ];

  it("splits the dotted arg into positional pair with omit flags", async () => {
    t.fake.respond("tables list", TABLES);
    const { out, exitCode } = await t.run([
      "catalog",
      "tables",
      "workspace.default",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "tables",
        "list",
        "workspace",
        "default",
        "--limit",
        "30",
        "--omit-columns",
        "--omit-properties",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("tables[2]{name,table_type,data_source_format}:");
    expect(out).toContain("axi_bench_trips,MANAGED,DELTA");
    expect(out).toContain("catalog table view workspace.default.<name>");
  });

  it("flags a full page as has_more, keeping the dotted arg", async () => {
    t.fake.respond("tables list", [TABLES[0]]);
    const { out } = await t.run([
      "catalog",
      "tables",
      "workspace.default",
      "--limit",
      "1",
    ]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("catalog tables workspace.default --limit 2");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("tables list", []);
    const { out, exitCode } = await t.run([
      "catalog",
      "tables",
      "workspace.default",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no tables");
  });

  it("maps a missing schema to NOT_FOUND with a schemas suggestion", async () => {
    t.fake.respondError(
      "tables list",
      "Error: Schema 'workspace.does_not_exist_schema_xyz' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "tables",
      "workspace.does_not_exist_schema_xyz",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog schemas workspace");
  });

  it("rejects an arg with no dot showing the expected shape", async () => {
    const { out, exitCode } = await t.run(["catalog", "tables", "workspace"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("<catalog>.<schema>");
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects unknown --fields keys", async () => {
    t.fake.respond("tables list", TABLES);
    const { out, exitCode } = await t.run([
      "catalog",
      "tables",
      "workspace.default",
      "--fields",
      "bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: bogus");
  });

  it("rejects a leading-dash dotted arg smuggled past `--`", async () => {
    const { exitCode } = await t.run(["catalog", "tables", "--", "-x.y"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("catalog table view", () => {
  const TABLE = {
    full_name: "workspace.default.axi_bench_trips",
    name: "axi_bench_trips",
    table_type: "MANAGED",
    owner: "a@b.c",
    comment: "seeded bench fixture",
    columns: [
      { name: "trip_id", type_text: "bigint", nullable: false },
      { name: "fare", type_text: "double", nullable: true },
    ],
  };

  it("shows full_name, metadata, and columns", async () => {
    t.fake.respond("tables get", TABLE);
    const { out, exitCode } = await t.run([
      "catalog",
      "table",
      "view",
      "workspace.default.axi_bench_trips",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["tables", "get", "workspace.default.axi_bench_trips", "-o", "json"],
    ]);
    expect(out).toContain("full_name: workspace.default.axi_bench_trips");
    expect(out).toContain("table_type: MANAGED");
    expect(out).toContain("comment: seeded bench fixture");
    expect(out).toContain("columns[2]{name,type_text,nullable}:");
    expect(out).toContain("trip_id,bigint,false");
    expect(out).toContain("fare,double,true");
    // Stay tolerant of TOON's string-quoting rules for the embedded quotes:
    // assert the pieces, not the exact joined suggestion.
    expect(out).toContain("sql exec");
    expect(out).toContain(
      "SELECT * FROM workspace.default.axi_bench_trips LIMIT 10",
    );
    expect(out).toContain("catalog tables workspace.default");
  });

  it("omits comment when absent", async () => {
    // JSON.stringify in the stub drops undefined keys, so this is TABLE
    // without `comment`.
    t.fake.respond("tables get", { ...TABLE, comment: undefined });
    const { out } = await t.run([
      "catalog",
      "table",
      "view",
      "workspace.default.axi_bench_trips",
    ]);
    expect(out).not.toContain("comment:");
  });

  it("maps a missing table to NOT_FOUND with a tables suggestion", async () => {
    t.fake.respondError(
      "tables get",
      "Error: Table 'workspace.default.does_not_exist_xyz' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "table",
      "view",
      "workspace.default.does_not_exist_xyz",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog tables workspace.default");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondRaw("tables get", "");
    const { out, exitCode } = await t.run([
      "catalog",
      "table",
      "view",
      "workspace.default.axi_bench_trips",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });

  it("rejects fewer than two dots showing the expected shape", async () => {
    const { out, exitCode } = await t.run([
      "catalog",
      "table",
      "view",
      "workspace.default",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("<catalog>.<schema>.<table>");
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a bare table subcommand", async () => {
    const { exitCode } = await t.run(["catalog", "table"]);
    expect(exitCode).toBe(2);
  });
});

describe("catalog dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["catalog", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare catalog invocation", async () => {
    const { exitCode } = await t.run(["catalog"]);
    expect(exitCode).toBe(2);
  });

  it("serves catalog --help", async () => {
    const { out, exitCode } = await t.run(["catalog", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi catalog");
  });

  it("threads --profile into NOT_FOUND suggestions", async () => {
    t.fake.respondError(
      "-p dev schemas list",
      "Error: Catalog 'nope' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "schemas",
      "nope",
      "--profile",
      "dev",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("catalog catalogs --profile dev");
  });
});

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

  it("rejects a leading-dash schema segment smuggled as a separate argv token", async () => {
    const { exitCode } = await t.run(["catalog", "tables", "workspace.-y"]);
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

describe("catalog volumes", () => {
  const VOLUME = { name: "axi_bench_vol", volume_type: "MANAGED" };

  it("splits the dotted arg and renders default fields", async () => {
    t.fake.respond("volumes list", [VOLUME]);
    const { out, exitCode } = await t.run([
      "catalog",
      "volumes",
      "workspace.default",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "volumes",
        "list",
        "workspace",
        "default",
        "--limit",
        "30",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("volumes[1]{name,volume_type}:");
    expect(out).toContain("axi_bench_vol,MANAGED");
    expect(out).toContain("catalog volume view workspace.default.<name>");
    expect(out).toContain("fs ls /Volumes/workspace/default/<name>");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("volumes list", []);
    const { out, exitCode } = await t.run([
      "catalog",
      "volumes",
      "workspace.default",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no volumes in workspace.default");
    expect(out).toContain("catalog schemas workspace");
  });

  it("flags a full page as has_more", async () => {
    t.fake.respond("volumes list", [VOLUME]);
    const { out } = await t.run([
      "catalog",
      "volumes",
      "workspace.default",
      "--limit",
      "1",
    ]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("catalog volumes workspace.default --limit 2");
  });

  it("maps a missing schema to NOT_FOUND with a schemas suggestion", async () => {
    t.fake.respondError(
      "volumes list",
      "Error: Schema 'workspace.does_not_exist_sch' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "volumes",
      "workspace.does_not_exist_sch",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog schemas workspace");
  });

  it("rejects an arg with no dot", async () => {
    const { out, exitCode } = await t.run(["catalog", "volumes", "workspace"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("<catalog>.<schema>");
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("catalog volume view", () => {
  const VOLUME = {
    full_name: "workspace.default.axi_bench_vol",
    volume_type: "MANAGED",
    owner: "a@b.c",
    comment: "seeded bench fixture",
    storage_location: "s3://bucket/workspace/default/axi_bench_vol",
  };

  it("shows full_name, metadata, and storage_location", async () => {
    t.fake.respond("volumes read", VOLUME);
    const { out, exitCode } = await t.run([
      "catalog",
      "volume",
      "view",
      "workspace.default.axi_bench_vol",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["volumes", "read", "workspace.default.axi_bench_vol", "-o", "json"],
    ]);
    expect(out).toContain("full_name: workspace.default.axi_bench_vol");
    expect(out).toContain("volume_type: MANAGED");
    expect(out).toContain("comment: seeded bench fixture");
    expect(out).toContain("storage_location:");
    expect(out).toContain("s3://bucket/workspace/default/axi_bench_vol");
    expect(out).toContain("fs ls /Volumes/workspace/default/axi_bench_vol");
    expect(out).toContain("catalog volumes workspace.default");
  });

  it("omits comment when absent", async () => {
    t.fake.respond("volumes read", { ...VOLUME, comment: undefined });
    const { out } = await t.run([
      "catalog",
      "volume",
      "view",
      "workspace.default.axi_bench_vol",
    ]);
    expect(out).not.toContain("comment:");
  });

  it("maps a missing volume to NOT_FOUND with a volumes suggestion", async () => {
    t.fake.respondError(
      "volumes read",
      "Error: Volume 'workspace.default.does_not_exist_vol' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "volume",
      "view",
      "workspace.default.does_not_exist_vol",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog volumes workspace.default");
  });

  it("rejects --fields as an unknown flag", async () => {
    const { exitCode } = await t.run([
      "catalog",
      "volume",
      "view",
      "workspace.default.axi_bench_vol",
      "--fields",
      "name",
    ]);
    expect(exitCode).toBe(2);
  });

  it("rejects fewer than two dots", async () => {
    const { out, exitCode } = await t.run([
      "catalog",
      "volume",
      "view",
      "workspace.default",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("<catalog>.<schema>.<volume>");
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("catalog functions", () => {
  const FUNCTION = {
    name: "axi_fare_with_tip",
    data_type: "DOUBLE",
    comment: "computes fare with a flat 20 percent tip",
  };

  it("splits the dotted arg and renders default fields", async () => {
    t.fake.respond("functions list", [FUNCTION]);
    const { out, exitCode } = await t.run([
      "catalog",
      "functions",
      "workspace.axi_bench",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "functions",
        "list",
        "workspace",
        "axi_bench",
        "--limit",
        "30",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("functions[1]{name,data_type,comment}:");
    expect(out).toContain("axi_fare_with_tip");
    expect(out).toContain("catalog function view workspace.axi_bench.<name>");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("functions list", []);
    const { out, exitCode } = await t.run([
      "catalog",
      "functions",
      "workspace.axi_bench",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no functions in workspace.axi_bench");
  });

  it("flags a full page as has_more", async () => {
    t.fake.respond("functions list", [FUNCTION]);
    const { out } = await t.run([
      "catalog",
      "functions",
      "workspace.axi_bench",
      "--limit",
      "1",
    ]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("catalog functions workspace.axi_bench --limit 2");
  });

  it("maps a missing schema to NOT_FOUND with a schemas suggestion", async () => {
    t.fake.respondError(
      "functions list",
      "Error: Schema 'workspace.does_not_exist_sch' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "functions",
      "workspace.does_not_exist_sch",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog schemas workspace");
  });
});

describe("catalog function view", () => {
  const FUNCTION = {
    full_name: "workspace.axi_bench.axi_fare_with_tip",
    data_type: "DOUBLE",
    routine_definition: "fare * 1.2",
    comment: "computes fare with a flat 20 percent tip",
    input_params: {
      parameters: [{ name: "fare", type_text: "double" }],
    },
  };

  it("shows full_name, definition, comment, and params", async () => {
    t.fake.respond("functions get", FUNCTION);
    const { out, exitCode } = await t.run([
      "catalog",
      "function",
      "view",
      "workspace.axi_bench.axi_fare_with_tip",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "functions",
        "get",
        "workspace.axi_bench.axi_fare_with_tip",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("full_name: workspace.axi_bench.axi_fare_with_tip");
    expect(out).toContain("data_type: DOUBLE");
    expect(out).toContain("routine_definition: fare * 1.2");
    expect(out).toContain("comment: computes fare with a flat 20 percent tip");
    expect(out).toContain("params[1]{name,type_text}:");
    expect(out).toContain("fare,double");
    expect(out).toContain("catalog functions workspace.axi_bench");
  });

  it("maps a missing function to NOT_FOUND with a functions suggestion", async () => {
    t.fake.respondError(
      "functions get",
      "Error: Routine or Model 'workspace.axi_bench.does_not_exist_fn' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "function",
      "view",
      "workspace.axi_bench.does_not_exist_fn",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog functions workspace.axi_bench");
  });

  it("rejects fewer than two dots", async () => {
    const { out, exitCode } = await t.run([
      "catalog",
      "function",
      "view",
      "workspace.axi_bench",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("<catalog>.<schema>.<function>");
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("catalog grants", () => {
  const ASSIGNMENT = {
    principal: "_workspace_users_workspace_7474654644538813",
    privileges: [{ privilege: "USE_CATALOG" }],
  };

  it("passes exact argv with --max-results 0", async () => {
    t.fake.respond("grants get-effective catalog workspace --max-results 0", {
      privilege_assignments: [ASSIGNMENT],
    });
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "grants",
        "get-effective",
        "catalog",
        "workspace",
        "--max-results",
        "0",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("grants[1]{principal,privileges}:");
    expect(out).toContain("USE_CATALOG");
  });

  it("adds --principal when passed", async () => {
    t.fake.respond("grants get-effective catalog workspace --max-results 0", {
      privilege_assignments: [ASSIGNMENT],
    });
    const { exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
      "--principal",
      "itsvigneshperumal@gmail.com",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "grants",
        "get-effective",
        "catalog",
        "workspace",
        "--max-results",
        "0",
        "--principal",
        "itsvigneshperumal@gmail.com",
        "-o",
        "json",
      ],
    ]);
  });

  it("drains a zero-result page that still carries a next_page_token", async () => {
    t.fake.respondSeq(
      "grants get-effective catalog workspace --max-results 0",
      [
        { privilege_assignments: [], next_page_token: "page2" },
        { privilege_assignments: [ASSIGNMENT] },
      ],
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "grants",
        "get-effective",
        "catalog",
        "workspace",
        "--max-results",
        "0",
        "-o",
        "json",
      ],
      [
        "grants",
        "get-effective",
        "catalog",
        "workspace",
        "--max-results",
        "0",
        "--page-token",
        "page2",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("count: 1");
    expect(out).toContain("USE_CATALOG");
  });

  it("--full renders one row per privilege with inheritance columns", async () => {
    t.fake.respond(
      "grants get-effective table workspace.default.t --max-results 0",
      {
        privilege_assignments: [
          {
            principal: "a@b.c",
            privileges: [
              {
                privilege: "SELECT",
                inherited_from_type: "SCHEMA",
                inherited_from_name: "workspace.default",
              },
            ],
          },
        ],
      },
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "table",
      "workspace.default.t",
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain(
      "grants[1]{principal,privilege,inherited_from_type,inherited_from_name}:",
    );
    expect(out).toContain("a@b.c,SELECT,SCHEMA,workspace.default");
  });

  it("--fields selects among the four real keys", async () => {
    t.fake.respond("grants get-effective catalog workspace --max-results 0", {
      privilege_assignments: [ASSIGNMENT],
    });
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
      "--fields",
      "principal",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("grants[1]{principal}:");
  });

  it("renders a definitive empty state for a bare {} response", async () => {
    t.fake.respond(
      "grants get-effective table workspace.default.axi_bench_trips --max-results 0",
      {},
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "table",
      "workspace.default.axi_bench_trips",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain(
      "no effective grants on table workspace.default.axi_bench_trips",
    );
  });

  it("renders a definitive empty state for {privilege_assignments: []}", async () => {
    t.fake.respond("grants get-effective catalog workspace --max-results 0", {
      privilege_assignments: [],
    });
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no effective grants on catalog workspace");
  });

  it("never redacts an email or long group-id principal (leak test)", async () => {
    t.fake.respond("grants get-effective catalog workspace --max-results 0", {
      privilege_assignments: [
        {
          principal: "itsvigneshperumal@gmail.com",
          privileges: [{ privilege: "USE_CATALOG" }],
        },
        ASSIGNMENT,
      ],
    });
    const { out } = await t.run(["catalog", "grants", "catalog", "workspace"]);
    expect(out).toContain("itsvigneshperumal@gmail.com");
    expect(out).toContain("_workspace_users_workspace_7474654644538813");
    expect(out).not.toContain("redacted");
  });

  it("maps the live missing-table NOT_FOUND string verbatim", async () => {
    t.fake.respondError(
      "grants get-effective",
      "Error: Table 'workspace.default.does_not_exist_tbl' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "table",
      "workspace.default.does_not_exist_tbl",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("catalog grants schema workspace.default");
  });

  it("maps the live missing-catalog NOT_FOUND string verbatim", async () => {
    t.fake.respondError(
      "grants get-effective",
      "Error: Catalog 'does_not_exist_cat' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "does_not_exist_cat",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
  });

  it("a bad --principal (F2) leads help with the drop-flag suggestion", async () => {
    t.fake.respondError(
      "grants get-effective",
      "Error: Could not find principal with name nosuchuser@x.com.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "workspace",
      "--principal",
      "nosuchuser@x.com",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("drop --principal");
  });

  it("a securable-miss without --principal only gets the parent-list help", async () => {
    t.fake.respondError(
      "grants get-effective",
      "Error: Catalog 'does_not_exist_cat' does not exist.",
    );
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "catalog",
      "does_not_exist_cat",
    ]);
    expect(exitCode).toBe(1);
    expect(out).not.toContain("drop --principal");
  });

  it("rejects a non-lowercase securable type without normalizing it (F4)", async () => {
    const { out, exitCode } = await t.run([
      "catalog",
      "grants",
      "TABLE",
      "workspace.default.x",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("catalog, schema, table, volume, function");
    expect(t.fake.calls()).toEqual([]);
  });

  describe("403 (F6, both shapes, not live-observed)", () => {
    it("maps a bare 403 to PERMISSION_DENIED", async () => {
      t.fake.respondError("grants get-effective", "Error: 403 Forbidden");
      const { out, exitCode } = await t.run([
        "catalog",
        "grants",
        "catalog",
        "workspace",
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain("code: PERMISSION_DENIED");
    });

    it("maps a PERMISSION_DENIED-token stderr to PERMISSION_DENIED", async () => {
      t.fake.respondError(
        "grants get-effective",
        "Error: PERMISSION_DENIED: caller lacks ownership",
      );
      const { out, exitCode } = await t.run([
        "catalog",
        "grants",
        "catalog",
        "workspace",
      ]);
      expect(exitCode).toBe(1);
      expect(out).toContain("code: PERMISSION_DENIED");
    });
  });

  it("rejects an unknown securable type listing the five", async () => {
    const { out, exitCode } = await t.run(["catalog", "grants", "bogus", "x"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("catalog, schema, table, volume, function");
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a bare grants invocation", async () => {
    const { exitCode } = await t.run(["catalog", "grants"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
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

import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const DASHBOARD = {
  dashboard_id: "01f18184706f11da846a179c97fcc018",
  display_name: "axi-spec-probe-dash",
  lifecycle_state: "ACTIVE",
  create_time: "2026-07-17T02:08:44.742Z",
};

describe("dashboards list", () => {
  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("lakeview list", [DASHBOARD]);
    const { out, exitCode } = await t.run(["dashboards", "list"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["lakeview", "list", "--limit", "20", "-o", "json"],
    ]);
    expect(out).toContain(
      "dashboards[1]{dashboard_id,display_name,lifecycle_state,update_time}:",
    );
    expect(out).toContain("axi-spec-probe-dash");
    expect(out).toContain("dashboards view <dashboard_id>");
  });

  it("adds --show-trashed under --trashed", async () => {
    t.fake.respond("lakeview list", [
      { ...DASHBOARD, lifecycle_state: "TRASHED" },
    ]);
    const { exitCode } = await t.run(["dashboards", "list", "--trashed"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["lakeview", "list", "--limit", "20", "--show-trashed", "-o", "json"],
    ]);
  });

  it("threads --profile as a -p prefix", async () => {
    t.fake.respond("-p AWS lakeview list", [DASHBOARD]);
    const { exitCode } = await t.run([
      "dashboards",
      "list",
      "--profile",
      "AWS",
    ]);
    expect(exitCode).toBe(0);
  });

  it("supports --fields for a raw top-level key", async () => {
    t.fake.respond("lakeview list", [DASHBOARD]);
    const { out, exitCode } = await t.run([
      "dashboards",
      "list",
      "--fields",
      "create_time",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("dashboards[1]{create_time}:");
  });

  it("rejects an unknown --fields key", async () => {
    t.fake.respond("lakeview list", [DASHBOARD]);
    const { out, exitCode } = await t.run([
      "dashboards",
      "list",
      "--fields",
      "bogus",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: bogus");
  });

  it("flags a full page as has_more with a bigger-limit rerun", async () => {
    t.fake.respond("lakeview list", [DASHBOARD]);
    const { out } = await t.run(["dashboards", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("dashboards list --limit 2");
  });

  it("renders a definitive empty state pointing at --trashed", async () => {
    t.fake.respond("lakeview list", []);
    const { out, exitCode } = await t.run(["dashboards", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no dashboards in this workspace");
    expect(out).toContain("dashboards list --trashed");
  });

  it("renders a distinct empty state when --trashed is already set", async () => {
    t.fake.respond("lakeview list", []);
    const { out, exitCode } = await t.run(["dashboards", "list", "--trashed"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no dashboards in this workspace, including trash");
  });

  it("rejects a positional argument", async () => {
    const { exitCode } = await t.run(["dashboards", "list", "extra"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("dashboards view", () => {
  const FULL_DASHBOARD = {
    ...DASHBOARD,
    path: "/Users/user@example.com/axi-spec-probe-dash.lvdash.json",
    warehouse_id: "614f87803a006f55",
    update_time: "2026-07-17T02:08:45.814Z",
    serialized_dashboard: JSON.stringify({
      pages: [{}, {}, {}],
      datasets: [{}, {}],
    }),
  };

  it("summarizes the dashboard and omits serialized_dashboard by default", async () => {
    t.fake.respond("lakeview get", FULL_DASHBOARD);
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc018",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["lakeview", "get", "01f18184706f11da846a179c97fcc018", "-o", "json"],
    ]);
    expect(out).toContain("dashboard_id: 01f18184706f11da846a179c97fcc018");
    expect(out).toContain("display_name: axi-spec-probe-dash");
    expect(out).toContain("lifecycle_state: ACTIVE");
    expect(out).toContain("warehouse_id: 614f87803a006f55");
    expect(out).toContain("pages: 3");
    expect(out).toContain("datasets: 2");
    expect(out).not.toContain("serialized_dashboard");
    expect(out).toContain(
      "permissions dashboards 01f18184706f11da846a179c97fcc018",
    );
  });

  it("omits warehouse_id when absent", async () => {
    const rest = { ...FULL_DASHBOARD, warehouse_id: undefined };
    t.fake.respond("lakeview get", rest);
    const { out } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc018",
    ]);
    expect(out).not.toContain("warehouse_id");
  });

  it("omits counts and adds a note when the spec is unparseable", async () => {
    t.fake.respond("lakeview get", {
      ...FULL_DASHBOARD,
      serialized_dashboard: "not json{{{",
    });
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc018",
    ]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("pages:");
    expect(out).not.toContain("datasets:");
    expect(out).toContain("note:");
    expect(out).toContain("--full");
  });

  it("omits counts and adds a note when the spec parses to a non-object", async () => {
    t.fake.respond("lakeview get", {
      ...FULL_DASHBOARD,
      serialized_dashboard: "42",
    });
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc018",
    ]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("pages:");
    expect(out).toContain("note:");
  });

  it("--full includes the raw serialized_dashboard string verbatim", async () => {
    t.fake.respond("lakeview get", FULL_DASHBOARD);
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc018",
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("serialized_dashboard:");
    // TOON quotes/escapes the string for rendering (it contains raw `"`),
    // but the underlying content is byte-identical to the fixture — compare
    // against JSON.stringify's own escaping of the same string.
    const escaped = JSON.stringify(FULL_DASHBOARD.serialized_dashboard).slice(
      1,
      -1,
    );
    expect(out).toContain(escaped);
  });

  describe("id guard (F1)", () => {
    const rejected = [
      "foo",
      "--evil",
      "../x",
      "-1f18184706f11da846a179c97fcc018", // 32 chars, leading dash
      "--------------------------------", // 32 dashes
    ];
    for (const bad of rejected) {
      it(`rejects ${JSON.stringify(bad)}`, async () => {
        const { exitCode } = await t.run(["dashboards", "view", bad]);
        expect(exitCode).toBe(2);
        expect(t.fake.calls()).toEqual([]);
      });
    }

    it("rejects a leading-dash id smuggled past `--`", async () => {
      const { exitCode } = await t.run([
        "dashboards",
        "view",
        "--",
        "-1f18184706f11da846a179c97fcc018",
      ]);
      expect(exitCode).toBe(2);
      expect(t.fake.calls()).toEqual([]);
    });

    it("accepts the live 32-hex id shape", async () => {
      t.fake.respond("lakeview get", FULL_DASHBOARD);
      const { exitCode } = await t.run([
        "dashboards",
        "view",
        "01f18184706f11da846a179c97fcc018",
      ]);
      expect(exitCode).toBe(0);
    });

    it("accepts a dashed 36-char UUID shape (upstream's own claimed format)", async () => {
      t.fake.respond("lakeview get", FULL_DASHBOARD);
      const { exitCode } = await t.run([
        "dashboards",
        "view",
        "11111111-1111-1111-1111-111111111111",
      ]);
      expect(exitCode).toBe(0);
    });
  });

  it("maps the live 'Unable to find dashboard' stderr to NOT_FOUND, redacted (F3)", async () => {
    t.fake.respondError(
      "lakeview get",
      "Error: Unable to find dashboard [01f18184706f11da846a179c97fcc019]",
    );
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "01f18184706f11da846a179c97fcc019",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    // The id is exactly 32 hex chars, which trips redactSecrets before
    // classification — pin the collision, don't discover it (spec §5.2).
    expect(out).toContain("Unable to find dashboard [[redacted]]");
    expect(out).toContain("dashboards list");
    expect(out).toContain("dashboards list --trashed");
  });

  it("keeps an 'invalid resource name' format error as UPSTREAM_ERROR", async () => {
    t.fake.respondError(
      "lakeview get",
      "Error: invalid resource name [dashboards/11111111-1111-1111-1111-111111111111]",
    );
    const { out, exitCode } = await t.run([
      "dashboards",
      "view",
      "11111111-1111-1111-1111-111111111111",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
  });
});

describe("dashboards dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["dashboards", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare dashboards invocation", async () => {
    const { exitCode } = await t.run(["dashboards"]);
    expect(exitCode).toBe(2);
  });

  it("serves dashboards --help", async () => {
    const { out, exitCode } = await t.run(["dashboards", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi dashboards");
  });
});

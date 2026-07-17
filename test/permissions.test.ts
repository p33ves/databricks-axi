import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const JOB_ACL = {
  access_control_list: [
    {
      user_name: "itsvigneshperumal@gmail.com",
      all_permissions: [{ inherited: false, permission_level: "IS_OWNER" }],
    },
    {
      group_name: "admins",
      all_permissions: [
        {
          inherited: true,
          inherited_from_object: ["/jobs/"],
          permission_level: "CAN_MANAGE",
        },
      ],
    },
  ],
  object_id: "/jobs/88440223843221",
  object_type: "job",
};

describe("permissions", () => {
  it("passes exact argv", async () => {
    t.fake.respond("permissions get", JOB_ACL);
    const { exitCode } = await t.run(["permissions", "jobs", "88440223843221"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["permissions", "get", "jobs", "88440223843221", "-o", "json"],
    ]);
  });

  it("renders compact rows by default", async () => {
    t.fake.respond("permissions get", JOB_ACL);
    const { out, exitCode } = await t.run([
      "permissions",
      "jobs",
      "88440223843221",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("object_type: job");
    expect(out).toContain("object_id: /jobs/88440223843221");
    expect(out).toContain("permissions[2]{principal,permissions}:");
    expect(out).toContain("itsvigneshperumal@gmail.com,IS_OWNER");
    expect(out).toContain("admins,CAN_MANAGE");
    expect(out).toContain("count: 2");
  });

  it("--full renders one row per (principal, level) with inheritance", async () => {
    t.fake.respond("permissions get", JOB_ACL);
    const { out, exitCode } = await t.run([
      "permissions",
      "jobs",
      "88440223843221",
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain(
      "permissions[2]{principal,type,level,inherited,inherited_from}:",
    );
    expect(out).toContain("admins,group,CAN_MANAGE,true,/jobs/");
    expect(out).toContain("itsvigneshperumal@gmail.com,user,IS_OWNER,false,");
  });

  it("the live dashboard fixture echoes object_type dashboard and the numeric object_id (F5)", async () => {
    t.fake.respond("permissions get", {
      access_control_list: [
        {
          user_name: "itsvigneshperumal@gmail.com",
          all_permissions: [
            {
              inherited: true,
              inherited_from_object: ["/directories/3775776929152704"],
              permission_level: "CAN_MANAGE",
            },
          ],
        },
        {
          group_name: "admins",
          all_permissions: [
            {
              inherited: true,
              inherited_from_object: ["/directories/"],
              permission_level: "CAN_MANAGE",
            },
          ],
        },
      ],
      object_id: "/dashboards/570857400383840",
      object_type: "dashboard",
    });
    const { out, exitCode } = await t.run([
      "permissions",
      "dashboards",
      "01f1818b2ab611a49f09d3b7b6637589",
      "--full",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "permissions",
        "get",
        "dashboards",
        "01f1818b2ab611a49f09d3b7b6637589",
        "-o",
        "json",
      ],
    ]);
    // Echoes upstream's own response value, not the 32-hex id we passed in.
    expect(out).toContain("object_type: dashboard");
    expect(out).toContain("object_id: /dashboards/570857400383840");
    expect(out).not.toContain(
      "object_id: /dashboards/01f1818b2ab611a49f09d3b7b6637589",
    );
    expect(out).toContain("/directories/3775776929152704");
    expect(out).toContain("dashboards view 01f1818b2ab611a49f09d3b7b6637589");
  });

  it("falls through to service_principal_name (W2)", async () => {
    t.fake.respond("permissions get", {
      access_control_list: [
        {
          service_principal_name: "svc-principal-id",
          all_permissions: [
            { inherited: false, permission_level: "CAN_MANAGE" },
          ],
        },
      ],
      object_id: "/jobs/1",
      object_type: "job",
    });
    const { out } = await t.run(["permissions", "jobs", "1", "--full"]);
    expect(out).toContain("svc-principal-id,service_principal,CAN_MANAGE");
  });

  describe("object-type allow-list", () => {
    const rejected = [
      ["experiments", "123"],
      ["serving-endpoints", "no_such_endpoint"],
      ["dbsql-dashboards", "01f18184706f11da846a179c97fcc018"],
    ];
    for (const [type, id] of rejected) {
      it(`rejects ${type}, naming the five + the api escape line`, async () => {
        const { out, exitCode } = await t.run(["permissions", type, id]);
        expect(exitCode).toBe(2);
        expect(out).toContain(
          "jobs, clusters, pipelines, warehouses, dashboards",
        );
        expect(out).toContain("api get /api/2.0/permissions");
        expect(t.fake.calls()).toEqual([]);
      });
    }

    it("rejects a flag-shaped type (--evil) before it ever reaches the type check", async () => {
      const { exitCode } = await t.run(["permissions", "--evil", "1"]);
      expect(exitCode).toBe(2);
      expect(t.fake.calls()).toEqual([]);
    });

    it("rejects a bare invocation", async () => {
      const { exitCode } = await t.run(["permissions"]);
      expect(exitCode).toBe(2);
      expect(t.fake.calls()).toEqual([]);
    });
  });

  it("has no --fields (F9): unknown option, not silently ignored", async () => {
    const { out, exitCode } = await t.run([
      "permissions",
      "jobs",
      "88440223843221",
      "--fields",
      "principal",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--fields'");
    expect(t.fake.calls()).toEqual([]);
  });

  describe("live NOT_FOUND strings map to the matching list-command help", () => {
    const cases: [string, string, string, string][] = [
      ["jobs", "999999999", "Error: job 999999999 does not exist", "jobs list"],
      [
        "clusters",
        "0000-000000-bogus99",
        "Error: Compute with id: 0000-000000-bogus99 does not exist",
        "clusters list",
      ],
      [
        "pipelines",
        "0000-000000-bogus99",
        "Error: pipelines 0000-000000-bogus99 does not exist",
        "pipelines list",
      ],
      [
        "warehouses",
        "1234567890abcdef",
        "Error: endpoints 1234567890abcdef does not exist",
        "sql warehouses",
      ],
      [
        "dashboards",
        "01f18184706f11da846a179c97fcc019",
        "Error: Dashboard 01f18184706f11da846a179c97fcc019 does not exist",
        "dashboards list",
      ],
    ];
    for (const [type, id, stderr, help] of cases) {
      it(`${type} -> NOT_FOUND + ${help}`, async () => {
        t.fake.respondError("permissions get", stderr);
        const { out, exitCode } = await t.run(["permissions", type, id]);
        expect(exitCode).toBe(1);
        expect(out).toContain("code: NOT_FOUND");
        expect(out).toContain(help);
      });
    }
  });

  it("keeps a malformed-id format error as UPSTREAM_ERROR", async () => {
    t.fake.respondError(
      "permissions get",
      "Error: 0000-000000-bogus99 is not a valid endpoint id.",
    );
    const { out, exitCode } = await t.run([
      "permissions",
      "warehouses",
      "0000-000000-bogus99",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
  });

  it("renders a definitive empty state for an empty access_control_list", async () => {
    t.fake.respond("permissions get", {
      access_control_list: [],
      object_id: "/jobs/1",
      object_type: "job",
    });
    const { out, exitCode } = await t.run(["permissions", "jobs", "1"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no access control entries visible on jobs 1");
    expect(out).toContain("--full");
    expect(out).toContain("doctor");
  });

  it("never redacts an email or long group-id principal in success rows (leak test)", async () => {
    t.fake.respond("permissions get", {
      access_control_list: [
        {
          user_name: "itsvigneshperumal@gmail.com",
          all_permissions: [{ inherited: false, permission_level: "CAN_RUN" }],
        },
        {
          group_name: "_workspace_users_workspace_7474654644538813",
          all_permissions: [
            { inherited: true, permission_level: "CAN_MANAGE" },
          ],
        },
      ],
      object_id: "/jobs/1",
      object_type: "job",
    });
    const { out } = await t.run(["permissions", "jobs", "1"]);
    expect(out).toContain("itsvigneshperumal@gmail.com");
    expect(out).toContain("_workspace_users_workspace_7474654644538813");
    expect(out).not.toContain("redacted");
  });

  describe("403 (F6, both shapes, not live-observed)", () => {
    it("maps a bare 403 to PERMISSION_DENIED", async () => {
      t.fake.respondError("permissions get", "Error: 403 Forbidden");
      const { out, exitCode } = await t.run(["permissions", "jobs", "1"]);
      expect(exitCode).toBe(1);
      expect(out).toContain("code: PERMISSION_DENIED");
    });

    it("maps a PERMISSION_DENIED-token stderr to PERMISSION_DENIED", async () => {
      t.fake.respondError(
        "permissions get",
        "Error: PERMISSION_DENIED: caller lacks CAN_MANAGE",
      );
      const { out, exitCode } = await t.run(["permissions", "jobs", "1"]);
      expect(exitCode).toBe(1);
      expect(out).toContain("code: PERMISSION_DENIED");
    });
  });

  it("serves permissions --help", async () => {
    const { out, exitCode } = await t.run(["permissions", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi permissions");
  });
});

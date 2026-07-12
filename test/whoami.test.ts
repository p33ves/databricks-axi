import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const ME = {
  userName: "itsvigneshperumal@gmail.com",
  displayName: "Vignesh Perumal",
  active: true,
  groups: [
    {
      display: "account users",
      type: "direct",
      value: "g1",
      $ref: "Groups/g1",
    },
    { display: "admins", type: "direct", value: "g2", $ref: "Groups/g2" },
    { display: "users", type: "direct", value: "g3", $ref: "Groups/g3" },
  ],
  entitlements: [
    { value: "allow-cluster-create" },
    { value: "allow-instance-pool-create" },
  ],
  emails: [{ value: "itsvigneshperumal@gmail.com", primary: true }],
  id: "1234567890",
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
};

describe("whoami", () => {
  it("passes exact argv with no profile and renders the default view", async () => {
    t.fake.respond("current-user me", ME);
    const { out, exitCode } = await t.run(["whoami"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["current-user", "me", "-o", "json"]]);
    expect(out).toContain("user_name: itsvigneshperumal@gmail.com");
    expect(out).toContain("display_name: Vignesh Perumal");
    expect(out).toContain("active: true");
    expect(out).toContain("groups[3]{display,type}:");
    expect(out).toContain("account users,direct");
    expect(out).toContain("admins,direct");
    expect(out).toContain("users,direct");
    expect(out).toContain(
      "entitlements[2]: allow-cluster-create,allow-instance-pool-create",
    );
    expect(out).toContain("databricks-axi home");
    // SCIM ids/refs/emails/schemas are omitted from the rendered view.
    expect(out).not.toContain("$ref");
    expect(out).not.toContain("schemas");
    expect(out).not.toContain("primary");
  });

  it("passes --profile before args and suffixes the home suggestion", async () => {
    t.fake.respond("-p AWS current-user me", ME);
    const { exitCode, out } = await t.run(["whoami", "--profile", "AWS"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["-p", "AWS", "current-user", "me", "-o", "json"],
    ]);
    expect(out).toContain("databricks-axi home --profile AWS");
  });

  it("omits display_name when absent", async () => {
    t.fake.respond("current-user me", {
      userName: "svc@example.com",
      active: true,
      groups: [],
      entitlements: [],
    });
    const { out } = await t.run(["whoami"]);
    expect(out).not.toContain("display_name");
  });

  it("rejects positional arguments", async () => {
    const { exitCode, out } = await t.run(["whoami", "extra"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("extra");
    expect(t.fake.calls()).toEqual([]);
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["whoami", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });

  it("maps auth failures to a structured AUTH_ERROR without leaking tokens", async () => {
    t.fake.respondError(
      "current-user me",
      "Error: 401 Unauthorized dapi1234567890abcdef",
    );
    const { out, exitCode } = await t.run(["whoami"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("databricks auth login");
    expect(out).not.toContain("dapi1234");
  });

  it("serves whoami --help", async () => {
    const { out, exitCode } = await t.run(["whoami", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi whoami");
  });
});

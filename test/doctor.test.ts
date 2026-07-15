import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const AUTH_DESCRIBE = {
  status: "success",
  username: "user@example.com",
  details: {
    auth_type: "databricks-cli",
    host: "https://dbc-abc123.cloud.databricks.com",
    configuration: { profile: { value: "DEFAULT" } },
  },
};

const ACCOUNT_AUTH_DESCRIBE = {
  status: "success",
  username: "user@example.com",
  details: {
    auth_type: "oauth-u2m",
    host: "https://accounts.cloud.databricks.com",
    configuration: { profile: { value: "ACCT" } },
  },
};

const ME = { userName: "user@example.com", active: true };

function seedBase(t: ReturnType<typeof setupCli>) {
  t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
  t.fake.respond("auth describe", AUTH_DESCRIBE);
  t.fake.respond("current-user me", ME);
}

describe("doctor — base checks", () => {
  it("spawns exactly the base three probes with exact argv, no --sensitive", async () => {
    seedBase(t);
    const { exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    const calls = t.fake.calls();
    expect(calls).toContainEqual(["-v"]);
    expect(calls).toContainEqual(["auth", "describe", "-o", "json"]);
    expect(calls).toContainEqual(["current-user", "me", "-o", "json"]);
    expect(calls.length).toBe(3);
    expect(calls.flat()).not.toContain("--sensitive");
  });

  it("renders exactly cli/profile/auth, all PASS, overall healthy", async () => {
    seedBase(t);
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("checks[3]{check,status,detail}:");
    expect(out).toContain("cli,PASS,v1.6.0");
    expect(out).toContain(
      'profile,PASS,"DEFAULT  https://dbc-abc123.cloud.databricks.com  databricks-cli"',
    );
    expect(out).toContain("auth,PASS,user@example.com  active");
    expect(out).toContain("overall: healthy");
    expect(out).not.toContain("code:");
  });

  it("passes -p AWS to every workspace probe, not to the version probe", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respond("-p AWS auth describe", AUTH_DESCRIBE);
    t.fake.respond("-p AWS current-user me", ME);
    const { exitCode } = await t.run(["doctor", "--profile", "AWS"]);
    expect(exitCode).toBe(0);
    const calls = t.fake.calls();
    expect(calls).toContainEqual(["-v"]);
    expect(calls).toContainEqual([
      "-p",
      "AWS",
      "auth",
      "describe",
      "-o",
      "json",
    ]);
    expect(calls).toContainEqual([
      "-p",
      "AWS",
      "current-user",
      "me",
      "-o",
      "json",
    ]);
  });

  it("found but unparseable -v output is a WARN 'version unknown', code CLI_VERSION_UNKNOWN, not FAIL", async () => {
    t.fake.respondRaw("-v", "");
    t.fake.respond("auth describe", AUTH_DESCRIBE);
    t.fake.respond("current-user me", ME);
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cli,WARN,version unknown");
    expect(out).toContain("code: CLI_VERSION_UNKNOWN");
    expect(out).toContain("databricks -v");
    expect(out).toContain("overall: warn");
  });

  it("CLI missing entirely (ENOENT on every spawn) is a FAIL row, code CLI_MISSING wins over AUTH_ERROR", async () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "doctor-empty-path-"));
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cli,FAIL,not found on PATH");
    expect(out).toContain("code: CLI_MISSING");
    expect(out).toContain("overall: fail");
  });

  it("rejects extra positional arguments", async () => {
    const { exitCode, out } = await t.run(["doctor", "extra"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("extra");
    expect(t.fake.calls()).toEqual([]);
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["doctor", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });

  it("serves doctor --help", async () => {
    const { out, exitCode } = await t.run(["doctor", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi doctor");
  });
});

describe("doctor — precedence (§4.1)", () => {
  it("old CLI (WARN) + failed auth (FAIL) yields overall fail, code AUTH_ERROR, never CLI_TOO_OLD", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v0.200.0\n");
    t.fake.respondError(
      "auth describe",
      "Error: cannot configure default credentials",
    );
    t.fake.respondError(
      "current-user me",
      "Error: cannot configure default credentials",
    );
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cli,WARN");
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).not.toContain("code: CLI_TOO_OLD");
    expect(out).toContain("overall: fail");
  });

  it("old CLI alone (no other failures) yields overall warn, code CLI_TOO_OLD", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v0.200.0\n");
    t.fake.respond("auth describe", AUTH_DESCRIBE);
    t.fake.respond("current-user me", ME);
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cli,WARN,v0.200.0 — upgrade to >= 0.298");
    expect(out).toContain("code: CLI_TOO_OLD");
    expect(out).toContain("overall: warn");
  });

  it("F1: a TIMEOUT on the auth probe renders code TIMEOUT, not AUTH_ERROR, help matches the timeout action", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respondHang("auth describe");
    t.fake.respond("current-user me", ME);
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("profile,FAIL");
    expect(out).toContain("auth,FAIL");
    expect(out).toContain("code: TIMEOUT");
    expect(out).not.toContain("code: AUTH_ERROR");
    expect(out).toContain('help[1]: "Retry, or check workspace availability"');
    expect(out).toContain("overall: fail");
  }, 8000);
});

describe("doctor — auth failures", () => {
  it("auth describe rejects (no creds): profile FAIL and auth FAIL share one AUTH_ERROR code", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respondError(
      "auth describe",
      "Error: cannot configure default credentials",
    );
    t.fake.respondError(
      "current-user me",
      "Error: cannot configure default credentials",
    );
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("profile,FAIL");
    expect(out).toContain("auth,FAIL");
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("overall: fail");
  });

  it("current-user me rejects on a normal workspace host: auth FAIL with sub-typed help, exit 0", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respond("auth describe", AUTH_DESCRIBE);
    t.fake.respondError(
      "current-user me",
      "Error: 401 Unauthorized dapi1234567890abcdef",
    );
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("auth,FAIL");
    expect(out).toContain("profile,PASS");
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("databricks auth login");
    expect(out).not.toContain("dapi1234");
  });
});

describe("doctor — account-host carve-out (§6 Decision 3)", () => {
  it("account-level host: current-user me rejection is INFO, not FAIL; overall stays healthy", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respond("auth describe", ACCOUNT_AUTH_DESCRIBE);
    t.fake.respondError("current-user me", "Error: RESOURCE_DOES_NOT_EXIST");
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("auth,INFO,account-level host");
    expect(out).toContain("current-user me not applicable");
    expect(out).not.toContain("auth,FAIL");
    expect(out).toContain("overall: healthy");
  });

  it("a host merely containing 'accounts' as a non-first label does NOT trip the carve-out", async () => {
    t.fake.respondRaw("-v", "Databricks CLI v1.6.0\n");
    t.fake.respond("auth describe", {
      username: "user@example.com",
      details: {
        auth_type: "databricks-cli",
        host: "https://my-accounts.cloud.databricks.com",
        configuration: { profile: { value: "DEFAULT" } },
      },
    });
    t.fake.respondError("current-user me", "Error: 401 Unauthorized");
    const { out, exitCode } = await t.run(["doctor"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("auth,FAIL");
    expect(out).not.toContain("account-level");
    expect(out).toContain("overall: fail");
  });
});

describe("doctor --full — predictive checks", () => {
  it("base doctor omits warehouse/compute rows and never calls their upstream endpoints", async () => {
    seedBase(t);
    const { out } = await t.run(["doctor"]);
    expect(out).not.toContain("warehouse,");
    expect(out).not.toContain("compute,");
    const calls = t.fake.calls();
    expect(calls.some((c) => c.includes("warehouses"))).toBe(false);
    expect(calls.some((c) => c.includes("clusters"))).toBe(false);
  });

  it("--full spawns warehouses list, clusters list, and jobs list-runs with exact argv", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", { warehouses: [] });
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    const calls = t.fake.calls();
    expect(calls).toContainEqual(["warehouses", "list", "-o", "json"]);
    expect(calls).toContainEqual(["clusters", "list", "-o", "json"]);
    expect(calls).toContainEqual([
      "jobs",
      "list-runs",
      "--limit",
      "5",
      "-o",
      "json",
    ]);
  });

  it("serverless-only: empty unfiltered clusters list yields compute INFO serverless-only", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", {
      warehouses: [{ id: "wh1", name: "Starter", state: "RUNNING" }],
    });
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain(
      "compute,INFO,serverless-only workspace (no classic clusters exist)",
    );
    expect(out).not.toContain("running_clusters");
  });

  it("all-TERMINATED clusters: INFO 'classic cluster(s), all stopped', NOT serverless-only", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", {
      warehouses: [{ id: "wh1", name: "Starter", state: "RUNNING" }],
    });
    t.fake.respond("clusters list", {
      clusters: [
        { cluster_id: "c1", cluster_name: "old", state: "TERMINATED" },
      ],
    });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("1 classic cluster(s), all stopped");
    expect(out).toContain("databricks-axi clusters start c1");
    expect(out).not.toContain("serverless-only");
    expect(out).not.toContain("running_clusters");
  });

  it("a RUNNING cluster renders the running-clusters panel, no compute row", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", {
      warehouses: [{ id: "wh1", name: "Starter", state: "RUNNING" }],
    });
    t.fake.respond("clusters list", {
      clusters: [
        { cluster_id: "c1", cluster_name: "dev", state: "RUNNING" },
        { cluster_id: "c2", cluster_name: "old", state: "TERMINATED" },
      ],
    });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("running_clusters");
    expect(out).toContain("dev");
    expect(out).not.toContain("compute,");
  });

  it("no RUNNING warehouse: WARN row with a start suggestion", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", {
      warehouses: [{ id: "wh1", name: "Starter", state: "STOPPED" }],
    });
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("warehouse,WARN,no RUNNING warehouse");
    expect(out).toContain("databricks-axi sql warehouses start wh1");
    expect(out).toContain("overall: warn");
    expect(out).toContain("help[1]: databricks-axi sql warehouses start wh1");
  });

  it("F2: zero warehouses yields no warehouse row (not a WARN with a placeholder <id>)", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", { warehouses: [] });
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("warehouse,");
    expect(out).not.toContain("<id>");
    expect(out).toContain("overall: healthy");
  });

  it("a RUNNING warehouse yields no warehouse row", async () => {
    seedBase(t);
    t.fake.respond("warehouses list", {
      warehouses: [{ id: "wh1", name: "Starter", state: "RUNNING" }],
    });
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("warehouse,");
  });

  it("a degraded --full panel (timeout) yields an unavailable line and no false prediction, exit 0", async () => {
    seedBase(t);
    t.fake.respondHang("warehouses list");
    t.fake.respond("clusters list", { clusters: [] });
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("warehouses: unavailable");
    expect(out).not.toContain("warehouse,WARN");
    expect(out).not.toContain("warehouse,");
    // compute prediction still renders from the (successful) clusters panel.
    expect(out).toContain("compute,INFO,serverless-only");
  }, 8000);
});

describe("doctor — always-exit-0 invariant", () => {
  it("every probe rejecting (including a full timeout sweep) still exits 0", async () => {
    t.fake.respondError("-v", "", 127);
    t.fake.respondHang("auth describe");
    t.fake.respondHang("current-user me");
    t.fake.respondHang("warehouses list");
    t.fake.respondHang("clusters list");
    t.fake.respondHang("jobs list-runs");
    const { out, exitCode } = await t.run(["doctor", "--full"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("overall:");
  }, 15000);
});

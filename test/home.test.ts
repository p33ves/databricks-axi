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

const RUNS = {
  runs: [
    { run_id: 1, state: { life_cycle_state: "RUNNING" }, start_time: 1000 },
    {
      run_id: 2,
      state: { result_state: "FAILED", life_cycle_state: "TERMINATED" },
      start_time: 2000,
    },
    {
      run_id: 3,
      state: { result_state: "SUCCESS", life_cycle_state: "TERMINATED" },
      start_time: 3000,
    },
  ],
};

const WAREHOUSES = {
  warehouses: [{ id: "wh1", name: "Starter Warehouse", state: "RUNNING" }],
};

const CLUSTERS = {
  clusters: [
    { cluster_id: "c1", cluster_name: "dev", state: "RUNNING" },
    { cluster_id: "c2", cluster_name: "old", state: "TERMINATED" },
  ],
};

function seedAll(t: ReturnType<typeof setupCli>) {
  t.fake.respond("auth describe", AUTH_DESCRIBE);
  t.fake.respond("jobs list-runs", RUNS);
  t.fake.respond("warehouses list", WAREHOUSES);
  t.fake.respond("clusters list", CLUSTERS);
}

describe("home dashboard", () => {
  it("spawns all four panel calls in parallel with exact argv, never --sensitive", async () => {
    seedAll(t);
    const { exitCode } = await t.run(["home"]);
    expect(exitCode).toBe(0);
    const calls = t.fake.calls();
    expect(calls).toContainEqual(["auth", "describe", "-o", "json"]);
    expect(calls).toContainEqual([
      "jobs",
      "list-runs",
      "--limit",
      "5",
      "-o",
      "json",
    ]);
    expect(calls).toContainEqual(["warehouses", "list", "-o", "json"]);
    expect(calls).toContainEqual(["clusters", "list", "-o", "json"]);
    expect(calls.flat()).not.toContain("--sensitive");
  });

  it("renders auth context from the nested v1.6.0 shape", async () => {
    seedAll(t);
    const { out } = await t.run(["home"]);
    expect(out).toContain("user@example.com");
    expect(out).toContain("dbc-abc123.cloud.databricks.com");
    expect(out).toContain("databricks-cli");
    expect(out).toContain("DEFAULT");
  });

  it("sorts recent runs FAILED-first with a per-row jobs logs suggestion", async () => {
    seedAll(t);
    const { out } = await t.run(["home"]);
    expect(out).toContain("jobs logs 2");
    // FAILED run (id 2) renders before the RUNNING (id 1) / SUCCESS (id 3) rows.
    const failedIdx = out.indexOf("FAILED");
    const runningIdx = out.indexOf("RUNNING", out.indexOf("recent_runs"));
    expect(failedIdx).toBeGreaterThan(-1);
    expect(failedIdx).toBeLessThan(runningIdx);
  });

  it("renders warehouses and running clusters (TERMINATED filtered out)", async () => {
    seedAll(t);
    const { out } = await t.run(["home"]);
    expect(out).toContain("Starter Warehouse");
    expect(out).toContain("dev");
    expect(out).not.toContain("TERMINATED");
  });

  it("omits the running_clusters panel entirely on zero non-terminated clusters", async () => {
    t.fake.respond("auth describe", AUTH_DESCRIBE);
    t.fake.respond("jobs list-runs", { runs: [] });
    t.fake.respond("warehouses list", { warehouses: [] });
    t.fake.respond("clusters list", {
      clusters: [
        { cluster_id: "c2", cluster_name: "old", state: "TERMINATED" },
      ],
    });
    const { out, exitCode } = await t.run(["home"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("running_clusters");
  });

  it("degrades one timed-out panel to an unavailable line, others intact, exit 0", async () => {
    t.fake.respond("auth describe", AUTH_DESCRIBE);
    t.fake.respond("jobs list-runs", RUNS);
    t.fake.respondHang("warehouses list");
    t.fake.respond("clusters list", CLUSTERS);
    const { out, exitCode } = await t.run(["home"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("warehouses: unavailable");
    expect(out).toContain("user@example.com");
    expect(out).toContain("dev"); // clusters panel unaffected
  }, 8000);

  it("respects the 4s-per-panel budget in parallel, not serially", async () => {
    t.fake.respondHang("auth describe");
    t.fake.respondHang("jobs list-runs");
    t.fake.respondHang("warehouses list");
    t.fake.respondHang("clusters list");
    const start = Date.now();
    const { exitCode, out } = await t.run(["home"]);
    const elapsed = Date.now() - start;
    expect(exitCode).toBe(0);
    // Serial would be ~16s; parallel should land close to the 4s panel timeout.
    expect(elapsed).toBeLessThan(8000);
    expect(out).toContain("context: unavailable");
    expect(out).toContain("recent_runs: unavailable");
    expect(out).toContain("warehouses: unavailable");
    expect(out).toContain("running_clusters: unavailable");
  }, 15000);

  it("swaps the whole body for the structured AUTH_ERROR and still prints commands", async () => {
    t.fake.respondError(
      "auth describe",
      "Error: token expired\n\nProfile: DEFAULT\nHost: https://dbc-abc123.cloud.databricks.com\nAuth type: OAuth (user)\n",
    );
    t.fake.respond("jobs list-runs", RUNS);
    t.fake.respond("warehouses list", WAREHOUSES);
    t.fake.respond("clusters list", CLUSTERS);
    const { out, exitCode } = await t.run(["home"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("databricks auth login");
    expect(out).toContain("commands:");
    expect(out).not.toContain("recent_runs");
  });

  it("bare invocation renders the same dashboard as `home`", async () => {
    seedAll(t);
    const { out, exitCode } = await t.run([]);
    expect(exitCode).toBe(0);
    expect(out).toContain("user@example.com");
  });

  it("passes --profile through to every panel spawn", async () => {
    seedAll(t);
    await t.run(["home", "--profile", "aws"]);
    for (const call of t.fake.calls()) {
      expect(call.slice(0, 2)).toEqual(["-p", "aws"]);
    }
  });

  it("rejects extra positional arguments", async () => {
    const { exitCode } = await t.run(["home", "extra"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("serves home --help with the dashboard description", async () => {
    const { out, exitCode } = await t.run(["home", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi [home]");
    expect(out).toContain("setup hooks");
  });
});

import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const CLUSTER = {
  cluster_id: "1234-567890-abc123",
  cluster_name: "axi-bench-cluster",
  state: "RUNNING",
};

describe("clusters list", () => {
  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("clusters list", {
      clusters: [
        CLUSTER,
        {
          cluster_id: "9999-000000-xyz999",
          cluster_name: "other",
          state: "TERMINATED",
        },
      ],
    });
    const { out, exitCode } = await t.run(["clusters", "list"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["clusters", "list", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("clusters[2]{cluster_id,cluster_name,state}:");
    expect(out).toContain("1234-567890-abc123,axi-bench-cluster,RUNNING");
    expect(out).toContain("count: 2");
  });

  it("suggests starting a TERMINATED cluster by id", async () => {
    t.fake.respond("clusters list", {
      clusters: [
        CLUSTER,
        {
          cluster_id: "9999-000000-xyz999",
          cluster_name: "other",
          state: "TERMINATED",
        },
      ],
    });
    const { out } = await t.run(["clusters", "list"]);
    expect(out).toContain("clusters view <cluster_id>");
    expect(out).toContain("clusters start 9999-000000-xyz999");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("clusters list", { clusters: [CLUSTER] });
    const { out } = await t.run(["clusters", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("clusters list --limit 2");
  });

  it("passes --limit through", async () => {
    t.fake.respond("clusters list", { clusters: [] });
    await t.run(["clusters", "list", "--limit", "5"]);
    expect(t.fake.calls()).toEqual([
      ["clusters", "list", "--limit", "5", "-o", "json"],
    ]);
  });

  it("renders a definitive empty state with the serverless note", async () => {
    t.fake.respond("clusters list", { clusters: [] });
    const { out, exitCode } = await t.run(["clusters", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no clusters in this workspace");
    expect(out).toContain("serverless");
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("clusters list", {
      clusters: [{ ...CLUSTER, node_type_id: "m6gd.large" }],
    });
    const { out } = await t.run([
      "clusters",
      "list",
      "--fields",
      "cluster_id,node_type_id",
    ]);
    expect(out).toContain("clusters[1]{cluster_id,node_type_id}:");
    expect(out).toContain("1234-567890-abc123,m6gd.large");
  });

  it("rejects a non-integer --limit as a usage error", async () => {
    const { out, exitCode } = await t.run([
      "clusters",
      "list",
      "--limit",
      "abc",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--limit must be a positive integer");
    expect(t.fake.calls()).toEqual([]);
  });

  it("maps a genuine 403 to PERMISSION_DENIED, exit 1", async () => {
    t.fake.respondError(
      "clusters list",
      "Error: PERMISSION_DENIED: no list permission\n",
    );
    const { out, exitCode } = await t.run(["clusters", "list"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: PERMISSION_DENIED");
  });
});

describe("clusters view", () => {
  it("shows cluster detail with a fixed worker count", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      cluster_name: "axi-bench-cluster",
      state: "RUNNING",
      spark_version: "14.3.x-scala2.12",
      node_type_id: "m6gd.large",
      num_workers: 2,
      autotermination_minutes: 60,
      creator_user_name: "a@b.c",
    });
    const { out, exitCode } = await t.run([
      "clusters",
      "view",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["clusters", "get", "1234-567890-abc123", "-o", "json"],
    ]);
    expect(out).toContain("cluster_name: axi-bench-cluster");
    expect(out).toContain("state: RUNNING");
    expect(out).toContain("num_workers: 2");
    expect(out).toContain("node_type_id: m6gd.large");
    expect(out).toContain("clusters stop 1234-567890-abc123");
  });

  it("renders autoscale min-max instead of a fixed worker count", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "RUNNING",
      autoscale: { min_workers: 2, max_workers: 8 },
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).toContain("num_workers: 2-8");
  });

  it("falls back to num_workers when autoscale is missing max_workers", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "RUNNING",
      num_workers: 2,
      autoscale: { min_workers: 2 },
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).toContain("num_workers: 2");
    expect(out).not.toContain("undefined");
  });

  it("falls back to num_workers when autoscale is present but empty", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "RUNNING",
      num_workers: 2,
      autoscale: {},
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).toContain("num_workers: 2");
    expect(out).not.toContain("undefined");
  });

  it("includes state_message when non-empty", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "PENDING",
      state_message: "Starting instances",
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).toContain("state_message: Starting instances");
    expect(out).toContain("clusters start 1234-567890-abc123");
  });

  it("omits state_message when empty", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "TERMINATED",
      state_message: "",
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).not.toContain("state_message");
  });

  it("suggests start for a non-RUNNING cluster and stop for a RUNNING one", async () => {
    t.fake.respond("clusters get", {
      cluster_id: "1234-567890-abc123",
      state: "TERMINATED",
    });
    const { out } = await t.run(["clusters", "view", "1234-567890-abc123"]);
    expect(out).toContain("clusters start 1234-567890-abc123");
  });

  it("maps a missing cluster to NOT_FOUND with a list suggestion", async () => {
    t.fake.respondError("clusters get", "Error: Cluster 999 does not exist.");
    const { out, exitCode } = await t.run(["clusters", "view", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("clusters list");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondError("clusters get", "", 0);
    const { out, exitCode } = await t.run([
      "clusters",
      "view",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });
});

describe("clusters start", () => {
  it("starts async by default with empty upstream stdout", async () => {
    t.fake.respondRaw("clusters start", "");
    const { out, exitCode } = await t.run([
      "clusters",
      "start",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["clusters", "start", "1234-567890-abc123", "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("cluster_id: 1234-567890-abc123");
    expect(out).toContain("start requested");
    expect(out).toContain("clusters view 1234-567890-abc123");
  });

  it("omits --no-wait with --wait and reports the reached state", async () => {
    t.fake.respondRaw("clusters start", "");
    const { out } = await t.run([
      "clusters",
      "start",
      "1234-567890-abc123",
      "--wait",
    ]);
    expect(t.fake.calls()).toEqual([
      ["clusters", "start", "1234-567890-abc123", "-o", "json"],
    ]);
    expect(out).toContain("started, cluster RUNNING");
    expect(out).not.toContain("start requested");
  });

  it("treats the real 'unexpected state Running' error as an exit-0 no-op", async () => {
    t.fake.respondError(
      "clusters start",
      "Error: Cluster 1234-567890-abc123 is in unexpected state Running.",
    );
    const { out, exitCode } = await t.run([
      "clusters",
      "start",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cluster not startable in current state (no-op)");
  });

  it("treats an 'unexpected state Pending' error as the same no-op", async () => {
    t.fake.respondError(
      "clusters start",
      "Error: Cluster 1234-567890-abc123 is in unexpected state Pending.",
    );
    const { out, exitCode } = await t.run([
      "clusters",
      "start",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("cluster not startable in current state (no-op)");
  });

  it("still fails on a nonexistent cluster (NOT_FOUND, exit 1)", async () => {
    t.fake.respondError("clusters start", "Error: Cluster 999 does not exist.");
    const { out, exitCode } = await t.run(["clusters", "start", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).not.toContain("no-op");
  });

  it("still fails on a genuine 403 (PERMISSION_DENIED, exit 1)", async () => {
    t.fake.respondError(
      "clusters start",
      "Error: PERMISSION_DENIED: no manage permission\n",
    );
    const { out, exitCode } = await t.run([
      "clusters",
      "start",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: PERMISSION_DENIED");
    expect(out).not.toContain("no-op");
  });
});

describe("clusters stop", () => {
  it("maps to upstream 'delete', never 'permanent-delete' or 'stop'", async () => {
    t.fake.respondRaw("clusters delete", "");
    const { out, exitCode } = await t.run([
      "clusters",
      "stop",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["clusters", "delete", "1234-567890-abc123", "--no-wait", "-o", "json"],
    ]);
    expect(t.fake.calls()[0]).not.toContain("permanent-delete");
    expect(t.fake.calls()[0]).not.toContain("stop");
    expect(out).toContain("cluster_id: 1234-567890-abc123");
    expect(out).toContain("stop requested");
    expect(out).toContain("clusters view 1234-567890-abc123");
  });

  it("omits --no-wait with --wait and reports the reached state", async () => {
    t.fake.respondRaw("clusters delete", "");
    const { out } = await t.run([
      "clusters",
      "stop",
      "1234-567890-abc123",
      "--wait",
    ]);
    expect(t.fake.calls()).toEqual([
      ["clusters", "delete", "1234-567890-abc123", "-o", "json"],
    ]);
    expect(out).toContain("stopped, cluster TERMINATED");
    expect(out).not.toContain("stop requested");
  });

  it("still exits 0 on an already-terminated cluster (silent upstream no-op)", async () => {
    // Upstream `clusters delete` on a TERMINATED cluster is a genuine
    // no-op: exit 0, empty output — byte-identical to a fresh terminate.
    t.fake.respondRaw("clusters delete", "");
    const { out, exitCode } = await t.run([
      "clusters",
      "stop",
      "1234-567890-abc123",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("stop requested");
  });
});

describe("clusters dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["clusters", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare clusters invocation", async () => {
    const { exitCode } = await t.run(["clusters"]);
    expect(exitCode).toBe(2);
  });

  it("serves clusters --help with the stop->delete mapping note", async () => {
    const { out, exitCode } = await t.run(["clusters", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi clusters");
    expect(out).toContain("clusters delete");
  });

  it("rejects extra positionals on id commands", async () => {
    const { exitCode } = await t.run(["clusters", "view", "abc", "def"]);
    expect(exitCode).toBe(2);
  });

  it("fails loud on an unknown flag", async () => {
    const { out, exitCode } = await t.run(["clusters", "list", "--bogus"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--bogus'");
  });
});

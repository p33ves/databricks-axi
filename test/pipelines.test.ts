import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const PID = "905299c1-874d-44b6-995b-e6a5d2eb1a84";

const PIPELINE = {
  pipeline_id: PID,
  name: "axi-bench-pipeline",
  state: "IDLE",
};

describe("pipelines list", () => {
  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("pipelines list-pipelines", {
      statuses: [
        PIPELINE,
        {
          pipeline_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          name: "other",
          state: "RUNNING",
        },
      ],
    });
    const { out, exitCode } = await t.run(["pipelines", "list"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "list-pipelines", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("pipelines[2]{pipeline_id,name,state}:");
    expect(out).toContain(`${PID},axi-bench-pipeline,IDLE`);
    expect(out).toContain("count: 2");
  });

  it("passes --limit through", async () => {
    t.fake.respond("pipelines list-pipelines", { statuses: [] });
    await t.run(["pipelines", "list", "--limit", "5"]);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "list-pipelines", "--limit", "5", "-o", "json"],
    ]);
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("pipelines list-pipelines", { statuses: [PIPELINE] });
    const { out } = await t.run(["pipelines", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("pipelines list --limit 2");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("pipelines list-pipelines", { statuses: [] });
    const { out, exitCode } = await t.run(["pipelines", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no pipelines in this workspace");
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("pipelines list-pipelines", {
      statuses: [{ ...PIPELINE, creator_user_name: "a@b.c" }],
    });
    const { out } = await t.run([
      "pipelines",
      "list",
      "--fields",
      "pipeline_id,creator_user_name",
    ]);
    expect(out).toContain("pipelines[1]{pipeline_id,creator_user_name}:");
    expect(out).toContain(`${PID},a@b.c`);
  });
});

describe("pipelines view", () => {
  it("shows pipeline detail with latest updates and spec fields", async () => {
    t.fake.respond("pipelines get", {
      pipeline_id: PID,
      name: "axi-bench-pipeline",
      state: "IDLE",
      latest_updates: [
        {
          update_id: "f4a37bc3-603c-4b30-84ed-ae578deed323",
          state: "COMPLETED",
          creation_time: "2026-07-10T07:30:51.112Z",
        },
      ],
      spec: {
        id: PID,
        catalog: "workspace",
        schema: "default",
        continuous: false,
        serverless: true,
      },
    });
    const { out, exitCode } = await t.run(["pipelines", "view", PID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["pipelines", "get", PID, "-o", "json"]]);
    expect(out).toContain("name: axi-bench-pipeline");
    expect(out).toContain("state: IDLE");
    expect(out).toContain("catalog: workspace");
    expect(out).toContain("schema: default");
    expect(out).toContain("continuous: false");
    expect(out).toContain("f4a37bc3-603c-4b30-84ed-ae578deed323");
    expect(out).toContain(`pipelines start ${PID}`);
  });

  it("slices latest_updates to 3", async () => {
    t.fake.respond("pipelines get", {
      pipeline_id: PID,
      name: "axi-bench-pipeline",
      state: "IDLE",
      latest_updates: [
        { update_id: "1", state: "COMPLETED", creation_time: "t1" },
        { update_id: "2", state: "COMPLETED", creation_time: "t2" },
        { update_id: "3", state: "COMPLETED", creation_time: "t3" },
        { update_id: "4", state: "COMPLETED", creation_time: "t4" },
      ],
    });
    const { out } = await t.run(["pipelines", "view", PID]);
    expect(out).toContain("latest_updates[3]");
    expect(out).toContain('"1",COMPLETED');
    expect(out).not.toContain('"4",COMPLETED');
  });

  it("suggests events for a failed latest update", async () => {
    t.fake.respond("pipelines get", {
      pipeline_id: PID,
      name: "axi-bench-pipeline",
      state: "IDLE",
      latest_updates: [
        { update_id: "1", state: "FAILED", creation_time: "t1" },
      ],
    });
    const { out } = await t.run(["pipelines", "view", PID]);
    expect(out).toContain(`pipelines events ${PID}`);
  });

  it("suggests stop for a RUNNING pipeline", async () => {
    t.fake.respond("pipelines get", {
      pipeline_id: PID,
      name: "axi-bench-pipeline",
      state: "RUNNING",
    });
    const { out } = await t.run(["pipelines", "view", PID]);
    expect(out).toContain(`pipelines stop ${PID}`);
  });

  it("rejects a non-UUID pipeline_id (bundle-KEY hazard guard)", async () => {
    const { out, exitCode } = await t.run([
      "pipelines",
      "view",
      "my-bundle-key",
    ]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
    expect(out).toContain("pipelines view <pipeline_id>");
  });

  it("maps the live pipeline-404 shape ('was not found') to NOT_FOUND", async () => {
    t.fake.respondError(
      "pipelines get",
      `Error: The specified pipeline ${PID} was not found.`,
    );
    const { out, exitCode } = await t.run(["pipelines", "view", PID]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("pipelines list");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondError("pipelines get", "", 0);
    const { out, exitCode } = await t.run(["pipelines", "view", PID]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });
});

describe("pipelines start", () => {
  it("maps to start-update, no wait flags, and requests async", async () => {
    t.fake.respond("pipelines start-update", { update_id: "new-update-id" });
    const { out, exitCode } = await t.run(["pipelines", "start", PID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "start-update", PID, "-o", "json"],
    ]);
    expect(out).toContain(`pipeline_id: ${PID}`);
    expect(out).toContain("update_id: new-update-id");
    expect(out).toContain("update requested");
    expect(out).toContain(`pipelines view ${PID}`);
  });

  it("converts a conflicting active-update error to an exit-0 no-op", async () => {
    t.fake.respondError(
      "pipelines start-update",
      `Error: An active update 'f4a37bc3-603c-4b30-84ed-ae578deed323' already exists for pipeline '${PID}'.`,
    );
    const { out, exitCode } = await t.run(["pipelines", "start", PID]);
    expect(exitCode).toBe(0);
    expect(out).toContain("update already in progress");
    expect(out).toContain("f4a37bc3-603c-4b30-84ed-ae578deed323");
  });

  it("still fails on a nonexistent pipeline (NOT_FOUND, exit 1)", async () => {
    t.fake.respondError(
      "pipelines start-update",
      `Error: The specified pipeline ${PID} was not found.`,
    );
    const { out, exitCode } = await t.run(["pipelines", "start", PID]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).not.toContain("no-op");
  });

  it("rejects a non-UUID pipeline_id before spawning", async () => {
    const { exitCode } = await t.run(["pipelines", "start", "my-key"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("pipelines stop", () => {
  it("passes --no-wait and always exits 0 with empty upstream stdout", async () => {
    t.fake.respondRaw("pipelines stop", "");
    const { out, exitCode } = await t.run(["pipelines", "stop", PID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "stop", PID, "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain(`pipeline_id: ${PID}`);
    expect(out).toContain("stop requested");
  });

  it("exits 0 the same way on an already-IDLE pipeline (no rejection shape)", async () => {
    t.fake.respondRaw("pipelines stop", "");
    const { out, exitCode } = await t.run(["pipelines", "stop", PID]);
    expect(exitCode).toBe(0);
    expect(out).toContain("stop requested");
  });

  it("rejects a non-UUID pipeline_id before spawning (bundle-KEY hazard)", async () => {
    const { exitCode } = await t.run(["pipelines", "stop", "my-bundle-key"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("pipelines events", () => {
  const EVENTS = {
    events: [
      {
        timestamp: "2026-07-10T07:00:00.000Z",
        level: "INFO",
        event_type: "update_progress",
        message: "Update started",
      },
      {
        timestamp: "2026-07-10T07:05:00.000Z",
        level: "ERROR",
        event_type: "flow_progress",
        message: "Boom: table missing",
      },
    ],
  };

  it("passes exact argv, sorts newest-first with ERROR rows first", async () => {
    t.fake.respond("pipelines list-pipeline-events", EVENTS);
    const { out, exitCode } = await t.run(["pipelines", "events", PID]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "list-pipeline-events", PID, "--limit", "25", "-o", "json"],
    ]);
    expect(out).toContain("events[2]{timestamp,level,event_type,message}:");
    expect(out.indexOf("Boom: table missing")).toBeLessThan(
      out.indexOf("Update started"),
    );
  });

  it("passes --limit through", async () => {
    t.fake.respond("pipelines list-pipeline-events", { events: [] });
    await t.run(["pipelines", "events", PID, "--limit", "5"]);
    expect(t.fake.calls()).toEqual([
      ["pipelines", "list-pipeline-events", PID, "--limit", "5", "-o", "json"],
    ]);
  });

  it("head-truncates a long message to 200 chars by default", async () => {
    const long = "word ".repeat(60); // 300 chars, spaced so it isn't token-shaped
    t.fake.respond("pipelines list-pipeline-events", {
      events: [
        {
          timestamp: "2026-07-10T07:00:00.000Z",
          level: "INFO",
          event_type: "update_progress",
          message: long,
        },
      ],
    });
    const { out } = await t.run(["pipelines", "events", PID]);
    expect(out).not.toContain(long);
    expect(out).toContain(long.slice(0, 200));
    expect(out).toContain(`pipelines events ${PID} --full`);
  });

  it("--full disables message truncation", async () => {
    const long = "word ".repeat(60); // 300 chars, spaced so it isn't token-shaped
    t.fake.respond("pipelines list-pipeline-events", {
      events: [
        {
          timestamp: "2026-07-10T07:00:00.000Z",
          level: "INFO",
          event_type: "update_progress",
          message: long,
        },
      ],
    });
    const { out } = await t.run(["pipelines", "events", PID, "--full"]);
    expect(out).toContain(long);
  });

  it("redacts token-shaped strings in event messages", async () => {
    t.fake.respond("pipelines list-pipeline-events", {
      events: [
        {
          timestamp: "2026-07-10T07:00:00.000Z",
          level: "ERROR",
          event_type: "flow_progress",
          message: "auth failed for dapi1234567890abcdef",
        },
      ],
    });
    const { out } = await t.run(["pipelines", "events", PID]);
    expect(out).not.toContain("dapi1234567890abcdef");
    expect(out).toContain("[redacted]");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("pipelines list-pipeline-events", { events: [] });
    const { out, exitCode } = await t.run(["pipelines", "events", PID]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no events for this pipeline");
  });

  it("rejects a non-UUID pipeline_id before spawning", async () => {
    const { exitCode } = await t.run(["pipelines", "events", "my-key"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("pipelines dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["pipelines", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare pipelines invocation", async () => {
    const { exitCode } = await t.run(["pipelines"]);
    expect(exitCode).toBe(2);
  });

  it("serves pipelines --help with the start-update/stop mapping notes", async () => {
    const { out, exitCode } = await t.run(["pipelines", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi pipelines");
    expect(out).toContain("start-update");
  });
});

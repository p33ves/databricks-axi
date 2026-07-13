import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const JOB = {
  job_id: 101,
  creator_user_name: "a@b.c",
  settings: { name: "axi-bench-etl" },
};

describe("jobs list", () => {
  it("passes exact argv and renders default fields", async () => {
    t.fake.respond("jobs list", {
      jobs: [
        JOB,
        {
          job_id: 102,
          creator_user_name: "d@e.f",
          settings: { name: "other" },
        },
      ],
    });
    const { out, exitCode } = await t.run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("jobs[2]{job_id,name,creator_user_name}:");
    expect(out).toContain("101,axi-bench-etl,a@b.c");
    expect(out).toContain("count: 2");
  });

  it("tolerates a bare-array response", async () => {
    t.fake.respond("jobs list", [JOB]);
    const { out, exitCode } = await t.run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("jobs[1]");
    expect(out).toContain("axi-bench-etl");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("jobs list", { jobs: [JOB] });
    const { out } = await t.run(["jobs", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("jobs list --limit 2");
  });

  it("passes --limit through", async () => {
    t.fake.respond("jobs list", { jobs: [] });
    await t.run(["jobs", "list", "--limit", "5"]);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list", "--limit", "5", "-o", "json"],
    ]);
  });

  it("rejects a scientific-notation --limit (decimal digits only)", async () => {
    const { out, exitCode } = await t.run(["jobs", "list", "--limit", "1e3"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--limit must be a positive integer");
  });

  it("rejects a non-integer --limit as a usage error", async () => {
    const { out, exitCode } = await t.run(["jobs", "list", "--limit", "abc"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--limit must be a positive integer");
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects --limit 0", async () => {
    const { exitCode } = await t.run(["jobs", "list", "--limit", "0"]);
    expect(exitCode).toBe(2);
  });

  it("accepts --fields keys that only later items carry", async () => {
    t.fake.respond("jobs list", {
      jobs: [JOB, { job_id: 102, extra: "x" }],
    });
    const { out, exitCode } = await t.run([
      "jobs",
      "list",
      "--fields",
      "job_id,extra",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("102,x");
  });

  it("rejects the removed --page-token flag", async () => {
    const { out, exitCode } = await t.run([
      "jobs",
      "list",
      "--page-token",
      "tok123",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option '--page-token'");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("jobs list", { jobs: [] });
    const { out, exitCode } = await t.run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no jobs in this workspace");
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("jobs list", { jobs: [{ ...JOB, created_time: 5 }] });
    const { out } = await t.run([
      "jobs",
      "list",
      "--fields",
      "job_id,created_time",
    ]);
    expect(out).toContain("jobs[1]{job_id,created_time}:");
    expect(out).toContain("101,5");
  });

  it("rejects unknown --fields values listing what exists", async () => {
    t.fake.respond("jobs list", { jobs: [JOB] });
    const { out, exitCode } = await t.run(["jobs", "list", "--fields", "nope"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: nope");
    expect(out).toContain("job_id");
  });

  it("rejects unknown flags listing valid ones", async () => {
    const { out, exitCode } = await t.run(["jobs", "list", "--frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--frobnicate");
    expect(out).toContain("--limit");
  });

  it("passes --profile as leading -p", async () => {
    t.fake.respond("-p dev jobs list", { jobs: [] });
    await t.run(["jobs", "list", "--profile", "dev"]);
    expect(t.fake.calls()).toEqual([
      ["-p", "dev", "jobs", "list", "--limit", "30", "-o", "json"],
    ]);
  });

  it("maps auth failures to a structured AUTH_ERROR without leaking tokens", async () => {
    t.fake.respondError(
      "jobs list",
      "Error: 401 Unauthorized dapi1234567890abcdef",
    );
    const { out, exitCode } = await t.run(["jobs", "list"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("databricks auth login");
    expect(out).not.toContain("dapi1234");
  });
});

describe("jobs view", () => {
  it("shows job details, schedule, and tasks", async () => {
    t.fake.respond("jobs get", {
      job_id: 101,
      creator_user_name: "a@b.c",
      settings: {
        name: "axi-bench-etl",
        schedule: {
          quartz_cron_expression: "0 0 3 * * ?",
          pause_status: "PAUSED",
        },
        tasks: [
          {
            task_key: "extract",
            notebook_task: { notebook_path: "/Shared/etl" },
          },
        ],
      },
    });
    const { out, exitCode } = await t.run(["jobs", "view", "101"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["jobs", "get", "101", "-o", "json"]]);
    expect(out).toContain("name: axi-bench-etl");
    // Same key as jobs list and the spec — not a bare `creator`.
    expect(out).toContain("creator_user_name: a@b.c");
    expect(out).toContain("0 0 3 * * ?");
    expect(out).toContain("tasks[1]{task_key,type}:");
    expect(out).toContain("extract");
    expect(out).toContain("jobs run 101");
  });

  it("maps missing jobs to NOT_FOUND with list suggestions", async () => {
    t.fake.respondError("jobs get", "Error: Job 999 does not exist.");
    const { out, exitCode } = await t.run(["jobs", "view", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("jobs list");
  });

  it("requires a numeric job id", async () => {
    const { out, exitCode } = await t.run(["jobs", "view", "banana"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("jobs view <job_id>");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondError("jobs get", "", 0);
    const { out, exitCode } = await t.run(["jobs", "view", "101"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });
});

describe("jobs run", () => {
  it("triggers async by default and suggests runs view", async () => {
    t.fake.respond("jobs run-now", { run_id: 777 });
    const { out, exitCode } = await t.run(["jobs", "run", "101"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "run-now", "101", "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("run_id: 777");
    expect(out).toContain("jobs runs view 777");
  });

  it("drops --no-wait with --wait", async () => {
    t.fake.respond("jobs run-now", {
      run_id: 778,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
    });
    const { out } = await t.run(["jobs", "run", "101", "--wait"]);
    expect(t.fake.calls()).toEqual([["jobs", "run-now", "101", "-o", "json"]]);
    expect(out).toContain("state: SUCCESS");
  });

  it("requires a numeric job id", async () => {
    const { exitCode } = await t.run(["jobs", "run", "nope"]);
    expect(exitCode).toBe(2);
  });
});

describe("jobs cancel", () => {
  it("cancels async and confirms", async () => {
    t.fake.respondError("jobs cancel-run", "", 0);
    const { out, exitCode } = await t.run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "cancel-run", "777", "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("cancel requested");
    expect(out).toContain("jobs runs view 777");
  });

  it("treats an already-terminated run as an exit-0 no-op", async () => {
    t.fake.respondError(
      "jobs cancel-run",
      "Error: INVALID_STATE: Run 777 is already in a terminal state TERMINATED",
    );
    const { out, exitCode } = await t.run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run already terminated (no-op)");
  });

  it("still fails on real cancel errors", async () => {
    t.fake.respondError("jobs cancel-run", "Error: Run 999 does not exist.");
    const { out, exitCode } = await t.run(["jobs", "cancel", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
  });

  it("treats a cannot-be-canceled message as an exit-0 no-op", async () => {
    t.fake.respondError(
      "jobs cancel-run",
      "Error: Run 777 cannot be canceled since it is already completed",
    );
    const { out, exitCode } = await t.run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run already terminated (no-op)");
  });
});

describe("jobs dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["jobs", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects extra positionals on id commands", async () => {
    const { exitCode } = await t.run(["jobs", "view", "101", "102"]);
    expect(exitCode).toBe(2);
  });

  it("rejects a value flag without a value", async () => {
    const { out, exitCode } = await t.run(["jobs", "list", "--limit"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("argument missing");
  });

  it("rejects a bare jobs invocation", async () => {
    const { exitCode } = await t.run(["jobs"]);
    expect(exitCode).toBe(2);
  });

  it("serves jobs --help", async () => {
    const { out, exitCode } = await t.run(["jobs", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi jobs");
  });
});

const RUNS = {
  runs: [
    {
      run_id: 901,
      job_id: 101,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      start_time: 1751760000000,
      run_duration: 63000,
    },
    {
      run_id: 902,
      job_id: 101,
      state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
      start_time: 1751763600000,
      run_duration: 12000,
    },
  ],
};

describe("jobs runs", () => {
  it("lists runs across jobs with job_id first so runs map back to jobs", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out, exitCode } = await t.run(["jobs", "runs"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "20", "-o", "json"],
    ]);
    // Bulk mode (no job_id positional): job_id is in the default columns so
    // an agent can answer cross-job questions ("jobs never run") in one call.
    expect(out).toContain(
      "runs[2]{job_id,run_id,state,start_time,duration_s}:",
    );
    // Row assertions stay tolerant of TOON's string-quoting rules for the
    // ISO timestamp cell: assert the pieces, not the exact joined row.
    expect(out).toContain("101,901,SUCCESS");
    expect(out).toContain("2025-07-06T00:00:00.000Z");
    expect(out).toContain("101,902,FAILED");
    expect(out).toContain("2025-07-06T01:00:00.000Z");
  });

  it("omits job_id when filtered to one job (redundant) and suggests logs", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run(["jobs", "runs", "101"]);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "20", "--job-id", "101", "-o", "json"],
    ]);
    expect(out).toContain("runs[2]{run_id,state,start_time,duration_s}:");
    expect(out).toContain("jobs logs 902");
  });

  it("selects raw fields with --fields on runs", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run(["jobs", "runs", "--fields", "run_id,job_id"]);
    expect(out).toContain("runs[2]{run_id,job_id}:");
    expect(out).toContain("901,101");
  });

  it("exposes the derived display fields to --fields too", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run([
      "jobs",
      "runs",
      "--fields",
      "run_id,duration_s,state",
    ]);
    expect(out).toContain("runs[2]{run_id,duration_s,state}:");
    expect(out).toContain("901,63,SUCCESS");
  });

  it("treats non-SUCCESS terminal states like TIMEDOUT as failed", async () => {
    t.fake.respond("jobs list-runs", {
      runs: [
        {
          run_id: 903,
          job_id: 101,
          state: { life_cycle_state: "TERMINATED", result_state: "TIMEDOUT" },
        },
      ],
    });
    const { out } = await t.run(["jobs", "runs"]);
    expect(out).toContain("jobs logs 903");
  });

  it("flags a full page as has_more, keeping the job_id filter", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run([
      "jobs",
      "runs",
      "101",
      "--limit",
      String(RUNS.runs.length),
    ]);
    expect(out).toContain("has_more: true");
    expect(out).toContain(`jobs runs 101 --limit ${RUNS.runs.length * 2}`);
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["jobs", "runs", "101"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no runs found");
  });
});

describe("--profile in suggested commands", () => {
  it("threads --profile into help follow-ups", async () => {
    t.fake.respond("-p dev jobs get-run", {
      run_id: 902,
      job_id: 101,
      state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
    });
    const { out } = await t.run([
      "jobs",
      "runs",
      "view",
      "902",
      "--profile",
      "dev",
    ]);
    expect(out).toContain("jobs logs 902 --profile dev");
  });

  it("threads --profile into NOT_FOUND suggestions", async () => {
    t.fake.respondError("-p dev jobs get", "Error: Job 999 does not exist.");
    const { out, exitCode } = await t.run([
      "jobs",
      "view",
      "999",
      "--profile",
      "dev",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("jobs list --profile dev");
  });
});

describe("jobs runs view", () => {
  it("shows run detail with per-task states", async () => {
    t.fake.respond("jobs get-run", {
      run_id: 902,
      job_id: 101,
      state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
      start_time: 1751763600000,
      run_duration: 12000,
      tasks: [
        {
          task_key: "extract",
          run_id: 9021,
          state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
          execution_duration: 5000,
        },
        {
          task_key: "transform",
          run_id: 9022,
          state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
          execution_duration: 4000,
        },
      ],
    });
    const { out, exitCode } = await t.run(["jobs", "runs", "view", "902"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([["jobs", "get-run", "902", "-o", "json"]]);
    expect(out).toContain("state: FAILED");
    expect(out).toContain("tasks[2]{task_key,state,duration_s}:");
    expect(out).toContain("transform,FAILED");
    expect(out).toContain("jobs logs 902");
  });
});

describe("jobs logs", () => {
  const RUN_WITH_TASKS = {
    run_id: 902,
    state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
    tasks: [
      {
        task_key: "extract",
        run_id: 9021,
        state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      },
      {
        task_key: "transform",
        run_id: 9022,
        state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
      },
    ],
  };

  it("fans out to task run ids and renders failed tasks first", async () => {
    t.fake.respond("jobs get-run", RUN_WITH_TASKS);
    t.fake.respond("jobs get-run-output 9021", {
      notebook_output: { result: "extract ok" },
    });
    t.fake.respond("jobs get-run-output 9022", {
      error: "Boom: table missing",
      error_trace: "Traceback: ...",
    });
    const { out, exitCode } = await t.run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "get-run", "902", "-o", "json"],
      ["jobs", "get-run-output", "9021", "-o", "json"],
      ["jobs", "get-run-output", "9022", "-o", "json"],
    ]);
    expect(out).toContain("Boom: table missing");
    expect(out.indexOf("transform")).toBeLessThan(out.indexOf("extract"));
  });

  it("redacts token-shaped strings in error, trace, and log output", async () => {
    t.fake.respond("jobs get-run", RUN_WITH_TASKS);
    t.fake.respond("jobs get-run-output 9021", {
      logs: "exported DATABRICKS_TOKEN=dapi1234567890abcdef ok",
    });
    t.fake.respond("jobs get-run-output 9022", {
      error: "auth failed for dapi1234567890abcdef",
      error_trace: "Traceback: token dkeaAbc12345XYZ rejected",
    });
    const { out, exitCode } = await t.run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("dapi1234567890abcdef");
    expect(out).not.toContain("dkeaAbc12345XYZ");
    expect(out).toContain("[redacted]");
  });

  it("redacts a dkea token immediately preceded by a word character in real CLI stdout", async () => {
    t.fake.respond("jobs get-run", RUN_WITH_TASKS);
    t.fake.respond("jobs get-run-output 9021", {
      notebook_output: { result: "extract ok" },
    });
    t.fake.respond("jobs get-run-output 9022", {
      error: "auth failed for prefix_dkeaAbc12345XYZ",
      error_trace: "Traceback: token prefix_dkeaAbc12345XYZ rejected",
    });
    const { out, exitCode } = await t.run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(out).not.toContain("dkeaAbc12345XYZ");
    expect(out).toContain("prefix_[redacted]");
  });

  it("skips tasks without a run_id instead of fetching 'undefined'", async () => {
    t.fake.respond("jobs get-run", {
      run_id: 904,
      state: { life_cycle_state: "RUNNING" },
      tasks: [
        { task_key: "pending", state: { life_cycle_state: "PENDING" } },
        {
          task_key: "done",
          run_id: 9041,
          state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
        },
      ],
    });
    t.fake.respond("jobs get-run-output 9041", { logs: "done ok" });
    const { out, exitCode } = await t.run(["jobs", "logs", "904"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "get-run", "904", "-o", "json"],
      ["jobs", "get-run-output", "9041", "-o", "json"],
    ]);
    expect(out).toContain("output unavailable");
  });

  it("fans out even for a single-task run (parent id would fail upstream)", async () => {
    t.fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        {
          task_key: "only",
          run_id: 9031,
          state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
        },
      ],
    });
    t.fake.respond("jobs get-run-output 9031", { logs: "fine" });
    await t.run(["jobs", "logs", "903"]);
    expect(t.fake.calls()[1]).toEqual([
      "jobs",
      "get-run-output",
      "9031",
      "-o",
      "json",
    ]);
  });

  it("falls back to logs when the notebook result is empty", async () => {
    t.fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "SUCCESS" } },
      ],
    });
    t.fake.respond("jobs get-run-output 9031", {
      notebook_output: { result: "" },
      logs: "driver logs here",
    });
    const { out } = await t.run(["jobs", "logs", "903"]);
    expect(out).toContain("driver logs here");
  });

  it("truncates long output to the last 50 lines with a marker", async () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
    );
    t.fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "SUCCESS" } },
      ],
    });
    t.fake.respond("jobs get-run-output 9031", { logs: lines.join("\n") });
    const { out } = await t.run(["jobs", "logs", "903"]);
    expect(out).toContain("showing last 50 of 60 lines");
    expect(out).toContain("line-060");
    expect(out).not.toContain("line-005");
  });

  it("marks a clipped error_trace with a truncation hint", async () => {
    const trace = Array.from({ length: 60 }, (_, i) => `frame-${i}`).join("\n");
    t.fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "FAILED" } },
      ],
    });
    t.fake.respond("jobs get-run-output 9031", {
      error: "Boom",
      error_trace: trace,
    });
    const { out } = await t.run(["jobs", "logs", "903"]);
    expect(out).toContain("frame-59");
    expect(out).not.toContain("frame-5\n");
    expect(out).toContain("error_trace clipped to last 50 lines");
  });

  it("keeps going when one task's output fetch fails", async () => {
    t.fake.respond("jobs get-run", RUN_WITH_TASKS);
    t.fake.respondError("jobs get-run-output 9021", "Error: boom upstream");
    t.fake.respond("jobs get-run-output 9022", { logs: "transform ok" });
    const { out, exitCode } = await t.run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("output fetch failed");
    expect(out).toContain("transform ok");
  });

  it("--full disables truncation", async () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
    );
    t.fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "SUCCESS" } },
      ],
    });
    t.fake.respond("jobs get-run-output 9031", { logs: lines.join("\n") });
    const { out } = await t.run(["jobs", "logs", "903", "--full"]);
    expect(out).toContain("line-001");
    expect(out).not.toContain("showing last");
  });

  it("reports a run with no tasks definitively", async () => {
    t.fake.respond("jobs get-run", {
      run_id: 904,
      state: { life_cycle_state: "PENDING" },
      tasks: [],
    });
    const { out, exitCode } = await t.run(["jobs", "logs", "904"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run has no tasks");
  });
});

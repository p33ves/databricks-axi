import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import {
  installFakeDatabricks,
  type FakeDatabricks,
} from "./helpers/fake-databricks.js";

let fake: FakeDatabricks;
let prevPath: string | undefined;

beforeEach(() => {
  fake = installFakeDatabricks();
  prevPath = process.env.PATH;
  process.env.PATH = `${fake.binDir}:${prevPath ?? ""}`;
  process.exitCode = undefined;
});
afterEach(() => {
  process.env.PATH = prevPath;
  process.exitCode = undefined;
});

async function run(argv: string[]): Promise<{ out: string; exitCode: number }> {
  let out = "";
  await main({ argv, stdout: { write: (c: string) => ((out += c), true) } });
  return {
    out,
    exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode),
  };
}

const JOB = {
  job_id: 101,
  creator_user_name: "a@b.c",
  settings: { name: "axi-bench-etl" },
};

describe("jobs list", () => {
  it("passes exact argv and renders default fields", async () => {
    fake.respond("jobs list", {
      jobs: [
        JOB,
        {
          job_id: 102,
          creator_user_name: "d@e.f",
          settings: { name: "other" },
        },
      ],
    });
    const { out, exitCode } = await run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "list", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("jobs[2]{job_id,name,creator_user_name}:");
    expect(out).toContain("101,axi-bench-etl,a@b.c");
    expect(out).toContain("count: 2");
  });

  it("tolerates a bare-array response", async () => {
    fake.respond("jobs list", [JOB]);
    const { out, exitCode } = await run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("jobs[1]");
    expect(out).toContain("axi-bench-etl");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    fake.respond("jobs list", { jobs: [JOB] });
    const { out } = await run(["jobs", "list", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("jobs list --limit 2");
  });

  it("passes --limit through", async () => {
    fake.respond("jobs list", { jobs: [] });
    await run(["jobs", "list", "--limit", "5"]);
    expect(fake.calls()).toEqual([
      ["jobs", "list", "--limit", "5", "-o", "json"],
    ]);
  });

  it("rejects a non-integer --limit as a usage error", async () => {
    const { out, exitCode } = await run(["jobs", "list", "--limit", "abc"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--limit must be a positive integer");
    expect(fake.calls()).toEqual([]);
  });

  it("rejects --limit 0", async () => {
    const { exitCode } = await run(["jobs", "list", "--limit", "0"]);
    expect(exitCode).toBe(2);
  });

  it("accepts --fields keys that only later items carry", async () => {
    fake.respond("jobs list", {
      jobs: [JOB, { job_id: 102, extra: "x" }],
    });
    const { out, exitCode } = await run([
      "jobs",
      "list",
      "--fields",
      "job_id,extra",
    ]);
    expect(exitCode).toBe(0);
    expect(out).toContain("102,x");
  });

  it("rejects the removed --page-token flag", async () => {
    const { out, exitCode } = await run([
      "jobs",
      "list",
      "--page-token",
      "tok123",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown flag: --page-token");
  });

  it("renders a definitive empty state", async () => {
    fake.respond("jobs list", { jobs: [] });
    const { out, exitCode } = await run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no jobs in this workspace");
  });

  it("selects raw fields with --fields", async () => {
    fake.respond("jobs list", { jobs: [{ ...JOB, created_time: 5 }] });
    const { out } = await run([
      "jobs",
      "list",
      "--fields",
      "job_id,created_time",
    ]);
    expect(out).toContain("jobs[1]{job_id,created_time}:");
    expect(out).toContain("101,5");
  });

  it("rejects unknown --fields values listing what exists", async () => {
    fake.respond("jobs list", { jobs: [JOB] });
    const { out, exitCode } = await run(["jobs", "list", "--fields", "nope"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown field: nope");
    expect(out).toContain("job_id");
  });

  it("rejects unknown flags listing valid ones", async () => {
    const { out, exitCode } = await run(["jobs", "list", "--frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("--frobnicate");
    expect(out).toContain("--limit");
  });

  it("passes --profile as leading -p", async () => {
    fake.respond("-p dev jobs list", { jobs: [] });
    await run(["jobs", "list", "--profile", "dev"]);
    expect(fake.calls()).toEqual([
      ["-p", "dev", "jobs", "list", "--limit", "30", "-o", "json"],
    ]);
  });

  it("maps auth failures to a structured AUTH_ERROR without leaking tokens", async () => {
    fake.respondError(
      "jobs list",
      "Error: 401 Unauthorized dapi1234567890abcdef",
    );
    const { out, exitCode } = await run(["jobs", "list"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: AUTH_ERROR");
    expect(out).toContain("databricks auth login");
    expect(out).not.toContain("dapi1234");
  });
});

describe("jobs view", () => {
  it("shows job details, schedule, and tasks", async () => {
    fake.respond("jobs get", {
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
    const { out, exitCode } = await run(["jobs", "view", "101"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([["jobs", "get", "101", "-o", "json"]]);
    expect(out).toContain("name: axi-bench-etl");
    expect(out).toContain("0 0 3 * * ?");
    expect(out).toContain("tasks[1]{task_key,type}:");
    expect(out).toContain("extract");
    expect(out).toContain("jobs run 101");
  });

  it("maps missing jobs to NOT_FOUND with list suggestions", async () => {
    fake.respondError("jobs get", "Error: Job 999 does not exist.");
    const { out, exitCode } = await run(["jobs", "view", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("jobs list");
  });

  it("requires a numeric job id", async () => {
    const { out, exitCode } = await run(["jobs", "view", "banana"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("jobs view <job_id>");
  });

  it("maps an empty upstream response to a structured error", async () => {
    fake.respondError("jobs get", "", 0);
    const { out, exitCode } = await run(["jobs", "view", "101"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("empty response");
  });
});

describe("jobs run", () => {
  it("triggers async by default and suggests runs view", async () => {
    fake.respond("jobs run-now", { run_id: 777 });
    const { out, exitCode } = await run(["jobs", "run", "101"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "run-now", "101", "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("run_id: 777");
    expect(out).toContain("jobs runs view 777");
  });

  it("drops --no-wait with --wait", async () => {
    fake.respond("jobs run-now", {
      run_id: 778,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
    });
    const { out } = await run(["jobs", "run", "101", "--wait"]);
    expect(fake.calls()).toEqual([["jobs", "run-now", "101", "-o", "json"]]);
    expect(out).toContain("state: SUCCESS");
  });

  it("requires a numeric job id", async () => {
    const { exitCode } = await run(["jobs", "run", "nope"]);
    expect(exitCode).toBe(2);
  });
});

describe("jobs cancel", () => {
  it("cancels async and confirms", async () => {
    fake.respondError("jobs cancel-run", "", 0);
    const { out, exitCode } = await run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "cancel-run", "777", "--no-wait", "-o", "json"],
    ]);
    expect(out).toContain("cancel requested");
    expect(out).toContain("jobs runs view 777");
  });

  it("treats an already-terminated run as an exit-0 no-op", async () => {
    fake.respondError(
      "jobs cancel-run",
      "Error: INVALID_STATE: Run 777 is already in a terminal state TERMINATED",
    );
    const { out, exitCode } = await run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run already terminated (no-op)");
  });

  it("still fails on real cancel errors", async () => {
    fake.respondError("jobs cancel-run", "Error: Run 999 does not exist.");
    const { out, exitCode } = await run(["jobs", "cancel", "999"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
  });

  it("treats a cannot-be-canceled message as an exit-0 no-op", async () => {
    fake.respondError(
      "jobs cancel-run",
      "Error: Run 777 cannot be canceled since it is already completed",
    );
    const { out, exitCode } = await run(["jobs", "cancel", "777"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run already terminated (no-op)");
  });
});

describe("jobs dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await run(["jobs", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects extra positionals on id commands", async () => {
    const { exitCode } = await run(["jobs", "view", "101", "102"]);
    expect(exitCode).toBe(2);
  });

  it("rejects a value flag without a value", async () => {
    const { out, exitCode } = await run(["jobs", "list", "--limit"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("requires a value");
  });

  it("rejects a bare jobs invocation", async () => {
    const { exitCode } = await run(["jobs"]);
    expect(exitCode).toBe(2);
  });

  it("serves jobs --help", async () => {
    const { out, exitCode } = await run(["jobs", "--help"]);
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
  it("lists runs with compact state, ISO time, and duration", async () => {
    fake.respond("jobs list-runs", RUNS);
    const { out, exitCode } = await run(["jobs", "runs"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "20", "-o", "json"],
    ]);
    expect(out).toContain("runs[2]{run_id,state,start_time,duration_s}:");
    // Row assertions stay tolerant of TOON's string-quoting rules for the
    // ISO timestamp cell: assert the pieces, not the exact joined row.
    expect(out).toContain("901,SUCCESS");
    expect(out).toContain("2025-07-06T00:00:00.000Z");
    expect(out).toContain("902,FAILED");
    expect(out).toContain("2025-07-06T01:00:00.000Z");
  });

  it("filters by job id and suggests logs for the first failed run", async () => {
    fake.respond("jobs list-runs", RUNS);
    const { out } = await run(["jobs", "runs", "101"]);
    expect(fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "20", "--job-id", "101", "-o", "json"],
    ]);
    expect(out).toContain("jobs logs 902");
  });

  it("selects raw fields with --fields on runs", async () => {
    fake.respond("jobs list-runs", RUNS);
    const { out } = await run(["jobs", "runs", "--fields", "run_id,job_id"]);
    expect(out).toContain("runs[2]{run_id,job_id}:");
    expect(out).toContain("901,101");
  });

  it("treats non-SUCCESS terminal states like TIMEDOUT as failed", async () => {
    fake.respond("jobs list-runs", {
      runs: [
        {
          run_id: 903,
          job_id: 101,
          state: { life_cycle_state: "TERMINATED", result_state: "TIMEDOUT" },
        },
      ],
    });
    const { out } = await run(["jobs", "runs"]);
    expect(out).toContain("jobs logs 903");
  });

  it("flags a full page as has_more, keeping the job_id filter", async () => {
    fake.respond("jobs list-runs", RUNS);
    const { out } = await run([
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
    fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await run(["jobs", "runs", "101"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("no runs found");
  });
});

describe("jobs runs view", () => {
  it("shows run detail with per-task states", async () => {
    fake.respond("jobs get-run", {
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
    const { out, exitCode } = await run(["jobs", "runs", "view", "902"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([["jobs", "get-run", "902", "-o", "json"]]);
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
    fake.respond("jobs get-run", RUN_WITH_TASKS);
    fake.respond("jobs get-run-output 9021", {
      notebook_output: { result: "extract ok" },
    });
    fake.respond("jobs get-run-output 9022", {
      error: "Boom: table missing",
      error_trace: "Traceback: ...",
    });
    const { out, exitCode } = await run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "get-run", "902", "-o", "json"],
      ["jobs", "get-run-output", "9021", "-o", "json"],
      ["jobs", "get-run-output", "9022", "-o", "json"],
    ]);
    expect(out).toContain("Boom: table missing");
    expect(out.indexOf("transform")).toBeLessThan(out.indexOf("extract"));
  });

  it("skips tasks without a run_id instead of fetching 'undefined'", async () => {
    fake.respond("jobs get-run", {
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
    fake.respond("jobs get-run-output 9041", { logs: "done ok" });
    const { out, exitCode } = await run(["jobs", "logs", "904"]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["jobs", "get-run", "904", "-o", "json"],
      ["jobs", "get-run-output", "9041", "-o", "json"],
    ]);
    expect(out).toContain("output unavailable");
  });

  it("fans out even for a single-task run (parent id would fail upstream)", async () => {
    fake.respond("jobs get-run", {
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
    fake.respond("jobs get-run-output 9031", { logs: "fine" });
    await run(["jobs", "logs", "903"]);
    expect(fake.calls()[1]).toEqual([
      "jobs",
      "get-run-output",
      "9031",
      "-o",
      "json",
    ]);
  });

  it("truncates long output to the last 50 lines with a marker", async () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
    );
    fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "SUCCESS" } },
      ],
    });
    fake.respond("jobs get-run-output 9031", { logs: lines.join("\n") });
    const { out } = await run(["jobs", "logs", "903"]);
    expect(out).toContain("showing last 50 of 60 lines");
    expect(out).toContain("line-060");
    expect(out).not.toContain("line-005");
  });

  it("marks a clipped error_trace with a truncation hint", async () => {
    const trace = Array.from({ length: 60 }, (_, i) => `frame-${i}`).join("\n");
    fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "FAILED" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "FAILED" } },
      ],
    });
    fake.respond("jobs get-run-output 9031", {
      error: "Boom",
      error_trace: trace,
    });
    const { out } = await run(["jobs", "logs", "903"]);
    expect(out).toContain("frame-59");
    expect(out).not.toContain("frame-5\n");
    expect(out).toContain("error_trace clipped to last 50 lines");
  });

  it("keeps going when one task's output fetch fails", async () => {
    fake.respond("jobs get-run", RUN_WITH_TASKS);
    fake.respondError("jobs get-run-output 9021", "Error: boom upstream");
    fake.respond("jobs get-run-output 9022", { logs: "transform ok" });
    const { out, exitCode } = await run(["jobs", "logs", "902"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("output fetch failed");
    expect(out).toContain("transform ok");
  });

  it("--full disables truncation", async () => {
    const lines = Array.from(
      { length: 60 },
      (_, i) => `line-${String(i + 1).padStart(3, "0")}`,
    );
    fake.respond("jobs get-run", {
      run_id: 903,
      state: { life_cycle_state: "TERMINATED", result_state: "SUCCESS" },
      tasks: [
        { task_key: "only", run_id: 9031, state: { result_state: "SUCCESS" } },
      ],
    });
    fake.respond("jobs get-run-output 9031", { logs: lines.join("\n") });
    const { out } = await run(["jobs", "logs", "903", "--full"]);
    expect(out).toContain("line-001");
    expect(out).not.toContain("showing last");
  });

  it("reports a run with no tasks definitively", async () => {
    fake.respond("jobs get-run", {
      run_id: 904,
      state: { life_cycle_state: "PENDING" },
      tasks: [],
    });
    const { out, exitCode } = await run(["jobs", "logs", "904"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run has no tasks");
  });
});

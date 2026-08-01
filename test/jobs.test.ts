import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

const JOB = {
  job_id: 101,
  creator_user_name: "a@b.c",
  settings: { name: "axi-bench-etl" },
};

describe("jobs list", () => {
  it("fetches one display page by default and renders default fields", async () => {
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
    expect(out).not.toContain("total: 2");
    expect(out).not.toContain("has_more");
  });

  it("drains the ceiling and reports a precise total only with --total", async () => {
    t.fake.respond("jobs list", {
      jobs: [JOB, { job_id: 102, settings: { name: "other" } }],
    });
    const { out, exitCode } = await t.run(["jobs", "list", "--total"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list", "--limit", "1000", "-o", "json"],
    ]);
    expect(out).toContain("count: 2");
    expect(out).toContain("total: 2");
  });

  it("tolerates a bare-array response", async () => {
    t.fake.respond("jobs list", [JOB]);
    const { out, exitCode } = await t.run(["jobs", "list"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("jobs[1]");
    expect(out).toContain("axi-bench-etl");
  });

  it("slices to the display --limit and flags has_more with the true total", async () => {
    t.fake.respond("jobs list", {
      jobs: [JOB, { job_id: 102, settings: { name: "other" } }],
    });
    const { out } = await t.run(["jobs", "list", "--limit", "1", "--total"]);
    expect(out).toContain("jobs[1]");
    expect(out).toContain("count: 1");
    expect(out).toContain("total: 2");
    expect(out).toContain("has_more: true");
    expect(out).toContain("jobs list --limit 2 --total");
  });

  it("reports a numeric total and a truncated note when the fetch hits the ceiling", async () => {
    t.fake.respond("jobs list", {
      jobs: Array.from({ length: 1000 }, (_, i) => ({
        job_id: i,
        settings: { name: `job-${i}` },
      })),
    });
    const { out } = await t.run(["jobs", "list", "--total"]);
    expect(out).toContain("total: 1000");
    // Numeric, not the string "1000+" — `truncated` carries the imprecision.
    expect(out).not.toContain("1000+");
    expect(out).toContain("has_more: true");
    expect(out).toContain("truncated:");
  });

  it("suggests the exact true total, not a doubled --limit guess", async () => {
    t.fake.respond("jobs list", {
      jobs: Array.from({ length: 5 }, (_, i) => ({
        job_id: i,
        settings: { name: `job-${i}` },
      })),
    });
    const { out } = await t.run(["jobs", "list", "--limit", "3", "--total"]);
    expect(out).toContain("total: 5");
    // Doubling --limit 3 would suggest 6 (still short of the true 5); the
    // exact total (5) is what actually shows everything already fetched.
    expect(out).toContain("jobs list --limit 5 --total");
    expect(out).not.toContain("--limit 6");
  });

  it("caps the suggested rerun --limit instead of naming the whole ceiling fetch", async () => {
    t.fake.respond("jobs list", {
      jobs: Array.from({ length: 1000 }, (_, i) => ({
        job_id: i,
        settings: { name: `job-${i}` },
      })),
    });
    const { out } = await t.run(["jobs", "list", "--limit", "10", "--total"]);
    expect(out).toContain("total: 1000");
    // A bigger page (4x), not the full 1000 rows in one context dump.
    expect(out).toContain("jobs list --limit 40 --total");
    expect(out).not.toContain("jobs list --limit 1000");
  });

  it("omits the rerun suggestion once the ceiling is hit and the display --limit already covers it", async () => {
    t.fake.respond("jobs list", {
      jobs: Array.from({ length: 1000 }, (_, i) => ({
        job_id: i,
        settings: { name: `job-${i}` },
      })),
    });
    const { out } = await t.run(["jobs", "list", "--limit", "1000", "--total"]);
    expect(out).toContain("total: 1000");
    expect(out).toContain("has_more: true");
    expect(out).toContain("truncated:");
    // Already showing everything the pinned ceiling fetch got — a bigger
    // --limit can't get past TOTAL_FETCH_CEILING, so no rerun is suggested.
    expect(out).not.toContain("jobs list --limit");
  });

  it("passes the display --limit upstream unless --total opts into the ceiling", async () => {
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
    // No DAG anywhere in this job, so depends_on is omitted entirely and
    // the tasks array keeps TOON's compact tabular form.
    expect(out).toContain("tasks[1]{task_key,type}:");
    expect(out).toContain("extract");
    expect(out).not.toContain("depends_on");
    expect(out).toContain("jobs run 101");
  });

  it("surfaces the DAG shape via each task's depends_on", async () => {
    t.fake.respond("jobs get", {
      job_id: 881,
      settings: {
        name: "axi-bench-dag",
        tasks: [
          {
            task_key: "ingest",
            notebook_task: { notebook_path: "/Shared/axi-bench/ingest" },
          },
          {
            task_key: "transform",
            notebook_task: { notebook_path: "/Shared/axi-bench/transform" },
            depends_on: [{ task_key: "ingest" }],
          },
          {
            task_key: "report",
            notebook_task: { notebook_path: "/Shared/axi-bench/report" },
            depends_on: [{ task_key: "transform" }],
          },
        ],
      },
    });
    const { out } = await t.run(["jobs", "view", "881"]);
    // A "|"-joined scalar on every task keeps the array uniform, so TOON
    // still renders one row per task instead of a nested block each.
    expect(out).toContain("tasks[3]{task_key,type,depends_on}:");
    // Row assertions stay tolerant of TOON's quoting of the type cell.
    expect(out).toContain('ingest,"notebook: /Shared/axi-bench/ingest",""');
    expect(out).toContain(
      'transform,"notebook: /Shared/axi-bench/transform",ingest',
    );
    expect(out).toContain(
      'report,"notebook: /Shared/axi-bench/report",transform',
    );
  });

  it("drops depends_on entries with no task_key instead of an undefined slot", async () => {
    t.fake.respond("jobs get", {
      job_id: 882,
      settings: {
        name: "axi-bench-malformed-dag",
        tasks: [
          {
            task_key: "report",
            notebook_task: { notebook_path: "/Shared/axi-bench/report" },
            depends_on: [{ task_key: "transform" }, {}],
          },
        ],
      },
    });
    const { out } = await t.run(["jobs", "view", "882"]);
    expect(out).toContain("tasks[1]{task_key,type,depends_on}:");
    expect(out).toContain(',"notebook: /Shared/axi-bench/report",transform');
    expect(out).not.toContain("undefined");
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
    expect(out).not.toContain("total: 2");
  });

  it("drains the ceiling and reports a precise total only with --total", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run(["jobs", "runs", "--total"]);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "1000", "-o", "json"],
    ]);
    expect(out).toContain("total: 2");
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

  it("slices to the display --limit and flags has_more with the true total, keeping the job_id filter", async () => {
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run([
      "jobs",
      "runs",
      "101",
      "--limit",
      "1",
      "--total",
    ]);
    expect(out).toContain("count: 1");
    expect(out).toContain("total: 2");
    expect(out).toContain("has_more: true");
    expect(out).toContain("jobs runs 101 --limit 2 --total");
  });

  it("does not suggest logs for a failed run beyond the displayed --limit page", async () => {
    // RUNS is [901 SUCCESS, 902 FAILED] — --limit 1 only displays 901, so
    // the 902 failure was never shown to the agent and must not be
    // suggested as a follow-up (the search must not run over the full
    // ceiling-bounded fetch, only the displayed page).
    t.fake.respond("jobs list-runs", RUNS);
    const { out } = await t.run([
      "jobs",
      "runs",
      "101",
      "--limit",
      "1",
      "--total",
    ]);
    expect(out).not.toContain("jobs logs");
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

describe("jobs runs summary", () => {
  const runRow = (id: number, resultState?: string) => ({
    run_id: id,
    job_id: 101,
    ...(resultState ? { state: { result_state: resultState } } : {}),
  });

  it("computes tallies over the default 50-run window", async () => {
    t.fake.respond("jobs list-runs", {
      runs: [
        runRow(1, "SUCCESS"),
        runRow(2, "FAILED"),
        runRow(3), // no result_state yet — still running
      ],
    });
    t.fake.respond("jobs get-run", { run_id: 2, tasks: [] });
    const { out, exitCode } = await t.run(["jobs", "runs", "summary"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()[0]).toEqual([
      "jobs",
      "list-runs",
      "--limit",
      "50",
      "-o",
      "json",
    ]);
    expect(out).not.toContain("job_id:");
    expect(out).toContain("window: 3");
    expect(out).not.toContain("total_available");
    expect(out).toContain("success: 1");
    expect(out).toContain("failed: 1");
    expect(out).toContain("other: 0");
    expect(out).toContain("running: 1");
  });

  it("keeps cancelled, timed-out, and skipped runs out of the failed tally", async () => {
    t.fake.respond("jobs list-runs", {
      runs: [
        runRow(1, "SUCCESS"),
        runRow(2, "CANCELED"),
        runRow(3, "TIMEDOUT"),
        runRow(4, "UPSTREAM_CANCELED"),
        runRow(5, "EXCLUDED"),
        runRow(6, "MAXIMUM_CONCURRENT_RUNS_REACHED"),
        runRow(7, "DISABLED"),
      ],
    });
    const { out } = await t.run(["jobs", "runs", "summary"]);
    // No genuine failure in the window, so no get-run fan-out either.
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "50", "-o", "json"],
    ]);
    expect(out).toContain("success: 1");
    expect(out).toContain("failed: 0");
    expect(out).toContain("other: 6");
    expect(out).toContain("running: 0");
    expect(out).not.toContain("first_failed");
  });

  it("filters to one job, passing --job-id and reporting job_id", async () => {
    t.fake.respond("jobs list-runs", { runs: [runRow(1, "SUCCESS")] });
    const { out } = await t.run(["jobs", "runs", "summary", "101"]);
    expect(t.fake.calls()[0]).toEqual([
      "jobs",
      "list-runs",
      "--limit",
      "50",
      "--job-id",
      "101",
      "-o",
      "json",
    ]);
    expect(out).toContain('job_id: "101"');
  });

  it("caps a requested window at the internal 200 ceiling and notes the truncation", async () => {
    t.fake.respond("jobs list-runs", {
      runs: Array.from({ length: 200 }, (_, i) => runRow(i, "SUCCESS")),
    });
    const { out } = await t.run(["jobs", "runs", "summary", "--limit", "300"]);
    expect(t.fake.calls()[0]).toEqual([
      "jobs",
      "list-runs",
      "--limit",
      "200",
      "-o",
      "json",
    ]);
    expect(out).toContain("window: 200");
    expect(out).not.toContain("total_available");
    expect(out).toContain("truncated:");
    expect(out).toContain("200-run window ceiling");
  });

  it("notes truncation on a full window below the ceiling, so failed: 0 never reads as authoritative", async () => {
    t.fake.respond("jobs list-runs", {
      runs: Array.from({ length: 50 }, (_, i) => runRow(i, "SUCCESS")),
    });
    const { out } = await t.run(["jobs", "runs", "summary"]);
    expect(out).toContain("window: 50");
    expect(out).toContain("failed: 0");
    expect(out).toContain("newest 50 runs");
    expect(out).toContain("--limit");
  });

  it("resolves first_failed via one get-run + one get-run-output call, never a walk over every failing run", async () => {
    t.fake.respond("jobs list-runs", {
      runs: [runRow(2, "FAILED"), runRow(1, "FAILED")],
    });
    t.fake.respond("jobs get-run", {
      run_id: 2,
      tasks: [
        {
          task_key: "trivial",
          run_id: 202,
          state: { result_state: "FAILED" },
        },
      ],
    });
    t.fake.respond("jobs get-run-output", {
      error: "RuntimeError: deliberate trivial-job failure (mode=fail)",
    });
    const { out, exitCode } = await t.run(["jobs", "runs", "summary"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "50", "-o", "json"],
      ["jobs", "get-run", "2", "-o", "json"],
      ["jobs", "get-run-output", "202", "-o", "json"],
    ]);
    expect(out).toContain("run_id: 2");
    expect(out).toContain("task_key: trivial");
    expect(out).toContain(
      'error: "RuntimeError: deliberate trivial-job failure (mode=fail)"',
    );
    expect(out).not.toContain("common_error");
    expect(out).toContain("jobs logs 2");
  });

  it("redacts the first_failed error text", async () => {
    t.fake.respond("jobs list-runs", { runs: [runRow(1, "FAILED")] });
    t.fake.respond("jobs get-run", {
      run_id: 1,
      tasks: [{ task_key: "t", run_id: 11, state: { result_state: "FAILED" } }],
    });
    t.fake.respond("jobs get-run-output", {
      error: "dapifedcba9876543210 leaked",
    });
    const { out } = await t.run(["jobs", "runs", "summary"]);
    expect(out).not.toContain("dapifedcba9876543210");
    expect(out).toContain("[redacted]");
  });

  it("omits first_failed when there are no failures", async () => {
    t.fake.respond("jobs list-runs", { runs: [runRow(1, "SUCCESS")] });
    const { out, exitCode } = await t.run(["jobs", "runs", "summary"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "50", "-o", "json"],
    ]);
    expect(out).not.toContain("first_failed");
    expect(out).not.toContain("common_error");
  });

  it("stays best-effort when the failing task's get-run-output call fails", async () => {
    t.fake.respond("jobs list-runs", { runs: [runRow(1, "FAILED")] });
    t.fake.respond("jobs get-run", {
      run_id: 1,
      tasks: [{ task_key: "t", run_id: 11, state: { result_state: "FAILED" } }],
    });
    t.fake.respondError("jobs get-run-output", "Error: transient failure");
    const { out, exitCode } = await t.run(["jobs", "runs", "summary"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("run_id: 1");
    expect(out).toContain("task_key: t");
    // Unresolved error line is omitted, not emitted as an empty slot.
    expect(out).not.toContain("error:");
  });

  it("omits task_key and error when the failing run resolves no task", async () => {
    t.fake.respond("jobs list-runs", { runs: [runRow(1, "FAILED")] });
    t.fake.respond("jobs get-run", { run_id: 1, tasks: [] });
    const { out } = await t.run(["jobs", "runs", "summary"]);
    expect(out).toContain("first_failed");
    expect(out).toContain("run_id: 1");
    expect(out).not.toContain("task_key");
    expect(out).not.toContain("error:");
    expect(out).toContain("jobs logs 1");
  });

  it("stays best-effort when the get-run call itself fails, keeping tallies without first_failed", async () => {
    t.fake.respond("jobs list-runs", {
      runs: [runRow(1, "FAILED"), runRow(2, "SUCCESS")],
    });
    t.fake.respondError("jobs get-run", "Error: transient failure");
    const { out, exitCode } = await t.run(["jobs", "runs", "summary"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["jobs", "list-runs", "--limit", "50", "-o", "json"],
      ["jobs", "get-run", "1", "-o", "json"],
    ]);
    expect(out).toContain("window: 2");
    expect(out).toContain("success: 1");
    expect(out).toContain("failed: 1");
    expect(out).not.toContain("first_failed");
    // Still points at the generic runs follow-up even though the
    // logs-specific suggestion couldn't be resolved.
    expect(out).toContain("jobs runs");
    expect(out).not.toContain("jobs logs");
  });

  it("renders a zeroed envelope when no runs are found", async () => {
    t.fake.respond("jobs list-runs", { runs: [] });
    const { out, exitCode } = await t.run(["jobs", "runs", "summary", "101"]);
    expect(exitCode).toBe(0);
    expect(out).toContain('job_id: "101"');
    expect(out).toContain("window: 0");
    expect(out).not.toContain("total_available");
    expect(out).toContain("success: 0");
    expect(out).toContain("failed: 0");
    expect(out).toContain("other: 0");
    expect(out).toContain("running: 0");
    expect(out).toContain("no runs found");
  });

  it("requires a numeric job id", async () => {
    const { out, exitCode } = await t.run([
      "jobs",
      "runs",
      "summary",
      "banana",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("jobs runs summary [job_id]");
  });

  it("rejects --fields (no rows to select fields among)", async () => {
    const { out, exitCode } = await t.run([
      "jobs",
      "runs",
      "summary",
      "--fields",
      "run_id",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("Unknown option");
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

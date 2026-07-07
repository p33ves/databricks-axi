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

  it("surfaces pagination as has_more plus a suggestion", async () => {
    fake.respond("jobs list", { jobs: [JOB], next_page_token: "tok123" });
    const { out } = await run(["jobs", "list"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("jobs list --page-token tok123");
  });

  it("passes --page-token and --limit through", async () => {
    fake.respond("jobs list", { jobs: [] });
    await run(["jobs", "list", "--limit", "5", "--page-token", "tok123"]);
    expect(fake.calls()).toEqual([
      ["jobs", "list", "--limit", "5", "--page-token", "tok123", "-o", "json"],
    ]);
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
});

describe("jobs dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await run(["jobs", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
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

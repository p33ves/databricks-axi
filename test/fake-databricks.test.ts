import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { installFakeDatabricks } from "./helpers/fake-databricks.js";

const run = promisify(execFile);

describe("fake databricks binary", () => {
  it("replays canned JSON and records argv", async () => {
    const fake = installFakeDatabricks();
    fake.respond("jobs list", { jobs: [{ job_id: 7 }] });

    const { stdout } = await run("databricks", ["jobs", "list", "-o", "json"], {
      env: { ...process.env, PATH: `${fake.binDir}:${process.env["PATH"]}` },
    });

    expect(JSON.parse(stdout)).toEqual({ jobs: [{ job_id: 7 }] });
    expect(fake.calls()).toEqual([["jobs", "list", "-o", "json"]]);
  });

  it("fails loudly on an unmatched invocation", async () => {
    const fake = installFakeDatabricks();
    await expect(
      run("databricks", ["clusters", "list"], {
        env: { ...process.env, PATH: `${fake.binDir}:${process.env["PATH"]}` },
      }),
    ).rejects.toMatchObject({ code: 1 });
  });
});

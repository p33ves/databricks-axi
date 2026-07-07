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

  it("matches prefixes at token boundaries, not string prefixes", async () => {
    const fake = installFakeDatabricks();
    fake.respond("jobs get", { job_id: 7 });
    const env = {
      ...process.env,
      PATH: `${fake.binDir}:${process.env["PATH"]}`,
    };

    // "jobs get-run" must NOT hit the "jobs get" response.
    await expect(
      run("databricks", ["jobs", "get-run", "42"], { env }),
    ).rejects.toMatchObject({ code: 1 });

    const { stdout } = await run("databricks", ["jobs", "get", "42"], { env });
    expect(JSON.parse(stdout)).toEqual({ job_id: 7 });
  });

  it("replays canned stderr and exit code for upstream errors", async () => {
    const fake = installFakeDatabricks();
    fake.respondError(
      "clusters delete",
      "Error: INVALID_STATE: Cluster is terminated\n",
    );

    await expect(
      run("databricks", ["clusters", "delete", "abc"], {
        env: { ...process.env, PATH: `${fake.binDir}:${process.env["PATH"]}` },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: "Error: INVALID_STATE: Cluster is terminated\n",
    });
  });
});

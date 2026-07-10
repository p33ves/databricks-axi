import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDatabricks, runDatabricksApi } from "../src/databricks.js";
import {
  installFakeDatabricks,
  type FakeDatabricks,
} from "./helpers/fake-databricks.js";

let prevPath: string | undefined;

beforeEach(() => {
  prevPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = prevPath;
});

function useFake(): FakeDatabricks {
  const fake = installFakeDatabricks();
  process.env.PATH = `${fake.binDir}:${prevPath ?? ""}`;
  return fake;
}

describe("runDatabricks", () => {
  it("appends -o json and parses stdout", async () => {
    const fake = useFake();
    fake.respond("jobs list", { jobs: [] });
    const result = await runDatabricks(["jobs", "list"]);
    expect(result).toEqual({ jobs: [] });
    expect(fake.calls()).toEqual([["jobs", "list", "-o", "json"]]);
  });

  it("keeps 16+-digit int64 ids exact as strings", async () => {
    const fake = useFake();
    fake.respondRaw(
      "jobs get-run",
      '{"run_id":9223372036854775807,"job_id":123}',
    );
    const result = await runDatabricks(["jobs", "get-run"]);
    expect(result).toEqual({ run_id: "9223372036854775807", job_id: 123 });
  });

  it("prepends -p <profile>", async () => {
    const fake = useFake();
    fake.respond("-p dev jobs list", { jobs: [] });
    await runDatabricks(["jobs", "list"], { profile: "dev" });
    expect(fake.calls()).toEqual([["-p", "dev", "jobs", "list", "-o", "json"]]);
  });

  it("returns null on empty stdout", async () => {
    const fake = useFake();
    fake.respondError("jobs cancel-run", "", 0);
    expect(await runDatabricks(["jobs", "cancel-run"])).toBeNull();
  });

  it("maps nonzero exits through the taxonomy", async () => {
    const fake = useFake();
    fake.respondError("jobs get", "Error: Job 999 does not exist.");
    await expect(runDatabricks(["jobs", "get", "999"])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("deletes the --json body temp file after the call", async () => {
    const fake = useFake();
    fake.respond("api post", { ok: true });
    await runDatabricksApi("post", "/api/2.0/x", '{"a":1}');
    const argv = fake.calls()[0];
    const ref = argv[argv.indexOf("--json") + 1];
    expect(ref).toMatch(/^@/);
    expect(existsSync(ref.slice(1))).toBe(false);
    expect(fake.bodies()).toEqual(['{"a":1}']);
  });

  it("throws CLI_MISSING when databricks is not on PATH", async () => {
    process.env.PATH = mkdtempSync(join(tmpdir(), "empty-path-"));
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "CLI_MISSING",
    });
  });

  it("surfaces spawn errno messages like EACCES instead of a generic failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noexec-databricks-"));
    const bin = join(dir, "databricks");
    writeFileSync(bin, "not executable");
    chmodSync(bin, 0o644);
    process.env.PATH = dir;
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringContaining("EACCES") as string,
    });
  });

  it("kills a hung CLI and throws TIMEOUT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slow-databricks-"));
    const bin = join(dir, "databricks");
    writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n");
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    await expect(
      runDatabricks(["jobs", "list"], { timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("uses caller-supplied timeoutHelp for mutation-safe advice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slow-databricks-"));
    const bin = join(dir, "databricks");
    writeFileSync(bin, "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n");
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    await expect(
      runDatabricks(["jobs", "run-now", "101"], {
        timeoutMs: 300,
        timeoutHelp: ["databricks-axi jobs runs 101"],
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
      suggestions: ["databricks-axi jobs runs 101"],
    });
  });

  it("diagnoses CLI_TOO_OLD on unknown-command failures", async () => {
    const fake = useFake();
    fake.respondError(
      "jobs list",
      'Error: unknown command "jobs" for "databricks"',
    );
    fake.respond("-v", "Databricks CLI v0.18.0");
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "CLI_TOO_OLD",
    });
  });

  it("keeps the mapped error when the CLI is new enough", async () => {
    const fake = useFake();
    fake.respondError("jobs list", 'Error: unknown flag "--bogus"');
    fake.respond("-v", "Databricks CLI v1.6.0");
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("diagnoses CLI_TOO_OLD on legacy no-such-option failures", async () => {
    const fake = useFake();
    fake.respondError("jobs list", "Error: no such option: -o");
    fake.respond("-v", "Version 0.18.0");
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "CLI_TOO_OLD",
    });
  });

  it("decodes multibyte UTF-8 split across pipe-chunk boundaries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "utf8-databricks-"));
    const bin = join(dir, "databricks");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ logs: "\\u00e9".repeat(120000) }));
`,
    );
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    const result = (await runDatabricks(["jobs", "get-run-output"])) as {
      logs: string;
    };
    expect(result.logs).not.toContain("�");
    expect(result.logs).toHaveLength(120000);
  });

  it("wraps malformed JSON stdout in an AxiError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bad-json-databricks-"));
    const bin = join(dir, "databricks");
    writeFileSync(
      bin,
      "#!/usr/bin/env node\nprocess.stdout.write('not json');\n",
    );
    chmodSync(bin, 0o755);
    process.env.PATH = `${dir}:${prevPath ?? ""}`;
    await expect(runDatabricks(["jobs", "list"])).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});

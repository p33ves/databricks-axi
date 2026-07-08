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

describe("api", () => {
  it("passes a GET through and renders the response as TOON", async () => {
    fake.respond("api get", { warehouses: [{ id: "abc", state: "RUNNING" }] });
    const { out, exitCode } = await run([
      "api",
      "get",
      "/api/2.0/sql/warehouses",
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["api", "get", "/api/2.0/sql/warehouses", "-o", "json"],
    ]);
    expect(out).toContain("warehouses[1]{id,state}:");
    expect(out).toContain("abc,RUNNING");
  });

  it("places --body on argv as upstream --json", async () => {
    fake.respond("api post", { statement_id: "s1" });
    const body = '{"statement":"SELECT 1"}';
    const { exitCode } = await run([
      "api",
      "post",
      "/api/2.0/sql/statements",
      "--body",
      body,
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["api", "post", "/api/2.0/sql/statements", "--json", body, "-o", "json"],
    ]);
  });

  it("passes --profile through as -p", async () => {
    fake.respond("-p work api get", { ok: true });
    const { exitCode } = await run([
      "api",
      "get",
      "/api/2.0/x",
      "--profile",
      "work",
    ]);
    expect(exitCode).toBe(0);
    expect(fake.calls()).toEqual([
      ["-p", "work", "api", "get", "/api/2.0/x", "-o", "json"],
    ]);
  });

  it("rejects an unknown method without spawning", async () => {
    const { out, exitCode } = await run(["api", "frob", "/api/2.0/x"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frob");
    expect(fake.calls()).toEqual([]);
  });

  it("rejects a path that does not start with /api/ without spawning", async () => {
    const { out, exitCode } = await run(["api", "get", "/2.0/clusters/list"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("/api/");
    expect(fake.calls()).toEqual([]);
  });

  it("rejects an invalid JSON --body without spawning", async () => {
    const { out, exitCode } = await run([
      "api",
      "post",
      "/api/2.0/x",
      "--body",
      "{not json",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("JSON");
    expect(fake.calls()).toEqual([]);
  });

  it("requires method and path", async () => {
    const { exitCode } = await run(["api", "get"]);
    expect(exitCode).toBe(2);
    expect(fake.calls()).toEqual([]);
  });

  it("wraps a non-object response so TOON can render it", async () => {
    fake.respond("api get", [{ id: 1 }, { id: 2 }]);
    const { out, exitCode } = await run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("response");
  });

  it("truncates responses over 1MB with a byte count", async () => {
    fake.respond("api get", { blob: "x".repeat(1_100_000) });
    const { out, exitCode } = await run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/truncated:.*\d+ bytes/);
    expect(out.length).toBeLessThan(100_000);
  });

  it("counts UTF-8 bytes, not UTF-16 length, against the render cap", async () => {
    // 600k 2-byte chars: .length is ~600k (under cap) but UTF-8 bytes are ~1.2MB (over cap).
    fake.respond("api get", { blob: "é".repeat(600_000) });
    const { out, exitCode } = await run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/truncated:.*\d+ bytes/);
    expect(out).not.toContain("blob");
  });
});

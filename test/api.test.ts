import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

describe("api", () => {
  it("passes a GET through and renders the response as TOON", async () => {
    t.fake.respond("api get", {
      warehouses: [{ id: "abc", state: "RUNNING" }],
    });
    const { out, exitCode } = await t.run([
      "api",
      "get",
      "/api/2.0/sql/warehouses",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["api", "get", "/api/2.0/sql/warehouses", "-o", "json"],
    ]);
    expect(out).toContain("warehouses[1]{id,state}:");
    expect(out).toContain("abc,RUNNING");
  });

  it("sends inline --body via a temp file, never argv", async () => {
    t.fake.respond("api post", { statement_id: "s1" });
    const body = '{"statement":"SELECT 1"}';
    const { exitCode } = await t.run([
      "api",
      "post",
      "/api/2.0/sql/statements",
      "--body",
      body,
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "api",
        "post",
        "/api/2.0/sql/statements",
        "--json",
        expect.stringMatching(/^@.+body\.json$/) as unknown as string,
        "-o",
        "json",
      ],
    ]);
    expect(t.fake.bodies()).toEqual([body]);
  });

  it("passes --profile through as -p", async () => {
    t.fake.respond("-p work api get", { ok: true });
    const { exitCode } = await t.run([
      "api",
      "get",
      "/api/2.0/x",
      "--profile",
      "work",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["-p", "work", "api", "get", "/api/2.0/x", "-o", "json"],
    ]);
  });

  it("rejects an unknown method without spawning", async () => {
    const { out, exitCode } = await t.run(["api", "frob", "/api/2.0/x"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frob");
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a path that does not start with /api/ without spawning", async () => {
    const { out, exitCode } = await t.run(["api", "get", "/2.0/clusters/list"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("/api/");
    expect(t.fake.calls()).toEqual([]);
  });

  it("passes an @file --body through without JSON validation", async () => {
    t.fake.respond("api post", { statement_id: "s1" });
    const { exitCode } = await t.run([
      "api",
      "post",
      "/api/2.0/sql/statements",
      "--body",
      "@payload.json",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "api",
        "post",
        "/api/2.0/sql/statements",
        "--json",
        "@payload.json",
        "-o",
        "json",
      ],
    ]);
  });

  it("rejects an invalid JSON --body without spawning", async () => {
    const { out, exitCode } = await t.run([
      "api",
      "post",
      "/api/2.0/x",
      "--body",
      "{not json",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("JSON");
    expect(t.fake.calls()).toEqual([]);
  });

  it("requires method and path", async () => {
    const { exitCode } = await t.run(["api", "get"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("wraps a non-object response so TOON can render it", async () => {
    t.fake.respond("api get", [{ id: 1 }, { id: 2 }]);
    const { out, exitCode } = await t.run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("response");
  });

  it("truncates responses over 1MB with a byte count", async () => {
    t.fake.respond("api get", { blob: "x".repeat(1_100_000) });
    const { out, exitCode } = await t.run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/truncated:.*\d+ bytes/);
    expect(out.length).toBeLessThan(100_000);
  });

  it("counts UTF-8 bytes, not UTF-16 length, against the render cap", async () => {
    // 600k 2-byte chars: .length is ~600k (under cap) but UTF-8 bytes are ~1.2MB (over cap).
    t.fake.respond("api get", { blob: "é".repeat(600_000) });
    const { out, exitCode } = await t.run(["api", "get", "/api/2.0/x"]);
    expect(exitCode).toBe(0);
    expect(out).toMatch(/truncated:.*\d+ bytes/);
    expect(out).not.toContain("blob");
  });
});

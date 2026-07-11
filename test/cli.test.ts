import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { installFakeDatabricks } from "./helpers/fake-databricks.js";

function capture() {
  let out = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    read: () => out,
  };
}

describe("main", () => {
  // home (bare invocation and `home`) now spawns the databricks CLI for its
  // dashboard panels — put a fake on PATH so this file never touches a real
  // workspace, even for tests that don't otherwise care about spawning.
  let prevPath: string | undefined;
  beforeEach(() => {
    process.exitCode = undefined;
    const fake = installFakeDatabricks();
    prevPath = process.env.PATH;
    process.env.PATH = `${fake.binDir}:${prevPath ?? ""}`;
  });
  afterEach(() => {
    process.exitCode = undefined;
    process.env.PATH = prevPath;
  });

  it("prints the version", async () => {
    const c = capture();
    await main({ argv: ["--version"], stdout: c.stdout });
    expect(c.read().trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints top-level help", async () => {
    const c = capture();
    await main({ argv: ["--help"], stdout: c.stdout });
    expect(c.read()).toContain("usage: databricks-axi");
  });

  it("shows the home view with no args", async () => {
    const c = capture();
    await main({ argv: [], stdout: c.stdout });
    expect(c.read()).toMatch(/help\[\d+\]:/);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports unknown commands as structured usage errors on stdout", async () => {
    const c = capture();
    await main({ argv: ["frobnicate"], stdout: c.stdout });
    expect(process.exitCode).toBe(2);
    expect(c.read()).toContain("error:");
    expect(c.read()).toContain("frobnicate");
  });

  it("reports unknown flags as usage errors", async () => {
    const c = capture();
    await main({ argv: ["--frobnicate"], stdout: c.stdout });
    expect(process.exitCode).toBe(2);
  });

  it("resolves home by name with per-command help", async () => {
    const c = capture();
    await main({ argv: ["home"], stdout: c.stdout });
    expect(process.exitCode ?? 0).toBe(0);
    expect(c.read()).toContain("commands:");

    const h = capture();
    await main({ argv: ["home", "--help"], stdout: h.stdout });
    expect(h.read()).toContain("usage: databricks-axi [home]");
  });
});

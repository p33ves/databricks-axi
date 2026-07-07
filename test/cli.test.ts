import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

function capture() {
  let out = "";
  return {
    stdout: { write: (c: string) => ((out += c), true) },
    read: () => out,
  };
}

describe("main", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
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
    expect(c.read()).toContain("help:");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("reports unknown commands as usage errors", async () => {
    const c = capture();
    await main({ argv: ["frobnicate"], stdout: c.stdout });
    expect(process.exitCode).toBe(2);
  });
});

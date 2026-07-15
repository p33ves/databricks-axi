// Drift gate for the Claude Code plugin-marketplace manifest (spec §13):
// these are hand-written, not generated, so nothing else catches them
// silently going stale against a version bump or a missing skill file.
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(path, root), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("plugin-marketplace manifest", () => {
  it("plugin.json version matches package.json version", () => {
    const pkg = readJson("package.json");
    const plugin = readJson(".claude-plugin/plugin.json");
    expect(plugin.version).toBe(pkg.version);
  });

  it("marketplace.json's plugin entry version matches package.json version", () => {
    const pkg = readJson("package.json");
    const marketplace = readJson(".claude-plugin/marketplace.json") as {
      plugins: { version: string }[];
    };
    expect(marketplace.plugins[0]?.version).toBe(pkg.version);
  });

  it("the SKILL.md the manifest relies on exists", () => {
    expect(existsSync(new URL("skills/databricks-axi/SKILL.md", root))).toBe(
      true,
    );
  });
});

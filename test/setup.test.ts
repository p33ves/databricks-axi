import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

// installSessionStartHooks infers install eligibility from process.argv[1]
// matching a packaged `dist/bin/<marker>.js` path — under vitest that path
// never matches, so the SDK call would silently no-op (F2). Point argv[1] at
// a fake production-shaped entrypoint so the real write path under test.
const FAKE_EXEC_PATH = "/fake/project/dist/bin/databricks-axi.js";

async function run(argv: string[]): Promise<{ out: string; exitCode: number }> {
  let out = "";
  await main({ argv, stdout: { write: (c: string) => ((out += c), true) } });
  return {
    out,
    exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode),
  };
}

describe("setup hooks", () => {
  let prevArgv1: string | undefined;
  let prevHome: string | undefined;
  let home: string;

  beforeEach(() => {
    prevArgv1 = process.argv[1];
    prevHome = process.env.HOME;
    process.argv[1] = FAKE_EXEC_PATH;
    home = mkdtempSync(join(tmpdir(), "axi-home-"));
    process.env.HOME = home;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.argv[1] = prevArgv1;
    process.env.HOME = prevHome;
    process.exitCode = undefined;
  });

  it("writes all four hook targets and reports their paths", async () => {
    const { out, exitCode } = await run(["setup", "hooks"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("hooks installed or already up to date");
    const paths = [
      join(home, ".claude", "settings.json"),
      join(home, ".codex", "hooks.json"),
      join(home, ".codex", "config.toml"),
      join(home, ".config", "opencode", "plugins", "axi-databricks-axi.js"),
    ];
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
      expect(out).toContain(p);
    }
    const settings = JSON.parse(readFileSync(paths[0], "utf-8")) as {
      hooks?: { SessionStart?: unknown[] };
    };
    expect(settings.hooks?.SessionStart?.length).toBe(1);
  });

  it("is idempotent: a re-run is byte-stable", async () => {
    await run(["setup", "hooks"]);
    const settingsPath = join(home, ".claude", "settings.json");
    const before = readFileSync(settingsPath, "utf-8");
    const { exitCode } = await run(["setup", "hooks"]);
    expect(exitCode).toBe(0);
    expect(readFileSync(settingsPath, "utf-8")).toBe(before);
  });

  it("aggregates onError into one exit-1 structured error on an unmanaged OpenCode plugin, without rolling back other targets", async () => {
    const pluginDir = join(home, ".config", "opencode", "plugins");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, "axi-databricks-axi.js"),
      "// hand-written, not managed by axi-sdk-js\n",
    );
    const { out, exitCode } = await run(["setup", "hooks"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
    expect(out).toContain("refusing to overwrite unmanaged OpenCode plugin");
    expect(out).toContain("not rolled back");
    // The other three targets still landed even though OpenCode's write failed.
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(true);
  });

  it("reports non-installation instead of false success on an unrecognized entrypoint", async () => {
    process.argv[1] = "/fake/project/some-other-tool.js";
    const { out, exitCode } = await run(["setup", "hooks"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("not installed");
    expect(out).not.toContain("hooks installed or already up to date");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("rejects a --agent flag (dropped — installs all three agents unconditionally)", async () => {
    const { out, exitCode } = await run([
      "setup",
      "hooks",
      "--agent",
      "claude",
    ]);
    expect(exitCode).toBe(2);
    expect(out).toContain("code: VALIDATION_ERROR");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  it("rejects an unknown subcommand", async () => {
    const { out, exitCode } = await run(["setup", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare setup invocation", async () => {
    const { exitCode } = await run(["setup"]);
    expect(exitCode).toBe(2);
  });

  it("serves setup --help with a single hooks example and no --agent selector", async () => {
    const { out, exitCode } = await run(["setup", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi setup");
    expect(out).toContain("databricks-axi setup hooks");
    // Documents the drop in prose, but never advertises --agent as a
    // usable flag on its own help line (e.g. "  --agent <name>  ...").
    expect(out).not.toMatch(/^\s*--agent\b/m);
  });
});

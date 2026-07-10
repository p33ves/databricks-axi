import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("workspace ls", () => {
  it("defaults to the workspace root and renders default fields", async () => {
    t.fake.respond("workspace list", {
      objects: [
        { path: "/Shared/etl", object_type: "NOTEBOOK", language: "PYTHON" },
        { path: "/Shared/archive", object_type: "DIRECTORY" },
      ],
    });
    const { out, exitCode } = await t.run(["workspace", "ls"]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["workspace", "list", "/", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("objects[2]{path,object_type,language}:");
    expect(out).toContain("/Shared/etl,NOTEBOOK,PYTHON");
    expect(out).toContain("count: 2");
    expect(out).toContain("workspace view /Shared/etl");
    expect(out).toContain("workspace ls /Shared/archive");
  });

  it("passes an explicit path positional", async () => {
    t.fake.respond("workspace list", { objects: [] });
    await t.run(["workspace", "ls", "/Shared"]);
    expect(t.fake.calls()).toEqual([
      ["workspace", "list", "/Shared", "--limit", "30", "-o", "json"],
    ]);
  });

  it("tolerates a bare-array response", async () => {
    t.fake.respond("workspace list", [
      { path: "/Shared/etl", object_type: "NOTEBOOK", language: "PYTHON" },
    ]);
    const { out } = await t.run(["workspace", "ls"]);
    expect(out).toContain("objects[1]");
  });

  it("flags a full page as has_more with a bigger-limit suggestion", async () => {
    t.fake.respond("workspace list", {
      objects: [{ path: "/a", object_type: "NOTEBOOK" }],
    });
    const { out } = await t.run(["workspace", "ls", "--limit", "1"]);
    expect(out).toContain("has_more: true");
    expect(out).toContain("workspace ls / --limit 2");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("workspace list", { objects: [] });
    const { out, exitCode } = await t.run(["workspace", "ls", "/Shared/empty"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("directory is empty");
  });

  it("maps the upstream contraction 'doesn't exist' to NOT_FOUND", async () => {
    t.fake.respondError(
      "workspace list",
      "Error: Path (/Shared/nope) doesn't exist.",
    );
    const { out, exitCode } = await t.run(["workspace", "ls", "/Shared/nope"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("workspace ls");
  });

  it("rejects a leading-dash path smuggled as a positional", async () => {
    const { exitCode } = await t.run(["workspace", "ls", "-x"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects more than one positional", async () => {
    const { exitCode } = await t.run(["workspace", "ls", "/a", "/b"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("workspace list", {
      objects: [{ path: "/a", object_type: "NOTEBOOK", created_at: 5 }],
    });
    const { out } = await t.run([
      "workspace",
      "ls",
      "--fields",
      "path,created_at",
    ]);
    expect(out).toContain("objects[1]{path,created_at}:");
    expect(out).toContain("/a,5");
  });

  it("threads --profile into argv and suggestions", async () => {
    t.fake.respond("-p dev workspace list", {
      objects: [{ path: "/a", object_type: "NOTEBOOK" }],
    });
    const { out } = await t.run(["workspace", "ls", "--profile", "dev"]);
    expect(t.fake.calls()).toEqual([
      ["-p", "dev", "workspace", "list", "/", "--limit", "30", "-o", "json"],
    ]);
    expect(out).toContain("workspace view /a --profile dev");
  });
});

describe("workspace view", () => {
  it("passes exact argv and renders a decoded text header", async () => {
    t.fake.respond("workspace export", {
      content: b64("print(1)\nprint(2)\n"),
      file_type: "py",
    });
    const { out, exitCode } = await t.run([
      "workspace",
      "view",
      "/Shared/axi-bench-etl-daily",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "workspace",
        "export",
        "/Shared/axi-bench-etl-daily",
        "--format",
        "SOURCE",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("path: /Shared/axi-bench-etl-daily");
    expect(out).toContain("language: PYTHON");
    expect(out).toContain("print(1)");
    expect(out).toContain("workspace ls /Shared");
  });

  it("head-truncates at 200 lines with a rerun marker", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    t.fake.respond("workspace export", {
      content: b64(lines.join("\n")),
      file_type: "py",
    });
    const { out } = await t.run(["workspace", "view", "/Shared/big"]);
    expect(out).toContain("showing first 200 of 250 lines");
    expect(out).toContain("line-1");
    expect(out).not.toContain("line-201");
  });

  it("--full disables truncation", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    t.fake.respond("workspace export", {
      content: b64(lines.join("\n")),
      file_type: "py",
    });
    const { out } = await t.run(["workspace", "view", "/Shared/big", "--full"]);
    expect(out).toContain("line-250");
    expect(out).not.toContain("showing first");
  });

  it("renders a directory export as a note instead of the archive bytes", async () => {
    // Real ZIP: signature bytes plus enough binary noise to trip the
    // invalid-UTF-8 check too (belt and suspenders vs. the PK check alone).
    const zipish = Buffer.concat([
      Buffer.from("PK\x03\x04"),
      Buffer.from([0xff, 0xd8, 0x00, 0x01, 0x02]),
    ]);
    t.fake.respond("workspace export", {
      content: zipish.toString("base64"),
      file_type: "zip",
    });
    const { out, exitCode } = await t.run(["workspace", "view", "/Shared/dir"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("directory archive");
    expect(out).toContain("workspace ls /Shared/dir");
  });

  it("renders non-UTF-8 content as a binary note, not garbage text", async () => {
    const binary = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
    t.fake.respond("workspace export", {
      content: binary.toString("base64"),
      file_type: "bin",
    });
    const { out, exitCode } = await t.run(["workspace", "view", "/Shared/img"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("binary,");
    expect(out).toContain("not rendered");
  });

  it("maps NOT_FOUND to a parent-directory ls suggestion", async () => {
    t.fake.respondError(
      "workspace export",
      "Error: Path (/Shared/nope) doesn't exist.",
    );
    const { out, exitCode } = await t.run([
      "workspace",
      "view",
      "/Shared/nope",
    ]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("workspace ls /Shared");
  });

  it("maps an empty upstream response to a structured error", async () => {
    t.fake.respondRaw("workspace export", "");
    const { out, exitCode } = await t.run(["workspace", "view", "/Shared/x"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
  });

  it("requires a path argument", async () => {
    const { exitCode } = await t.run(["workspace", "view"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a leading-dash path smuggled past `--`", async () => {
    const { exitCode } = await t.run(["workspace", "view", "--", "-x"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });
});

describe("workspace dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["workspace", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare workspace invocation", async () => {
    const { exitCode } = await t.run(["workspace"]);
    expect(exitCode).toBe(2);
  });

  it("serves workspace --help", async () => {
    const { out, exitCode } = await t.run(["workspace", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi workspace");
  });
});

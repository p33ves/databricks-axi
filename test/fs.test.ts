import { describe, expect, it } from "vitest";
import { setupCli } from "./helpers/fake-databricks.js";

const t = setupCli();

describe("fs ls", () => {
  it("prepends dbfs: to a bare absolute path and passes -l --absolute", async () => {
    t.fake.respond("fs ls dbfs:/Volumes/workspace/default/vol", {
      files: [
        {
          name: "dbfs:/Volumes/workspace/default/vol/notes.txt",
          is_directory: false,
          size: 1258291, // ~1.2MB
        },
        {
          name: "dbfs:/Volumes/workspace/default/vol/archive",
          is_directory: true,
          size: 0,
        },
      ],
    });
    const { out, exitCode } = await t.run([
      "fs",
      "ls",
      "/Volumes/workspace/default/vol",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      [
        "fs",
        "ls",
        "dbfs:/Volumes/workspace/default/vol",
        "--absolute",
        "-l",
        "-o",
        "json",
      ],
    ]);
    expect(out).toContain("entries[2]{name,is_directory,size}:");
    expect(out).toContain("notes.txt");
    expect(out).toContain("1.2MB");
    expect(out).toContain(
      "fs cat dbfs:/Volumes/workspace/default/vol/notes.txt",
    );
    expect(out).toContain("fs ls dbfs:/Volumes/workspace/default/vol/archive");
  });

  it("passes an already-scoped dbfs: path through unchanged", async () => {
    t.fake.respond("fs ls dbfs:/foo", { files: [] });
    await t.run(["fs", "ls", "dbfs:/foo"]);
    expect(t.fake.calls()).toEqual([
      ["fs", "ls", "dbfs:/foo", "--absolute", "-l", "-o", "json"],
    ]);
  });

  it("tolerates a bare-array response", async () => {
    t.fake.respond("fs ls dbfs:/x", [
      { name: "dbfs:/x/a.txt", is_directory: false, size: 10 },
    ]);
    const { out } = await t.run(["fs", "ls", "/x"]);
    expect(out).toContain("entries[1]");
    expect(out).toContain("10B");
  });

  it("caps results client-side and marks the rerun-with-full-limit", async () => {
    t.fake.respond("fs ls dbfs:/x", {
      files: [
        { name: "dbfs:/x/a", is_directory: false, size: 1 },
        { name: "dbfs:/x/b", is_directory: false, size: 1 },
        { name: "dbfs:/x/c", is_directory: false, size: 1 },
      ],
    });
    const { out } = await t.run(["fs", "ls", "/x", "--limit", "2"]);
    expect(out).toContain("entries[2]");
    expect(out).toContain("showing 2 of 3 entries — rerun with --limit 3");
    expect(out).toContain("fs ls /x --limit 3");
  });

  it("renders a definitive empty state", async () => {
    t.fake.respond("fs ls dbfs:/empty", { files: [] });
    const { out, exitCode } = await t.run(["fs", "ls", "/empty"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("/empty is empty");
  });

  it("maps the contraction 'doesn't exist' to NOT_FOUND", async () => {
    t.fake.respondError("fs ls", "Error: Path (/nope) doesn't exist.");
    const { out, exitCode } = await t.run(["fs", "ls", "/nope"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
  });

  it("maps the disabled public DBFS root to PERMISSION_DENIED with a path hint", async () => {
    t.fake.respondError(
      "fs ls",
      "Error: Public DBFS root is disabled. Access is denied on path: /foo",
    );
    const { out, exitCode } = await t.run(["fs", "ls", "/foo"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: PERMISSION_DENIED");
    expect(out).toContain("databricks-datasets");
  });

  it("requires a path argument", async () => {
    const { exitCode } = await t.run(["fs", "ls"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a leading-dash path smuggled past `--`", async () => {
    const { exitCode } = await t.run(["fs", "ls", "--", "-x"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("selects raw fields with --fields", async () => {
    t.fake.respond("fs ls dbfs:/x", {
      files: [
        {
          name: "dbfs:/x/a",
          is_directory: false,
          size: 1,
          modification_time: 5,
        },
      ],
    });
    const { out } = await t.run([
      "fs",
      "ls",
      "/x",
      "--fields",
      "name,modification_time",
    ]);
    expect(out).toContain("entries[1]{name,modification_time}:");
    expect(out).toContain("5");
  });

  it("threads --profile into argv", async () => {
    t.fake.respond("-p dev fs ls dbfs:/x", { files: [] });
    await t.run(["fs", "ls", "/x", "--profile", "dev"]);
    expect(t.fake.calls()).toEqual([
      ["-p", "dev", "fs", "ls", "dbfs:/x", "--absolute", "-l", "-o", "json"],
    ]);
  });
});

describe("fs cat", () => {
  it("scopes a bare path and skips -o json (raw mode)", async () => {
    t.fake.respondRaw(
      "fs cat dbfs:/Volumes/workspace/default/vol/notes.txt",
      "hello world\n",
    );
    const { out, exitCode } = await t.run([
      "fs",
      "cat",
      "/Volumes/workspace/default/vol/notes.txt",
    ]);
    expect(exitCode).toBe(0);
    expect(t.fake.calls()).toEqual([
      ["fs", "cat", "dbfs:/Volumes/workspace/default/vol/notes.txt"],
    ]);
    expect(out).toContain("hello world");
    expect(out).toContain("size: 12");
  });

  it("passes an already-scoped path through unchanged", async () => {
    t.fake.respondRaw("fs cat dbfs:/x/a.txt", "hi");
    await t.run(["fs", "cat", "dbfs:/x/a.txt"]);
    expect(t.fake.calls()).toEqual([["fs", "cat", "dbfs:/x/a.txt"]]);
  });

  it("head-truncates at 200 lines with a rerun marker", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    t.fake.respondRaw("fs cat", lines.join("\n"));
    const { out } = await t.run(["fs", "cat", "/big.txt"]);
    expect(out).toContain("showing first 200 of 250 lines");
    expect(out).toContain("line-1");
    expect(out).not.toContain("line-201");
  });

  it("--full disables truncation", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
    t.fake.respondRaw("fs cat", lines.join("\n"));
    const { out } = await t.run(["fs", "cat", "/big.txt", "--full"]);
    expect(out).toContain("line-250");
    expect(out).not.toContain("showing first");
  });

  it("renders non-UTF-8 content as a binary note", async () => {
    // The stub can only write JS strings, which are always valid UTF-16 ->
    // UTF-8 on the wire — U+FFFD is exactly what our own spawn layer would
    // have already substituted for genuinely invalid bytes by the time this
    // reaches fs.ts, so seeding it directly here matches the real pipeline.
    t.fake.respondRaw("fs cat", "���binary junk�");
    const { out, exitCode } = await t.run(["fs", "cat", "/image.png"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("binary,");
    expect(out).toContain("not rendered");
  });

  it("rejects json output for raw fs cat the same way upstream does", async () => {
    t.fake.respondError("fs cat", "Error: json output not supported");
    const { out, exitCode } = await t.run(["fs", "cat", "/x"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: UPSTREAM_ERROR");
  });

  it("maps NOT_FOUND with a parent ls suggestion", async () => {
    t.fake.respondError("fs cat", "Error: Path (/nope) doesn't exist.");
    const { out, exitCode } = await t.run(["fs", "cat", "/nope"]);
    expect(exitCode).toBe(1);
    expect(out).toContain("code: NOT_FOUND");
    expect(out).toContain("fs ls dbfs:/");
  });

  it("requires a path argument", async () => {
    const { exitCode } = await t.run(["fs", "cat"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("rejects a leading-dash path smuggled past `--`", async () => {
    const { exitCode } = await t.run(["fs", "cat", "--", "-x"]);
    expect(exitCode).toBe(2);
    expect(t.fake.calls()).toEqual([]);
  });

  it("threads --profile into argv", async () => {
    t.fake.respondRaw("-p dev fs cat dbfs:/x", "hi");
    await t.run(["fs", "cat", "/x", "--profile", "dev"]);
    expect(t.fake.calls()).toEqual([["-p", "dev", "fs", "cat", "dbfs:/x"]]);
  });
});

describe("fs dispatch", () => {
  it("rejects unknown subcommands", async () => {
    const { out, exitCode } = await t.run(["fs", "frobnicate"]);
    expect(exitCode).toBe(2);
    expect(out).toContain("frobnicate");
  });

  it("rejects a bare fs invocation", async () => {
    const { exitCode } = await t.run(["fs"]);
    expect(exitCode).toBe(2);
  });

  it("serves fs --help", async () => {
    const { out, exitCode } = await t.run(["fs", "--help"]);
    expect(exitCode).toBe(0);
    expect(out).toContain("usage: databricks-axi fs");
  });
});

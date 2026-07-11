import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { main } from "../../src/cli.js";

export type FakeDatabricks = {
  /** Prepend to PATH so `databricks` resolves to the stub. */
  binDir: string;
  /** Replay `json` on stdout (exit 0) when argv starts with the tokens of `prefix`. */
  respond: (prefix: string, json: unknown) => void;
  /** Replay one JSON payload per call, in order; the last one sticks. */
  respondSeq: (prefix: string, jsons: unknown[]) => void;
  /** Replay a raw stdout string verbatim — for payloads JSON.stringify would mangle (int64 ids). */
  respondRaw: (prefix: string, stdout: string) => void;
  /** Replay `stderr` text with a nonzero exit (default 1) — canned upstream errors. */
  respondError: (prefix: string, stderr: string, exitCode?: number) => void;
  /** Never respond — the stub idles until the caller's own spawn timeout
   * SIGKILLs it, for testing timeout/budget handling. */
  respondHang: (prefix: string) => void;
  /** Every recorded invocation, as raw argv arrays, in call order. */
  calls: () => string[][];
  /** Contents of `--json @path` temp-file bodies, in call order. */
  bodies: () => string[];
};

type CannedReply = {
  stdout?: unknown;
  stdoutRaw?: string;
  stderr?: string;
  exitCode?: number;
  seq?: unknown[];
  hang?: boolean;
};

/**
 * Standard CLI test rig: registers beforeEach/afterEach that put a fresh fake
 * `databricks` first on PATH and reset exitCode. `t.fake` is the current
 * test's fake; `t.run` invokes main() and captures stdout + exit code.
 */
export function setupCli() {
  const rig = {
    fake: undefined as unknown as FakeDatabricks,
    run: async (argv: string[]): Promise<{ out: string; exitCode: number }> => {
      let out = "";
      await main({
        argv,
        stdout: { write: (c: string) => ((out += c), true) },
      });
      return {
        out,
        exitCode: process.exitCode === undefined ? 0 : Number(process.exitCode),
      };
    },
  };
  let prevPath: string | undefined;
  beforeEach(() => {
    rig.fake = installFakeDatabricks();
    prevPath = process.env.PATH;
    process.env.PATH = `${rig.fake.binDir}:${prevPath ?? ""}`;
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.env.PATH = prevPath;
    process.exitCode = undefined;
  });
  return rig;
}

/**
 * Drops an executable `databricks` stub into a temp dir. The stub appends each
 * invocation's argv to calls.jsonl and replays the first matching canned
 * response; unmatched invocations exit 1 so tests fail loudly instead of
 * silently returning nothing.
 */
export function installFakeDatabricks(): FakeDatabricks {
  const dir = mkdtempSync(join(tmpdir(), "fake-databricks-"));
  const callsFile = join(dir, "calls.jsonl");
  const responsesFile = join(dir, "responses.json");
  writeFileSync(responsesFile, "{}");

  // Plain CommonJS so the stub runs standalone under `#!/usr/bin/env node`
  // with zero build step.
  const script = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
// Temp-file bodies vanish after the call — capture them now for bodies().
const ji = args.indexOf("--json");
if (ji >= 0 && args[ji + 1] && args[ji + 1].startsWith("@")) {
  try {
    const content = readFileSync(args[ji + 1].slice(1), "utf8");
    appendFileSync(${JSON.stringify(join(dir, "bodies.jsonl"))}, JSON.stringify(content) + "\\n");
  } catch {} // nonexistent @path (user passthrough) — not a temp-file body
}
const responses = JSON.parse(readFileSync(${JSON.stringify(responsesFile)}, "utf8"));
// process.exitCode (not process.exit) so large stdout payloads flush fully.
let matched = false;
for (const [prefix, reply] of Object.entries(responses)) {
  // Token-wise match: "jobs get" matches ["jobs","get",...] but never
  // ["jobs","get-run",...], unlike a joined-string startsWith.
  const parts = prefix.split(" ");
  if (parts.every((part, i) => args[i] === part)) {
    matched = true;
    if (reply.hang) {
      // Idle forever — never write, never exit. The caller's own spawn
      // timeout is expected to SIGKILL this process.
      setInterval(() => {}, 1 << 30);
      break;
    }
    if (reply.seq !== undefined) {
      // Sequential replies: consume one per call, the last one sticks.
      process.stdout.write(JSON.stringify(reply.seq[0]));
      if (reply.seq.length > 1) {
        responses[prefix] = { seq: reply.seq.slice(1) };
        require("node:fs").writeFileSync(${JSON.stringify(responsesFile)}, JSON.stringify(responses));
      }
      break;
    }
    if (reply.stderr) process.stderr.write(reply.stderr);
    if (reply.stdoutRaw !== undefined) process.stdout.write(reply.stdoutRaw);
    else if (reply.stdout !== undefined) process.stdout.write(JSON.stringify(reply.stdout));
    process.exitCode = reply.exitCode ?? 0;
    break;
  }
}
if (!matched) {
  process.stderr.write("fake-databricks: no canned response for: " + args.join(" ") + "\\n");
  process.exitCode = 1;
}
`;
  const bin = join(dir, "databricks");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);

  const seed = (prefix: string, reply: CannedReply) => {
    const current = JSON.parse(readFileSync(responsesFile, "utf8")) as Record<
      string,
      CannedReply
    >;
    current[prefix] = reply;
    writeFileSync(responsesFile, JSON.stringify(current));
  };

  return {
    binDir: dir,
    respond: (prefix, json) => seed(prefix, { stdout: json }),
    respondSeq: (prefix, jsons) => seed(prefix, { seq: jsons }),
    respondRaw: (prefix, stdout) => seed(prefix, { stdoutRaw: stdout }),
    respondError: (prefix, stderr, exitCode = 1) =>
      seed(prefix, { stderr, exitCode }),
    respondHang: (prefix) => seed(prefix, { hang: true }),
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    bodies: () =>
      existsSync(join(dir, "bodies.jsonl"))
        ? readFileSync(join(dir, "bodies.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string)
        : [],
  };
}

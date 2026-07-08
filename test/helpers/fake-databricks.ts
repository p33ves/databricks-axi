import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  /** Every recorded invocation, as raw argv arrays, in call order. */
  calls: () => string[][];
};

type CannedReply = {
  stdout?: unknown;
  stdoutRaw?: string;
  stderr?: string;
  exitCode?: number;
  seq?: unknown[];
};

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
const responses = JSON.parse(readFileSync(${JSON.stringify(responsesFile)}, "utf8"));
// process.exitCode (not process.exit) so large stdout payloads flush fully.
let matched = false;
for (const [prefix, reply] of Object.entries(responses)) {
  // Token-wise match: "jobs get" matches ["jobs","get",...] but never
  // ["jobs","get-run",...], unlike a joined-string startsWith.
  const parts = prefix.split(" ");
  if (parts.every((part, i) => args[i] === part)) {
    matched = true;
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
    calls: () =>
      existsSync(callsFile)
        ? readFileSync(callsFile, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
  };
}

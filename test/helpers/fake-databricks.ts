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
  /** Replay `json` on stdout for any invocation whose argv starts with `prefix`. */
  respond: (prefix: string, json: unknown) => void;
  /** Every recorded invocation, as raw argv arrays, in call order. */
  calls: () => string[][];
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
const key = args.join(" ");
for (const [prefix, reply] of Object.entries(responses)) {
  if (key.startsWith(prefix)) {
    process.stdout.write(JSON.stringify(reply));
    process.exit(0);
  }
}
process.stderr.write("fake-databricks: no canned response for: " + key + "\\n");
process.exit(1);
`;
  const bin = join(dir, "databricks");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);

  return {
    binDir: dir,
    respond: (prefix, json) => {
      const current = JSON.parse(readFileSync(responsesFile, "utf8")) as Record<
        string,
        unknown
      >;
      current[prefix] = json;
      writeFileSync(responsesFile, JSON.stringify(current));
    },
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

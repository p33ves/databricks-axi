import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { mapUpstreamError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_MINOR_VERSION = 298; // databricks CLI floor: 0.298 (pre-0.298 pagination flags differ)
export const INSTALL_HELP =
  "Install it: https://docs.databricks.com/dev-tools/cli/install";
export const UPGRADE_HELP =
  "Upgrade: https://docs.databricks.com/dev-tools/cli/install";
const RAW_OUTPUT_CAP_BYTES = 5 * 1024 * 1024; // fs cat / raw mode: stream + abort, never buffer unbounded
const STDERR_CAP_BYTES = 64 * 1024; // error text is never legitimately large; stop buffering past this

export type RunDatabricksOptions = {
  profile?: string;
  timeoutMs?: number;
  /** TIMEOUT suggestions — mutations pass a state check, not "retry". */
  timeoutHelp?: string[];
  /** Skip `-o json`, JSON.parse, and the int64 id-quoting regex; return raw
   * stdout text as-is. Only fs cat uses this — file content is data, not
   * a structured response. */
  raw?: boolean;
};

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  enoent: boolean;
  timedOut: boolean;
  tooLarge: boolean;
};

/**
 * Run the official databricks CLI and return its parsed JSON output (or, in
 * raw mode, the verbatim stdout string). Array argv only (never a shell),
 * stdin ignored, hard timeout, always `-o json` unless raw. All failures
 * surface as AxiError.
 */
export async function runDatabricks(
  args: string[],
  opts: RunDatabricksOptions = {},
): Promise<unknown> {
  const argv = [
    ...(opts.profile ? ["-p", opts.profile] : []),
    ...args,
    ...(opts.raw ? [] : ["-o", "json"]),
  ];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await spawnCollect(
    argv,
    timeoutMs,
    opts.raw ? RAW_OUTPUT_CAP_BYTES : undefined,
  );
  if (result.enoent) {
    throw new AxiError("databricks CLI not found on PATH", "CLI_MISSING", [
      INSTALL_HELP,
    ]);
  }
  if (result.timedOut) {
    throw new AxiError(
      `databricks ${args[0] ?? ""} timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      opts.timeoutHelp ?? ["Retry, or check workspace availability"],
    );
  }
  if (result.tooLarge) {
    throw new AxiError(
      `databricks ${args[0] ?? ""} output exceeded the ${RAW_OUTPUT_CAP_BYTES / (1024 * 1024)}MB raw-output cap`,
      "TOO_LARGE",
      [
        "Narrow the request — a smaller file, or a line-range/head tool upstream",
      ],
    );
  }
  if (result.code !== 0) {
    throw await diagnoseFailure(result.stderr);
  }
  if (opts.raw) {
    return result.stdout;
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    // int64 ids (job_id/run_id) can exceed 2^53, where JSON.parse silently
    // rounds; quote 16+-digit id values so they stay exact as strings.
    return JSON.parse(
      trimmed.replace(/"(\w*_id)"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"$1":"$2"'),
    ) as unknown;
  } catch {
    // stdout can carry exported file content (workspace view) — never echo
    // any of it into an error message, even redacted.
    throw new AxiError("databricks returned invalid JSON", "UPSTREAM_ERROR");
  }
}

/**
 * REST passthrough over the CLI's `api` subcommand. Inline bodies never
 * land on child argv (visible in `ps`): they go through a 0600 temp file
 * as upstream's `--json @path`. Bodies already in `@path` form pass
 * through untouched. Responses still land on stdout — callers must not
 * hit endpoints that echo secret values.
 */
export async function runDatabricksApi(
  method: string,
  path: string,
  body?: string,
  opts: RunDatabricksOptions = {},
): Promise<unknown> {
  if (body === undefined || body.startsWith("@")) {
    return runDatabricks(
      ["api", method, path, ...(body !== undefined ? ["--json", body] : [])],
      opts,
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "axi-"));
  const file = join(dir, "body.json");
  try {
    await writeFile(file, body, { mode: 0o600 });
    return await runDatabricks(
      ["api", method, path, "--json", `@${file}`],
      opts,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `maxBytes`, when set, streams stdout as Buffer chunks and SIGKILLs the
 * child the moment the running total exceeds the cap — never buffers an
 * unbounded response in memory. Chunks are concatenated and decoded once at
 * the end (also sidesteps multi-byte UTF-8 sequences split across pipe
 * reads, which incremental string decoding would otherwise mangle).
 */
function spawnCollect(
  argv: string[],
  timeoutMs: number,
  maxBytes?: number,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("databricks", argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = "";
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      stdoutBytes += chunk.length;
      if (maxBytes !== undefined && stdoutBytes > maxBytes) {
        tooLarge = true;
        child.kill("SIGKILL");
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STDERR_CAP_BYTES) {
        stderr += chunk;
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: stderr || error.message,
        enoent: error.code === "ENOENT",
        timedOut,
        tooLarge,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr,
        enoent: false,
        timedOut,
        tooLarge,
      });
    });
  });
}

// ponytail: version guard runs only on the failure path — a pre-flight
// `databricks -v` would tax every happy-path invocation for nothing; revisit
// if users report confusing errors from old CLIs before any command fails.
async function diagnoseFailure(stderr: string): Promise<AxiError> {
  if (
    /unknown (command|flag|shorthand)|no such (option|command)/i.test(stderr)
  ) {
    const version = await detectVersion();
    if (version && version.major === 0 && version.minor < MIN_MINOR_VERSION) {
      return new AxiError(
        `databricks CLI ${version.raw} is too old (need >= 0.298)`,
        "CLI_TOO_OLD",
        [UPGRADE_HELP],
      );
    }
  }
  return mapUpstreamError(stderr);
}

type Version = { major: number; minor: number; raw: string };

// Shared by detectVersion and probeCli — both parse the same `-v` shape.
function parseVersion(text: string): Version | null {
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), raw: match[0] };
}

async function detectVersion(): Promise<Version | null> {
  const result = await spawnCollect(["-v"], 5_000);
  // Legacy CLIs print the version to stderr.
  return parseVersion(result.stdout + result.stderr);
}

export type CliProbe = {
  found: boolean;
  version?: Version;
  /** Only set when a version was parsed; undefined means "found, version
   * unknown" (a WARN, not a FAIL — distinct from `found: false`). */
  ok?: boolean;
};

/**
 * doctor's `cli` check. Unlike `detectVersion` (used only by the failure-path
 * guard, which doesn't need the distinction), this splits "not found on
 * PATH" (FAIL CLI_MISSING) from "found, but version unparseable" (WARN).
 * `timeoutMs` defaults to the same 5s `detectVersion` uses; doctor passes its
 * own `PANEL_TIMEOUT_MS` so the whole probe batch shares one budget.
 */
export async function probeCli(timeoutMs = 5_000): Promise<CliProbe> {
  const result = await spawnCollect(["-v"], timeoutMs);
  if (result.enoent) {
    return { found: false };
  }
  const version = parseVersion(result.stdout + result.stderr);
  if (!version) {
    return { found: true };
  }
  const ok = version.major >= 1 || version.minor >= MIN_MINOR_VERSION;
  return { found: true, version, ok };
}

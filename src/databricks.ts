import { spawn } from "node:child_process";
import { AxiError } from "axi-sdk-js";
import { mapUpstreamError, redactSecrets } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_MINOR_VERSION = 205; // databricks CLI floor: 0.205
const INSTALL_HELP = "Install it: https://docs.databricks.com/dev-tools/cli/install";

export type RunDatabricksOptions = {
  profile?: string;
  timeoutMs?: number;
};

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  enoent: boolean;
  timedOut: boolean;
};

/**
 * Run the official databricks CLI and return its parsed JSON output.
 * Array argv only (never a shell), stdin ignored, hard timeout, always
 * `-o json`. All failures surface as AxiError.
 */
export async function runDatabricks(
  args: string[],
  opts: RunDatabricksOptions = {},
): Promise<unknown> {
  const argv = [
    ...(opts.profile ? ["-p", opts.profile] : []),
    ...args,
    "-o",
    "json",
  ];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const result = await spawnCollect(argv, timeoutMs);
  if (result.enoent) {
    throw new AxiError("databricks CLI not found on PATH", "CLI_MISSING", [
      INSTALL_HELP,
    ]);
  }
  if (result.timedOut) {
    throw new AxiError(
      `databricks ${args[0] ?? ""} timed out after ${timeoutMs}ms`,
      "TIMEOUT",
      ["Retry, or check workspace availability"],
    );
  }
  if (result.code !== 0) {
    throw await diagnoseFailure(result.stderr);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new AxiError(
      `databricks returned invalid JSON: ${redactSecrets(trimmed).slice(0, 120)}`,
      "UPSTREAM_ERROR",
    );
  }
}

function spawnCollect(argv: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn("databricks", argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr,
        enoent: error.code === "ENOENT",
        timedOut,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, enoent: false, timedOut });
    });
  });
}

// ponytail: version guard runs only on the failure path — a pre-flight
// `databricks -v` would tax every happy-path invocation for nothing.
async function diagnoseFailure(stderr: string): Promise<AxiError> {
  if (/unknown (command|flag|shorthand)/i.test(stderr)) {
    const version = await detectVersion();
    if (version && version.major === 0 && version.minor < MIN_MINOR_VERSION) {
      return new AxiError(
        `databricks CLI ${version.raw} is too old (need >= 0.205)`,
        "CLI_TOO_OLD",
        [`Upgrade: https://docs.databricks.com/dev-tools/cli/install`],
      );
    }
  }
  return mapUpstreamError(stderr);
}

async function detectVersion(): Promise<{
  major: number;
  minor: number;
  raw: string;
} | null> {
  const result = await spawnCollect(["-v"], 5_000);
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), raw: match[0] };
}

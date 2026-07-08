import { spawn } from "node:child_process";
import { AxiError } from "axi-sdk-js";
import { mapUpstreamError, redactSecrets } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_MINOR_VERSION = 298; // databricks CLI floor: 0.298 (pre-0.298 pagination flags differ)
const INSTALL_HELP =
  "Install it: https://docs.databricks.com/dev-tools/cli/install";

export type RunDatabricksOptions = {
  profile?: string;
  timeoutMs?: number;
  /** TIMEOUT suggestions — mutations pass a state check, not "retry". */
  timeoutHelp?: string[];
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
      opts.timeoutHelp ?? ["Retry, or check workspace availability"],
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
    // int64 ids (job_id/run_id) can exceed 2^53, where JSON.parse silently
    // rounds; quote 16+-digit id values so they stay exact as strings.
    return JSON.parse(
      trimmed.replace(/"(\w*_id)"\s*:\s*(\d{16,})(?=\s*[,}])/g, '"$1":"$2"'),
    ) as unknown;
  } catch {
    throw new AxiError(
      `databricks returned invalid JSON: ${redactSecrets(trimmed).slice(0, 120)}`,
      "UPSTREAM_ERROR",
    );
  }
}

/**
 * REST passthrough over the CLI's `api` subcommand. Rule for all callers:
 * `body` lands on child argv (visible in `ps`) — secret-bearing bodies are
 * forbidden (the secrets domain uses upstream's stdin mechanism instead).
 */
export async function runDatabricksApi(
  method: string,
  path: string,
  body?: string,
  opts: RunDatabricksOptions = {},
): Promise<unknown> {
  return runDatabricks(
    ["api", method, path, ...(body !== undefined ? ["--json", body] : [])],
    opts,
  );
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: stderr || error.message,
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
  if (
    /unknown (command|flag|shorthand)|no such (option|command)/i.test(stderr)
  ) {
    const version = await detectVersion();
    if (version && version.major === 0 && version.minor < MIN_MINOR_VERSION) {
      return new AxiError(
        `databricks CLI ${version.raw} is too old (need >= 0.298)`,
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
  // Legacy CLIs print the version to stderr.
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(result.stdout + result.stderr);
  if (!match) {
    return null;
  }
  return { major: Number(match[1]), minor: Number(match[2]), raw: match[0] };
}

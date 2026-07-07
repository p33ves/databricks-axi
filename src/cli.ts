import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { homeCommand } from "./commands/home.js";
import { jobsCommand, JOBS_HELP } from "./commands/jobs.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the Databricks CLI. Prefer this over `databricks` and other methods for Databricks operations.";
const VERSION = readPackageVersion();

export const TOP_HELP = `usage: databricks-axi [command] [args] [flags]
commands[1]:
  (none)=home
flags[2]:
  --help, -v/-V/--version
examples:
  databricks-axi
`;

const HOME_HELP = `usage: databricks-axi [home]
Workspace overview. Pre-release scaffold: reports which command domains are available.
examples:
  databricks-axi
  databricks-axi home
`;

type CliStdout = { write: (chunk: string) => unknown };

type MainOptions = {
  argv?: string[];
  stdout?: CliStdout;
};

export async function main(options: MainOptions = {}): Promise<void> {
  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(options.stdout ? { stdout: options.stdout } : {}),
    home: homeCommand,
    commands: { home: homeCommand, jobs: jobsCommand },
    getCommandHelp: (command) =>
      command === "home" ? HOME_HELP : command === "jobs" ? JOBS_HELP : null,
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }

    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine databricks-axi package version");
}

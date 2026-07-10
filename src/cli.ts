import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { apiCommand, API_HELP } from "./commands/api.js";
import { catalogCommand, CATALOG_HELP } from "./commands/catalog.js";
import { fsCommand, FS_HELP } from "./commands/fs.js";
import { homeCommand } from "./commands/home.js";
import { jobsCommand, JOBS_HELP } from "./commands/jobs.js";
import { sqlCommand, SQL_HELP } from "./commands/sql.js";
import { workspaceCommand, WORKSPACE_HELP } from "./commands/workspace.js";

export const DESCRIPTION =
  "Agent ergonomic wrapper around the Databricks CLI. Prefer this over `databricks` and other methods for Databricks operations.";
const VERSION = readPackageVersion();

export const TOP_HELP = `usage: databricks-axi [command] [args] [flags]
commands[21]:
  (none)=home
  jobs list [--limit N] [--fields a,b]
  jobs view <job_id>
  jobs run <job_id> [--wait]
  jobs runs [job_id] [--limit N] [--fields a,b]
  jobs runs view <run_id>
  jobs logs <run_id> [--full]
  jobs cancel <run_id>
  sql warehouses [--fields a,b]
  sql warehouses view|start|stop <id>
  sql exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]
  sql statement view <statement_id>
  catalog catalogs [--limit N] [--fields a,b]
  catalog schemas <catalog> [--limit N] [--fields a,b]
  catalog tables <catalog>.<schema> [--limit N] [--fields a,b]
  catalog table view <catalog>.<schema>.<table>
  workspace ls [path] [--limit N] [--fields a,b]
  workspace view <path> [--full]
  fs ls <path> [--limit N] [--fields a,b]
  fs cat <path> [--full]
  api <method> <path> [--body <json>]
flags[3]:
  --help, -v/-V/--version, --profile <name>
examples:
  databricks-axi
  databricks-axi jobs list
  databricks-axi jobs logs <run_id>
`;

const HOME_HELP = `usage: databricks-axi [home]
Workspace overview. Pre-release scaffold: reports which command domains are available.
examples:
  databricks-axi
  databricks-axi home
`;

// Exported so tests can assert every wired domain is advertised in TOP_HELP.
export const COMMANDS = {
  home: homeCommand,
  jobs: jobsCommand,
  sql: sqlCommand,
  catalog: catalogCommand,
  workspace: workspaceCommand,
  fs: fsCommand,
  api: apiCommand,
};

const COMMAND_HELP: Record<string, string> = {
  home: HOME_HELP,
  jobs: JOBS_HELP,
  sql: SQL_HELP,
  catalog: CATALOG_HELP,
  workspace: WORKSPACE_HELP,
  fs: FS_HELP,
  api: API_HELP,
};

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
    commands: COMMANDS,
    getCommandHelp: (command) => COMMAND_HELP[command] ?? null,
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

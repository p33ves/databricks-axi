import {
  AxiError,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";

export const JOBS_HELP = `usage: databricks-axi jobs <subcommand> [args] [flags]
subcommands[4]:
  list [--limit N] [--page-token T] [--fields a,b]
  view <job_id>
  run <job_id> [--wait]
  cancel <run_id>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi jobs list
  databricks-axi jobs run 101
notes:
  run is async by default; --wait blocks up to ~20 min upstream (agents: avoid)
`;

type Raw = Record<string, unknown>;
type RunState = { result_state?: string; life_cycle_state?: string };
type RawTask = {
  task_key?: string;
  run_id?: number;
  state?: RunState;
  notebook_task?: { notebook_path?: string };
  spark_python_task?: { python_file?: string };
} & Raw;
type RawJob = {
  job_id?: number;
  creator_user_name?: string;
  settings?: {
    name?: string;
    schedule?: { quartz_cron_expression?: string; pause_status?: string };
    tasks?: RawTask[];
  };
} & Raw;

export async function jobsCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return jobsList(rest);
    case "view":
      return jobsView(rest);
    case "run":
      return jobsRun(rest);
    case "cancel":
      return jobsCancel(rest);
    default:
      throw usage(
        sub ? `Unknown jobs subcommand: ${sub}` : "jobs requires a subcommand",
      );
  }
}

// --- subcommands ---

const LIST_FLAGS = {
  profile: "value",
  limit: "value",
  "page-token": "value",
  fields: "value",
} as const;

async function jobsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`jobs list takes no arguments, got: ${positional[0]}`);
  }
  const argv = ["jobs", "list", "--limit", String(flags.get("limit") ?? "30")];
  const pageToken = flags.get("page-token");
  if (typeof pageToken === "string") {
    argv.push("--page-token", pageToken);
  }
  const parsed = await runJobs(argv, spawnOpts(flags));
  const { items, nextPageToken } = asList(parsed, "jobs");
  const flattened = items.map((job) => ({
    ...job,
    name: (job as RawJob).settings?.name,
  }));
  const rows = renderRows(flattened, flags, [
    "job_id",
    "name",
    "creator_user_name",
  ]);
  if (rows.length === 0) {
    return {
      jobs: [],
      status: "no jobs in this workspace",
      help: ["Create one in the workspace UI: Workflows > Create job"],
    };
  }
  const help = [
    "databricks-axi jobs view <job_id>",
    "databricks-axi jobs runs <job_id>",
  ];
  const out: AxiStructuredOutput = { jobs: rows, count: rows.length };
  if (nextPageToken) {
    out.has_more = true;
    help.unshift(`databricks-axi jobs list --page-token ${nextPageToken}`);
  }
  out.help = help;
  return out;
}

async function jobsView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const jobId = requireId(positional, "jobs view <job_id>");
  const job = (await runJobs(
    ["jobs", "get", jobId],
    spawnOpts(flags),
  )) as RawJob;
  const settings = job.settings ?? {};
  const out: AxiStructuredOutput = {
    job_id: job.job_id,
    name: settings.name,
    creator: job.creator_user_name,
  };
  if (settings.schedule?.quartz_cron_expression) {
    out.schedule = `${settings.schedule.quartz_cron_expression} (${settings.schedule.pause_status ?? "UNPAUSED"})`;
  }
  out.tasks = (settings.tasks ?? []).map((task) => ({
    task_key: task.task_key,
    type: taskType(task),
  }));
  out.help = [
    `databricks-axi jobs run ${jobId}`,
    `databricks-axi jobs runs ${jobId}`,
  ];
  return out;
}

const WAIT_TIMEOUT_MS = 25 * 60_000; // upstream blocks up to 20 min on --wait

function compactState(item: { state?: RunState }): string {
  return item.state?.result_state ?? item.state?.life_cycle_state ?? "UNKNOWN";
}

async function jobsRun(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    wait: "boolean",
  });
  const jobId = requireId(positional, "jobs run <job_id> [--wait]");
  const wait = flags.get("wait") === true;
  const argv = ["jobs", "run-now", jobId];
  if (!wait) {
    argv.push("--no-wait");
  }
  const opts = {
    ...spawnOpts(flags),
    ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
  };
  const runObj = (await runJobs(argv, opts)) as {
    run_id?: number;
    state?: RunState;
  };
  const out: AxiStructuredOutput = { run_id: runObj.run_id };
  if (runObj.state) {
    out.state = compactState(runObj);
  }
  out.help = [`databricks-axi jobs runs view ${runObj.run_id}`];
  return out;
}

async function jobsCancel(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const runId = requireId(positional, "jobs cancel <run_id>");
  try {
    await runJobs(["jobs", "cancel-run", runId, "--no-wait"], spawnOpts(flags));
  } catch (error) {
    if (isAlreadyTerminated(error)) {
      return {
        run_id: Number(runId),
        status: "run already terminated (no-op)",
        help: [`databricks-axi jobs runs view ${runId}`],
      };
    }
    throw error;
  }
  return {
    run_id: Number(runId),
    status: "cancel requested",
    help: [`databricks-axi jobs runs view ${runId}`],
  };
}

function isAlreadyTerminated(error: unknown): boolean {
  if (!(error instanceof AxiError)) {
    return false;
  }
  return (
    error.code === "INVALID_STATE" ||
    /cannot be canceled|already (terminated|completed)/i.test(error.message)
  );
}

function taskType(task: RawTask): string {
  if (task.notebook_task?.notebook_path) {
    return `notebook: ${task.notebook_task.notebook_path}`;
  }
  if (task.spark_python_task?.python_file) {
    return `python: ${task.spark_python_task.python_file}`;
  }
  const key = Object.keys(task).find((k) => k.endsWith("_task"));
  return key ? key.replace(/_task$/, "") : "unknown";
}

// --- shared helpers (used by every jobs subcommand) ---

type FlagSpec = Record<string, "value" | "boolean">;
type Flags = Map<string, string | boolean>;

function parseArgs(
  args: string[],
  spec: FlagSpec,
): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const kind = spec[name];
    if (!kind) {
      const valid = Object.keys(spec)
        .map((f) => `--${f}`)
        .join(", ");
      throw usage(`Unknown flag: --${name}`, [`Valid flags: ${valid}`]);
    }
    if (kind === "boolean") {
      flags.set(name, true);
      continue;
    }
    const value = args[++i];
    if (value === undefined) {
      throw usage(`Flag --${name} requires a value`);
    }
    flags.set(name, value);
  }
  return { positional, flags };
}

function usage(message: string, extraHelp: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", [
    ...extraHelp,
    "Run `databricks-axi jobs --help`",
  ]);
}

function requireId(positional: string[], usageText: string): string {
  const id = positional[0];
  if (!id || !/^\d+$/.test(id)) {
    throw usage(`Usage: databricks-axi ${usageText}`);
  }
  return id;
}

function spawnOpts(flags: Flags): RunDatabricksOptions {
  const profile = flags.get("profile");
  return typeof profile === "string" ? { profile } : {};
}

/** runDatabricks, with jobs-flavored suggestions folded into NOT_FOUND. */
async function runJobs(
  args: string[],
  opts: RunDatabricksOptions,
): Promise<unknown> {
  try {
    return await runDatabricks(args, opts);
  } catch (error) {
    if (
      error instanceof AxiError &&
      error.code === "NOT_FOUND" &&
      error.suggestions.length === 0
    ) {
      throw new AxiError(error.message, "NOT_FOUND", [
        "databricks-axi jobs list",
        "databricks-axi jobs runs",
      ]);
    }
    throw error;
  }
}

/**
 * The Go CLI prints either a bare item array or the full response object
 * ({items, next_page_token}) depending on version — tolerate both.
 */
function asList(
  parsed: unknown,
  key: string,
): { items: Raw[]; nextPageToken?: string } {
  if (Array.isArray(parsed)) {
    return { items: parsed as Raw[] };
  }
  const obj = (parsed ?? {}) as Raw;
  const items = (obj[key] as Raw[] | undefined) ?? [];
  const token = obj["next_page_token"];
  return {
    items,
    ...(typeof token === "string" && token ? { nextPageToken: token } : {}),
  };
}

/** Apply --fields (raw top-level keys) or the default field list. */
function renderRows(items: Raw[], flags: Flags, defaults: string[]): Raw[] {
  const spec = flags.get("fields");
  const fields =
    typeof spec === "string"
      ? spec
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean)
      : defaults;
  const first = items[0];
  if (typeof spec === "string" && first) {
    for (const field of fields) {
      if (!(field in first)) {
        throw usage(`Unknown field: ${field}`, [
          `Available fields: ${Object.keys(first).sort().join(", ")}`,
        ]);
      }
    }
  }
  return items.map((item) =>
    Object.fromEntries(fields.map((field) => [field, item[field] ?? ""])),
  );
}

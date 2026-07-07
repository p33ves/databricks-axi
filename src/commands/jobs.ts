import { AxiError } from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";

// axi-sdk-js 0.1.8 doesn't re-export its output types from the package
// index; mirror the two one-line aliases locally until it does.
type AxiStructuredOutput = Record<string, unknown>;
type AxiRenderable = string | AxiStructuredOutput;

export const JOBS_HELP = `usage: databricks-axi jobs <subcommand> [args] [flags]
subcommands[7]:
  list [--limit N] [--fields a,b]
  view <job_id>
  run <job_id> [--wait]
  runs [job_id] [--limit N] [--fields a,b]
  runs view <run_id>
  logs <run_id> [--full]
  cancel <run_id>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi jobs list
  databricks-axi jobs run 101
  databricks-axi jobs logs 901
notes:
  run is async by default; --wait blocks up to ~20 min upstream (agents: avoid)
  logs shows failed tasks first, last 50 lines each; --full for everything
`;

type Raw = Record<string, unknown>;
type RunState = { result_state?: string; life_cycle_state?: string };
type RawTask = {
  task_key?: string;
  run_id?: number;
  state?: RunState;
  notebook_task?: { notebook_path?: string };
  spark_python_task?: { python_file?: string };
  execution_duration?: number;
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
type RawRun = {
  run_id?: number;
  job_id?: number;
  state?: RunState;
  start_time?: number;
  end_time?: number;
  run_duration?: number;
  tasks?: RawTask[];
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
    case "runs":
      return rest[0] === "view" ? runsView(rest.slice(1)) : runsList(rest);
    case "logs":
      return jobsLogs(rest);
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
  fields: "value",
} as const;

async function jobsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`jobs list takes no arguments, got: ${positional[0]}`);
  }
  const limit = Number(flags.get("limit") ?? 30);
  const argv = ["jobs", "list", "--limit", String(limit)];
  const parsed = await runJobs(argv, spawnOpts(flags));
  const items = asList(parsed, "jobs");
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
  // CLI >= 0.298 caps results client-side at --limit; a full page means
  // there may be more.
  if (rows.length >= limit) {
    out.has_more = true;
    help.unshift(`databricks-axi jobs list --limit ${limit * 2}`);
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

/** Terminal and not clean success (FAILED, TIMEDOUT, CANCELED, ...). */
function isFailed(item: { state?: RunState }): boolean {
  const result = item.state?.result_state;
  return typeof result === "string" && result !== "SUCCESS";
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
    timeoutHelp: [
      "The run may have started despite the timeout — check before retrying:",
      `databricks-axi jobs runs ${jobId}`,
    ],
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
    await runJobs(["jobs", "cancel-run", runId, "--no-wait"], {
      ...spawnOpts(flags),
      timeoutHelp: [
        "The cancel may have applied despite the timeout — check state:",
        `databricks-axi jobs runs view ${runId}`,
      ],
    });
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

function iso(ms: number | undefined): string {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : "";
}

function durationSeconds(item: {
  run_duration?: number;
  execution_duration?: number;
  start_time?: number;
  end_time?: number;
}): number {
  const ms =
    item.run_duration ??
    item.execution_duration ??
    (item.end_time && item.start_time ? item.end_time - item.start_time : 0);
  return Math.round(ms / 1000);
}

async function runsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  const limit = Number(flags.get("limit") ?? 20);
  const argv = ["jobs", "list-runs", "--limit", String(limit)];
  let jobId: string | undefined;
  if (positional.length > 0) {
    jobId = requireId(positional, "jobs runs [job_id]");
    argv.push("--job-id", jobId);
  }
  const parsed = await runJobs(argv, spawnOpts(flags));
  const items = asList(parsed, "runs");
  const runs = items as RawRun[];
  const rows =
    typeof flags.get("fields") === "string"
      ? renderRows(items, flags, [])
      : runs.map((r) => ({
          run_id: r.run_id,
          state: compactState(r),
          start_time: iso(r.start_time),
          duration_s: durationSeconds(r),
        }));
  if (rows.length === 0) {
    return {
      runs: [],
      status: "no runs found",
      help: ["databricks-axi jobs run <job_id>"],
    };
  }
  const help = ["databricks-axi jobs runs view <run_id>"];
  const firstFailed = runs.find(isFailed);
  if (firstFailed) {
    help.unshift(`databricks-axi jobs logs ${firstFailed.run_id}`);
  }
  const out: AxiStructuredOutput = { runs: rows, count: rows.length };
  if (rows.length >= limit) {
    out.has_more = true;
    help.unshift(
      `databricks-axi jobs runs${jobId ? ` ${jobId}` : ""} --limit ${limit * 2}`,
    );
  }
  out.help = help;
  return out;
}

async function runsView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const runId = requireId(positional, "jobs runs view <run_id>");
  const runObj = (await runJobs(
    ["jobs", "get-run", runId],
    spawnOpts(flags),
  )) as RawRun;
  const state = compactState(runObj);
  return {
    run_id: runObj.run_id,
    job_id: runObj.job_id,
    state,
    start_time: iso(runObj.start_time),
    duration_s: durationSeconds(runObj),
    tasks: (runObj.tasks ?? []).map((task) => ({
      task_key: task.task_key,
      state: compactState(task),
      duration_s: durationSeconds(task),
    })),
    help: isFailed(runObj)
      ? [`databricks-axi jobs logs ${runId}`]
      : [`databricks-axi jobs runs ${runObj.job_id ?? ""}`.trim()],
  };
}

const LOG_TAIL_LINES = 50;

type RawRunOutput = {
  error?: string;
  error_trace?: string;
  logs?: string;
  notebook_output?: { result?: string };
};

async function jobsLogs(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const runId = requireId(positional, "jobs logs <run_id> [--full]");
  const full = flags.get("full") === true;
  const opts = spawnOpts(flags);
  const runObj = (await runJobs(["jobs", "get-run", runId], opts)) as RawRun;
  const tasks = runObj.tasks ?? [];
  if (tasks.length === 0) {
    return {
      run_id: runObj.run_id,
      state: compactState(runObj),
      status: "run has no tasks (no output to fetch)",
      help: [`databricks-axi jobs runs view ${runId}`],
    };
  }
  // ponytail: sequential fan-out — runs have a handful of tasks; parallelize
  // only if logs latency ever actually hurts.
  const entries: AxiStructuredOutput[] = [];
  for (const task of tasks) {
    if (task.run_id == null) {
      entries.push({
        task: task.task_key,
        state: compactState(task),
        error: "task has no run_id; output unavailable",
      });
      continue;
    }
    try {
      const output = (await runJobs(
        ["jobs", "get-run-output", String(task.run_id)],
        opts,
      )) as RawRunOutput;
      entries.push(taskLogEntry(task, output, full));
    } catch (error) {
      // One task's output failing shouldn't sink the rest of the fan-out.
      entries.push({
        task: task.task_key,
        state: compactState(task),
        error: `output fetch failed: ${error instanceof AxiError ? error.message : String(error)}`,
      });
    }
  }
  entries.sort(
    (a, b) => Number(a.state === "SUCCESS") - Number(b.state === "SUCCESS"),
  );
  return {
    run_id: runObj.run_id,
    state: compactState(runObj),
    tasks: entries,
    help: [`databricks-axi jobs runs view ${runId}`],
  };
}

function taskLogEntry(
  task: RawTask,
  output: RawRunOutput,
  full: boolean,
): AxiStructuredOutput {
  const entry: AxiStructuredOutput = {
    task: task.task_key,
    state: compactState(task),
  };
  let traceClipped = false;
  if (output.error) {
    entry.error = output.error;
  }
  if (output.error_trace) {
    if (full) {
      entry.error_trace = output.error_trace;
    } else {
      const t = tail(output.error_trace, LOG_TAIL_LINES);
      entry.error_trace = t.text;
      traceClipped = t.truncated;
    }
  }
  const text = output.notebook_output?.result ?? output.logs ?? "";
  if (text) {
    if (full) {
      entry.output = text;
    } else {
      const t = tail(text, LOG_TAIL_LINES);
      entry.output = t.text;
      if (t.truncated) {
        entry.truncated = `showing last ${LOG_TAIL_LINES} of ${t.total} lines — rerun with --full`;
      }
    }
  }
  if (traceClipped && !entry.truncated) {
    entry.truncated = `error_trace clipped to last ${LOG_TAIL_LINES} lines — rerun with --full`;
  }
  return entry;
}

function tail(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean; total: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, total: lines.length };
  }
  return {
    text: lines.slice(-maxLines).join("\n"),
    truncated: true,
    total: lines.length,
  };
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
  if (!id || !/^\d+$/.test(id) || positional.length > 1) {
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
 * The Go CLI prints either a bare item array (>= 0.298) or the response
 * object ({items, ...}) depending on version — tolerate both.
 */
function asList(parsed: unknown, key: string): Raw[] {
  if (Array.isArray(parsed)) {
    return parsed as Raw[];
  }
  const obj = (parsed ?? {}) as Raw;
  return (obj[key] as Raw[] | undefined) ?? [];
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

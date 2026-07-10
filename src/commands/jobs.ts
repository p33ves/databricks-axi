import { AxiError } from "axi-sdk-js";
import type { RunDatabricksOptions } from "../databricks.js";
import { redactSecrets } from "../errors.js";
import { truncate } from "../truncate.js";
import {
  asList,
  assertObject,
  domainHelpers,
  LIST_FLAGS,
  listResult,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const {
  usage,
  parseArgs,
  parseIntFlag,
  requireId: requireIdArg,
  renderRows,
} = domainHelpers("jobs");

// Jobs ids are numeric — reject anything else before it reaches argv.
const requireId = (positional: string[], usageText: string) =>
  requireIdArg(positional, usageText, /^\d+$/);

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
  run_id?: number | string;
  state?: RunState;
  notebook_task?: { notebook_path?: string };
  spark_python_task?: { python_file?: string };
  execution_duration?: number;
} & Raw;
type RawJob = {
  job_id?: number | string;
  creator_user_name?: string;
  settings?: {
    name?: string;
    schedule?: { quartz_cron_expression?: string; pause_status?: string };
    tasks?: RawTask[];
  };
} & Raw;
type RawRun = {
  run_id?: number | string;
  job_id?: number | string;
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

async function jobsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`jobs list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
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
  const p = profileSuffix(flags.get("profile"));
  return listResult("jobs", rows, limit, {
    rerun: `databricks-axi jobs list --limit ${limit * 2}${p}`,
    empty: {
      status: "no jobs in this workspace",
      help: ["Create one in the workspace UI: Workflows > Create job"],
    },
    help: [
      `databricks-axi jobs view <job_id>${p}`,
      `databricks-axi jobs runs <job_id>${p}`,
    ],
  });
}

async function jobsView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const jobId = requireId(positional, "jobs view <job_id>");
  const job = (await runJobsObject(
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
  const p = profileSuffix(flags.get("profile"));
  out.help = [
    `databricks-axi jobs run ${jobId}${p}`,
    `databricks-axi jobs runs ${jobId}${p}`,
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
  const p = profileSuffix(flags.get("profile"));
  const argv = ["jobs", "run-now", jobId];
  if (!wait) {
    argv.push("--no-wait");
  }
  const opts = {
    ...spawnOpts(flags),
    ...(wait ? { timeoutMs: WAIT_TIMEOUT_MS } : {}),
    timeoutHelp: [
      "The run may have started despite the timeout — check before retrying:",
      `databricks-axi jobs runs ${jobId}${p}`,
    ],
  };
  const runObj = (await runJobsObject(argv, opts)) as {
    run_id?: number | string;
    state?: RunState;
  };
  const out: AxiStructuredOutput = { run_id: runObj.run_id };
  if (runObj.state) {
    out.state = compactState(runObj);
  }
  out.help = [`databricks-axi jobs runs view ${runObj.run_id}${p}`];
  return out;
}

async function jobsCancel(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const runId = requireId(positional, "jobs cancel <run_id>");
  const p = profileSuffix(flags.get("profile"));
  try {
    await runJobs(["jobs", "cancel-run", runId, "--no-wait"], {
      ...spawnOpts(flags),
      timeoutHelp: [
        "The cancel may have applied despite the timeout — check state:",
        `databricks-axi jobs runs view ${runId}${p}`,
      ],
    });
  } catch (error) {
    if (isAlreadyTerminated(error)) {
      return {
        run_id: runId,
        status: "run already terminated (no-op)",
        help: [`databricks-axi jobs runs view ${runId}${p}`],
      };
    }
    throw error;
  }
  return {
    run_id: runId,
    status: "cancel requested",
    help: [`databricks-axi jobs runs view ${runId}${p}`],
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
  const limit = parseIntFlag(flags, "limit", 20);
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
  const p = profileSuffix(flags.get("profile"));
  const help = [`databricks-axi jobs runs view <run_id>${p}`];
  const firstFailed = runs.find(isFailed);
  if (firstFailed) {
    help.unshift(`databricks-axi jobs logs ${firstFailed.run_id}${p}`);
  }
  return listResult("runs", rows, limit, {
    rerun: `databricks-axi jobs runs${jobId ? ` ${jobId}` : ""} --limit ${limit * 2}${p}`,
    empty: {
      status: "no runs found",
      help: [`databricks-axi jobs run <job_id>${p}`],
    },
    help,
  });
}

async function runsView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, { profile: "value" });
  const runId = requireId(positional, "jobs runs view <run_id>");
  const runObj = (await runJobsObject(
    ["jobs", "get-run", runId],
    spawnOpts(flags),
  )) as RawRun;
  const state = compactState(runObj);
  const p = profileSuffix(flags.get("profile"));
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
      ? [`databricks-axi jobs logs ${runId}${p}`]
      : [`databricks-axi jobs runs ${runObj.job_id ?? ""}`.trim() + p],
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
  const p = profileSuffix(flags.get("profile"));
  const runObj = (await runJobsObject(
    ["jobs", "get-run", runId],
    opts,
  )) as RawRun;
  const tasks = runObj.tasks ?? [];
  if (tasks.length === 0) {
    return {
      run_id: runObj.run_id,
      state: compactState(runObj),
      status: "run has no tasks (no output to fetch)",
      help: [`databricks-axi jobs runs view ${runId}${p}`],
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
      const output = (await runJobsObject(
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
    help: [`databricks-axi jobs runs view ${runId}${p}`],
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
  // Upstream log/trace text goes straight into agent context — redact
  // token-shaped strings before assembly (same rule as sql error detail).
  if (output.error) {
    entry.error = redactSecrets(output.error);
  }
  if (output.error_trace) {
    const trace = redactSecrets(output.error_trace);
    if (full) {
      entry.error_trace = trace;
    } else {
      const t = truncate(trace, { lines: LOG_TAIL_LINES, mode: "tail" });
      entry.error_trace = t.text;
      traceClipped = t.truncated;
    }
  }
  const text = redactSecrets(
    output.notebook_output?.result || output.logs || "",
  );
  if (text) {
    if (full) {
      entry.output = text;
    } else {
      const t = truncate(text, { lines: LOG_TAIL_LINES, mode: "tail" });
      entry.output = t.text;
      if (t.truncated) {
        entry.truncated = `showing last ${LOG_TAIL_LINES} of ${t.totalLines} lines — rerun with --full`;
      }
    }
  }
  if (traceClipped && !entry.truncated) {
    entry.truncated = `error_trace clipped to last ${LOG_TAIL_LINES} lines — rerun with --full`;
  }
  return entry;
}

/** runDatabricks, with jobs-flavored suggestions folded into NOT_FOUND. */
function runJobs(args: string[], opts: RunDatabricksOptions): Promise<unknown> {
  const p = profileSuffix(opts.profile);
  return runWithNotFoundHelp(args, opts, [
    `databricks-axi jobs list${p}`,
    `databricks-axi jobs runs${p}`,
  ]);
}

/** runJobs for endpoints whose result gets dereferenced — empty stdout
 * (null) becomes a structured UPSTREAM_ERROR instead of a TypeError. */
async function runJobsObject(
  args: string[],
  opts: RunDatabricksOptions,
): Promise<Raw> {
  return assertObject<Raw>(
    await runJobs(args, opts),
    `databricks ${args.slice(0, 2).join(" ")}`,
  );
}

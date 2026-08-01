import { AxiError } from "axi-sdk-js";
import type { RunDatabricksOptions } from "../databricks.js";
import { redactSecrets } from "../errors.js";
import { truncate } from "../truncate.js";
import {
  asList,
  assertObject,
  compactState,
  domainHelpers,
  isFailed,
  isGenuineFailure,
  listResult,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  totalMode,
  TOTAL_LIST_FLAGS,
  WAIT_TIMEOUT_MS,
  type AxiRenderable,
  type AxiStructuredOutput,
  type RunState,
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
subcommands[8]:
  list [--limit N] [--total] [--fields a,b]
  view <job_id>
  run <job_id> [--wait]
  runs [job_id] [--limit N] [--total] [--fields a,b]
  runs view <run_id>
  runs summary [job_id] [--limit N]
  logs <run_id> [--full]
  cancel <run_id>
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi jobs list
  databricks-axi jobs run 101
  databricks-axi jobs logs 901
  databricks-axi jobs runs summary 101
notes:
  run is async by default; --wait blocks up to ~20 min upstream (agents: avoid)
  logs shows failed tasks first, last 50 lines each; --full for everything
  list/runs: --limit fetches one page; add --total for an exact count from a
  bounded fetch (costs extra round trips, --limit then caps rows shown only)
  runs summary: audit rollup over a bounded window (default 50, max 200
  recent runs) of state tallies plus the first failing run/task/error;
  "running" means no terminal result_state yet (life_cycle running, pending,
  queued, or skipped), not only actively-running runs; "failed" counts genuine
  failures only: canceled, timed-out, excluded, disabled, and
  concurrency-capped runs are terminal but tally as "other"
`;

type Raw = Record<string, unknown>;
type RawTask = {
  task_key?: string;
  run_id?: number | string;
  state?: RunState;
  notebook_task?: { notebook_path?: string };
  spark_python_task?: { python_file?: string };
  execution_duration?: number;
  depends_on?: { task_key?: string }[];
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
      if (rest[0] === "view") {
        return runsView(rest.slice(1));
      }
      if (rest[0] === "summary") {
        return runsSummary(rest.slice(1));
      }
      return runsList(rest);
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
  const { positional, flags } = parseArgs(args, TOTAL_LIST_FLAGS);
  if (positional.length > 0) {
    throw usage(`jobs list takes no arguments, got: ${positional[0]}`);
  }
  const limit = parseIntFlag(flags, "limit", 30);
  const counted = totalMode(flags, limit);
  const argv = ["jobs", "list", "--limit", String(counted.fetch)];
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
    rerun: `databricks-axi jobs list ${counted.rerun(rows.length)}${p}`,
    empty: {
      status: "no jobs in this workspace",
      help: ["Create one in the workspace UI: Workflows > Create job"],
    },
    help: [
      `databricks-axi jobs view <job_id>${p}`,
      `databricks-axi jobs runs <job_id>${p}`,
    ],
    total: counted.total,
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
    creator_user_name: job.creator_user_name,
  };
  if (settings.schedule?.quartz_cron_expression) {
    out.schedule = `${settings.schedule.quartz_cron_expression} (${settings.schedule.pause_status ?? "UNPAUSED"})`;
  }
  // depends_on is a "|"-joined scalar, and present on every task or none:
  // a nested array (or a key only some tasks carry) makes the tasks array
  // non-uniform, which costs TOON its compact tabular form for ~3x the
  // tokens per task. Jobs with no DAG at all pay nothing for it.
  const tasks = (settings.tasks ?? []).map((task) => ({
    task_key: task.task_key,
    type: taskType(task),
    depends_on: (task.depends_on ?? [])
      .map((d) => d.task_key)
      .filter((k): k is string => k != null)
      .join("|"),
  }));
  out.tasks = tasks.some((task) => task.depends_on)
    ? tasks
    : tasks.map(({ depends_on: _drop, ...rest }) => rest);
  const p = profileSuffix(flags.get("profile"));
  out.help = [
    `databricks-axi jobs run ${jobId}${p}`,
    `databricks-axi jobs runs ${jobId}${p}`,
  ];
  return out;
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
  const { positional, flags } = parseArgs(args, TOTAL_LIST_FLAGS);
  const limit = parseIntFlag(flags, "limit", 20);
  const counted = totalMode(flags, limit);
  const argv = ["jobs", "list-runs", "--limit", String(counted.fetch)];
  let jobId: string | undefined;
  if (positional.length > 0) {
    jobId = requireId(positional, "jobs runs [job_id]");
    argv.push("--job-id", jobId);
  }
  const parsed = await runJobs(argv, spawnOpts(flags));
  const runs = asList(parsed, "runs") as RawRun[];
  // Spread-raw then override with the derived display fields, so --fields
  // can select both raw upstream keys and the computed columns the default
  // view shows (the warehouseSize/jobs-list `name` precedent).
  const flattened = runs.map((r) => ({
    ...r,
    state: compactState(r),
    start_time: iso(r.start_time),
    duration_s: durationSeconds(r),
  }));
  // In bulk mode (no job_id filter) lead with job_id so runs map back to
  // their jobs in one call — cross-job questions ("which jobs never ran")
  // otherwise force an N+1 walk. When filtered to one job it is redundant.
  const defaultFields = jobId
    ? ["run_id", "state", "start_time", "duration_s"]
    : ["job_id", "run_id", "state", "start_time", "duration_s"];
  const rows = renderRows(flattened, flags, defaultFields);
  const p = profileSuffix(flags.get("profile"));
  const help = [`databricks-axi jobs runs view <run_id>${p}`];
  // Search only the rows actually displayed (the --limit-sliced page), not
  // the full ceiling fetch — a match beyond the display page is a run the
  // agent never saw, so suggesting it as a follow-up would dangle.
  const firstFailed = runs.slice(0, limit).find(isFailed);
  if (firstFailed) {
    help.unshift(`databricks-axi jobs logs ${firstFailed.run_id}${p}`);
  }
  return listResult("runs", rows, limit, {
    rerun: `databricks-axi jobs runs${jobId ? ` ${jobId}` : ""} ${counted.rerun(rows.length)}${p}`,
    empty: {
      status: "no runs found",
      help: [`databricks-axi jobs run <job_id>${p}`],
    },
    help,
    total: counted.total,
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

const RUNS_SUMMARY_DEFAULT_WINDOW = 50;
const RUNS_SUMMARY_CEILING = 200;

/** Audit rollup: state tallies over a bounded window of recent runs plus
 * the most recent failing run/task/error — fixes the find-failed-run
 * five-hop hunt (list -> pick -> runs view -> logs) into one call. Costs a
 * small constant number of upstream calls regardless of window size or
 * failure count: one `list-runs` for the window, one `get-run` to resolve
 * the first failing task, one `get-run-output` for its redacted error —
 * never a walk over every failing run. */
// No --fields here: the output is a hand-built rollup, not a rows array —
// unlike LIST_FLAGS' other consumers, --fields has nothing to select
// among, so it's left off the spec rather than silently accepted and
// ignored (AGENTS.md: fail loud on unknown flags).
const RUNS_SUMMARY_FLAGS = { profile: "value", limit: "value" } as const;

async function runsSummary(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, RUNS_SUMMARY_FLAGS);
  let jobId: string | undefined;
  if (positional.length > 0) {
    jobId = requireId(positional, "jobs runs summary [job_id]");
  }
  const requested = parseIntFlag(flags, "limit", RUNS_SUMMARY_DEFAULT_WINDOW);
  const window = Math.min(requested, RUNS_SUMMARY_CEILING);
  const argv = ["jobs", "list-runs", "--limit", String(window)];
  if (jobId) {
    argv.push("--job-id", jobId);
  }
  const parsed = await runJobs(argv, spawnOpts(flags));
  const runs = asList(parsed, "runs") as RawRun[];
  const p = profileSuffix(flags.get("profile"));

  // Tallies compute the same way whether or not any runs came back (all
  // zero on an empty window) — one code path, branching only on status/
  // first_failed below, not a duplicated empty-state block.
  let success = 0;
  // Genuine failures only — this is a reported audit number, so a window of
  // user-cancelled runs must not read as `failed: N`.
  let failed = 0;
  // Terminal but neither: canceled, timed out, or skipped.
  let other = 0;
  for (const run of runs) {
    if (run.state?.result_state === "SUCCESS") {
      success++;
    } else if (isGenuineFailure(run)) {
      failed++;
    } else if (typeof run.state?.result_state === "string") {
      other++;
    }
  }
  // Remainder: no terminal result_state yet — covers actively RUNNING plus
  // PENDING/QUEUED/BLOCKED, not just "running" in the literal sense.
  const running = runs.length - success - failed - other;
  // A full window means the tallies only cover the newest `window` runs —
  // `failed: 0` there is not an authoritative "nothing ever failed". True
  // at the ceiling and at any smaller --limit alike.
  const full = runs.length >= window;

  const out: AxiStructuredOutput = {};
  if (jobId) {
    out.job_id = jobId;
  }
  out.window = runs.length;
  out.success = success;
  out.failed = failed;
  out.other = other;
  out.running = running;
  if (full) {
    out.truncated =
      window >= RUNS_SUMMARY_CEILING
        ? `tallies cover the newest ${window} runs; more runs may exist beyond the ${RUNS_SUMMARY_CEILING}-run window ceiling`
        : `tallies cover the newest ${window} runs; more runs may exist — rerun with a bigger --limit (max ${RUNS_SUMMARY_CEILING})`;
  }

  if (runs.length === 0) {
    out.status = "no runs found";
    out.help = [`databricks-axi jobs run <job_id>${p}`];
    return out;
  }

  const help: string[] = [];
  // Most recent failing run — list-runs returns newest-first, same
  // assumption runsList already makes for its own first-failed suggestion.
  const firstFailedRun = runs.find(isGenuineFailure);
  if (firstFailedRun) {
    try {
      const runDetail = (await runJobsObject(
        ["jobs", "get-run", String(firstFailedRun.run_id)],
        spawnOpts(flags),
      )) as RawRun;
      const failedTask = (runDetail.tasks ?? []).find(isGenuineFailure);
      let error = "";
      if (failedTask?.run_id != null) {
        try {
          const output = (await runJobsObject(
            ["jobs", "get-run-output", String(failedTask.run_id)],
            spawnOpts(flags),
          )) as RawRunOutput;
          if (output.error) {
            error = redactSecrets(output.error).split("\n")[0] ?? "";
          }
        } catch {
          // Best-effort detail fetch — the rollup still reports the failing
          // run/task without a specific error line rather than sinking the
          // whole summary over one output fetch.
        }
      }
      // Only the keys actually resolved: a run that never started its
      // tasks would otherwise emit an empty task_key/error slot carrying
      // nothing the `jobs logs <run_id>` suggestion doesn't already imply.
      const firstFailed: AxiStructuredOutput = {
        run_id: firstFailedRun.run_id,
      };
      if (failedTask?.task_key) {
        firstFailed.task_key = failedTask.task_key;
      }
      if (error) {
        firstFailed.error = error;
      }
      out.first_failed = firstFailed;
      help.push(`databricks-axi jobs logs ${firstFailedRun.run_id}${p}`);
    } catch {
      // Best-effort, same as the get-run-output call above: a transient
      // get-run failure shouldn't throw away the tallies already computed —
      // the rollup just omits first_failed, same shape as the no-failures
      // case below.
    }
  }
  help.push(`databricks-axi jobs runs${jobId ? ` ${jobId}` : ""}${p}`);
  out.help = help;
  return out;
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

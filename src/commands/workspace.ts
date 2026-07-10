import { AxiError } from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";
import { truncate } from "../truncate.js";
import {
  asList,
  assertObject,
  domainHelpers,
  looksBinary,
  parentPath,
  profileSuffix,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs, parseIntFlag, requireId, renderRows } =
  domainHelpers("workspace");

export const WORKSPACE_HELP = `usage: databricks-axi workspace <subcommand> [args] [flags]
subcommands[2]:
  ls [path] [--limit N] [--fields a,b]
  view <path> [--full]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi workspace ls
  databricks-axi workspace view /Shared/axi-bench-etl-daily
notes:
  ls defaults to the workspace root /
  view head-truncates at 200 lines — rerun with --full
  directories exported via view render as a note, not file content — use workspace ls <path>
  read-only: no import/mkdirs/rm — use bundles or the workspace UI to edit
`;

const DEFAULT_LIST_LIMIT = 30;
const HEAD_LINES = 200;

type RawObject = {
  path?: string;
  object_type?: string;
  language?: string;
} & Record<string, unknown>;

type RawExport = { content?: string; file_type?: string };

const LANGUAGE_BY_EXT: Record<string, string> = {
  py: "PYTHON",
  sql: "SQL",
  scala: "SCALA",
  r: "R",
};

export async function workspaceCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "ls":
      return workspaceList(rest);
    case "view":
      return workspaceView(rest);
    default:
      throw usage(
        sub
          ? `Unknown workspace subcommand: ${sub}`
          : "workspace requires a subcommand",
      );
  }
}

// --- subcommands ---

const LIST_FLAGS = {
  profile: "value",
  limit: "value",
  fields: "value",
} as const;

async function workspaceList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  if (positional.length > 1) {
    throw usage(
      `workspace ls takes at most one argument, got: ${positional[1]}`,
    );
  }
  const rawPath = positional[0];
  if (rawPath !== undefined && rawPath.startsWith("-")) {
    throw usage(`Usage: databricks-axi workspace ls [path]`);
  }
  const path = rawPath ?? "/";
  const limit = parseIntFlag(flags, "limit", DEFAULT_LIST_LIMIT);
  const p = profileSuffix(flags.get("profile"));
  const parsed = await runWorkspace(
    ["workspace", "list", path, "--limit", String(limit)],
    spawnOpts(flags),
    [`databricks-axi workspace ls${p}`],
  );
  const items = asList(parsed, "objects") as RawObject[];
  const rows = renderRows(items, flags, ["path", "object_type", "language"]);
  if (rows.length === 0) {
    return { objects: [], status: "directory is empty" };
  }
  const help: string[] = [];
  const notebook = items.find((o) => o.object_type === "NOTEBOOK");
  if (notebook?.path) {
    help.push(`databricks-axi workspace view ${notebook.path}${p}`);
  }
  const dir = items.find((o) => o.object_type === "DIRECTORY");
  if (dir?.path) {
    help.push(`databricks-axi workspace ls ${dir.path}${p}`);
  }
  const out: AxiStructuredOutput = { objects: rows, count: rows.length };
  // CLI >= 0.298 caps results client-side at --limit; a full page means
  // there may be more.
  if (rows.length >= limit) {
    out.has_more = true;
    help.unshift(
      `databricks-axi workspace ls ${path} --limit ${limit * 2}${p}`,
    );
  }
  out.help = help;
  return out;
}

async function workspaceView(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const path = requireId(positional, "workspace view <path>", /^[^-]/);
  const full = flags.get("full") === true;
  const p = profileSuffix(flags.get("profile"));
  const parent = parentPath(path);
  const obj = assertObject<RawExport>(
    await runWorkspace(
      ["workspace", "export", path, "--format", "SOURCE"],
      spawnOpts(flags),
      [`databricks-axi workspace ls ${parent}${p}`],
    ),
    "workspace export",
  );
  const buf = Buffer.from(obj.content ?? "", "base64");
  const size = buf.length;
  // Directory paths export as a ZIP archive (upstream supports DBC/SOURCE/
  // AUTO on dirs); the local-magic-number check is cheaper than a
  // get-status pre-flight for the common (file) case.
  if (buf.subarray(0, 2).toString("latin1") === "PK") {
    return {
      path,
      size,
      content: `<directory archive — use workspace ls ${path}${p}>`,
      help: [`databricks-axi workspace ls ${path}${p}`],
    };
  }
  const text = buf.toString("utf8");
  if (looksBinary(text)) {
    return { path, size, content: `<binary, ${size} bytes — not rendered>` };
  }
  const t = full
    ? { text, truncated: false, totalLines: text.split("\n").length }
    : truncate(text, { lines: HEAD_LINES, mode: "head" });
  const out: AxiStructuredOutput = {
    path,
    language: languageFromFileType(obj.file_type),
    size,
    content: t.text,
  };
  if (t.truncated) {
    out.truncated = `showing first ${HEAD_LINES} of ${t.totalLines} lines — rerun with --full`;
  }
  out.help = [`databricks-axi workspace ls ${parent}${p}`];
  return out;
}

function languageFromFileType(fileType: string | undefined): string {
  if (!fileType) {
    return "";
  }
  return LANGUAGE_BY_EXT[fileType.toLowerCase()] ?? fileType.toUpperCase();
}

/** runDatabricks, with workspace-flavored suggestions folded into NOT_FOUND. */
async function runWorkspace(
  args: string[],
  opts: RunDatabricksOptions,
  notFoundHelp: string[],
): Promise<unknown> {
  try {
    return await runDatabricks(args, opts);
  } catch (error) {
    if (
      error instanceof AxiError &&
      error.code === "NOT_FOUND" &&
      error.suggestions.length === 0
    ) {
      throw new AxiError(error.message, "NOT_FOUND", notFoundHelp);
    }
    throw error;
  }
}

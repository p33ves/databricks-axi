import { MAX_VIEW_CHARS, truncate } from "../truncate.js";
import {
  asList,
  domainHelpers,
  LIST_FLAGS,
  looksBinary,
  parentPath,
  profileSuffix,
  runWithNotFoundHelp,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs, parseIntFlag, requireId, renderRows } =
  domainHelpers("fs");

export const FS_HELP = `usage: databricks-axi fs <subcommand> [args] [flags]
subcommands[2]:
  ls <path> [--limit N] [--fields a,b]
  cat <path> [--full]
flags:
  --profile <name>  databricks auth profile passthrough
examples:
  databricks-axi fs ls dbfs:/Volumes/workspace/default/my_volume
  databricks-axi fs cat dbfs:/Volumes/workspace/default/my_volume/notes.txt
notes:
  bare absolute paths (/Volumes/..., /databricks-datasets/...) get dbfs: prepended automatically
  cat head-truncates at 200 lines — rerun with --full; binary files render a byte-count note instead
  read-only: no import/mkdirs/rm/cp — use the workspace UI or bundles to write
`;

const DEFAULT_LIST_LIMIT = 100;
const HEAD_LINES = 200;

type RawEntry = {
  name?: string;
  is_directory?: boolean;
  size?: number;
} & Record<string, unknown>;

// A bare absolute path (no scheme) reads the *local* filesystem upstream —
// prepend dbfs: so agents never get surprised by their own machine's files.
function withScheme(path: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) {
    return path;
  }
  return path.startsWith("/") ? `dbfs:${path}` : path;
}

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)(\/.*)$/;

/** parentPath, scheme-aware: dbfs:/nope -> dbfs:/ (not the bare "dbfs:"
 * that plain string-splitting on "/" would produce for scheme roots). */
function parentDbfsDir(scopedPath: string): string {
  const match = SCHEME_RE.exec(scopedPath);
  if (!match) {
    return parentPath(scopedPath);
  }
  return match[1] + parentPath(match[2]);
}

export function humanSize(bytes: unknown): string {
  const n = typeof bytes === "number" ? bytes : Number(bytes);
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${n}B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)}${units[i]}`;
}

export async function fsCommand(args: string[]): Promise<AxiRenderable> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "ls":
      return fsList(rest);
    case "cat":
      return fsCat(rest);
    default:
      throw usage(
        sub ? `Unknown fs subcommand: ${sub}` : "fs requires a subcommand",
      );
  }
}

// --- subcommands ---

async function fsList(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, LIST_FLAGS);
  const path = requireId(positional, "fs ls <path>", /^[^-]/);
  const limit = parseIntFlag(flags, "limit", DEFAULT_LIST_LIMIT);
  const scoped = withScheme(path);
  const p = profileSuffix(flags.get("profile"));
  // No upstream --limit on the fs group (and no pagination at all) — it
  // returns everything in one shot, so the cap is purely client-side.
  const parsed = await runWithNotFoundHelp(
    ["fs", "ls", scoped, "--absolute", "-l"],
    spawnOpts(flags),
    [`databricks-axi fs ls ${parentDbfsDir(scoped)}${p}`],
  );
  const items = asList(parsed, "files") as RawEntry[];
  const total = items.length;
  const limited = items.slice(0, limit);
  if (limited.length === 0) {
    return {
      entries: [],
      status: `${path} is empty`,
      help: [`databricks-axi fs ls ${parentDbfsDir(scoped)}${p}`],
    };
  }
  // Human-readable size is a formatting transform on the flattened items,
  // applied before renderRows so --fields size also picks up "1.2MB" (no
  // separate raw-byte field — add one if a caller ever needs exact bytes).
  const flattened = limited.map((item) => ({
    ...item,
    size: humanSize(item.size),
  }));
  const rows = renderRows(flattened, flags, ["name", "is_directory", "size"]);
  const help: string[] = [];
  const file = limited.find((i) => i.is_directory === false);
  if (file?.name) {
    help.push(`databricks-axi fs cat ${file.name}${p}`);
  }
  const dir = limited.find((i) => i.is_directory === true);
  if (dir?.name) {
    help.push(`databricks-axi fs ls ${dir.name}${p}`);
  }
  const out: AxiStructuredOutput = { entries: rows, count: rows.length };
  if (total > limit) {
    out.truncated = `showing ${limit} of ${total} entries — rerun with --limit ${total}`;
    help.unshift(`databricks-axi fs ls ${path} --limit ${total}${p}`);
  }
  out.help = help;
  return out;
}

async function fsCat(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    profile: "value",
    full: "boolean",
  });
  const path = requireId(positional, "fs cat <path>", /^[^-]/);
  const full = flags.get("full") === true;
  const scoped = withScheme(path);
  const p = profileSuffix(flags.get("profile"));
  const text = (await runWithNotFoundHelp(
    ["fs", "cat", scoped],
    { ...spawnOpts(flags), raw: true },
    [`databricks-axi fs ls ${parentDbfsDir(scoped)}${p}`],
  )) as string;
  // ponytail: byte size is derived from the decoded text, re-encoded — exact
  // for text files, approximate for binary ones (which we don't render
  // anyway, so the count is informational only).
  const size = Buffer.byteLength(text, "utf8");
  const help = [`databricks-axi fs ls ${parentDbfsDir(scoped)}${p}`];
  if (looksBinary(text)) {
    return {
      path,
      size,
      content: `<binary, ${size} bytes — not rendered>`,
      help,
    };
  }
  const t = truncate(text, {
    lines: full ? Infinity : HEAD_LINES,
    mode: "head",
    maxChars: full ? Infinity : MAX_VIEW_CHARS,
  });
  const out: AxiStructuredOutput = { path, size, content: t.text };
  if (t.truncated) {
    out.truncated = t.clipped
      ? `content clipped at ${MAX_VIEW_CHARS} chars — rerun with --full`
      : `showing first ${HEAD_LINES} of ${t.totalLines} lines — rerun with --full`;
  }
  out.help = help;
  return out;
}

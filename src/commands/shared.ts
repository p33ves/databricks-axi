import { parseArgs as nodeParseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";

// axi-sdk-js 0.1.8 doesn't re-export its output types from the package
// index; mirror the two one-line aliases locally until it does.
export type AxiStructuredOutput = Record<string, unknown>;
export type AxiRenderable = string | AxiStructuredOutput;

export type FlagSpec = Record<string, "value" | "boolean">;
export type Flags = Map<string, string | boolean>;

export function spawnOpts(flags: Flags): RunDatabricksOptions {
  const profile = flags.get("profile");
  return typeof profile === "string" ? { profile } : {};
}

/** Suffix for suggested follow-up commands so they hit the same workspace. */
export function profileSuffix(profile: unknown): string {
  return typeof profile === "string" ? ` --profile ${profile}` : "";
}

/** Guard for endpoints whose result gets dereferenced — empty stdout (null)
 * becomes a structured UPSTREAM_ERROR instead of a raw TypeError. */
export function assertObject<T>(parsed: unknown, label: string): T {
  if (parsed === null || typeof parsed !== "object") {
    throw new AxiError(
      `${label} returned an empty response`,
      "UPSTREAM_ERROR",
      ["Retry, or check workspace availability"],
    );
  }
  return parsed as T;
}

/**
 * The Go CLI prints either a bare item array (>= 0.298) or the response
 * object ({items, ...}) depending on version — tolerate both.
 */
export function asList(parsed: unknown, key: string): AxiStructuredOutput[] {
  if (Array.isArray(parsed)) {
    return parsed as AxiStructuredOutput[];
  }
  const obj = (parsed ?? {}) as AxiStructuredOutput;
  return (obj[key] as AxiStructuredOutput[] | undefined) ?? [];
}

/** Parent directory of a slash-separated workspace/dbfs path ("/" at the root). */
export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

/**
 * True if decoded text looks like it isn't actually text: Node's UTF-8
 * decoder swaps invalid byte sequences for U+FFFD, and NUL bytes are a
 * reliable binary tell that survive decoding untouched either way.
 */
export function looksBinary(text: string): boolean {
  return text.includes("\uFFFD") || text.includes("\u0000");
}

/** Shared list-result tail: empty state, count envelope, and the
 * full-page has_more + rerun-with-double-limit suggestion. */
export function listResult(
  key: string,
  rows: AxiStructuredOutput[],
  limit: number,
  rerunCmd: string,
  empty: { status: string; help: string[] },
  help: string[],
): AxiRenderable {
  if (rows.length === 0) {
    return { [key]: [], status: empty.status, help: empty.help };
  }
  const allHelp = [...help];
  const out: AxiStructuredOutput = { [key]: rows, count: rows.length };
  // CLI >= 0.298 caps results client-side at --limit; a full page means
  // there may be more.
  if (rows.length >= limit) {
    out.has_more = true;
    allHelp.unshift(rerunCmd);
  }
  out.help = allHelp;
  return out;
}

/** runDatabricks, folding domain-flavored suggestions into bare NOT_FOUND. */
export async function runWithNotFoundHelp(
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

/** Helpers whose usage errors point at `databricks-axi <domain> --help`. */
export function domainHelpers(domain: string) {
  const usage = (message: string, extraHelp: string[] = []): AxiError =>
    new AxiError(message, "VALIDATION_ERROR", [
      ...extraHelp,
      `Run \`databricks-axi ${domain} --help\``,
    ]);

  const parseArgs = (
    args: string[],
    spec: FlagSpec,
  ): { positional: string[]; flags: Flags } => {
    const options = Object.fromEntries(
      Object.entries(spec).map(([name, kind]) => [
        name,
        { type: kind === "value" ? ("string" as const) : ("boolean" as const) },
      ]),
    );
    try {
      const { values, positionals } = nodeParseArgs({
        args,
        options,
        strict: true,
        allowPositionals: true,
      });
      return {
        positional: positionals,
        flags: new Map(Object.entries(values) as [string, string | boolean][]),
      };
    } catch (error) {
      const valid = Object.keys(spec)
        .map((f) => `--${f}`)
        .join(", ");
      // First sentence only — node appends a long "--" placement hint,
      // sometimes as extra lines (e.g. the ambiguous-option error).
      const message = (error as Error).message.split("\n")[0].split(". ")[0];
      throw usage(message, [`Valid flags: ${valid}`]);
    }
  };

  const parseIntFlag = (
    flags: Flags,
    name: string,
    fallback: number,
    min = 1,
  ): number => {
    const raw = flags.get(name);
    if (raw === undefined) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      const kind = min === 0 ? "non-negative" : "positive";
      throw usage(`--${name} must be a ${kind} integer, got: ${String(raw)}`);
    }
    return value;
  };

  const requireId = (
    positional: string[],
    usageText: string,
    pattern?: RegExp,
  ): string => {
    const id = positional[0];
    if (!id || positional.length > 1 || (pattern && !pattern.test(id))) {
      throw usage(`Usage: databricks-axi ${usageText}`);
    }
    return id;
  };

  /** Apply --fields (raw top-level keys) or the default field list. */
  const renderRows = (
    items: AxiStructuredOutput[],
    flags: Flags,
    defaults: string[],
  ): AxiStructuredOutput[] => {
    const spec = flags.get("fields");
    const fields =
      typeof spec === "string"
        ? spec
            .split(",")
            .map((f) => f.trim())
            .filter(Boolean)
        : defaults;
    if (typeof spec === "string" && items.length > 0) {
      const known = new Set(items.flatMap((item) => Object.keys(item)));
      for (const field of fields) {
        if (!known.has(field)) {
          throw usage(`Unknown field: ${field}`, [
            `Available fields: ${[...known].sort().join(", ")}`,
          ]);
        }
      }
    }
    return items.map((item) =>
      Object.fromEntries(fields.map((field) => [field, item[field] ?? ""])),
    );
  };

  return { usage, parseArgs, parseIntFlag, requireId, renderRows };
}

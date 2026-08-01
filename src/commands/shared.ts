import { parseArgs as nodeParseArgs } from "node:util";
import { AxiError } from "axi-sdk-js";
import { runDatabricks, type RunDatabricksOptions } from "../databricks.js";
import { MAX_VIEW_CHARS, truncate } from "../truncate.js";

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

/** Shared by jobs.ts and context.ts's home-panel run rendering. */
export type RunState = { result_state?: string; life_cycle_state?: string };

export function compactState(item: { state?: RunState }): string {
  return item.state?.result_state ?? item.state?.life_cycle_state ?? "UNKNOWN";
}

/** Terminal and not clean success (FAILED, TIMEDOUT, CANCELED, ...). */
export function isFailed(item: { state?: RunState }): boolean {
  const result = item.state?.result_state;
  return typeof result === "string" && result !== "SUCCESS";
}

/** Terminal result states that aren't a genuine failure: cancellations
 * (user or upstream), timeouts, and condition-skipped runs. */
const NOT_FAILURE_STATES = new Set([
  "SUCCESS",
  "CANCELED",
  "TIMEDOUT",
  "EXCLUDED",
  "UPSTREAM_CANCELED",
]);

/** Terminal and actually broken (FAILED, UPSTREAM_FAILED, ...) — the
 * narrower predicate for reported audit numbers, where a cancelled run
 * counted as a failure is a wrong answer, not just a wide suggestion. */
export function isGenuineFailure(item: { state?: RunState }): boolean {
  const result = item.state?.result_state;
  return typeof result === "string" && !NOT_FAILURE_STATES.has(result);
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

const HEAD_LINES = 200;

export type FileContentResult = { content: string; truncated?: string };

/** Binary check + head-truncate for exported/read file content — shared by
 * workspace view and fs cat. `size` is caller-computed (the two callers use
 * different byte-count sources) and only used for the binary-sentinel text. */
export function renderFileContent(
  text: string,
  size: number,
  full: boolean,
): FileContentResult {
  if (looksBinary(text)) {
    return { content: `<binary, ${size} bytes — not rendered>` };
  }
  const t = truncate(text, {
    lines: full ? Infinity : HEAD_LINES,
    mode: "head",
    maxChars: full ? Infinity : MAX_VIEW_CHARS,
  });
  const result: FileContentResult = { content: t.text };
  if (t.truncated) {
    result.truncated = t.clipped
      ? `content clipped at ${MAX_VIEW_CHARS} chars — rerun with --full`
      : `showing first ${HEAD_LINES} of ${t.totalLines} lines — rerun with --full`;
  }
  return result;
}

/** --wait budget for async start/stop/run mutations; upstream blocks up to
 * 20 min. Shared by jobs, clusters, sql (warehouses start/stop). */
export const WAIT_TIMEOUT_MS = 25 * 60_000;

/** The flag spec every list-shaped subcommand shares. */
export const LIST_FLAGS = {
  profile: "value",
  limit: "value",
  fields: "value",
} as const;

/** LIST_FLAGS plus the opt-in `--total` for the surfaces that can drain a
 * bounded fetch and report an exact count (see `totalMode`). */
export const TOTAL_LIST_FLAGS = {
  ...LIST_FLAGS,
  total: "boolean",
} as const;

/** Internal fetch ceiling for the opt-in `--total` on the cheaply-countable
 * list surfaces (jobs list/runs, catalog catalogs/schemas/tables/volumes/
 * functions, clusters list, serving list). All nine take `--limit` as a
 * client-side cap over an auto-drained page iterator, not as a server page
 * size: their `--limit` carries the same generated "Maximum number of
 * results to return" help text (API-field flags keep their API wording),
 * the server page size is a separate flag where one exists (`clusters list
 * --page-size`, `volumes list --max-results`; `tables list` has no such
 * flag), and none takes `--page-token` (pinned against CLI v1.6.0). So
 * `--total` fetches this many rows upstream regardless of the agent's own
 * `--limit` (which then caps DISPLAY only) and `listResult` can report a
 * true `total` instead of the rows-shown heuristic. Bounded, not unbounded
 * auto-pagination (AGENTS.md sharp edge).
 * ponytail: 1000 ceiling, raise if a real workspace clips it. */
export const TOTAL_FETCH_CEILING = 1000;

/** `--limit` to suggest for a rerun in total mode. The full fetch is
 * already in hand, so grow the page geometrically and stop at the true
 * count instead of guessing at a doubled limit. */
export function nextLimit(limit: number, total: number): number {
  return Math.min(total, limit * 4);
}

/** Opt-in exact totals. `--total` trades upstream round trips (the fetch
 * drains up to TOTAL_FETCH_CEILING rows through the client-side `--limit`
 * cap) for a precise `total`; without it a list fetches exactly one
 * `--limit` page and falls back to the full-page `has_more` heuristic. The
 * drain is never implicit: an agent asking for 5 rows gets one page. */
export function totalMode(
  flags: Flags,
  limit: number,
): {
  total: boolean;
  fetch: number;
  rerun: (fetched: number) => string;
} {
  const total = flags.get("total") === true;
  return {
    total,
    fetch: total ? TOTAL_FETCH_CEILING : limit,
    // In total mode the true count is known, so the suggestion is bounded
    // by it (and keeps --total, or the rerun would silently drop back to
    // the heuristic); otherwise it's the legacy blind doubling.
    rerun: (fetched: number) =>
      total
        ? `--limit ${nextLimit(limit, fetched)} --total`
        : `--limit ${limit * 2}`,
  };
}

/** Shared list-result tail: empty state, count envelope, and either the
 * legacy full-page has_more heuristic or (opts.total) a precise `total`
 * sliced from a ceiling-bounded fetch. */
export function listResult(
  key: string,
  rows: AxiStructuredOutput[],
  limit: number,
  opts: {
    /** Rerun-with-a-bigger---limit suggestion, prepended when there's more
     * to see. Both modes build it from `totalMode(flags, limit).rerun`:
     * a doubled limit when the true count isn't known, otherwise a
     * geometrically bigger page bounded by that count. listResult only uses
     * it when the page is short of what was fetched. */
    rerun: string;
    empty: { status: string; help: string[] };
    help: string[];
    /** True when the caller opted into `--total`: `rows` is the FULL
     * ceiling-bounded fetch (up to TOTAL_FETCH_CEILING), not a display page
     * — listResult slices to `limit` itself and reports the true row count
     * as `total` instead of `count`-equals-rows-shown. */
    total?: boolean;
  },
): AxiRenderable {
  if (rows.length === 0) {
    return { [key]: [], status: opts.empty.status, help: opts.empty.help };
  }
  const allHelp = [...opts.help];
  if (opts.total) {
    const hitCeiling = rows.length >= TOTAL_FETCH_CEILING;
    const sliced = rows.slice(0, limit);
    // `total` stays numeric even at the ceiling — a consumer comparing or
    // summing it shouldn't get a string in the one case that matters; the
    // `truncated` note below carries "may be higher".
    const out: AxiStructuredOutput = {
      [key]: sliced,
      count: sliced.length,
      total: rows.length,
    };
    if (sliced.length < rows.length) {
      // A bigger --limit (up to rows.length, already fetched) shows more —
      // opts.rerun names a nextLimit-bounded step toward that count.
      out.has_more = true;
      allHelp.unshift(opts.rerun);
    } else if (hitCeiling) {
      // Already displaying everything the ceiling fetch got; a bigger
      // --limit can't get past the pinned TOTAL_FETCH_CEILING fetch, so
      // there's no rerun suggestion to make — the `truncated` note below
      // is the only signal that more may exist.
      out.has_more = true;
    }
    if (hitCeiling) {
      out.truncated = `stopped counting at the ${TOTAL_FETCH_CEILING}-row fetch ceiling; true total may be higher`;
    }
    out.help = allHelp;
    return out;
  }
  const out: AxiStructuredOutput = { [key]: rows, count: rows.length };
  // CLI >= 0.298 caps results client-side at --limit; a full page means
  // there may be more.
  if (rows.length >= limit) {
    out.has_more = true;
    allHelp.unshift(opts.rerun);
  }
  out.help = allHelp;
  return out;
}

/** Fold a bare NOT_FOUND (no domain suggestions yet) into a domain-flavored
 * one. Shared by runWithNotFoundHelp and callers that go through
 * runDatabricksApi instead of runDatabricks (e.g. sql statement view). */
export async function foldNotFoundHelp<T>(
  promise: Promise<T>,
  notFoundHelp: string[],
): Promise<T> {
  try {
    return await promise;
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

/** runDatabricks, folding domain-flavored suggestions into bare NOT_FOUND. */
export function runWithNotFoundHelp(
  args: string[],
  opts: RunDatabricksOptions,
  notFoundHelp: string[],
): Promise<unknown> {
  return foldNotFoundHelp(runDatabricks(args, opts), notFoundHelp);
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
    // Decimal digits only — Number() alone would accept "1e3"/"0x1F4".
    const value =
      typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
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

type TruncateMode = "head" | "tail";

type TruncateResult = {
  text: string;
  truncated: boolean;
  totalLines: number;
  /** True when the char clamp (not the line limit) did the cutting. */
  clipped: boolean;
};

/** Line limits don't bound minified one-liners; the char clamp does. */
export const MAX_VIEW_CHARS = 100_000;

/**
 * Line-based truncation shared by workspace view, fs cat, and jobs logs.
 * `head` keeps
 * the first N lines (notebooks: imports/markdown preamble is what
 * summarization needs); `tail` keeps the last N (logs: the failure is at
 * the end). Exact-boundary input (totalLines === lines) is never marked
 * truncated, and a trailing newline doesn't count as an extra line. The
 * kept slice is further clamped to `maxChars` (default unbounded) so
 * low-newline content can't flood the caller anyway.
 */
export function truncate(
  text: string,
  opts: { lines: number; mode: TruncateMode; maxChars?: number },
): TruncateResult {
  const all = text.split("\n");
  if (all.length > 1 && all[all.length - 1] === "") {
    all.pop();
  }
  const totalLines = all.length;
  let out = text;
  let truncated = false;
  let clipped = false;
  if (totalLines > opts.lines) {
    const slice =
      opts.mode === "head" ? all.slice(0, opts.lines) : all.slice(-opts.lines);
    out = slice.join("\n");
    truncated = true;
  }
  const maxChars = opts.maxChars ?? Infinity;
  if (out.length > maxChars) {
    out = opts.mode === "head" ? out.slice(0, maxChars) : out.slice(-maxChars);
    truncated = true;
    clipped = true;
  }
  return { text: out, truncated, totalLines, clipped };
}

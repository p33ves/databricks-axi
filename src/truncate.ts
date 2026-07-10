export type TruncateMode = "head" | "tail";

export type TruncateResult = {
  text: string;
  truncated: boolean;
  totalLines: number;
};

/**
 * Line-based truncation shared by workspace view and fs cat. `head` keeps
 * the first N lines (notebooks: imports/markdown preamble is what
 * summarization needs); `tail` keeps the last N (logs: the failure is at
 * the end). Exact-boundary input (totalLines === lines) is never marked
 * truncated.
 */
export function truncate(
  text: string,
  opts: { lines: number; mode: TruncateMode },
): TruncateResult {
  const all = text.split("\n");
  const totalLines = all.length;
  if (totalLines <= opts.lines) {
    return { text, truncated: false, totalLines };
  }
  const slice =
    opts.mode === "head" ? all.slice(0, opts.lines) : all.slice(-opts.lines);
  return { text: slice.join("\n"), truncated: true, totalLines };
}

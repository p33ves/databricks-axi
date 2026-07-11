import { AxiError } from "axi-sdk-js";

const AUTH_HELP = [
  "Ask the user to run: databricks auth login --host <workspace-url>",
];

/**
 * Strip token-shaped strings from upstream text before it can reach stdout.
 * Order matters: dapi tokens first (they are also long hex).
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/dapi[0-9a-f]{16,}/gi, "[redacted]")
    .replace(/dkea[A-Za-z0-9_-]{8,}/gi, "[redacted]") // OAuth tokens — no \b: it doesn't match after a preceding _, letting the whole token through unredacted
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9+=_-]{40,}\b/g, "[redacted]"); // no "/" so workspace paths stay readable
}

/**
 * Pattern-match the Go CLI's plain-text stderr into the AXI taxonomy.
 * Returns (never throws) so callers decide whether to throw or inspect.
 */
export function mapUpstreamError(stderr: string): AxiError {
  // Some CLI errors carry a "Profile:/Host:/Auth type:" trailer whose
  // "OAuth (...)" line would trip the AUTH_ERROR branch below on every
  // auth mode — strip it before classification (live-verified shape).
  const withoutTrailer = stderr.replace(/\n\s*Profile:\s[\s\S]*$/, "");
  const text =
    redactSecrets(withoutTrailer.trim()) ||
    "databricks CLI failed with no error output";
  const firstLine = text.split("\n", 1)[0] ?? text;
  if (
    /\b401\b|unauthorized|token.{0,20}expired|cannot configure default credentials|oauth/i.test(
      text,
    )
  ) {
    return new AxiError(firstLine, "AUTH_ERROR", AUTH_HELP);
  }
  if (/Public DBFS root is disabled/i.test(text)) {
    // Platform restriction on Free Edition-style workspaces, not a missing
    // object — steer toward paths that are actually readable.
    return new AxiError(firstLine, "PERMISSION_DENIED", [
      "Public DBFS root access is disabled here — try dbfs:/databricks-datasets or a /Volumes/<catalog>/<schema>/<volume> path instead",
    ]);
  }
  if (/\b403\b|PERMISSION_DENIED/i.test(text)) {
    return new AxiError(firstLine, "PERMISSION_DENIED");
  }
  if (
    /RESOURCE_DOES_NOT_EXIST|\b404\b|does(?: not|n't) exist|\bwas not found\b/i.test(
      text,
    )
  ) {
    return new AxiError(firstLine, "NOT_FOUND");
  }
  if (/INVALID_STATE/.test(text)) {
    return new AxiError(firstLine, "INVALID_STATE");
  }
  return new AxiError(firstLine, "UPSTREAM_ERROR");
}

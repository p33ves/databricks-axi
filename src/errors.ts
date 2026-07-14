import { AxiError } from "axi-sdk-js";

const AUTH_HELP = [
  "Ask the user to run: databricks auth login --host <workspace-url>",
];

// Re-login help for a token that's expired/revoked/invalid, not merely
// unconfigured — the recovery is the same login command, phrased as a
// refresh rather than an initial setup.
const AUTH_HELP_EXPIRED_TOKEN = [
  "The stored token is expired, revoked, or invalid. Ask the user to " +
    "re-authenticate: databricks auth login --host <workspace-url>",
];

// A profile wasn't resolved at all (no default configured, or none named).
// The fix is picking one, not just re-logging in with whatever was tried.
const AUTH_HELP_MISSING_CREDENTIALS = [
  "No default credentials could be resolved. Ask the user which " +
    "Databricks profile to use and pass --profile <name>, or run: " +
    "databricks auth login --host <workspace-url>",
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
    .replace(/\b[A-Za-z0-9+=_-]{40,}\b/g, "[redacted]") // no "/" so workspace paths stay readable
    .replace(/https?:\/\/\S*databricks\S*/gi, "[redacted-host]") // workspace URL inline in an error's first line, not just the stripped Profile:/Host: trailer
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[redacted-email]");
}

/**
 * Pattern-match the Go CLI's plain-text stderr into the AXI taxonomy.
 * Returns (never throws) so callers decide whether to throw or inspect.
 */
export function mapUpstreamError(stderr: string): AxiError {
  // Some CLI errors carry a "Profile:/Host:/Auth type:" trailer whose
  // "OAuth (...)" line would trip the AUTH_ERROR branch below on every
  // auth mode — strip it before classification. Matched as a trailing run
  // of labeled lines in any order, not anchored on "Profile:" first, so an
  // upstream reorder can't smuggle the "Auth type:" line past the strip.
  const withoutTrailer = stderr.replace(
    /(?:\n\s*(?:Profile|Host|Auth type|Username):[^\n]*)+\s*$/,
    "",
  );
  const text =
    redactSecrets(withoutTrailer.trim()) ||
    "databricks CLI failed with no error output";
  const firstLine = text.split("\n", 1)[0] ?? text;
  // Expired/revoked/invalid token: the token was once valid but no longer
  // is - recovery is re-login, not picking a different profile.
  const expiredTokenRe =
    /token.{0,20}(?:expired|revoked|invalid)|(?:expired|revoked|invalid).{0,20}token|invalid_grant/i;
  // No credentials resolved at all (no default profile, none named):
  // recovery is choosing a profile, not just re-running the same login.
  const missingCredentialsRe =
    /cannot configure default credentials|no.{0,20}profile|profile.{0,20}not found/i;
  if (
    expiredTokenRe.test(text) ||
    missingCredentialsRe.test(text) ||
    /\b401\b|unauthorized|oauth/i.test(text)
  ) {
    if (expiredTokenRe.test(text)) {
      return new AxiError(firstLine, "AUTH_ERROR", AUTH_HELP_EXPIRED_TOKEN);
    }
    if (missingCredentialsRe.test(text)) {
      return new AxiError(
        firstLine,
        "AUTH_ERROR",
        AUTH_HELP_MISSING_CREDENTIALS,
      );
    }
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

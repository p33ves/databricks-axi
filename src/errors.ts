import { AxiError } from "axi-sdk-js";

const AUTH_HELP = [
  "Ask the user to run: databricks auth login --host <workspace-url>",
];

const AUTH_HELP_EXPIRED_TOKEN = [
  "The stored token is expired, revoked, or invalid. Ask the user to " +
    "re-authenticate: databricks auth login --host <workspace-url>",
];

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
  // Sub-typed AUTH_ERROR help (deliberately narrow - concrete phrasings
  // over broad gaps, to avoid misrouting a NOT_FOUND/PERMISSION_DENIED
  // error that merely mentions "token"/"profile"/"OAuth"):
  //  - expired/revoked/invalid token: matches "token expired"/"token is
  //    expired"/"token revoked", or "invalid/expired/revoked [access]
  //    token" reversed, or invalid_grant. Requires the failure word directly
  //    adjacent to "token" so "token is not expired" does NOT match (the
  //    "not" breaks the adjacency) - recovery is re-login either way.
  //  - missing credentials: only the literal upstream phrase actually seen
  //    ("cannot configure default credentials") - not a generic "profile"
  //    gap, which would false-positive on e.g. a NOT_FOUND error naming a
  //    resource called "profile-xyz".
  //  - generic 401/unauthorized/oauth: oauth only counts co-occurring with
  //    a failure word, since an unstrippable `Auth type: OAuth (...)`
  //    trailer (trailing content after it defeats the trailer-strip anchor
  //    below) would otherwise misroute an unrelated NOT_FOUND error.
  if (
    /\btoken\s+(?:is\s+|has\s+)?(?:expired|revoked)\b|\b(?:expired|revoked|invalid)\s+(?:access\s+)?token\b|invalid_grant/i.test(
      text,
    )
  ) {
    return new AxiError(firstLine, "AUTH_ERROR", AUTH_HELP_EXPIRED_TOKEN);
  }
  if (/cannot configure default credentials/i.test(text)) {
    return new AxiError(firstLine, "AUTH_ERROR", AUTH_HELP_MISSING_CREDENTIALS);
  }
  if (
    /\b401\b|unauthorized|oauth2?.{0,40}(?:fail|error|invalid|expired|denied|cannot fetch)/i.test(
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
    /RESOURCE_DOES_NOT_EXIST|\b404\b|does(?: not|n't) exist|\bwas not found\b|\bUnable to find (?:published )?dashboard\b|\bCould not find principal\b/i.test(
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

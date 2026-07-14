import { describe, expect, it } from "vitest";
import { mapUpstreamError, redactSecrets } from "../src/errors.js";

describe("redactSecrets", () => {
  it("redacts dapi tokens", () => {
    expect(redactSecrets("token dapi1234567890abcdef leaked")).toBe(
      "token [redacted] leaked",
    );
  });

  it("redacts dkea OAuth tokens too short for the generic rules", () => {
    expect(redactSecrets("token dkeaAbc12345XYZ leaked")).toBe(
      "token [redacted] leaked",
    );
  });

  it("redacts dkea OAuth tokens containing - and _", () => {
    expect(redactSecrets("token dkeaAbc12-XY_890z rejected")).toBe(
      "token [redacted] rejected",
    );
  });

  it("redacts a dkea token immediately preceded by a word character", () => {
    expect(redactSecrets("prefix_dkeaAbc12345XYZ leaked")).toBe(
      "prefix_[redacted] leaked",
    );
  });

  it("redacts long hex runs", () => {
    expect(redactSecrets("id 0123456789abcdef0123456789abcdef end")).toBe(
      "id [redacted] end",
    );
  });

  it("redacts long base64-ish runs", () => {
    expect(
      redactSecrets("bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh done"),
    ).toBe("bearer [redacted] done");
  });

  it("redacts a workspace host URL inline in error text", () => {
    expect(
      redactSecrets(
        "cannot configure default credentials, host=https://dbc-1234abcd-5678.cloud.databricks.com",
      ),
    ).toBe("cannot configure default credentials, host=[redacted-host]");
  });

  it("redacts an account email inline in error text", () => {
    expect(redactSecrets("principal user@example.com lacks permission")).toBe(
      "principal [redacted-email] lacks permission",
    );
  });

  it("keeps long workspace paths readable", () => {
    const text =
      "Notebook /Workspace/Shared/my-long-notebook-name does not exist";
    expect(redactSecrets(text)).toBe(text);
  });

  it("keeps a statement UUID and SQLSTATE readable in a SQL error message", () => {
    // The two identifier shapes sql.ts actually surfaces in SQL_ERROR text:
    // a 36-char statement id (under the 40-char floor) and a 5-char SQLSTATE.
    const text =
      "[42601] Syntax error near 'foo' (statement 01234567-89ab-cdef-0123-456789abcdef)";
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves normal text alone", () => {
    expect(redactSecrets("Error: Job 123 does not exist.")).toBe(
      "Error: Job 123 does not exist.",
    );
  });
});

describe("mapUpstreamError", () => {
  it("classifies past the Profile/Host/Auth-type trailer (live CLI shape)", () => {
    const stderr = [
      "Error: Public DBFS root is disabled. Access is denied on path: /nope-xyz",
      "",
      "Profile:   DEFAULT",
      "Host:      https://example.cloud.databricks.com",
      "Auth type: OAuth (databricks-cli)",
    ].join("\n");
    const err = mapUpstreamError(stderr);
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.suggestions[0]).toContain("databricks-datasets");
  });

  it("strips the trailer even when its lines are reordered", () => {
    const stderr = [
      "Error: Public DBFS root is disabled. Access is denied on path: /nope-xyz",
      "Host:      https://example.cloud.databricks.com",
      "Auth type: OAuth (databricks-cli)",
      "Profile:   DEFAULT",
    ].join("\n");
    const err = mapUpstreamError(stderr);
    // The "Auth type: OAuth" line must never trip the AUTH_ERROR branch.
    expect(err.code).toBe("PERMISSION_DENIED");
  });

  it("maps 401-shaped stderr to AUTH_ERROR with login help", () => {
    const err = mapUpstreamError("Error: failed request: 401 Unauthorized");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions.join(" ")).toContain("databricks auth login");
  });

  it("maps credential-config stderr to AUTH_ERROR", () => {
    const err = mapUpstreamError(
      "Error: cannot configure default credentials, please check ...",
    );
    expect(err.code).toBe("AUTH_ERROR");
  });

  it("gives re-login help for an expired token", () => {
    const err = mapUpstreamError("Error: token expired");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions.join(" ")).toContain("re-authenticate");
    expect(err.suggestions.join(" ")).toContain("databricks auth login");
  });

  it("gives re-login help for a revoked/invalid token", () => {
    const err = mapUpstreamError("Error: invalid access token");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions.join(" ")).toContain("expired, revoked, or invalid");
  });

  it("gives re-login help for an OAuth invalid_grant response", () => {
    const err = mapUpstreamError(
      "Error: oauth2: cannot fetch token: invalid_grant",
    );
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions.join(" ")).toContain("re-authenticate");
  });

  it("gives --profile guidance for missing default credentials", () => {
    const err = mapUpstreamError(
      "Error: cannot configure default credentials, please check ...",
    );
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions.join(" ")).toContain("--profile");
    expect(err.suggestions.join(" ")).not.toContain("re-authenticate");
  });

  it("falls back to the generic auth help for an unqualified 401", () => {
    const err = mapUpstreamError("Error: failed request: 401 Unauthorized");
    expect(err.code).toBe("AUTH_ERROR");
    expect(err.suggestions).toEqual([
      "Ask the user to run: databricks auth login --host <workspace-url>",
    ]);
  });

  it("does not treat a NOT_FOUND error naming a 'profile' resource as AUTH_ERROR", () => {
    const err = mapUpstreamError(
      "Error: cluster policy profile-xyz was not found.",
    );
    expect(err.code).toBe("NOT_FOUND");
  });

  it("does not misroute a NOT_FOUND error behind an unstrippable OAuth trailer", () => {
    // The trailer-strip anchor only fires when the labeled run reaches the
    // end of the string; a trailing non-label line after "Auth type: OAuth"
    // defeats it, so the raw "OAuth (...)" text survives into
    // classification. It must not trip the AUTH_ERROR branch.
    const stderr = [
      "Error: The specified pipeline abc was not found.",
      "",
      "Profile:   DEFAULT",
      "Host:      https://example.cloud.databricks.com",
      "Auth type: OAuth (databricks-cli)",
      "Something else trailing",
    ].join("\n");
    expect(mapUpstreamError(stderr).code).toBe("NOT_FOUND");
  });

  it("does not misroute a NOT_FOUND error whose first line merely mentions OAuth", () => {
    expect(
      mapUpstreamError("Error: OAuth app my-app does not exist").code,
    ).toBe("NOT_FOUND");
  });

  it("does not give expired-token help for a negated 'not expired' phrasing", () => {
    const err = mapUpstreamError("Error: token is not expired");
    // No other auth signal in this text, so it falls through to the
    // existing generic fallback rather than any AUTH_ERROR sub-type.
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("maps 403 to PERMISSION_DENIED", () => {
    expect(mapUpstreamError("Error: 403 Forbidden").code).toBe(
      "PERMISSION_DENIED",
    );
  });

  it("maps RESOURCE_DOES_NOT_EXIST to NOT_FOUND", () => {
    expect(
      mapUpstreamError("Error: RESOURCE_DOES_NOT_EXIST: Job 999 gone").code,
    ).toBe("NOT_FOUND");
  });

  it("maps 'does not exist' to NOT_FOUND", () => {
    expect(mapUpstreamError("Error: Job 999 does not exist.").code).toBe(
      "NOT_FOUND",
    );
  });

  it("maps the workspace CLI's contraction 'doesn't exist' to NOT_FOUND", () => {
    expect(
      mapUpstreamError("Error: Path (/Shared/nope) doesn't exist.").code,
    ).toBe("NOT_FOUND");
  });

  it("maps the pipelines CLI's 'was not found' to NOT_FOUND", () => {
    // Live-pinned pipeline-404 shape (2026-07-11): unlike the other
    // domains' "does not exist", pipelines get uses "was not found" — the
    // matcher must cover both.
    expect(
      mapUpstreamError(
        "Error: The specified pipeline 905299c1-874d-44b6-995b-e6a5d2eb1a84 was not found.",
      ).code,
    ).toBe("NOT_FOUND");
  });

  it("maps the disabled public DBFS root to PERMISSION_DENIED with a path hint", () => {
    const err = mapUpstreamError(
      "Error: Public DBFS root is disabled. Access is denied on path: /foo",
    );
    expect(err.code).toBe("PERMISSION_DENIED");
    expect(err.suggestions.join(" ")).toContain("dbfs:/databricks-datasets");
    expect(err.suggestions.join(" ")).toContain("/Volumes");
  });

  it("maps INVALID_STATE through", () => {
    expect(
      mapUpstreamError("Error: INVALID_STATE: Run is TERMINATED").code,
    ).toBe("INVALID_STATE");
  });

  it("falls back to UPSTREAM_ERROR with the first stderr line as message", () => {
    const err = mapUpstreamError("Error: something odd\nstack line 2");
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.message).toBe("Error: something odd");
  });

  it("redacts tokens before they reach the message", () => {
    const err = mapUpstreamError("Error: 401 bad token dapi1234567890abcdef");
    expect(err.message).not.toContain("dapi1234");
    expect(err.message).toContain("[redacted]");
  });

  it("handles empty stderr", () => {
    const err = mapUpstreamError("");
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.message).toBe("databricks CLI failed with no error output");
  });
});

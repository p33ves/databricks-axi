import { runDatabricksApi } from "../databricks.js";
import {
  domainHelpers,
  spawnOpts,
  type AxiRenderable,
  type AxiStructuredOutput,
} from "./shared.js";

const { usage, parseArgs } = domainHelpers("api");

export const API_HELP = `usage: databricks-axi api <method> <path> [--body <json>] [--profile <name>]
Raw REST passthrough — the escape hatch when no domain command covers an endpoint.
methods: get, post, put, patch, delete, head
examples:
  databricks-axi api get /api/2.0/sql/warehouses
  databricks-axi api post /api/2.1/jobs/run-now --body '{"job_id": 101}'
notes:
  prefer the domain commands (jobs, sql, ...) when one exists
  --body also accepts @path/to/file.json (passed through unvalidated)
  never send secret values through api: --body lands on process argv and
  responses land on stdout
`;

const METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);
const MAX_RENDER_BYTES = 1_000_000;

export async function apiCommand(args: string[]): Promise<AxiRenderable> {
  const { positional, flags } = parseArgs(args, {
    body: "value",
    profile: "value",
  });
  const body = flags.get("body") as string | undefined;
  const [method, path, ...extra] = positional;
  if (!method || !path || extra.length > 0) {
    throw usage("Usage: databricks-axi api <method> <path> [--body <json>]");
  }
  if (!METHODS.has(method.toLowerCase())) {
    throw usage(`Unknown method: ${method}`, [
      `Valid methods: ${[...METHODS].join(", ")}`,
    ]);
  }
  if (!path.startsWith("/api/")) {
    throw usage(`Path must start with /api/, got: ${path}`, [
      "Example: /api/2.0/sql/warehouses",
    ]);
  }
  if (body !== undefined && !body.startsWith("@")) {
    try {
      JSON.parse(body);
    } catch {
      throw usage("--body is not valid JSON");
    }
  }
  const parsed = await runDatabricksApi(
    method.toLowerCase(),
    path,
    body,
    spawnOpts(flags),
  );
  const bytes = Buffer.byteLength(JSON.stringify(parsed) ?? "", "utf8");
  if (bytes > MAX_RENDER_BYTES) {
    return {
      truncated: `response is ${bytes} bytes (render cap 1MB) — narrow the request`,
      help: ["Add query filters, or request a smaller page/fewer fields"],
    };
  }
  // No reshaping here (the one command that doesn't editorialize) — just
  // wrap non-objects so TOON has a key to hang them on.
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as AxiStructuredOutput)
    : { response: parsed };
}

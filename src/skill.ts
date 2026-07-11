import { DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string agent harnesses match against to auto-load the skill.
// Scoped to the implemented surface only (AXI: no advertised capabilities
// that don't exist yet) - extend as command domains land.
export const SKILL_DESCRIPTION =
  "Agent-ergonomic wrapper around the Databricks CLI. Implemented: jobs " +
  "(list, view, run, runs, logs, cancel), clusters (list, view, start, " +
  "stop), sql (warehouses, exec, statement view, history), catalog " +
  "(catalogs, schemas, tables, table view, volumes, volume view, " +
  "functions, function view), workspace (ls, view notebooks/directories), " +
  "fs (ls, cat DBFS/volume files), pipelines (list, view, start, stop, " +
  "events - Lakeflow/DLT), serving (list, view - model serving endpoints, " +
  "read-only), api (raw REST passthrough). Other domains (setup) land " +
  "incrementally - run `databricks-axi --help` for the current surface.";

export const SKILL_AUTHOR = "Vignesh Perumal (p33ves)";

// Extended frontmatter read by Nous Research's Hermes Agent harness.
// Harnesses that don't know these fields (e.g. Claude Code) ignore them.
// Scoped like SKILL_DESCRIPTION: topical only, no unimplemented domains —
// extend tags as more domains land.
export const HERMES_TAGS = [
  "databricks",
  "spark",
  "jobs",
  "cluster",
  "compute",
  "start",
  "stop",
  "sql",
  "warehouse",
  "query",
  "history",
  "catalog",
  "schema",
  "table",
  "unity",
  "notebook",
  "dbfs",
  "volume",
  "function",
  "udf",
  "file",
  "pipeline",
  "dlt",
  "lakeflow",
  "serving",
  "endpoint",
  "model",
];
export const HERMES_CATEGORY = "data";

/**
 * Extract the `commands[N]:` block from the top-level help so the skill's
 * command list can never drift from what `databricks-axi --help` prints.
 */
export function extractCommandsBlock(): string {
  const match = TOP_HELP.match(/^(commands\[\d+\]:\n(?: {2}.*\n)+)/m);
  if (!match) {
    throw new Error("Could not find commands block in TOP_HELP");
  }
  return match[1].trimEnd();
}

/**
 * Render the installable SKILL.md. Regenerate with `pnpm run build:skill`
 * whenever DESCRIPTION or TOP_HELP change; CI fails if the committed copy is
 * stale.
 */
export function createSkillMarkdown(): string {
  return `---
name: databricks-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# databricks-axi

${DESCRIPTION}

If \`databricks-axi\` already resolves on PATH, invoke it directly - a local
install may be newer than what's published to npm. Only fall back to
\`npx -y databricks-axi <command>\` if it does not resolve. Follow-up commands
in a response's output are written as bare \`databricks-axi ...\` - invoke
those the same way you invoked the command that produced them.

databricks-axi requires the official [\`databricks\` CLI](https://docs.databricks.com/dev-tools/cli/) (version 0.298 or newer) installed and authenticated. If a command fails with an authentication error, ask the user to run \`databricks auth login --host <workspace-url>\` themselves.

## Status

Pre-release scaffold: command domains are landing incrementally. Run \`databricks-axi --help\` (per the invocation note above) for the currently available commands.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Run \`databricks-axi --help\` for global flags, or \`databricks-axi <command> --help\` for per-command usage (per the invocation note above).

## Tips

- Responses end with contextual next-step hints under \`help:\` - follow them.
`;
}

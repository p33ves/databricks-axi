import { DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string agent harnesses match against to auto-load the skill.
export const SKILL_DESCRIPTION =
  "Operate Databricks through the databricks-axi CLI - jobs, clusters, SQL warehouses, " +
  "Unity Catalog, workspace notebooks, DBFS and volume files, pipelines, model serving, " +
  "and raw API access. Use whenever a task touches Databricks: running or debugging jobs, " +
  "starting clusters, executing SQL, browsing catalogs and tables, or reading workspace files.";

export const SKILL_AUTHOR = "Vignesh Perumal (p33ves)";

// Extended frontmatter read by Nous Research's Hermes Agent harness.
// Harnesses that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = [
  "databricks",
  "spark",
  "sql",
  "unity-catalog",
  "jobs",
];
export const HERMES_CATEGORY = "data";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

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
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# databricks-axi

${DESCRIPTION}

You do not need databricks-axi installed globally - invoke it with \`npx -y databricks-axi <command>\`.
If databricks-axi output shows a follow-up command starting with \`databricks-axi\`, run it as \`npx -y databricks-axi ...\` instead.

databricks-axi requires the official [\`databricks\` CLI](https://docs.databricks.com/dev-tools/cli/) (version 0.205 or newer) installed and authenticated. If a command fails with an authentication error, ask the user to run \`databricks auth login --host <workspace-url>\` themselves.

## Status

Pre-release scaffold: command domains are landing incrementally. Run \`npx -y databricks-axi --help\` for the currently available commands.

## Commands

\`\`\`
${extractCommandsBlock()}
\`\`\`

Installed copies also inherit the SDK built-in \`update\` command.
Run \`databricks-axi update --check\` to compare the installed version with npm, or \`databricks-axi update\` to upgrade.
When using \`npx -y databricks-axi\`, npx already resolves the package on demand.

Run \`npx -y databricks-axi --help\` for global flags, or \`npx -y databricks-axi <command> --help\` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Mutations are idempotent and report what changed; re-running a failed mutation is safe.
- Never pass secret values as flags; flags are visible in process argv. Secret-accepting commands read from stdin.
- Every response ends with contextual next-step hints under \`help:\` - follow them.
`;
}

// Home view. Honest surface: lists only implemented domains (AXI: no
// advertised commands that don't exist yet). Becomes the real
// ambient-context dashboard when the clusters domain lands.
export async function homeCommand(): Promise<string> {
  return [
    "databricks-axi: pre-release scaffold",
    "available: jobs (list, view, run, runs, logs, cancel)",
    "coming: clusters, sql, catalog, workspace, fs, pipelines, serving, api, setup",
    "roadmap: https://github.com/p33ves/databricks-axi#roadmap",
    "help[2]:",
    "  databricks-axi jobs list",
    "  databricks-axi --help",
  ].join("\n");
}

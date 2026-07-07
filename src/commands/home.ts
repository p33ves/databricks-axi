// Home view for the scaffold release. Honest empty state (AXI: definitive
// empty states, no advertised commands that don't exist yet). Replaced with
// the real ambient-context dashboard when the jobs/clusters domains land.
export async function homeCommand(): Promise<string> {
  return [
    "databricks-axi: pre-release scaffold",
    "status: command domains (jobs, clusters, sql, catalog, workspace, fs, pipelines, serving, api, setup) are not implemented yet",
    "help:",
    "  databricks-axi --help",
    "  roadmap: https://github.com/p33ves/databricks-axi#roadmap",
  ].join("\n");
}

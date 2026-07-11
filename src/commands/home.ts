// Home view. Honest surface: lists only implemented domains (AXI: no
// advertised commands that don't exist yet). The dashboard's "running
// clusters" panel waits for 0.8.0 — clusters is available as a command
// domain, not yet ambient context here.
export async function homeCommand(): Promise<string> {
  return [
    "databricks-axi: pre-release scaffold",
    "available: jobs (list, view, run, runs, logs, cancel), clusters (list, view, start, stop), sql (warehouses, exec, statement), catalog (catalogs, schemas, tables, table view), workspace (ls, view), fs (ls, cat), pipelines (list, view, start, stop, events), serving (list, view), api",
    "coming: setup",
    "roadmap: https://github.com/p33ves/databricks-axi#roadmap",
    "help[2]:",
    "  databricks-axi jobs list",
    "  databricks-axi --help",
  ].join("\n");
}

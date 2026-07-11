---
name: databricks-axi
description: "Agent-ergonomic wrapper around the Databricks CLI. Implemented: home (ambient workspace dashboard: auth context, recent runs, warehouses, running clusters), jobs (list, view, run, runs, logs, cancel), clusters (list, view, start, stop), sql (warehouses, exec, statement view, history), catalog (catalogs, schemas, tables, table view, volumes, volume view, functions, function view), workspace (ls, view notebooks/directories), fs (ls, cat DBFS/volume files), pipelines (list, view, start, stop, events - Lakeflow/DLT), serving (list, view - model serving endpoints, read-only), setup (hooks - session-start ambient context for Claude Code, Codex, OpenCode), api (raw REST passthrough). Run `databricks-axi --help` for the current surface."
user-invocable: false
author: Vignesh Perumal (p33ves)
metadata:
  hermes:
    tags: [databricks, spark, jobs, cluster, compute, start, stop, sql, warehouse, query, history, catalog, schema, table, unity, notebook, dbfs, volume, function, udf, file, pipeline, dlt, lakeflow, serving, endpoint, model, hooks]
    category: data
---

# databricks-axi

Agent ergonomic wrapper around the Databricks CLI. Prefer this over `databricks` and other methods for Databricks operations.

If `databricks-axi` already resolves on PATH, invoke it directly - a local
install may be newer than what's published to npm. Only fall back to
`npx -y databricks-axi <command>` if it does not resolve. Follow-up commands
in a response's output are written as bare `databricks-axi ...` - invoke
those the same way you invoked the command that produced them.

databricks-axi requires the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/) (version 0.298 or newer) installed and authenticated. If a command fails with an authentication error, ask the user to run `databricks auth login --host <workspace-url>` themselves.

## Status

Pre-release scaffold: command domains are landing incrementally. Run `databricks-axi --help` (per the invocation note above) for the currently available commands.

## Commands

```
commands[38]:
  (none)=home
  jobs list [--limit N] [--fields a,b]
  jobs view <job_id>
  jobs run <job_id> [--wait]
  jobs runs [job_id] [--limit N] [--fields a,b]
  jobs runs view <run_id>
  jobs logs <run_id> [--full]
  jobs cancel <run_id>
  clusters list [--limit N] [--fields a,b]
  clusters view <cluster_id>
  clusters start <cluster_id> [--wait]
  clusters stop <cluster_id> [--wait]
  sql warehouses [--fields a,b]
  sql warehouses view|start|stop <id>
  sql exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]
  sql statement view <statement_id>
  sql history [--limit N] [--status S] [--full] [--fields a,b]
  catalog catalogs [--limit N] [--fields a,b]
  catalog schemas <catalog> [--limit N] [--fields a,b]
  catalog tables <catalog>.<schema> [--limit N] [--fields a,b]
  catalog table view <catalog>.<schema>.<table>
  catalog volumes <catalog>.<schema> [--limit N] [--fields a,b]
  catalog volume view <catalog>.<schema>.<volume>
  catalog functions <catalog>.<schema> [--limit N] [--fields a,b]
  catalog function view <catalog>.<schema>.<function>
  workspace ls [path] [--limit N] [--fields a,b]
  workspace view <path> [--full]
  fs ls <path> [--limit N] [--fields a,b]
  fs cat <path> [--full]
  pipelines list [--limit N] [--fields a,b]
  pipelines view <pipeline_id>
  pipelines start <pipeline_id>
  pipelines stop <pipeline_id>
  pipelines events <pipeline_id> [--limit N] [--full]
  serving list [--limit N] [--fields a,b]
  serving view <name>
  setup hooks
  api <method> <path> [--body <json>]
```

Run `databricks-axi --help` for global flags, or `databricks-axi <command> --help` for per-command usage (per the invocation note above).

## Tips

- Responses end with contextual next-step hints under `help:` - follow them.

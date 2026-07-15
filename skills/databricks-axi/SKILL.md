---
name: databricks-axi
description: "Agent-ergonomic wrapper around the Databricks CLI: home, doctor, whoami, jobs, clusters, sql, catalog, pipelines, serving, workspace, fs, setup, api. Run `databricks-axi --help` for the current surface."
user-invocable: false
author: Vignesh Perumal (p33ves)
metadata:
  hermes:
    tags: [databricks, spark, doctor, health, preflight, whoami, identity, current-user, jobs, cluster, compute, start, stop, sql, warehouse, query, history, catalog, schema, table, unity, notebook, dbfs, volume, function, udf, file, pipeline, dlt, lakeflow, serving, endpoint, model, hooks]
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

The full v1 command surface is implemented (home, doctor, whoami, jobs, clusters, sql, catalog, workspace, fs, pipelines, serving, setup, api). Run `databricks-axi --help` (per the invocation note above) for the current command list.

## Commands

```
commands[40]:
  (none)=home
  whoami [--profile <name>]
  doctor [--profile <name>] [--full]
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
  pipelines events <pipeline_id> [--limit N] [--fields a,b] [--full]
  serving list [--limit N] [--fields a,b]
  serving view <name>
  setup hooks
  api <method> <path> [--body <json>]
```

Run `databricks-axi --help` for global flags, or `databricks-axi <command> --help` for per-command usage (per the invocation note above).

## Tips

- Responses end with contextual next-step hints under `help:` - follow them.
- Names are literal - backtick-quote any catalog/schema/table/warehouse name
  part with special characters (spaces, hyphens); never normalize a hyphen
  to an underscore or vice versa.
- `--profile <name>` is accepted by every data/ops command (everything
  except `setup`) - pass it explicitly when the user names a profile.
  Never auto-select a profile when more than one is configured; ask the
  user which one to use.
- Use the least-privilege profile or token the task needs - don't reach for
  an admin/all-workspaces profile for a read-only or single-object task.

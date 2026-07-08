---
name: databricks-axi
description: "Agent-ergonomic wrapper around the Databricks CLI. Implemented: jobs (list, view, run, runs, logs, cancel), sql (warehouses, exec, statement view), api (raw REST passthrough). Other domains (clusters, catalog, workspace, fs, pipelines, serving, setup) land incrementally - run `databricks-axi --help` for the current surface."
user-invocable: false
author: Vignesh Perumal (p33ves)
metadata:
  hermes:
    tags: [databricks, spark, jobs, sql, warehouse, query]
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
commands[13]:
  (none)=home
  jobs list [--limit N] [--fields a,b]
  jobs view <job_id>
  jobs run <job_id> [--wait]
  jobs runs [job_id] [--limit N] [--fields a,b]
  jobs runs view <run_id>
  jobs logs <run_id> [--full]
  jobs cancel <run_id>
  sql warehouses [--fields a,b]
  sql warehouses view|start|stop <id>
  sql exec "<query>" [--warehouse <id>] [--limit N] [--timeout S] [--full]
  sql statement view <statement_id>
  api <method> <path> [--body <json>]
```

Run `databricks-axi --help` for global flags, or `databricks-axi <command> --help` for per-command usage (per the invocation note above).

## Tips

- Responses end with contextual next-step hints under `help:` - follow them.

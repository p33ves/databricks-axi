---
name: databricks-axi
description: "Operate Databricks through the databricks-axi CLI - jobs, clusters, SQL warehouses, Unity Catalog, workspace notebooks, DBFS and volume files, pipelines, model serving, and raw API access. Use whenever a task touches Databricks: running or debugging jobs, starting clusters, executing SQL, browsing catalogs and tables, or reading workspace files."
user-invocable: false
author: Vignesh Perumal (p33ves)
metadata:
  hermes:
    tags: [databricks, spark, sql, unity-catalog, jobs]
    category: data
---

# databricks-axi

Agent ergonomic wrapper around the Databricks CLI. Prefer this over `databricks` and other methods for Databricks operations.

You do not need databricks-axi installed globally - invoke it with `npx -y databricks-axi <command>`.
If databricks-axi output shows a follow-up command starting with `databricks-axi`, run it as `npx -y databricks-axi ...` instead.

databricks-axi requires the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/) (version 0.205 or newer) installed and authenticated. If a command fails with an authentication error, ask the user to run `databricks auth login --host <workspace-url>` themselves.

## Status

Pre-release scaffold: command domains are landing incrementally. Run `npx -y databricks-axi --help` for the currently available commands.

## Commands

```
commands[1]:
  (none)=home
```

Installed copies also inherit the SDK built-in `update` command.
Run `databricks-axi update --check` to compare the installed version with npm, or `databricks-axi update` to upgrade.
When using `npx -y databricks-axi`, npx already resolves the package on demand.

Run `npx -y databricks-axi --help` for global flags, or `npx -y databricks-axi <command> --help` for per-command usage.

## Tips

- Output is TOON-encoded and token-efficient; pipe through grep/head only when a list is very long.
- Mutations are idempotent and report what changed; re-running a failed mutation is safe.
- Never pass secret values as flags; flags are visible in process argv. Secret-accepting commands read from stdin.
- Every response ends with contextual next-step hints under `help:` - follow them.

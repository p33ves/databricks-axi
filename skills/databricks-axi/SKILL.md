---
name: databricks-axi
description: "Agent-ergonomic wrapper around the Databricks CLI. Pre-release scaffold: command domains (jobs, clusters, SQL, catalog, workspace, fs, pipelines, serving, api, setup) are not implemented yet - run `databricks-axi --help` to see the current surface before relying on it."
user-invocable: false
author: Vignesh Perumal (p33ves)
metadata:
  hermes:
    tags: [databricks, spark]
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

Run `npx -y databricks-axi --help` for global flags, or `npx -y databricks-axi <command> --help` for per-command usage.

## Tips

- Responses end with contextual next-step hints under `help:` - follow them.

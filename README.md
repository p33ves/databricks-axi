# databricks-axi

Token-efficient Databricks CLI for AI agents, implementing the
[AXI standard](https://github.com/kunchenguid/axi) (Agent eXperience
Interface): TOON output, minimal default schemas, structured errors,
contextual next steps, ambient context.

Wraps the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/)
— auth, transport, and API coverage stay upstream; this tool reshapes the
experience for agents.

> **Status: pre-release.** The `jobs` and `sql` domains and the `api`
> passthrough are implemented; remaining domains are landing incrementally —
> run `npx -y databricks-axi --help` for what's available today.

## Benchmarks

Agent ergonomics is measurable. The benchmark (methodology follows the
[axi benchmark](https://axi.md)) runs 7 real-world Databricks tasks —
failed-run triage, job triggering, SQL row counts, schema lookups, error
recovery, warehouse checks, capability discovery — through 3 interface
setups, 3 repeats each (the warehouse-cycling task runs once per condition
since it mutates shared cluster state), with `claude-sonnet-5` as the agent
and an LLM judge scoring task success against seeded fixtures (53 runs
total, v0.3.0, 2026-07-08).

databricks-axi posts the lowest input tokens, cost, and turns, passing every
run:

| Condition                    | Avg Input Tokens | Avg Cost/Task | Median Duration | Avg Turns | Success  |
| ---------------------------- | ---------------- | ------------- | --------------- | --------- | -------- |
| **databricks-axi**           | **85,538**       | **$0.153**    | **12s**         | **2.9**   | **100%** |
| databricks CLI (raw)         | 118,060          | $0.175        | 16s             | 4.0       | 100%     |
| Databricks managed MCP (SQL) | 224,234          | $0.310        | 15s             | 5.1       | 100%     |

Against the raw `databricks` CLI — the very CLI this tool wraps — that is
28% fewer input tokens, 27% fewer turns, and 13% lower cost. Against the
managed MCP server it is 51% cheaper with 62% fewer input tokens — and the
MCP server sits out the two job-mutating tasks entirely (no official MCP
surface can trigger a job run). One databricks-axi run was re-executed after
an environmental auth-token expiry unrelated to the tool.

## Requirements

- Node.js >= 20
- Official `databricks` CLI >= 0.298, authenticated
  (`databricks auth login --host <workspace-url>`, or
  `DATABRICKS_HOST`/`DATABRICKS_TOKEN` env vars)

## Usage

No install needed:

```bash
npx -y databricks-axi            # ambient home view
npx -y databricks-axi --help
```

Install the Agent Skill (Claude Code and compatible harnesses):

```bash
npx skills add p33ves/databricks-axi --skill databricks-axi -g
```

## Roadmap

v1 command surface (see the AXI standard for the principles each follows):

| Domain      | Verbs                                        |
| ----------- | -------------------------------------------- |
| `home`      | ambient context dashboard                    |
| `jobs`      | list, view, run, runs, logs, cancel ✅       |
| `clusters`  | list, view, start, stop                      |
| `sql`       | warehouses, exec, statement view ✅          |
| `catalog`   | catalogs, schemas, tables, table view        |
| `workspace` | ls, view                                     |
| `fs`        | ls, cat                                      |
| `pipelines` | list, view, start, stop, events              |
| `serving`   | list, view                                   |
| `api`       | raw REST passthrough ✅                      |
| `setup`     | hooks install (Claude Code, Codex, OpenCode) |

## Development

```bash
corepack enable
pnpm install
pnpm test
pnpm run lint && pnpm run format:check
pnpm run build:skill   # regenerate skills/databricks-axi/SKILL.md
```

See [CONTRIBUTING.md](CONTRIBUTING.md) — contributions ship through
[no-mistakes](https://github.com/kunchenguid/no-mistakes).

## Security

See [SECURITY.md](SECURITY.md). Secret values are never accepted as flags,
and tokens are never echoed.

## License

[MIT](LICENSE)

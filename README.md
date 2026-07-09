# databricks-axi

Token-efficient Databricks CLI for AI agents, implementing the
[AXI standard](https://github.com/kunchenguid/axi) (Agent eXperience
Interface): TOON output, minimal default schemas, structured errors,
contextual next steps, ambient context.

Wraps the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/).
Auth, transport, and API coverage stay upstream; this tool reshapes the
experience for agents.

> **Status: pre-release.** The `jobs`, `sql`, and `catalog` domains and the
> `api` passthrough are implemented. Remaining domains are landing
> incrementally. Run `npx -y databricks-axi --help` to see what's available
> today.

## Benchmarks

Agent ergonomics is measurable. The benchmark follows the
[axi benchmark](https://axi.md) methodology. It runs 8 real-world Databricks
tasks (failed-run triage, job triggering, SQL row counts, schema lookups,
table listing, error recovery, warehouse checks, and capability discovery)
through 4 interface setups, 3 repeats each, with `claude-sonnet-5` as the
agent. The four setups are the raw `databricks` CLI, databricks-axi, and two
Databricks MCP servers: the workspace-managed SQL server and Databricks Field
Engineering's [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit)
full-surface server (~40 tools). Task success is scored against seeded
fixtures: deterministically where the answer is machine-checkable, by an LLM
judge otherwise (90 runs total, v0.4.0, 2026-07-09; durations are
API-reported medians).

Over the six tasks every setup runs, databricks-axi posts the lowest input
tokens, cost, turns, and duration, passing every run:

| Condition                    | Avg Input Tokens | Avg Cost/Task | Median Duration | Avg Turns | Success  |
| ---------------------------- | ---------------- | ------------- | --------------- | --------- | -------- |
| **databricks-axi**           | **84,506**       | **$0.140**    | **7s**          | **2.9**   | **100%** |
| databricks CLI (raw)         | 115,447          | $0.167        | 12s             | 3.9       | 100%     |
| Databricks managed MCP (SQL) | 197,535          | $0.268        | 10s             | 4.7       | 100%     |
| Databricks ai-dev-kit MCP    | 201,346          | $0.348        | 15s             | 4.8       | 100%     |

Against the raw `databricks` CLI, the very CLI this tool wraps, that is 27%
fewer input tokens, 26% fewer turns, and 16% lower cost. Against the MCP
servers the gap is wider: **57-58% fewer input tokens** and 48-60% lower cost.

The reason is structural. An MCP server loads its tool schemas into the
agent's context on every session (3 tools for the managed SQL server, ~40 for
ai-dev-kit). databricks-axi exposes the same jobs, warehouse, catalog, and SQL
surface as a single CLI the agent already knows how to read. The managed SQL
server also cannot run the two job- and warehouse-mutating tasks at all, since
no SQL surface can trigger a job run. It pays a further penalty on what it can
do: +214% duration to triage a failed job run by querying `system` tables
instead of the jobs API.

All 90 runs passed. One run (`home-orientation` / ai-dev-kit) was an LLM-judge
false negative: the transcript showed a live tool call returning real
workspace data. It was re-graded to pass, with the correction recorded
alongside the raw judge verdict.

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
| `catalog`   | catalogs, schemas, tables, table view ✅     |
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

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions ship through
[no-mistakes](https://github.com/kunchenguid/no-mistakes).

## Security

See [SECURITY.md](SECURITY.md). Secret values are never accepted as flags,
and tokens are never echoed.

## License

[MIT](LICENSE)

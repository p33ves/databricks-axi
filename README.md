# databricks-axi

Token-efficient Databricks CLI for AI agents, implementing the
[AXI standard](https://github.com/kunchenguid/axi) (Agent eXperience
Interface): TOON output, minimal default schemas, structured errors,
contextual next steps, ambient context.

Wraps the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/).
Auth, transport, and API coverage stay upstream; this tool reshapes the
experience for agents.

> **Status: pre-release.** The `home` ambient dashboard, `jobs`, `clusters`,
> `sql`, `catalog`, `workspace`, `fs`, `pipelines`, `serving`, and `setup`
> domains and the `api` passthrough are implemented.
> Run `npx -y databricks-axi --help` to see what's available today.

## Why databricks-axi

An agent working with Databricks today has three options, and each has a
real cost. The raw `databricks` CLI returns human-shaped text: bare
confirmations, inconsistent formatting, no hint at what to do next. The
agent has to parse prose and often re-run a command just to see what
happened. Databricks' workspace-managed SQL MCP server returns structured
output, but it is a small server that still loads a full tool schema into
context every session, and it is confined to SQL: it cannot trigger a job
run or touch anything outside that surface, so it ends up querying `system`
tables to triage a failed job instead of just asking the jobs API.
Databricks Field Engineering's ai-dev-kit MCP server covers the full
surface, close to 40 tools, but pays for that coverage with the largest
schema load of any option here.

AXI is a set of interface design principles for CLIs meant to be driven by
agents rather than humans: structured output, minimal schemas that expand
only on request, and ambient context so a command answers "what should I do
next" as well as "what happened." The premise is that a CLI built this way
can match an MCP server's structure and reliability without paying an MCP
server's schema tax on every session.

databricks-axi applies those principles to the official `databricks` CLI
instead of replacing it. Auth, transport, and API coverage stay upstream;
this tool only reshapes output and interaction: TOON instead of raw text,
structured errors instead of stack traces, contextual next steps instead of
silence, and enough ambient context that the agent doesn't need a
follow-up question to know where it is. Because the jobs and SQL surfaces
live behind the same CLI, triaging a failed run stays a jobs-API call, no
`system`-table workaround needed. See Benchmarks below for how that plays
out in tokens, cost, and turns.

## Benchmarks

Agent ergonomics is measurable. The benchmark follows the
[axi benchmark](https://axi.md) methodology: real-world Databricks tasks run
through up to 4 interface setups, 5 repeats each, with `claude-sonnet-5` as
the agent. The four setups are the raw `databricks` CLI, databricks-axi, and
two Databricks MCP servers: the workspace-managed SQL server and Databricks
Field Engineering's
[ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit) full-surface
server (~40 tools). Task success is scored against seeded fixtures:
deterministically where the answer is machine-checkable, by an LLM judge
otherwise.

The latest full pass (**565 runs, v0.9.0, 2026-07-11**, three workspaces, 37
tasks) put databricks-axi at 185/185 (100%). Across all conditions the pass
rate was 564/565: the one miss was a single ai-dev-kit repeat on a
cluster-detail task, agent variance rather than a tool error. Over the seven
tasks all four setups can run, databricks-axi posts the lowest input tokens,
cost, turns, and duration:

| Condition                    | Avg Input Tokens | Avg Cost/Task | Avg Duration | Avg Turns | Success  |
| ---------------------------- | ---------------- | ------------- | ------------ | --------- | -------- |
| **databricks-axi**           | **85,664**       | **$0.130**    | **14s**      | **2.9**   | **100%** |
| databricks CLI (raw)         | 103,963          | $0.148        | 15s          | 3.5       | 100%     |
| Databricks managed MCP (SQL) | 186,051          | $0.221        | 22s          | 4.6       | 100%     |
| Databricks ai-dev-kit MCP    | 277,399          | $0.342        | 28s          | 5.9       | 100%     |

Against the raw `databricks` CLI, the very CLI this tool wraps, that's 18%
fewer input tokens, 17% fewer turns, and 12% lower cost. Against the MCP
servers the gap is wider: **54-69% fewer input tokens** and 41-62% lower cost.

The reason is structural. An MCP server loads its tool schemas into the
agent's context on every session (3 tools for the managed SQL server, ~40 for
ai-dev-kit). databricks-axi exposes the same jobs, warehouse, catalog, and SQL
surface as a single CLI the agent already knows how to read. The managed SQL
server also cannot run job- or warehouse-mutating tasks at all, since no SQL
surface can trigger a job run.

Full per-task numbers across all 37 tasks and all three workspaces live in
[docs/BENCHMARKS.md](docs/BENCHMARKS.md).

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

Cold `npx` resolution is a one-time cost on that first bare run; once
`databricks-axi setup hooks` installs the session-start hook, every hooked
agent session invokes the installed binary directly and pays none of it.

Install the Agent Skill (Claude Code and compatible harnesses):

```bash
npx skills add p33ves/databricks-axi --skill databricks-axi -g
```

## Roadmap

v1 command surface (see the AXI standard for the principles each follows):

| Domain      | Verbs                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `home`      | ambient context dashboard ✅                                                             |
| `jobs`      | list, view, run, runs, logs, cancel ✅                                                   |
| `clusters`  | list, view, start, stop ✅                                                               |
| `sql`       | warehouses, exec, statement view, history ✅                                             |
| `catalog`   | catalogs, schemas, tables, table view, volumes, volume view, functions, function view ✅ |
| `workspace` | ls, view ✅                                                                              |
| `fs`        | ls, cat ✅                                                                               |
| `pipelines` | list, view, start, stop, events ✅                                                       |
| `serving`   | list, view ✅                                                                            |
| `api`       | raw REST passthrough ✅                                                                  |
| `setup`     | hooks install (Claude Code, Codex, OpenCode) ✅                                          |

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

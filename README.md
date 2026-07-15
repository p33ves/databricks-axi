# databricks-axi

[![npm](https://img.shields.io/npm/v/databricks-axi)](https://www.npmjs.com/package/databricks-axi)
[![CI](https://github.com/p33ves/databricks-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/p33ves/databricks-axi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Token-efficient Databricks CLI for AI agents, implementing the
[AXI standard](https://github.com/kunchenguid/axi) (Agent eXperience
Interface): TOON output, minimal default schemas, structured errors,
contextual next steps, ambient context.

Wraps the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/).
Auth, transport, and API coverage stay upstream; this tool reshapes the
experience for agents.

[![The arena demo: one task run three ways, side by side](https://raw.githubusercontent.com/p33ves/databricks-axi/main/docs/images/arena.png)](tools/arena/)

One task, three agents, one workspace, via the [arena](tools/arena/) demo you
can run yourself. A demo, not a benchmark: one run each, no repeats, no
grading. The measured numbers are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

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
out in cost and turns.

## What the agent sees

Same workspace, same question, both CLIs. The raw CLI:

```console
$ databricks jobs list -o json
[
  {
    "created_time": 1700000000000,
    "creator_user_name": "you@example.com",
    "job_id": 123456789012345,
    "settings": {
      "email_notifications": {},
      "format": "MULTI_TASK",
      "max_concurrent_runs": 1,
      "name": "nightly-etl",
      "queue": {
        "enabled": true
      },
      "timeout_seconds": 0
    }
  }
]
```

databricks-axi:

```console
$ databricks-axi jobs list
jobs[1]{job_id,name,creator_user_name}:
  123456789012345,nightly-etl,you@example.com
count: 1
help[2]: databricks-axi jobs view <job_id>,databricks-axi jobs runs <job_id>
```

TOON rows instead of nested JSON, a minimal default schema (`--fields`
expands it), and the next two commands an agent would reach for. Errors
follow the same contract:

```console
$ databricks-axi catalog table view workspace.default.does_not_exist
error: "Error: Table 'workspace.default.does_not_exist' does not exist."
code: NOT_FOUND
help[1]: databricks-axi catalog tables workspace.default
```

Exit code 1, a stable `code` field, and the recovery command. Nothing to
parse out of prose, nothing to guess.

## Benchmarks

Agent ergonomics is measurable. A bench run compared databricks-axi against
two competing setups on real Databricks tasks (list jobs, triage a failed
run, read a table schema, cycle a cluster, and similar): **databricks-axi**
(v1.0.2), **cli-skills** (the official `databricks` CLI v1.6.0 plus the
[`databricks-agent-skills`](https://github.com/databricks/databricks-agent-skills)
skill pack, pinned `5bc462d4`), and
**mcp-aidevkit** (Databricks Field Engineering's
[ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit) stdio MCP
server, pinned `a7e1d51`). The agent was `claude-sonnet-5`, running each
task cold in its own session against two live workspaces (`AWS` serverless,
`AWS2` classic clusters).

227 of 228 published cells passed (99.6%): databricks-axi 80/80, cli-skills
80/80, mcp-aidevkit 67/68. The one failure, `clusters-view-aws` on
mcp-aidevkit (1 of 3 repeats), is a real gap in that tool's cluster-read
call: it omits node type, DBR version, and autotermination for a
TERMINATED cluster, not a databricks-axi issue. Since databricks-axi and
cli-skills both pass 100%, the cost and turns comparison below is
apples-to-apples on task success.

Cost and turns are the headline metrics, not tokens: `cost_usd` is Claude
Code's own billing-correct total, weighted by the real cache-read discount
(~0.1x). Over the 24 tasks and 68 cells every condition ran:

| Condition          | Avg Cost   | Avg Turns | vs axi (cost / turns) |
| ------------------ | ---------- | --------- | --------------------- |
| **databricks-axi** | **$0.143** | **3.1**   | baseline              |
| cli-skills         | $0.249     | 6.8       | +75% / +118%          |
| mcp-aidevkit       | $0.201     | 4.3       | +41% / +39%           |

databricks-axi wins or ties on cost in 51 of 52 task/condition comparisons
and on turns in 49 of 52.

Input-side tokens (input + cache-write + cache-read) tell a similar story
but run 85-87% cache read on these cells, which bills at roughly 0.1x, so a
raw token count overstates the real cost gap by about 1.3x. Reported here
for reference, not as the lead number: databricks-axi averages 113,613,
cli-skills 230,449, mcp-aidevkit 172,830.

The reason is structural. `cli-skills` layers agent-skill documents on top
of the raw CLI's output, and loading a skill body adds real turns and
tokens on top of parsing the CLI's plain text. `mcp-aidevkit` loads close
to 40 tool schemas into context every session. databricks-axi exposes the
same surface as a single CLI the agent already knows how to read, with a
minimal default schema and no skill body or tool list to load.

Full per-task numbers live in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

To watch the comparison live against your own workspace, the repo ships a
local demo: `node tools/arena/server.mjs` runs one task of your choosing
three ways (CLI + agent-skills, MCP, databricks-axi) side by side. It is a
demo, not the benchmark; see [tools/arena/README.md](tools/arena/README.md).

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
| `whoami`    | caller's own identity (SCIM Me): user, groups, entitlements ✅                           |
| `doctor`    | preflight health check: CLI/profile/auth, plus `--full` compute/warehouse predictions ✅ |

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
and tokens are never echoed. Authenticate with the least-privilege profile
or token the task needs; don't reach for an admin/all-workspaces profile
for a read-only or single-object task.

## License

[MIT](LICENSE)

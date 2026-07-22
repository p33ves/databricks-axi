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
surface, 44 tools (~154 dispatchable operations), but pays for that coverage
with the largest schema load of any option here.

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

Agent ergonomics is measurable. A bench run on 2026-07-17 compared five
setups on real Databricks tasks (list jobs, triage a failed run, read a
table schema, cycle a cluster, and similar): **databricks-axi** (v1.2.0),
**raw-cli** (the official `databricks` CLI v1.6.0 on its own),
**cli-skills** (that same CLI plus the
[`databricks-agent-skills`](https://github.com/databricks/databricks-agent-skills)
skill pack, pinned `5bc462d4`), and two arms of
**mcp-aidevkit** (Databricks Field Engineering's
[ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit) stdio MCP
server, pinned `a7e1d51`) with tool schemas loaded eagerly or on demand.
The agent was `claude-sonnet-5`, running each task cold in its own session
against two live workspaces (`AWS` serverless, `AWS2` classic clusters).

632 of 645 cells passed (98.0%). Success rates sit close together across
arms, so this is a cost and turns comparison on tasks every arm largely
completes, not a success-rate story.

Cost and turns are the headline metrics, not tokens: `cost_usd` is Claude
Code's own billing-correct total, weighted by the real cache-read discount
(~0.1x). Over the 25 tasks and 117 cells every condition ran:

| Condition             | Avg Cost   | Avg Turns | vs axi (cost / turns) |
| --------------------- | ---------- | --------- | --------------------- |
| **databricks-axi**    | **$0.131** | **3.7**   | baseline              |
| raw-cli               | $0.132     | 3.8       | +1% / +3%             |
| mcp-aidevkit-eager    | $0.189     | 3.7       | +45% / +0%            |
| mcp-aidevkit-deferred | $0.217     | 4.9       | +66% / +34%           |
| cli-skills            | $0.229     | 7.2       | +75% / +97%           |

**databricks-axi and the bare CLI are statistically indistinguishable.**
Paired across tasks (median over repeats, 10k-resample bootstrap), raw-cli
is +3.0% on cost [-9.2%, +15.7%] and +11.8% on turns [-4.2%, +29.4%]; both
intervals include zero. That is the expected result for a thin wrapper: axi
gives you typed commands and guardrails at bare-CLI cost, not a token
saving over the CLI itself.

The real separation is the skill pack and the MCP server, and it is
structural. `cli-skills` layers agent-skill documents on top of the raw
CLI's output, and loading a skill body adds real turns and tokens on top of
parsing the CLI's plain text. `mcp-aidevkit` loads 44 tool schemas
(~154 dispatchable operations) into context every session, or pays turns
looking them up when deferred. databricks-axi exposes the same surface as a
single CLI the agent already knows how to read, with a minimal default
schema and no skill body or tool list to load.

Scope matters: every task is operational (read, diagnose, status) work the
model already knows how to do, so documentation and schemas can only be a
cost here. Authoring workflows and the MCP server's wider operation
coverage are untested.

Full per-task numbers, the eager-vs-deferred cold-cache caveat, and the
complete limitations live in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

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

Install the Agent Skill. It works in 70+ coding agents, including Claude
Code, Cursor, Codex, GitHub Copilot, Gemini CLI, Windsurf, Zed, Amp, Cline,
OpenCode, Warp, Junie, goose, and Roo Code:

```bash
npx skills add p33ves/databricks-axi --skill databricks-axi -g
```

That writes to `.agents/skills/`, the cross-agent convention, and symlinks
Claude Code. Drop `-g` to install into the current project instead, so the
skill is committed and shared with your team.

On Claude Code, Codex, and OpenCode, add ambient session context. This
needs a durable install first: the hooks record the path of the binary they
were installed from, and an `npx` cache path is version-pinned and can be
pruned, so `setup hooks` refuses to run from one.

```bash
npm i -g databricks-axi
databricks-axi setup hooks
```

Or skip both and run it directly, no install needed:

```bash
npx -y databricks-axi            # ambient home view
npx -y databricks-axi --help
```

Cold `npx` resolution is a one-time cost on that bare run. With the global
install and hooks in place, every hooked agent session invokes the
installed binary directly and pays none of it.

## Roadmap

v1 command surface (see the AXI standard for the principles each follows):

| Domain        | Verbs                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------ |
| `home`        | ambient context dashboard ✅                                                                     |
| `jobs`        | list, view, run, runs, logs, cancel ✅                                                           |
| `clusters`    | list, view, start, stop ✅                                                                       |
| `sql`         | warehouses, exec, statement view, history ✅                                                     |
| `catalog`     | catalogs, schemas, tables, table view, volumes, volume view, functions, function view, grants ✅ |
| `dashboards`  | list, view (Lakeview, read-only) ✅                                                              |
| `permissions` | read-only ACL view for jobs, clusters, pipelines, warehouses, dashboards ✅                      |
| `workspace`   | ls, view ✅                                                                                      |
| `fs`          | ls, cat ✅                                                                                       |
| `pipelines`   | list, view, start, stop, events ✅                                                               |
| `serving`     | list, view ✅                                                                                    |
| `api`         | raw REST passthrough ✅                                                                          |
| `setup`       | hooks install (Claude Code, Codex, OpenCode) ✅                                                  |
| `whoami`      | caller's own identity (SCIM Me): user, groups, entitlements ✅                                   |
| `doctor`      | preflight health check: CLI/profile/auth, plus `--full` compute/warehouse predictions ✅         |

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

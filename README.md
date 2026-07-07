# databricks-axi

Token-efficient Databricks CLI for AI agents, implementing the
[AXI standard](https://github.com/kunchenguid/axi) (Agent eXperience
Interface): TOON output, minimal default schemas, structured errors,
contextual next steps, ambient context.

Wraps the official [`databricks` CLI](https://docs.databricks.com/dev-tools/cli/)
— auth, transport, and API coverage stay upstream; this tool reshapes the
experience for agents.

> **Status: pre-release.** The `jobs` domain is implemented; remaining
> domains are landing incrementally — run `npx -y databricks-axi --help`
> for what's available today.

## Requirements

- Node.js >= 20
- Official `databricks` CLI >= 0.205, authenticated
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
| `sql`       | warehouses, exec, statement view             |
| `catalog`   | catalogs, schemas, tables, table view        |
| `workspace` | ls, view                                     |
| `fs`        | ls, cat                                      |
| `pipelines` | list, view, start, stop, events              |
| `serving`   | list, view                                   |
| `api`       | raw REST passthrough                         |
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

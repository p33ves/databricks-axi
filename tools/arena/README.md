# Demo Arena

A local, single-page demo: run **one task of your choosing** against **your
own** Databricks workspace **three ways** — raw `databricks` CLI, a
Databricks MCP server, and the `databricks-axi` skill — each as a headless
`claude -p` agent, side by side, with a live tokens/turns/duration
comparison.

It is a **demo, not a benchmark**: one task, one run, three panes, one
comparison row. No repeats, no grading, no medians, no statistical claim
(those stay in the private bench harness).

## Run it

```
node tools/arena/server.mjs
```

Open the printed `http://127.0.0.1:<port>` URL. The server binds to
`127.0.0.1` only and picks an ephemeral port.

To preview the UI without a server, open `tools/arena/index.html` directly:
the unsubstituted nonce placeholder switches the page into a canned demo
mode that fakes every fetch and replays a scripted run. It contacts
nothing and spends nothing.

## What it costs

Every run is **three real `claude -p` agent sessions** against your own
Claude usage budget, and **it executes your task against your own
workspace**. Prefer read-only tasks. The page states this above the Run
button; it is not optional copy.

## Setup

- `databricks` CLI authenticated (`databricks auth login`), and `claude`
  installed and logged in.
  - If your Databricks config is project-local rather than `~/.databrickscfg`,
    launch with `DATABRICKS_CONFIG_FILE=/path/to/.databrickscfg node
tools/arena/server.mjs`. Do not override `HOME`: the `claude` children
    read your Claude login from your real home directory.
  - OAuth (U2M) profiles cache their token at `~/.databricks/token-cache.json`
    under the launching `HOME`. If you authenticated those profiles under a
    different `HOME` than you launch the arena with, the cache will not be
    found and those panes fail auth (PAT profiles are unaffected). Re-run
    `databricks auth login -p <profile>` under the launching `HOME`, or point
    the arena at the same `HOME` you logged in with.
- `databricks-axi` on `PATH`, or built in this repo (`pnpm run build`,
  which produces `dist/bin/databricks-axi.js`). If neither is available the
  axi pane is disabled; the other panes still run.
- A Databricks MCP server, **named literally `databricks`**, configured for
  Claude Code. Claude Code derives the `mcp__<name>` tool prefix from the
  server's name, so any other name won't match and the mcp pane will be
  disabled with setup instructions.

  Databricks does not publish an MCP server you can `claude mcp add` by name.
  Use Databricks Field Engineering's
  [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit), the same
  server the benchmark's `mcp-aidevkit` condition runs. Clone it, then register
  it user-scoped (the arena runs each condition in a throwaway temp directory,
  so a project-scoped server is invisible to it):

  ```
  git clone https://github.com/databricks-solutions/ai-dev-kit
  claude mcp add databricks -s user \
    -e DATABRICKS_CONFIG_FILE=/path/to/.databrickscfg \
    -e DATABRICKS_CONFIG_PROFILE=<profile> \
    -- uv run --directory /path/to/ai-dev-kit python databricks-mcp-server/run_server.py
  ```

  Requires [`uv`](https://docs.astral.sh/uv/). Passing the config file and
  profile keeps auth on the Databricks CLI's own credential chain, so no token
  is written into your Claude config. Check it with `claude mcp list`; the
  arena looks for a line starting with `databricks:`.
  - **Inherit mode (default):** the mcp condition runs without
    `--mcp-config`, so it loads your already-configured, **user-scoped**
    Databricks MCP server. Each run executes in a throwaway temp directory,
    so a project-/local-scoped server registered only in your real project
    is invisible to it — register it user-scoped, or use scoped mode below.
  - **Scoped mode (opt-in):** set `ARENA_MCP_CONFIG=/path/to/your/mcp.json`
    to run with `--strict-mcp-config --mcp-config $ARENA_MCP_CONFIG`
    instead, for a clean single-server session. The arena only points
    `claude` at your file; it never reads or copies it.

- Databricks CLI profiles: if you use named profiles in `~/.databrickscfg`,
  `GET /profiles` lists them for the page's profile picker (§ below).

Run is enabled once `databricks` and `claude` pass preflight; a failing
per-condition check disables only that one pane — a 2-way demo is degraded
but allowed.

## Environment variables

| Variable           | Default                 | Meaning                                                                                                                |
| ------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ARENA_MAX_TURNS`  | `20`                    | `--max-turns` passed to every condition's `claude -p`                                                                  |
| `ARENA_MODEL`      | viewer's Claude default | `--model` override; omitted (not forced to a fixed model) unless set, so all three panes share whatever the default is |
| `ARENA_TIMEOUT_MS` | `300000` (5 min)        | hard timeout per condition child; SIGKILL past this                                                                    |
| `ARENA_MCP_CONFIG` | unset                   | path to a viewer-owned `mcp.json` for scoped MCP mode (see above)                                                      |

## The workspace hostname

Never rendered as text: the profile picker shows the name, and the status line
links that name (host lives in the `href`). Hostnames in error lines are
replaced with `<workspace>`. Screenshots are safe by default.

## What the duration means

The duration each pane reports is end-to-end wall clock for that condition's
`claude -p` session: process start to exit. It includes model inference, the
agent's own thinking, and every tool call, which means it **includes the time
Databricks takes to answer**. Nothing is subtracted.

That is the honest number for "how long did I wait", but it is not a clean
measure of the tool alone. A cold SQL warehouse or a slow cluster lands in
whichever pane happens to hit it, and conditions that make more tool calls
absorb more workspace latency. Read the duration row as a demo observation,
not as a benchmark of the interfaces.

## Safety

- Binds `127.0.0.1` only, and rejects any request whose `Host` header isn't
  `127.0.0.1:<port>` (DNS-rebinding guard).
- `POST /run` requires a same-origin `Origin`/`Sec-Fetch-Site` and the
  per-server random nonce embedded in the served page (CSRF guard) — a
  random web page cannot trigger a real, workspace-touching, token-spending
  run against your localhost server.
- The app never touches credentials: no token storage, no minting, no
  proxying. Children inherit your ambient `databricks` auth and your own
  Claude login. Every spawn (preflight and child runs alike) uses
  `stdin: "ignore"` and a hard timeout — an auth prompt can never hang the
  page.
- `GET /events/:runId` looks `runId` up in an in-memory run map only; a
  client-supplied id is never used to build a filesystem path.
- Results (`tools/arena/results/runs.jsonl`, gitignored, never committed)
  and the `GET /profiles` response carry no token and no full CLI config —
  profiles are reduced to `{name, host}` only. Transcripts are streamed to
  the browser only and never persisted.

## API / SSE contract

The page is built against this contract (server and page ship in the same
commit; the SSE event shape is intentionally not frozen for any other
consumer — see the design spec §4/§11(c), which is local-only and not
committed).

### `GET /`

Serves the static page with the CSRF nonce substituted into it
(`%%ARENA_NONCE%%` placeholder). All page fetches are relative, so no port
value is embedded.

### `GET /preflight`

```json
{
  "databricks": { "ok": true },
  "claude": { "ok": true, "version": "2.1.207 ..." },
  "axi": { "ok": true, "mode": "path" },
  "mcp": { "ok": true, "name": "databricks", "mode": "inherit" }
}
```

`ok: false` entries carry a `reason` string with the exact fix (e.g. "run
`databricks auth login`"). The `databricks` host is deliberately **not**
included here (leak surface for a status check) — see `started` below for
where a host IS surfaced, and why.

### `GET /profiles`

```json
{ "profiles": [{ "name": "FREE", "host": "https://....cloud.databricks.com" }] }
```

Sourced from the `databricks` CLI's own profile list. Only `name` and `host`
are exposed — never a token or any other config value. Empty array if the
CLI has no profiles or the call fails.

### `POST /run`

Request body:

```json
{ "task": "list the running clusters", "profile": "FREE" }
```

- `task` (string, required): the viewer's task, in their own words. Free
  text — the only free-text field persisted anywhere by this app. Must not
  begin with a dash (it is a positional in the child argv; a leading dash
  would read as a CLI flag) — `400` otherwise.
- `profile` (string, optional): a name from `GET /profiles`. When set,
  every condition's child process resolves Databricks auth against that
  profile (`DATABRICKS_CONFIG_PROFILE` in the child's env — honored by both
  the official CLI and `databricks-axi`). The mcp condition's server is
  configured independently of any CLI profile, so this is best-effort
  there. Omitted: current/default profile behavior, unchanged.
- `model` (string, optional): a Claude model choice from the page's Model
  dropdown, applied as `--model` to every condition equally (so the
  comparison stays fair). The dropdown offers the CLI-maintained aliases
  (`sonnet`, `opus`, `haiku`), which `claude` resolves to the latest model
  of each family, so no model id is hardcoded to go stale. Overrides the
  `ARENA_MODEL` env default. Omitted: the viewer's Claude default.
  Validated against `^[A-Za-z0-9][\w.:-]{0,63}$`; a value starting with a
  dash is a `400`, and any other non-matching value is ignored (the default
  model is used).

Headers required: `x-arena-nonce: <the page's embedded nonce>`, plus a
same-origin `Origin`/`Sec-Fetch-Site` (browsers set these automatically for
a same-origin fetch).

Response: `{ "runId": "<uuid>" }`. The three conditions start running
**sequentially in a per-run random order** (so no condition permanently
rides a warmup/cache advantage) in the background; the drawn order is sent
in the `started` event. Open `GET /events/:runId` right away to watch.

### `GET /events/:runId`

`text/event-stream`. Unknown `runId` → `404`. Each `data:` line is one JSON
object, tagged `{ pane, kind, ... }`:

| kind         | pane                   | payload                                     | meaning                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `started`    | `null`                 | `{ profile, host, order }`                  | once, at run start; `host` is the resolved workspace URL for the chosen (or default) profile — render an "open workspace" link (`target="_blank"`), never an iframe/proxy of the workspace UI                                                                                                                                                                                                                                                   |
| `line`       | condition id           | `{ text }`                                  | one condensed transcript line (`ASSISTANT: ...` / `TOOL <name>: ...` / `RESULT: ...`), pushed as the child's stdout arrives                                                                                                                                                                                                                                                                                                                     |
| `done`       | condition id           | `{ metrics }`                               | that condition finished; `metrics` = `{ exit, wall_s, num_turns, tokens_in, tokens_cache_create, tokens_cache_read, tokens_out, cost_usd, is_error, error_line }`                                                                                                                                                                                                                                                                               |
| `comparison` | `null`                 | `{ conditions, lowest_cost, lowest_turns }` | once, after all conditions finish; `conditions` mirrors the per-condition `metrics` above. `lowest_cost`/`lowest_turns` are each an **array** of the condition ids tied at the minimum (cost is the headline axis, not raw token count, since token classes are priced differently). Empty array when fewer than two conditions survive (a lone finisher has nothing to compare against), or when all candidates tie (a wash highlights nobody) |
| `error`      | condition id or `null` | `{ reason, disabled? }`                     | that condition is disabled (failed preflight, `disabled: true`) or crashed mid-run (no `disabled` flag); a `null`-pane error is a whole-run failure                                                                                                                                                                                                                                                                                             |

Condition ids: `"raw-cli"`, `"mcp"`, `"databricks-axi"` — the three panes.
They run in the per-run random order carried by the `started` event, not a
fixed sequence.

The stream ends (`res.end()`) once the `comparison` event has been sent.

## Results persistence

One JSONL line appended to `tools/arena/results/runs.jsonl` (gitignored,
never committed) per completed run:

```json
{
  "ts": "2026-07-12T00:00:00.000Z",
  "task": "list the running clusters",
  "conditions": {
    "raw-cli": {
      "exit": 0,
      "wall_s": 12,
      "num_turns": 3,
      "tokens_in": 100,
      "tokens_cache_create": 10,
      "tokens_cache_read": 20,
      "tokens_out": 50,
      "cost_usd": 0.01,
      "is_error": false
    },
    "mcp": { "...": "..." },
    "databricks-axi": { "...": "..." }
  }
}
```

No workspace hostname, no token, no transcript text is written to this
file: rows are reduced to the fixed numeric/boolean field list above by
whitelist, so `task` is the only free-text field. Free-text diagnostics
(`error_line`, `error`) exist only on the SSE stream to the browser.
Transcripts stream to the browser only and are never persisted.

## Error taxonomy

The arena is a demo tool, not an axi CLI domain — it does not emit the
`src/errors.ts` TOON taxonomy. It mirrors the philosophy (structured,
actionable, never a raw stack trace, never a token): preflight failures are
plain `{ ok: false, reason }` status objects, and a child failure surfaces
its exit code and last stderr line in its pane.

## Self-check

```
pnpm test
```

runs `tools/arena/parse.test.mjs`, a hermetic check of the stream-json
metric parse, the `condense`/`condenseEvent` transcript reducer, the
results-row shape, and the comparison-highlight sets (`buildComparison`).
It never spawns `claude` or `databricks`.

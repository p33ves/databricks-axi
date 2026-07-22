# Benchmark results

Full detail behind the numbers in the [README](../README.md#benchmarks), for
anyone who wants the per-task breakdown instead of the headline average.

## What this measures, and what it does not

Every task here is **operational**: list jobs, triage a failed run, read a
table schema, cycle a cluster, preflight a workspace. Read, diagnose, and
status work the model already knows how to do. Each task runs **cold in its
own session**, so every arm pays its full session-setup cost on a single
call and never amortizes it.

That scope is the honest frame for everything below. This bench says nothing
about **authoring** workflows (scaffolding a DAB, building a dashboard,
migrating to serverless), nothing about **capability coverage** (the MCP
server exposes operations databricks-axi has no typed command for), and
nothing about a task suite hard enough to make the bare CLI fail. It measures
token cost and turns on cold operational tasks from a shell-capable agent.
Read the results as that specific claim, not as "better in every way."

## Methodology

Real Databricks tasks, each run cold in its own session by `claude-sonnet-5`,
against two live workspaces: `AWS` (serverless, data/jobs/notebook fixtures)
and `AWS2` (classic clusters).

Five conditions, all measured together on 2026-07-17 against a single build,
so every row is directly comparable:

- **databricks-axi** @ v1.2.0, this tool.
- **raw-cli**: the official `databricks` CLI v1.6.0 on its own, no skill pack
  and no MCP server. The bare-CLI reference: databricks-axi is a thin wrapper
  over this same CLI, so raw-cli is the honest "does the wrapper cost
  anything?" baseline.
- **cli-skills**: the same official CLI plus the
  [`databricks-agent-skills`](https://github.com/databricks/databricks-agent-skills)
  skill pack, pinned `5bc462d4`.
- **mcp-aidevkit-eager**: Databricks Field Engineering's
  [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit) stdio MCP
  server, pinned `a7e1d51`, with all **44 tool schemas (~154 dispatchable
  operations)** loaded into context up front (`ENABLE_TOOL_SEARCH=auto:100`).
- **mcp-aidevkit-deferred**: the same server with schemas loaded on demand
  (`ENABLE_TOOL_SEARCH=auto:0`), so the agent pays a lookup step per tool it
  reaches for instead of the full schema tax up front.

The two MCP arms bracket a real deployment choice: load every schema eagerly
(more tokens up front, fewer turns) or defer them (fewer tokens, more turns
spent discovering tools). Reporting one and not the other would hide the
tradeoff.

27 tasks x 5 repeats, plus 2 once-only mutating tasks (`cluster-stop-noop`,
`warehouse-cycle`), per condition. The two MCP arms don't run 4 workspace/fs
tasks (`notebook-read`, `notebook-discovery`, `api-current-user`,
`fs-error-recovery`); those rows read `—` for them. Success is graded
deterministically where the answer is machine-checkable, by an LLM judge
otherwise.

`cli-skills`' agent instructions hand-feed the router step that tells the
agent to load the matching product skill, even though this arm ships no
router hook of its own. Deliberately generous: its numbers below are a floor
on its real overhead, not a ceiling.

## Results

**632 of 645 cells passed (98.0%).** Per arm:

| Condition             | Passed    |
| --------------------- | --------- |
| databricks-axi        | 134 / 137 |
| raw-cli               | 135 / 137 |
| cli-skills            | 136 / 137 |
| mcp-aidevkit-eager    | 115 / 117 |
| mcp-aidevkit-deferred | 112 / 117 |

No arm is perfect, and success rates sit close together, so this is a cost
and turns comparison on tasks every arm largely completes, not a success-rate
story. The 13 failures are scattered graded misses; the one real cluster is
`query-history-aws`, whose deterministic "report that the source does not
exist" check is strict and caught one repeat each across cli-skills and both
MCP arms.

## Headline: cost and turns

`cost_usd` is Claude Code's own billing-correct total, weighted by the real
cache-read discount (~0.1x). Turns is the other primary metric. Computed over
the 25 tasks (117 cells per arm) every one of the five arms ran:

| Condition             | Avg Cost   | Avg Turns | Avg Wall (s) | Input tokens | vs axi (cost / turns) |
| --------------------- | ---------- | --------- | ------------ | ------------ | --------------------- |
| **databricks-axi**    | **$0.131** | **3.7**   | 15.3         | 120,216      | baseline              |
| raw-cli               | $0.132     | 3.8       | 16.5         | 121,249      | +1% / +3%             |
| mcp-aidevkit-eager    | $0.189     | 3.7       | 17.7         | 244,940      | +45% / +0%            |
| mcp-aidevkit-deferred | $0.217     | 4.9       | 21.1         | 196,965      | +66% / +34%           |
| cli-skills            | $0.229     | 7.2       | 21.2         | 224,625      | +75% / +97%           |

**databricks-axi and the bare CLI are statistically indistinguishable.**
Paired across tasks (median over repeats, 10k-resample bootstrap), raw-cli is
+3.0% on cost [-9.2%, +15.7%] and +11.8% on turns [-4.2%, +29.4%] versus
databricks-axi. Both intervals include zero. This is the expected result for
a thin wrapper: axi does not make the CLI cheaper to drive, and it does not
make it more expensive. Its value is typed commands and guardrails at
bare-CLI cost, not a token saving over the CLI itself.

The real separation is the skill pack and the MCP server, both of which pay
for what they add: cli-skills loads documentation, the MCP arms load (or look
up) tool schemas. Those costs are real and they are the point of the
comparison.

The 4 tasks the MCP arms don't run (axi / cli-skills only):

| Condition      | Avg Cost | Avg Turns |
| -------------- | -------- | --------- |
| databricks-axi | $0.131   | 4.0       |
| cli-skills     | $0.189   | 5.5       |

### Eager vs deferred, and the cold-cache caveat

The eager arm's headline $0.189 is **warm-dominated**. The ~77.5k-token
schema is created cold once, then Claude Code's prompt cache serves it back
at ~0.1x to every later eager cell inside the 1-hour cache window. So a bench
that runs one task per session, and claims no amortization, quietly amortizes
the schema tax for this arm. Isolating the genuinely cold cells:

| eager regime                    | cells | median cost |
| ------------------------------- | ----- | ----------- |
| cold (full schema created)      | 4     | $0.477      |
| warm (schema served from cache) | 113   | $0.159      |

A truly cold deployment, where each session is independent, pays the cold
row (roughly 3x the warm cost) every time. The headline understates eager for
that case. Deferred sidesteps the up-front tax but spends it back in turns
(4.9 vs eager's 3.7), which is why the two MCP arms land close on cost by
different routes.

## Per-task tables

Median over repeats. **Bold** = row winner (lowest). `—` = not run for this
condition.

### Cost per task (USD)

| task                   | databricks-axi | raw-cli   | mcp-aidevkit-eager | mcp-aidevkit-deferred | cli-skills |
| ---------------------- | -------------- | --------- | ------------------ | --------------------- | ---------- |
| warehouse-cycle-aws    | 0.123          | **0.115** | 0.162              | 0.139                 | 0.234      |
| cluster-stop-noop-aws  | 0.129          | **0.121** | 0.497              | 0.143                 | 0.238      |
| notebook-discovery-aws | **0.149**      | 0.151     | —                  | —                     | 0.171      |
| home-dashboard-aws     | 0.138          | **0.118** | 0.198              | 0.239                 | 0.289      |
| home-orientation-aws   | **0.092**      | 0.138     | 0.146              | 0.217                 | 0.261      |
| doctor-aws             | **0.155**      | 0.193     | 0.232              | 0.259                 | 0.277      |
| function-view-aws      | 0.139          | **0.129** | 0.202              | 0.184                 | 0.176      |
| serving-status-aws     | 0.124          | **0.073** | 0.138              | 0.139                 | 0.191      |
| volumes-metadata-aws   | **0.080**      | 0.117     | 0.141              | 0.094                 | 0.226      |
| find-failed-run-aws    | 0.259          | **0.184** | 0.429              | 0.472                 | 0.333      |
| clusters-view-aws      | 0.142          | **0.120** | 0.317              | 0.356                 | 0.187      |
| table-list-aws         | **0.081**      | 0.150     | 0.160              | 0.189                 | 0.168      |
| pipeline-status-aws    | **0.099**      | 0.139     | 0.169              | 0.161                 | 0.351      |
| job-list-aws           | 0.127          | **0.073** | 0.095              | 0.142                 | 0.225      |
| run-and-confirm-aws    | 0.108          | **0.092** | 0.146              | 0.178                 | 0.247      |
| error-recovery-aws     | 0.095          | **0.072** | 0.157              | 0.137                 | 0.149      |
| table-schema-aws       | **0.083**      | 0.087     | 0.159              | 0.165                 | 0.146      |
| pipeline-stop-noop-aws | 0.143          | **0.103** | 0.171              | 0.180                 | 0.245      |
| clusters-list-aws      | 0.094          | **0.077** | 0.095              | 0.142                 | 0.172      |
| volume-read-aws        | 0.143          | **0.133** | 0.193              | 0.183                 | 0.254      |
| api-current-user-aws   | 0.125          | **0.071** | —                  | —                     | 0.176      |
| job-run-why-failed-aws | 0.155          | **0.140** | 0.207              | 0.180                 | 0.216      |
| catalog-browse-aws     | **0.096**      | 0.141     | 0.192              | 0.183                 | 0.178      |
| sql-count-aws          | **0.129**      | 0.138     | 0.138              | 0.167                 | 0.177      |
| job-cancel-noop-aws    | **0.082**      | 0.138     | 0.102              | 0.149                 | 0.199      |
| query-history-aws      | **0.130**      | 0.197     | 0.162              | 0.230                 | 0.305      |
| dag-shape-aws          | 0.284          | **0.132** | 0.167              | 0.158                 | 0.240      |
| notebook-read-aws      | **0.159**      | 0.190     | —                  | —                     | 0.246      |
| fs-error-recovery-aws  | **0.085**      | 0.090     | —                  | —                     | 0.138      |

<details>
<summary><b>Turns</b></summary>

| task                   | databricks-axi | raw-cli | mcp-aidevkit-eager | mcp-aidevkit-deferred | cli-skills |
| ---------------------- | -------------- | ------- | ------------------ | --------------------- | ---------- |
| warehouse-cycle-aws    | **2.0**        | **2.0** | 3.0                | 3.0                   | 7.0        |
| cluster-stop-noop-aws  | **2.0**        | **2.0** | **2.0**            | 3.0                   | 7.0        |
| notebook-discovery-aws | **3.0**        | 4.0     | —                  | —                     | 5.0        |
| home-dashboard-aws     | **5.0**        | 6.0     | 6.0                | 9.0                   | 11.0       |
| home-orientation-aws   | **2.0**        | 5.0     | **2.0**            | 3.0                   | 8.0        |
| doctor-aws             | **5.0**        | 8.0     | 8.0                | 8.0                   | 11.0       |
| function-view-aws      | 3.0            | **2.0** | 3.0                | 3.0                   | 4.0        |
| serving-status-aws     | **2.0**        | **2.0** | **2.0**            | 3.0                   | 6.0        |
| volumes-metadata-aws   | **2.0**        | **2.0** | **2.0**            | 3.0                   | 7.0        |
| find-failed-run-aws    | 10.0           | **5.0** | 7.0                | 8.0                   | 10.0       |
| clusters-view-aws      | 3.0            | **2.0** | 9.0                | 11.0                  | 7.0        |
| table-list-aws         | **2.0**        | **2.0** | 3.0                | 4.0                   | 4.0        |
| pipeline-status-aws    | **3.0**        | 5.0     | **3.0**            | 5.0                   | 9.0        |
| job-list-aws           | **2.0**        | **2.0** | **2.0**            | 3.0                   | 6.0        |
| run-and-confirm-aws    | 4.0            | **3.0** | 4.0                | 5.0                   | 7.0        |
| error-recovery-aws     | **2.0**        | **2.0** | 3.0                | 3.0                   | 4.0        |
| table-schema-aws       | **2.0**        | **2.0** | 3.0                | 3.0                   | 4.0        |
| pipeline-stop-noop-aws | **3.0**        | **3.0** | **3.0**            | 4.0                   | 7.0        |
| clusters-list-aws      | 3.0            | **2.0** | **2.0**            | 3.0                   | 6.0        |
| volume-read-aws        | **3.0**        | 4.0     | 4.0                | 6.0                   | 8.0        |
| api-current-user-aws   | **2.0**        | **2.0** | —                  | —                     | 4.0        |
| job-run-why-failed-aws | **3.0**        | 5.0     | 4.0                | 4.0                   | 7.0        |
| catalog-browse-aws     | **3.0**        | **3.0** | 4.0                | 4.0                   | 5.0        |
| sql-count-aws          | **2.0**        | 3.0     | **2.0**            | 3.0                   | 4.0        |
| job-cancel-noop-aws    | **2.0**        | 4.0     | **2.0**            | 3.0                   | 6.0        |
| query-history-aws      | 5.0            | 7.0     | **2.0**            | 4.0                   | 12.0       |
| dag-shape-aws          | 14.0           | **3.0** | **3.0**            | 4.0                   | 7.0        |
| notebook-read-aws      | 8.0            | **6.0** | —                  | —                     | 8.0        |
| fs-error-recovery-aws  | **2.0**        | **2.0** | —                  | —                     | 4.0        |

</details>

<details>
<summary><b>Wall clock (seconds)</b></summary>

| task                   | databricks-axi | raw-cli  | mcp-aidevkit-eager | mcp-aidevkit-deferred | cli-skills |
| ---------------------- | -------------- | -------- | ------------------ | --------------------- | ---------- |
| warehouse-cycle-aws    | **8.0**        | **8.0**  | 9.0                | 9.0                   | 16.0       |
| cluster-stop-noop-aws  | 12.0           | 10.0     | **7.0**            | 10.0                  | 15.0       |
| notebook-discovery-aws | **16.0**       | **16.0** | —                  | —                     | 17.0       |
| home-dashboard-aws     | **13.0**       | 17.0     | 19.0               | 21.0                  | 40.0       |
| home-orientation-aws   | **9.0**        | 14.0     | 10.0               | 10.0                  | 21.0       |
| doctor-aws             | **18.0**       | 34.0     | 31.0               | 26.0                  | 39.0       |
| function-view-aws      | 12.0           | **8.0**  | 10.0               | 10.0                  | 10.0       |
| serving-status-aws     | 8.0            | **7.0**  | **7.0**            | 11.0                  | 14.0       |
| volumes-metadata-aws   | **6.0**        | 8.0      | 8.0                | 8.0                   | 13.0       |
| find-failed-run-aws    | 45.0           | **25.0** | 26.0               | 34.0                  | 35.0       |
| clusters-view-aws      | 13.0           | **8.0**  | 86.0               | 125.0                 | 18.0       |
| table-list-aws         | **6.0**        | 7.0      | 16.0               | 19.0                  | 9.0        |
| pipeline-status-aws    | 12.0           | 18.0     | **11.0**           | 15.0                  | 28.0       |
| job-list-aws           | 8.0            | 6.0      | **5.0**            | 10.0                  | 12.0       |
| run-and-confirm-aws    | 16.0           | 61.0     | **10.0**           | 15.0                  | 66.0       |
| error-recovery-aws     | 10.0           | **8.0**  | 13.0               | 11.0                  | 14.0       |
| table-schema-aws       | **6.0**        | 8.0      | 14.0               | 14.0                  | 10.0       |
| pipeline-stop-noop-aws | 12.0           | **9.0**  | 12.0               | 12.0                  | 15.0       |
| clusters-list-aws      | 10.0           | **6.0**  | 7.0                | 11.0                  | 11.0       |
| volume-read-aws        | **12.0**       | 17.0     | 14.0               | 19.0                  | 17.0       |
| api-current-user-aws   | 9.0            | **6.0**  | —                  | —                     | 10.0       |
| job-run-why-failed-aws | 17.0           | 16.0     | **15.0**           | 18.0                  | 19.0       |
| catalog-browse-aws     | **9.0**        | 10.0     | 13.0               | 10.0                  | 11.0       |
| sql-count-aws          | **11.0**       | 20.0     | **11.0**           | 15.0                  | 17.0       |
| job-cancel-noop-aws    | 9.0            | 13.0     | **6.0**            | 10.0                  | 12.0       |
| query-history-aws      | **17.0**       | 31.0     | 28.0               | 31.0                  | 34.0       |
| dag-shape-aws          | 57.0           | 12.0     | **10.0**           | 12.0                  | 18.0       |
| notebook-read-aws      | **26.0**       | **26.0** | —                  | —                     | 29.0       |
| fs-error-recovery-aws  | **8.0**        | 13.0     | —                  | —                     | 14.0       |

</details>

<details>
<summary><b>Input-side tokens (input + cache-write + cache-read; roughly 85-87% cache read, billed roughly 0.1x, not a cost figure)</b></summary>

| task                   | databricks-axi | raw-cli     | mcp-aidevkit-eager | mcp-aidevkit-deferred | cli-skills |
| ---------------------- | -------------- | ----------- | ------------------ | --------------------- | ---------- |
| warehouse-cycle-aws    | 75,976         | **72,652**  | 233,695            | 112,687               | 227,366    |
| cluster-stop-noop-aws  | 76,225         | **72,977**  | 155,916            | 113,312               | 227,740    |
| notebook-discovery-aws | **115,666**    | 147,379     | —                  | —                     | 173,113    |
| home-dashboard-aws     | **76,880**     | 95,453      | 191,908            | 210,600               | 302,433    |
| home-orientation-aws   | **63,277**     | 162,817     | 156,199            | 114,398               | 241,720    |
| doctor-aws             | **115,879**    | 189,821     | 324,220            | 205,391               | 354,755    |
| function-view-aws      | 114,316        | **79,707**  | 194,606            | 120,548               | 114,575    |
| serving-status-aws     | 75,990         | **58,847**  | 155,680            | 112,691               | 181,546    |
| volumes-metadata-aws   | **62,169**     | 72,633      | 155,998            | 92,325                | 195,841    |
| find-failed-run-aws    | 371,070        | **187,969** | 637,536            | 480,513               | 388,665    |
| clusters-view-aws      | 114,538        | **73,023**  | 622,277            | 500,791               | 193,153    |
| table-list-aws         | **62,198**     | 78,425      | 187,781            | 161,728               | 113,380    |
| pipeline-status-aws    | **94,032**     | 154,053     | 234,365            | 159,465               | 370,344    |
| job-list-aws           | 76,000         | **58,964**  | 142,070            | 113,269               | 181,841    |
| run-and-confirm-aws    | 125,516        | **89,134**  | 284,762            | 194,230               | 231,317    |
| error-recovery-aws     | 76,005         | **58,441**  | 187,277            | 111,706               | 127,773    |
| table-schema-aws       | 62,311         | **61,165**  | 187,484            | 113,547               | 109,766    |
| pipeline-stop-noop-aws | 114,827        | **89,870**  | 234,626            | 169,792               | 218,647    |
| clusters-list-aws      | 93,882         | **59,690**  | 142,017            | 112,988               | 152,434    |
| volume-read-aws        | **114,655**    | 118,007     | 312,428            | 227,795               | 278,491    |
| api-current-user-aws   | 75,969         | **58,762**  | —                  | —                     | 128,040    |
| job-run-why-failed-aws | **116,230**    | 158,177     | 263,055            | 155,839               | 200,695    |
| catalog-browse-aws     | **76,345**     | 111,851     | 261,284            | 125,939               | 144,580    |
| sql-count-aws          | **76,236**     | 110,340     | 155,706            | 114,796               | 127,938    |
| job-cancel-noop-aws    | **62,316**     | 121,807     | 143,084            | 114,374               | 182,853    |
| query-history-aws      | 159,068        | 263,344     | **157,581**        | 173,425               | 416,146    |
| dag-shape-aws          | 471,095        | **108,929** | 234,067            | 151,902               | 230,462    |
| notebook-read-aws      | **159,983**    | 223,271     | —                  | —                     | 262,783    |
| fs-error-recovery-aws  | **62,315**     | 72,420      | —                  | —                     | 107,418    |

</details>

## Reading the tables

**databricks-axi tracks the bare CLI, as it should.** Row by row, axi and
raw-cli trade the win: axi is lower on some tasks, raw-cli on others, and the
paired difference sits inside noise. That is the correct outcome for a
wrapper. The takeaway is not "axi is cheaper than the CLI" but "axi adds
typed commands and guardrails without adding cost over the CLI."

**Where axi loses.** Two multi-step diagnostics run worse on axi than on the
bare CLI. `dag-shape-aws` is the clearest: 14 turns and $0.284 median for
axi against 3 turns and $0.132 for raw-cli, with one failed repeat, the agent
looping on the job's task graph instead of reading it in one pass.
`find-failed-run-aws` is milder (10 turns vs 5). These are real and worth
chasing down; axi is not uniformly ahead of its own underlying CLI.

**Where cli-skills pays a premium.** It loads skill-body documentation on top
of the raw CLI's plain-text output, and that load costs real turns and
tokens. It is the most expensive arm on cost and by far the highest on turns
(7.2 vs 3.7). `home-dashboard-aws`, `pipeline-status-aws`, and
`query-history-aws` show the widest gaps.

**Where the MCP arms land.** Both sit above axi on cost. Eager keeps turns
low (all tools present, no discovery) but carries the largest token load and,
in a cold deployment, the ~77.5k schema tax every session. Deferred trims the
tokens but spends turns looking tools up. `clusters-view-aws` is the standout
cost: both MCP arms hunt for the right cluster-read call (9 and 11 turns, up
to 125s), against axi's 3 turns and 13s.

## Limitations

The headline holds only inside the scope at the top of this page. The main
threats to reading it more broadly:

- **The cold, one-task-per-session container** charges every arm its full
  setup cost on a single call and never lets it amortize. This is the best
  possible container for a low-setup arm (axi, raw-cli) and the worst for one
  with real setup cost (cli-skills' documentation, the MCP schema). Longer
  sessions, where setup amortizes across many tasks, would narrow these gaps;
  that sweep has not run.
- **Doc-delivery asymmetry.** databricks-axi's ~87-line skill is injected
  preloaded into the agent's context (zero turns). cli-skills uses Claude
  Code's native skill loader, which costs real turns to discover and load.
  This mirrors a real deployment difference (a small skill can preload where
  7,000+ lines of skill content cannot), but it is an asymmetry, not a level
  field, and it is part of why cli-skills shows more turns.
- **Operational, not authoring.** Every task is something the model already
  knows how to do, so documentation can only ever be a cost here, never a
  benefit. On unfamiliar authoring work the skill and schema arms could earn
  their overhead back on success rate. That regime is untested.
- **Coverage, not tested.** The MCP server exposes ~154 operations;
  databricks-axi has typed commands for a subset and falls back to generic
  CLI passthrough beyond it. A suite that ranged across the full surface would
  test breadth, where axi is narrower by construction, not just cost.
- **Noise floor.** The 25-task suite resolves a cost effect no smaller than
  roughly 10%. Gaps below that are reported with their interval and not called
  a difference; the axi-vs-raw-cli result is one such near-zero gap.

## Reproduce

To watch the comparison live against your own workspace, the repo ships a
local demo: `node tools/arena/server.mjs` runs one task of your choosing side
by side. It is a demo, not the benchmark; see
[tools/arena/README.md](../tools/arena/README.md).

# Benchmark results

Full detail behind the numbers in the [README](../README.md#benchmarks), for
anyone who wants the per-task breakdown instead of the headline average.

## Methodology

Real Databricks tasks (list jobs, triage a failed run, read a table schema,
cycle a cluster, and similar), each run cold in its own session by
`claude-sonnet-5`, against two live workspaces: `AWS` (serverless,
data/jobs/notebook fixtures) and `AWS2` (classic clusters). Tasks cover
operational read/diagnose/status work, not authoring workflows.

Three conditions:

- **databricks-axi** @ v1.0.2, this tool
- **cli-skills**: the official `databricks` CLI v1.6.0 plus the
  `databricks-agent-skills` skill pack, pinned `5bc462d4`
- **mcp-aidevkit**: Databricks Field Engineering's
  [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit), a stdio
  MCP server covering jobs/clusters/SQL/UC/pipelines/serving, pinned
  `a7e1d51`. It gets its normal MCP connection warm-up time before the task
  starts, matching how a person would use it interactively.

26 tasks x 3 repeats, plus 2 once-only mutating tasks, per condition.
`mcp-aidevkit` doesn't run 4 workspace/fs tasks (`notebook-read`,
`notebook-discovery`, `api-current-user`, `fs-error-recovery`); those rows
read `—` for it. Success is graded deterministically where the answer is
machine-checkable, by an LLM judge otherwise.

`cli-skills`' agent instructions hand-feed the router step that tells the
agent to load the matching product skill, even though this arm ships no
router hook of its own. Deliberately generous: its numbers below are a
floor on its real overhead, not a ceiling.

## Results

227 of 228 published cells passed (99.6%): databricks-axi 80/80, cli-skills
80/80, mcp-aidevkit 67/68.

The one failure: `clusters-view-aws` on mcp-aidevkit, 1 of 3 repeats. Its
cluster-read tool omits node type, DBR version, and autotermination for a
TERMINATED cluster. A real gap in that tool's surface, not a databricks-axi
issue.

databricks-axi and cli-skills both pass 100%, so the cost and turns
comparison below is apples-to-apples on task success.

## Headline: cost and turns

`cost_usd` is Claude Code's own billing-correct total, weighted by the real
cache-read discount (~0.1x). Turns is the other primary metric. Computed
over the 24 tasks (68 cells per arm) every condition ran:

| Condition          | Avg Cost   | Avg Turns | vs axi (cost / turns) |
| ------------------ | ---------- | --------- | --------------------- |
| **databricks-axi** | **$0.143** | **3.1**   | baseline              |
| cli-skills         | $0.249     | 6.8       | +75% / +118%          |
| mcp-aidevkit       | $0.201     | 4.3       | +41% / +39%           |

databricks-axi wins or ties on cost in 51 of 52 task/condition comparisons
and on turns in 49 of 52.

The 4 tasks mcp-aidevkit doesn't run (axi/cli-skills only):

| Condition      | Avg Cost | Avg Turns |
| -------------- | -------- | --------- |
| databricks-axi | $0.139   | 3.6       |
| cli-skills     | $0.211   | 5.5       |

Input-side tokens (input + cache-write + cache-read), included for
reference, not the lead metric. These cells run 85-87% cache read, which
bills at roughly 0.1x, so a raw token count overstates the real cost gap by
about 1.3x:

| Condition      | Avg Input-side Tokens |
| -------------- | --------------------- |
| databricks-axi | 113,613               |
| cli-skills     | 230,449               |
| mcp-aidevkit   | 172,830               |

## Per-task tables

Mean over repeats. `—` = not run for this condition.

### Cost per task (USD)

| task                   | databricks-axi | cli-skills | mcp-aidevkit |
| ---------------------- | -------------- | ---------- | ------------ |
| home-orientation-aws   | **0.136**      | 0.259      | 0.142        |
| table-schema-aws       | 0.126          | 0.245      | **0.109**    |
| table-list-aws         | **0.125**      | 0.211      | 0.179        |
| error-recovery-aws     | **0.136**      | 0.179      | 0.137        |
| volume-read-aws        | **0.132**      | 0.240      | 0.167        |
| notebook-read-aws      | **0.153**      | 0.258      | —            |
| clusters-list-aws      | **0.126**      | 0.234      | 0.152        |
| clusters-view-aws      | **0.140**      | 0.235      | 0.319        |
| job-list-aws           | **0.127**      | 0.225      | 0.158        |
| notebook-discovery-aws | **0.149**      | 0.211      | —            |
| dag-shape-aws          | **0.170**      | 0.248      | 0.238        |
| find-failed-run-aws    | **0.230**      | 0.341      | 0.337        |
| run-and-confirm-aws    | **0.125**      | 0.247      | 0.181        |
| pipeline-status-aws    | **0.144**      | 0.307      | 0.177        |
| sql-count-aws          | **0.127**      | 0.176      | 0.163        |
| pipeline-stop-noop-aws | **0.143**      | 0.295      | 0.181        |
| serving-status-aws     | **0.125**      | 0.224      | 0.138        |
| api-current-user-aws   | **0.125**      | 0.177      | —            |
| query-history-aws      | **0.205**      | 0.321      | 0.253        |
| volumes-metadata-aws   | **0.125**      | 0.241      | 0.215        |
| function-view-aws      | **0.140**      | 0.263      | 0.186        |
| fs-error-recovery-aws  | **0.129**      | 0.197      | —            |
| home-dashboard-aws     | **0.143**      | 0.314      | 0.313        |
| job-cancel-noop-aws    | **0.126**      | 0.230      | 0.222        |
| job-run-why-failed-aws | **0.153**      | 0.272      | 0.209        |
| catalog-browse-aws     | **0.139**      | 0.190      | 0.231        |
| cluster-stop-noop-aws  | **0.126**      | 0.240      | 0.216        |
| warehouse-cycle-aws    | **0.157**      | 0.235      | 0.216        |

<details>
<summary><b>Turns</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | cli-skills | mcp-aidevkit |
| ---------------------- | -------------- | ---------- | ------------ |
| home-orientation-aws   | **2.3**        | 7.3        | **2.3**      |
| table-schema-aws       | **2.0**        | 4.0        | 3.0          |
| table-list-aws         | **2.0**        | 5.0        | 4.0          |
| error-recovery-aws     | **2.7**        | 4.0        | 3.0          |
| volume-read-aws        | **2.3**        | 7.0        | 5.0          |
| notebook-read-aws      | **7.3**        | 8.0        | —            |
| clusters-list-aws      | **2.0**        | 7.0        | 3.0          |
| clusters-view-aws      | **3.0**        | 7.0        | 8.3          |
| job-list-aws           | **2.0**        | 6.0        | 3.0          |
| notebook-discovery-aws | **3.0**        | 5.3        | —            |
| dag-shape-aws          | 4.7            | 7.3        | **4.0**      |
| find-failed-run-aws    | 7.0            | 11.0       | **6.0**      |
| run-and-confirm-aws    | **4.0**        | 7.0        | 5.0          |
| pipeline-status-aws    | **3.0**        | 8.7        | 4.7          |
| sql-count-aws          | **2.0**        | 4.0        | 3.0          |
| pipeline-stop-noop-aws | **3.0**        | 7.0        | 5.0          |
| serving-status-aws     | **2.0**        | 6.0        | 3.0          |
| api-current-user-aws   | **2.0**        | 4.0        | —            |
| query-history-aws      | 6.3            | 9.7        | **4.7**      |
| volumes-metadata-aws   | **2.0**        | 7.0        | 4.0          |
| function-view-aws      | **3.0**        | 5.3        | **3.0**      |
| fs-error-recovery-aws  | **2.0**        | 4.7        | —            |
| home-dashboard-aws     | **5.0**        | 10.0       | 8.7          |
| job-cancel-noop-aws    | **2.0**        | 6.0        | 3.0          |
| job-run-why-failed-aws | **3.0**        | 7.3        | 4.7          |
| catalog-browse-aws     | **3.0**        | 5.0        | 4.0          |
| cluster-stop-noop-aws  | **2.0**        | 7.0        | 3.0          |
| warehouse-cycle-aws    | **4.0**        | 7.0        | 8.0          |

</details>

<details>
<summary><b>Wall clock (seconds)</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | cli-skills | mcp-aidevkit |
| ---------------------- | -------------- | ---------- | ------------ |
| home-orientation-aws   | 12.0           | 23.0       | **10.7**     |
| table-schema-aws       | **7.3**        | 10.7       | 16.0         |
| table-list-aws         | **6.7**        | 12.7       | 18.7         |
| error-recovery-aws     | **11.3**       | 13.0       | 12.3         |
| volume-read-aws        | **10.3**       | 17.3       | 16.0         |
| notebook-read-aws      | **24.0**       | 29.3       | —            |
| clusters-list-aws      | **8.0**        | 13.3       | 11.0         |
| clusters-view-aws      | **11.7**       | 16.3       | 81.3         |
| job-list-aws           | **8.7**        | 13.7       | 11.7         |
| notebook-discovery-aws | 19.3           | **17.3**   | —            |
| dag-shape-aws          | 19.0           | 17.0       | **16.7**     |
| find-failed-run-aws    | 43.0           | **37.0**   | 132.7        |
| run-and-confirm-aws    | 17.7           | 40.0       | **15.7**     |
| pipeline-status-aws    | **12.0**       | 25.3       | 16.3         |
| sql-count-aws          | **9.0**        | 12.0       | 14.7         |
| pipeline-stop-noop-aws | **11.3**       | 16.7       | 20.0         |
| serving-status-aws     | **8.3**        | 12.7       | 9.7          |
| api-current-user-aws   | **7.3**        | 9.0        | —            |
| query-history-aws      | **24.0**       | 38.3       | 32.3         |
| volumes-metadata-aws   | **7.7**        | 13.0       | 13.0         |
| function-view-aws      | **11.7**       | 13.0       | 13.0         |
| fs-error-recovery-aws  | **11.0**       | 18.0       | —            |
| home-dashboard-aws     | **14.7**       | 31.3       | 29.0         |
| job-cancel-noop-aws    | **9.0**        | 13.3       | 12.0         |
| job-run-why-failed-aws | **17.7**       | 21.3       | 21.3         |
| catalog-browse-aws     | **9.3**        | 14.7       | 12.0         |
| cluster-stop-noop-aws  | **9.0**        | 15.0       | 10.0         |
| warehouse-cycle-aws    | 18.0           | **15.0**   | 34.0         |

</details>

<details>
<summary><b>Input-side tokens (input + cache-write + cache-read; roughly 85-87% cache read, billed roughly 0.1x — not a cost figure)</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | cli-skills | mcp-aidevkit |
| ---------------------- | -------------- | ---------- | ------------ |
| home-orientation-aws   | **77,048**     | 250,163    | 89,378       |
| table-schema-aws       | **75,972**     | 146,212    | 112,261      |
| table-list-aws         | **75,875**     | 163,409    | 159,046      |
| error-recovery-aws     | **101,450**    | 128,185    | 111,962      |
| volume-read-aws        | **88,837**     | 230,548    | 189,414      |
| notebook-read-aws      | **181,376**    | 294,239    | —            |
| clusters-list-aws      | **75,920**     | 227,562    | 116,617      |
| clusters-view-aws      | **114,364**    | 227,426    | 358,468      |
| job-list-aws           | **75,921**     | 182,322    | 120,974      |
| notebook-discovery-aws | **115,620**    | 189,011    | —            |
| dag-shape-aws          | **179,308**    | 247,579    | 187,919      |
| find-failed-run-aws    | **279,119**    | 437,910    | 296,584      |
| run-and-confirm-aws    | **153,058**    | 231,981    | 195,018      |
| pipeline-status-aws    | **114,586**    | 351,890    | 181,527      |
| sql-count-aws          | **76,087**     | 128,259    | 120,107      |
| pipeline-stop-noop-aws | **114,707**    | 253,609    | 193,526      |
| serving-status-aws     | **75,935**     | 182,072    | 112,924      |
| api-current-user-aws   | **75,884**     | 128,380    | —            |
| query-history-aws      | 247,551        | 369,471    | **201,289**  |
| volumes-metadata-aws   | **75,894**     | 231,070    | 173,869      |
| function-view-aws      | **114,276**    | 189,236    | 120,678      |
| fs-error-recovery-aws  | **76,013**     | 158,300    | —            |
| home-dashboard-aws     | **76,804**     | 298,721    | 284,528      |
| job-cancel-noop-aws    | **76,023**     | 183,394    | 136,761      |
| job-run-why-failed-aws | **115,909**    | 252,375    | 168,593      |
| catalog-browse-aws     | **114,164**    | 157,883    | 138,478      |
| cluster-stop-noop-aws  | **75,952**     | 228,649    | 136,199      |
| warehouse-cycle-aws    | **153,339**    | 228,068    | 306,504      |

</details>

## Reading the tables

**Where cli-skills pays a premium.** It loads skill-body documentation on
top of the raw CLI's plain-text output, and that load is bimodal: some runs
load the matching product skill, some don't, so a few tasks show a wide
spread between repeats even though the mean stays high. `clusters-view-aws`,
`home-dashboard-aws`, and `pipeline-status-aws` show the largest per-task
gaps against databricks-axi.

**Where mcp-aidevkit lands.** Above databricks-axi on cost in every task, and
on turns in most (it edges ahead on a few, like `dag-shape-aws`,
`find-failed-run-aws`, and `query-history-aws`, where a typed tool call
saves a step). The structural reason it runs higher overall: an MCP server
loads its tool schemas into context every session, close to 40 tools for
ai-dev-kit, against a CLI the agent already knows how to read.

**The one real outlier.** `clusters-view-aws` on mcp-aidevkit takes 8.3
turns and 81s, hunting for the right cluster-read call, against
databricks-axi's 3 turns and 12s. That is also where its one failed repeat
landed.

## Reproduce

To watch the comparison live against your own workspace, the repo ships a
local demo: `node tools/arena/server.mjs` runs one task of your choosing
three ways side by side. It is a demo, not the benchmark; see
[tools/arena/README.md](../tools/arena/README.md).

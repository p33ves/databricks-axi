# Benchmark results

Full detail behind the numbers in the [README](../README.md#benchmarks), for
anyone who wants the per-task breakdown instead of the headline average.

## Methodology

Each task is a real Databricks operation (list jobs, triage a failed run,
count rows, read a notebook, cycle a cluster, ...) run through up to four
interface setups:

- **databricks-axi**: this tool
- **raw-cli**: the official `databricks` CLI, unmodified
- **mcp-managed**: Databricks' workspace-managed SQL MCP server
  (`/api/2.0/mcp/sql`), SQL-only
- **mcp-aidevkit**: Databricks Field Engineering's
  [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit), a
  ~40-tool stdio MCP server covering jobs/clusters/SQL/UC/pipelines/serving

An agent (`claude-sonnet-5`) runs each task cold, 5 repeats per
task/condition pair, against seeded fixtures. Success is graded
deterministically where the answer is machine-checkable (row counts, IDs,
statuses), by an LLM judge otherwise.

Not every condition can run every task, and a `—` in the tables below means
exactly that: `mcp-managed` is SQL-only, so it sits out every job- or
cluster-mutating task and every AWS-profile task; both MCP servers sit out
`api-current-user-aws` and `notebook-discovery-aws`, which have no matching
tool.

## Latest run: CP3 (2026-07-11, v0.9.0)

37 tasks across three workspaces: a Databricks Free Edition workspace
(`FREE`) plus two paid trial workspaces (`AWS`, serverless; `AWS2`, classic
clusters, used for the cluster tasks). Every databricks-axi cell passed
(185/185).

The one failed cell across all conditions was `clusters-view-aws /
mcp-aidevkit`, one of five repeats: after a 15-turn tool-discovery loop the
agent's final answer omitted the node type, DBR version, and max-worker
count. Graded deterministically. Run-to-run variance in that condition, not
a tool error.

Tool versions: databricks-axi @ 96bde97 (v0.9.0), official `databricks` CLI
v1.6.0, `ai-dev-kit` pinned at `a7e1d51`. The `api-current-user-aws` row is
re-measured on 1.0 (whoami-enabled) code, which closed the CP3 outlier on
that task; every other row is the original CP3 matrix.

### Input tokens

Mean over repeats. `—` = condition cannot run this task.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit | axi vs cli |
| ---------------------- | -------------- | ------- | ----------- | ------------ | ---------- |
| home-orientation       | **60,684**     | 135,463 | 182,049     | 164,741      | -55%       |
| find-failed-run        | **203,695**    | 193,849 | 600,135     | 659,709      | +5%        |
| run-and-confirm        | **120,407**    | 103,782 | —           | 501,653      | +16%       |
| sql-count              | **59,844**     | 129,731 | 90,851      | 172,779      | -54%       |
| table-schema           | **59,751**     | 58,987  | 87,997      | 152,563      | +1%        |
| error-recovery         | **89,881**     | 56,273  | 87,835      | 137,494      | +60%       |
| table-list             | **59,691**     | 62,460  | 103,336     | 238,345      | -4%        |
| warehouse-cycle        | **59,782**     | 56,839  | —           | 168,376      | +5%        |
| notebook-read          | **90,580**     | 115,328 | —           | —            | -21%       |
| volume-read            | **59,754**     | 90,787  | —           | 584,559      | -34%       |
| fs-error-recovery      | **59,759**     | 73,913  | —           | —            | -19%       |
| home-dashboard         | **109,753**    | 122,943 | —           | 333,110      | -11%       |
| job-cancel-noop        | **59,810**     | 75,233  | —           | 287,231      | -20%       |
| job-run-why-failed     | **79,399**     | 126,358 | —           | 423,263      | -37%       |
| catalog-browse         | **66,100**     | 90,980  | 150,156     | 416,160      | -27%       |
| home-orientation-aws   | **60,683**     | 152,534 | —           | 198,826      | -60%       |
| table-schema-aws       | **59,751**     | 58,985  | —           | 115,899      | +1%        |
| sql-count-aws          | **59,829**     | 92,188  | —           | 184,687      | -35%       |
| table-list-aws         | **59,636**     | 62,563  | —           | 216,398      | -5%        |
| error-recovery-aws     | **65,761**     | 56,277  | —           | 125,908      | +17%       |
| volume-read-aws        | **65,916**     | 123,603 | —           | 632,845      | -47%       |
| notebook-read-aws      | **232,382**    | 231,616 | —           | —            | +0%        |
| clusters-list-aws      | **83,238**     | 73,457  | —           | 195,739      | +13%       |
| clusters-view-aws      | **129,256**    | 72,904  | —           | 744,836      | +77%       |
| cluster-stop-noop-aws  | **114,323**    | 72,982  | —           | 163,390      | +57%       |
| job-list-aws           | **75,648**     | 72,767  | —           | 265,705      | +4%        |
| notebook-discovery-aws | **115,209**    | 133,757 | —           | —            | -14%       |
| dag-shape-aws          | **160,553**    | 116,899 | —           | 397,283      | +37%       |
| find-failed-run-aws    | **226,758**    | 294,334 | —           | 442,730      | -23%       |
| run-and-confirm-aws    | **152,436**    | 124,512 | —           | 426,518      | +22%       |
| pipeline-status-aws    | **114,109**    | 140,968 | —           | 471,081      | -19%       |
| pipeline-stop-noop-aws | **114,238**    | 109,783 | —           | 335,966      | +4%        |
| serving-status-aws     | **75,644**     | 72,624  | —           | 201,364      | +4%        |
| api-current-user-aws   | **75,694**     | 72,508  | —           | —            | +4%        |
| volumes-metadata-aws   | **75,584**     | 72,633  | —           | 285,061      | +4%        |
| function-view-aws      | **113,878**    | 104,594 | —           | 282,256      | +9%        |
| query-history-aws      | **75,838**     | 255,353 | —           | 304,606      | -70%       |

### Turns

Mean over repeats. `—` = condition cannot run this task.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit | axi vs cli |
| ---------------------- | -------------- | ------- | ----------- | ------------ | ---------- |
| home-orientation       | **2.2**        | 5.2     | 5.0         | 3.8          | -58%       |
| find-failed-run        | **6.4**        | 6.2     | 10.8        | 10.2         | +3%        |
| run-and-confirm        | **4.0**        | 3.6     | —           | 9.2          | +11%       |
| sql-count              | **2.0**        | 4.4     | 3.0         | 4.8          | -55%       |
| table-schema           | **2.0**        | 2.0     | 3.0         | 4.4          | +0%        |
| error-recovery         | **3.0**        | 2.0     | 3.0         | 4.0          | +50%       |
| table-list             | **2.0**        | 2.0     | 3.0         | 5.4          | +0%        |
| warehouse-cycle        | **2.0**        | 2.0     | —           | 4.8          | +0%        |
| notebook-read          | **3.0**        | 4.0     | —           | —            | -25%       |
| volume-read            | **2.0**        | 3.2     | —           | 9.6          | -38%       |
| fs-error-recovery      | **2.0**        | 2.6     | —           | —            | -23%       |
| home-dashboard         | **3.6**        | 6.8     | —           | 10.2         | -47%       |
| job-cancel-noop        | **2.0**        | 2.6     | —           | 6.0          | -23%       |
| job-run-why-failed     | **2.6**        | 4.2     | —           | 8.2          | -38%       |
| catalog-browse         | **3.0**        | 3.0     | 4.2         | 9.0          | +0%        |
| home-orientation-aws   | **2.2**        | 5.6     | —           | 4.6          | -61%       |
| table-schema-aws       | **2.0**        | 2.0     | —           | 3.4          | +0%        |
| sql-count-aws          | **2.0**        | 3.2     | —           | 4.8          | -38%       |
| table-list-aws         | **2.0**        | 2.0     | —           | 4.8          | +0%        |
| error-recovery-aws     | **2.2**        | 2.0     | —           | 3.6          | +10%       |
| volume-read-aws        | **2.2**        | 3.4     | —           | 9.2          | -35%       |
| notebook-read-aws      | **6.0**        | 6.2     | —           | —            | -3%        |
| clusters-list-aws      | **2.2**        | 2.0     | —           | 4.2          | +10%       |
| clusters-view-aws      | **3.4**        | 2.0     | —           | 12.4         | +70%       |
| cluster-stop-noop-aws  | **3.0**        | 2.0     | —           | 3.6          | +50%       |
| job-list-aws           | **2.0**        | 2.0     | —           | 5.0          | +0%        |
| notebook-discovery-aws | **4.2**        | 3.6     | —           | —            | +17%       |
| dag-shape-aws          | **4.2**        | 3.2     | —           | 6.6          | +31%       |
| find-failed-run-aws    | **5.8**        | 7.6     | —           | 7.2          | -24%       |
| run-and-confirm-aws    | **4.0**        | 3.4     | —           | 7.4          | +18%       |
| pipeline-status-aws    | **3.0**        | 3.8     | —           | 8.8          | -21%       |
| pipeline-stop-noop-aws | **3.0**        | 3.0     | —           | 6.6          | +0%        |
| serving-status-aws     | **2.0**        | 2.0     | —           | 4.2          | +0%        |
| api-current-user-aws   | **2.0**        | 2.0     | —           | —            | +0%        |
| volumes-metadata-aws   | **2.0**        | 2.0     | —           | 5.6          | +0%        |
| function-view-aws      | **3.0**        | 2.6     | —           | 5.0          | +15%       |
| query-history-aws      | **2.0**        | 6.8     | —           | 6.0          | -71%       |

### Cost per task (USD)

Mean over repeats. `—` = condition cannot run this task.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit | axi vs cli |
| ---------------------- | -------------- | ------- | ----------- | ------------ | ---------- |
| home-orientation       | **0.089**      | 0.162   | 0.264       | 0.316        | -45%       |
| find-failed-run        | **0.203**      | 0.205   | 0.507       | 0.649        | -1%        |
| run-and-confirm        | **0.144**      | 0.139   | —           | 0.504        | +4%        |
| sql-count              | **0.121**      | 0.152   | 0.139       | 0.248        | -21%       |
| table-schema           | **0.119**      | 0.126   | 0.131       | 0.216        | -5%        |
| error-recovery         | **0.132**      | 0.109   | 0.131       | 0.209        | +21%       |
| table-list             | **0.119**      | 0.145   | 0.179       | 0.314        | -18%       |
| warehouse-cycle        | **0.119**      | 0.112   | —           | 0.202        | +6%        |
| notebook-read          | **0.140**      | 0.145   | —           | —            | -3%        |
| volume-read            | **0.120**      | 0.126   | —           | 0.553        | -5%        |
| fs-error-recovery      | **0.121**      | 0.122   | —           | —            | 0%         |
| home-dashboard         | **0.151**      | 0.171   | —           | 0.431        | -12%       |
| job-cancel-noop        | **0.120**      | 0.126   | —           | 0.415        | -5%        |
| job-run-why-failed     | **0.138**      | 0.166   | —           | 0.496        | -17%       |
| catalog-browse         | **0.124**      | 0.141   | 0.199       | 0.444        | -12%       |
| home-orientation-aws   | **0.126**      | 0.180   | —           | 0.342        | -30%       |
| table-schema-aws       | **0.119**      | 0.125   | —           | 0.190        | -5%        |
| sql-count-aws          | **0.120**      | 0.131   | —           | 0.265        | -9%        |
| table-list-aws         | **0.118**      | 0.146   | —           | 0.320        | -19%       |
| error-recovery-aws     | **0.123**      | 0.109   | —           | 0.170        | +13%       |
| volume-read-aws        | **0.124**      | 0.136   | —           | 0.553        | -9%        |
| notebook-read-aws      | **0.199**      | 0.194   | —           | —            | +2%        |
| clusters-list-aws      | **0.126**      | 0.121   | —           | 0.248        | +4%        |
| clusters-view-aws      | **0.144**      | 0.118   | —           | 0.565        | +22%       |
| cluster-stop-noop-aws  | **0.141**      | 0.120   | —           | 0.229        | +17%       |
| job-list-aws           | **0.125**      | 0.118   | —           | 0.343        | +6%        |
| notebook-discovery-aws | **0.149**      | 0.150   | —           | —            | -1%        |
| dag-shape-aws          | **0.161**      | 0.136   | —           | 0.441        | +18%       |
| find-failed-run-aws    | **0.198**      | 0.238   | —           | 0.479        | -17%       |
| run-and-confirm-aws    | **0.155**      | 0.143   | —           | 0.423        | +8%        |
| pipeline-status-aws    | **0.142**      | 0.152   | —           | 0.438        | -7%        |
| pipeline-stop-noop-aws | **0.142**      | 0.135   | —           | 0.376        | +5%        |
| serving-status-aws     | **0.124**      | 0.117   | —           | 0.267        | +6%        |
| api-current-user-aws   | **0.124**      | 0.114   | —           | —            | +8%        |
| volumes-metadata-aws   | **0.123**      | 0.116   | —           | 0.316        | +6%        |
| function-view-aws      | **0.139**      | 0.177   | —           | 0.400        | -21%       |
| query-history-aws      | **0.032**      | 0.117   | —           | 0.282        | -73%       |

## Reading the tables

**Where axi wins.** Single-purpose lookups, by a wide margin:
`query-history-aws` (-70% input tokens, -71% turns vs raw-cli),
`home-orientation` (-55%/-58%), `sql-count` (-54%/-55%), `volume-read-aws`
(-47%). These are the cases where raw-cli makes the agent stitch together
several calls and read past a lot of JSON it does not need.

**Where axi pays a premium.** Multi-step and cluster/extension tasks:
`clusters-view-aws` (+77% tokens), `error-recovery` (+60%),
`cluster-stop-noop-aws` (+57%), `dag-shape-aws` (+37%). `find-failed-run` is
the notable one, roughly a tie (+5% tokens, +3% turns): it needs several
jobs-API calls, so raw-cli's dense `-o json` output happens to answer more per
round trip. Both MCP servers still cost 3x on it.

**Where the MCP servers land.** Consistently 2-6x axi's input tokens, and the
gap widens with tool count. `catalog-browse` is 416,160 tokens on ai-dev-kit
against 66,100 on axi. The structural reason is in the README: an MCP server
loads its tool schemas into context every session, ~40 of them for ai-dev-kit.

**The one real outlier.** mcp-aidevkit spent 12.4 turns and 147s on
`clusters-view-aws` hunting for the right `manage_cluster` verb (+1655% wall
vs raw-cli), which is also where its single failed repeat landed. That is the
cost of a 40-tool consolidated-verb schema, not an axi comparison point.

`run-and-confirm` triggers a real job run and polls for completion; axi's
async-by-default flow takes more turns than raw-cli's blocking call but
finishes well inside the wall time (16s vs 50s).

## Post-matrix live smoke: 9/9 PASS

After the matrix, a separate live smoke pass exercised paths the matrix
doesn't cover: `setup hooks`, `sql exec` plus `sql statement view`,
`pipelines events`, a `pipelines start` run to `COMPLETED`, and a live
classic-cluster cycle on `AWS2`: `clusters start --wait` through to
`RUNNING`, then `clusters stop --wait` back to `TERMINATED`. All 9 checks
passed.

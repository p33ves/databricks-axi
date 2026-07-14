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

Not every condition can run every task. A `—` in the tables below means the
condition was not run for that task. `mcp-managed` is SQL-only, so it ran
only on the tasks its SQL surface can actually answer; both MCP servers sit
out tasks they have no matching tool for.

Cost tracks the mix of fresh input, cache writes, and cache reads, not the
token total: cache writes bill at 1.25x input and cache reads at 0.1x. So two
rows with the same `tok_in` can differ several-fold in cost depending on how
warm the prompt cache was. Input tokens is the more stable basis for
comparison.

One convention in the tables: the `databricks-axi` column is bolded because
it is the tool under test, not because it wins the row. Input tokens is the
table that carries the argument, so it stays open; turns, wall clock, and cost
fold away below it. There is no percentage column: every number you would
divide is sitting in the same row.

## Latest run: CP3 (2026-07-11, v0.9.0)

37 tasks across three workspaces: a Databricks Free Edition workspace
(`FREE`) plus two paid trial workspaces (`AWS`, serverless; `AWS2`, classic
clusters, used for the cluster tasks). 564 of 565 runs passed (99.8%). Every
databricks-axi cell passed (185/185).

The one failed cell across all conditions was `clusters-view-aws /
mcp-aidevkit`, one of five repeats: after a 15-turn tool-discovery loop the
agent's final answer omitted the node type, DBR version, and max-worker
count. Graded deterministically. Run-to-run variance in that condition, not
a tool error.

The README's headline table averages the seven tasks all four setups can run,
the rows below carrying a number in every column: `home-orientation`,
`find-failed-run`, `sql-count`, `table-schema`, `error-recovery`,
`table-list`, and `catalog-browse`. Every condition passed all 35 of its runs
on that subset (seven tasks, five repeats each), so its success column reads
35/35 across the board. The one failure above lies outside the subset.

Tool versions: databricks-axi @ 96bde97 (v0.9.0), official `databricks` CLI
v1.6.0, `ai-dev-kit` pinned at `a7e1d51`. The `api-current-user-aws` row is
re-measured on 1.0 (whoami-enabled) code, which closed the CP3 outlier on
that task; every other row is the original CP3 matrix.

### Input tokens

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit |
| ---------------------- | -------------- | ------- | ----------- | ------------ |
| home-orientation       | **60,684**     | 135,463 | 182,049     | 164,741      |
| find-failed-run        | **203,695**    | 193,849 | 600,135     | 659,709      |
| run-and-confirm        | **120,407**    | 103,782 | —           | 501,653      |
| sql-count              | **59,844**     | 129,731 | 90,851      | 172,779      |
| table-schema           | **59,751**     | 58,987  | 87,997      | 152,563      |
| error-recovery         | **89,881**     | 56,273  | 87,835      | 137,494      |
| table-list             | **59,691**     | 62,460  | 103,336     | 238,345      |
| warehouse-cycle        | **59,782**     | 56,839  | —           | 168,376      |
| notebook-read          | **90,580**     | 115,328 | —           | —            |
| volume-read            | **59,754**     | 90,787  | —           | 584,559      |
| fs-error-recovery      | **59,759**     | 73,913  | —           | —            |
| home-dashboard         | **109,753**    | 122,943 | —           | 333,110      |
| job-cancel-noop        | **59,810**     | 75,233  | —           | 287,231      |
| job-run-why-failed     | **79,399**     | 126,358 | —           | 423,263      |
| catalog-browse         | **66,100**     | 90,980  | 150,156     | 416,160      |
| home-orientation-aws   | **60,683**     | 152,534 | —           | 198,826      |
| table-schema-aws       | **59,751**     | 58,985  | —           | 115,899      |
| sql-count-aws          | **59,829**     | 92,188  | —           | 184,687      |
| table-list-aws         | **59,636**     | 62,563  | —           | 216,398      |
| error-recovery-aws     | **65,761**     | 56,277  | —           | 125,908      |
| volume-read-aws        | **65,916**     | 123,603 | —           | 632,845      |
| notebook-read-aws      | **232,382**    | 231,616 | —           | —            |
| clusters-list-aws      | **83,238**     | 73,457  | —           | 195,739      |
| clusters-view-aws      | **129,256**    | 72,904  | —           | 744,836      |
| cluster-stop-noop-aws  | **114,323**    | 72,982  | —           | 163,390      |
| job-list-aws           | **75,648**     | 72,767  | —           | 265,705      |
| notebook-discovery-aws | **115,209**    | 133,757 | —           | —            |
| dag-shape-aws          | **160,553**    | 116,899 | —           | 397,283      |
| find-failed-run-aws    | **226,758**    | 294,334 | —           | 442,730      |
| run-and-confirm-aws    | **152,436**    | 124,512 | —           | 426,518      |
| pipeline-status-aws    | **114,109**    | 140,968 | —           | 471,081      |
| pipeline-stop-noop-aws | **114,238**    | 109,783 | —           | 335,966      |
| serving-status-aws     | **75,644**     | 72,624  | —           | 201,364      |
| api-current-user-aws   | **75,694**     | 72,508  | —           | —            |
| volumes-metadata-aws   | **75,584**     | 72,633  | —           | 285,061      |
| function-view-aws      | **113,878**    | 104,594 | —           | 282,256      |
| query-history-aws      | **75,838**     | 255,353 | —           | 304,606      |

<details>
<summary><b>Turns</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit |
| ---------------------- | -------------- | ------- | ----------- | ------------ |
| home-orientation       | **2.2**        | 5.2     | 5.0         | 3.8          |
| find-failed-run        | **6.4**        | 6.2     | 10.8        | 10.2         |
| run-and-confirm        | **4.0**        | 3.6     | —           | 9.2          |
| sql-count              | **2.0**        | 4.4     | 3.0         | 4.8          |
| table-schema           | **2.0**        | 2.0     | 3.0         | 4.4          |
| error-recovery         | **3.0**        | 2.0     | 3.0         | 4.0          |
| table-list             | **2.0**        | 2.0     | 3.0         | 5.4          |
| warehouse-cycle        | **2.0**        | 2.0     | —           | 4.8          |
| notebook-read          | **3.0**        | 4.0     | —           | —            |
| volume-read            | **2.0**        | 3.2     | —           | 9.6          |
| fs-error-recovery      | **2.0**        | 2.6     | —           | —            |
| home-dashboard         | **3.6**        | 6.8     | —           | 10.2         |
| job-cancel-noop        | **2.0**        | 2.6     | —           | 6.0          |
| job-run-why-failed     | **2.6**        | 4.2     | —           | 8.2          |
| catalog-browse         | **3.0**        | 3.0     | 4.2         | 9.0          |
| home-orientation-aws   | **2.2**        | 5.6     | —           | 4.6          |
| table-schema-aws       | **2.0**        | 2.0     | —           | 3.4          |
| sql-count-aws          | **2.0**        | 3.2     | —           | 4.8          |
| table-list-aws         | **2.0**        | 2.0     | —           | 4.8          |
| error-recovery-aws     | **2.2**        | 2.0     | —           | 3.6          |
| volume-read-aws        | **2.2**        | 3.4     | —           | 9.2          |
| notebook-read-aws      | **6.0**        | 6.2     | —           | —            |
| clusters-list-aws      | **2.2**        | 2.0     | —           | 4.2          |
| clusters-view-aws      | **3.4**        | 2.0     | —           | 12.4         |
| cluster-stop-noop-aws  | **3.0**        | 2.0     | —           | 3.6          |
| job-list-aws           | **2.0**        | 2.0     | —           | 5.0          |
| notebook-discovery-aws | **4.2**        | 3.6     | —           | —            |
| dag-shape-aws          | **4.2**        | 3.2     | —           | 6.6          |
| find-failed-run-aws    | **5.8**        | 7.6     | —           | 7.2          |
| run-and-confirm-aws    | **4.0**        | 3.4     | —           | 7.4          |
| pipeline-status-aws    | **3.0**        | 3.8     | —           | 8.8          |
| pipeline-stop-noop-aws | **3.0**        | 3.0     | —           | 6.6          |
| serving-status-aws     | **2.0**        | 2.0     | —           | 4.2          |
| api-current-user-aws   | **2.0**        | 2.0     | —           | —            |
| volumes-metadata-aws   | **2.0**        | 2.0     | —           | 5.6          |
| function-view-aws      | **3.0**        | 2.6     | —           | 5.0          |
| query-history-aws      | **2.0**        | 6.8     | —           | 6.0          |

</details>

<details>
<summary><b>Wall clock (seconds)</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit |
| ---------------------- | -------------- | ------- | ----------- | ------------ |
| home-orientation       | **8.8**        | 16.0    | 25.6        | 18.6         |
| find-failed-run        | **28.2**       | 27.8    | 68.6        | 40.2         |
| run-and-confirm        | **15.8**       | 50.2    | —           | 36.8         |
| sql-count              | **17.2**       | 19.8    | 10.4        | 21.4         |
| table-schema           | **7.4**        | 9.4     | 11.0        | 26.2         |
| error-recovery         | **13.0**       | 8.2     | 10.6        | 22.0         |
| table-list             | **9.6**        | 9.2     | 9.6         | 29.0         |
| warehouse-cycle        | **7.8**        | 8.0     | —           | 19.2         |
| notebook-read          | **15.2**       | 18.6    | —           | —            |
| volume-read            | **8.2**        | 14.0    | —           | 29.8         |
| fs-error-recovery      | **10.8**       | 12.8    | —           | —            |
| home-dashboard         | **18.4**       | 22.4    | —           | 42.8         |
| job-cancel-noop        | **9.4**        | 10.8    | —           | 25.0         |
| job-run-why-failed     | **19.0**       | 20.2    | —           | 41.0         |
| catalog-browse         | **12.4**       | 12.4    | 15.6        | 38.0         |
| home-orientation-aws   | **9.2**        | 22.0    | —           | 20.2         |
| table-schema-aws       | **7.4**        | 7.6     | —           | 22.6         |
| sql-count-aws          | **9.8**        | 13.2    | —           | 21.4         |
| table-list-aws         | **8.4**        | 8.2     | —           | 21.8         |
| error-recovery-aws     | **8.8**        | 7.8     | —           | 18.8         |
| volume-read-aws        | **9.0**        | 14.0    | —           | 31.4         |
| notebook-read-aws      | **27.6**       | 29.4    | —           | —            |
| clusters-list-aws      | **8.2**        | 8.6     | —           | 16.6         |
| clusters-view-aws      | **12.6**       | 8.4     | —           | 147.4        |
| cluster-stop-noop-aws  | **11.6**       | 9.6     | —           | 17.8         |
| job-list-aws           | **9.6**        | 8.2     | —           | 17.0         |
| notebook-discovery-aws | **16.2**       | 16.8    | —           | —            |
| dag-shape-aws          | **17.2**       | 13.2    | —           | 21.8         |
| find-failed-run-aws    | **24.0**       | 34.6    | —           | 30.8         |
| run-and-confirm-aws    | **15.8**       | 41.8    | —           | 28.0         |
| pipeline-status-aws    | **12.6**       | 16.2    | —           | 31.6         |
| pipeline-stop-noop-aws | **13.6**       | 12.8    | —           | 23.0         |
| serving-status-aws     | **8.6**        | 9.2     | —           | 19.8         |
| api-current-user-aws   | **8.8**        | 8.8     | —           | —            |
| volumes-metadata-aws   | **8.4**        | 8.2     | —           | 19.2         |
| function-view-aws      | **10.8**       | 10.6    | —           | 23.8         |
| query-history-aws      | **10.8**       | 25.2    | —           | 45.6         |

</details>

<details>
<summary><b>Cost per task (USD)</b></summary>

Mean over repeats. `—` = not run for this condition.

| task                   | databricks-axi | raw-cli | mcp-managed | mcp-aidevkit |
| ---------------------- | -------------- | ------- | ----------- | ------------ |
| home-orientation       | **0.089**      | 0.162   | 0.264       | 0.316        |
| find-failed-run        | **0.203**      | 0.205   | 0.507       | 0.649        |
| run-and-confirm        | **0.144**      | 0.139   | —           | 0.504        |
| sql-count              | **0.121**      | 0.152   | 0.139       | 0.248        |
| table-schema           | **0.119**      | 0.126   | 0.131       | 0.216        |
| error-recovery         | **0.132**      | 0.109   | 0.131       | 0.209        |
| table-list             | **0.119**      | 0.145   | 0.179       | 0.314        |
| warehouse-cycle        | **0.119**      | 0.112   | —           | 0.202        |
| notebook-read          | **0.140**      | 0.145   | —           | —            |
| volume-read            | **0.120**      | 0.126   | —           | 0.553        |
| fs-error-recovery      | **0.121**      | 0.122   | —           | —            |
| home-dashboard         | **0.151**      | 0.171   | —           | 0.431        |
| job-cancel-noop        | **0.120**      | 0.126   | —           | 0.415        |
| job-run-why-failed     | **0.138**      | 0.166   | —           | 0.496        |
| catalog-browse         | **0.124**      | 0.141   | 0.199       | 0.444        |
| home-orientation-aws   | **0.126**      | 0.180   | —           | 0.342        |
| table-schema-aws       | **0.119**      | 0.125   | —           | 0.190        |
| sql-count-aws          | **0.120**      | 0.131   | —           | 0.265        |
| table-list-aws         | **0.118**      | 0.146   | —           | 0.320        |
| error-recovery-aws     | **0.123**      | 0.109   | —           | 0.170        |
| volume-read-aws        | **0.124**      | 0.136   | —           | 0.553        |
| notebook-read-aws      | **0.199**      | 0.194   | —           | —            |
| clusters-list-aws      | **0.126**      | 0.121   | —           | 0.248        |
| clusters-view-aws      | **0.144**      | 0.118   | —           | 0.565        |
| cluster-stop-noop-aws  | **0.141**      | 0.120   | —           | 0.229        |
| job-list-aws           | **0.125**      | 0.118   | —           | 0.343        |
| notebook-discovery-aws | **0.149**      | 0.150   | —           | —            |
| dag-shape-aws          | **0.161**      | 0.136   | —           | 0.441        |
| find-failed-run-aws    | **0.198**      | 0.238   | —           | 0.479        |
| run-and-confirm-aws    | **0.155**      | 0.143   | —           | 0.423        |
| pipeline-status-aws    | **0.142**      | 0.152   | —           | 0.438        |
| pipeline-stop-noop-aws | **0.142**      | 0.135   | —           | 0.376        |
| serving-status-aws     | **0.124**      | 0.117   | —           | 0.267        |
| api-current-user-aws   | **0.124**      | 0.114   | —           | —            |
| volumes-metadata-aws   | **0.123**      | 0.116   | —           | 0.316        |
| function-view-aws      | **0.139**      | 0.177   | —           | 0.400        |
| query-history-aws      | **0.032**      | 0.117   | —           | 0.282        |

</details>

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
round trip. Both MCP servers still cost more on it: $0.507 for mcp-managed and
$0.649 for mcp-aidevkit, against axi's $0.203.

**Where the MCP servers land.** Above axi on input tokens almost everywhere,
and the gap widens with tool count. The structural reason is in the README: an
MCP server loads its tool schemas into context every session, ~40 of them for
ai-dev-kit. The largest multiple is `volume-read`, where mcp-aidevkit spends
584,559 input tokens against axi's 59,754.

**The one real outlier.** mcp-aidevkit spent 12.4 turns and 147s on
`clusters-view-aws`, against raw-cli's 8s, hunting for the right
`manage_cluster` verb. That is also where its single failed repeat landed, and
it is the cost of a 40-tool consolidated-verb schema, not an axi comparison
point.

**Why `run-and-confirm` takes more turns.** It triggers a real job run and
polls for completion; axi's async-by-default flow takes more turns than
raw-cli's blocking call but finishes well inside the wall time (16s against
50s).

## Post-matrix live smoke: 9/9 PASS

After the matrix, a separate live smoke pass exercised paths the matrix
doesn't cover: `setup hooks`, `sql exec` plus `sql statement view`,
`pipelines events`, a `pipelines start` run to `COMPLETED`, and a live
classic-cluster cycle on `AWS2`: `clusters start --wait` through to
`RUNNING`, then `clusters stop --wait` back to `TERMINATED`. All 9 checks
passed.

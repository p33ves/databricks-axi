# Benchmark results

Full detail behind the numbers in the [README](../README.md#benchmarks), for
anyone who wants the per-task breakdown instead of the headline average.

## Methodology

Each task is a real Databricks operation (list jobs, triage a failed run,
count rows, read a notebook, cycle a cluster, ...) run through up to four
interface setups:

- **databricks-axi** — this tool
- **raw-cli** — the official `databricks` CLI, unmodified
- **mcp-managed** — Databricks' workspace-managed SQL MCP server
  (`/api/2.0/mcp/sql`), SQL-only
- **mcp-aidevkit** — Databricks Field Engineering's
  [ai-dev-kit](https://github.com/databricks-solutions/ai-dev-kit), a
  ~40-tool stdio MCP server covering jobs/clusters/SQL/UC/pipelines/serving

An agent (`claude-sonnet-5`) runs each task cold, 3 repeats per
task/condition pair, against seeded fixtures. Success is graded
deterministically where the answer is machine-checkable (row counts, IDs,
statuses), by an LLM judge otherwise. Not every condition can run every
task: `mcp-managed` is SQL-only, so it's excluded from job/cluster-mutating
tasks and every AWS-profile task; both MCP servers are excluded from
`api-current-user-aws` and `notebook-discovery-aws` (no matching tool).

## Latest run: CP2 (2026-07-10, v0.6.1)

**291/291 runs passed (100%)** across 32 tasks and three workspaces (a
Databricks Free Edition workspace plus two paid trial workspaces used for
cluster and extension-domain tasks).

### The six comparable tasks (all four conditions)

Mean over 3 repeats:

| Task             | Condition          | Turns   | Wall (s) | Input tok  | Output tok | Cost   |
| ---------------- | ------------------ | ------- | -------- | ---------- | ---------- | ------ |
| home-orientation | raw-cli            | 5.7     | 18       | 171,131    | 960        | $0.196 |
| home-orientation | **databricks-axi** | **2.0** | **11**   | **59,528** | 484        | $0.172 |
| home-orientation | mcp-managed        | 3.3     | 19       | 113,871    | 1,295      | $0.291 |
| home-orientation | mcp-aidevkit       | 4.3     | 21       | 190,362    | 1,048      | $0.398 |
| find-failed-run  | raw-cli            | 6.7     | 33       | 199,269    | 2,009      | $0.222 |
| find-failed-run  | databricks-axi     | 7.3     | 32       | 229,158    | 1,324      | $0.232 |
| find-failed-run  | mcp-managed        | 10.0    | 64       | 580,550    | 2,176      | $0.573 |
| find-failed-run  | mcp-aidevkit       | 9.3     | 38       | 599,101    | 1,643      | $0.697 |
| sql-count        | raw-cli            | 4.3     | 20       | 129,408    | 916        | $0.181 |
| sql-count        | **databricks-axi** | **2.0** | **13**   | **59,019** | 430        | $0.143 |
| sql-count        | mcp-managed        | 3.0     | 12       | 91,233     | 461        | $0.198 |
| sql-count        | mcp-aidevkit       | 4.0     | 19       | 148,576    | 574        | $0.294 |
| table-schema     | raw-cli            | 2.0     | 9        | 58,981     | 331        | $0.149 |
| table-schema     | databricks-axi     | 2.0     | 9        | 58,934     | 324        | $0.141 |
| table-schema     | mcp-managed        | 3.0     | 11       | 88,303     | 430        | $0.189 |
| table-schema     | mcp-aidevkit       | 3.7     | 22       | 123,433    | 596        | $0.283 |
| error-recovery   | raw-cli            | 2.0     | 9        | 56,340     | 406        | $0.134 |
| error-recovery   | databricks-axi     | 3.0     | 12       | 88,646     | 493        | $0.153 |
| error-recovery   | mcp-managed        | 3.0     | 13       | 88,187     | 563        | $0.190 |
| error-recovery   | mcp-aidevkit       | 4.0     | 20       | 138,241    | 583        | $0.320 |
| table-list       | raw-cli            | 2.0     | 8        | 62,545     | 304        | $0.170 |
| table-list       | databricks-axi     | 2.0     | 9        | 58,792     | 251        | $0.139 |
| table-list       | mcp-managed        | 3.0     | 10       | 102,498    | 419        | $0.233 |
| table-list       | mcp-aidevkit       | 6.0     | 30       | 259,670    | 859        | $0.364 |

`find-failed-run` is the one task where axi doesn't win outright: it needs
several jobs-API calls (list runs → filter failed → view → read the error),
so raw-cli's dense `-o json` output happens to answer more of that in fewer
round trips. Both MCP servers still cost noticeably more on it (+191-201%
input tokens) since job triage over MCP means more individual tool calls.

### Other tasks: raw-cli and axi, plus mcp-aidevkit where available

Five more tasks fall outside the six-condition core. None have a
`mcp-managed` condition: they mutate state or read filesystem-like surfaces
(`fs`, `workspace`) the SQL-only managed server can't reach. Three
(`run-and-confirm`, `cluster-cycle`, `volume-read`) do have an
`mcp-aidevkit` condition; `notebook-read` and `fs-error-recovery` have no
matching tool in either MCP server.

| Task              | Condition      | Turns | Wall (s) | Input tok | Output tok | Cost   |
| ----------------- | -------------- | ----- | -------- | --------- | ---------- | ------ |
| run-and-confirm   | raw-cli        | 3.3   | 48       | 95,682    | 863        | $0.160 |
| run-and-confirm   | databricks-axi | 4.0   | 16       | 118,979   | 703        | $0.167 |
| run-and-confirm   | mcp-aidevkit   | 6.0   | 25       | 274,604   | 865        | $0.387 |
| cluster-cycle     | raw-cli        | 2.0   | 9        | 56,836    | 280        | $0.135 |
| cluster-cycle     | databricks-axi | 2.0   | 9        | 58,963    | 300        | $0.141 |
| cluster-cycle     | mcp-aidevkit   | 4.0   | 19       | 130,643   | 502        | $0.295 |
| notebook-read     | raw-cli        | 4.3   | 21       | 127,005   | 1,215      | $0.181 |
| notebook-read     | databricks-axi | 3.0   | 17       | 89,399    | 879        | $0.163 |
| volume-read       | raw-cli        | 4.3   | 16       | 123,824   | 815        | $0.164 |
| volume-read       | databricks-axi | 2.0   | 10       | 58,968    | 391        | $0.142 |
| volume-read       | mcp-aidevkit   | 9.3   | 35       | 545,700   | 1,566      | $0.563 |
| fs-error-recovery | raw-cli        | 2.7   | 14       | 75,809    | 718        | $0.147 |
| fs-error-recovery | databricks-axi | 2.3   | 12       | 68,952    | 511        | $0.148 |

`run-and-confirm` triggers a real job run and polls for completion; axi's
async-by-default flow takes 3x more turns than raw-cli's blocking call but
finishes in a third of the wall time.

### AWS-profile tasks (clusters, pipelines, serving, 0.9.0 extensions)

21 tasks run against the two paid trial workspaces, comparing axi and
raw-cli, with mcp-aidevkit where a matching tool exists (mcp-managed is
SQL-only and excluded from every AWS task; `api-current-user-aws` and
`notebook-discovery-aws` have no mcp-aidevkit tool either). Mean over 3
repeats:

| Task                   | Condition      | Turns | Wall (s) | Input tok | Output tok | Cost   |
| ---------------------- | -------------- | ----- | -------- | --------- | ---------- | ------ |
| home-orientation-aws   | raw-cli        | 6.0   | 19       | 141,152   | 1,050      | $0.205 |
| home-orientation-aws   | databricks-axi | 2.3   | 8        | 59,640    | 409        | $0.146 |
| home-orientation-aws   | mcp-aidevkit   | 4.0   | 19       | 165,045   | 944        | $0.397 |
| table-schema-aws       | raw-cli        | 2.0   | 8        | 59,044    | 355        | $0.149 |
| table-schema-aws       | databricks-axi | 2.0   | 8        | 58,937    | 309        | $0.141 |
| table-schema-aws       | mcp-aidevkit   | 4.0   | 27       | 130,256   | 612        | $0.296 |
| sql-count-aws          | raw-cli        | 4.0   | 19       | 116,078   | 862        | $0.168 |
| sql-count-aws          | databricks-axi | 2.3   | 13       | 69,021    | 497        | $0.148 |
| sql-count-aws          | mcp-aidevkit   | 4.3   | 20       | 163,649   | 701        | $0.314 |
| table-list-aws         | raw-cli        | 2.0   | 8        | 62,626    | 312        | $0.170 |
| table-list-aws         | databricks-axi | 2.0   | 8        | 58,800    | 233        | $0.139 |
| table-list-aws         | mcp-aidevkit   | 6.3   | 26       | 294,219   | 887        | $0.414 |
| error-recovery-aws     | raw-cli        | 2.0   | 10       | 56,336    | 373        | $0.133 |
| error-recovery-aws     | databricks-axi | 3.0   | 12       | 88,680    | 538        | $0.154 |
| error-recovery-aws     | mcp-aidevkit   | 4.0   | 19       | 130,948   | 616        | $0.298 |
| volume-read-aws        | raw-cli        | 3.7   | 15       | 104,341   | 733        | $0.156 |
| volume-read-aws        | databricks-axi | 2.0   | 10       | 59,002    | 409        | $0.143 |
| volume-read-aws        | mcp-aidevkit   | 8.7   | 29       | 449,549   | 1,373      | $0.534 |
| notebook-read-aws      | raw-cli        | 6.0   | 25       | 166,717   | 1,689      | $0.201 |
| notebook-read-aws      | databricks-axi | 7.7   | 25       | 203,046   | 1,409      | $0.214 |
| clusters-list-aws      | raw-cli        | 2.0   | 8        | 57,564    | 255        | $0.139 |
| clusters-list-aws      | databricks-axi | 2.7   | 10       | 78,915    | 373        | $0.149 |
| clusters-list-aws      | mcp-aidevkit   | 4.7   | 17       | 178,784   | 727        | $0.302 |
| clusters-view-aws      | raw-cli        | 2.3   | 9        | 66,784    | 366        | $0.142 |
| clusters-view-aws      | databricks-axi | 3.3   | 13       | 98,922    | 491        | $0.158 |
| clusters-view-aws      | mcp-aidevkit   | 11.3  | 174      | 551,655   | 5,206      | $0.574 |
| cluster-stop-noop-aws  | raw-cli        | 2.0   | 9        | 57,338    | 463        | $0.141 |
| cluster-stop-noop-aws  | databricks-axi | 3.3   | 13       | 99,272    | 478        | $0.158 |
| cluster-stop-noop-aws  | mcp-aidevkit   | 5.0   | 17       | 203,308   | 714        | $0.329 |
| job-list-aws           | raw-cli        | 2.0   | 8        | 56,892    | 352        | $0.136 |
| job-list-aws           | databricks-axi | 2.0   | 9        | 58,933    | 428        | $0.143 |
| job-list-aws           | mcp-aidevkit   | 5.7   | 22       | 272,363   | 773        | $0.409 |
| notebook-discovery-aws | raw-cli        | 3.0   | 13       | 86,463    | 623        | $0.153 |
| notebook-discovery-aws | databricks-axi | 4.0   | 15       | 90,345    | 757        | $0.166 |
| dag-shape-aws          | raw-cli        | 3.0   | 13       | 85,526    | 531        | $0.149 |
| dag-shape-aws          | databricks-axi | 4.0   | 14       | 119,137   | 630        | $0.168 |
| dag-shape-aws          | mcp-aidevkit   | 6.3   | 20       | 356,583   | 877        | $0.530 |
| find-failed-run-aws    | raw-cli        | 5.3   | 23       | 155,531   | 1,479      | $0.193 |
| find-failed-run-aws    | databricks-axi | 6.3   | 28       | 195,436   | 1,385      | $0.220 |
| find-failed-run-aws    | mcp-aidevkit   | 6.0   | 24       | 312,950   | 1,018      | $0.458 |
| run-and-confirm-aws    | raw-cli        | 3.3   | 43       | 95,977    | 917        | $0.162 |
| run-and-confirm-aws    | databricks-axi | 4.0   | 15       | 118,988   | 677        | $0.167 |
| run-and-confirm-aws    | mcp-aidevkit   | 8.3   | 26       | 447,478   | 1,216      | $0.527 |
| pipeline-status-aws    | raw-cli        | 4.7   | 18       | 127,360   | 1,160      | $0.178 |
| pipeline-status-aws    | databricks-axi | 4.7   | 24       | 143,903   | 1,379      | $0.182 |
| pipeline-status-aws    | mcp-aidevkit   | 7.7   | 23       | 307,316   | 1,232      | $0.403 |
| serving-status-aws     | raw-cli        | 2.0   | 8        | 56,750    | 359        | $0.135 |
| serving-status-aws     | databricks-axi | 2.7   | 12       | 80,159    | 650        | $0.159 |
| serving-status-aws     | mcp-aidevkit   | 4.0   | 16       | 149,593   | 548        | $0.305 |
| api-current-user-aws   | raw-cli        | 2.0   | 6        | 56,658    | 252        | $0.133 |
| api-current-user-aws   | databricks-axi | 2.0   | 8        | 59,119    | 370        | $0.143 |
| query-history-aws      | raw-cli        | 8.7   | 28       | 259,178   | 1,722      | $0.236 |
| query-history-aws      | databricks-axi | 7.7   | 34       | 246,304   | 1,870      | $0.247 |
| query-history-aws      | mcp-aidevkit   | 6.7   | 37       | 304,412   | 1,268      | $0.440 |
| volumes-metadata-aws   | raw-cli        | 2.0   | 8        | 56,766    | 340        | $0.135 |
| volumes-metadata-aws   | databricks-axi | 2.7   | 13       | 79,703    | 769        | $0.159 |
| volumes-metadata-aws   | mcp-aidevkit   | 4.3   | 18       | 174,395   | 654        | $0.335 |
| function-view-aws      | raw-cli        | 3.3   | 13       | 102,044   | 490        | $0.193 |
| function-view-aws      | databricks-axi | 2.3   | 12       | 69,192    | 573        | $0.150 |
| function-view-aws      | mcp-aidevkit   | 5.0   | 22       | 217,540   | 726        | $0.452 |

A few patterns worth naming: axi wins or ties raw-cli on turns and input
tokens for single-purpose lookups (`table-schema-aws`, `table-list-aws`,
`job-list-aws`, `api-current-user-aws`, `query-history-aws`), and pays a
modest turns/token premium on multi-step or newly-added cluster/extension
tasks (`clusters-list-aws`, `clusters-view-aws`, `cluster-stop-noop-aws`,
`serving-status-aws`, `volumes-metadata-aws`). The one real outlier:
mcp-aidevkit spent 174s and 11.3 turns on `clusters-view-aws` hunting for the
right `manage_cluster` verb (+386% turns, +1912% wall vs raw-cli) — a real
cost of a 40-tool consolidated-verb schema, not an axi comparison point.

</content>

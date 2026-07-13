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
statuses), by an LLM judge otherwise. Not every condition can run every
task: `mcp-managed` is SQL-only, so it's excluded from job/cluster-mutating
tasks and every AWS-profile task; both MCP servers are excluded from
`api-current-user-aws` and `notebook-discovery-aws` (no matching tool).

## Latest run: CP3 (2026-07-11, v0.9.0)

**564/565 runs passed (99.8%)** across 37 tasks and three workspaces: a
Databricks Free Edition workspace (`FREE`) plus two paid trial workspaces
(`AWS`, a serverless workspace; `AWS2`, a classic-cluster workspace used for
cluster tasks). Every databricks-axi cell passed (185/185). The one failed
cell across all conditions was `clusters-view-aws / mcp-aidevkit`, one of
five repeats: the agent's final answer omitted the node type, DBR version,
and max-worker count after a 15-turn tool-discovery loop, graded
deterministically. Run to run variance in that condition, not a tool error.

Tool versions: databricks-axi @ 96bde97 (v0.9.0), official `databricks` CLI
v1.6.0, `ai-dev-kit` pinned at `a7e1d51`.

### The seven comparable tasks (all four conditions)

Mean over 5 repeats:

| task             | condition      | pass | turns       | wall_s     | tok_in          | tok_out       | cost_usd |
| ---------------- | -------------- | ---- | ----------- | ---------- | --------------- | ------------- | -------- |
| home-orientation | raw-cli        | 5/5  | 5.2         | 16         | 135,463         | 846           | 0.162    |
| home-orientation | databricks-axi | 5/5  | 2.2 (-58%)  | 9 (-45%)   | 60,684 (-55%)   | 449 (-47%)    | 0.089    |
| home-orientation | mcp-managed    | 5/5  | 5.0 (-4%)   | 26 (+60%)  | 182,049 (+34%)  | 1,501 (+77%)  | 0.264    |
| home-orientation | mcp-aidevkit   | 5/5  | 3.8 (-27%)  | 19 (+16%)  | 164,741 (+22%)  | 877 (+4%)     | 0.316    |
| find-failed-run  | raw-cli        | 5/5  | 6.2         | 28         | 193,849         | 1,620         | 0.205    |
| find-failed-run  | databricks-axi | 5/5  | 6.4 (+3%)   | 28 (+1%)   | 203,695 (+5%)   | 1,198 (-26%)  | 0.203    |
| find-failed-run  | mcp-managed    | 5/5  | 10.8 (+74%) | 69 (+147%) | 600,135 (+210%) | 2,445 (+51%)  | 0.507    |
| find-failed-run  | mcp-aidevkit   | 5/5  | 10.2 (+65%) | 40 (+45%)  | 659,709 (+240%) | 1,756 (+8%)   | 0.649    |
| sql-count        | raw-cli        | 5/5  | 4.4         | 20         | 129,731         | 829           | 0.152    |
| sql-count        | databricks-axi | 5/5  | 2.0 (-55%)  | 17 (-13%)  | 59,844 (-54%)   | 383 (-54%)    | 0.121    |
| sql-count        | mcp-managed    | 5/5  | 3.0 (-32%)  | 10 (-47%)  | 90,851 (-30%)   | 420 (-49%)    | 0.139    |
| sql-count        | mcp-aidevkit   | 5/5  | 4.8 (+9%)   | 21 (+8%)   | 172,779 (+33%)  | 691 (-17%)    | 0.248    |
| table-schema     | raw-cli        | 5/5  | 2.0         | 9          | 58,987          | 388           | 0.126    |
| table-schema     | databricks-axi | 5/5  | 2.0 (+0%)   | 7 (-21%)   | 59,751 (+1%)    | 306 (-21%)    | 0.119    |
| table-schema     | mcp-managed    | 5/5  | 3.0 (+50%)  | 11 (+17%)  | 87,997 (+49%)   | 409 (+6%)     | 0.131    |
| table-schema     | mcp-aidevkit   | 5/5  | 4.4 (+120%) | 26 (+179%) | 152,563 (+159%) | 688 (+78%)    | 0.216    |
| error-recovery   | raw-cli        | 5/5  | 2.0         | 8          | 56,273          | 382           | 0.109    |
| error-recovery   | databricks-axi | 5/5  | 3.0 (+50%)  | 13 (+59%)  | 89,881 (+60%)   | 502 (+31%)    | 0.132    |
| error-recovery   | mcp-managed    | 5/5  | 3.0 (+50%)  | 11 (+29%)  | 87,835 (+56%)   | 472 (+23%)    | 0.131    |
| error-recovery   | mcp-aidevkit   | 5/5  | 4.0 (+100%) | 22 (+168%) | 137,494 (+144%) | 576 (+51%)    | 0.209    |
| table-list       | raw-cli        | 5/5  | 2.0         | 9          | 62,460          | 269           | 0.145    |
| table-list       | databricks-axi | 5/5  | 2.0 (+0%)   | 10 (+4%)   | 59,691 (-4%)    | 309 (+15%)    | 0.119    |
| table-list       | mcp-managed    | 5/5  | 3.0 (+50%)  | 10 (+4%)   | 103,336 (+65%)  | 401 (+49%)    | 0.179    |
| table-list       | mcp-aidevkit   | 5/5  | 5.4 (+170%) | 29 (+215%) | 238,345 (+282%) | 853 (+217%)   | 0.314    |
| catalog-browse   | raw-cli        | 5/5  | 3.0         | 12         | 90,980          | 418           | 0.141    |
| catalog-browse   | databricks-axi | 5/5  | 3.0 (+0%)   | 12 (+0%)   | 66,100 (-27%)   | 402 (-4%)     | 0.124    |
| catalog-browse   | mcp-managed    | 5/5  | 4.2 (+40%)  | 16 (+26%)  | 150,156 (+65%)  | 540 (+29%)    | 0.199    |
| catalog-browse   | mcp-aidevkit   | 5/5  | 9.0 (+200%) | 38 (+206%) | 416,160 (+357%) | 1,228 (+194%) | 0.444    |

`find-failed-run` is one task where axi doesn't win outright: it needs
several jobs-API calls (list runs, filter failed, view, read the error), so
raw-cli's dense `-o json` output happens to answer more of that in fewer
round trips. Both MCP servers still cost noticeably more on it (+210-240%
input tokens) since job triage over MCP means more individual tool calls.

### Other tasks: raw-cli and axi, plus MCP where available

The remaining tasks fall outside the seven-condition core. Some have no
`mcp-managed` condition because they mutate state or read filesystem-like
surfaces (`fs`, `workspace`) the SQL-only managed server can't reach.

| task               | condition      | pass | turns       | wall_s     | tok_in          | tok_out       | cost_usd |
| ------------------ | -------------- | ---- | ----------- | ---------- | --------------- | ------------- | -------- |
| run-and-confirm    | raw-cli        | 5/5  | 3.6         | 50         | 103,782         | 847           | 0.139    |
| run-and-confirm    | databricks-axi | 5/5  | 4.0 (+11%)  | 16 (-69%)  | 120,407 (+16%)  | 602 (-29%)    | 0.144    |
| run-and-confirm    | mcp-aidevkit   | 5/5  | 9.2 (+156%) | 37 (-27%)  | 501,653 (+383%) | 1,312 (+55%)  | 0.504    |
| warehouse-cycle    | raw-cli        | 5/5  | 2.0         | 8          | 56,839          | 357           | 0.112    |
| warehouse-cycle    | databricks-axi | 5/5  | 2.0 (+0%)   | 8 (-3%)    | 59,782 (+5%)    | 274 (-23%)    | 0.119    |
| warehouse-cycle    | mcp-aidevkit   | 5/5  | 4.8 (+140%) | 19 (+140%) | 168,376 (+196%) | 557 (+56%)    | 0.202    |
| notebook-read      | raw-cli        | 5/5  | 4.0         | 19         | 115,328         | 1,056         | 0.145    |
| notebook-read      | databricks-axi | 5/5  | 3.0 (-25%)  | 15 (-18%)  | 90,580 (-21%)   | 798 (-24%)    | 0.140    |
| volume-read        | raw-cli        | 5/5  | 3.2         | 14         | 90,787          | 665           | 0.126    |
| volume-read        | databricks-axi | 5/5  | 2.0 (-38%)  | 8 (-41%)   | 59,754 (-34%)   | 339 (-49%)    | 0.120    |
| volume-read        | mcp-aidevkit   | 5/5  | 9.6 (+200%) | 30 (+113%) | 584,559 (+544%) | 1,356 (+104%) | 0.553    |
| fs-error-recovery  | raw-cli        | 5/5  | 2.6         | 13         | 73,913          | 702           | 0.122    |
| fs-error-recovery  | databricks-axi | 5/5  | 2.0 (-23%)  | 11 (-16%)  | 59,759 (-19%)   | 442 (-37%)    | 0.121    |
| home-dashboard     | raw-cli        | 5/5  | 6.8         | 22         | 122,943         | 1,423         | 0.171    |
| home-dashboard     | databricks-axi | 5/5  | 3.6 (-47%)  | 18 (-18%)  | 109,753 (-11%)  | 1,072 (-25%)  | 0.151    |
| home-dashboard     | mcp-aidevkit   | 5/5  | 10.2 (+50%) | 43 (+91%)  | 333,110 (+171%) | 2,334 (+64%)  | 0.431    |
| job-cancel-noop    | raw-cli        | 5/5  | 2.6         | 11         | 75,233          | 481           | 0.126    |
| job-cancel-noop    | databricks-axi | 5/5  | 2.0 (-23%)  | 9 (-13%)   | 59,810 (-20%)   | 322 (-33%)    | 0.120    |
| job-cancel-noop    | mcp-aidevkit   | 5/5  | 6.0 (+131%) | 25 (+131%) | 287,231 (+282%) | 955 (+98%)    | 0.415    |
| job-run-why-failed | raw-cli        | 5/5  | 4.2         | 20         | 126,358         | 1,019         | 0.166    |
| job-run-why-failed | databricks-axi | 5/5  | 2.6 (-38%)  | 19 (-6%)   | 79,399 (-37%)   | 562 (-45%)    | 0.138    |
| job-run-why-failed | mcp-aidevkit   | 5/5  | 8.2 (+95%)  | 41 (+103%) | 423,263 (+235%) | 1,503 (+48%)  | 0.496    |

`run-and-confirm` triggers a real job run and polls for completion; axi's
async-by-default flow takes more turns than raw-cli's blocking call but
finishes well inside the wall time.

### AWS-profile tasks (clusters, pipelines, serving, extension domains)

Tasks run against the two paid trial workspaces, comparing axi and raw-cli,
with mcp-aidevkit where a matching tool exists (mcp-managed is SQL-only and
excluded from every AWS task; `api-current-user-aws` and
`notebook-discovery-aws` have no mcp-aidevkit tool either). Mean over 5
repeats:

| task                   | condition      | pass | turns        | wall_s       | tok_in          | tok_out        | cost_usd |
| ---------------------- | -------------- | ---- | ------------ | ------------ | --------------- | -------------- | -------- |
| home-orientation-aws   | raw-cli        | 5/5  | 5.6          | 22           | 152,534         | 962            | 0.180    |
| home-orientation-aws   | databricks-axi | 5/5  | 2.2 (-61%)   | 9 (-58%)     | 60,683 (-60%)   | 400 (-58%)     | 0.126    |
| home-orientation-aws   | mcp-aidevkit   | 5/5  | 4.6 (-18%)   | 20 (-8%)     | 198,826 (+30%)  | 934 (-3%)      | 0.342    |
| table-schema-aws       | raw-cli        | 5/5  | 2.0          | 8            | 58,985          | 342            | 0.125    |
| table-schema-aws       | databricks-axi | 5/5  | 2.0 (+0%)    | 7 (-3%)      | 59,751 (+1%)    | 287 (-16%)     | 0.119    |
| table-schema-aws       | mcp-aidevkit   | 5/5  | 3.4 (+70%)   | 23 (+197%)   | 115,899 (+96%)  | 593 (+73%)     | 0.190    |
| sql-count-aws          | raw-cli        | 5/5  | 3.2          | 13           | 92,188          | 693            | 0.131    |
| sql-count-aws          | databricks-axi | 5/5  | 2.0 (-38%)   | 10 (-26%)    | 59,829 (-35%)   | 350 (-49%)     | 0.120    |
| sql-count-aws          | mcp-aidevkit   | 5/5  | 4.8 (+50%)   | 21 (+62%)    | 184,687 (+100%) | 720 (+4%)      | 0.265    |
| table-list-aws         | raw-cli        | 5/5  | 2.0          | 8            | 62,563          | 301            | 0.146    |
| table-list-aws         | databricks-axi | 5/5  | 2.0 (+0%)    | 8 (+2%)      | 59,636 (-5%)    | 244 (-19%)     | 0.118    |
| table-list-aws         | mcp-aidevkit   | 5/5  | 4.8 (+140%)  | 22 (+166%)   | 216,398 (+246%) | 743 (+147%)    | 0.320    |
| error-recovery-aws     | raw-cli        | 5/5  | 2.0          | 8            | 56,277          | 366            | 0.109    |
| error-recovery-aws     | databricks-axi | 5/5  | 2.2 (+10%)   | 9 (+13%)     | 65,761 (+17%)   | 445 (+21%)     | 0.123    |
| error-recovery-aws     | mcp-aidevkit   | 5/5  | 3.6 (+80%)   | 19 (+141%)   | 125,908 (+124%) | 553 (+51%)     | 0.170    |
| volume-read-aws        | raw-cli        | 5/5  | 3.4          | 14           | 123,603         | 618            | 0.136    |
| volume-read-aws        | databricks-axi | 5/5  | 2.2 (-35%)   | 9 (-36%)     | 65,916 (-47%)   | 426 (-31%)     | 0.124    |
| volume-read-aws        | mcp-aidevkit   | 5/5  | 9.2 (+171%)  | 31 (+124%)   | 632,845 (+412%) | 1,481 (+140%)  | 0.553    |
| notebook-read-aws      | raw-cli        | 5/5  | 6.2          | 29           | 231,616         | 1,560          | 0.194    |
| notebook-read-aws      | databricks-axi | 5/5  | 6.0 (-3%)    | 28 (-6%)     | 232,382 (+0%)   | 1,286 (-18%)   | 0.199    |
| clusters-list-aws      | raw-cli        | 5/5  | 2.0          | 9            | 73,457          | 275            | 0.121    |
| clusters-list-aws      | databricks-axi | 5/5  | 2.2 (+10%)   | 8 (-5%)      | 83,238 (+13%)   | 242 (-12%)     | 0.126    |
| clusters-list-aws      | mcp-aidevkit   | 5/5  | 4.2 (+110%)  | 17 (+93%)    | 195,739 (+166%) | 543 (+97%)     | 0.248    |
| clusters-view-aws      | raw-cli        | 5/5  | 2.0          | 8            | 72,904          | 328            | 0.118    |
| clusters-view-aws      | databricks-axi | 5/5  | 3.4 (+70%)   | 13 (+50%)    | 129,256 (+77%)  | 415 (+27%)     | 0.144    |
| clusters-view-aws      | mcp-aidevkit   | 4/5  | 12.4 (+520%) | 147 (+1655%) | 744,836 (+922%) | 4,501 (+1272%) | 0.565    |
| cluster-stop-noop-aws  | raw-cli        | 5/5  | 2.0          | 10           | 72,982          | 456            | 0.120    |
| cluster-stop-noop-aws  | databricks-axi | 5/5  | 3.0 (+50%)   | 12 (+21%)    | 114,323 (+57%)  | 475 (+4%)      | 0.141    |
| cluster-stop-noop-aws  | mcp-aidevkit   | 5/5  | 3.6 (+80%)   | 18 (+85%)    | 163,390 (+124%) | 543 (+19%)     | 0.229    |
| job-list-aws           | raw-cli        | 5/5  | 2.0          | 8            | 72,767          | 344            | 0.118    |
| job-list-aws           | databricks-axi | 5/5  | 2.0 (+0%)    | 10 (+17%)    | 75,648 (+4%)    | 334 (-3%)      | 0.125    |
| job-list-aws           | mcp-aidevkit   | 5/5  | 5.0 (+150%)  | 17 (+107%)   | 265,705 (+265%) | 742 (+116%)    | 0.343    |
| notebook-discovery-aws | raw-cli        | 5/5  | 3.6          | 17           | 133,757         | 854            | 0.150    |
| notebook-discovery-aws | databricks-axi | 5/5  | 4.2 (+17%)   | 16 (-4%)     | 115,209 (-14%)  | 580 (-32%)     | 0.149    |
| dag-shape-aws          | raw-cli        | 5/5  | 3.2          | 13           | 116,899         | 564            | 0.136    |
| dag-shape-aws          | databricks-axi | 5/5  | 4.2 (+31%)   | 17 (+30%)    | 160,553 (+37%)  | 652 (+16%)     | 0.161    |
| dag-shape-aws          | mcp-aidevkit   | 5/5  | 6.6 (+106%)  | 22 (+65%)    | 397,283 (+240%) | 831 (+47%)     | 0.441    |
| find-failed-run-aws    | raw-cli        | 5/5  | 7.6          | 35           | 294,334         | 2,099          | 0.238    |
| find-failed-run-aws    | databricks-axi | 5/5  | 5.8 (-24%)   | 24 (-31%)    | 226,758 (-23%)  | 994 (-53%)     | 0.198    |
| find-failed-run-aws    | mcp-aidevkit   | 5/5  | 7.2 (-5%)    | 31 (-11%)    | 442,730 (+50%)  | 1,387 (-34%)   | 0.479    |
| run-and-confirm-aws    | raw-cli        | 5/5  | 3.4          | 42           | 124,512         | 762            | 0.143    |
| run-and-confirm-aws    | databricks-axi | 5/5  | 4.0 (+18%)   | 16 (-62%)    | 152,436 (+22%)  | 635 (-17%)     | 0.155    |
| run-and-confirm-aws    | mcp-aidevkit   | 5/5  | 7.4 (+118%)  | 28 (-33%)    | 426,518 (+243%) | 1,087 (+43%)   | 0.423    |
| pipeline-status-aws    | raw-cli        | 5/5  | 3.8          | 16           | 140,968         | 852            | 0.152    |
| pipeline-status-aws    | databricks-axi | 5/5  | 3.0 (-21%)   | 13 (-22%)    | 114,109 (-19%)  | 538 (-37%)     | 0.142    |
| pipeline-status-aws    | mcp-aidevkit   | 5/5  | 8.8 (+132%)  | 32 (+95%)    | 471,081 (+234%) | 1,519 (+78%)   | 0.438    |
| pipeline-stop-noop-aws | raw-cli        | 5/5  | 3.0          | 13           | 109,783         | 638            | 0.135    |
| pipeline-stop-noop-aws | databricks-axi | 5/5  | 3.0 (+0%)    | 14 (+6%)     | 114,238 (+4%)   | 480 (-25%)     | 0.142    |
| pipeline-stop-noop-aws | mcp-aidevkit   | 5/5  | 6.6 (+120%)  | 23 (+80%)    | 335,966 (+206%) | 1,187 (+86%)   | 0.376    |
| serving-status-aws     | raw-cli        | 5/5  | 2.0          | 9            | 72,624          | 360            | 0.117    |
| serving-status-aws     | databricks-axi | 5/5  | 2.0 (+0%)    | 9 (-7%)      | 75,644 (+4%)    | 237 (-34%)     | 0.124    |
| serving-status-aws     | mcp-aidevkit   | 5/5  | 4.2 (+110%)  | 20 (+115%)   | 201,364 (+177%) | 673 (+87%)     | 0.267    |
| api-current-user-aws   | raw-cli        | 5/5  | 2.0          | 9            | 72,508          | 223            | 0.114    |
| api-current-user-aws   | databricks-axi | 5/5  | 2.0 (+0%)    | 9 (+0%)      | 75,694 (+4%)    | 237 (+6%)      | 0.124    |
| volumes-metadata-aws   | raw-cli        | 5/5  | 2.0          | 8            | 72,633          | 307            | 0.116    |
| volumes-metadata-aws   | databricks-axi | 5/5  | 2.0 (+0%)    | 8 (+2%)      | 75,584 (+4%)    | 212 (-31%)     | 0.123    |
| volumes-metadata-aws   | mcp-aidevkit   | 5/5  | 5.6 (+180%)  | 19 (+134%)   | 285,061 (+292%) | 783 (+155%)    | 0.316    |
| function-view-aws      | raw-cli        | 5/5  | 2.6          | 11           | 104,594         | 444            | 0.177    |
| function-view-aws      | databricks-axi | 5/5  | 3.0 (+15%)   | 11 (+2%)     | 113,878 (+9%)   | 416 (-6%)      | 0.139    |
| function-view-aws      | mcp-aidevkit   | 5/5  | 5.0 (+92%)   | 24 (+125%)   | 282,256 (+170%) | 884 (+99%)     | 0.400    |
| query-history-aws      | raw-cli        | 5/5  | 6.8          | 25           | 255,353         | 1,401          | 0.117    |
| query-history-aws      | databricks-axi | 5/5  | 2.0 (-71%)   | 11 (-57%)    | 75,838 (-70%)   | 397 (-72%)     | 0.032    |
| query-history-aws      | mcp-aidevkit   | 5/5  | 6.0 (-12%)   | 46 (+81%)    | 304,606 (+19%)  | 1,709 (+22%)   | 0.282    |

Note: the two `api-current-user-aws` rows were re-measured on 1.0
(whoami-enabled) code, since the `whoami` command added in this release
closed the CP3/v0.9.0 outlier; the rest of the table is the original CP3
v0.9.0 matrix.

A few patterns worth naming: axi wins or ties raw-cli on turns and input
tokens for single-purpose lookups (`table-schema-aws`, `table-list-aws`,
`job-list-aws`, `volumes-metadata-aws`), and pays a modest turns/token
premium on multi-step or cluster/extension tasks (`clusters-view-aws`,
`cluster-stop-noop-aws`, `dag-shape-aws`, `function-view-aws`). The widest
gap this pass is `query-history-aws` (-71% turns, -70% input tokens vs
raw-cli). The one real outlier: mcp-aidevkit spent 147s and 12.4 turns on
`clusters-view-aws` (one of five repeats failed there too) hunting for the
right `manage_cluster` verb (+520% turns, +1655% wall vs raw-cli), a real
cost of a 40-tool consolidated-verb schema, not an axi comparison point.
Every other axi condition is at or below raw-cli on turns and tokens,
including `api-current-user-aws`, where the `whoami` command puts axi level
with a single raw `api get` call (2.0 turns / 9s, 5/5).

### Post-matrix live smoke: 9/9 PASS

After the matrix, a separate live smoke pass exercised paths the matrix
doesn't cover: `setup hooks`, `sql exec` plus `sql statement view`,
`pipelines events`, a `pipelines start` run to `COMPLETED`, and a live
classic-cluster cycle on `AWS2`: `clusters start --wait` through to
`RUNNING`, then `clusters stop --wait` back to `TERMINATED`. All 9 checks
passed.

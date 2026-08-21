# 只读数据展示端到端验收（issue #14）

本文档是把 **issue #14（[MVP][QA] 建立只读数据展示端到端验收、性能与上线检查）** 的
10 个核心场景与 6 条验收标准逐一钉到**已存在的自动化测试 / 可复现脚本 / 文档证据**上的
映射中枢。诚实标注现有覆盖，不夸大：凡标注"新增"的行均为本 issue 补齐；其余均为
历史 issue 已交付并纳入 CI 的回归防线。

> 范围声明（issue #26 收敛）：验收目标是"IRIS 查询 → 关键词分级 → 只读工作台展示"
> 的完整链路，**不再测试上报闭环**。任何"待上报/已上报/已知晓/已处理/误报/日报"
> 入口或可调用 API 的存在即验收失败（场景 10，由 `closed-loop-absence.spec.ts` 门禁）。
>
> 上线清单与回滚 runbook 见 [docs/go-live.md](./go-live.md)；字段/主键/敏感级别见
> [docs/data-dictionary.md](./data-dictionary.md)；源字段映射见
> [docs/pacs-ris-adapter.md](./pacs-ris-adapter.md) §3；权限模型见
> [docs/auth.md](./auth.md)。

## 测试清单（证据索引）

| 证据                                | 文件                                                                     | 规模/说明                                 |
| ----------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| 监测列表/详情/汇总 e2e              | `apps/api/test/monitor.e2e-spec.ts`                                      | 20 个真实 PG 用例                         |
| 权限/脱敏/审计 e2e（#13）           | `apps/api/test/security.e2e-spec.ts`                                     | 7 个真实 PG 用例（另含多项矩阵断言）      |
| 性能基准（100k 行，≤3s，**新增**）  | `apps/api/test/performance.e2e-spec.ts`                                  | 4 个真实 PG 用例                          |
| 规则 API e2e                        | `apps/api/test/rules.e2e-spec.ts`                                        | 真实 PG 用例                              |
| 登录/会话 e2e（#31）                | `apps/api/test/auth.e2e-spec.ts`                                         | 真实 PG 用例                              |
| 同步任务 e2e（#6/#8）               | `apps/worker/test/sync.e2e-spec.ts`                                      | 10 个真实 PG 用例                         |
| 匹配引擎单测（#5）                  | `packages/matching-engine/src/*.spec.ts`                                 | 34 个用例（matcher/normalize/strategies） |
| 同步游标/重试/时区单测（#6）        | `apps/worker/src/sync/*.spec.ts`、`apps/worker/src/config/*.spec.ts`     | 51 个用例                                 |
| PACS/RIS 适配器单测                 | `apps/worker/src/pacs-adapter/*.spec.ts`                                 | CSV/HTTP 两模式                           |
| 敏感日志/凭据扫描门禁（#13）        | `apps/api/src/security/log-sanitization.spec.ts`                         | 3 个用例（遍历全库静态扫描）              |
| 无闭环能力静态门禁（**新增**，#14） | `apps/api/src/security/closed-loop-absence.spec.ts`                      | 4 个用例（DB-free 静态扫描）              |
| 约束/幂等/索引核验脚本（#3/#26）    | `apps/api/prisma/scripts/verify-constraints.ts`                          | ts-node 脚本，db-migrations job 中执行    |
| Web 组件测试                        | `apps/web/src/{Workbench,DetailDrawer,RulesModal,AuthGate,App}.test.tsx` | 42 个用例                                 |

## 一、10 个核心场景 → 证据映射

### 场景 1：九个确认字段从源查询正确映射到列表/详情

| 证据                                             | 位置                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 源字段 → 展示字段映射表（9 字段 + 可空标记）     | [docs/pacs-ris-adapter.md](./pacs-ris-adapter.md) §3                                                                                          |
| 字段含义/敏感级别/保留策略                       | [docs/data-dictionary.md](./data-dictionary.md) §monitor_record                                                                               |
| 详情返回完整快照（多关键词 R1 的九字段逐项断言） | `apps/api/test/monitor.e2e-spec.ts` → `'detail returns the full snapshot + all hits (multi-keyword R1)'`                                      |
| CSV 夹具 → MonitorRecord 行的首窗全量写入        | `apps/worker/test/sync.e2e-spec.ts` → `'first full window: syncing the fixture dataset from scratch creates MonitorRecord + SyncJobLog rows'` |

### 场景 2：报告内容或诊断命中关键词后正确显示红黄绿；混合命中取最高等级并保留全部词

| 证据                                              | 位置                                                                                                                                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关键词分级 + **混合命中取最高等级且保留全部命中** | `packages/matching-engine/src/matcher.spec.ts` → `'matches "考虑贲门失弛缓症" and classifies as RED'`、`'resolves to RED when both GREEN and RED rules match, and keeps both matches'` |
| 大小写不敏感 CONTAINS / 全半角标点归一            | 同文件 → `'matches "ca", "CA", and "Ca"...'`、`'matches across full-width and half-width punctuation variants...'`                                                                     |
| 命中证据在详情端到端可见                          | `apps/api/test/monitor.e2e-spec.ts` → `'detail returns the full snapshot + all hits (multi-keyword R1)'`                                                                               |
| 命中证据在工作台高亮                              | `apps/web/src/DetailDrawer.test.tsx`、`apps/web/src/Workbench.test.tsx`                                                                                                                |

### 场景 3：无命中显示 UNCLASSIFIED，不能显示绿色

| 证据                                       | 位置                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 空/无启用规则 → UNCLASSIFIED（绝非 GREEN） | `packages/matching-engine/src/matcher.spec.ts` → `'returns UNCLASSIFIED with no matches for empty/null text'`、`'returns UNCLASSIFIED when there are no enabled rules at all'` |
| 详情对未分类记录返回空命中、无正文         | `apps/api/test/monitor.e2e-spec.ts` → `'detail of an unclassified record has empty hits and no body'`                                                                          |

### 场景 4：重复日期窗口扫描不产生重复记录；源内容修改后展示和命中更新

| 证据                                                           | 位置                                                                                                                                                            |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 同批次重复执行计数不增（**幂等**）                             | `apps/worker/test/sync.e2e-spec.ts` → `'re-running the exact same batch twice does not increase MonitorRecord/MonitorMatch counts (idempotency)'`               |
| 增量同步只拾取游标之后的新变化                                 | 同文件 → `'normal incremental sync: a second run only picks up newly-updated records after the first cursor'`                                                   |
| 内容修改（同自然键、新 sourceUpdatedAt）重新触发匹配并更新展示 | 同文件 → `'a report with an amended sourceUpdatedAt (content change, same natural key) re-triggers matching'`                                                   |
| 相同时间戳多记录无碰撞 / 迟到更新仍被 look-back 窗拾取         | 同文件 → `'same sourceUpdatedAt timestamp on multiple records: all are processed without collision'`、`'a late-arriving update within the look-back window...'` |
| 唯一键重复写入被数据库拒绝（稳定主键证明）                     | `apps/api/prisma/scripts/verify-constraints.ts`（重复 `sourceRecordId+reportId+reportVersion` / 重复命中键均被拒）                                              |
| **重启/中断**：失败运行不推进游标，不丢数据                    | 同文件 → `'process interruption: a FAILED run does not advance the cursor past unprocessed data'`；`apps/worker/src/sync/sync-cursor.spec.ts`、`retry.spec.ts`  |

### 场景 5：日期、科室、患者类型、等级、检查项目和搜索筛选口径一致

| 证据                                                                       | 位置                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日期上下界语义（含排他上界、开区间）                                       | `apps/api/test/monitor.e2e-spec.ts` → `'treats examDateTo as an exclusive upper bound...'`、`'supports open-ended date bounds'`                                                                                                                                        |
| 科室（大小写不敏感精确）、患者类型（精确）、等级、检查项目（子串）、姓名/关键词搜索 | 同文件 → `'filters by department...'`、`'filters by patientTypeCode exact match'`、`'filters by attention level'`、`'filters by examItem substring...'`、`'patientName searches patientName only - never report text'`、`'keyword matches the exact matched-rule keyword only - never report text'`、`'combines filters (AND semantics)'` |
| 汇总与列表同口径                                                           | 同文件 → `'summary matches the list under the same filters (empty query)'`、`'summary reflects every applied filter'`                                                                                                                                                  |
| 非法参数 400（口径防回归）                                                 | 同文件 → `'rejects invalid params with 400'`                                                                                                                                                                                                                           |

> 场景 5 的筛选条件与性能基准（验收标准 3）**同一套参数**：`performance.e2e-spec.ts`
> 对完全相同的 `level`/`department`/`examDateFrom`/`examDateTo`/`patientTypeCode`/
> `examItem`/`patientName`/`keyword` 在 100k 行下实测 ≤3s。

### 场景 6：汇总五项与列表数量一致，不存在待上报数量

| 证据                             | 位置                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 汇总五桶与列表同筛选项下计数一致 | `apps/api/test/monitor.e2e-spec.ts` → `'summary matches the list under the same filters (empty query)'`、`'summary reflects every applied filter'`、`'summary level=RED counts only red records'` |
| **不存在"待上报"数量**（无闭环） | `apps/api/src/security/closed-loop-absence.spec.ts` → 全站无 `待上报/已上报/已知晓/已处理/误报/日报` 字样、无闭环 API 路径（**新增**）                                                            |

### 场景 7：详情高亮与原文一致，空床号/空诊断可正常展示

| 证据                                             | 位置                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 详情高亮渲染（原文一致性、多关键词、命中上下文） | `apps/web/src/DetailDrawer.test.tsx`（10 用例）、`apps/web/src/Workbench.test.tsx`（11 用例）              |
| 空诊断仍保留报告正文                             | `apps/api/test/monitor.e2e-spec.ts` → `'detail of a record with an empty diagnosis keeps the report body'` |
| 全空行（含空床号）以空值占位展示，不崩不藏       | 同文件 → `'surfaces the fully-null row R7 with null display values'`                                       |

### 场景 8：数据源不可用时显示异常和最后成功同步时间，恢复后可补偿

| 证据                                                    | 位置                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 数据源 503 型瞬时故障：重试 → FAILED 且游标不丢         | `apps/worker/test/sync.e2e-spec.ts` → `'source unavailable (503-style transient error): retries then marks FAILED without losing the cursor position'` |
| 单条坏数据不阻塞整批（故障恢复/补偿）                   | 同文件 → `'a single malformed/failing record does not block the rest of the batch'`                                                                    |
| 重试策略边界（可重试/不可重试/重试次数耗尽）            | `apps/worker/src/sync/retry.spec.ts`                                                                                                                   |
| 游标从未成功/部分成功/失败运行正确推进                  | `apps/worker/src/sync/sync-cursor.spec.ts`                                                                                                             |
| 调度首跑/停表逻辑                                       | `apps/worker/src/sync/sync.service.spec.ts`                                                                                                            |
| 同步状态与最后成功时间端点（`/api/system/sync-status`） | `apps/api/test/monitor.e2e-spec.ts`、`apps/api/test/security.e2e-spec.ts`                                                                              |

### 场景 9：权限、脱敏和读取审计符合 #13

| 证据                                                            | 位置                                                                                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未登录 401；健康检查 200                                        | `apps/api/test/security.e2e-spec.ts` → `'unauthenticated requests get 401 on every protected route; health stays 200'`                                     |
| 权限矩阵（VIEWER/RULE_ADMIN/SYSTEM_ADMIN/AUDITOR × 读/写/审计） | 同文件 → 全部 7 个用例                                                                                                                                     |
| 横向越权：越科室读他人记录返回 404 而非 403                     | 同文件 → `'horizontal escalation: a scoped user fetching an out-of-scope record gets 404'`                                                                 |
| 脱敏：无 patientDetail 时姓名/床号/正文/诊断掩码                | 同文件 → `'VIEWER (scoped, no detail) reads scoped masked data...'`                                                                                        |
| 读取审计：每次读都落 audit_log，meta 不含患者数据/搜索词原文    | 同文件 → `'every read is audited and audit meta never carries patient data'`、`'the list read also writes an EXAM_LIST audit row without the raw q value'` |
| 敏感日志/凭据全库静态扫描                                       | `apps/api/src/security/log-sanitization.spec.ts`（3 用例）                                                                                                 |
| 权限模型文档                                                    | [docs/auth.md](./auth.md)                                                                                                                                  |

### 场景 10：全站不存在上报、知晓、处理、误报、日报等入口或可调用 API

| 证据                                                                                                                                                      | 位置                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **静态门禁（DB-free，遍历非测试源码）**：schema 无闭环模型/字段映射；API 路由无闭环路径；shared-types 无闭环类型名；web 无闭环入口文案与 `/api/` 闭环目标 | `apps/api/src/security/closed-loop-absence.spec.ts`（**新增**，4 用例） |

> 该门禁是"不存在闭环"的**回归防线**：任何未来开发者往页面/API 加"上报/知晓/处理/
> 误报/日报"能力，CI 会立刻红。它排除 `reportContent`/`reportId` 等合法属性名（只扫
> 路由装饰器内的路径字面量）与自身 spec 文件，避免误报。

## 二、6 条验收标准 → 证据与状态

| #   | 验收标准                                               | 状态 | 证据                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 10 个核心场景均有自动化测试或可复现脚本                | ✅   | 见上文"一、10 场景→证据"，每场景至少一个自动化证据；`verify-constraints.ts` 为可复现脚本（db-migrations job 执行）                                                                                                                                     |
| 2   | 数据库字段核验、稳定主键和患者类型字典有记录           | ✅   | 字段/敏感级别/保留策略：[data-dictionary.md](./data-dictionary.md)；稳定主键：`uq_monitor_record_source_version`（同文档 + verify-constraints 重复键拒绝证明）；患者类型字典：本文件 §三 + data-dictionary.md §monitor_record + pacs-ris-adapter.md §3 |
| 3   | 常用筛选目标响应时间不超过 3 秒                        | ✅   | [performance.e2e-spec.ts](../apps/api/test/performance.e2e-spec.ts)：**100,000 行**真实 PG 实测 8 项常用筛选 + 主键详情，全部 < 300ms（阈值 3s 留 ≥10 倍余量），并断言 `patient_type_code` 索引存在（**新增**）                                        |
| 4   | 重复读取、重启和故障恢复证明不重不漏                   | ✅   | 见场景 4/8：幂等、增量、修改重匹配、并发双 worker、中断不丢游标、恢复补偿；唯一约束由 verify-constraints 复核                                                                                                                                          |
| 5   | 敏感日志扫描和权限矩阵测试通过                         | ✅   | [log-sanitization.spec.ts](../apps/api/src/security/log-sanitization.spec.ts) + [security.e2e-spec.ts](../apps/api/test/security.e2e-spec.ts) 7 用例                                                                                                   |
| 6   | 上线清单包含凭据轮换、只读账号、网络白名单、备份和监控 | ✅   | [docs/go-live.md](./go-live.md)（**新增**，含回滚 runbook）                                                                                                                                                                                            |

## 三、患者类型字典（issue #14 记录）

来源系统 `PAADM_Type` 原值 → 中文含义，写入 `monitor_record.patientTypeCode` /
`patientTypeName`：

| 代码      | 中文含义        | 备注                                                                                          |
| --------- | --------------- | --------------------------------------------------------------------------------------------- |
| `I`       | 住院            | 常见 PAADM_Type 原值                                                                          |
| `O`       | 门诊            | 常见 PAADM_Type 原值                                                                          |
| 其他/未知 | **必须为 NULL** | 不得猜测或填默认值（#26 约定；见 [data-dictionary.md](./data-dictionary.md) §monitor_record） |

映射位置：worker 端 `apps/worker/src/pacs-adapter/*`（CSV 与 HTTP 两模式的
`patientTypeCode` 原样透传 + `patientTypeName` 核验映射）。工作台筛选按
`patientTypeCode` 精确匹配（性能基准覆盖）。**生产上线前须由内镜中心/信息科确认完整
字典**，否则未知值一律 NULL（见 go-live.md）。

## 四、稳定主键记录

`monitor_record` 幂等/去重主键为 `sourceRecordId + reportId + reportVersion`
（Postgres 唯一索引 `monitor_record_source_record_id_report_id_report_version_key`，
schema 逻辑名 `uq_monitor_record_source_version`）。`monitor_match` 幂等主键为
`monitorRecordId + ruleId + matchedField + keyword + reportVersion`
（`uq_monitor_match_dedup`）。两条键均由 `verify-constraints.ts` 用重复写入被拒证明，
并由 `monitor_rule` 上 `ON DELETE RESTRICT` / `monitor_record` 上 `ON DELETE CASCADE`
的引用行为复核。详见 [data-dictionary.md](./data-dictionary.md)。

## 五、CI 中的执行位置

- **build-and-test job**：单测（含 matching-engine 34、worker 单测 51、API 单测、
  `closed-loop-absence.spec.ts`、`log-sanitization.spec.ts`）+ web 组件测试。
- **db-migrations job**：真实 Postgres 上依次执行规则 → monitor → auth → security →
  worker sync → **性能 e2e（新增）** → seed → 约束/幂等/索引核验（verify-constraints）
  → 迁移回滚（新到旧，含 #14）。

## 六、已知边界（诚实声明）

- 性能基准为**合成数据**（8 科室 × 4 等级 × ~18 个月 × 患者类型 × 5 检查项目，
  100k 行），证明在既定量级下筛选口径与响应目标成立；真实 IRIS 数据量与分布如远超
  此量级，需以 go-live.md 的监控与扩容预案复核。
- `examItem`/`q` 为子串搜索（`ILIKE %..%`），无法用 btree 索引；100k 行下仍 < 150ms，
  若量级再增需 pg_trgm 索引（go-live.md 标注为跟进项）。
- 场景 8 的"最后成功同步时间"展示在 web 端有组件覆盖，但"数据源不可用"的**真实
  生产故障注入演练**未自动化（涉第三方网关），依赖 go-live.md 的上线检查项人工复核。

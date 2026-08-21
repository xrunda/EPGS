# EPGS 增量同步任务（issue #6）

本文档描述 `apps/worker/src/sync/` 实现的后端增量同步任务：定期从
`PacsRisAdapter`（issue #2）增量读取报告、调用 `packages/matching-engine`
（issue #5）做关键词匹配、幂等写入监测库（issue #3 的
`MonitorRecord`/`MonitorMatch`），并通过 `apps/api` 的
`GET /api/system/sync-status` 暴露健康状态。

## 1. 组件与数据流

```text
PacsRisAdapter (fixture / sql骨架 / http)
        │  fetchReports(since, until, cursor, pageSize)
        ▼
SyncService (@nestjs/schedule 自调度 setTimeout)
        │  runSync()  ── apps/worker/src/sync/sync-runner.ts
        ├─ resolveCursor()  读取上次成功 SyncJobLog.cursorEnd - lookback
        ├─ matchReport()    packages/matching-engine（纯函数）
        └─ upsertReport()   Prisma upsert MonitorRecord / createMany MonitorMatch
        ▼
Postgres（apps/api 与 apps/worker 共享同一实例）
        ▲
        │  直接查询 sync_job_log（无内部 RPC）
GET /api/system/sync-status（apps/api/src/system/）
```

## 2. `HttpPacsRisAdapter`（`apps/worker/src/pacs-adapter/http-pacs-ris-adapter.ts`）

对接 issue #20 的 `docs/api/pacs-ris-data-api.md` / `.openapi.yaml` 契约。

- HTTP 客户端使用 Node 24 内置 `fetch`（未引入 axios/undici 作为生产依赖；
  `undici` 仅作为测试期 devDependency，用于 mock，见下文）。
- 字段映射：契约 `PacsReport` 的字段名与 issue #2 的内部 `PacsReportDto`
  （`packages/shared-types/src/pacs-ris.ts`）**逐字段同名**（`patientId`/
  `inpatientNo`/`patientName`/`sex`/`age`/`department`/`bedNo`/
  `studyAccessionNo`/`examItem`/`examTime`/`reportId`/`reportStatus`/
  `rawStatusCode`/`reportSavedAt`/`reportSubmittedAt`/`reportReviewedAt`/
  `describeText`/`diagnoseText`/`sourceUpdatedAt`），因此不需要重命名层，
  但仍对每个字段做防御式类型校验（`mapWireReportToDto`），不信任跨组织边界
  传来的数据。
- 状态映射：契约的标准状态枚举（`EXAM_IN_PROGRESS`/`AWAITING_REPORT`/
  `DRAFT`/`PENDING_REVIEW`/`REVIEWED`/`FINAL_REVIEWED`/`UNKNOWN`）与
  `PacsReportStatus` 的值也逐一相同，映射是直通而非转换；任何不在这七个
  已知值中的字符串一律映射为 `UNKNOWN`，不猜测。
- 错误映射：401/403/400/404 → `PacsHttpAuthError`（不重试，由同步任务记录
  清晰错误摘要）；429/503/5xx/网络错误/超时 → `PacsHttpTransientError`（可
  被同步任务的指数退避重试）；200 但响应体不符契约 → `PacsHttpContractError`。
  以上错误类型均不在异常信息中回显响应体细节或 Token。
- 环境变量：`PACS_HTTP_BASE_URL`、`PACS_HTTP_SERVICE_TOKEN`（Bearer Token，
  绝不写入日志或异常信息）、`PACS_HTTP_TIMEOUT_MS`（默认 10000）。
- **未发现字段级不一致**：契约字段与内部 DTO 完全同名同义，唯一需要说明的
  是这不是巧合——两者都源自同一份 PACS/RIS 工作流术语表（issue #2 的
  `docs/pacs-ris-adapter.md` 假设的源库字段推演出的内部 DTO，恰好与 issue
  #20 后续交付的网关契约在命名上对齐）。

### Mock HTTP server 测试

`apps/worker/src/pacs-adapter/http-pacs-ris-adapter.spec.ts` 使用
`undici` 的 `MockAgent`，覆盖：

- 分页（`nextCursor` 透传、多页游走）
- 鉴权头（`Authorization: Bearer <token>` + `X-Request-Id`，Token 不泄漏）
- 错误码：401/403 → `PacsHttpAuthError`；429/503/500 → `PacsHttpTransientError`
  （500 场景额外断言异常信息不包含模拟的敏感 SQL 片段）
- 超时（10ms 超时 + 200ms 延迟响应）
- 契约违反：`data.items` 缺失、单条报告缺少必填字段
- `pageSize` 上限裁剪（>500 → 500）
- 状态映射：未知值 → `UNKNOWN`；七个已知值逐一直通验证

**为什么不用 `nock`**：`nock` 13.x 只 patch 传统 `http`/`https` 模块，不拦截
Node 原生 `fetch` 所依赖的 undici dispatcher；在本仓库的 Jest + ts-jest 环境
下，`setGlobalDispatcher` 对全局 `fetch` 也不生效（`globalThis.fetch !==
require('undici').fetch`，已实测验证）。改为通过 adapter 已有的
`fetchImpl` 构造参数注入绑定了 `MockAgent` 的 `undici.fetch`，可靠且不改变
生产代码路径。

## 3. 同步任务本体（`apps/worker/src/sync/`）

### 幂等 / 游标设计

- 游标以 `sourceUpdatedAt`（ISO 字符串）持久化在 `SyncJobLog.cursorEnd`，
  下次运行从**上一次 SUCCEEDED 或 PARTIAL** 运行的 `cursorEnd` 减去回看窗口
  继续（`sync-cursor.ts#resolveCursor`）。`FAILED` 运行的游标**永不**被采用，
  避免推进到丢数据的位置。
- 首次运行（无历史成功记录）使用 `firstRunLookbackMinutes`（当前 CLI/服务
  内部固定取回看窗口本身或 1 小时兜底，见 `sync.service.ts`）。
- `MonitorRecord` 按唯一键 `(studyAccessionNo, reportId, reportVersion)`
  upsert；仅当写入前查得的既有行 `sourceUpdatedAt` 严格早于本次数据时才
  重新调用 `matchReport()` 并写入 `MonitorMatch`——同一报告版本的重复批次
  不会重复生成命中。`MonitorMatch` 额外受 schema 唯一键
  `(monitorRecordId, ruleId, matchedField, keyword, reportVersion)` 保护，
  `createMany` 使用 `skipDuplicates: true` 兜底。
- 两个 worker 并发处理同一条新记录时，Prisma 的 `upsert` 在 Postgres 上
  编译为原子的 `INSERT ... ON CONFLICT DO UPDATE`；败者事务可能命中
  `P2002`（唯一键冲突），`upsertReportWithConcurrencyRetry` 捕获后重试一次
  （重新读取，正确判定为"已是最新，跳过重新匹配"），因此不产生重复
  `MonitorRecord`/`MonitorMatch`。

### 重试 / 退避

- 单条报告处理失败（Prisma 写入异常、matchReport 罕见异常等）只计入该次
  `SyncJobLog.failureCount`，记录脱敏错误摘要（仅 `reportId`/
  `studyAccessionNo` 等来源标识，不含姓名/住院号/报告正文），继续处理下一
  条 —— 状态标记为 `PARTIAL`（而非 `FAILED`）。
- 整批失败（adapter 抛 `PacsHttpTransientError` 或等价瞬时错误）由
  `retry.ts#withRetry` 做指数退避（`SYNC_RETRY_BASE_DELAY_MS *
  2^attempt`），达到 `SYNC_MAX_RETRIES` 后仍失败则整次运行标记 `FAILED`，
  `cursorEnd` 只提交到本次运行中**已成功处理**的最后一条记录的
  `sourceUpdatedAt`（而非窗口结束时间），下次运行据此续跑，不丢数据。
- 非重试错误（如 `PacsHttpAuthError`）立即失败，不消耗重试次数。

### 回看窗口

- `SYNC_LOOKBACK_MINUTES`（默认 10，范围 0-120）：每次运行在游标基础上
  额外往回读取这段时间，覆盖数据源短暂故障恢复后的补偿窗口和迟到写入
  （源端时间戳落后于实际同步节奏的情况）。由于全链路幂等，重复读取已同步
  过的记录不会产生重复数据，只会重新走一次"内容是否变化"的判断。

### 时区

- 所有持久化时间字段沿用 issue #3 已定义的 `@db.Timestamptz(6)`（UTC 存储），
  同步逻辑内部（游标比较、窗口计算）全部基于 `Date`/UTC epoch 运算，不引入
  手工时区偏移计算。仅日志展示层（`time-format.ts#formatShanghai`）使用
  `Intl.DateTimeFormat` 以 `Asia/Shanghai` 显示，避免了"手动加 8 小时"
  这类经典时区 bug。测试（`time-format.spec.ts`）用可控 `Date` 验证跨日
  和固定 UTC+8 偏移（不依赖中国不实行夏令时这一假设本身，只是巧合利用了它）。

## 4. `GET /api/system/sync-status`（`apps/api/src/system/`）

`apps/api` 与 `apps/worker` 共享同一个 Postgres，因此 `apps/api` 直接查询
`sync_job_log` 表返回状态，未搭建 worker↔api 的内部 RPC。

响应字段（`packages/shared-types/src/sync-status.ts`）：`jobName`、
`health`（`HEALTHY`/`DELAYED`/`FAILED`/`UNKNOWN`）、`lastSuccessAt`、
`lastRunAt`、`lastRunStatus`、`cursor`、`readCount`/`successCount`/
`failureCount`、`errorSummary`（脱敏）、`syncIntervalMinutes`。

健康分级（`sync-status.service.ts#classifyHealth`，均以配置的
`SYNC_INTERVAL_MINUTES` 为基准倍数）：

| 分级 | 判定条件 |
|---|---|
| `UNKNOWN` | 从未运行过（无 `sync_job_log` 记录） |
| `HEALTHY` | 最近一次成功运行在 3 倍同步周期内 |
| `DELAYED` | 最近一次成功运行超过 3 倍但未超过 8 倍周期；或从未成功过但最近一次尝试未失败/未卡死 |
| `FAILED` | 最近一次运行状态为 `FAILED`；或最近成功运行已超过 8 倍周期；或存在一个运行状态为 `RUNNING` 但已超过 4 倍周期仍未结束（判定为卡死/进程崩溃未更新状态） |

阈值倍数（`DELAYED_THRESHOLD_MULTIPLIER=3`、`FAILED_THRESHOLD_MULTIPLIER=8`、
`STUCK_RUNNING_THRESHOLD_MULTIPLIER=4`）是本 issue 的工程默认值，未经运维
最终拍板，见下文"待确认事项"。

## 5. 手动触发同步

**选择：CLI 脚本（`pnpm --filter worker run sync:once`），而非 HTTP 端点。**

理由（详见 `apps/worker/src/sync/run-once.ts` 顶部注释）：

1. 不新增攻击面——即使"内网不对外暴露"，一个监听端口仍需要自己的鉴权/
   网络策略，CLI 脚本没有这个问题，只有拿到 worker 运行环境 shell 权限的人
   才能触发。
2. 复用真实 `AppModule`（含真实 env 校验、DI、真实的 `PACS_RIS_ADAPTER`/
   `PrismaService`），手动触发与定时 tick 走同一段代码，不会产生"手动路径
   和自动路径逻辑分叉"的风险。
3. 与仓库既有约定一致——issue #4 的种子脚本也是 npm script
   （`prisma db seed`），而非 HTTP 端点。

退出码：`0`=`SUCCEEDED`，`1`=`FAILED`/未预期错误，`2`=`PARTIAL`（部分记录
失败但整体有进展），便于运维脚本/CI 判断结果而不必解析日志。

权衡（已记录，非隐瞒）：这要求可以访问 worker 运行环境（env 变量、到
Postgres 及 `http` 模式下到 #20 网关的网络可达性），而不是一次简单的、来自
独立运维工具的鉴权 HTTP 调用。如果后续 issue 需要"可远程触发"的端点，应在
那时补充恰当的鉴权，而不是复用本脚本的信任模型。

## 6. 本地真实 Postgres 验证

沿用 issue #3/#4 的临时实例配方：

```bash
initdb -D /tmp/epgs-pgdata -U epgs --auth=trust -E UTF8
pg_ctl -D /tmp/epgs-pgdata -o "-p 5544 -k /tmp" -l /tmp/epgs-pg.log start
createdb -h /tmp -p 5544 -U epgs epgs
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec prisma migrate deploy

# 端到端同步（FixturePacsRisAdapter，8 条合成数据）
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter worker run sync:once

# 幂等重跑（不产生重复 MonitorRecord/MonitorMatch）
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter worker run sync:once

# 完整场景化 e2e 套件（首次全量窗口/增量/同时间戳/重复批次/进程中断恢复/
# 迟到更新/源不可用/单条坏数据/并发 worker）
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter worker exec jest --config ./test/jest-e2e.json test/sync.e2e-spec.ts

pg_ctl -D /tmp/epgs-pgdata stop
rm -rf /tmp/epgs-pgdata /tmp/epgs-pg.log
```

CI 中，上述 e2e 套件运行在 `.github/workflows/ci.yml` 的 `db-migrations`
job，紧跟 issue #4 的 rules e2e 套件之后、迁移回滚步骤之前。

## 7. 待确认事项（本 issue 不擅自决定）

1. `GET /api/system/sync-status` 的健康分级阈值倍数（3×/8×/4× 同步周期）
   是工程默认值，未与运维口径核对，实际告警阈值应由运维/信息科确认。
2. 回看窗口默认值 `SYNC_LOOKBACK_MINUTES=10` 同样是工程默认，具体应覆盖
   的"数据源可能停机时长"需业务/运维确认；已做成环境变量方便后续调整。
3. `MonitorRecord.reportVersion` 目前恒为 1（issue #2 的 `PacsReportDto`
   未提供显式版本字段，只提供 `reportId`+`sourceUpdatedAt`）；若 issue #20
   后续为契约新增版本字段，应更新 `sync-runner.ts#resolveReportVersion`。
4. `patientIdMasked` 的脱敏规则沿用 issue #3 文档中"待确认"的占位实现
   （仅保留末 4 位），最终规则需信息科审核（见 `docs/data-dictionary.md`）。
5. `SqlPacsRisAdapter`（issue #2 遗留骨架）仍未连接真实驱动，本 issue 未
   触碰，`PACS_ADAPTER_MODE=sql` 依旧不可用于真实环境。

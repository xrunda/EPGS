# EPGS 监测业务数据字典（issue #3）

本文档描述 `apps/api/prisma/schema.prisma` 中监测业务库的表结构、字段含义、
敏感级别与保留策略。适用范围：`monitor_rule`、`monitor_record`、
`monitor_match`、`monitor_action`、`sync_job_log` 五张核心表及相关枚举。

本库与 PACS/RIS **解耦**：不复制影像文件，不作为患者主数据的系统记录
（system of record）——PACS/RIS/HIS 才是。本库只保存"支撑监测工作台展示、
去重幂等和审计追溯"所必需的最小数据快照。

## 敏感级别定义

- **高敏感（HIGH）**：可直接识别患者身份的信息。禁止出现在日志、错误消息、
  `sync_job_log.error_summary` 中；仅限授权角色在工作台详情页查看；未来
  API（issue #4/#7/#8）必须做访问控制和脱敏返回。
- **中敏感（MEDIUM）**：间接识别信息或医疗片段，需要访问控制但可用于列表/筛选展示。
- **低敏感（LOW）**：内部运营元数据，不涉及患者隐私。

## 枚举

| 枚举 | 取值 | 说明 |
|---|---|---|
| `MonitorLevel` | `RED` `YELLOW` `GREEN` `UNCLASSIFIED` | 关注等级，是"关注等级管理"而非正式诊断结论。固定四值，新增需走 issue 评审。 |
| `HandlingStatus` | `PENDING` `REPORTED` `ACKNOWLEDGED` `RESOLVED` `FALSE_POSITIVE` | 闭环处置状态，由 `monitor_action` 时间线的最新一条动作派生。 |
| `MatchField` | `FINDINGS` `IMPRESSION` `REPORT_TEXT` `STUDY_DESCRIPTION` `OTHER` | 命中/规则作用的报告字段，具体解释权在 issue #5 匹配引擎。 |
| `MatchMode` | `EXACT` `CONTAINS` `REGEX` | 关键词匹配方式。 |
| `ReportStatus` | `PRELIMINARY` `FINAL` `AMENDED` `UNKNOWN` | 源系统报告审核状态快照，非本系统处置状态。 |
| `ActionType` | `REPORTED` `ACKNOWLEDGED` `RESOLVED` `MARKED_FALSE_POSITIVE` `REOPENED` | 闭环动作类型。 |
| `SyncJobStatus` | `RUNNING` `SUCCEEDED` `FAILED` `PARTIAL` | 同步任务运行结果。 |

## monitor_rule — 关键词规则

规则采用"版本化 + 软停用"策略：编辑会改变匹配语义时应新建一行
（`version = 上一版本 + 1`，共享同一个 `ruleGroupId`），而不是原地更新，
以保证历史 `monitor_match` 始终能追溯到产生它的确切规则版本。

| 字段 | 类型 | 敏感级别 | 说明 |
|---|---|---|---|
| `id` | UUID PK | LOW | 规则版本主键 |
| `keyword` | varchar(255) | LOW | 关键词/短语 |
| `level` | MonitorLevel | LOW | 命中后赋予的等级 |
| `matchField` | MatchField | LOW | 作用字段 |
| `matchMode` | MatchMode | LOW | 匹配方式，默认 CONTAINS |
| `category` | varchar(100)? | LOW | 分组标签（如科室/瘤种），自由文本非外键 |
| `isEnabled` | boolean | LOW | 软启停开关；停用不删除，保留历史引用 |
| `version` | int | LOW | 同一逻辑规则的版本号 |
| `ruleGroupId` | UUID | LOW | 同一逻辑规则的稳定分组标识 |
| `notes` | text? | LOW | 审核备注/临床依据 |
| `createdAt`/`updatedAt` | timestamptz | LOW | 审计时间戳 |
| `createdBy`/`updatedBy` | varchar(100) | MEDIUM | 操作人账号（外部身份，非本库外键） |

保留策略：规则版本永久保留，不做过期清理（属于配置审计数据，体量小）。

## monitor_record — 检查/报告监测主记录

保存"当前状态"：当前最高等级、首次/最近命中时间、报告状态、处置状态。
全部命中明细在 `monitor_match`，全部处置历史在 `monitor_action`。

**幂等约束**：`@@unique([studyAccessionNo, reportId, reportVersion])`
（`uq_monitor_record_source_version`）。同步任务对同一来源检查/报告版本
重复写入时必须按此键 upsert，不产生重复行。

| 字段 | 类型 | 敏感级别 | 说明 |
|---|---|---|---|
| `id` | UUID PK | LOW | 主键 |
| `studyAccessionNo` | varchar(64) | MEDIUM | 源系统检查号，来源自然键前半部分 |
| `reportId` | varchar(64) | MEDIUM | 源系统报告 ID，来源自然键后半部分 |
| `reportVersion` | int | LOW | 源报告版本号（如修订后递增） |
| `sourceUpdatedAt` | timestamptz | LOW | 源系统报告最后更新时间，配合 reportVersion 做幂等/陈旧判断 |
| `patientName` | varchar(100)? | **HIGH** | 患者姓名快照，仅供工作台详情展示 |
| `patientIdMasked` | varchar(50)? | **HIGH** | 脱敏后的患者标识（如仅保留末 4 位），禁止存完整身份证号 |
| `inpatientNo` | varchar(64)? | **HIGH** | 住院/门诊号快照 |
| `department` | varchar(100)? | MEDIUM | 开单/执行科室，工作台筛选用 |
| `studyDescription` | varchar(255)? | MEDIUM | 检查项目描述（如"胃镜""肠镜"） |
| `studyTime` | timestamptz? | MEDIUM | 检查执行时间 |
| `currentLevel` | MonitorLevel | LOW | 当前最高关注等级（去规范化，由匹配引擎维护） |
| `firstMatchedAt`/`lastMatchedAt` | timestamptz? | LOW | 首次/最近命中时间 |
| `reportStatus` | ReportStatus | LOW | 源系统报告审核状态快照 |
| `handlingStatus` | HandlingStatus | LOW | 本系统闭环处置状态（派生自 monitor_action 最新记录） |
| `reportTextCache` | text? | **HIGH（见下方缓存策略）** | 可选的报告原文缓存 |
| `reportTextCacheExpiresAt` | timestamptz? | LOW | 缓存过期时间，缓存有值时必须同时设置（应用层强制，Postgres 无法表达跨列条件约束） |
| `createdAt`/`updatedAt` | timestamptz | LOW | 审计时间戳 |

### 报告原文缓存策略（待产品/信息科最终确认，详见文末"待确认事项"）

- **默认不缓存**：`reportTextCache` 默认 NULL；本 issue 不实现任何写入/读取逻辑。
- 若后续业务确需缓存报告原文用于详情展示，建议策略（草案，需信息科审核）：
  - **保留期限**：建议 ≤ 90 天，到期由定时任务清空 `reportTextCache`（置 NULL），
    仅保留 `monitor_match.contextSnippet`（短摘要）用于长期审计。
  - **加密**：建议应用层对该列做列级加密（如 AES-256-GCM，密钥由 KMS/环境变量管理，
    不与数据库密码同库存放），而非依赖数据库透明加密；本 issue 不实现加密，仅在此
    声明策略供后续 issue 落地。
  - **访问控制**：仅工作台详情页在用户有权限时按需解密展示，禁止出现在列表接口、
    导出文件或日志中。

## monitor_match — 命中证据明细

保存全部命中明细（与 `monitor_record.currentLevel` 的"当前最高等级"并存，
互不覆盖）。

**幂等约束**：`@@unique([monitorRecordId, ruleId, matchedField, keyword, reportVersion])`
（`uq_monitor_match_dedup`）。同一报告版本下，同一规则对同一字段/关键词的
命中只会被记录一次。

| 字段 | 类型 | 敏感级别 | 说明 |
|---|---|---|---|
| `id` | UUID PK | LOW | 主键 |
| `monitorRecordId` | UUID FK → monitor_record, `ON DELETE CASCADE` | LOW | 所属记录；记录删除时命中明细一并级联删除 |
| `ruleId` | UUID FK → monitor_rule, `ON DELETE RESTRICT` | LOW | 命中的规则版本；有命中引用时禁止删除该规则版本，保证审计可追溯 |
| `keyword` | varchar(255) | LOW | 命中时刻的关键词快照（即使规则后续改版，本行不变） |
| `level` | MonitorLevel | LOW | 命中时刻赋予的等级快照 |
| `matchedField` | MatchField | LOW | 命中字段 |
| `contextSnippet` | varchar(500) | **HIGH** | 命中上下文摘要（非全文），供证据展示 |
| `reportVersion` | int | LOW | 命中时对应的报告版本 |
| `matchedAt` | timestamptz | LOW | 命中时间 |

保留策略：作为审计证据，不主动删除；随所属 `monitor_record` 级联删除（若该记录被删除）。

## monitor_action — 闭环处置时间线（Append-Only）

**硬性约束（业务规则，非数据库触发器强制）**：本表只允许 `INSERT`，
**禁止 `UPDATE`/`DELETE` 历史记录**。`monitor_record.handlingStatus` 是
从本表最新一条记录派生的去规范化投影，重建当前状态的方式是"取该
`monitorRecordId` 按 `occurredAt` 排序的最后一条 `monitor_action`"，
而不是就地修改状态字段。

> 说明：本 issue 未在数据库层配置只读触发器/权限锁定（不在 issue #3 范围），
> 该约束由 `schema.prisma` 中的模型注释与本文档共同作为"契约"文档化，
> 供 issue #8（处置动作 API）实现时遵守：其 service 层不得提供
> update/delete 方法。

| 字段 | 类型 | 敏感级别 | 说明 |
|---|---|---|---|
| `id` | UUID PK | LOW | 主键 |
| `monitorRecordId` | UUID FK → monitor_record, `ON DELETE CASCADE` | LOW | 所属记录 |
| `actionType` | ActionType | LOW | 动作类型 |
| `actorId` | varchar(100) | MEDIUM | 操作人账号 |
| `recipientId` | varchar(100)? | MEDIUM | 上报接收人（仅 REPORTED 类动作适用） |
| `note` | text? | MEDIUM | 备注（如误报原因、处理结论） |
| `occurredAt` | timestamptz | LOW | 动作发生时间 |

保留策略：作为审计时间线永久保留，随所属 `monitor_record` 级联删除。

## sync_job_log — 同步任务日志

不包含任何患者数据；`errorSummary` 只允许记录来源标识/错误摘要，
禁止写入患者姓名、住院号等信息。

| 字段 | 类型 | 敏感级别 | 说明 |
|---|---|---|---|
| `id` | UUID PK | LOW | 主键 |
| `jobName` | varchar(100) | LOW | 逻辑任务名 |
| `cursorStart`/`cursorEnd` | varchar(255)? | LOW | 断点续传游标 |
| `windowStart`/`windowEnd` | timestamptz? | LOW | 本次同步覆盖的时间窗口 |
| `status` | SyncJobStatus | LOW | 运行结果 |
| `readCount`/`successCount`/`failureCount` | int | LOW | 读取/成功/失败数量 |
| `errorSummary` | text? | LOW（**内容需脱敏**） | 错误摘要，禁止含患者数据 |
| `startedAt`/`finishedAt` | timestamptz | LOW | 运行起止时间 |

保留策略：建议保留 ≥ 6 个月用于运维审计，具体周期待运维/信息科确认。

## 索引设计对照工作台常用筛选

| 筛选维度 | 索引 |
|---|---|
| 时间（检查时间/最近命中） | `monitor_record(study_time)`、`monitor_record(last_matched_at)` |
| 等级 | `monitor_record(current_level)`、`monitor_match(level)` |
| 科室 | `monitor_record(department)` |
| 报告状态 | `monitor_record(report_status)` |
| 处置状态 | `monitor_record(handling_status)` |
| 来源唯一键 | `monitor_record(study_accession_no, report_id)` + 唯一索引 `(study_accession_no, report_id, report_version)` |
| 规则维度 | `monitor_rule(level, is_enabled)`、`monitor_rule(rule_group_id)`、`monitor_rule(category)` |
| 命中明细按记录/规则/时间查询 | `monitor_match(monitor_record_id)`、`monitor_match(rule_id)`、`monitor_match(matched_at)` |
| 处置时间线按记录+时间查询 | `monitor_action(monitor_record_id, occurred_at)`、`monitor_action(action_type)` |
| 同步任务运维查询 | `sync_job_log(job_name, started_at)`、`sync_job_log(status)` |

## 迁移与回滚

- 迁移文件：`apps/api/prisma/migrations/20260821040339_init_monitoring_schema/migration.sql`
- 回滚脚本：`apps/api/prisma/migrations/20260821040339_init_monitoring_schema/rollback.sql`
  （Prisma Migrate 本身没有内建 down-migration 机制，回滚脚本需手动执行，
  详见脚本头部注释）。
- 已在本地真实 Postgres 16 实例（Homebrew 安装，非仓库依赖）上验证：
  空库正向迁移成功 → 约束测试（重复来源键、非法枚举、重复命中、级联删除、
  RESTRICT 删除、索引命中）全部符合预期 → 回滚脚本清空所有表/类型 → 清除
  `_prisma_migrations` 历史行后重新正向迁移成功，schema 与 `prisma migrate diff`
  比对无差异。验证脚本为本次会话的临时文件，未提交仓库。

## 待确认事项（需产品/信息科最终拍板，本 issue 不擅自决定）

1. `reportTextCache` 是否确需启用、具体保留天数、加密算法与密钥管理方案。
2. `patientIdMasked` 的脱敏规则（保留末几位、脱敏算法）需与信息科现行规范对齐。
3. `sync_job_log` 的具体保留周期。
4. `monitor_action` 的数据库层只读强制（如专用只读角色、触发器拒绝
   UPDATE/DELETE）是否要在后续 issue（#6/#8）中补充，或仅靠应用层约束。

# EPGS 监测业务数据字典（issue #3 / issue #26）

本文档描述 `apps/api/prisma/schema.prisma` 中监测业务库的表结构、字段含义、
敏感级别与保留策略。适用范围：`monitor_rule`、`monitor_record`、
`monitor_match`、`sync_job_log` 四张监测核心表、Issue #31 的 `app_user` 本地账号表
及相关枚举。

> 范围说明（issue #26）：本库已**移除闭环上报模型**。不再保存/展示
> 待上报/已上报/已知晓/已处理/误报等处置状态与 `monitor_action` 处置时间线，
> 也不保存报告审核状态（`ReportStatus`）或报告原文缓存。`monitor_record`
> 收敛为**只读展示数据**：来源稳定 ID + 患者/检查展示字段 + 当前关注等级 +
> 命中证据（命中证据明细在 `monitor_match`）。关注等级仅影响工作台的颜色/
> 排序/筛选，不再触发任何上报动作。

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

| 枚举            | 取值                                                              | 说明                                                                        |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `MonitorLevel`  | `RED` `YELLOW` `GREEN` `UNCLASSIFIED`                             | 关注等级，是"关注等级管理"而非正式诊断结论。固定四值，新增需走 issue 评审。 |
| `MatchField`    | `FINDINGS` `IMPRESSION` `REPORT_TEXT` `STUDY_DESCRIPTION` `OTHER` | 命中/规则作用的报告字段，具体解释权在 issue #5 匹配引擎。                   |
| `MatchMode`     | `EXACT` `CONTAINS` `REGEX`                                        | 关键词匹配方式。                                                            |
| `SyncJobStatus` | `RUNNING` `SUCCEEDED` `FAILED` `PARTIAL`                          | 同步任务运行结果。                                                          |

## app_user — 本地登录账号

`app_user` 不保存患者数据，也不建立会话记录。密码只保存 Argon2id 不可逆哈希；
`passwordVersion` 在修改或管理员重置密码时递增，用于使旧 JWT 失效。

| 字段                    | 类型                | 敏感级别 | 说明                                |
| ----------------------- | ------------------- | -------- | ----------------------------------- |
| `id`                    | UUID PK             | LOW      | 本地用户主键                        |
| `username`              | varchar(50), unique | MEDIUM   | 标准化为小写的登录账号              |
| `displayName`           | varchar(100)        | MEDIUM   | 页面显示名称                        |
| `passwordHash`          | varchar(255)        | **HIGH** | Argon2id 哈希，禁止返回、记录或导出 |
| `passwordVersion`       | int                 | LOW      | 密码版本，默认 1                    |
| `isActive`              | boolean             | LOW      | 账号是否可登录                      |
| `createdAt`/`updatedAt` | timestamptz         | LOW      | 创建和更新时间                      |

## monitor_rule — 关键词规则

规则采用"版本化 + 软停用"策略：编辑会改变匹配语义时应新建一行
（`version = 上一版本 + 1`，共享同一个 `ruleGroupId`），而不是原地更新，
以保证历史 `monitor_match` 始终能追溯到产生它的确切规则版本。

| 字段                    | 类型          | 敏感级别 | 说明                                    |
| ----------------------- | ------------- | -------- | --------------------------------------- |
| `id`                    | UUID PK       | LOW      | 规则版本主键                            |
| `keyword`               | varchar(255)  | LOW      | 关键词/短语                             |
| `level`                 | MonitorLevel  | LOW      | 命中后赋予的等级                        |
| `matchField`            | MatchField    | LOW      | 作用字段                                |
| `matchMode`             | MatchMode     | LOW      | 匹配方式，默认 CONTAINS                 |
| `category`              | varchar(100)? | LOW      | 分组标签（如科室/瘤种），自由文本非外键 |
| `isEnabled`             | boolean       | LOW      | 软启停开关；停用不删除，保留历史引用    |
| `version`               | int           | LOW      | 同一逻辑规则的版本号                    |
| `ruleGroupId`           | UUID          | LOW      | 同一逻辑规则的稳定分组标识              |
| `notes`                 | text?         | LOW      | 审核备注/临床依据                       |
| `createdAt`/`updatedAt` | timestamptz   | LOW      | 审计时间戳                              |
| `createdBy`/`updatedBy` | varchar(100)  | MEDIUM   | 操作人账号（外部身份，非本库外键）      |

保留策略：规则版本永久保留，不做过期清理（属于配置审计数据，体量小）。

## monitor_record — 检查/报告监测主记录

保存"当前状态"：当前最高关注等级、首次/最近命中时间，以及来源检查/报告的
只读展示快照。全部命中明细在 `monitor_match`。本表**不再包含**任何闭环
处置字段（`handlingStatus`/`reportStatus`）或报告原文缓存。

**幂等约束**：`@@unique([sourceRecordId, reportId, reportVersion])`
（Postgres 中的唯一索引名为 `monitor_record_source_record_id_report_id_report_version_key`，
schema 中声明的逻辑名是 `uq_monitor_record_source_version`）。同步任务对同一
来源检查/报告版本重复写入时必须按此键 upsert，不产生重复行。

> **内部记账字段**：`reportId`、`reportVersion`、`sourceUpdatedAt` 是同步
> 作业（issue #6）用于幂等去重与增量变更检测的**内部记账字段**，不属于
> 工作台展示数据；`sourceUpdatedAt` 还驱动增量同步游标。

| 字段                             | 类型          | 敏感级别 | 说明                                                                         |
| -------------------------------- | ------------- | -------- | ---------------------------------------------------------------------------- |
| `id`                             | UUID PK       | LOW      | 主键                                                                         |
| `sourceRecordId`                 | varchar(64)   | MEDIUM   | 来源稳定 ID（由原 `studyAccessionNo` 重命名，issue #26），来源自然键前半部分 |
| `reportId`                       | varchar(64)   | MEDIUM   | 源系统报告 ID（内部记账），来源自然键后半部分                                |
| `reportVersion`                  | int           | LOW      | 源报告版本号（内部记账，如修订后递增）                                       |
| `sourceUpdatedAt`                | timestamptz   | LOW      | 源系统报告最后更新时间（内部记账），配合 reportVersion 做幂等/陈旧判断       |
| `patientName`                    | varchar(100)? | **HIGH** | 患者姓名快照，仅供工作台详情展示                                             |
| `department`                     | varchar(100)? | MEDIUM   | 开单/执行科室，工作台筛选用                                                  |
| `bedNo`                          | varchar(50)?  | MEDIUM   | 床号（新增，issue #26）；门诊/未知为空，展示为"—"                            |
| `patientTypeCode`                | varchar(20)?  | MEDIUM   | 患者类型代码（来源 PAADM_Type 原值，如 `I`/`O`）                             |
| `patientTypeName`                | varchar(50)?  | MEDIUM   | 已核验的患者类型中文含义（住院/门诊/…）；未知必须为 NULL，不得猜测           |
| `examItem`                       | varchar(255)? | MEDIUM   | 检查项目（如"电子胃镜检查"；由原 `studyDescription` 重命名）                 |
| `examTime`                       | timestamptz?  | MEDIUM   | 检查执行时间（由原 `studyTime` 重命名）                                      |
| `currentLevel`                   | MonitorLevel  | LOW      | 当前最高关注等级（去规范化，由匹配引擎维护）                                 |
| `firstMatchedAt`/`lastMatchedAt` | timestamptz?  | LOW      | 首次/最近命中时间                                                            |
| `reportContent`                  | text?         | **HIGH** | 报告内容/检查所见原文快照（来源 `RISR_ExamDesc`，逐字保存、不做清洗）        |
| `diagnosis`                      | text?         | **HIGH** | 诊断意见原文快照（来源 `RISR_DiagDesc`，逐字保存、不做清洗）                 |
| `createdAt`/`updatedAt`          | timestamptz   | LOW      | 审计时间戳                                                                   |

保留策略：作为工作台只读展示数据与审计证据保留；具体保留周期待运维/信息科确认。

## monitor_match — 命中证据明细

保存全部命中明细（与 `monitor_record.currentLevel` 的"当前最高等级"并存，
互不覆盖）。

**幂等约束**：`@@unique([monitorRecordId, ruleId, matchedField, keyword, reportVersion])`
（`uq_monitor_match_dedup`）。同一报告版本下，同一规则对同一字段/关键词的
命中只会被记录一次。

| 字段              | 类型                                          | 敏感级别 | 说明                                                           |
| ----------------- | --------------------------------------------- | -------- | -------------------------------------------------------------- |
| `id`              | UUID PK                                       | LOW      | 主键                                                           |
| `monitorRecordId` | UUID FK → monitor_record, `ON DELETE CASCADE` | LOW      | 所属记录；记录删除时命中明细一并级联删除                       |
| `ruleId`          | UUID FK → monitor_rule, `ON DELETE RESTRICT`  | LOW      | 命中的规则版本；有命中引用时禁止删除该规则版本，保证审计可追溯 |
| `keyword`         | varchar(255)                                  | LOW      | 命中时刻的关键词快照（即使规则后续改版，本行不变）             |
| `level`           | MonitorLevel                                  | LOW      | 命中时刻赋予的等级快照                                         |
| `matchedField`    | MatchField                                    | LOW      | 命中字段                                                       |
| `contextSnippet`  | varchar(500)                                  | **HIGH** | 命中上下文摘要（非全文），供证据展示                           |
| `reportVersion`   | int                                           | LOW      | 命中时对应的报告版本                                           |
| `matchedAt`       | timestamptz                                   | LOW      | 命中时间                                                       |

保留策略：作为审计证据，不主动删除；随所属 `monitor_record` 级联删除（若该记录被删除）。

## sync_job_log — 同步任务日志

不包含任何患者数据；`errorSummary` 只允许记录来源标识/错误摘要，
禁止写入患者姓名、报告正文等可识别信息。

| 字段                                      | 类型          | 敏感级别              | 说明                     |
| ----------------------------------------- | ------------- | --------------------- | ------------------------ |
| `id`                                      | UUID PK       | LOW                   | 主键                     |
| `jobName`                                 | varchar(100)  | LOW                   | 逻辑任务名               |
| `cursorStart`/`cursorEnd`                 | varchar(255)? | LOW                   | 断点续传游标             |
| `windowStart`/`windowEnd`                 | timestamptz?  | LOW                   | 本次同步覆盖的时间窗口   |
| `status`                                  | SyncJobStatus | LOW                   | 运行结果                 |
| `readCount`/`successCount`/`failureCount` | int           | LOW                   | 读取/成功/失败数量       |
| `errorSummary`                            | text?         | LOW（**内容需脱敏**） | 错误摘要，禁止含患者数据 |
| `startedAt`/`finishedAt`                  | timestamptz   | LOW                   | 运行起止时间             |

保留策略：建议保留 ≥ 6 个月用于运维审计，具体周期待运维/信息科确认。

## 索引设计对照工作台常用筛选

| 筛选维度                     | 索引                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| 时间（检查时间/最近命中）    | `monitor_record(exam_time)`、`monitor_record(last_matched_at)`                                           |
| 等级                         | `monitor_record(current_level)`、`monitor_match(level)`                                                  |
| 科室                         | `monitor_record(department)`                                                                             |
| 来源唯一键                   | `monitor_record(source_record_id, report_id)` + 唯一索引 `(source_record_id, report_id, report_version)` |
| 规则维度                     | `monitor_rule(level, is_enabled)`、`monitor_rule(rule_group_id)`、`monitor_rule(category)`               |
| 命中明细按记录/规则/时间查询 | `monitor_match(monitor_record_id)`、`monitor_match(rule_id)`、`monitor_match(matched_at)`                |
| 同步任务运维查询             | `sync_job_log(job_name, started_at)`、`sync_job_log(status)`                                             |

## 迁移与回滚

- 迁移文件：
  - `apps/api/prisma/migrations/20260821040339_init_monitoring_schema/migration.sql`（issue #3 建表）
  - `apps/api/prisma/migrations/20260821073851_remove_closed_loop_readonly/migration.sql`（issue #26 移除闭环模型）
  - `apps/api/prisma/migrations/20260821093500_add_local_auth/migration.sql`（issue #31 增加本地账号）
- 回滚脚本（Prisma Migrate 本身没有内建 down-migration 机制，回滚脚本需手动执行，
  详见脚本头部注释）：
  - `20260821040339_init_monitoring_schema/rollback.sql`
  - `20260821073851_remove_closed_loop_readonly/rollback.sql`
  - `20260821093500_add_local_auth/rollback.sql`
- **生产数据确认门（issue #26）**：`remove_closed_loop_readonly` 迁移开头包含
  PL/pgSQL 数据门禁——若 `monitor_action` 仍存在任何数据，或任意
  `monitor_record.handling_status <> 'PENDING'`，迁移会抛出异常并中止。
  正式升级前必须**备份数据库**并完成数据丢失评审；门禁通过后才能执行。
- 已在本地真实 Postgres 16 实例（Homebrew 安装，非仓库依赖）上验证：
  空库正向迁移成功 → 数据门禁中止路径（有 `monitor_action` 行 / 有非
  `PENDING` 处置状态均被拒并保持库不变）→ 无数据时正向迁移成功（列重命名
  保留原值、闭环字段/表/枚举全部移除）→ `prisma migrate diff` 无差异 →
  回滚脚本恢复 migration-1 表结构 → 清除 `_prisma_migrations` 历史行后重新
  正向迁移成功。验证脚本为本次会话的临时文件，未提交仓库。

## 待确认事项（需产品/信息科最终拍板，本 issue 不擅自决定）

1. `sync_job_log` 的具体保留周期。
2. `monitor_record`（含 `reportContent`/`diagnosis` 报告正文快照）的保留周期，
   及报告正文的快照保存策略（逐字保存 vs 仅保留命中摘要）。

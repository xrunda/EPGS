# EPGS 监测业务数据字典（issue #3 / issue #26）

本文档描述 `apps/api/prisma/schema.prisma` 中监测业务库的表结构、字段含义、
敏感级别与保留策略。适用范围：`monitor_rule`、`attention_semantic`、
`monitor_record`、`monitor_match`、`monitor_match_semantic`、`monitor_report_ai`
及其两张子表、`sync_job_log` 监测核心表、Issue #31 的 `app_user` 本地账号表及
相关枚举。

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

| 枚举                   | 取值                                                              | 说明                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `MonitorLevel`         | `RED` `YELLOW` `GREEN` `UNCLASSIFIED`                             | 关注等级，是"关注等级管理"而非正式诊断结论。固定四值，新增需走 issue 评审。                                                             |
| `MatchField`           | `FINDINGS` `IMPRESSION` `REPORT_TEXT` `STUDY_DESCRIPTION` `OTHER` | 命中/规则作用的报告字段，具体解释权在 issue #5 匹配引擎。                                                                               |
| `MatchMode`            | `EXACT` `CONTAINS` `REGEX`                                        | 关键词匹配方式。                                                                                                                        |
| `SyncJobStatus`        | `RUNNING` `SUCCEEDED` `FAILED` `PARTIAL`                          | 同步任务运行结果。                                                                                                                      |
| `NotificationMsgType`  | `TEXT` `NEWS`                                                     | 推送消息类型（issue #52/#53），对应企业微信 Webhook 的 text/news 两种消息形状。                                                         |
| `SemanticStatus`       | `PRESENT` `NEGATED` `SUSPECTED` `HISTORY` `UNCERTAIN`             | 上下文判读结论（issue #87）：报告里那句话是**肯定 / 否定 / 疑似 / 既往史 / 无法判断**。**不是关注等级**，与红黄绿无映射关系。           |
| `SemanticConfidence`   | `HIGH` `MEDIUM` `LOW`                                             | 上下文判读的把握程度（issue #87）。只有 `HIGH` 才可能触发"未计入关注"，中/低一律保留原命中。                                            |
| `SemanticJudgeOutcome` | `OK` `ERROR`                                                      | 一次判读**调用**的结果（issue #87），与它得出什么结论无关。刻意没有 `SKIPPED`：规则未配置关注情况时根本不会调用模型，也就不产生审计行。 |
| `SemanticTask`         | `VALIDATE_MATCH` `CLASSIFY_REPORT`                                | 产生 AI 审计行的任务。`VALIDATE_MATCH` = 判读**一条命中**的上下文（issue #87，写 `monitor_match_semantic`）；`CLASSIFY_REPORT` = 读**整份报告**匹配医院配置的关注语义（issue #88，写 `monitor_report_ai`）。取值只增不改：新增取值必须带上对应任务的实现与测试。 |
| `AttentionLevel`       | `RED` `YELLOW` `GREEN`                                            | 一条**关注语义**的颜色（issue #88）。刻意**没有** `UNCLASSIFIED`（与 `MonitorLevel` 不同）：配置出来的语义一定带颜色，"无法归类"是**报告**的属性（什么都没命中），不是语义的属性。报告最终等级 = 它已验证命中里这些颜色的最大值（RED > YELLOW > GREEN）；最大值由代码算，模型不参与。 |
| `ReportAiField`        | `EXAM_ITEM` `FINDINGS` `IMPRESSION`                               | 报告级 AI 任务能引用的三个报告字段（issue #88），各自对应一个真实列：`EXAM_ITEM` → `exam_item`（检查项目）、`FINDINGS` → `report_content`（报告正文/检查所见）、`IMPRESSION` → `diagnosis`（诊断意见）。**刻意不复用 `MatchField`**：那是关键词引擎的词汇，且其 `STUDY_DESCRIPTION` 意为"检查描述"、在 `monitor_record` 里没有对应文本源。 |

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

## app_user_access — 角色与数据范围授权（issue #13）

登录账号（`app_user`）与授权（`app_user_access`）分离：账号只管"是谁"，授权决定
"能看什么、能做什么"。授权按 `username` 主键与账号匹配，不建外键（账号删除后
授权行可独立保留）。

| 字段              | 类型                              | 敏感级别 | 说明                                                     |
| ----------------- | --------------------------------- | -------- | -------------------------------------------------------- |
| `username`        | varchar(100) PK                   | MEDIUM   | 登录账号（小写），与 `app_user.username` 对应            |
| `roles`           | `AppRole[]`                       | MEDIUM   | 角色集合：`VIEWER` `RULE_ADMIN` `SYSTEM_ADMIN` `AUDITOR` |
| `departmentScope` | `varchar[]`（`department_scope`） | MEDIUM   | 授权可读科室；**空数组 = 全部科室**                      |
| `patientDetail`   | boolean（`patient_detail`）       | MEDIUM   | 是否可查看患者详情（false 时对监测响应脱敏）             |
| `updatedAt`       | timestamptz                       | LOW      | 最近一次授权更新时间                                     |

授权即时生效（每次请求实时读取，不缓存）。`roles` 为空的授权行等价于无授权——
角色受限接口一律 `403`。

## audit_log — 审计日志（issue #13）

只增不删的审计流水，用于追溯"谁在何时看了/改了什么"。没有任何更新/删除接口，
仅 `GET /api/audit`（`AUDITOR` 角色）只读分页查询。

| 字段            | 类型                  | 敏感级别 | 说明                                                                                                                                                                                                                                      |
| --------------- | --------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | UUID PK               | LOW      | 审计行主键                                                                                                                                                                                                                                |
| `actorUsername` | varchar(100) nullable | MEDIUM   | 操作者登录账号；无授权记录时为 null                                                                                                                                                                                                       |
| `actorRole`     | `AppRole`             | MEDIUM   | 操作者的主角色（用于审计展示）                                                                                                                                                                                                            |
| `action`        | `AuditAction`         | LOW      | `EXAM_LIST` `EXAM_DETAIL` `RULE_CREATE` `RULE_UPDATE` `RULE_IMPORT` `AUDIT_VIEW` `NOTIFICATION_TEST_SEND`（issue #52/#53，推送测试发送留痕）（`LOGIN`/`CONFIG_CHANGE` 预留，其中 `CONFIG_CHANGE` 已由 issue #54 的渠道/模板写入接口触发） |
| `resourceType`  | varchar(100)          | LOW      | 资源类型：`monitor_record` / `monitor_rule` / `audit_log`                                                                                                                                                                                 |
| `resourceId`    | UUID nullable         | LOW      | 具体资源 id（列表类操作为 null）                                                                                                                                                                                                          |
| `department`    | varchar(100) nullable | MEDIUM   | 操作涉及的科室上下文                                                                                                                                                                                                                      |
| `meta`          | jsonb nullable        | **LOW**  | 只含低敏感字段（过滤条件、masked 标记、规则语义、计数）——**绝不允许**患者姓名/报告正文/搜索词 `q` 原文/凭据                                                                                                                               |
| `ip`            | varchar(64) nullable  | LOW      | 来源 IP                                                                                                                                                                                                                                   |
| `correlationId` | varchar(100) nullable | LOW      | 关联请求的 correlation id，便于与业务日志对账                                                                                                                                                                                             |
| `createdAt`     | timestamptz           | LOW      | 审计时间戳（列表默认倒序）                                                                                                                                                                                                                |

索引：`(action, created_at)`、`(actor_username, created_at)`、`(department, created_at)`。

## monitor_rule — 关键词规则

规则采用"版本化 + 软停用"策略：编辑会改变匹配语义时应新建一行
（`version = 上一版本 + 1`，共享同一个 `ruleGroupId`），而不是原地更新，
以保证历史 `monitor_match` 始终能追溯到产生它的确切规则版本。

| 字段                    | 类型          | 敏感级别 | 说明                                                                                                                                                               |
| ----------------------- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                    | UUID PK       | LOW      | 规则版本主键                                                                                                                                                       |
| `keyword`               | varchar(255)  | LOW      | 关键词/短语                                                                                                                                                        |
| `level`                 | MonitorLevel  | LOW      | 命中后赋予的等级                                                                                                                                                   |
| `matchField`            | MatchField    | LOW      | 作用字段                                                                                                                                                           |
| `matchMode`             | MatchMode     | LOW      | 匹配方式，默认 CONTAINS                                                                                                                                            |
| `category`              | varchar(100)? | LOW      | 分组标签（如科室/瘤种），自由文本非外键                                                                                                                            |
| `semanticIntent`        | text?         | LOW      | 医生用自然语言写的"这个关键词想关注什么情况"（issue #87），例如"本次检查明确或疑似存在的病变；单独出现的否认句或既往史不算"。为空 = 不做上下文判读，命中即计入关注 |
| `isEnabled`             | boolean       | LOW      | 软启停开关；停用不删除，保留历史引用                                                                                                                               |
| `version`               | int           | LOW      | 同一逻辑规则的版本号                                                                                                                                               |
| `ruleGroupId`           | UUID          | LOW      | 同一逻辑规则的稳定分组标识                                                                                                                                         |
| `notes`                 | text?         | LOW      | 审核备注/临床依据                                                                                                                                                  |
| `createdAt`/`updatedAt` | timestamptz   | LOW      | 审计时间戳                                                                                                                                                         |
| `createdBy`/`updatedBy` | varchar(100)  | MEDIUM   | 操作人账号（外部身份，非本库外键）                                                                                                                                 |

`semanticIntent` 属于**匹配语义**：改动它（包括清空）与改动关键词一样会新建
规则版本行，而不是原地更新——否则历史 `monitor_match_semantic` 审计行所指向的
"当时的关注情况"就被悄悄改写了。它只被上下文判读读取，**不参与关键词匹配**，
配错也不会让一条命中消失。

保留策略：规则版本永久保留，不做过期清理（属于配置审计数据，体量小）。

## attention_semantic — 关注语义配置（issue #88）

医院用**自己的话**写下的"要关注报告里的哪种意思"，加上这层意思该有的颜色。它
**不是关键词规则、也不是提示词片段**：关键词路径问"报告里出现了哪些字"，本表
问"报告在说什么意思"。完整设计见
[ai-semantic-monitor-design.md](./ai-semantic-monitor-design.md)。

规则采用与 `monitor_rule` **完全一致**的"版本化 + 软停用"策略：改动
`name`/`description`/`attentionLevel`——**包括把一条语义在红/黄/绿之间挪动**——
会新建一行（`version + 1`，共享同一个 `semanticGroupId`）并停用旧行。原地改写会
追溯性地篡改一条历史 AI 判定"当时依据的是哪版文字"，正是 issue #88 §5 禁止的事。
**启停是唯一原地生效的编辑**（它不改变语义的"意思"），此时 `version` 只作为乐观
锁令牌递增。

行永不删除：`monitor_report_ai_match.semanticId` 指向判定当时的确切版本行，删掉就
毁掉了"依据的是医院哪一版关注语义"这个问题。

**预置语义只能显式载入**：任何迁移、任何 seed 都**不会**写入医学配置（所有者决定）。

| 字段                    | 类型            | 敏感级别 | 说明                                                                                                             |
| ----------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                    | UUID PK         | LOW      | 语义版本主键                                                                                                     |
| `semanticGroupId`       | UUID            | LOW      | 同一逻辑语义的稳定分组标识；首版即自身 id（分组锚点），与 `MonitorRule.ruleGroupId` 同构                          |
| `name`                  | varchar(100)    | LOW      | 短名，如"高度疑似恶性病变"                                                                                       |
| `description`           | text            | LOW      | 医生用自然语言写的"要关注什么情况"。**逐字**作为配置的一部分发给模型；有长度上限，一条语义只表达一层意思，宁可拆开写也不要写成条件树 |
| `attentionLevel`        | AttentionLevel  | LOW      | 这层意思的颜色。医院选，**模型无权决定**。报告最终等级 = 已验证命中的颜色最大值                                   |
| `isEnabled`             | boolean         | LOW      | 软启停。停用的语义不参与新的分类；历史 `monitor_report_ai_match` 仍指向它们                                       |
| `version`               | int             | LOW      | 同一逻辑语义的版本号；写入分类审计作为快照，保证判定可归因到当时生效的确切文字                                    |
| `createdAt`/`updatedAt` | timestamptz     | LOW      | 审计时间戳                                                                                                       |
| `createdBy`/`updatedBy` | varchar(100)    | MEDIUM   | 操作人账号（外部身份，非本库外键，同 `MonitorRule.createdBy`）                                                   |

索引：`(semantic_group_id)`、`(attention_level, is_enabled)`。

保留策略：同 `monitor_rule`，版本永久保留、体量小、不做过期清理。

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
| `aiAttentionLevel`               | AttentionLevel? | LOW    | 最近一次**成功**的报告级 AI 分类算出的等级（issue #88）= 该次已验证命中的配置颜色最大值。NULL = 从未分类 / 每次尝试都失败 / 功能关闭。没有"NONE"取值：一次成功但零命中的分类同样留 NULL，靠 `monitor_report_ai`（有 `OK` 且 `match_count = 0` 的行 vs 一条 `OK` 行都没有）区分二者。**永远不允许拉低 `currentLevel`** |
| `aiMatchedAt`                    | timestamptz?  | LOW      | 最近一次 AI 分类产生至少一条已验证命中的时间（issue #88）。刻意与 `firstMatchedAt`/`lastMatchedAt` 分开，后者只记录**关键词**路径、必须保持为纯粹的关键词事实 |
| `aiResolvedAt`                   | timestamptz?  | LOW      | 本记录的 AI 分类到达终点、离开分类队列的时间（issue #88）。队列定义就是 `ai_resolved_at IS NULL`——是这一列（不是状态列）在排空队列，与 #87 的 `semanticResolvedAt` 同构。**报告内容变化（重新同步）时置回 NULL**，改过文字的报告会被重新分类，而不是留着一条对已不存在文字的结论 |
| `aiClaimedAt`                    | timestamptz?  | LOW      | 分类 worker 认领本记录的时刻（乐观租约，issue #88），用于跨进程互斥 |
| `aiAttempts`                     | int NOT NULL DEFAULT 0 | LOW | 本记录已消耗的分类尝试次数（issue #88），认领时递增，上限由配置约束，防止坏行无限消耗模型调用 |

> **AI 只加不减（issue #88）**：超时、输出非法、证据不可追溯、语义不存在这四类
> 失败**都不动上面任何一列**，所以关键词结果——以及 #87 的过滤结论——和没有 #88
> 时完全一样。这几列是"最近一次成功尝试"的去规范化缓存，审计轨迹在
> `monitor_report_ai`（一次尝试一行）。
>
> **索引注意（issue #88）**：分类队列索引是**手写部分索引**
> `uq_monitor_record_ai_queue ON (ai_claimed_at, id) WHERE ai_resolved_at IS NULL`；
> Prisma 的 `@@index` 表达不了 `WHERE`，因此**不在 schema.prisma 里**（与
> `monitor_match` 的 `uq_monitor_match_semantic_queue` 同一处坑）。若 `prisma
> migrate dev` 把它当 drift 提议删除，手工加回去。

保留策略：作为工作台只读展示数据与审计证据保留；具体保留周期待运维/信息科确认。

## monitor_match — 命中证据明细

保存全部命中明细（与 `monitor_record.currentLevel` 的"当前最高等级"并存，
互不覆盖）。

**幂等约束**：`@@unique([monitorRecordId, ruleId, matchedField, keyword, reportVersion])`
（`uq_monitor_match_dedup`）。同一报告版本下，同一规则对同一字段/关键词的
命中只会被记录一次。

| 字段                                   | 类型                                          | 敏感级别 | 说明                                                                                                                  |
| -------------------------------------- | --------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `id`                                   | UUID PK                                       | LOW      | 主键                                                                                                                  |
| `monitorRecordId`                      | UUID FK → monitor_record, `ON DELETE CASCADE` | LOW      | 所属记录；记录删除时命中明细一并级联删除                                                                              |
| `ruleId`                               | UUID FK → monitor_rule, `ON DELETE RESTRICT`  | LOW      | 命中的规则版本；有命中引用时禁止删除该规则版本，保证审计可追溯                                                        |
| `keyword`                              | varchar(255)                                  | LOW      | 命中时刻的关键词快照（即使规则后续改版，本行不变）                                                                    |
| `level`                                | MonitorLevel                                  | LOW      | 命中时刻赋予的等级快照                                                                                                |
| `matchedField`                         | MatchField                                    | LOW      | 命中字段                                                                                                              |
| `contextSnippet`                       | varchar(500)                                  | **HIGH** | 命中上下文摘要（非全文），供证据展示                                                                                  |
| `reportVersion`                        | int                                           | LOW      | 命中时对应的报告版本                                                                                                  |
| `matchedAt`                            | timestamptz                                   | LOW      | 命中时间                                                                                                              |
| `matchStart`/`matchEnd`                | int?                                          | LOW      | 命中位置在该字段原文中的字符偏移（issue #87），判读时用于定位锚点；#87 之前的存量行为 NULL，判读时按规则+原文重新定位 |
| `semanticStatus`/`semanticConfidence`  | SemanticStatus? / SemanticConfidence?         | LOW      | 最近一次判读的**结论**（issue #87）。NULL = 尚未判读或规则未配置关注情况                                              |
| `semanticFiltered`                     | boolean NOT NULL DEFAULT false                | LOW      | 判读**决定**：true = 这条命中不计入关注（issue #87）。只有确定性的处置矩阵能把它置为 true，任何失败路径都保持 false   |
| `semanticResolvedAt`                   | timestamptz?                                  | LOW      | 判读队列终点标记（issue #87）：`IS NULL` 即待判读；调用成功/失败/规则未配置关注情况都会写入，且永不回退               |
| `semanticClaimedAt`/`semanticAttempts` | timestamptz? / int NOT NULL DEFAULT 0         | LOW      | 判读任务的认领租约与尝试次数（issue #87），用于跨进程互斥与防止坏行无限消耗模型调用                                   |

> **原始命中不可变（issue #87）**：AI 判读的结论写在下面这些独立列与
> `monitor_match_semantic` 审计表里，**不会覆盖** `keyword`/`level`/
> `matchedField`/`contextSnippet`/`matchedAt`。`semanticFiltered = true` 只影响
> 工作台"这条算不算数"的展示与统计口径，命中本身永远是事实。
>
> **等级仍然只来自规则（issue #87）**：`level` 永远是匹配时刻规则给的等级，
> 判读不修改它。`monitor_record.currentLevel` 由判读后重算，但也只取
> `semanticFiltered = false` 的命中等级的上限——AI 不会创造等级，只会让某条
> 命中暂时不参与。

保留策略：作为审计证据，不主动删除；随所属 `monitor_record` 级联删除（若该记录被删除）。

## monitor_match_semantic — 上下文判读审计（issue #87）

追加写入（append-only）：**一次判读调用写一行**，超时后重试会各写一行，用于回答
"当时到底把什么发给了哪个模型、它说了什么、代码据此做了什么"。

**隐私边界**：报表原文、Prompt、上下文窗口、模型原始响应**都不落库**，`evidence`
也不存原文。存的是内容哈希（`evidenceHash`/`inputHash`/`contextHash`）和原文中的
绝对偏移（`evidenceStart`/`evidenceEnd`/`contextStart`/`contextEnd`），审计时用
`monitor_record` 自己的报告正文（本来就有 `patientDetail` 权限门）重新算出当时
发出去的那一段。`reason` 是模型给出的解释句（界面要显示"为什么这么判"），长度
上限 300 字符，调用方无 `patientDetail` 权限时置空。

| 字段                          | 类型                                         | 敏感级别 | 说明                                                                       |
| ----------------------------- | -------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `id`                          | UUID PK                                      | LOW      | 主键                                                                       |
| `matchId`                     | UUID FK → monitor_match, `ON DELETE CASCADE` | LOW      | 被判读的命中行；命中行不存在时本行无意义                                   |
| `task`                        | SemanticTask                                 | LOW      | AI 任务类型，当前只有 `VALIDATE_MATCH`                                     |
| `taskVersion`                 | varchar(50)                                  | LOW      | 任务/提示词版本，判读口径变更的可追溯锚点                                  |
| `outcome`                     | SemanticJudgeOutcome                         | LOW      | 本次**调用**成功或失败（失败也留痕，且同样保留原命中）                     |
| `semanticStatus`              | SemanticStatus?                              | LOW      | 结论；调用失败时为 NULL                                                    |
| `matched`                     | boolean?                                     | LOW      | 模型的判断：这段话是否真的在说该规则关注的情况                             |
| `confidence`                  | SemanticConfidence?                          | LOW      | 结论的把握程度；调用失败时为 NULL                                          |
| `reason`                      | varchar(300)?                                | MEDIUM   | 模型给医生看的解释句。**可能复述报告片段**，因此按 MEDIUM 处理并做权限脱敏 |
| `intentExcludesHistory`       | boolean?                                     | LOW      | 模型对"该规则是否明确排除既往史"的判断，配合 `HISTORY` + `HIGH` 才可能过滤 |
| `evidenceHash`                | varchar(64)?                                 | LOW      | 模型引用的那段原文的 SHA-256（不存原文）                                   |
| `evidenceStart`/`evidenceEnd` | int?                                         | LOW      | 引用片段在字段原文中的偏移；与原文对不上时整条判读按失败处理（fail-open）  |
| `model` / `modelVersion`      | varchar(100) / varchar(100)?                 | LOW      | 模型标识与版本，满足"用了哪个模型"的审计要求                               |
| `inputHash`                   | varchar(64)                                  | LOW      | 送给模型的输入的哈希，用于确认"同一输入"与去重排查                         |
| `contextHash`                 | varchar(64)                                  | LOW      | 上下文片段的哈希（不存片段本身）                                           |
| `contextStart`/`contextEnd`   | int NOT NULL                                 | LOW      | 上下文片段在字段原文中的偏移范围                                           |
| `latencyMs`                   | int?                                         | LOW      | 本次调用耗时（毫秒）                                                       |
| `error`                       | varchar(255)?                                | LOW      | 失败原因（机器码 + HTTP 状态），**不存模型输出**——模型输出可能回显报告正文 |
| `filtered`                    | boolean NOT NULL DEFAULT false               | LOW      | 代码最终是否因这次判读把命中排除出关注（确定性决策，非模型决定）           |
| `decisionReason`              | varchar(50)                                  | LOW      | 决策依据的短标签（如处置矩阵命中的那一格），便于统计与复盘                 |
| `createdAt`                   | timestamptz                                  | LOW      | 写入时间                                                                   |

索引：`(matchId, created_at)`（详情页取最新一条判读）、`(outcome)`、
`(decisionReason)`。

保留策略：与 `monitor_match` 同级，作为审计证据保留；随所属命中行级联删除。

> **级联删除说明**：本表是全库唯一一处"删命中即删审计"的地方，因为它依附于
> 命中行才有意义。触发它的是删除 `monitor_record` 这一显式清理动作，AI 路径
> 本身从不删除任何命中。

## monitor_report_ai — 报告级 AI 分类审计（issue #88）

追加写入（append-only），与 `monitor_match_semantic` 同构但**主体不同**：**一次
`CLASSIFY_REPORT` 尝试写一行**，超时后重试各写一行，回答 issue #88 §13 的
"这份报告当时为什么被 AI 判成红色？依据的是医院哪一版关注语义？"

**为什么不复用 `monitor_match_semantic`**：那张表以**一条关键词命中**为主体，
`match_id` 非空；#88 的主体是**报告**，而它可能一条关键词命中都没有——这正是
本功能存在的意义。复用就得凭空造一行假命中，并破坏 #87 的审计契约。

**隐私边界**：与 #87 同一所有者决定——报表原文、Prompt、模型原始响应、证据原文
**都不落库**。存的是内容哈希与（在证据行上的）原文偏移，审计时用本来就有
`patientDetail` 权限门的 `monitor_record` 报告正文重算当时读到/发出的那一段。

| 字段                       | 类型                       | 敏感级别 | 说明                                                                                                             |
| -------------------------- | -------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `id`                       | UUID PK                    | LOW      | 主键                                                                                                             |
| `monitorRecordId`          | UUID FK → monitor_record, `ON DELETE CASCADE` | LOW | 被分类的报告记录                                                                        |
| `reportVersion`            | int                        | LOW      | 本次尝试针对的报告版本。重新同步改了文字会把记录的 AI 状态重置，避免对已被取代的文字的结论存活                     |
| `task`                     | SemanticTask               | LOW      | 本表恒为 `CLASSIFY_REPORT`                                                                                       |
| `taskVersion`              | varchar(50)                | LOW      | 任务/提示词版本（`CLASSIFY_REPORT_PROMPT_VERSION`），判读口径变更的可追溯锚点                                    |
| `outcome`                  | SemanticJudgeOutcome       | LOW      | 本次**调用**是否产出了完整可用的结果（与它得出什么结论无关）。`ERROR` 覆盖超时/网络/HTTP/JSON/schema/未知语义/证据/等级一致性全部失败面 |
| `attentionLevel`           | AttentionLevel?            | LOW      | **代码**为本次尝试算出的等级 = 已验证命中的配置颜色最大值。`outcome = ERROR` 或成功但零命中时为 NULL（§8 的"真实的 NONE"）。**模型从不写这一列** |
| `modelAttentionLevel`      | AttentionLevel?            | LOW      | **模型自称**的等级，仅供审计与观测模型漂移，**不参与任何等级计算**。与上面那列不一致时整次尝试按 `INCOHERENT_LEVEL` 拒收、一条命中都不写——所以模型说 RED 抬不动等级，说 NONE 也压不动 |
| `semanticCount`            | int                        | LOW      | 本次发给模型的启用语义条数；配合 `matchCount` 让"模型什么也没看到"与"根本没问模型"可区分                            |
| `matchCount`               | int                        | LOW      | 本次通过验证的命中条数                                                                                           |
| `error`                    | varchar(64)?               | LOW      | 失败机器码（共享的 `SemanticErrorCode` 分类 + #88 自己的码）。**绝不是**模型自由文本或报告正文                     |
| `model` / `modelVersion`   | varchar(100) / varchar(100)? | LOW    | 模型标识与版本                                                                                                   |
| `inputHash`                | varchar(64)                | LOW      | 发给模型的全部内容（task + 版本 + 模型 + `reportHash` + `configHash`）的规范化 JSON 哈希                          |
| `reportHash`               | varchar(64)                | LOW      | 报告快照本身（检查项目 + 正文 + 诊断）的哈希；有权限的人重算即可确认当时读的是同一段文字                          |
| `configHash`               | varchar(64)                | LOW      | **整份**关注语义配置快照（每条启用语义的 id + version + level + name + description，按 id 排序）的哈希。**这一列**回答"依据的是医院哪一版关注语义"；单条语义由 match 行的 `semanticId`/`semanticVersion` 回答 |
| `latencyMs`                | int?                       | LOW      | 模型调用耗时（毫秒）；未发起调用（如报告无可判读文本）时为 NULL                                                   |
| `createdAt`                | timestamptz                | LOW      | 写入时间                                                                                                         |

索引：`(monitor_record_id, created_at)`、`(outcome)`、`(attention_level)`。

保留策略：随所属 `monitor_record` 级联删除（`onDelete: Cascade`），AI 路径自身
从不删除审计行。

## monitor_report_ai_match — 报告级 AI 命中的关注语义（issue #88）

一次 `CLASSIFY_REPORT` 尝试验证通过的每一条关注语义各写一行。**全部保存，从不
只留最高**（§8）：审计要能看到模型找到的每一条，等级只是其中最大值。

这里的颜色是**判定当时该语义被配置的颜色快照**，最终等级就是由它算出来的。

| 字段                       | 类型                                            | 敏感级别 | 说明                                                                                       |
| -------------------------- | ----------------------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `id`                       | UUID PK                                         | LOW      | 主键                                                                                       |
| `reportAiId`               | UUID FK → monitor_report_ai, `ON DELETE CASCADE` | LOW     | 所属尝试                                                                                   |
| `semanticId`               | UUID FK → attention_semantic, `ON DELETE RESTRICT` | LOW   | 判定所依据的**确切语义版本行**（即当时医院那句话的确切文字）。用 Restrict 而非 Cascade：语义只软停用、从不删除，删掉会让审计悬空 |
| `semanticVersion`          | int                                             | LOW      | 判定时刻的语义快照（版本号）                                                               |
| `semanticName`             | varchar(100)                                    | LOW      | 判定时刻的语义快照（名称），即使日后改名或换色，本行仍是忠实记录（同 `monitor_match.keyword` 的去规范化理由） |
| `attentionLevel`           | AttentionLevel                                  | LOW      | 判定时刻该语义的**配置**颜色快照，最终等级由它计算                                          |
| `confidence`               | SemanticConfidence                              | LOW      | 模型把握程度。**只作记录**：#87 按置信度过滤，#88 **从不**过滤——一条 AI 命中要么有可验证的证据，要么不存在 |
| `reason`                   | varchar(300)                                    | MEDIUM   | 模型给医生看的解释句。**可能复述报告片段**，因此按 MEDIUM 处理、对无 `patientDetail` 权限的调用方置空，且**从不写日志** |
| `ordinal`                  | int                                             | LOW      | 该命中在模型响应里的位置，审计可按模型原本的顺序回放                                        |

**幂等约束**：`@@unique([reportAiId, semanticId])`（`uq_report_ai_match_semantic`）。
模型同一条语义返回两次属于契约违例，解析器在任何写入之前就拒收整次尝试。

索引：`(report_ai_id)`、`(semantic_id)`。

保留策略：随所属尝试行级联删除。

## monitor_report_ai_evidence — AI 命中的证据片段（issue #88）

一条命中可以引用多段原文，每段一行。**片段原文不落库**，只存它的哈希与它在报告
正文里的位置——与 #87 对 `monitor_match_semantic` 的做法一致。有权限读
`monitor_record` 的人用这些偏移重算出当时的片段。

校验方式是**字面子串**：这段文字必须出现在这次真正发给模型的那个字段文本里
（先去空格折叠重试一次），通过后才换算成下面的偏移。任何一条命中有一段证据对不
上，**整次尝试**按 `EVIDENCE_UNVERIFIED` 记失败，零条命中生效（一期刻意从严）。

| 字段                        | 类型                                         | 敏感级别 | 说明                                                                             |
| --------------------------- | -------------------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `id`                        | UUID PK                                      | LOW      | 主键                                                                             |
| `matchId`                   | UUID FK → monitor_report_ai_match, `ON DELETE CASCADE` | LOW | 所属命中行                                                              |
| `ordinal`                   | int                                          | LOW      | 该片段在所属命中 `evidence` 数组中的位置                                          |
| `field`                     | ReportAiField                                | LOW      | 片段定位在三个报告字段中的哪一个；下面的偏移是**该字段文本内**的偏移             |
| `evidenceHash`              | varchar(64)                                  | LOW      | 模型返回、且已被验证可在所发文本中定位的那段字符串的 SHA-256（不存原文）         |
| `evidenceStart`/`evidenceEnd` | int                                        | LOW      | 片段在 `field` 所指 `monitor_record` 列中的偏移（含头不含尾，UTF-16 码元）        |

**幂等约束**：`@@unique([matchId, ordinal])`（`uq_report_ai_evidence_ordinal`）。

索引：`(match_id)`。

保留策略：随所属命中行级联删除。

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

## notification_channel — 消息推送渠道（issue #52/#53）

企业微信群机器人 Webhook 配置。完整设计见
[`docs/notification-design.md`](notification-design.md)。**不做版本化**
（对比 `monitor_rule`）——Webhook 地址改了不需要追溯"历史某条消息用的
是哪个版本"，改了就是改了；只做软启停（`isEnabled`），停用后不可作为
发送目标但记录保留。

> **本库首个可逆敏感凭证**：`webhookUrlCiphertext` 是本库第一个需要
> "存了还要能读出明文"的字段。对比 `app_user.passwordHash`
> 是 Argon2id 单向哈希（永远不需要还原成明文密码），`JWT_SECRET`/
> `PACS_HTTP_SERVICE_TOKEN` 是环境变量、从未落库——Webhook URL 必须能
> 在发送消息时还原成明文才能调用企业微信接口，因此新增了应用层对称
> 加密（`NotificationSecretCipher`，AES-256-GCM），密钥来自
> `NOTIFICATION_SECRET_KEY` 环境变量，不落库。

| 字段                    | 类型         | 敏感级别 | 说明                                                                                                  |
| ----------------------- | ------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `id`                    | UUID PK      | LOW      | 主键                                                                                                  |
| `name`                  | varchar(100) | LOW      | 渠道名称（业务可读标识，如"内镜中心红色关注群"）；不要求唯一                                          |
| `webhookUrlCiphertext`  | text         | **HIGH** | AES-256-GCM 密文（`<iv>:<authTag>:<ciphertext>` base64 三段式）；API 响应**只返回掩码，绝不返回明文** |
| `isEnabled`             | boolean      | LOW      | 软启停；停用后不可作为发送目标，历史记录保留                                                          |
| `createdAt`/`updatedAt` | timestamptz  | LOW      | 审计时间戳                                                                                            |
| `createdBy`/`updatedBy` | varchar(100) | MEDIUM   | 操作人账号（外部身份，非本库外键）                                                                    |

保留策略：作为配置审计数据永久保留，体量小，不做过期清理（同
`monitor_rule` 的保留策略）。

## notification_template — 消息推送模板（issue #52/#53）

推送内容模板（文字或图文），支持 `{{placeholder}}` 占位符，渲染发生在
发送时（issue #54），取值口径复用 `GET /api/monitor/summary`
的既有统计逻辑。**本表只存模板文本本身，不存渲染后的消息正文**——
渲染结果含当日统计数字组合，属于易变的派生数据，不落库以避免与
`monitor_record`/`monitor_match` 产生数据冗余。

| 字段                    | 类型                | 敏感级别 | 说明                                                                 |
| ----------------------- | ------------------- | -------- | -------------------------------------------------------------------- |
| `id`                    | UUID PK             | LOW      | 主键                                                                 |
| `name`                  | varchar(100)        | LOW      | 模板名称（如"红色关注日报"）                                         |
| `msgType`               | NotificationMsgType | LOW      | `TEXT`（对应企业微信 text 消息）或 `NEWS`（图文卡片）                |
| `titleTemplate`         | varchar(200)?       | LOW      | 标题模板，仅 `NEWS` 使用                                             |
| `contentTemplate`       | text                | LOW      | 正文/摘要模板，含 `{{占位符}}`                                       |
| `coverImageUrl`         | text?               | LOW      | 封面图静态地址，仅 `NEWS` 使用；V1 无动态生成能力                    |
| `linkUrl`               | text?               | LOW      | 点击跳转地址，仅 `NEWS` 使用；当前医院内网未与企业微信互通，暂不可达 |
| `isEnabled`             | boolean             | LOW      | 软启停                                                               |
| `createdAt`/`updatedAt` | timestamptz         | LOW      | 审计时间戳                                                           |
| `createdBy`/`updatedBy` | varchar(100)        | MEDIUM   | 操作人账号                                                           |

保留策略：同 `notification_channel`，永久保留、体量小。

## 索引设计对照工作台常用筛选

| 筛选维度                     | 索引                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 时间（检查时间/最近命中）    | `monitor_record(exam_time)`、`monitor_record(last_matched_at)`                                                                                                            |
| 等级                         | `monitor_record(current_level)`、`monitor_match(level)`                                                                                                                   |
| 科室                         | `monitor_record(department)`                                                                                                                                              |
| 患者类型（issue #14）        | `monitor_record(patient_type_code)`（精确匹配常用筛选，issue #14 补建）                                                                                                   |
| 来源唯一键                   | `monitor_record(source_record_id, report_id)` + 唯一索引 `(source_record_id, report_id, report_version)`                                                                  |
| 规则维度                     | `monitor_rule(level, is_enabled)`、`monitor_rule(rule_group_id)`、`monitor_rule(category)`                                                                                |
| 命中明细按记录/规则/时间查询 | `monitor_match(monitor_record_id)`、`monitor_match(rule_id)`、`monitor_match(matched_at)`                                                                                 |
| 有效命中（issue #87）        | 部分索引 `uq_monitor_match_semantic_queue(semantic_claimed_at, id) WHERE semantic_resolved_at IS NULL`（判读队列）、`monitor_match(monitor_record_id, semantic_filtered)` |
| 判读审计查询（issue #87）    | `monitor_match_semantic(match_id, created_at)`、`monitor_match_semantic(outcome)`、`monitor_match_semantic(decision_reason)`                                              |
| 关注语义配置（issue #88）    | `attention_semantic(semantic_group_id)`、`attention_semantic(attention_level, is_enabled)`                                                                               |
| 分类队列与审计（issue #88）  | 部分索引 `uq_monitor_record_ai_queue(ai_claimed_at, id) WHERE ai_resolved_at IS NULL`（分类队列，**手写、不在 schema.prisma 里**）、`monitor_report_ai(monitor_record_id, created_at)`、`monitor_report_ai(outcome)`、`monitor_report_ai(attention_level)`、`monitor_report_ai_match(report_ai_id)`、`monitor_report_ai_match(semantic_id)`、`monitor_report_ai_evidence(match_id)` |
| 同步任务运维查询             | `sync_job_log(job_name, started_at)`、`sync_job_log(status)`                                                                                                              |

## 迁移与回滚

- 迁移文件：
  - `apps/api/prisma/migrations/20260821040339_init_monitoring_schema/migration.sql`（issue #3 建表）
  - `apps/api/prisma/migrations/20260821073851_remove_closed_loop_readonly/migration.sql`（issue #26 移除闭环模型）
  - `apps/api/prisma/migrations/20260821093500_add_local_auth/migration.sql`（issue #31 增加本地账号）
  - `apps/api/prisma/migrations/20260821103732_add_auth_access_and_audit_log/migration.sql`（issue #13 增加 `app_user_access`/`audit_log` 与 `AppRole`/`AuditAction` 枚举）
  - `apps/api/prisma/migrations/20260821110858_add_monitor_record_patient_type_index/migration.sql`（issue #14 为 `patient_type_code` 常用筛选补建 btree 索引）
  - `apps/api/prisma/migrations/20260823032959_add_notification_channel_template/migration.sql`（issue #52/#53 增加 `notification_channel`/`notification_template` 与 `NotificationMsgType` 枚举，并为既有 `AuditAction` 枚举追加 `NOTIFICATION_TEST_SEND` 值）
  - `apps/api/prisma/migrations/20260911000000_add_user_admin_role_and_audit_actions/migration.sql`（issue #78/#79 为既有 `AppRole` 枚举追加 `USER_ADMIN` 值，为既有 `AuditAction` 枚举追加 `USER_CREATE`/`USER_ROLE_CHANGE`/`USER_DISABLE`/`USER_ENABLE`/`USER_DELETE`/`USER_PASSWORD_RESET` 六个值，不新建表）
  - `apps/api/prisma/migrations/20260925000000_add_semantic_judge/migration.sql`（issue #87 新增 `monitor_match_semantic` 表与 `SemanticStatus`/`SemanticConfidence`/`SemanticJudgeOutcome`/`SemanticTask` 四个枚举，为 `monitor_rule` 加 `semantic_intent`，为 `monitor_match` 加判读状态列。**纯增量、全部 `IF NOT EXISTS`**：不改任何既有列的含义，`semantic_filtered NOT NULL DEFAULT false` 保证存量命中全部按原样计入关注）
  - `apps/api/prisma/migrations/20260926000000_add_ai_report_classify/migration.sql`（issue #88 新增 `attention_semantic` 配置表与 `monitor_report_ai`/`monitor_report_ai_match`/`monitor_report_ai_evidence` 三张审计表、`AttentionLevel`/`ReportAiField` 两个枚举，为既有 `SemanticTask` 枚举追加 `CLASSIFY_REPORT`、为既有 `AuditAction` 枚举追加 `ATTENTION_SEMANTIC_CREATE`/`ATTENTION_SEMANTIC_UPDATE`，为 `monitor_record` 加五个 `ai_*` 队列/结果列并**手写**分类队列部分索引 `uq_monitor_record_ai_queue`。**纯增量、全部 `IF NOT EXISTS`，且不写入任何医学配置**：`ai_attention_level` 为 NULL、`ai_resolved_at` 为 NULL 时行为与 #88 之前完全一致）
- 回滚脚本（Prisma Migrate 本身没有内建 down-migration 机制，回滚脚本需手动执行，
  详见脚本头部注释）：
  - `20260821040339_init_monitoring_schema/rollback.sql`
  - `20260821073851_remove_closed_loop_readonly/rollback.sql`
  - `20260821093500_add_local_auth/rollback.sql`
  - `20260821103732_add_auth_access_and_audit_log/rollback.sql`（删除全部角色授权与审计日志）
  - `20260821110858_add_monitor_record_patient_type_index/rollback.sql`（删除 `patient_type_code` 索引，issue #14）
  - `20260823032959_add_notification_channel_template/rollback.sql`（删除两张新表与 `NotificationMsgType` 枚举可直接执行；`AuditAction` 追加值**不可**用 `DROP TYPE` 简单回滚——PostgreSQL 无 `ALTER TYPE ... DROP VALUE`，脚本头部注释给出了需要人工确认 `audit_log` 无该值记录后再执行的枚举重建 SQL，不自动执行）
  - `20260911000000_add_user_admin_role_and_audit_actions/rollback.sql`（同样无表可删——`AppRole`/`AuditAction` 追加值均不可用 `DROP TYPE` 简单回滚，脚本头部注释给出需人工确认 `app_user_access`/`audit_log` 无该值记录后再执行的枚举重建 SQL，不自动执行）
  - `20260925000000_add_semantic_judge/rollback.sql`（issue #87：删除判读状态列、`semantic_intent`、审计表与四个枚举。**会丢失全部判读记录与已生效的过滤结论**，回滚后所有命中重新计入关注；脚本头部注释要求先确认 `monitor_match_semantic` 行数，不自动执行）
  - `20260926000000_add_ai_report_classify/rollback.sql`（issue #88：按"先子表后父表、先去列后删类型"的顺序删除三张审计表、`attention_semantic`、五个 `ai_*` 列、分类队列部分索引与 `AttentionLevel`/`ReportAiField` 两个枚举。**会丢失全部报告级 AI 分类记录**——当时生效的是哪版关注语义、哪个模型、命中了什么、依据了哪些原文片段，这份审计**不可重建**：今天重跑只会用今天的配置、今天的模型，跟产生原判定的那次不是一回事。关键词路径（`monitor_match`、`monitor_record` 的 `current_level`/`first_matched_at`/`last_matched_at`、`monitor_rule`）与 #87 的审计表**完全不受影响**。**两处撤不干净**：`SemanticTask` 里仍留着 `CLASSIFY_REPORT`、`AuditAction` 里仍留着 `ATTENTION_SEMANTIC_CREATE`/`_UPDATE`——PostgreSQL 无法从类型里删除取值，重建类型要重写 `monitor_match_semantic`/`audit_log`，代价远大于留下两个无人使用的取值。建议**先回滚 worker 再回滚 schema**，避免出现分类器往半拆的表里写的窗口）
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

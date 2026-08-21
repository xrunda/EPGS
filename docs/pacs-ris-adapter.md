# PACS/RIS 只读适配层（issue #2）

本适配层的唯一职责：把 PACS/RIS 内镜检查/报告数据转换为稳定的内部 DTO
（`@epgs/shared-types` 中的 `PacsReportDto`），供后续同步任务（issue #6）
消费。**本 issue 不连接真实生产数据库**，因此下文所有表结构、字段名、
索引和状态取值均为基于常见 PACS/RIS（假设为 SQL Server）设计的**假设**，
必须在接入真实系统前逐项核验。凡标记"待核验"的内容，在生产环境验证完成
前不得视为已确认的事实。

## 1. 代码位置

- 类型定义：`packages/shared-types/src/pacs-ris.ts`（`PacsReportDto`、
  `PacsReportStatus`、`FetchReportsParams`、`FetchReportsResult`）。
- 适配器接口：`apps/worker/src/pacs-adapter/pacs-ris-adapter.interface.ts`
  （`PacsRisAdapter`，DI token `PACS_RIS_ADAPTER`）。
- 状态映射：`apps/worker/src/pacs-adapter/status-mapping.ts`。
- 真实库骨架实现：`apps/worker/src/pacs-adapter/sql-pacs-ris-adapter.ts`
  （`SqlPacsRisAdapter` + `buildFetchReportsQuery`，仅生成参数化 SQL 模板，
  未连接任何真实驱动）。
- 脱敏 mock 实现：`apps/worker/src/pacs-adapter/fixture-pacs-ris-adapter.ts`
  - `fixtures/reports.fixture.json`（全部为虚构数据）。
- 模块与环境变量开关：`apps/worker/src/pacs-adapter/pacs-adapter.module.ts`，
  由 `PACS_ADAPTER_MODE=fixture|sql` 控制（默认 `fixture`）。

## 2. 假设的源表结构（待生产环境核验）

以下表名、字段名、类型均为**假设**，未连接真实 PACS/RIS 库验证：

| 表              | 假设关键字段                                                                                                        | 假设类型                                             | 说明                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATIENTINFO`   | `PAT_ID` (PK), `INPATIENT_NO`, `PATIENT_NAME`, `SEX_CODE`, `AGE`                                                    | `PAT_ID` varchar/int，其余多为 varchar               | 待核验：`PAT_ID` 是否全局稳定唯一，还是可能跨科室系统重复                                                                                                                        |
| `STUDYINFO`     | `ST_ACCNUM` (PK/UK), `PAT_ID` (FK), `EXAM_ITEM`, `EXAM_TIME`, `BED_NO`, `LOC_ID`, `DEVICE_ID`                       | `ST_ACCNUM` varchar，`EXAM_TIME` datetime            | 待核验：`ST_ACCNUM` 是否保证全局唯一（本适配器已按"可能重复"设计，见第 5 节）                                                                                                    |
| `REPORTINFO`    | `REPORT_ID` (PK), `ST_ACCNUM` (FK), `REPORT_STATUS`, `REPORT_SAVED_AT`, `REPORT_SUBMITTED_AT`, `REPORT_REVIEWED_AT` | 待核验实际列名/类型                                  | 待核验：一个 `ST_ACCNUM` 是否可对应多条 `REPORTINFO`（版本历史）                                                                                                                 |
| `REPORTCONTENT` | `ST_ACCNUM` (FK), `REPORT_ID` (FK), `RPT_DESCRIBE`, `RPT_DIAGNOSE`                                                  | `RPT_DESCRIBE`/`RPT_DIAGNOSE` 为 ntext/nvarchar(max) | 待核验：是否与 `REPORTINFO` 一对一，还是可能一个检查对应多条内容记录                                                                                                             |
| `LOC`           | `LOC_ID` (PK), `DEPARTMENT_NAME`                                                                                    | 待核验                                               | 待核验：科室信息来自 `LOC` 还是 `STUDYINFO` 冗余字段，或另有独立科室维表                                                                                                         |
| `STUDYSTATUS`   | 未在本适配器中直接使用                                                                                              | 待核验                                               | Issue 原文提到该表，但状态映射本实现假设集中在 `REPORTINFO.REPORT_STATUS`；**待核验**：检查级状态（`STUDYSTATUS`）与报告级状态（`REPORTINFO`）是否需要分别建模、是否存在冲突场景 |

### 关联键假设

```
STUDYINFO.ST_ACCNUM = REPORTINFO.ST_ACCNUM = REPORTCONTENT.ST_ACCNUM
STUDYINFO.PAT_ID    = PATIENTINFO.PAT_ID
REPORTCONTENT.REPORT_ID = REPORTINFO.REPORT_ID  （假设，用于多版本报告区分内容）
STUDYINFO.LOC_ID    = LOC.LOC_ID  （科室归属，假设）
```

**待核验事项清单**：

1. `ST_ACCNUM` 是否保证全局唯一，或者不同院区/设备是否可能产生重复值（本
   适配器已假设"可能重复"并在 fixture 中构造了重复 accession number 的用例）。
2. `REPORT_ID` 与 `REPORTCONTENT` 是否严格一对一，还是一个 `REPORT_ID`
   可能关联多条 `REPORTCONTENT`（如按段落拆分存储）。
3. 科室信息的权威来源：`LOC` 表、`STUDYINFO` 冗余列，还是需要联 HIS 科室字典。
4. `STUDYSTATUS` 表与 `REPORTINFO.REPORT_STATUS` 的关系——是否存在检查级
   状态与报告级状态不一致的场景（例如检查已取消但报告仍为草稿）。
5. 各时间戳列（`REPORT_SAVED_AT` / `REPORT_SUBMITTED_AT` /
   `REPORT_REVIEWED_AT`）在目标系统中的真实列名、是否可能为空、时区
   （假设与数据库会话时区一致，默认 Asia/Shanghai，**待核验**）。
6. **"报告首次保存后是否可读"**——即 `REPORT_SAVED_AT`（草稿保存）时刻，
   `REPORTCONTENT` 是否已经可以被本适配器的只读账号查询到，还是要等到
   `REPORT_SUBMITTED_AT` 或更晚的阶段内容才落库/可读。这直接决定 issue #6
   同步任务能多早发现重点患者，是本文档中**优先级最高的待核验事项**。
7. 索引情况：假设至少需要 `STUDYINFO(EXAM_TIME)` 或某个"最后更新时间"列
   上的索引以支持增量扫描（见第 6 节），实际索引需 DBA 核验。
8. 数据库/驱动方言：假设为 SQL Server（故 `SqlPacsRisAdapter` 使用
   `TOP (@n)` 语法）。若目标实际为 Oracle/MySQL/PostgreSQL，需要替换
   `buildFetchReportsQuery` 中的分页语法（`TOP` → `LIMIT`/`FETCH FIRST`
   等）与标识符引用规则，但参数绑定方式、JOIN 关系、游标字段不变。

## 3. 内部 DTO 与源字段映射

`PacsReportDto`（`packages/shared-types/src/pacs-ris.ts`）字段与假设源列的
对应关系：

| DTO 字段                                                   | 假设源列                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `patientId`                                                | `PATIENTINFO.PAT_ID`                                                     |
| `inpatientNo`                                              | `PATIENTINFO.INPATIENT_NO`（可为空，门诊/急诊检查常无住院号）            |
| `patientName`                                              | `PATIENTINFO.PATIENT_NAME`                                               |
| `sex`                                                      | `PATIENTINFO.SEX_CODE`，仅识别 `M`/`F`，其余（含空值）映射为 `'UNKNOWN'` |
| `age`                                                      | `PATIENTINFO.AGE`（原样返回，不重新计算）                                |
| `department`                                               | `LOC.DEPARTMENT_NAME`（经 `STUDYINFO.LOC_ID` 关联）                      |
| `bedNo`                                                    | `STUDYINFO.BED_NO`                                                       |
| `studyAccessionNo`                                         | `STUDYINFO.ST_ACCNUM`                                                    |
| `examItem`                                                 | `STUDYINFO.EXAM_ITEM`                                                    |
| `examTime`                                                 | `STUDYINFO.EXAM_TIME`                                                    |
| `reportId`                                                 | `REPORTINFO.REPORT_ID`                                                   |
| `reportStatus`                                             | 由 `REPORTINFO.REPORT_STATUS` 经 `status-mapping.ts` 映射得到，见第 4 节 |
| `rawStatusCode`                                            | `REPORTINFO.REPORT_STATUS` 原始值（保留用于排查 UNKNOWN 状态）           |
| `reportSavedAt` / `reportSubmittedAt` / `reportReviewedAt` | `REPORTINFO` 对应时间戳列                                                |
| `describeText`                                             | `REPORTCONTENT.RPT_DESCRIBE`，**原样返回，不做任何清洗/改写**            |
| `diagnoseText`                                             | `REPORTCONTENT.RPT_DIAGNOSE`，**原样返回，不做任何清洗/改写**            |
| `sourceUpdatedAt`                                          | 假设为 `REPORTINFO` 的"最后修改时间"列（真实列名待核验），用于增量游标   |

## 4. 状态映射表

源状态码（假设值，待核验实际取值集合）→ 内部 `PacsReportStatus`：

| 假设源状态码                                          | 内部状态                                         |
| ----------------------------------------------------- | ------------------------------------------------ |
| `IN_PROGRESS` / `EXAM_IN_PROGRESS`                    | `EXAM_IN_PROGRESS`                               |
| `AWAITING_REPORT` / `NOT_STARTED`                     | `AWAITING_REPORT`                                |
| `DRAFT` / `SAVED`                                     | `DRAFT`                                          |
| `SUBMITTED` / `PENDING_REVIEW` / `PENDING_AUDIT`      | `PENDING_REVIEW`                                 |
| `REVIEWED` / `PRELIMINARY_AUDITED`                    | `REVIEWED`                                       |
| `FINAL` / `AUDITED` / `FINAL_REVIEWED` / `SIGNED_OFF` | `FINAL_REVIEWED`                                 |
| 任何未在上表出现的值（含 `null`/空字符串）            | `UNKNOWN`（**绝不**静默映射为 `FINAL_REVIEWED`） |

映射逻辑实现于 `apps/worker/src/pacs-adapter/status-mapping.ts`，匹配前会
`trim()` + 转大写，未命中一律返回 `UNKNOWN`，并通过 `rawStatusCode` 字段
保留原始值供人工核查。**这是验收标准的硬性要求**：未知状态必须可观察，不
得被误判为已审核。

## 5. 空值 / 重复 / 多版本处理规则

| 场景                                                        | 处理规则                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describeText` / `diagnoseText` 为空字符串或 `null`         | 原样返回（`''` 保留为 `''`，不强制转换为 `null` 或反之），不触发错误                                                                                                                    |
| 同一 `studyAccessionNo` 存在多条 `REPORTINFO`（报告多版本） | 全部作为独立的 `PacsReportDto` 返回（按 `reportId` 区分），适配器不做"只保留最新版本"的裁剪——是否需要按版本去重由消费方（issue #6）决定，避免适配层丢失历史内容                         |
| 同一检查对应多条 `REPORTCONTENT`                            | 假设 `REPORTCONTENT` 按 `REPORT_ID` 与 `REPORTINFO` 一一对应（待核验，见第 2 节待核验 #2）；若实际为一对多，需要在 `SqlPacsRisAdapter` 的 JOIN 中改为聚合或选择"最新一条"并记录取舍规则 |
| `studyAccessionNo` 重复（跨患者/跨检查）                    | 原样返回全部记录，不做合并、不做去重、不猜测哪条"权威"——已在 fixture 中构造两条共享同一 accession number 但属于不同患者的记录作为回归用例                                               |
| `PATIENTINFO.INPATIENT_NO` 缺失（门诊/急诊）                | `inpatientNo` 返回 `null`，不视为异常                                                                                                                                                   |
| `REPORT_STATUS` 缺失或无法识别                              | 映射为 `UNKNOWN`（见第 4 节）                                                                                                                                                           |
| 源字段整体缺失（如 JOIN 未命中 `REPORTCONTENT`）            | `SqlPacsRisAdapter` 对 `REPORTCONTENT` 使用 `LEFT JOIN`，缺失时 `describeText`/`diagnoseText` 为 `null`                                                                                 |

## 6. 分页 / 增量游标设计

`fetchReports(params)` 输入：`since`（必填，增量下限）、`until`（可选，默认
当前时间）、`department`/`deviceId`（可选过滤）、`cursor`（可选，续页）、
`pageSize`（必填，硬上限 `MAX_PAGE_SIZE = 500`，防止无界扫描）。

- **游标形式**：keyset pagination，基于 `(sourceUpdatedAt, reportId)` 复合键
  （而非 offset），避免在源表持续写入的情况下出现分页漏读/重复读。
  `SqlPacsRisAdapter` 的游标编码为
  `base64("<ISO时间戳>|<reportId>")`，查询时展开为
  `SOURCE_UPDATED_AT > @cursorTs OR (SOURCE_UPDATED_AT = @cursorTs AND REPORT_ID > @cursorId)`。
  `FixturePacsRisAdapter` 为简化实现使用等价的有序 offset 游标（因为内存
  数据集不会在分页过程中变化），两者对外契约一致（`nextCursor` 存在即表示
  还有更多数据）。
- **排序**：`ORDER BY SOURCE_UPDATED_AT ASC, REPORT_ID ASC`，保证确定性，
  是游标能正确续页的前提。
- **参数绑定**：所有查询条件（`since`/`until`/`pageSize`/`department`/
  `deviceId`/游标值）均通过命名参数（`@since` 等）传递给驱动，`SqlPacsRisAdapter`
  和 `buildFetchReportsQuery` 不做任何字符串拼接注入 SQL 文本——单元测试
  `sql-pacs-ris-adapter.spec.ts` 专门验证了这一点（含一条 SQL 注入 payload
  作为参数值的用例，确认生成的 SQL 文本不含该 payload）。

### "限定一天数据"查询的预期查询计划设计说明

（无法连接真实库，以下为索引设计意图说明，非真实 `EXPLAIN` 输出）

假设查询：`since = 当天 00:00`, `until = 次日 00:00`, `department` 可选。

- 预期索引：`STUDYINFO`/`REPORTINFO` 上按 `sourceUpdatedAt`（假设列，见第 2
  节待核验 #5/#7）建立的非聚集索引，理想情况下为复合索引
  `(SOURCE_UPDATED_AT, REPORT_ID)`，使 `WHERE SOURCE_UPDATED_AT >= @since AND
SOURCE_UPDATED_AT < @until` 可以走索引范围扫描（index range seek）而非全表
  扫描，同时该索引的列序恰好匹配游标谓词与 `ORDER BY` 子句，避免额外排序
  （sort operator）。
- 若增量游标频繁调用（issue #6 高频轮询场景），建议该索引覆盖
  （covering/include）`REPORT_ID`、`ST_ACCNUM`，减少回表（key lookup）。
- `department` 过滤走 `LOC.DEPARTMENT_NAME`，若该列选择性低（科室数量少、
  每科室行数多），不建议单独建索引，优先依赖时间范围索引缩小后再过滤。
- 该设计意图**未经真实执行计划验证**，实际是否命中索引、是否存在参数嗅探
  （parameter sniffing）等问题需要在生产/仿真环境用真实 `SET STATISTICS
IO/TIME ON` 或 `EXPLAIN`/执行计划工具核验。

## 7. 最小权限只读账号设计约定

- PACS/RIS 侧应创建专用只读账号（例如 `epgs_pacs_reader`），仅对
  `PATIENTINFO`、`STUDYINFO`、`REPORTINFO`、`REPORTCONTENT`、`LOC`
  （以及若独立建模则包含 `STUDYSTATUS`）授予 `SELECT`，不授予
  `INSERT`/`UPDATE`/`DELETE`/DDL 权限。
- 连接串通过环境变量注入（`PACS_DB_HOST`/`PACS_DB_PORT`/`PACS_DB_NAME`/
  `PACS_DB_USER`/`PACS_DB_PASSWORD`，见 `apps/worker/.env.example`），
  代码中不硬编码任何真实主机名、账号或密码。
- `PACS_ADAPTER_MODE` 环境变量控制实现选择：`fixture`（默认，开发/测试/CI
  使用，无需真实数据库）或 `sql`（真实只读连接，本 issue 仅提供骨架，
  尚未接入具体数据库驱动——`SqlPacsRisAdapter` 在没有注入
  `ParameterizedQueryExecutor` 时会显式抛错，而不是静默失败或连接生产库）。

## 8. 与 issue 范围的关系

- 本 issue 只交付适配层本身：只读查询、DTO 映射、状态映射、分页/游标、
  fixture mock、以及本文档。
- 不做患者匹配、不做关键词分级、不做 UI、不写入/修改 PACS/RIS/HIS 数据。
- 真实的定时同步任务、`ParameterizedQueryExecutor` 的具体数据库驱动接入
  （如 `mssql` 包）、以及针对生产库的实际验证，留给 issue #6 及后续工作，
  并需要在正式接入前完成第 2 节列出的全部"待核验"事项。

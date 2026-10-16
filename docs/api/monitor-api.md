# EPGS 内镜监测工作台 API（issue #7、#8）

本文档描述 `apps/api/src/monitor/` 实现的**只读**内镜监测工作台 API：列表、筛选、
汇总、详情与明细导出。供工作台页面（issue #9+）与关注等级汇总卡片使用。issue #8 的
**详情与命中证据**契约在本文档的「详情接口」小节：每条命中的 `ruleId`/`ruleVersion`
规则来源与 `matchedField` 命中位置定位。

这四个接口全部是只读的——它们不写入、不修改任何数据（issue #139 的导出也只读取，
它把调用者本来就能在详情接口读到的字段写进文件，不产生任何写入）。字段级含义参见
`apps/api/prisma/schema.prisma` 与 `docs/data-dictionary.md` 的
`monitor_record`/`monitor_match` 章节；本文档只补充 HTTP 层的请求/响应约定与
查询语义。wire DTO 定义见 `packages/shared-types/src/monitor.ts`。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`
（`@nestjs/swagger`，见 `apps/api/src/main.ts`）。本文档是对其的手写补充，
着重说明查询语义与数据规则。

> 端到端验收与上线检查：本 API 的 10 个验收场景、筛选性能基准（≤3s，100k 行）
> 与数据库字段/稳定主键/患者类型字典记录见 [docs/acceptance.md](../acceptance.md)；
> 上线清单与回滚 runbook 见 [docs/go-live.md](../go-live.md)。

## 只读约定（产品决策，必须遵守）

产品已收敛为**只读展示**（issue #26 移除了闭环处置模型），以下约束贯穿全部四个接口：

- **响应中永不出现任何处置/上报状态字段**：`reportStatus`、`handlingStatus`、
  首报/处置字段在 issue #26 已从 schema 移除，wire DTO 中也刻意不存在。
- **列表永不返回报告正文**：`reportContent`/`diagnosis` 只在
  `GET /api/monitor/exams/:id` 详情接口按需返回（高敏感，不应随列表批量暴露）。
  列表查询的 Prisma `select` 就没有选择这两列，即使出错也不可能泄漏进列表响应。
  导出（issue #139）同样不包含这两列——它是**批量出口**，比列表更需要克制。
- **导出不是「日报」**：issue #26 取消的是**导出日报**（定时、按等级聚合、推送的
  上报产物），该取消条款至今有效，见
  [product/read-only-display-spec.md](../product/read-only-display-spec.md) §8。
  issue #139 新增的是**只读明细导出**：按需、单日、按关注的等级（#145 起可多选）、无聚合、无定时、无推送、
  无任何闭环状态字段。两者不是同一件事，不要因为「都能导出 CSV」把它们合并讨论。
- **无规则命中 = `UNCLASSIFIED`**：永不自动标注为 `GREEN`。无命中记录同样进入
  列表与汇总，供人工关注。
- **`patientType` 保留源编码 + 已确认的中文名**：源编码（如 `I`/`O`）原样返回；
  `name` 只有被确认过才填（住院/门诊…）。未知编码 `name` 为 `null`，由前端展示
  原始编码，**永不猜测**中文含义。
- **`patientName`/`keyword` 是两个独立参数，AND 组合**：`patientName` 子串匹配
  姓名，`keyword` 精确匹配命中关键词 `monitor_match.keyword`（来自
  `GET /api/rules` 的规则库，非子串），**绝不搜 `reportContent`/`diagnosis`**
  （防止无界全文扫描）。因此正文里出现某个词、但没有对应规则命中的记录，不会被
  `keyword` 搜到。

## 鉴权

所有接口均要求 Issue #31 的有效登录 Cookie，未登录或会话过期返回
`401 AUTH_REQUIRED`。本接口保持只读。

### 角色（Issue #13）

类级要求 `VIEWER | RULE_ADMIN | SYSTEM_ADMIN` 之一，否则 `403 FORBIDDEN`
（`AUDITOR` 被刻意排除——审计界面是其唯一入口）。权限与数据范围来自
`app_user_access` 授权（见 docs/auth.md）：

- **科室范围**：非空 `departmentScope` 时，列表/汇总/详情只返回授权科室的记录。
- **患者脱敏**：`patientDetail=false` 时，姓名保留姓氏、床号 → `***`、
  `reportContent`/`diagnosis`/命中 `contextSnippet` → `null`，**手机号 →
  `138****0000`**（保留前 3 位与后 4 位；短于手机号的号码丢掉前导段、隐藏位补足
  4 位，如 `0531-1234` → `*****1234`，不足 8 位整体打码；见 `maskPhone`），响应附加
  `dataAccess: { masked: true }`；未脱敏响应不带 `dataAccess`。
  性别和开单医生属 MEDIUM，两种情况都原样返回。
- **越权即 404**：请求范围外详情返回 `404 MONITOR_RECORD_NOT_FOUND`。
- **导出另有一道 `patientDetail` 授权闸门**（issue #139）：读角色只是第一道；没有
  `patientDetail` 授权时导出返回 `403 PATIENT_DETAIL_REQUIRED`（与 `FORBIDDEN`
  区分开，界面才能说清是「没有患者明细授权」而不是「没有权限」）。原因见
  [导出接口](#get-apimonitorexport)：它**故意不脱敏手机号**。

### 审计（Issue #13）

每次 `GET /api/monitor/exams` 与 `GET /api/monitor/exams/:id` 都会在 `audit_log`
落一条 `EXAM_LIST`/`EXAM_DETAIL` 记录（含 `masked` 标记；`patientName` 只记
`hadPatientName` 布尔，不落原文；`keyword` 是规则库里的非敏感值，原样记录）。
`GET /api/monitor/export` 落一条 `EXAM_EXPORT`（issue #139）。
`GET /api/monitor/summary` 只做科室范围限制，不审计。

审计是**尽力而为**的：`AuditService.record` 写失败不会让请求失败（fail-open），
所以「导出成功」不等于「必有审计行」。复核导出请查
`GET /api/audit?action=EXAM_EXPORT`。

## 统一错误格式

复用 issue #1 的全局异常过滤器，所有错误响应形如：

```json
{
  "error": {
    "code": "MONITOR_RECORD_NOT_FOUND",
    "message": "...",
    "correlationId": "..."
  }
}
```

| 错误码                       | HTTP 状态 | 触发场景                                                                                |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `INVALID_DATE_PARAM`         | 400       | `examDateFrom`/`examDateTo` 格式合法（`YYYY-MM-DD`）但不是真实日历日期，如 `2026-02-31` |
| （class-validator 校验失败） | 400       | 非法枚举（`level`/`sortBy`/`sortDir`）、日期格式非法、未知查询参数等                    |
| `MONITOR_RECORD_NOT_FOUND`   | 404       | `GET /api/monitor/exams/:id` 的 id 不存在                                               |
| `PARSE_UUID_FAILED`          | 400       | `:id` 不是合法 UUID（`ParseUUIDPipe`）                                                  |

> **为什么日期要二次校验：** `@Matches(/^\d{4}-\d{2}-\d{2}$/)` 只能保证**格式**，
> 拦不住 `2026-02-31` 这类不存在的日历日期。而 V8 的 ISO 解析会**静默归一化**
> （`2026-02-31T00:00:00+08:00` → `2026-03-02T16:00:00Z`，不是 Invalid Date），
> 若不校验就会"安静地"按错误的日期区间返回数据而不是报错。因此
> `monitor-time.ts` 对日期做了组件级回环校验（见 `assertValidCalendarDate`）。

## 查询语义

### 时间边界：Asia/Shanghai 自然日

`monitor_record.exam_time` 在库中存 UTC `timestamptz`（issue #6 约定）。时间类
筛选与展示统一按 **Asia/Shanghai 自然日**（UTC+8，无夏令时，一天恒为 24h）解释：

- `examDateFrom` = **包含下界**，即该 Shanghai 日的 00:00:00（`gte`）。
- `examDateTo` = **排他上界**，即 `examDateTo` **后一天**的 00:00:00（`lt`）——
  "到 X 日为止"包含 X 日整天，排除 X+1 日 00:00 起的记录。

示例（`2026-08-20T10:00:00Z` = Shanghai `2026-08-20 18:00`；`2026-08-19T16:30:00Z`
= Shanghai `2026-08-20 00:30`，跨 UTC 日界）：

| 查询                                            | 上界/下界（UTC）           | 效果                                             |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------ |
| `examDateFrom=2026-08-20`                       | `gte 2026-08-19T16:00:00Z` | 含 Shanghai 08-20 00:00 起（含上面那个跨日记录） |
| `examDateTo=2026-08-20`                         | `lt 2026-08-20T16:00:00Z`  | 含 Shanghai 08-20 23:59:59，排除 08-21 00:00 起  |
| `examDateFrom=2026-08-20&examDateTo=2026-08-20` | 同上两者                   | 恰好一个 Shanghai 自然日                         |

`examTime` 为 `null` 的记录永不落入任何日期区间（`null` 不满足 `gte`/`lt`）。
展示层面，`examDate`/`examTime` 用 `Intl.DateTimeFormat('zh-CN', { timeZone:
'Asia/Shanghai', hourCycle: 'h23' })` 格式化——`hourCycle: 'h23'` 保证午夜渲染为
`00:00:00` 而不是 zh-CN 的 `24:00:00`。

### 筛选参数表

以下参数在列表与汇总两个接口上**完全一致**（`MonitorFiltersDto` 被两个 DTO 复用），
多个筛选条件之间是 **AND** 关系。

| 参数              | 类型                                  | 语义                                                                                   |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `examDateFrom`    | `YYYY-MM-DD`                          | Shanghai 自然日包含下界（见上）                                                        |
| `examDateTo`      | `YYYY-MM-DD`                          | Shanghai 自然日排他上界（见上）                                                        |
| `department`      | 字符串                                | 科室，**大小写不敏感精确匹配**（`equals` + `insensitive`）                             |
| `patientTypeCode` | 字符串                                | 患者类型源编码**精确匹配**（如 `I`/`O`）                                               |
| `level`           | `RED`/`YELLOW`/`GREEN`/`UNCLASSIFIED` | 关注等级精确匹配                                                                       |
| `examItem`        | 字符串                                | 检查项目**子串匹配**（大小写不敏感）                                                   |
| `patientName`     | 字符串                                | 姓名**子串匹配**（大小写不敏感）                                                       |
| `keyword`         | 字符串                                | 命中关键词 `monitor_match.keyword` **精确匹配**（来自 `GET /api/rules`），**不含正文** |

### 排序

列表接口 `GET /api/monitor/exams` 支持 `sortBy`（白名单）+ `sortDir`：

| 参数      | 默认       | 可选值                                                                       |
| --------- | ---------- | ---------------------------------------------------------------------------- |
| `sortBy`  | `examTime` | `examTime`、`currentLevel`、`patientName`、`firstMatchedAt`、`lastMatchedAt` |
| `sortDir` | `desc`     | `asc`、`desc`                                                                |

**默认排序（issue #7 要求）**：`examTime desc`，同时刻的记录按关注等级
**RED > YELLOW > GREEN > UNCLASSIFIED** 排列，最后以 `id asc` 保证全序稳定。
数据库层实现：`currentLevel asc` 直接复用 PG enum 声明顺序
（`RED, YELLOW, GREEN, UNCLASSIFIED`），因此 `asc` 天然 RED 在前，无需额外映射。

- `examTime` 排序显式 `nulls: 'last'`；其他自定义排序列走 **Postgres 默认 null 规则**
  （`asc` = null 最后，`desc` = null 最前）。
- 自定义 `sortBy` 只有 `{ 排序列: dir, id: asc }` 两键，**不附加**等级 tie-break。
  `sortBy=currentLevel` 配默认 `sortDir=desc` 时 UNCLASSIFIED 在前；需要 RED 在前
  时前端应显式传 `sortDir=asc`。
- 白名单外的 `sortBy` 值返回 `400`（`@IsIn`）。

### 分页

`page` 默认 `1`、最小 `1`；`pageSize` 默认 `20`、最小 `1`、最大 `200`。响应
`total` 为满足筛选条件的总行数（与当前页无关）。因默认排序以 `id asc` 收尾（全序），
翻页不会出现跨页跳行/重复。

## 接口

### `GET /api/monitor/exams`

列表。请求示例（组合筛选：近两天 + 消化内科 + 住院 + RED，第 1 页）：

```
GET /api/monitor/exams?examDateFrom=2026-08-20&examDateTo=2026-08-20&department=%E6%B6%88%E5%8C%96%E5%86%85%E7%A7%91&patientTypeCode=I&level=RED&page=1&pageSize=20
```

响应（以下为合成测试数据，非真实患者）：

```json
{
  "items": [
    {
      "recordId": "11111111-1111-4111-8111-000000000008",
      "monitorLevel": "RED",
      "patientName": "测试患者庚",
      "patientSex": "女",
      "department": "消化内科",
      "bedNo": "12-8",
      "patientType": { "code": "I", "name": "住院" },
      "orderingDoctor": "测试医生甲",
      "examItem": "电子胃镜检查",
      "examDate": "2026-08-20",
      "examTime": "18:00:00",
      "matchedKeywords": ["浸润癌"],
      "attentionSource": "AI_REPORT"
    },
    {
      "recordId": "11111111-1111-4111-8111-000000000001",
      "monitorLevel": "RED",
      "patientName": "测试患者甲",
      "patientSex": "男",
      "department": "消化内科",
      "bedNo": "12-1",
      "patientType": { "code": "I", "name": "住院" },
      "orderingDoctor": "测试医生乙",
      "examItem": "电子胃镜检查",
      "examDate": "2026-08-20",
      "examTime": "16:15:00",
      "matchedKeywords": ["腺癌", "息肉样"],
      "attentionSource": "BOTH"
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 20
}
```

**列表行字段固定为**：`recordId`、`monitorLevel`、`patientName`、`patientSex`、
`department`、`bedNo`、`patientType`、`orderingDoctor`、`examItem`、`examDate`、
`examTime`、`matchedKeywords`、`attentionSource`（issue #88）。
**绝不含** `reportContent`/`diagnosis`，也绝不含任何 `reportStatus`/
`handlingStatus` 类字段——这是 wire 类型 `MonitorExamWorkbenchDto` 的硬约束。
**也绝不含** `patientPhone`：手机号是本系统最直接的可识别字段，只在详情接口、
且调用方持有 `patientDetail` 授权时才以原文返回（否则 `138****0000`），
列表任何情况下都不带它（issue #137）。
**也绝不含** `aiSemantics`/`aiJudged`/`aiStatus`：AI 文本与审计字段只出现在详情接口，
列表行上的 `aiAttentionLevel` 标量只用于推导 `attentionSource`，本身不外发。
（"这一行的 AI 判读失败了"是详情页要讲清的事，列表不承担这个信息；列表要的是
"这位患者为什么在名单上"。）

空值示例（无科室/床号、未知患者类型编码 `X`、无命中、`examTime` 为 null 的行）：

```json
{
  "recordId": "11111111-1111-4111-8111-000000000012",
  "monitorLevel": "UNCLASSIFIED",
  "patientName": "测试患者子",
  "patientSex": null,
  "department": null,
  "bedNo": null,
  "patientType": { "code": "X", "name": null },
  "orderingDoctor": null,
  "examItem": null,
  "examDate": "2026-08-17",
  "examTime": "23:59:00",
  "matchedKeywords": [],
  "attentionSource": "NONE"
}
```

> **#137 的三个新字段**：`patientSex`（性别）、`patientPhone`（手机号，仅详情）、
> `orderingDoctor`（开单医生）。三者都是**来源快照**、逐字透传，不参与筛选、排序或
> 分级；没有值时为 `null`，前端渲染"—"。老记录在重新同步覆盖前一直是 `null`。

### `GET /api/monitor/exams/{id}`

详情（工作台抽屉，issue #8）。返回列表行全部字段 **加** 报告正文快照、诊断意见与
全部命中证据。每条命中带**规则来源**（`ruleId` + `ruleVersion`，issue #8）与
**命中位置**（`matchedField`，见下方定位表）：

```json
{
  "recordId": "11111111-1111-4111-8111-000000000001",
  "monitorLevel": "RED",
  "patientName": "测试患者甲",
  "patientSex": "男",
  "patientPhone": "13800000000",
  "department": "消化内科",
  "bedNo": "12-1",
  "patientType": { "code": "I", "name": "住院" },
  "orderingDoctor": "测试医生乙",
  "examItem": "电子胃镜检查",
  "examDate": "2026-08-20",
  "examTime": "16:15:00",
  "matchedKeywords": ["腺癌", "息肉样"],
  "reportContent": "胃窦见一处隆起性病变，病理提示黏膜内腺癌。",
  "diagnosis": "胃腺癌（早期）。",
  "hits": [
    {
      "ruleId": "11111111-1111-4111-8111-0000000000aa",
      "ruleVersion": 1,
      "keyword": "腺癌",
      "level": "RED",
      "matchedField": "REPORT_TEXT",
      "contextSnippet": "…黏膜内腺癌…",
      "matchedAt": "2026-08-20T08:15:30.000Z",
      "semanticFiltered": false,
      "semantic": null
    },
    {
      "ruleId": "11111111-1111-4111-8111-0000000000bb",
      "ruleVersion": 1,
      "keyword": "息肉样",
      "level": "YELLOW",
      "matchedField": "FINDINGS",
      "contextSnippet": "…息肉样隆起…",
      "matchedAt": "2026-08-20T08:15:45.000Z",
      "semanticFiltered": false,
      "semantic": {
        "status": "PRESENT",
        "confidence": "HIGH",
        "reason": "报告中明确描述该病变。",
        "judgedAt": "2026-08-20T08:20:11.000Z"
      }
    }
  ],
  "attentionSource": "BOTH",
  "aiJudged": true,
  "aiStatus": "JUDGED",
  "aiSemantics": [
    {
      "semanticId": "22222222-2222-4222-8222-000000000001",
      "semanticVersion": 1,
      "name": "明确或高度疑似恶性病变",
      "attentionLevel": "RED",
      "confidence": "HIGH",
      "reason": "报告描述了隆起性病变并提示黏膜内腺癌。",
      "evidence": [
        { "field": "FINDINGS", "text": "一处隆起性病变" },
        { "field": "IMPRESSION", "text": "胃腺癌" }
      ]
    }
  ],
  "levelConflicts": [
    {
      "keyword": "息肉样",
      "keywordLevel": "YELLOW",
      "semanticName": "明确或高度疑似恶性病变",
      "semanticLevel": "RED",
      "field": "FINDINGS"
    }
  ]
}
```

- `hits` 即 issue #8 的 `matches`（本 API 命名为 `hits`）。按
  `matchedAt asc, id asc` 排序；`matchedKeywords` 为去重后的关键词列表，按最早命中
  顺序排列。

### 命中上的 AI 语义判读字段（issue #87）

详情接口**返回全部命中**，包括被判定"未计入关注"的那些——关键词引擎命中过是事实，
隐藏它等于隐藏一次真实事件。判读只是附加在这条命中上的注解：

| 字段                  | 取值                                                  | 说明                                                                                    |
| --------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `semanticFiltered`    | boolean                                               | 判读结论是否为"不计入关注"。**只有确定性的处置矩阵能置 true**，任何 AI 失败都保持 false |
| `semantic`            | object \| null                                        | 最近一次**成功**判读的结论；从未判读、判读失败、或规则未配置关注情况时为 `null`         |
| `semantic.status`     | `PRESENT`/`NEGATED`/`SUSPECTED`/`HISTORY`/`UNCERTAIN` | 报告里那句话是肯定/否定/疑似/既往史/无法判断。**不是关注等级**，与红黄绿无映射          |
| `semantic.confidence` | `HIGH`/`MEDIUM`/`LOW`                                 | 把握程度；只有 `HIGH` 才可能触发过滤                                                    |
| `semantic.reason`     | string \| null                                        | 给医生看的解释句。调用方没有 `patientDetail` 权限时置 `null`（结论与把握仍返回）        |
| `semantic.judgedAt`   | ISO 时间                                              | 该结论的写入时间                                                                        |

- `level` **永远不变**：它是匹配时刻规则给的等级，判读不会调整它，也不会产生新等级。
  是否计入关注由 `semanticFiltered` 表达，两者互不覆盖。
- 列表接口（`GET /api/monitor/exams`）**不返回** `semantic`，但它的口径是"有效命中"：
  `matchedKeywords`、关键词筛选与汇总计数都只统计 `semanticFiltered = false` 的命中，
  与 `monitor_record.currentLevel`（判读后按有效命中重算）保持一致。
- 审计字段（模型、版本、耗时、证据哈希、错误码）在 `monitor_match_semantic` 表，
  不对医生端返回；见 [data-dictionary.md](../data-dictionary.md) 与
  [semantic-judge-design.md](../semantic-judge-design.md)。
- **`ruleId` + `ruleVersion`**（issue #8）：命中由哪条 `monitor_rule` 的哪个版本
  产生。规则是版本化、只软禁用的（FK RESTRICT，永不物理删除），因此该引用永远
  可解析——命中证据可审计回产生它的确切规则版本。
- **`matchedField` 命中位置定位**：issue #8 规格写作 `field(REPORT_CONTENT/
DIAGNOSIS)`，实现沿用 issue #5/#26 收敛后的 `MatchField` 枚举，二者映射如下：

  | `matchedField`        | 报告位置                     | 命中文本         |
  | --------------------- | ---------------------------- | ---------------- |
  | `FINDINGS`            | 报告内容（所见描述）         | `reportContent`  |
  | `IMPRESSION`          | 诊断意见                     | `diagnosis`      |
  | `REPORT_TEXT`/`OTHER` | 全文（两个字段都查）         | 可能命中任意一个 |
  | `STUDY_DESCRIPTION`   | 检查描述（当前无独立文本源） | —                |

  因此「所有关键词命中均可定位到报告内容或诊断」（issue #8 验收）成立。

- id 不存在返回 `404 MONITOR_RECORD_NOT_FOUND`；id 不是合法 UUID 返回 `400`。
- 权限、脱敏与审计日志（issue #8 验收「权限/脱敏/审计符合 #13」）在 issue #13
  实现——当前无鉴权，本接口只读。

### 报告级 AI 语义发现字段（issue #88）

详情接口在命中证据之外，还返回**整份报告**被读出的关注语义。它与 issue #87 的
`hits[].semantic` 是两件事：那一个判的是"某条关键词命中的上下文该不该算"，这一个
判的是"这份报告整体表达了医院配置的哪些关注语义"——**关键词一条都没命中，这里也
可能有发现**，这正是该功能存在的理由。

| 字段                                               | 取值                                           | 说明                                                                                                                |
| -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `attentionSource`                                  | `RULE`/`AI_REPORT`/`BOTH`/`NONE`               | 这条记录为什么在关注列表里（真值表见下）                                                                            |
| `aiJudged`                                         | boolean                                        | AI 是否判读过**当前版本**的报告。只回答"看没看过"，不含时间、模型、耗时。恒等于 `aiStatus === 'JUDGED'`，为兼容保留 |
| `aiStatus`                                         | `JUDGED`/`FAILED`/`NOT_JUDGED`                 | AI 有没有结论、以及结论还会不会来（三态见下）                                                                       |
| `aiSemantics`                                      | array                                          | 报告级发现，按关注等级优先级（RED → YELLOW → GREEN）再按模型输出顺序排列                                            |
| `aiSemantics[].semanticId` / `.semanticVersion`    | uuid / number                                  | 依据的是医院哪一版关注语义（`attention_semantic` 永不物理删除，引用可解析）                                         |
| `aiSemantics[].name`                               | string                                         | 该版关注语义的名称（命中时刻的快照）                                                                                |
| `aiSemantics[].attentionLevel`                     | `RED`/`YELLOW`/`GREEN`                         | 该关注语义**配置**的颜色。最终关注等级是这些颜色与关键词等级取最大值                                                |
| `aiSemantics[].confidence`                         | `HIGH`/`MEDIUM`/`LOW`                          | 把握程度，**仅描述性**：issue #88 不过滤低把握的发现                                                                |
| `aiSemantics[].reason`                             | string \| null                                 | 给医生看的解释句。无 `patientDetail` 权限时置 `null`                                                                |
| `aiSemantics[].evidence`                           | array                                          | 证据引用；无 `patientDetail` 权限时整体置 `[]`                                                                      |
| `evidence[].field`                                 | `EXAM_ITEM`/`FINDINGS`/`IMPRESSION`            | 片段出自哪一列：检查项目 / 报告内容 / 诊断                                                                          |
| `evidence[].text`                                  | string                                         | **服务端按偏移从报告原文重算出的片段**，与库中正文逐字节相同                                                        |
| `levelConflicts`                                   | array                                          | 同一处两边等级不同的位置（issue #103，见下）。无分歧时为 `[]`                                                       |
| `levelConflicts[].keyword` / `.keywordLevel`       | string / `RED`/`YELLOW`/`GREEN`/`UNCLASSIFIED` | 关键词那一侧（与 `hits[].keyword`/`.level` 同源）                                                                   |
| `levelConflicts[].semanticName` / `.semanticLevel` | string / `RED`/`YELLOW`/`GREEN`                | 报告级判读那一侧（与 `aiSemantics[].name`/`.attentionLevel` 同源）                                                  |
| `levelConflicts[].field`                           | `FINDINGS`/`IMPRESSION`                        | 两边落在**同一列**才配对：报告内容 / 诊断                                                                           |

**`attentionSource` 真值表**（只由记录上已有的两个输入决定，不看谁高谁低）：

| 值          | 有效关键词命中 | `aiAttentionLevel` | 含义                     |
| ----------- | -------------- | ------------------ | ------------------------ |
| `RULE`      | 有             | 空                 | 只有关键词路径发现了内容 |
| `AI_REPORT` | 无             | 非空               | 只有报告级判读发现了内容 |
| `BOTH`      | 有             | 非空               | 两条路径都发现了内容     |
| `NONE`      | 无             | 空                 | 两条路径都没发现         |

issue #94 之前，调用方用这个字段渲染一个中性灰的「来源徽标」（关键词 / AI 语义 /
关键词 + AI 语义）。**该徽标已从临床视图移除**（取舍理由见
[rules-config-ui.md](./rules-config-ui.md) 的「医生看到什么」）；字段本身仍在契约上，
供运营与审计路径使用，也是工作台/抽屉那句关注理由决定要不要说「报告提示…」的依据。
**本字段是派生值、不是判定值**：它不参与等级计算，改它不影响任何记录的关注等级。

关键词 RED + AI YELLOW 仍然是 `BOTH`：AI 另外读出的内容本身就是医生该看的临床
上下文，命名只回答"从哪里来"，不回答"谁更重"。`NONE` 是枚举成员而非 `null`，
因为"两条路径都没发现"（记录为 `UNCLASSIFIED`，本来就在列表里可见）是一个真实
状态，可空字段只会制造含混的 NULL。**`attentionSource` 与 `monitorLevel` 读的是
同一组输入**，所以 `NONE` 与 `UNCLASSIFIED` 必然同时出现，本字段不可能与等级矛盾。

**`aiStatus` 三态（issue #102）。** 它回答的是"这条记录的关注等级背后有没有 AI 结论"，
以及"结论还会不会来"：

| 值           | 条件                                                      | 调用方要求                                             |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------ |
| `JUDGED`     | 当前报告版本有一条 `outcome = 'OK'` 的尝试                | 正常展示结论（含"看了但没发现"，即 `aiSemantics: []`） |
| `FAILED`     | 有 `ERROR` 尝试、当前版本没有 `OK` 尝试，**且记录已出队** | **必须显式告知结论不完整**，见下                       |
| `NOT_JUDGED` | 其余（没问过、正文已换、还在队列里）                      | 无需额外说明                                           |

- **`FAILED` 必须让医生看见。** 此时关注等级只由关键词路径产生，AI 那一半**永久缺席**
  （记录已出队，不会再有尝试）。渲染成与普通关键词记录无异的界面，等于让医生把"没判"
  读成"判了但没有"——这是 issue #102 存在的理由。
- **`FAILED` 与 `aiJudged: false` 不是一回事。** 后者包含"还没轮到它判"这种正常状态；
  只有"失败过且不会再试"才是 `FAILED`。判断依据里**必须**带上队列状态（`aiResolvedAt`），
  只看"有没有 ERROR 行"会把还在重试的记录误报成失败。
- **医生端只被告知"没判成"，不被告知"为什么"。** `aiStatus` 只读 `outcome` 与队列状态，
  不读 `error` 错误码、模型、耗时；失败原因留在 `monitor_report_ai`，由有权限的运维
  路径查（见 [ai-semantic-monitor-design.md](../ai-semantic-monitor-design.md) §7.2）。
- **失败分级与重试次数**见 [ai-semantic-monitor-design.md](../ai-semantic-monitor-design.md)
  §7.1：传输层失败会留在队列里重试到上限，因此同一份报告可能有多行 `ERROR` 审计，
  期间 `aiStatus` 是 `NOT_JUDGED`，跑满之后才变 `FAILED`。

### 等级分歧（issue #103）

`levelConflicts` 说的是：关键词路径与报告级判读路径**落在同一列、区间相交，但给出
了不同的关注等级**。在它之前，医生端把这样一对显示成合并列表里一条红、一条黄并排，
摘要句用「；」把两侧并列——读起来像两条互相印证的独立理由，而真相是两条规则指着
**同一处**、要的关注等级不一样，需要有人裁定。

- **它报的是分歧，不是胜负。** 不说哪边对，也不改任何等级。
- **等级相同不报**；两侧不在同一列不报（关键词侧只存实际命中的那一列，两边只有
  `FINDINGS`/`IMPRESSION` 有文本来源，AI 的 `EXAM_ITEM` 恒不参与）。
- **为空是常态**，空数组时医生端**什么都不渲染**——一条天天挂着的提醒等于没有提醒。
- 判定只有一份实现（`apps/api/src/monitor/level-conflict.ts`），医生端这个字段与
  管理员待办列表（[monitor-level-conflict-api.md](../monitor-level-conflict-api.md)）
  共用它，不可能各说各的。
- **不是新的正文出口**：`keyword`/`semanticName`/两个等级本来就同在这条响应里，
  `field` 是列名而不是文本；偏移与证据原文一概不上 wire。因此
  [脱敏（`patientDetail` 缺失）](../auth.md)时这个字段**原样保留**——它由调用方本来
  就看得见的关键词与发现名推导而来。每条分歧点名的发现必然也出现在 `aiSemantics`
  里（同一份尝试、同一个闸门推导），不会出现"提醒指着一个界面没画出来的东西"。
- 医学上它不是诊断分歧，是**配置**分歧：规则的等级划高了，或那条关注语义的等级
  划低了。

**证据为什么是重算的。** `monitor_report_ai_evidence` 只存 `evidence_hash` 与
`evidence_start`/`evidence_end`（UTF-16 码元，左闭右开，指向 `monitor_record` 的
`exam_item`/`report_content`/`diagnosis` 之一）。报告正文原文不落在 AI 表里。因此
本接口按偏移从库中正文切出片段返回；切片为空、偏移越界或哈希对不上（正文已被替换）
时**丢弃该条片段、保留发现**，`evidence: []`——丢掉整个发现会让抽屉与仍把它算进
`currentLevel` 的等级自相矛盾。这里没有 500 分支。

**AI 侧"陈旧"的两种情况。** `monitor_report_ai*` 是 append-only：

- 报告正文被重新同步时，`sync-runner` 在同一次写入里清空记录的 AI 状态
  （`ai_attention_level` 置空），但历史尝试行仍在。此时接口**不返回**那些发现
  （`aiSemantics: []`），等级与 `attentionSource` 也同步退回 `RULE`/`NONE`——两者永远同向。
- 重跑（`requeue`）**有意保留** `ai_attention_level`，重跑期间显示上一版结论是
  合法行为。

**审计字段一律不出现在医生端**：模型标识、`taskVersion`、`modelVersion`、
`inputHash`、`reportHash`、`configHash`、`latencyMs`、`error`、`modelAttentionLevel`
以及**证据哈希**都只存于 `monitor_report_ai` / `_match` / `_evidence` 三张表，
读路径的 Prisma `select` 里根本没有这些列。同上，`aiJudged` 用布尔而不是
`aiJudgedAt` 时间戳，也是这条规矩的推论。

**脱敏（无 `patientDetail` 权限时）**：`reason` 置 `null`、`evidence` 整体置 `[]`
（不按 `field` 分档——同一个数组可能混着不同来源，分档会产出红一半留一半的列表），
而 `name`/`attentionLevel`/`confidence`/`semanticId`/`semanticVersion` 保留：后一组
是在解释一个调用方**本来就看得见**的关注等级，前者是报告邻近的自由文本，与
`contextSnippet` 同类。

**预警链接 H5 面（issue #72）不返回以上任何字段。** `AlertLinkExamDetailDto` 就是
基础类型 `MonitorExamDetailDto`，`AlertLinkExamListDto.items` 就是
`MonitorExamDto[]`，两者在类型层面就叫不出这些字段；`listByIds` 仍走基础映射，
H5 详情则从白名单构造基类型对象。通知形态是被冻结的面，链接可以被转发到工作台之外。

### `GET /api/monitor/summary`

关注等级汇总，**筛选参数与列表完全一致**（同一个 `where`），无分页/排序
（就是 5 个桶的计数）：

```
GET /api/monitor/summary?department=%E6%B6%88%E5%8C%96%E5%86%85%E7%A7%91
```

```json
{
  "total": 7,
  "red": 2,
  "yellow": 3,
  "green": 1,
  "unclassified": 1
}
```

- `total` = 满足筛选的记录总数；因为 `current_level` 非空、每条记录恰好落在一个
  桶里，**恒有 `total == red + yellow + green + unclassified`**（空筛时 5 桶默认 0）。
- 内部用一条 `GROUP BY current_level` 聚合，而不是 5 次 COUNT。

### `GET /api/monitor/export`（issue #139，多等级见 #145）

把**一个自然日 + 选定的关注等级（一个或多个）**的患者明细导出成 CSV 文件。

```
GET /api/monitor/export?examDate=2026-08-20&levels=RED,YELLOW
```

**查询参数（两个都必填，没有别的）**

| 参数       | 类型                                                  | 说明                                                      |
| ---------- | ----------------------------------------------------- | --------------------------------------------------------- |
| `examDate` | `^YYYY-MM-DD$`                                        | 检查日期，**单日**（Asia/Shanghai 自然日）                |
| `levels`   | `RED\|YELLOW\|GREEN\|UNCLASSIFIED` 的**逗号分隔列表** | 关注等级，**至少一个**；去重并归一化到「红→黄→绿→未分级」 |

- `levels` 是**一个**逗号分隔的参数（`?levels=RED,YELLOW`），不是重复参数；重复
  参数形式（`?levels=RED&levels=YELLOW`）也接受，因为 Nest 交给 DTO 的就是数组。
- **归一化**：去重 + 按红→黄→绿→未分级排序。`YELLOW,RED,RED` 与 `RED,YELLOW`
  得到**同一个文件名和同一份内容**（否则同一个选择会在下载目录里堆出 `…(1).csv`）。
  归一化在 `orderExportLevels()`（`apps/api/src/monitor/monitor-csv.ts`）。
- **`?levels=` 空、只写分隔符、缺参、未知等级值（含小写 `red`、中文 `红色关注`）
  一律 400。** 未知值**不**被静默丢掉：丢掉会让 `?levels=RED,PURPLE` 变成「200 但
  只导了红色」，调用方拿到文件却永远不知道另一半请求被无视。
- **旧的 `?level=RED`（单数）现在返回 400，这是有意的**：保留别名会把「单等级」这份
  契约永远留在 API 里，而它已经不是这个接口的意思了。
- **#145 把「一天的全部患者打成一个文件」变成可达成**（勾满四个等级），所以下面的
  10000 行上限从「永不触发的护栏」变成可能真的挡住一次请求——它仍然是 400，
  **不截断**。

- **「单日」的语义就是 `examDateFrom = examDateTo = examDate`，绝对不要写成
  `examDate` 到「次日」。** `resolveDateRange`（`apps/api/src/monitor/monitor-time.ts`）
  已经把上界推到次日 `00:00+08`，再传 `D..D+1` 会导出**两天**。工作台的「近一日」
  预设同样是 `from = to = today`。
- DTO 是新写的两字段必填 DTO，**不复用** `MonitorFiltersQueryDto`：
  class-validator 会继承 `@IsOptional()` 的元数据，子类无法把字段改回必填；
  且复用等于把「单日 + 选定的等级」这条业务规则只留在前端。`main.ts` 已开
  `forbidNonWhitelisted`，所以 `?department=`、`?page=1`、`?examDateFrom=` 之类
  一律 **400**——既有的筛选面挤不进这个口子。
- `examTime` 为 `NULL` 的记录**永不出现**（日范围是 `exam_time` 上的
  `gte`/`lt`，`NULL` 不满足任何区间比较）。
- 科室范围（`departmentScope`）照旧生效。

**授权：两道闸门**

1. 类级 `@RequireRoles(VIEWER | RULE_ADMIN | SYSTEM_ADMIN)`——`AUDITOR` 等无读
   角色 → `403 FORBIDDEN`。
2. 处理函数首行再查 `patientDetail` 授权——有读角色但无该授权 →
   **`403 PATIENT_DETAIL_REQUIRED`**（消息「没有导出患者明细的权限，请联系管理员开通。」）。

第 2 道是**本接口设计的核心**，理由只有一个：**这个文件里的手机号是原文，不脱敏**
（所有者决定，2026-10-16）。`patientDetail` 恰好就是「已经能在详情抽屉里看到同一个
手机号」的那份授权，所以导出没有新增特权——它只是拒绝成为绕过既有授权的一条路。
因此**没有「脱敏导出」这种模式**，代码里也不存在那条分支：如果您正想「顺手修好、
给脱敏用户也放行」，那是把 HIGH 级字段的批量出口开给了没有该授权的人。

未登录 → `401 AUTH_REQUIRED`。**预警链接令牌不是工作台凭据**，用它调这个接口同样
401（普通链接不应变成一份患者名单，这一条在 `alert-links.e2e-spec.ts` 里有专门
用例）。

**响应头**

| 头                       | 值                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Type`           | `text/csv; charset=utf-8`                                                                                                                |
| `Content-Disposition`    | `attachment; filename="monitor-2026-08-20-RED-YELLOW.csv"; filename*=UTF-8''<percent-encoded 数据导出-2026-08-20-红色关注+黄色关注.csv>` |
| `Content-Length`         | 字节数                                                                                                                                   |
| `Cache-Control`          | `no-store`                                                                                                                               |
| `X-Content-Type-Options` | `nosniff`                                                                                                                                |
| `X-Row-Count`            | 数据行数（不含表头）                                                                                                                     |

- ASCII 的 `filename=` 在前、RFC 5987 的 `filename*=UTF-8''` 在后，两个都留着：
  前者给忽略后者的客户端兜底。浏览器 fetch + blob 下载会**忽略**
  `Content-Disposition` 而用 `a[download]` 的名字，所以服务端
  `csvFileName()` 与前端 `exportFileName()` 是**必须逐字一致的一对双胞胎**。
- 多等级时的文件名：中文那截用 `+` 连接（`数据导出-2026-08-20-红色关注+黄色关注.csv`），
  ASCII 那截用 `-` 连接（`monitor-2026-08-20-RED-YELLOW.csv`）——ASCII 段里放 `,`
  会被读成 header 列表分隔符。文件名只由**选择**决定，与调用方传参顺序无关。
- `Cache-Control: no-store` 不是可选项：一份患者名单不得被任何中间层留存。
- `X-Row-Count` 只带行数、不带任何患者信息，是给界面区分「没有符合条件的记录」与
  「这就是你的文件」用的。它叫这个泛名是为了避开 `log-sanitization.spec.ts` 的
  标识符门禁（`X-` + 大写动词 + `-` 这种形状里，连字符是词边界）。
- 只有 `X-Row-Count: 0` 时界面才**不落盘**：0 行文件仍是一个合法 CSV（只有表头），
  但存一个只有表头的文件对用户没有用。读不到这个头时按「有内容」处理，不能当成 0。

**CSV 内容**

编码 UTF-8 **带 BOM**（`EF BB BF`；Excel 靠它把中文表头读成 UTF-8 而不是乱码），
行尾 `\r\n`（RFC 4180），含 `"` `,` `\r` `\n` 的值按 RFC 4180 加引号并翻倍内部引号。

列顺序（精确）：

```
关注等级,患者姓名,性别,科室,床号,患者类型,开单医生,检查项目,检查日期,检查时间,命中关键词,手机号
```

- **`NULL` 导出为空单元格，不是 `—`。** 屏幕上的 `—` 是渲染决定，不是数据；配合
  #137「历史数据不回填」的决定，「空」正是「来源没有值」的意思，而且在 Excel 里
  空单元格能正常参与排序与筛选。
- 关注等级用中文（红色关注/黄色关注/绿色关注/未分级），与
  `apps/web/src/attentionSource.ts` 的 `ATTENTION_LEVEL_LABELS` 逐字一致。
- 患者类型：有名字时 `名字（code）`，否则 `code`，否则空。**服务端不臆造**
  `patient_type_name`（data-dictionary 明令）；界面上的编码→中文兜底表是屏幕的
  方便，故意没有搬到这里。
- 检查日期/时间用 `HH:mm:ss`，与工作台那一列同形。
- 命中关键词用 `、` 连接，只有**未被 AI 语义过滤掉的**命中（与屏幕上一致）。
- **公式注入防护**：值首字符为 `=` `+` `-` `@` `\t` `\r` 时前置一个 `'`。仅加引号
  **挡不住** Excel/LibreOffice 的公式求值，所以这条必须做，且那个 `'` 是文本前缀，
  显示时会被吃掉（`+8613800000000` 仍然读得对）。
- **文件里没有**：`reportContent`、`diagnosis`、`contextSnippet`（HIGH 级报告正文，
  批量出口不应携带）、`passwordHash`、以及**任何内部 UUID**——**连 id 列都没有**，
  使这份文件无法反查内部键。
- 表头与文件名请以 `apps/api/src/monitor/monitor-csv.ts` 为唯一事实来源。

**上限**

`MONITOR_EXPORT_MAX_ROWS = 10000`。查询用 `take = MAX + 1` 作溢出探针，超过则
`400 MONITOR_EXPORT_TOO_LARGE`（「当日该等级记录过多（超过 10000 条），导出已取消，
请联系管理员。」），**绝不静默截断**——静默截断会交出一份看起来完整、实际不完整的
文件。这是**数据损坏护栏**，不是用户路径：单日一天 10000 条已属异常，超过就说明数据
有问题（#145 之后「勾满四个等级」使这条路径可达，届时用户可缩小等级选择重试）。

**审计**

落一条 `EXAM_EXPORT`，`meta = { scope, examDate, levels, rowCount }`——只有筛选值与
行数，**绝不含任何患者字段，也绝不含文件内容**。`levels` 是**数组**（#145）：一次
「红+黄」的导出是**一行**，这一行正是事后告诉审计者「离开系统的那份文件有多宽」的
唯一记录。纪律同 `EXAM_LIST` 用 `hadPatientName` 布尔量而非搜索串：审计轨迹必须能在
不持有患者数据的前提下被阅读。注意 `AuditService.record` 是 **fail-open**，所以文档
不声称「每次导出必有审计行」。复核用 `GET /api/audit?action=EXAM_EXPORT`。

## 测试

- 单元测试（mock Prisma，无需数据库）：`apps/api/src/monitor/monitor.service.spec.ts`
  —— where/orderBy 形状、Shanghai 展示格式、关键词去重、patientType 透传、
  汇总聚合、详情未找到、详情查询包含 `rule.version`（issue #8）。
- 报告级 AI 发现的单元测试（纯函数，issue #88）：
  `apps/api/src/monitor/report-ai.mapper.spec.ts` —— `attentionSource` 四种来源真值
  表、尝试选择（只认 OK、优先 `createdAt == aiResolvedAt` 的那次、版本不符不展示）、
  证据重算（越界/负值/`start >= end`/空切片/正文变更导致哈希不符 → 丢片段留发现，
  空白折叠形态仍接受）、三个 `field` 对三列的映射、发现按等级优先级排序，以及
  `aiStatus` 三态（issue #102：`JUDGED` 含"看了但没发现"与"先失败后成功"两种历史、
  `FAILED` 仅在记录已出队时成立、重试待办期间是 `NOT_JUDGED`，并有"`aiStatus` 不得与
  `aiJudged` 互相矛盾"的等价性用例）。失败分级本身的单测在 worker：
  `apps/worker/src/semantic-report/retry-policy.spec.ts`（含"新增错误码而未分级必须
  挂测试"的完备性用例）。
- 端到端测试（真实 Postgres）：`apps/api/test/monitor.e2e-spec.ts` —— 组合筛选、
  跨 UTC 日界的 Shanghai 边界、自然日边界（午夜 00:00、23:59）、null 行、稳定分页、
  非法参数 400、汇总与列表同筛一致性、只读详情，以及 issue #8 的命中证据契约
  （每条命中的 `ruleId`/`ruleVersion` 规则来源、`matchedField` 报告位置定位、
  空诊断行）。该文件在检测不到可用 Postgres 时全部用例 no-op 通过（不影响
  issue #1 的无数据库 CI）；CI 中真正执行在 `.github/workflows/ci.yml` 的
  `db-migrations` job。
- 报告级 AI 发现的端到端测试（真实 Postgres，issue #88）：
  `apps/api/test/monitor-ai.e2e-spec.ts` —— 四种 `attentionSource` 与等级的对应
  （含 `NONE` ⟺ `UNCLASSIFIED` 不变式）、证据文本与库中报告子串**逐字节相同**、
  陈旧偏移 → 片段丢弃而发现保留且 HTTP 200、**审计字段泄漏扫描**（序列化后的响应
  不含任何哈希/模型/耗时/错误字段名，也不含 64 位十六进制串）、列表信封每项有
  `attentionSource` 而无 `aiSemantics`，以及 `listByIds`（预警 H5 列表路径）返回
  基类型行。issue #102 另有一组：种一条 `ERROR` 尝试断言 `aiStatus: 'FAILED'` 且
  等级退回纯关键词路径，并单独断言**失败原因本身**（错误码字符串、`error` 字段）不
  出现在这份响应里。脱敏与 H5 边界的成对断言分别在 `security.e2e-spec.ts` 与
  `alert-links.e2e-spec.ts`。issue #103 又加了一组：`levelConflicts` 在分歧存在时
  逐字给出两边的名字与等级（键集合固定为
  `field/keyword/keywordLevel/semanticLevel/semanticName`），**等级一致时为 `[]`**，
  且它**不出现在列表信封上**（列表行没有这个字段）。
- 等级分歧的判定单测（纯函数，issue #103）：`apps/api/src/monitor/level-conflict.spec.ts`
  —— 区间相交/不相交/首尾相接不算相交、偏移缺失时退回"证据原文包含关键词"、
  两套枚举映射不上的组合恒不配对、等级相同不报、一命中对多发现与一发现对多命中
  各自成条、输出去重与排序。同一条判定的聚合与已读状态另有
  `apps/api/src/level-conflicts/` 下的三个 spec。

- CSV 序列化的单测（纯函数，issue #139）：`apps/api/src/monitor/monitor-csv.spec.ts`
  —— 表头与列序、BOM 三个字节、CRLF、引号与内部引号翻倍、七个可空字段 → 空单元格、
  四个中文等级、手机号原文通过且脱敏串永不出现、公式注入四种前缀、0/1/N 个关键词、
  患者类型三种组合、`contentDispositionFor` 的 ASCII 段不含非 ASCII。
- 导出的控制器单测（mock service，issue #139）：
  `apps/api/src/monitor/monitor.controller.spec.ts` —— 无授权 403 且**不读库、不写审计、
  不设任何响应头**、`@CurrentUser()` 为 null 同样 403、成功时 `StreamableFile` 的
  type/length/disposition、审计 `meta` 恰好只有四个键且序列化后无患者数据。
- 导出的端到端测试（真实 Postgres，issue #139）：`apps/api/test/monitor.e2e-spec.ts`
  新加的四条——整份 CSV 的逐行内容与「不含报告正文/诊断」、**日界两端**（当日
  `00:00:00` 与 `23:59:00` 在内、次日 `00:00` 在外，这条就是防止 `D..D+1` 重犯的
  回归测试）、`examTime` 为 null 的行永不出现、非法与多余参数 400；
  `apps/api/test/security.e2e-spec.ts` 的——**系统管理员也不例外**的
  `PATIENT_DETAIL_REQUIRED`、AUDITOR 的 `FORBIDDEN`、含原文手机号且不含脱敏串、
  科室范围外为空、审计 `meta` 只有筛选值。

本地验证 real Postgres 的临时实例方式（与 `docs/rules-api.md` 相同）：

```bash
initdb -D /tmp/epgs-pgdata -U epgs --auth=trust -E UTF8
pg_ctl -D /tmp/epgs-pgdata -o "-p 5544 -k /tmp" -l /tmp/epgs-pg.log start
createdb -h /tmp -p 5544 -U epgs epgs
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec prisma migrate deploy
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec jest --config ./test/jest-e2e.json test/monitor.e2e-spec.ts
pg_ctl -D /tmp/epgs-pgdata stop
rm -rf /tmp/epgs-pgdata /tmp/epgs-pg.log
```

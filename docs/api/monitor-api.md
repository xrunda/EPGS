# EPGS 内镜监测工作台 API（issue #7、#8）

本文档描述 `apps/api/src/monitor/` 实现的**只读**内镜监测工作台 API：列表、筛选、
汇总与详情。供工作台页面（issue #9+）与关注等级汇总卡片使用。issue #8 的
**详情与命中证据**契约在本文档的「详情接口」小节：每条命中的 `ruleId`/`ruleVersion`
规则来源与 `matchedField` 命中位置定位。

这三个接口全部是只读的——它们不写入、不修改任何数据。字段级含义参见
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

产品已收敛为**只读展示**（issue #26 移除了闭环处置模型），以下约束贯穿全部三个接口：

- **响应中永不出现任何处置/上报状态字段**：`reportStatus`、`handlingStatus`、
  首报/处置字段在 issue #26 已从 schema 移除，wire DTO 中也刻意不存在。
- **列表永不返回报告正文**：`reportContent`/`diagnosis` 只在
  `GET /api/monitor/exams/:id` 详情接口按需返回（高敏感，不应随列表批量暴露）。
  列表查询的 Prisma `select` 就没有选择这两列，即使出错也不可能泄漏进列表响应。
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
  `reportContent`/`diagnosis`/命中 `contextSnippet` → `null`，响应附加
  `dataAccess: { masked: true }`；未脱敏响应不带 `dataAccess`。
- **越权即 404**：请求范围外详情返回 `404 MONITOR_RECORD_NOT_FOUND`。

### 审计（Issue #13）

每次 `GET /api/monitor/exams` 与 `GET /api/monitor/exams/:id` 都会在 `audit_log`
落一条 `EXAM_LIST`/`EXAM_DETAIL` 记录（含 `masked` 标记；`patientName` 只记
`hadPatientName` 布尔，不落原文；`keyword` 是规则库里的非敏感值，原样记录）。
`GET /api/monitor/summary` 只做科室范围限制，不审计。

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
      "department": "消化内科",
      "bedNo": "12-8",
      "patientType": { "code": "I", "name": "住院" },
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
      "department": "消化内科",
      "bedNo": "12-1",
      "patientType": { "code": "I", "name": "住院" },
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

**列表行字段固定为**：`recordId`、`monitorLevel`、`patientName`、`department`、
`bedNo`、`patientType`、`examItem`、`examDate`、`examTime`、`matchedKeywords`、
`attentionSource`（issue #88）。
**绝不含** `reportContent`/`diagnosis`，也绝不含任何 `reportStatus`/
`handlingStatus` 类字段——这是 wire 类型 `MonitorExamWorkbenchDto` 的硬约束。
**也绝不含** `aiSemantics`/`aiJudged`：AI 文本与审计字段只出现在详情接口，
列表行上的 `aiAttentionLevel` 标量只用于推导 `attentionSource`，本身不外发。

空值示例（无科室/床号、未知患者类型编码 `X`、无命中、`examTime` 为 null 的行）：

```json
{
  "recordId": "11111111-1111-4111-8111-000000000012",
  "monitorLevel": "UNCLASSIFIED",
  "patientName": "测试患者子",
  "department": null,
  "bedNo": null,
  "patientType": { "code": "X", "name": null },
  "examItem": null,
  "examDate": "2026-08-17",
  "examTime": "23:59:00",
  "matchedKeywords": [],
  "attentionSource": "NONE"
}
```

### `GET /api/monitor/exams/{id}`

详情（工作台抽屉，issue #8）。返回列表行全部字段 **加** 报告正文快照、诊断意见与
全部命中证据。每条命中带**规则来源**（`ruleId` + `ruleVersion`，issue #8）与
**命中位置**（`matchedField`，见下方定位表）：

```json
{
  "recordId": "11111111-1111-4111-8111-000000000001",
  "monitorLevel": "RED",
  "patientName": "测试患者甲",
  "department": "消化内科",
  "bedNo": "12-1",
  "patientType": { "code": "I", "name": "住院" },
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

| 字段                    | 取值                              | 说明                                                                       |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| `attentionSource`       | `RULE`/`AI_REPORT`/`BOTH`/`NONE`  | 这条记录为什么在关注列表里（真值表见下）                                   |
| `aiJudged`              | boolean                           | AI 是否判读过**当前版本**的报告。只回答"看没看过"，不含时间、模型、耗时     |
| `aiSemantics`           | array                             | 报告级发现，按关注等级优先级（RED → YELLOW → GREEN）再按模型输出顺序排列    |
| `aiSemantics[].semanticId` / `.semanticVersion` | uuid / number        | 依据的是医院哪一版关注语义（`attention_semantic` 永不物理删除，引用可解析） |
| `aiSemantics[].name`    | string                            | 该版关注语义的名称（命中时刻的快照）                                       |
| `aiSemantics[].attentionLevel` | `RED`/`YELLOW`/`GREEN`     | 该关注语义**配置**的颜色。最终关注等级是这些颜色与关键词等级取最大值        |
| `aiSemantics[].confidence` | `HIGH`/`MEDIUM`/`LOW`          | 把握程度，**仅描述性**：issue #88 不过滤低把握的发现                        |
| `aiSemantics[].reason`  | string \| null                   | 给医生看的解释句。无 `patientDetail` 权限时置 `null`                        |
| `aiSemantics[].evidence` | array                            | 证据引用；无 `patientDetail` 权限时整体置 `[]`                              |
| `evidence[].field`      | `EXAM_ITEM`/`FINDINGS`/`IMPRESSION` | 片段出自哪一列：检查项目 / 报告内容 / 诊断                                |
| `evidence[].text`       | string                            | **服务端按偏移从报告原文重算出的片段**，与库中正文逐字节相同                |

**`attentionSource` 真值表**（只由记录上已有的两个输入决定，不看谁高谁低）：

| 值          | 有效关键词命中 | `aiAttentionLevel` | 含义                       |
| ----------- | -------------- | ------------------ | -------------------------- |
| `RULE`      | 有             | 空                 | 只有关键词路径发现了内容   |
| `AI_REPORT` | 无             | 非空               | 只有报告级判读发现了内容   |
| `BOTH`      | 有             | 非空               | 两条路径都发现了内容       |
| `NONE`      | 无             | 空                 | 两条路径都没发现           |

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

## 测试

- 单元测试（mock Prisma，无需数据库）：`apps/api/src/monitor/monitor.service.spec.ts`
  —— where/orderBy 形状、Shanghai 展示格式、关键词去重、patientType 透传、
  汇总聚合、详情未找到、详情查询包含 `rule.version`（issue #8）。
- 报告级 AI 发现的单元测试（纯函数，issue #88）：
  `apps/api/src/monitor/report-ai.mapper.spec.ts` —— `attentionSource` 四种来源真值
  表、尝试选择（只认 OK、优先 `createdAt == aiResolvedAt` 的那次、版本不符不展示）、
  证据重算（越界/负值/`start >= end`/空切片/正文变更导致哈希不符 → 丢片段留发现，
  空白折叠形态仍接受）、三个 `field` 对三列的映射、发现按等级优先级排序。
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
  基类型行。脱敏与 H5 边界的成对断言分别在 `security.e2e-spec.ts` 与
  `alert-links.e2e-spec.ts`。

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

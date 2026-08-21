# PACS/RIS 内镜数据 API 交付规范

> 对应 Issue：#20  
> OpenAPI：[`pacs-ris-data-api.openapi.yaml`](./pacs-ris-data-api.openapi.yaml)  
> 接口版本：v1 / 文档版本：1.0.0

## 1. 文档用途

本文档交给负责读取医院 PACS/RIS 数据库的后端开发人员，规定其必须向 EPGS
交付的内部 HTTP API。后端开发人员负责核验真实数据库、实现只读查询并保证
接口符合本契约；EPGS Worker 负责调用该 API，完成增量同步、关键词匹配和
红黄绿关注等级计算。

该 API 不是浏览器接口。Web 前端必须访问 EPGS 的业务 API，不得直接访问
数据库网关。

```text
PACS/RIS 数据库（只读）
          │
          ▼
医院数据库网关（本文档定义的 API）
          │  内网 + 服务身份认证
          ▼
EPGS Worker → 监测业务库 → EPGS API → Web 工作台
```

## 2. 职责边界

### 数据库网关负责

- 使用专用只读账号查询实际 PACS/RIS 数据库。
- 将厂商表字段映射为本文档定义的稳定 JSON 字段。
- 按更新时间提供有边界的增量分页查询。
- 返回检查所见、诊断意见和报告流程状态的原始数据。
- 提供单份报告、科室字典和健康检查。
- 实现服务鉴权、参数校验、查询限流、错误脱敏和安全日志。

### 数据库网关不负责

- 不匹配关键词，不计算红黄绿等级。
- 不维护待上报、已上报、已知晓、已处理或误报状态。
- 不向 PACS/RIS/HIS 写入任何数据。
- 不直接服务浏览器或向院外通道发送患者数据。
- 不把未审核内容解释为正式诊断。

## 3. 联调前必须完成的数据库核验

以下内容不能继续使用假设值。后端开发人员应在安全渠道记录实际值，并在 PR
中仅写脱敏结论，不提交真实地址、账号或患者样本。

| 核验项           | 当前候选/假设                | 后端必须确认的结果                                     |
| ---------------- | ---------------------------- | ------------------------------------------------------ |
| 数据库类型与版本 | SQL Server                   | 实际产品、版本和驱动                                   |
| 患者表           | `PATIENTINFO`                | 真实表名、主键、住院号/姓名/性别/年龄字段              |
| 检查表           | `STUDYINFO`                  | 检查号、患者关联键、项目、时间、科室、床号、设备字段   |
| 报告主表         | `REPORTINFO`                 | 报告 ID、检查关联键、状态及保存/提交/审核/更新时间字段 |
| 报告内容表       | `REPORTCONTENT`              | 检查所见、诊断意见及与报告版本的关联方式               |
| 科室表           | `LOC`                        | 科室 ID、名称及权威来源                                |
| 状态表           | `STUDYSTATUS` 或报告主表字段 | 状态码全集及业务含义                                   |
| 报告最早可读节点 | 首次保存后可能可读           | 保存、提交、审核三个节点分别验证内容是否可查           |
| 多版本关系       | 一个检查可能有多份报告       | 如何唯一标识版本、是否保留历史版本                     |
| 内容一对多       | 待确认                       | 多段内容拼接顺序或最新记录选择规则                     |
| 源时区           | Asia/Shanghai                | 数据库字段/会话时区及转 UTC 规则                       |
| 增量字段         | 报告最后更新时间             | 真实字段、精度、是否有索引、同时间戳排序键             |

优先关联假设：

```text
STUDYINFO.ST_ACCNUM = REPORTINFO.ST_ACCNUM = REPORTCONTENT.ST_ACCNUM
STUDYINFO.PAT_ID = PATIENTINFO.PAT_ID
REPORTCONTENT.REPORT_ID = REPORTINFO.REPORT_ID
STUDYINFO.LOC_ID = LOC.LOC_ID
```

如果真实关系不同，应更新适配层和 OpenAPI 实现说明，不能在接口输出中隐式
丢弃无法关联的报告。

## 4. 通用约定

### 4.1 地址与传输

- 测试环境 Base URL 示例：`https://<internal-host>/api/v1/endoscopy`。
- 只允许医院内网或批准的网络区访问。
- 使用 HTTPS 或医院批准的等效安全传输。
- Base URL、Token、账号和数据库连接信息通过安全渠道提供，不写入仓库。

### 4.2 服务认证

请求使用服务身份 Token：

```http
Authorization: Bearer <service-token>
X-Request-Id: 018f-example-request-id
```

- 缺少或无效认证返回 `401`。
- 身份有效但无该资源权限返回 `403`。
- Token 不得放在 URL、日志、Issue、PR 或测试截图中。

### 4.3 时间

- 请求和响应时间均使用 RFC 3339。
- 网关统一返回 UTC `Z` 时间，例如 `2026-08-21T02:05:00Z`。
- `updatedFrom` 为包含下限；`updatedTo` 为不包含上限，即
  `[updatedFrom, updatedTo)`。
- 数据库源时区及转 UTC 规则必须写入核验记录。

### 4.4 响应包装

成功响应：

```json
{
  "requestId": "018f-example-request-id",
  "serverTime": "2026-08-21T02:06:00Z",
  "data": {}
}
```

失败响应：

```json
{
  "requestId": "018f-example-request-id",
  "code": "INVALID_ARGUMENT",
  "message": "updatedFrom must be a valid RFC 3339 timestamp"
}
```

错误不得返回 SQL、表名、连接地址、账号、堆栈或报告正文。

## 5. 接口一：增量读取内镜报告

```http
GET /api/v1/endoscopy/reports
```

### 查询参数

| 参数          | 类型      | 必填 | 规则                                             |
| ------------- | --------- | ---- | ------------------------------------------------ |
| `updatedFrom` | date-time | 是   | 源记录更新时间包含下限，禁止省略                 |
| `updatedTo`   | date-time | 否   | 不包含上限；省略时由服务端固定为本次请求开始时间 |
| `department`  | string    | 否   | 精确匹配标准化科室名称或 ID，具体方式联调确认    |
| `deviceId`    | string    | 否   | 源系统可提供设备标识时使用                       |
| `cursor`      | string    | 否   | 上一页返回的不透明游标，客户端不得解析或修改     |
| `pageSize`    | integer   | 否   | 默认 200，范围 1–500                             |

### 排序与游标

- 使用 `(sourceUpdatedAt, reportId)` 或经数据库核验的等价稳定复合键做
  keyset pagination。
- 排序固定为 `sourceUpdatedAt ASC, reportId ASC`。
- `nextCursor` 非空表示仍有下一页；为空表示当前固定时间窗口读取完成。
- 使用游标续页时，除 `cursor` 外的所有过滤条件必须与第一页一致。
- 同一窗口和游标重复请求应返回相同顺序，不得漏读；消费方会自行幂等去重。

### 请求示例

```bash
curl --request GET \
  --url 'https://<internal-host>/api/v1/endoscopy/reports?updatedFrom=2026-08-21T00%3A00%3A00Z&updatedTo=2026-08-22T00%3A00%3A00Z&pageSize=200' \
  --header 'Authorization: Bearer <service-token>' \
  --header 'X-Request-Id: 018f-example-request-id'
```

### 响应示例（全部为虚构数据）

```json
{
  "requestId": "018f-example-request-id",
  "serverTime": "2026-08-21T02:06:00Z",
  "data": {
    "items": [
      {
        "patientId": "TEST-P-0001",
        "inpatientNo": "TEST-I-0001",
        "patientName": "测试患者甲",
        "sex": "F",
        "age": 62,
        "department": "测试科室",
        "bedNo": "TEST-12",
        "studyAccessionNo": "TEST-A-20260821001",
        "examItem": "电子胃镜检查",
        "examTime": "2026-08-21T01:30:00Z",
        "reportId": "TEST-R-0001",
        "reportStatus": "PENDING_REVIEW",
        "rawStatusCode": "SUBMITTED",
        "reportSavedAt": "2026-08-21T01:55:00Z",
        "reportSubmittedAt": "2026-08-21T02:00:00Z",
        "reportReviewedAt": null,
        "describeText": "测试检查所见文本，仅为合成数据。",
        "diagnoseText": "测试诊断意见文本，仅为合成数据。",
        "sourceUpdatedAt": "2026-08-21T02:00:05Z"
      }
    ],
    "nextCursor": "opaque-cursor-value",
    "hasMore": true
  }
}
```

## 6. 接口二：查询单份报告

```http
GET /api/v1/endoscopy/reports/{reportId}
```

- `reportId` 必须 URL 编码，且以生产核验确认的报告版本唯一键为准。
- 成功时 `data` 为完整 `PacsReport`；不存在时返回 `404 REPORT_NOT_FOUND`。
- 同一检查的不同报告版本必须使用不同 `reportId` 返回，不得静默覆盖。
- 该接口用于补查与联调，不替代增量接口。

```bash
curl --request GET \
  --url 'https://<internal-host>/api/v1/endoscopy/reports/TEST-R-0001' \
  --header 'Authorization: Bearer <service-token>'
```

## 7. 接口三：获取科室字典

```http
GET /api/v1/endoscopy/departments
```

响应中的科室必须使用报告记录实际关联的标准化来源：

```json
{
  "requestId": "018f-example-request-id",
  "serverTime": "2026-08-21T02:06:00Z",
  "data": {
    "items": [
      {
        "id": "TEST-D-01",
        "name": "测试科室",
        "active": true
      }
    ]
  }
}
```

如果数据库只能提供科室名称，应与 EPGS 联调确认稳定 ID 的生成或映射方式，
不得每次请求生成不同 ID。

## 8. 接口四：健康检查

```http
GET /api/v1/endoscopy/health
```

健康检查供 EPGS 判断数据延迟和连接状态，不返回数据库产品、地址、库名、账号
或异常堆栈。

```json
{
  "requestId": "018f-example-request-id",
  "serverTime": "2026-08-21T02:06:00Z",
  "data": {
    "status": "UP",
    "database": "UP",
    "schemaVerifiedAt": "2026-08-21T00:00:00Z",
    "lastSuccessfulQueryAt": "2026-08-21T02:05:58Z"
  }
}
```

状态值：

- `UP`：API 和数据库正常。
- `DEGRADED`：可服务但延迟、部分映射未知或核验未完成。
- `DOWN`：数据库不可访问或核心查询失败；HTTP 返回 `503`。

## 9. 报告字段定义

| 字段                | 类型/可空      | 来源与说明                           |
| ------------------- | -------------- | ------------------------------------ |
| `patientId`         | string         | 患者稳定内部 ID；不得使用姓名代替    |
| `inpatientNo`       | string/null    | 住院号；门诊或缺失时可空             |
| `patientName`       | string         | 源系统姓名原值，仅授权服务可见       |
| `sex`               | `M/F/UNKNOWN`  | 未识别值统一为 `UNKNOWN`             |
| `age`               | integer/null   | 检查时源系统记录年龄，不重新推断     |
| `department`        | string/null    | 住院科室或经业务确认的权威科室名称   |
| `bedNo`             | string/null    | 住院床号                             |
| `studyAccessionNo`  | string         | 检查号；不得单独假设为跨院区全局唯一 |
| `examItem`          | string         | 检查项目名称                         |
| `examTime`          | date-time      | 检查时间，UTC                        |
| `reportId`          | string         | 报告版本稳定唯一键                   |
| `reportStatus`      | enum           | 标准化报告流程状态                   |
| `rawStatusCode`     | string/null    | 源状态原值，供未知映射排查           |
| `reportSavedAt`     | date-time/null | 报告首次保存时间                     |
| `reportSubmittedAt` | date-time/null | 提交审核时间                         |
| `reportReviewedAt`  | date-time/null | 审核/签署时间                        |
| `describeText`      | string/null    | 检查所见原文，不清洗、不改写         |
| `diagnoseText`      | string/null    | 诊断意见原文，不清洗、不改写         |
| `sourceUpdatedAt`   | date-time      | 增量读取的权威更新时间，UTC          |

标准状态：

| 状态               | 含义                             |
| ------------------ | -------------------------------- |
| `EXAM_IN_PROGRESS` | 检查进行中，尚无完整报告         |
| `AWAITING_REPORT`  | 检查完成，等待报告               |
| `DRAFT`            | 已保存初步报告，未提交审核       |
| `PENDING_REVIEW`   | 已提交，等待审核                 |
| `REVIEWED`         | 已完成一级审核，但不一定终审     |
| `FINAL_REVIEWED`   | 已完成最终审核/签署              |
| `UNKNOWN`          | 无法识别源状态，绝不能当作已审核 |

`DRAFT`、`PENDING_REVIEW`、`REVIEWED` 等非最终状态可以用于监测，但 EPGS
必须显示“仅用于监测，不作为正式诊断”。网关不得自行修改报告文字。

## 10. 错误码

| HTTP | code                      | 场景                                               |
| ---- | ------------------------- | -------------------------------------------------- |
| 400  | `INVALID_ARGUMENT`        | 时间、页大小、游标或路径参数非法                   |
| 401  | `UNAUTHENTICATED`         | 缺失或无效服务身份                                 |
| 403  | `FORBIDDEN`               | 调用方无接口或数据范围权限                         |
| 404  | `REPORT_NOT_FOUND`        | 报告不存在                                         |
| 409  | `CURSOR_FILTER_MISMATCH`  | 游标与第一页过滤条件不一致（若服务绑定游标上下文） |
| 429  | `RATE_LIMITED`            | 调用超过约定限制                                   |
| 500  | `INTERNAL_ERROR`          | 未预期内部错误，响应必须脱敏                       |
| 503  | `DATA_SOURCE_UNAVAILABLE` | PACS/RIS 数据库不可用或超时                        |

## 11. 性能与安全验收

- 所有 SQL 参数化，禁止拼接参数值。
- 每次报告列表查询必须有更新时间下限和最大 500 条限制。
- 一天数据量下记录真实执行计划、扫描行数、P50/P95 和资源占用。
- 单页 200 条目标响应时间不超过 3 秒；若未达到，提交查询计划和优化方案。
- 对数据库超时使用有限重试；不得因重试造成无界并发。
- 生产日志不出现患者姓名、住院号、报告原文、Token、连接串和 SQL 参数值。
- 只读账号仅对核验所需表/视图授予 `SELECT`，不授予 DML/DDL 权限。
- 测试、文档和截图全部使用合成患者数据。

## 12. 联调交付清单

后端开发人员完成后应在 Issue #20 / PR 中提供：

- [ ] 数据库核验表的实际结论和仍未解决的问题。
- [ ] 测试环境 Base URL 与服务身份申请方式（通过安全渠道）。
- [ ] OpenAPI/Swagger 或 Apifox/Postman 可导入文件。
- [ ] 四个接口的合成数据请求/响应示例。
- [ ] 两页以上增量分页测试证据，无重复、无漏读。
- [ ] 新增或修改测试报告后的增量读取证据。
- [ ] 未知状态、多版本、空报告和同时间戳记录测试结果。
- [ ] 一天数据量性能测试与执行计划结论。
- [ ] 鉴权、SQL 注入防护、错误脱敏和日志敏感信息扫描结果。
- [ ] 部署、配置、监控和回滚说明。

以上交付完成后，EPGS Worker 才能开始真实数据联调。未完成数据库核验时，
接口必须保持在测试环境，不得宣称生产可用。

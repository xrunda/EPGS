# IRIS/Caché 内镜数据 API 契约

> 对应实现：Issue #24
>
> 产品范围：Issue #27
>
> OpenAPI：[`pacs-ris-data-api.openapi.yaml`](./pacs-ris-data-api.openapi.yaml)

## 1. 接口边界

该接口由医院数据库网关提供给 EPGS Worker，只读访问
`Ens_RISReportResult`、`PA_Adm` 和 `PA_PatMas`。浏览器不得直接调用。

网关只返回源数据，不返回关注等级、命中关键词和任何上报/处置状态。

## 2. 通用约定

- Base URL：`https://<internal-host>/api/v1/endoscopy`。
- 使用医院内网 HTTPS 和服务身份 Bearer Token。
- 请求可携带 `X-Request-Id`；响应必须返回同一 ID 或服务端生成值。
- 成功响应包含 `requestId`、`serverTime`、`data`。
- 错误响应包含 `requestId`、`code`、`message`，不返回 SQL、堆栈和连接信息。
- 所有示例均为合成数据。

## 3. 增量/窗口读取

```http
GET /api/v1/endoscopy/reports
```

| 参数          | 类型    | 必填 | 说明                                   |
| ------------- | ------- | ---- | -------------------------------------- |
| `dateFrom`    | date    | 是   | 检查日期开始值                         |
| `dateTo`      | date    | 是   | 检查日期结束值；边界语义由实库测试固定 |
| `department`  | string  | 否   | 科室精确筛选                           |
| `patientType` | string  | 否   | `PAADM_Type` 源代码                    |
| `examItem`    | string  | 否   | 检查项目                               |
| `cursor`      | string  | 否   | 不透明续页游标                         |
| `pageSize`    | integer | 否   | 默认 200，范围 1–500                   |

固定排序为检查日期、检查时间、检查号升序。`RISR_ExamID` 已正式确定为
`sourceRecordId`；若源库无更新时间，EPGS 重复读取日期窗口并按该字段去重。

响应示例：

```json
{
  "requestId": "synthetic-request-id",
  "serverTime": "2026-08-21T06:00:00Z",
  "data": {
    "items": [
      {
        "sourceRecordId": "TEST-RIS-0001",
        "patientRegistrationNo": "TEST-REG-0001",
        "patientName": "测试患者甲",
        "department": "测试科室",
        "bedNo": "TEST-12",
        "patientTypeCode": "I",
        "patientTypeName": "住院",
        "examItem": "电子胃镜检查",
        "examDate": "2026-08-21",
        "examTime": "10:05:30",
        "reportContent": "测试报告内容，仅为合成数据。",
        "diagnosis": "测试诊断，仅为合成数据。"
      }
    ],
    "nextCursor": "opaque-cursor-value",
    "hasMore": true
  }
}
```

## 4. 单条详情

```http
GET /api/v1/endoscopy/reports/{sourceRecordId}
```

- 返回与列表数据项相同的源字段。
- `sourceRecordId` 对应 `RISR_ExamID`（检查号）。
- 不存在返回 `404 REPORT_NOT_FOUND`。
- 不提供任何 POST、PUT、PATCH、DELETE 动作。

## 5. 科室字典

```http
GET /api/v1/endoscopy/departments
```

从 `PAADM_DepCode_DR->CTLOC_Desc` 的权威来源返回稳定科室 ID、名称和启用状态。
如果只能取得名称，应与医院确认稳定 ID 映射，不得每次随机生成。

## 6. 健康检查

```http
GET /api/v1/endoscopy/health
```

返回网关状态、数据库状态、字段核验时间和最近成功查询时间，不泄露数据库类型、
地址、库名、账号、SQL 或堆栈。

## 7. 字段定义

| 字段                    | 类型/可空   | 来源                                       |
| ----------------------- | ----------- | ------------------------------------------ |
| `sourceRecordId`        | string      | `RISR_ExamID` 检查号                       |
| `patientRegistrationNo` | string/null | `PAPMI_No` 登记号                          |
| `patientName`           | string/null | `PAPMI_Name`                               |
| `department`            | string/null | `PAADM_DepCode_DR->CTLOC_Desc`             |
| `bedNo`                 | string/null | `PAADM_CurrentBed_DR->BED_Code`            |
| `patientTypeCode`       | string/null | `PAADM_Type` 原值                          |
| `patientTypeName`       | string/null | 字典确认前为 null，不根据 I/O 猜测中文含义 |
| `examItem`              | string/null | `RISR_ItemDesc`                            |
| `examDate`              | date        | `RISR_ReportDate`                          |
| `examTime`              | time/null   | `RISR_ReportTime`                          |
| `reportContent`         | string/null | `RISR_ExamDesc` 原文                       |
| `diagnosis`             | string/null | `RISR_DiagDesc` 原文                       |

患者类型截图中出现的 `I`、`O` 不能仅凭经验认定，必须以医院字典核验结果为准。

## 8. 错误码

| HTTP | code                      | 场景                             |
| ---: | ------------------------- | -------------------------------- |
|  400 | `INVALID_ARGUMENT`        | 日期、游标、页大小或路径参数非法 |
|  401 | `UNAUTHENTICATED`         | 服务身份缺失或无效               |
|  403 | `FORBIDDEN`               | 无调用或数据范围权限             |
|  404 | `REPORT_NOT_FOUND`        | 记录不存在                       |
|  409 | `CURSOR_FILTER_MISMATCH`  | 游标与第一页筛选条件不一致       |
|  429 | `RATE_LIMITED`            | 超过调用限制                     |
|  500 | `INTERNAL_ERROR`          | 已脱敏的内部错误                 |
|  503 | `DATA_SOURCE_UNAVAILABLE` | IRIS/Caché 不可用或超时          |

## 9. 明确移除的旧契约字段

以下字段不再出现在本接口：

- `patientId`、`inpatientNo`、`sex`、`age`。
- `studyAccessionNo`、`deviceId`。
- `reportStatus`、`rawStatusCode`。
- `reportSavedAt`、`reportSubmittedAt`、`reportReviewedAt`、`sourceUpdatedAt`。
- `monitorLevel`、`matchedKeywords`、`handlingStatus` 及所有上报字段。

关注等级和命中关键词由 EPGS 内部 API 提供；数据库网关不负责。

## 10. 后端联调交付

- 患者类型字典、日期/时间语义及报告修改时间核验结果。
- 参数化查询实现和只读账号权限证明。
- 两页以上窗口分页测试，无重复、无漏读。
- 空科室、空床号、空诊断和同时间多记录测试。
- OpenAPI/契约测试、性能结果、敏感日志扫描和部署说明。
- 截图中暴露的数据库凭据已经轮换。

# 内镜数据源适配说明

> 实现范围：Issue #38
>
> REST 契约：[`api/pacs-ris-data-api.md`](api/pacs-ris-data-api.md)

## 1. 边界

EPGS 不直接连接医院 IRIS/Caché 数据库。医院在内网单独部署只读数据
网关，由网关读取 `Ens_RISReportResult`、`PA_Adm`、`PA_PatMas`，再通过
REST API 向 EPGS Worker 提供数据。

```text
生产：IRIS/Caché → 医院只读网关（仓库外） → HttpPacsRisAdapter → 同步与匹配
本地：API 字段 CSV → CsvPacsRisAdapter ─────────→ 同步与匹配
```

本仓库不包含数据库驱动、SQL 执行器、源库账号或连接参数。

## 2. 运行模式

### 2.1 本地 CSV

```env
PACS_ADAPTER_MODE=csv
PACS_MOCK_CSV_PATH=../../Doc/moke-data.utf8.csv
```

CSV 为 UTF-8，表头必须与最终 REST API 字段同名：

```text
sourceRecordId,patientRegistrationNo,patientName,department,bedNo,
patientTypeCode,patientTypeName,examItem,examDate,examTime,
reportContent,diagnosis
```

适配器支持 BOM、引号内逗号/换行、中文和空值。每行都使用 HTTP 适配器相同的
`mapWireReportToDto` 校验；缺列、重复 `sourceRecordId`、非法日期/时间会直接失败。
错误只记录行号和字段契约，不记录姓名、报告正文或诊断。

仓库中的 `reports.fixture.csv` 仅含合成数据，用于自动化测试。
`Doc/moke-*.csv`（医院原始导出与本地转换产物）默认被 Git 忽略，在确认完全脱敏前
不得提交。

#### 医院导出 mock 数据的本地转换（issue #42）

医院提供的内镜导出文件通常不满足上述契约：

- **编码**：GB18030/GBK（适配器要求 UTF-8）。
- **表头**：11 个中文字段（`检查号,登记号,姓名,科室,床号,类型,检查项目,检查日期,
检查时间,报告内容,诊断`），而非 12 个英文 wire 名。
- **日期/时间**：如 `2026-8-2 0:00` / `8:48:08`（月、日、时不补零，日期列还嵌入
  Excel 的 `0:00`）。
- **文件名**：实际导出名用 U+2011 非断行连字符 `moke‑data.csv`，与文档的 ASCII
  连字符不同。

`apps/worker` 提供转换入口，把医院原始导出转成适配器契约一致的 UTF-8 + 英文表头
CSV（输出到上述 `PACS_MOCK_CSV_PATH` 默认路径），并在写盘前用适配器同款
`parseCsvReports` 做全量校验：

```bash
pnpm --filter worker run mock:convert
# 可选显式路径（相对 apps/worker 的 cwd，与 PACS_MOCK_CSV_PATH 的约定一致）：
#   pnpm --filter worker run mock:convert --input ../../Doc/moke‑data.csv --output ../../Doc/moke-data.utf8.csv
```

转换逻辑：GB18030→UTF-8、11 中文字段→12 英文 wire 名（`类型` 的 I/O 按
`docs/acceptance.md` 字典派生出 `patientTypeName`：I→住院、O→门诊）、日期去 `0:00`
并补零、时间补零。转换后按文档默认配置即可 `pnpm dev`。

**注意同步窗口**：首次同步只回看 `SYNC_FIRST_RUN_LOOKBACK_MINUTES`（默认 1440 分钟
= 24 小时）。若 mock 数据的检查日期早于该窗口（如导出的检查日期是几周前），首次
`pnpm dev` 会看到 `fetched 0 report(s)` —— 属正常行为，把该变量调大以覆盖检查日期
即可（例如覆盖一个月：`SYNC_FIRST_RUN_LOOKBACK_MINUTES=43200`）。

**安全约束**：原始文件与转换产物都含疑似真实患者数据，脚本只报告行数、绝不打印
行内容；两者均被 `Doc/moke-*` 忽略，未完成脱敏评审前不得提交（`git ls-files`
应无 `Doc/moke`）。

### 2.2 生产 REST

```env
PACS_ADAPTER_MODE=http
PACS_HTTP_BASE_URL=https://<internal-host>/api/v1/endoscopy
PACS_HTTP_SERVICE_TOKEN=<secret-manager-injected-token>
PACS_HTTP_TIMEOUT_MS=10000
```

Worker 按现有 1–5 分钟周期调用 `GET /reports`，使用 Bearer Token、超时、指数退避和
不透明游标分页。`401/403/400/404` 为不可重试错误；`429/503/5xx` 和网络超时为
可重试错误。Token、响应正文和患者字段不进入日志。

## 3. 统一字段映射

| API/CSV 字段                          | 用途                  | 可空 |
| ------------------------------------- | --------------------- | ---- |
| `sourceRecordId`                      | 检查号、稳定去重键    | 否   |
| `patientRegistrationNo`               | 登记号                | 是   |
| `patientName`                         | 姓名展示              | 是   |
| `department`                          | 科室展示/筛选         | 是   |
| `bedNo`                               | 床号                  | 是   |
| `patientTypeCode` / `patientTypeName` | 患者类型              | 是   |
| `examItem`                            | 检查项目              | 是   |
| `examDate`                            | `YYYY-MM-DD`          | 否   |
| `examTime`                            | `HH:mm:ss[.fraction]` | 是   |
| `reportContent` / `diagnosis`         | 只读展示与关键词匹配  | 是   |

上述字段的源库取数语句（医院提供，含 `->` 关系取值语法与 `RISR_SysCode` 过滤条件）
见 [pacs-ris-source-sql.md](./pacs-ris-source-sql.md)。

`reportId` 在 EPGS 内部由 `sourceRecordId` 派生；在尚无可靠修改时间时，
`sourceUpdatedAt` 由检查日期时间派生，Worker 重复读取日期窗口并幂等 upsert。

## 4. 上线检查

1. 生产环境必须为 `PACS_ADAPTER_MODE=http`。
2. Base URL 和 Token 通过医院密钥系统注入，不写入文件或镜像。
3. 网关的 OpenAPI、日期边界、分页、错误码和健康检查通过联调。
4. 连续两次同步无重复记录，故障后游标不丢失。
5. 仓库、镜像和日志扫描不得出现真实患者数据、数据库凭据或服务 Token。

## 5. 明确不实现

- 数据库直连、SQL 适配器或数据库账号配置。
- 从浏览器直接调用医院网关。
- 向 IRIS/Caché、HIS、PACS/RIS 写回任何数据。
- 在网关中计算红黄绿等级、命中关键词或上报/处置状态。

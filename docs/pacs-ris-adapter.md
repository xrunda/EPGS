# IRIS/Caché 内镜结果只读适配说明

> 需求修订：Issue #24、#27
>
> 本文替代 #2 中基于 SQL Server 和通用 PACS 表结构的假设。旧实现保留 Git 历史，不再作为真实数据库依据。

## 1. 已确认数据源

医院提供的可运行查询表明，内镜检查结果来自 InterSystems IRIS/Caché 数据库：

- `Ens_RISReportResult`：检查结果、报告内容和诊断。
- `PA_Adm`：就诊科室、当前床号和患者类型。
- `PA_PatMas`：患者姓名。
- `RISR_SysCode = 'ES'`：内镜系统数据范围。

IRIS/Caché SQL 使用对象引用箭头语法，例如：

- `pa.PAADM_DepCode_DR->CTLOC_Desc`
- `pa.PAADM_CurrentBed_DR->BED_Code`

不得继续使用 `PATIENTINFO`、`STUDYINFO`、`REPORTINFO`、`REPORTCONTENT`、
`LOC` 或 SQL Server `TOP (@n)` 作为医院真实库的实现依据。

## 2. 医院已验证的查询结构

下面仅保留字段结构，日期和系统代码必须由数据库驱动参数绑定。示例不含任何
数据库地址、账号或密码。

```sql
SELECT
  pp.PAPMI_Name AS PatientName,
  pa.PAADM_DepCode_DR->CTLOC_Desc AS Department,
  pa.PAADM_CurrentBed_DR->BED_Code AS BedNo,
  pa.PAADM_Type AS PatientType,
  a.RISR_ItemDesc AS ExamItem,
  a.RISR_ReportDate AS ExamDate,
  a.RISR_ReportTime AS ExamTime,
  a.RISR_ExamDesc AS ReportContent,
  a.RISR_DiagDesc AS Diagnosis
FROM Ens_RISReportResult a
LEFT JOIN PA_Adm pa ON pa.PAADM_RowID = a.RISR_VisitNumber
LEFT JOIN PA_PatMas pp ON a.RISR_PatientID = pp.PAPMI_RowId1
WHERE a.RISR_ReportDate BETWEEN ? AND ?
  AND a.RISR_SysCode = ?
```

生产实现不得把日期或 `ES` 直接拼接到 SQL 字符串；必须使用 IRIS 驱动支持的
参数绑定。日期边界采用 `BETWEEN` 还是 `[from, to)` 需要结合字段类型验证后
固定，并通过跨日测试证明无重复、无漏读。

## 3. 已确认字段映射

| 标准字段          | 实际表达式                         | 页面用途             | 可空       |
| ----------------- | ---------------------------------- | -------------------- | ---------- |
| `patientName`     | `pp.PAPMI_Name`                    | 姓名                 | 待实库统计 |
| `department`      | `pa.PAADM_DepCode_DR->CTLOC_Desc`  | 科室、筛选           | 是         |
| `bedNo`           | `pa.PAADM_CurrentBed_DR->BED_Code` | 床号                 | 是         |
| `patientTypeCode` | `pa.PAADM_Type`                    | 类型、筛选           | 待实库统计 |
| `examItem`        | `a.RISR_ItemDesc`                  | 检查项目、筛选       | 待实库统计 |
| `examDate`        | `a.RISR_ReportDate`                | 检查日期、日期筛选   | 否         |
| `examTime`        | `a.RISR_ReportTime`                | 检查时间             | 待实库统计 |
| `reportContent`   | `a.RISR_ExamDesc`                  | 报告内容、关键词匹配 | 是         |
| `diagnosis`       | `a.RISR_DiagDesc`                  | 诊断、关键词匹配     | 是         |

页面和 API 暂不依赖以下旧字段，因为当前查询没有提供可靠来源：

- 住院号、患者 ID 展示值、性别、年龄。
- 报告审核状态、原始状态码。
- 报告保存、提交、审核和最后更新时间。
- 报告版本号、检查号和设备号。
- 上报状态及任何处置时间。

未来如能稳定读取，应通过独立 Issue 增加，不得在当前实现中猜测或填充假值。

## 4. 上线前必须确认

### 4.1 稳定源记录 ID

当前 SELECT 没有返回 `Ens_RISReportResult` 的稳定主键。后端必须确认实际的
行 ID/报告 ID 表达式，并通过 API 返回为 `sourceRecordId`。

- 禁止用姓名、日期、科室、床号或报告正文拼接永久主键。
- `RISR_VisitNumber` 和 `RISR_PatientID` 可作为关联和排查字段，但不能未经
  验证就当作报告唯一 ID。
- 在稳定 ID 未确认前，只能进行人工查询验证，不得上线自动同步。

### 4.2 增量更新策略

当前只有报告日期和时间，没有确认“最后修改时间”。按以下顺序选择：

1. 最优：找到可靠最后更新时间，使用 `(updatedAt, sourceRecordId)` 游标。
2. 可接受：每次重复扫描可配置日期窗口，按 `sourceRecordId` upsert，并以
   报告内容/诊断指纹识别修改。
3. 不允许：仅记住上次最大检查时间，因同时间新增或历史报告修改会漏数。

### 4.3 患者类型字典

截图可见 `I`、`O` 等值，但必须查询实际值全集并由医院确认含义。API 同时返回：

- `patientTypeCode`：源值。
- `patientTypeName`：经确认的中文名称；未知代码使用“未知（原值）”，不能猜测。

### 4.4 日期、时间与时区

确认 `RISR_ReportDate`、`RISR_ReportTime` 的真实类型、精度和数据库会话时区。
API 分别保留 `examDate` 和 `examTime`，并可在服务端组合为排序值，但不得将
未知时区擅自标记为 UTC。

## 5. 只读与安全边界

- 使用专用账号，仅授予三张表/视图及必要对象引用的 `SELECT` 权限。
- 不授予 INSERT、UPDATE、DELETE 或 DDL 权限。
- 连接信息只通过环境变量或医院密钥系统注入。
- 截图中已暴露的凭据必须在联调前轮换；旧凭据不得继续使用。
- 日志不记录姓名、床号、报告内容、诊断、SQL 参数或连接信息。
- fixture、测试和文档只使用合成数据。

## 6. 与产品范围的关系

适配器只返回源数据。关键词引擎使用 `reportContent` 和 `diagnosis` 计算关注
等级；红色、黄色、绿色只用于页面颜色、排序和筛选。

项目已取消以下全部功能：

- 待上报、已上报、已知晓、已处理、误报。
- 上报按钮、处置按钮、上报时间线。
- 日报和实时推送。

这些字段不得从适配器、业务库或 API 中重新引入。

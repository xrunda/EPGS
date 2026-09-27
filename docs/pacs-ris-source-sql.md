# 内镜数据源取数语句（医院提供）

> 来源：医院信息科提供的源库查询语句。
> 用途：记录 `Ens_RISReportResult` / `PA_Adm` / `PA_PatMas` 三张表的关联方式与字段出处，
> 是 [pacs-ris-adapter.md](./pacs-ris-adapter.md) §3 统一字段映射的原始凭据。
> 关联：数据网关读取的正是这三张表（见 [pacs-ris-adapter.md](./pacs-ris-adapter.md) §1）。

有关本仓库与源库的边界（EPGS **不直接连接**医院 IRIS/Caché，仓库内不含驱动、SQL 执行器、
源库账号或连接参数），见 [pacs-ris-adapter.md](./pacs-ris-adapter.md) §1。

## 1. 语句原文

```sql
SELECT a.RISR_ExamID AS 检查号, pp.PAPMI_No AS 登记号,pp.PAPMI_Name AS 姓名,pa.PAADM_DepCode_DR->CTLOC_Desc AS 科室,pa.PAADM_CurrentBed_DR->BED_Code AS 床号, pa.PAADM_Type AS 类型,
a.RISR_ItemDesc AS 检查项目,a.RISR_ReportDate As 检查日期, a.RISR_ReportTime AS 检查时间,a.RISR_ExamDesc AS 报告内容,a.RISR_DiagDesc AS 诊断
FROM Ens_RISReportResult a
LEFT JOIN PA_Adm pa ON pa.PAADM_RowID=a.RISR_VisitNumber
LEFT JOIN PA_PatMas pp ON a.RISR_PatientID=pp.PAPMI_RowId1
WHERE a.RISR_ReportDate BETWEEN "2026-08-02" AND "2026-08-03" AND RISR_SysCode="ES"
```

## 2. 读这段语句时需要注意的点

- **`AS` 后面是中文别名**，它同时就是医院导出 CSV 的表头。本地转换脚本
  （[pacs-ris-adapter.md](./pacs-ris-adapter.md) §2.1）处理的 11 个中文字段
  `检查号,登记号,姓名,科室,床号,类型,检查项目,检查日期,检查时间,报告内容,诊断`
  与本语句的别名逐一对应——**改这条语句就会改导出表头**，转换脚本要同步跟进。
- **`->` 是源库的关系字段取值语法**（`PAADM_DepCode_DR->CTLOC_Desc`、
  `PAADM_CurrentBed_DR->BED_Code`），不是标准 SQL。这是源系统的取值方式，
  不要在改写时"纠正"成普通 JOIN。
- **日期区间是一个示例值**（`2026-08-02` ~ `2026-08-03`），实际取数时由网关按同步窗口
  自行替换。除代码块内的行尾空白外，上方语句与医院提供的原文**逐字一致**，便于日后
  核对语句是否被改动过。
- **`RISR_SysCode="ES"` 是内镜系统的过滤条件**，去掉会把其他系统的检查一并取出。
- **三表全部是 `LEFT JOIN`**：`PA_Adm` 缺行时科室/床号为空，`PA_PatMas` 缺行时
  登记号/姓名为空。适配器契约要求这些字段可用，因此网关侧是否有补默认值的逻辑，
  联调时需要确认。

## 3. 语句里未出现的字段

适配器契约里的 `patientTypeName`（患者类型中文名）**不在本语句的选取列内**——
本语句只取 `PAADM_Type` 原始代码。代码到中文名的映射由 EPGS 侧的字典完成，
见 [data-dictionary.md](./data-dictionary.md) 的 `monitor_record` 一节（`patientTypeCode`
与 `patientTypeName` 两行）及 [acceptance.md](./acceptance.md) §三。

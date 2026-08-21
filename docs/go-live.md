# EPGS 上线检查清单与回滚 runbook（issue #14 / epic #15）

本清单是把 issue #14 验收标准第 6 条（"上线清单包含凭据轮换、只读账号、网络白名单、
备份和监控"）与 epic #15 生产前门禁落成可勾选的检查项。**每项均有负责人 + 证据**；
无法勾选前不得上线。

配套文档：验收映射见 [docs/acceptance.md](./acceptance.md)；字段/主键/敏感级别见
[docs/data-dictionary.md](./data-dictionary.md)；权限与账号操作见
[docs/auth.md](./auth.md)；源适配与部署模式见 [docs/pacs-ris-adapter.md](./pacs-ris-adapter.md)。

---

## 0. 上线范围与确认门

- [ ] **数据范围确认**：内镜中心/信息科确认 `monitor_record` 快照字段范围
      （[docs/acceptance.md](./acceptance.md) §三 九字段）与保留周期
      （[docs/data-dictionary.md](./data-dictionary.md) §待确认事项）。
- [ ] **日志保留确认**：`sync_job_log` 保留 ≥ 6 个月，`audit_log` 与命中证据
      （`monitor_match`）保留策略已与运维确认。
- [ ] **患者类型字典确认**：`PAADM_Type` 完整字典由内镜中心确认；未确认的代码
      一律存 NULL（[docs/acceptance.md](./acceptance.md) §三）。
- [ ] **词库确认**：黄/绿关键词清单由内镜中心签核后由 `RULE_ADMIN` 导入
      （种子脚本有意只内置 6 条 RED，见 issue #4 / [docs/rules-api.md](./rules-api.md)）。

## 1. 凭据轮换

- [ ] **仓库无明文凭据**：全库扫描确认无真实患者数据、数据库连接串、密码、Token。
      CI 门禁：[apps/api/src/security/log-sanitization.spec.ts](../apps/api/src/security/log-sanitization.spec.ts)。
- [ ] **`JWT_SECRET` 重新生成**（≥32 随机字符，每套环境独立，禁止复用开发值）：
  ```bash
  openssl rand -base64 48
  ```
  通过虚拟机环境文件或密钥管理注入，**不写入文件或镜像**。
- [ ] **数据库密码重新生成**：生产库不用 `docker-compose.yml` 的 `epgs/epgs`
      默认值；通过密钥管理注入。
- [ ] **PACS/RIS 服务 Token** 通过医院密钥系统注入
      （`PACS_HTTP_SERVICE_TOKEN`，见 [docs/pacs-ris-adapter.md](./pacs-ris-adapter.md) §4）。

## 2. 数据库：只读/最小权限账号

- [ ] **运行账号最小权限**：API/Worker 的连接账号只授予应用需要的库级别权限，
      不使用超级用户。
- [ ] **工作台"只读展示"语义复核**：业务层面 API 本身无写接口（除
      `RULE_ADMIN` 的规则管理）；DB 账号层面按"能跑 Prisma 迁移的账号"与"应用运行
      账号"分离——**迁移只在发布窗口用迁移账号执行**，运行账号不得持有 DDL 权限。
- [ ] 生产库 `TZ=Asia/Shanghai`（与 docker-compose 一致），跨日筛选边界依赖
      该时区（[docs/acceptance.md](./acceptance.md) 场景 5）。

## 3. 网络白名单

- [ ] API/前端/数据库均在**内网**，`WEB_ORIGIN` 精确匹配前端源
      （[docs/auth.md](./auth.md) §部署配置）。
- [ ] Worker 仅能访问医院网关白名单地址 + API 需要的内部服务；对外仅暴露
      API（`/health` + `/api/*`），前端静态资源按内网策略放行。
- [ ] 浏览器不直接调用医院网关（[docs/pacs-ris-adapter.md](./pacs-ris-adapter.md) §5）。

## 4. 备份与恢复演练

- [ ] **每日备份**：生产库每日定时 `pg_dump`（或运维既有备份方案），备份异地/异盘。
- [ ] **恢复演练**：上线前在暂存环境完成一次**从备份恢复到空实例**的演练，记录
      演练时间与恢复点目标（RPO/RTO），证据存档。
- [ ] 备份/恢复方案与 `monitor_record` 保留周期一并确认（见 §0）。

## 5. 监控与告警

- [ ] **同步健康巡检**：定时检查 `sync_job_log` 最近一次运行状态，`status != SUCCEEDED`
      或窗口晚于预期即告警（`GET /api/system/sync-status` 可作对账端点）。
- [ ] **失败告警**：`sync_job_log` 出现 `FAILED` / `PARTIAL`、或连续 N 次同步
      无进展时通知运维。
- [ ] **日志保留 ≥ 6 个月**：API 结构化日志与审计日志的保留策略落地并抽查。
- [ ] **性能阈值告警**：`GET /api/monitor/exams` 常见筛选 p95 超过 3s 告警
      （验收基准见 [docs/acceptance.md](./acceptance.md) 验收标准 3）。
- [ ] **数据量增长预案**：若 `monitor_record` 量级远超 100k 行，评估
      `examItem`/`q` 子串搜索的 `pg_trgm` 索引（btree 无法加速 `ILIKE %..%`）。

## 6. 初始账号与角色分配

按 [docs/auth.md](./auth.md) 创建初始账号并分配授权（`assign-access` 整表替换）：

```bash
pnpm --filter @epgs/api auth:create-user --username <账号> --display-name <姓名>
pnpm --filter @epgs/api auth:assign-access --username <账号> --roles VIEWER --departments 消化内科,呼吸内科 [--patient-detail]
pnpm --filter @epgs/api auth:assign-access --username <账号> --roles RULE_ADMIN
pnpm --filter @epgs/api auth:assign-access --username <账号> --roles AUDITOR
pnpm --filter @epgs/api auth:assign-access --username <账号> --roles SYSTEM_ADMIN
```

- [ ] 角色矩阵勾选：哪些账号可看患者详情（`--patient-detail`）经内镜中心书面确认；
      其余账号一律不加该标记（默认脱敏）。
- [ ] 科室范围（`--departments`）与账号职责一致；为空 = 全部科室，需谨慎。
- [ ] 无默认/写死账号密码（系统主动拒绝 `--password` 参数）。

## 7. 上线回滚 runbook

> 原则：**先回滚应用，再按需回滚数据库**。数据库迁移是链式的——要撤销某次迁移，
> 必须先撤销所有更新的迁移；回滚均为破坏性操作，**执行前必须确认备份**。

### 7.1 应用回滚（首选）

回滚部署产物 / revert 对应提交，重启服务即恢复到上一版本代码。数据库不降级时，
新版只读代码对旧 schema 天然兼容（#14 只新增索引，无字段变更，可安全保留）。

### 7.2 数据库迁移回滚（新到旧）

迁移链（新 → 旧）：

| 顺序 | 迁移目录                                                      | 回滚脚本作用                                             |
| ---- | ------------------------------------------------------------- | -------------------------------------------------------- |
| 1    | `20260821110858_add_monitor_record_patient_type_index`（#14） | 删除 `monitor_record_patient_type_code_idx` 索引         |
| 2    | `20260821103732_add_auth_access_and_audit_log`（#13）         | 删除 `app_user_access` / `audit_log` 与相关枚举          |
| 3    | `20260821093500_add_local_auth`（#31）                        | 删除 `app_user`（全部本地账号）                          |
| 4    | `20260821073851_remove_closed_loop_readonly`（#26）           | **破坏性**：恢复闭环模型，数据不还原，见脚本头部 WARNING |
| 5    | `20260821040339_init_monitoring_schema`（#3）                 | 删除全部 `monitor_*` 表与枚举                            |

```bash
# 单步回滚示例（第 1 步：撤掉 #14 索引）
psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821110858_add_monitor_record_patient_type_index/rollback.sql
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260821110858_add_monitor_record_patient_type_index';
```

- **只回退单一特性**：按上表只执行到该迁移为止（新到旧依次）。例：仅撤销权限层
  → 执行 1、2 两步。
- **完全重置到空库**：执行 1→5 全部回滚，再 `DELETE FROM "_prisma_migrations";`
  清空历史（否则 re-deploy 会跳过"看似已应用"的迁移），最后按需
  `prisma migrate deploy` 重建。CI 的 db-migrations job 即按此流程验证：
  #14→#13→#31→#3 回滚（#26 因 #3 已全量清表而省略其破坏性回滚）→ 清空历史 →
  重新正向迁移。
- **#26 特别警告**：该回滚会重建 `monitor_action` 与 `handling_status` 等已被
  删除的字段（数据不还原），仅当明确需要回到旧闭环模型时执行；否则靠 #3 清表
  即可。

## 8. 上线后验证（24h 内）

- [ ] `GET /health` 200；`GET /api/system/sync-status` 显示最近一次同步成功。
- [ ] 权限矩阵抽查：无 `patient-detail` 的账号看到脱敏数据；越科室访问 404。
- [ ] 审计日志持续写入（`AUDITOR` 账号 `GET /api/audit` 可见当日记录）。
- [ ] 常见筛选响应时间与 [performance.e2e-spec.ts](../apps/api/test/performance.e2e-spec.ts)
      的量级一致（远低于 3s）。
- [ ] 首次生产同步完成后，`monitor_record` 行数与源系统对账无重复（幂等主键
      `source_record_id + report_id + report_version`，见 verify-constraints）。

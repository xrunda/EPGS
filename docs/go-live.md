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
- [ ] **词库确认**：种子脚本内置内镜中心定稿的 RED 17 / YELLOW 13 条（`6bf29d5`，
      `apps/api/prisma/seed.ts`，幂等可重复执行）；后续增补由 `RULE_ADMIN` 在配置页
      导入（见 [docs/rules-api.md](./rules-api.md)），上线前与内镜中心核对一遍现网
      规则表与定稿清单一致。

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
- [ ] **企业微信推送出站**（#53/#61）：api（手动「立即执行一次」/「发送测试」）与
      worker（定时推送）所在主机都能出站访问 `https://qyapi.weixin.qq.com`
      （群机器人 Webhook）；否则推送记录为 `FAILED`、`wecomErrMsg` 为网络错误。
- [ ] **预警卡片链接可达**（#72/#76）：`ALERT_LINK_BASE_URL` 必须是**医生手机在医院
      网络下**能打开的 web 入口（nginx 单端口对外地址，如 `http://10.10.10.91:5173`），
      手机需能访问 `/alert` 与封面 `/alert-cover.jpg`；用 4G 看企微的场景下若入口
      不可达，卡片可显示但点不开。未确认前**不要配置**该变量（不配 = 只推文本，
      行为与之前一致），确认后 api 与 worker 配同值（`start.sh` 会校验一致性）。

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
      `examItem`/`patientName` 子串搜索的 `pg_trgm` 索引（btree 无法加速
      `ILIKE %..%`）；`keyword` 已改为精确匹配，走普通索引即可，无需
      `pg_trgm`。

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

### 6.1 USER_ADMIN 冷启动（#78/#81，每次新环境必做）

`SYSTEM_ADMIN` 与 `USER_ADMIN` 是**职责分离**的两个角色——`SYSTEM_ADMIN` 拿不到
`/api/users/*`，Web 上的「用户管理」入口也**只对 `USER_ADMIN` 渲染**。所以新环境
（或任何尚无 `USER_ADMIN` 的环境）部署完管理员模块后，**必须先用 CLI 给至少一个
管理员账号追加 `USER_ADMIN`**，否则页面上根本看不到这个模块，且系统里没有任何
人能新建第二个 `USER_ADMIN`。

```bash
# 1. 先看该账号当前角色，避免整表替换丢角色
pnpm --filter @epgs/api auth:show-access --username <现有管理员>

# 2. 带上"原有全部角色" + USER_ADMIN，一次写入
pnpm --filter @epgs/api auth:assign-access --username <现有管理员> \
  --roles SYSTEM_ADMIN,USER_ADMIN
```

- [ ] **`assign-access` 是整表替换**：`--roles` 必须列出该账号原有**全部**角色，
      漏写即静默丢失（第 1 步的 `show-access` 就是为此）。
- [ ] **`--departments` 漏写 = 全院可见**（命令行会警告）：原账号若设过科室限制，
      不传该参数会**静默放宽到全院**。原账号有科室限制时，必须原样带上
      `--departments <原值,...>`。
- [ ] 授权**无需重新登录**即对接口生效（`RolesGuard` 每次请求实时查库，
      `/api/auth/me` 同样实时返回）——但已打开的页面需要**刷新**才会重新拉
      `/me` 并渲染出入口按钮。
- [ ] 冷启动完成后立即用该账号登录验证：工作台右上角出现「用户管理」，
      点开能看到账号列表。此后再新增 `USER_ADMIN` 一律走 Web 界面，不再用 CLI。

## 7. 上线回滚 runbook

> 原则：**先回滚应用，再按需回滚数据库**。数据库迁移是链式的——要撤销某次迁移，
> 必须先撤销所有更新的迁移；回滚均为破坏性操作，**执行前必须确认备份**。

### 7.1 应用回滚（首选）

回滚部署产物 / revert 对应提交，重启服务即恢复到上一版本代码。数据库不降级时，
新版只读代码对旧 schema 天然兼容（#14 只新增索引，无字段变更，可安全保留）。

**功能级开关（不必回滚代码）**：

- 预警卡片（#72/#76）：从 api 与 worker 的 `.env` 删除/清空 `ALERT_LINK_BASE_URL`
  并 `bash start.sh nopull`，推送即回到只发文本；已发出的卡片链接仍可在其
  24 小时有效期内打开（要立刻全部失效，执行 §7.2 第 1 步删除 `alert_link` 表，或
  `DELETE FROM alert_link;`）。
- 定时推送（#61）：在配置页停用对应规则即可，不需要改配置或重启。

### 7.2 数据库迁移回滚（新到旧）

迁移链（新 → 旧，每个目录都自带 `rollback.sql`）。**下表记录的是截止 §9 批次
（2026-09 推送增强）的链条**；其后的 `20260911000000_add_user_admin_role_and_audit_actions`
（#83 管理员模块）比下表全部条目都新，回退说明见 §10.6。

| 顺序 | 迁移目录                                                      | 回滚脚本作用                                                                                               |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1    | `20260905060000_add_alert_link`（#72）                        | 删除 `alert_link`（已发出的企微卡片链接立即失效）。**必须先于第 3 步**：它对 `push_log` 有外键             |
| 2    | `20260903000000_add_push_assistant`（#70）                    | 删除 `assistant_heartbeat` / `assistant_event` 与枚举 `AssistantEventType`（推送助理心跳与活动流，可重建） |
| 3    | `20260823055843_add_notification_push_rules`（#61）           | 删除 `push_delivery` / `push_log` / `notification_rule_channel` / `notification_rule` 与相关枚举           |
| 4    | `20260823032959_add_notification_channel_template`（#53）     | 删除 `notification_channel` / `notification_template`（含加密的 Webhook 地址）与枚举                       |
| 5    | `20260821110858_add_monitor_record_patient_type_index`（#14） | 删除 `monitor_record_patient_type_code_idx` 索引                                                           |
| 6    | `20260821103732_add_auth_access_and_audit_log`（#13）         | 删除 `app_user_access` / `audit_log` 与相关枚举                                                            |
| 7    | `20260821093500_add_local_auth`（#31）                        | 删除 `app_user`（全部本地账号）                                                                            |
| 8    | `20260821073851_remove_closed_loop_readonly`（#26）           | **破坏性**：恢复闭环模型，数据不还原，见脚本头部 WARNING                                                   |
| 9    | `20260821040339_init_monitoring_schema`（#3）                 | 删除全部 `monitor_*` 表与枚举                                                                              |

```bash
# 单步回滚示例（第 1 步：撤掉 #72 的 alert_link 表）
psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260905060000_add_alert_link/rollback.sql
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260905060000_add_alert_link';
```

- **只回退单一特性**：按上表只执行到该迁移为止（新到旧依次）。例：仅撤销预警
  卡片 → 只执行第 1 步；撤销整个推送模块 → 执行 1→4。
- **枚举值不可逆**：#53/#61 向 `AuditAction` 追加的 `CONFIG_CHANGE` 触发点、
  `NOTIFICATION_TEST_SEND`、`NOTIFICATION_RULE_RUN` 无法用 `ALTER TYPE` 删除；
  对应 `rollback.sql` 头部给出了"先确认 `audit_log` 无该值再重建枚举"的手工 SQL，
  默认不自动执行。
- **完全重置到空库**：执行 1→9 全部回滚，再 `DELETE FROM "_prisma_migrations";`
  清空历史（否则 re-deploy 会跳过"看似已应用"的迁移），最后按需
  `prisma migrate deploy` 重建。CI 的 db-migrations job 即按此流程验证：
  #72→#70→#61→#53→#14→#13→#31→#3 回滚（#26 因 #3 已全量清表而省略其破坏性
  回滚）→ 清空历史 → 重新正向迁移。
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
- [ ] **推送链路**（#53/#61/#72/#76）：对绑定**测试群**的规则点「立即执行一次」，
      群内收到文本汇总 + 红/黄/绿各一条卡片（0 例的颜色不发）；配置页「日志」中该
      次运行 `SUCCESS`。若某渠道 `FAILED` 且 `wecomErrMsg` 以「正文已发送，关注卡片
      发送失败」开头，说明文本已到、仅卡片失败——**不要重复补推**。
- [ ] **卡片真机验证**：医生手机（医院网络）在企业微信客户端与个人微信企业会话中
      各点一张卡片，能打开列表与详情、封面显示完整院徽；库内
      `SELECT level, open_count FROM alert_link ORDER BY created_at DESC LIMIT 3;`
      的 `open_count` 随点击增加。
- [ ] **推送助理**（#70）：工作台右下角胶囊显示「值班中」与距下次推送倒计时；
      worker 停 2 分钟后变「已失联」，恢复后自动回到在线。

## 9. 发布记录：2026-09 推送增强（#74 / #72 / #70 / #76）

本批次合并了四个 PR，涉及**两张新表、两个新环境变量、一张新静态资源**。按下列
顺序执行，每步有明确的通过标准；任何一步不通过先按 §7.1 功能开关回退，不要带着
问题继续。

### 9.1 变更清单

| 来源 | 内容                                                                                  | 数据库                                               | 配置                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| #74  | 修复 CI 两条过时断言，`db-migrations` 回滚验证恢复运行                                | 无                                                   | 无                                                                                                                         |
| #72  | 企微推送追加预警卡片 → `/alert` 免登 H5（脱敏列表 / 详情），token 24h、库内只存哈希   | `20260905060000_add_alert_link`（新表 `alert_link`） | `ALERT_LINK_BASE_URL`（可选）、`ALERT_LINK_TTL_HOURS`                                                                      |
| #70  | 工作台右下角「推送助理」：worker 心跳、倒计时、活动流、「立即推送」                   | `20260903000000_add_push_assistant`（两张新表）      | `ASSISTANT_STALE_SECONDS`（api）、`ASSISTANT_HEARTBEAT_SECONDS` / `ASSISTANT_EVENT_RETENTION_DAYS`（worker），均可选有默认 |
| #76  | 卡片改为每色一条**单篇**图文（个人微信企业会话也可点击）+ 院徽封面 `/alert-cover.jpg` | 无                                                   | 复用 `ALERT_LINK_BASE_URL`                                                                                                 |

### 9.2 部署前（在堡垒机上，执行 `start.sh` 之前）

常规流程不变：VPN 连到堡垒机 → `bash start.sh`（脚本自行 `git pull` / 迁移 / 构建 /
重启）。本批次只多一步**一次性**的 `.env` 修改：

- [ ] **两端同值写入 `.env`**（`apps/api/.env` 与 `apps/worker/.env` 各加两行；
      `start.sh` 每次都会校验两端一致，不一致直接退出）：
  ```dotenv
  ALERT_LINK_BASE_URL=http://<医生浏览器打开工作台用的地址>:<端口>
  ALERT_LINK_TTL_HOURS=24
  ```
  值就是大家现在访问工作台的那个入口（nginx 单端口 / 网闸映射后的地址），
  **不是** `localhost`。医生手机能否点开卡片与能否打开工作台是同一个前提，不需要
  额外提前验证；不确定时可以先不加这两行——卡片功能关闭，其余功能照常上线，
  之后随时加上再 `bash start.sh nopull` 即可。
- [ ] （可选）推送助理参数保持默认即可；只有当 worker 心跳周期改动时才需同时改
      api 的 `ASSISTANT_STALE_SECONDS`（≈ 3 × `ASSISTANT_HEARTBEAT_SECONDS`）。
- [ ] **备份数据库**（§4）：本批次有两张新表的正向迁移，回滚会删表。
- [ ] **企微群准备**：确认要接收卡片的群机器人 Webhook 已在配置页「渠道」中配置
      并「发送测试」成功；先用**测试群**验证，再切到正式群。

### 9.3 部署（`bash start.sh`，脚本自动完成的步骤只需看输出）

1. `git pull` 到包含 #76 的 main。
2. env 预检输出中应看到 `ALERT_LINK_BASE_URL=...（api/worker 一致）-> 企微预警卡片功能开启`
   （或未配置时的「功能关闭」提示）；看到「错误」即停下修 `.env`。
3. `prisma migrate deploy` 应输出应用了 `20260903000000_add_push_assistant` 与
   `20260905060000_add_alert_link`（已应用过则显示 "No pending migrations"）。
4. `pnpm --filter web run build` 后确认产物里有封面：
   `ls apps/web/dist/alert-cover.jpg apps/web/dist/hospital-logo.jpg`。
5. nginx reload 后：`curl -sI http://<入口>/alert-cover.jpg` 为 200 `image/jpeg`，
   `curl -sI http://<入口>/alert` 为 200（SPA fallback）。

### 9.4 部署后验证

按 §8 新增的三项（推送链路、卡片真机验证、推送助理）逐项勾选。卡片验证由在院
同事在**医生实际使用的网络**下点一次即可（封面与链接都由手机自行拉取）；点不开
就按 §9.5 删掉 `ALERT_LINK_BASE_URL` 关掉卡片，不影响其他功能。

### 9.5 回退

- 只关卡片：删 `ALERT_LINK_BASE_URL` → `bash start.sh nopull`（§7.1）。
- 回退代码：revert 对应 PR 后重启；两张新表可留存不影响旧代码。
- 回退数据库：§7.2 第 1、2 步（先 `alert_link`，再 `assistant_*`）。

## 10. 发布记录：2026-09 管理员模块（#82 / #83 / #84 / #85）

代码上线本身很轻：**一张迁移（只改枚举）、零新环境变量、零新依赖、零新静态资源**。
真正的操作重点是 §10.4 的**冷启动**——不做的话模块上线了但没人能打开。

### 10.1 变更清单

| 来源 | 内容 | 数据库 | 配置 |
| ---- | ---- | ------ | ---- |
| #83 | `AppRole` 追加 `USER_ADMIN`；`AuditAction` 追加 6 个 `USER_*` 值 | `20260911000000_add_user_admin_role_and_audit_actions`（**仅 `ALTER TYPE ... ADD VALUE`**，无新表、无字段变更、不触碰任何现有行） | 无 |
| #84 | `/api/users` 账号 CRUD / 启停 / 重置密码 / 授权读写，类级 `@RequireRoles(USER_ADMIN)` | 无 | 无 |
| #85 | 工作台「用户管理」弹窗；入口按钮仅当 `/api/auth/me` 返回的角色含 `USER_ADMIN` 时渲染 | 无 | 无 |
| #78/#79 | 设计文档、API 文档、`docs/auth.md` 角色表补 `USER_ADMIN` 行 | 无 | 无 |

对照上一批（§9），**本批次不需要动 `.env`、不需要准备图片、`.env` 预检输出应与
上次完全一致**——如果 `start.sh` 的 env 预检报出新错误，说明是环境被改动过，
停下来查，不是本次部署引入的。

### 10.2 部署前（在堡垒机上，执行 `start.sh` 之前）

- [ ] **备份数据库**（§4）。本批次迁移只加枚举值、不删不改数据，但备份是常规动作。
- [ ] 本节及 §10.5 的 `psql` 需要 `DATABASE_URL`。堡垒机的登录 shell 里通常没有
      导出它（服务是由 `start.sh` 读 `apps/api/.env` 启动的），先取出来：
      ```bash
      cd <仓库根> && DATABASE_URL=$(grep -m1 '^DATABASE_URL=' apps/api/.env | cut -d= -f2- | tr -d '"')
      ```
- [ ] **盘点现有账号与授权**（决定 §10.4 冷启动挂到谁头上，也是"数据完整"的基线）：
  ```bash
  psql "$DATABASE_URL" -c 'SELECT u.username, u.display_name, u.is_active,
      a.roles, a.department_scope, a.patient_detail
    FROM app_user u LEFT JOIN app_user_access a ON a.username = u.username
    ORDER BY u.created_at;'
  ```
  **把输出存档**（部署后要逐行对比，确认没有任何账号的角色/科室/脱敏被改动）。
- [ ] 从上面结果里**选定一个管理员账号**作为首个 `USER_ADMIN`（建议现有
      `SYSTEM_ADMIN` 账号），记下它当前的 `roles` 与 `department_scope` 原值。
- [ ] 确认**没有任何账号的 `department_scope` 非空**、或已记下这些账号的科室原值。
      非空的账号在 §10.4 和 §10.5 都要特别处理（见那里的警告）。
- [ ] `apps/api/.env` / `apps/worker/.env` 无需改动（本批次无新环境变量）。

### 10.3 部署（`bash start.sh`，脚本自动完成的步骤只需看输出）

1. `git pull` 到包含 #85 的 main（本次批次末尾提交为 `507e6fd`）。
2. env 预检输出应与 §9 部署时**逐字一致**（`ALERT_LINK_BASE_URL` 那行的开启/关闭
   状态不变）。出现新「错误」即停下。
3. `prisma migrate deploy` 应新增应用 `20260911000000_add_user_admin_role_and_audit_actions`，
   且**只打印 `ALTER TYPE` 语句**。若它试图 `CREATE TABLE` / `DROP` / 改字段，
   立刻中断并排查（那不是本批次应有的内容）。已应用过则显示 "No pending migrations"。
4. **确认 Prisma Client 已按新枚举重新生成**（这是本批次唯一的构建期风险：
   `start.sh` 里没有显式 `prisma generate`，靠 `pnpm install` 的 `postinstall`
   触发；client 若没更新，`AppRole.USER_ADMIN` 在运行时是 `undefined`，
   写授权会报数据库枚举错误）：
   ```bash
   # 应打印 "runtime AppRole.USER_ADMIN = USER_ADMIN"
   # 打印 undefined 说明 client 是旧的（postinstall 没跑到），停下来先
   # `pnpm --filter api exec prisma generate` 再重启，不要带着它上线。
   # 用子 shell 以免改变当前目录，后面的步骤还依赖仓库根路径。
   ( cd apps/api && node -e "const {AppRole}=require('@prisma/client'); console.log('runtime AppRole.USER_ADMIN =', AppRole.USER_ADMIN)" )
   ```
5. `pnpm --filter web run build` 完成后，产物应包含本批次的弹窗代码：
   ```bash
   grep -rl "用户管理" apps/web/dist/assets/ | head   # 应列出打包后的 JS
   ```
6. nginx reload 后：`curl -sI http://<入口>/` 为 200（SPA fallback 正常）。

### 10.4 冷启动：授予首个 `USER_ADMIN`（**本批次的关键步骤**）

页面上的「用户管理」入口**只对持有 `USER_ADMIN` 的账号渲染**，`SYSTEM_ADMIN`
刻意拿不到它（职责分离，见 `docs/auth.md` 角色表）。所以刚部署完时，**所有人
都看不到这个模块**，必须先用 CLI 打通第一个口子。完整注意事项见 §6.1。

```bash
# 用 §10.2 选定的账号替换 <管理员账号>
pnpm --filter @epgs/api auth:show-access --username <管理员账号>   # 先看现有角色原值
pnpm --filter @epgs/api auth:assign-access --username <管理员账号> \
  --roles <原角色1>,<原角色2>,USER_ADMIN                          # 带上原有全部角色 + USER_ADMIN
```

- [ ] **`assign-access` 整表替换**：`--roles` 漏写的原有角色会被静默删除。
- [ ] **不传 `--departments` = 全院可见**（且命令行只给警告）：该账号原本设过科室
      限制的话，这一步会**静默放宽到全院**。原值非空时必须原样带回：
      `--departments <原值,...>`。
- [ ] 授权即时生效（每次请求实时查库）；已打开的页面**刷新**即可看到入口，
      不需要重新登录。
- [ ] 立即用该账号登录验证：右上角出现「用户管理」，点开能看到列表且行数与
      §10.2 的盘点结果一致。

### 10.5 部署后验证（24h 内）

先做 §8 的常规项（`/health`、同步状态、脱敏抽查、审计写入），本批次额外确认：

- [ ] **入口隔离**：换一个只有 `VIEWER`/`SYSTEM_ADMIN`（无 `USER_ADMIN`）的账号登录，
      右上角**没有**「用户管理」按钮；直接调 `GET /api/users` 返回 `403`。
- [ ] **建号闭环**：用 `USER_ADMIN` 账号新建一个测试账号（账号/显示名/密码两次），
      保存后应**自动展开该账号的授权编辑区**；分配 `VIEWER` 保存。
- [ ] **新账号可用**：用刚建的测试账号登录，能看到工作台监测列表（`VIEWER` 语义）。
- [ ] **审计落库**：
      ```bash
      # 注意 action 是 AuditAction 枚举类型，LIKE 前必须显式转 text
      psql "$DATABASE_URL" -c "SELECT action, actor_username, meta, created_at
        FROM audit_log WHERE action::text LIKE 'USER_%' ORDER BY created_at DESC LIMIT 10;"
      ```
      应能看到 `USER_CREATE` / `USER_ROLE_CHANGE`，且 `meta` **不含任何密码或哈希**。
- [ ] **最后管理员保护**：把唯一 `USER_ADMIN` 账号的角色取消 `USER_ADMIN` 后保存，
      应返回 `409 LAST_USER_ADMIN_PROTECTED` 并被界面拦住（禁用/删除同一账号同样被拦）。
      **先决条件**：做这条之前，§10.4 的冷启动账号之外**再授予第二个账号
      `USER_ADMIN`**。守卫本身是 fail-closed 的（请求被拒、数据不变），但万一它
      失效，唯一管理员会被自己锁在门外、只能回堡垒机用 CLI 救——两个管理员时
      最坏情况也只是自己丢权限，另一个账号还能进 Web 改回来。验证完把角色改回去。
- [ ] **回归：老账号授权未被改动**——重新执行 §10.2 的盘点 SQL，与存档逐行对比：
      `roles`、`department_scope`、`patient_detail` 三项必须与部署前完全一致。
      这是"线上数据完整"的直接证据。
- [ ] **回归：科室限制未被放宽**——若盘点里有 `department_scope` 非空的账号，
      在 Web 上给它改一次角色并保存，再查一次库：`department_scope` 应**保持原值
      不变**（这是 #81 修复的行为，界面不显示该字段但也不会覆盖它）；若有账号被
      意外放宽到 `{}`，立即用 CLI 按原值 `--departments` 改回。
- [ ] **回归：脱敏未被打乱**——抽查一个 `patient_detail = false` 的账号，
      监测详情仍脱敏（响应带 `dataAccess.masked`）。
- [ ] **删除联动**：删除 §10.5 建的测试账号，确认 `app_user` 与 `app_user_access`
      两行同时消失，不留孤儿授权行：
      ```bash
      psql "$DATABASE_URL" -c "SELECT count(*) FROM app_user_access a
        WHERE NOT EXISTS (SELECT 1 FROM app_user u WHERE u.username = a.username);"
      ```
      应为 `0`。

### 10.6 回退

- **首选：只回退应用**。`revert` #85/#84 对应提交后 `bash start.sh nopull`。
  **数据库不用动**：#83 迁移只是在两个枚举类型上追加了值，旧代码从不引用它们，
  留在库里完全无害（本批次没有新表、没有字段变更，因此不存在"新旧 schema 不兼容"）。
- **不要回退 #83 的枚举迁移**。PostgreSQL 没有 `ALTER TYPE ... DROP VALUE`，
  撤销需要重建枚举类型并重指两个表的列，且有数据时不可逆。**没有任何理由做这件事**
  ——枚举值冗余存在不影响任何功能。
- 若确实需要（例如必须让 `AppRole` 回到四个值），按
  `apps/api/prisma/migrations/20260911000000_add_user_admin_role_and_audit_actions/rollback.sql`
  头部的手工 SQL 执行，**执行前必须先确认无数据引用**：
  ```bash
  psql "$DATABASE_URL" -c "SELECT count(*) FROM app_user_access WHERE 'USER_ADMIN' = ANY(roles);"
  psql "$DATABASE_URL" -c "SELECT count(*) FROM audit_log WHERE action IN
    ('USER_CREATE','USER_ROLE_CHANGE','USER_DISABLE','USER_ENABLE','USER_DELETE','USER_PASSWORD_RESET');"
  ```
  两者都必须为 `0`，否则要么删掉这些行（丢失账号授权/审计历史），要么放弃回退。
- **功能级降级（推荐给"只想先关掉这个模块再排查"的场景）**：回退应用即可——入口
  按钮随新前端一起消失，`/api/users` 随新后端一起消失。已授予的 `USER_ADMIN`
  角色留在库里，下次重新部署即恢复，无需重新冷启动。

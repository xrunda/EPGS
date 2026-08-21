# 本地账号与登录运维（Issue #31）

EPGS 在医院内网使用轻量本地账号。除 `GET /health` 和
`POST /api/auth/login` 外，业务 API 默认要求登录。本功能只判断“是否登录”；
角色、科室范围、患者脱敏和完整读取审计由 Issue #13 实现。

## 数据与会话

- `app_user` 仅保存标准化账号、显示名称、Argon2id 密码哈希、启用状态和
  `password_version`，不保存明文密码。
- 登录成功后设置 `epgs_session` HttpOnly Cookie，前端 JavaScript 不读取或保存
  JWT。Cookie 使用 `SameSite=Lax`、`Path=/`，生产环境自动增加 `Secure`。
- JWT 只包含用户 ID、账号和密码版本。修改或重置密码会增加密码版本，使所有旧
  JWT 立即失效。
- 不建立会话表，不提供注册、邮件、短信、验证码或自助找回密码。

## API

| 方法   | 路径                        | 行为                                           |
| ------ | --------------------------- | ---------------------------------------------- |
| `POST` | `/api/auth/login`           | 校验账号密码，设置 Cookie，返回最小用户信息    |
| `GET`  | `/api/auth/me`              | 返回当前用户的 `id`、`username`、`displayName` |
| `POST` | `/api/auth/logout`          | 清除 Cookie                                    |
| `POST` | `/api/auth/change-password` | 校验当前密码并修改，随后清除 Cookie            |

登录失败统一返回 `401 AUTH_INVALID_CREDENTIALS`，不区分账号不存在或密码错误；
禁用账号返回 `403 AUTH_ACCOUNT_DISABLED`。修改密码要求新密码至少 8 个字符、两次
输入一致且不能与当前密码相同。响应、日志均不得包含密码、哈希或 JWT。

所有浏览器请求必须携带 Cookie：

```ts
fetch('/api/auth/me', { credentials: 'include' });
```

## 部署配置

先应用 Prisma 迁移：

```bash
pnpm --filter @epgs/api exec prisma migrate deploy
```

API 必需或相关环境变量：

```dotenv
JWT_SECRET=<至少 32 个随机字符，每套环境单独生成>
JWT_EXPIRES_SECONDS=28800
WEB_ORIGIN=http://<内网前端地址>
```

`JWT_SECRET` 变更会使现有登录全部失效。生产环境应通过虚拟机环境文件或密钥管理
方式注入，禁止提交到仓库。前端和 API 分开端口部署时，`WEB_ORIGIN` 必须精确匹配
浏览器访问前端时的源，API CORS 才会允许携带 Cookie。

## 创建初始账号

在应用服务器的项目目录执行：

```bash
pnpm --filter @epgs/api auth:create-user --username <账号> --display-name <姓名>
```

终端会隐藏输入两次密码。禁止增加 `--password` 参数；命令会主动拒绝，避免密码
进入 Shell 历史或进程列表。系统不提供写死的默认账号或密码。

## 忘记密码

由服务器管理员在应用服务器执行：

```bash
pnpm --filter @epgs/api auth:reset-password --username <账号>
```

两次隐藏输入一致且至少 8 个字符后，系统写入新哈希并增加密码版本。旧密码和全部
旧 Cookie 随即失效。管理员通过院内线下方式告知用户新密码；命令只输出成功/失败
和账号，不输出密码或哈希。

## 回滚

应用代码可通过回滚本 Issue 的提交撤销。数据库回滚会删除全部本地账号，属于破坏
性操作，只能在确认备份和停用本地登录后执行：

```bash
psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821093500_add_local_auth/rollback.sql
```

---

# 角色、科室范围、数据脱敏与审计（Issue #13）

#31 只判断“是否登录”；本功能在登录之上叠加**授权**：按账号分配角色，按角色
限制可读科室与患者详情，并对全部读取与规则写操作落审计日志。由全局
`RolesGuard`（在 #31 的 `AuthGuard` 之后注册）执行：每次请求按
`request.user.username` 查询 `app_user_access`，无授权记录则角色受限接口一律
`403 FORBIDDEN`（fail-closed）；无角色元数据的接口任意已登录用户可访问。

## 角色

| 角色           | 监测列表/汇总 | 监测详情   | 规则读取 | 规则写 | 审计读取 | 系统状态 |
| -------------- | ------------- | ---------- | -------- | ------ | -------- | -------- |
| `VIEWER`       | ✅ 仅本科室   | ✅         | ✅       | ❌ 403 | ❌ 403   | ✅       |
| `RULE_ADMIN`   | ✅（脱敏）    | ✅（脱敏） | ✅       | ✅     | ❌ 403   | ✅       |
| `SYSTEM_ADMIN` | ✅（脱敏）    | ✅（脱敏） | ✅       | ❌ 403 | ❌ 403   | ✅       |
| `AUDITOR`      | ❌ 403        | ❌ 403     | ✅       | ❌ 403 | ✅       | ✅       |
| 未登录         | 401           | 401        | 401      | 401    | 401      | 401      |

- 监测接口（`/api/monitor/*`）类级要求 `VIEWER | RULE_ADMIN | SYSTEM_ADMIN`。
- 规则写接口（创建/编辑/导入确认）方法级要求 `RULE_ADMIN`；规则读取任意已登录。
- 审计接口（`GET /api/audit`）类级要求 `AUDITOR`。

## 数据范围与脱敏

- **科室范围** `departmentScope`：数组为空 = 全部科室；非空时监测查询只返回
  这些科室的记录。**值必须与 `monitor_record.department` 完全一致**（区分大小写），
  错配会静默返回空结果。
- **患者详情** `patientDetail`：为 `false` 时对监测响应脱敏——姓名保留姓氏
  （`张三丰` → `张**`）、床号 → `***`、`reportContent`/`diagnosis`/每个命中
  `contextSnippet` → `null`，并在响应体附加 `dataAccess: { masked: true }`。
  未脱敏响应不带该字段，以便区分“被脱敏”与“报告本就无正文”。
- **越权即 404**：受科室限制的用户请求范围外记录时返回 `404
MONITOR_RECORD_NOT_FOUND`（而非 403），不暴露该记录存在。

## 授权数据与运维

`app_user_access`（按 `username` 主键）保存角色、科室范围与患者详情授权，不依赖
`app_user` 存在与否。创建/重置账号（#31）后必须分配授权，否则登录后角色受限
接口全部 403：

```bash
# 给 doctor 分配“查看者”角色，限定消化内科与呼吸内科
pnpm --filter @epgs/api auth:assign-access --username doctor --roles VIEWER --departments 消化内科,呼吸内科

# 额外授予患者详情（不脱敏）
pnpm --filter @epgs/api auth:assign-access --username doctor --roles VIEWER --departments 消化内科 --patient-detail

# 查看现有授权
pnpm --filter @epgs/api auth:show-access --username doctor
```

- 未指定 `--departments` 时命令行会**大声警告**“该用户将拥有全部科室的访问范围”。
- `assign-access` 整表替换该账号的授权；`show-access` 无记录时非零退出。
- 授权即时生效，无需重新登录：每次请求都从数据库读取（不缓存）。

## 审计日志

`audit_log` 只增不删（无更新/删除接口，仅 `GET /api/audit` 由 `AUDITOR` 读取）。
已触发动作：`EXAM_LIST`、`EXAM_DETAIL`、`RULE_CREATE`、`RULE_UPDATE`、
`RULE_IMPORT`、`AUDIT_VIEW`；`LOGIN`、`CONFIG_CHANGE` 预留在枚举中，尚未接入。

- 审计 `meta` 只含低敏感字段（过滤条件、`masked` 标记、规则语义、计数），
  **绝不包含**患者姓名/报告正文/搜索关键词 `q` 本身（仅记 `hadQ` 布尔）。
  `log-sanitization` 静态测试对全源码树强制该约束。
- **审计 fail-open**：写失败仅记告警日志，绝不让业务请求变成 500；授权始终
  fail-closed。无授权记录的账号（例如只访问健康检查）不产生审计行。
- 审计查询支持按 `action`/`actorUsername`/`department` 过滤 + 分页（`GET
/api/audit?action=EXAM_DETAIL&actorUsername=doctor&page=1&pageSize=50`）。

## 规则写操作的执行者

已认证用户的**服务端账号**优先于请求体里的 `actorId`：`POST /api/rules` 等接口
即使被篡改 `actorId`，落库的 `createdBy`/`updatedBy` 与审计 `actorUsername` 仍是
登录账号。`actorId` 仅保留以兼容旧 DTO 形状，不再作为身份来源。

## 回滚

本迁移的回滚会删除全部角色授权与审计日志：

```bash
psql "$DATABASE_URL" -f apps/api/prisma/migrations/20260821103732_add_auth_access_and_audit_log/rollback.sql
```

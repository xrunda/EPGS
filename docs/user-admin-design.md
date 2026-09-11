# 用户管理功能模块（设计草案）

## 背景与目标

当前新建账号（`auth:create-user`）、分配角色/科室/脱敏授权（`auth:assign-access`）、
重置密码（`auth:reset-password`）都只能在应用服务器上以 CLI 方式执行，每次需要
登录 bastion、进入项目目录、逐条敲命令。本功能把这三类操作和账号启停、删除做成
Web 页面，供有权限的管理员在浏览器里直接完成，不再依赖服务器访问权限。

CLI（`apps/api/src/auth/auth-cli.ts`、`apps/api/src/access/access-cli.ts`）保留，
作为部署初期、紧急止血（例如忘记密码且 Web 不可用）或首个管理员冷启动的兜底手段，
不废弃。

## 权限模型变更

新增角色 `AppRole.USER_ADMIN`，专职管理账号与授权，与现有 `SYSTEM_ADMIN`（系统
状态/脱敏监测查看）职责分离：

| 角色         | 用户列表/新增/启停/删除 | 分配角色与科室范围 | 重置密码 |
| ------------ | ------------------------ | -------------------- | -------- |
| `USER_ADMIN` | ✅                        | ✅                    | ✅       |
| 其他角色     | ❌ 403                    | ❌ 403                | ❌ 403   |

- 需要 Prisma 迁移：`AppRole` 枚举追加 `USER_ADMIN`。
- 沿用现有 `@RequireRoles(AppRole.USER_ADMIN)` + `RolesGuard` 机制，无需新增守卫
  逻辑。
- **冷启动**：功能上线后，运维通过 CLI 给至少一个现有管理员账号追加
  `USER_ADMIN`：
  ```bash
  pnpm --filter @epgs/api auth:assign-access --username <现有管理员> \
    --roles SYSTEM_ADMIN,USER_ADMIN --departments <原有科室范围>
  ```
  （`assign-access` 是整表替换，需带上该账号原有的其它角色，避免覆盖丢失。）
  该步骤写入 `docs/go-live.md` 上线清单。

## 功能范围

### 1. 用户列表

- 展示字段：账号（`username`）、显示名（`displayName`）、启用状态
  （`isActive`）、已分配角色（`roles`，可能为空 = 无权限）、科室范围
  （`departmentScope`，空 = 全部科室）、患者详情脱敏状态（`patientDetail`）、
  创建时间。
- 无 `app_user_access` 记录的账号，角色列显示"未授权"，与 CLI 语义一致
  （已登录但角色受限接口全部 403）。
- 支持按账号/显示名搜索、按启用状态筛选。分页沿用规则管理页每页 20 条的约定。

### 2. 新建账号

- 表单字段：账号、显示名、密码（输入两次）。
- 密码由管理员在表单中手动设置两次（沿用 CLI 现状，不做邮件/短信下发），提交后
  管理员通过线下方式告知用户，与 `docs/auth.md` 现有"忘记密码"流程的线下告知
  方式保持一致。
- 提交后立即可在同一表单（或紧接着的引导步骤）分配角色和科室范围，避免创建后
  忘记授权导致新账号登录即全部 403。
- 校验：账号唯一、密码长度（沿用 `change-password` 的至少 8 位规则）、两次密码
  一致。

### 3. 分配角色与科室范围

- 角色多选：`VIEWER` / `RULE_ADMIN` / `SYSTEM_ADMIN` / `AUDITOR` /
  `USER_ADMIN`。
- 科室范围改为多选下拉，选项来自新增接口 `GET /api/monitor/departments`
  （对 `monitor_record.department` 去重查询），替代当前自由文本输入，从根上
  消除"拼写不一致导致静默空结果"的问题。留空 = 全部科室，前端需要用醒目提示
  文案还原 CLI 现有的"大声警告"效果。
- 患者详情开关对应 `--patient-detail`。
- 保存整表替换该账号授权（与 `assign-access` 语义一致），表单需要先加载当前
  授权作为初始值，避免管理员无意中清空其它角色。

### 4. 启用/禁用账号

- 对应 `app_user.isActive` 开关，不删除数据。禁用后登录返回
  `403 AUTH_ACCOUNT_DISABLED`（复用现有登录逻辑，无需改动）。

### 5. 重置密码

- 管理员输入新密码两次，提交后该账号 `passwordVersion` 自增，旧密码和全部旧
  Cookie 立即失效（复用 `auth-cli.ts` 现有的 `reset-password` 服务层逻辑）。
- 同样不通过邮件/短信下发，管理员线下告知。

### 6. 删除账号

- 硬删除，在一个事务内同时删除 `app_user` 和 `app_user_access` 记录，避免
  孤儿授权行日后被同名新账号意外继承。
- 需要二次确认弹窗（不可恢复操作）。

## 审计

新增 `AuditAction` 枚举值并在对应写操作后调用 `AuditService.record(...)`
（与 `RULE_CREATE`/`RULE_UPDATE` 相同的手动调用模式，非装饰器）：

- `USER_CREATE`
- `USER_ROLE_CHANGE`（角色/科室范围/患者详情变更）
- `USER_DISABLE` / `USER_ENABLE`
- `USER_DELETE`
- `USER_PASSWORD_RESET`（`meta` 中不得包含密码本身，只记账号和操作者）

`LOGIN` 枚举值当前预留未接入，本次不顺带实现，保持范围聚焦。

## 后端接口设计（草案）

沿用 `rules.controller.ts` 的结构模式：DTO + `class-validator`、Service 处理
Prisma 读写、Controller 只做校验/权限/审计编排。

| 方法     | 路径                              | 权限         | 说明                             |
| -------- | --------------------------------- | ------------ | -------------------------------- |
| `GET`    | `/api/users`                      | `USER_ADMIN` | 分页列表，含授权信息（联表）     |
| `POST`   | `/api/users`                      | `USER_ADMIN` | 创建账号（含初始密码）           |
| `PATCH`  | `/api/users/:username/status`     | `USER_ADMIN` | 启用/禁用                        |
| `POST`   | `/api/users/:username/password`   | `USER_ADMIN` | 重置密码                         |
| `DELETE` | `/api/users/:username`            | `USER_ADMIN` | 删除账号 + 授权（事务）          |
| `GET`    | `/api/users/:username/access`     | `USER_ADMIN` | 查看当前授权                     |
| `PUT`    | `/api/users/:username/access`     | `USER_ADMIN` | 整表替换角色/科室/患者详情       |
| `GET`    | `/api/monitor/departments`        | 任意已登录   | 去重科室列表，供选择器使用       |

响应、日志均不得包含密码或密码哈希，沿用 `docs/auth.md` 现有约束。

## 前端设计（草案）

沿用规则管理弹窗模式（`RulesModal.tsx`），不引入路由：

- 主工作台新增"用户管理"入口按钮，`user.roles.includes('USER_ADMIN')` 为 false
  时隐藏（与 `App.tsx` 现有 `canManageRules` 判断方式一致）。
- 弹窗内为列表 + 新建/编辑表单的组合，参考 `RulesPanel` + `RulesModal` 的
  拆分方式。
- 科室多选下拉、角色多选均为受控组件，无需引入组件库，手写 CSS 沿用
  `tokens.css` 设计变量。
- 401 时沿用现有 `epgs:auth-required` 事件机制。

## 不在本次范围内

- 账号自助注册、找回密码、邮件/短信验证码通道——项目现状明确不提供，本次不变。
- 操作日志的"审计读取"页面（`AUDITOR` 角色的 `GET /api/audit` 查看 UI）——如
  现有前端"操作日志"按钮仍是禁用占位，保持现状，不在本次范围内顺带实现。
- 批量导入用户（CSV）——本次只做单个创建，参考规则模块的导入模式，后续如有
  需要再扩展。

## 待确认的实现细节（进入开发前）

1. `USER_ADMIN` 的 Prisma 迁移文件命名与 issue 编号。
2. `/api/users` 列表是否需要按角色/科室筛选（当前草案只定了账号/显示名/启用
   状态筛选）。
3. 前端弹窗是"新建时强制紧接着填角色科室"，还是"新建后可先关闭、稍后再从列表
   点击授权"——两种都要支持只是入口不同，需要定哪个是默认路径。

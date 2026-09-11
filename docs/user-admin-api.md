# EPGS 用户管理 API（issue #78/#81）

本文档描述 `apps/api/src/users/` 实现的账号与授权管理 API：账号 CRUD、启停、
重置密码，以及授权（角色/患者详情脱敏）的查看与整表替换。替代原先只能在应用
服务器执行的 `auth:create-user`/`auth:reset-password`/`auth:assign-access` CLI
（CLI 仍保留作为紧急兜底，见 `docs/auth.md`）。字段级含义参见
`apps/api/prisma/schema.prisma` 的 `AppUser`/`AppUserAccess` 模型与
`docs/data-dictionary.md` —— 本文档只补充 HTTP 层的请求/响应约定。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`。

**科室范围收窄（issue #78）**：本次不做科室级别的访问控制，所有账号固定为
全院可见。`PUT /api/users/:username/access` 不接受 `departmentScope`
字段——请求体携带该字段会被全局 `ValidationPipe`（`forbidNonWhitelisted:
true`）拒绝，返回 `400 BAD_REQUEST`，而不是被静默忽略。详见
`docs/user-admin-design.md`。

## 鉴权

全部接口要求有效登录 Cookie 且持有 `USER_ADMIN` 角色，否则未登录
`401 AUTH_REQUIRED`、已登录但非 `USER_ADMIN` `403 FORBIDDEN`。`USER_ADMIN`
专职管理账号与授权，不具备监测数据、规则、审计的任何访问权限（详见
`docs/auth.md` 角色表）。

## 执行者与审计

写操作的执行者以服务端登录账号为准。每次创建/启停/重置密码/删除/授权变更都会
在 `audit_log` 落一条对应记录（`USER_CREATE`/`USER_ENABLE`/`USER_DISABLE`/
`USER_PASSWORD_RESET`/`USER_DELETE`/`USER_ROLE_CHANGE`），`meta` 只含账号名和
变更后的角色/脱敏状态，绝不含密码或密码哈希。

## 统一错误格式

复用全局异常过滤器，错误响应形如：

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "...",
    "correlationId": "..."
  }
}
```

| 错误码                | HTTP 状态 | 触发场景                                                         |
| ---------------------- | --------- | ------------------------------------------------------------------ |
| `USER_ALREADY_EXISTS`  | 409       | `POST /api/users` 的 `username` 已存在                            |
| `USER_NOT_FOUND`       | 404       | `:username` 不存在（启停/重置密码/删除/查看或修改授权时）         |
| `LAST_USER_ADMIN_PROTECTED` | 409  | 禁用/删除/取消角色会导致系统里不再有任何 `USER_ADMIN` 账号           |
| `BAD_REQUEST`          | 400       | DTO 校验失败（两次密码不一致、密码过短、角色枚举非法、多传了 `departmentScope` 等） |

## 接口

### `GET /api/users`

分页列表，联表返回每个账号当前的授权状态。

Query 参数：`search`（账号/显示名模糊匹配）、`isActive`、`page`（默认 1）、
`pageSize`（默认 20，最大 200）。

```json
{
  "items": [
    {
      "id": "…uuid…",
      "username": "doctor",
      "displayName": "李医生",
      "isActive": true,
      "createdAt": "2026-09-11T00:00:00.000Z",
      "roles": ["VIEWER"],
      "patientDetail": false
    },
    {
      "id": "…uuid…",
      "username": "newcomer",
      "displayName": "新账号",
      "isActive": true,
      "createdAt": "2026-09-11T00:00:00.000Z",
      "roles": null,
      "patientDetail": false
    }
  ],
  "total": 2,
  "page": 1,
  "pageSize": 20
}
```

`roles: null` 表示该账号没有 `app_user_access` 记录——已登录但角色受限接口
全部 403，与 CLI 现状语义一致。

### `POST /api/users`

创建账号，不附带任何授权（需要随后调用 `PUT .../access`）。

请求体：`username`、`displayName`、`password`、`confirmPassword`（后两者需
一致，且至少 8 位）。`username` 服务端统一转小写去空格存储。

成功返回 `201` 与创建后的 `AppUserDto`（`roles: null`）。

### `PATCH /api/users/:username/status`

启用/禁用账号。请求体：`{ "isActive": boolean }`。禁用后该账号登录返回
`403 AUTH_ACCOUNT_DISABLED`，不删除任何数据。

### `POST /api/users/:username/password`

重置密码。请求体：`newPassword`、`confirmPassword`（需一致，至少 8 位）。
成功返回 `204`。该账号的 `passwordVersion` 自增，旧密码与全部旧登录会话
（Cookie 携带的 JWT）立即失效。

### `DELETE /api/users/:username`

删除账号。在一个事务内同时删除 `app_user` 与 `app_user_access` 两条记录，
不留孤儿授权行。成功返回 `204`。**不可恢复**。

### `GET /api/users/:username/access`

查看当前授权。账号存在但无授权记录时返回角色为空数组的占位对象，而不是
`404`（`404` 只用于账号本身不存在）：

```json
{
  "username": "doctor",
  "roles": [],
  "departmentScope": [],
  "patientDetail": false,
  "updatedAt": "1970-01-01T00:00:00.000Z"
}
```

### `PUT /api/users/:username/access`

整表替换角色与患者详情脱敏授权（不是合并——未包含在 `roles` 里的现有角色会
被移除，语义与 `auth:assign-access` 一致）。请求体：

```json
{ "roles": ["VIEWER", "RULE_ADMIN"], "patientDetail": false }
```

`roles` 元素须是合法 `AppRole` 枚举值（`VIEWER`/`RULE_ADMIN`/
`SYSTEM_ADMIN`/`AUDITOR`/`USER_ADMIN`）。

**`departmentScope`**：该账号此前没有授权记录（全新账号）时写入 `[]`（全院
范围）；若该账号已有授权记录且 `departmentScope` 非空（例如运维通过 CLI 的
`--departments` 设置过科室限制），本接口**保留该值不变**，不会因为这次只是
调整角色或患者详情而把科室限制静默清空。换句话说：本接口永远不会把一个非空
的科室范围加宽，只会在创建全新授权时使用全院默认值。

**移除系统最后一个 `USER_ADMIN` 会被拒绝**：若这次调用会导致 `roles` 中不再
包含 `USER_ADMIN`，且该账号是当前系统里唯一持有 `USER_ADMIN` 的账号，返回
`409 LAST_USER_ADMIN_PROTECTED`，不会写入。`PATCH .../status`（禁用）与
`DELETE /api/users/:username`（删除）对最后一个 `USER_ADMIN` 账号同样返回
该错误；只有“启用”不受此限制（启用不会减少可用管理员数量）。守卫与写操作在
同一数据库事务内完成，避免两个并发请求同时通过检查后都成功移除，导致系统
瞬间无人能管理账号。

## 与 CLI 的关系

`pnpm --filter @epgs/api auth:create-user` / `auth:reset-password` /
`auth:assign-access` / `auth:show-access` 仍然可用，作为 Web 不可用时的紧急
止血手段（例如首个 `USER_ADMIN` 账号的冷启动）。日常操作建议统一走本 API，
避免两条路径的授权状态互相覆盖造成困惑。详见 `docs/auth.md`。

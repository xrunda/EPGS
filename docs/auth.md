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

# EPGS 通知渠道/模板管理 + 发送测试 API（issue #54）

本文档描述 `apps/api/src/notifications/` 实现的通知推送配置 API：
企业微信 Webhook 渠道、推送内容模板的增删改查，以及"发送测试"接口。
为 issue #55 的前端配置页与 #56 的推送触发提供后端契约。

字段级含义参见 `apps/api/prisma/schema.prisma` 与
`docs/notification-design.md`（§3 数据模型 / §4 占位符 / §5 敏感凭证处理 /
§7 审计 / §8 接口）——本文档只补充 HTTP 层的请求/响应约定，不重复字段定义。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`
（`@nestjs/swagger`，见 `apps/api/src/main.ts`）。本文档是对其的手写补充，
着重说明业务规则、安全约束和示例。

## 鉴权

全部接口要求 Issue #31 的有效登录 Cookie；未登录或会话过期返回
`401 AUTH_REQUIRED`。

### 角色（Issue #54）

- **读取**（渠道/模板列表、`variables` 字典）：任意已登录账号。
- **写**（新增/编辑渠道与模板、发送测试）：仅 `SYSTEM_ADMIN`，否则
  `403 FORBIDDEN`（全局 `RolesGuard`）。选择 `SYSTEM_ADMIN` 而非
  `RULE_ADMIN` 的理由见 `docs/notification-design.md` §6。

### 执行者

写操作的执行者以**服务端登录账号**为准：即使请求体把 `actorId` 篡改成其他值，
落库的 `createdBy`/`updatedBy` 与审计 `actorUsername` 仍是登录账号。`actorId`
仅保留以兼容旧 DTO 形状，已被忽略。

每次创建/编辑渠道或模板都会在 `audit_log` 落一条 `CONFIG_CHANGE` 记录；
每次"发送测试"（真实外呼）落一条 `NOTIFICATION_TEST_SEND`。**审计 meta 的
硬性约束：绝不含 Webhook 地址/key 明文，也不含渲染后的消息正文**（设计 §5/§7）。

## 统一错误格式

复用 issue #1 的全局异常过滤器，所有错误响应形如：

```json
{
  "error": {
    "code": "NOTIFICATION_CHANNEL_NOT_FOUND",
    "message": "...",
    "correlationId": "...",
    "details": {}
  }
}
```

`details` 为可选字段，仅部分错误码（见下表）携带机器可读的额外上下文。

| 错误码                             | HTTP 状态 | 触发场景                                                        |
| ---------------------------------- | --------- | --------------------------------------------------------------- |
| `NOTIFICATION_CHANNEL_NOT_FOUND`   | 404       | 渠道 id 不存在（含 test-send 目标渠道）                         |
| `NOTIFICATION_TEMPLATE_NOT_FOUND`  | 404       | 模板 id 不存在                                                   |
| `NOTIFICATION_CHANNEL_DISABLED`    | 400       | test-send 目标渠道 `isEnabled=false`                             |
| `NOTIFICATION_TEMPLATE_DISABLED`   | 400       | test-send 目标模板 `isEnabled=false`                             |
| `NOTIFICATION_TEMPLATE_TITLE_REQUIRED` | 400   | `msgType=NEWS` 时标题缺失或全空白（create 与 update 合并后校验） |
| `NOTIFICATION_SEND_FAILED`         | 502       | 企业微信 Webhook 拒绝/网络失败，`details` 携带 `{wecomErrCode, wecomErrMsg}` |
| （class-validator 校验失败）       | 400       | 非法枚举、空白名称、非法 UUID、未声明字段（`forbidNonWhitelisted`）等 |

## 业务规则与安全约束

- **Webhook 地址只写不回填**（设计 §5）：渠道响应的读取字段是
  `webhookUrlMasked`（如 `https://qyapi.weixin.qq.com/...key=8d24****`，
  保留 scheme/host/path，`key=` 值前 4 字符 + `****`），**没有任何端点
  返回明文**。掩码值字段名与可写字段 `webhookUrl` 刻意不同，避免被误当
  真实地址回填。`PUT` 时 `webhookUrl` **缺失则保留原密文**，仅当业务人员
  主动粘贴新地址时才提交替换。解密失败的单行掩码回 `<unavailable>`，
  不 500 整个列表。
- **NEWS 标题必填**：`msgType=NEWS` 时 `titleTemplate` 去首尾空白后不能为空，
  否则 `400 NOTIFICATION_TEMPLATE_TITLE_REQUIRED`。该规则在**服务层**对
  create 与 update 的**合并后结果**统一校验（`TEXT→NEWS` 切换且未补标题也会
  被拒）。`msgType=TEXT` 时提交的 `titleTemplate` 被忽略并落库为 `null`。
- **渲染口径唯一**（设计 §4）：占位符数字来自 `MonitorService.summary`
  （与工作台首页统计同源），医院名来自 `HOSPITAL_NAME` 环境变量（可选，
  默认 `菏泽市中医医院`），报告日期为上海时区当日（`formatShanghaiDateTime`）。
- **停用语义**：渠道/模板可软启停（`isEnabled`）。停用后记录保留、可再次启用，
  但不能作为 test-send 的发送目标。发送失败（企业微信拒绝）不改变渠道的
  `isEnabled` 状态——`isEnabled` 只反映管理员的主动配置。

## 接口

分页约定与 rules API 一致：`page` 默认 1，`pageSize` 默认 20、上限 200；
响应信封 `{ items, total, page, pageSize }`。

### `GET /api/notification-channels`

按 `isEnabled` 筛选，分页。响应中的渠道只含 `webhookUrlMasked`。

```
GET /api/notification-channels?isEnabled=true&page=1&pageSize=20
```

响应：

```json
{
  "items": [
    {
      "id": "3f5c4a8e-b2d1-4e0f-9a5c-6b7d8e9f0a1b",
      "name": "内镜中心红色关注群",
      "webhookUrlMasked": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24****",
      "isEnabled": true,
      "createdAt": "2026-08-23T06:30:00.000Z",
      "updatedAt": "2026-08-23T06:30:00.000Z",
      "createdBy": "zhang.san",
      "updatedBy": "zhang.san"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### `POST /api/notification-channels`

```json
{
  "name": "内镜中心红色关注群",
  "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=8d24e6c4...",
  "isEnabled": true
}
```

`name`（≤100，必填）、`webhookUrl`（≤2000，必填）——服务端对明文做
AES-256-GCM 加密后落库；`isEnabled` 缺省 `true`。成功返回 `201` 及创建后的
渠道（响应只含 `webhookUrlMasked`）。

### `PUT /api/notification-channels/{id}`

```json
{
  "name": "内镜中心红色关注群（备用）",
  "isEnabled": false
}
```

全部字段可选。`webhookUrl` **只写**：提交则替换并重新加密；缺失则保留原密文。
响应永远是 `webhookUrlMasked`（变更后按新值掩码）。渠道不存在返回
`404 NOTIFICATION_CHANNEL_NOT_FOUND`。

### `GET /api/notification-templates`

按 `msgType`、`isEnabled` 筛选，分页。

```
GET /api/notification-templates?msgType=NEWS&page=1&pageSize=20
```

响应：

```json
{
  "items": [
    {
      "id": "b1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b",
      "name": "红色关注日报",
      "msgType": "NEWS",
      "titleTemplate": "内镜重点患者监测日报 · 红色关注 {{redCount}} 例",
      "contentTemplate": "{{hospitalName}} · 内镜中心\n{{reportDate}}\n红色 {{redCount}} · 黄色 {{yellowCount}} · 绿色 {{greenCount}} · 未分级 {{unclassifiedCount}}",
      "coverImageUrl": null,
      "linkUrl": "http://10.0.0.5/workbench",
      "isEnabled": true,
      "createdAt": "2026-08-23T07:00:00.000Z",
      "updatedAt": "2026-08-23T07:00:00.000Z",
      "createdBy": "zhang.san",
      "updatedBy": "zhang.san"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

### `POST /api/notification-templates`

```json
{
  "name": "红色关注日报",
  "msgType": "NEWS",
  "titleTemplate": "内镜重点患者监测日报 · 红色关注 {{redCount}} 例",
  "contentTemplate": "{{hospitalName}} · 内镜中心\n{{reportDate}}\n红色 {{redCount}} · 黄色 {{yellowCount}} · 绿色 {{greenCount}} · 未分级 {{unclassifiedCount}}",
  "coverImageUrl": null,
  "linkUrl": "http://10.0.0.5/workbench",
  "isEnabled": true
}
```

`name`（≤100）、`msgType`（`TEXT`|`NEWS`）、`contentTemplate`（必填）为必填；
`titleTemplate` ≤200，`NEWS` 必填、`TEXT` 忽略（落库 `null`）；
`coverImageUrl`/`linkUrl` 可选（`NEWS` 时使用，仅作展示占位——当前医院内网
未与企业微信打通，内网链接暂不可达）；`isEnabled` 缺省 `true`。成功返回
`201` 及创建后的模板。

### `PUT /api/notification-templates/{id}`

```json
{
  "name": "红色关注日报（改）",
  "msgType": "TEXT"
}
```

全部字段可选。`NEWS` 标题必填规则按**合并后结果**校验：`TEXT→NEWS` 切换时
若未带非空 `titleTemplate` 同样 `400 NOTIFICATION_TEMPLATE_TITLE_REQUIRED`；
`NEWS→TEXT` 切换会把 `titleTemplate` 落为 `null`。模板不存在返回
`404 NOTIFICATION_TEMPLATE_NOT_FOUND`。

### `GET /api/notification-templates/variables`

返回固定占位符字典（7 项，前端"插入变量"下拉的数据源）。注意该路由需在
`:id` 之前声明以免被参数路由吞掉——已按此顺序实现。

```json
[
  { "key": "reportDate", "label": "报告日期", "example": "2026-08-23" },
  { "key": "hospitalName", "label": "医院名称", "example": "菏泽市中医医院" },
  { "key": "redCount", "label": "红色关注数量", "example": "3" },
  { "key": "yellowCount", "label": "黄色关注数量", "example": "7" },
  { "key": "greenCount", "label": "绿色关注数量", "example": "12" },
  { "key": "unclassifiedCount", "label": "未分级数量", "example": "45" },
  { "key": "totalCount", "label": "检查记录总数", "example": "67" }
]
```

### `POST /api/notification-channels/{id}/test-send`

```json
{ "templateId": "b1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b" }
```

流程：加载渠道与模板（不存在/停用 → `404`/`400`，**不发起真实外呼，也不记
test-send 审计**）→ 用当前真实数据渲染 → 解密 Webhook URL → POST 到企业微信
Webhook。渲染统计口径受调用者 `departmentScope` 约束（空 = 全局）。

响应（发送成功，`200`——`errcode==0`）：

```json
{
  "success": true,
  "renderedTitle": "",
  "renderedContent": "菏泽市中医医院 · 内镜中心\n2026-08-23\n红色 3 · 黄色 7 · 绿色 12 · 未分级 45",
  "sentAt": "2026-08-23T08:30:00.000Z"
}
```

`renderedTitle` 在 `msgType=TEXT` 时恒为 `''`。

响应（企业微信拒绝或网络失败，`502`）：

```json
{
  "error": {
    "code": "NOTIFICATION_SEND_FAILED",
    "message": "企业微信返回错误",
    "correlationId": "...",
    "details": { "wecomErrCode": 93000, "wecomErrMsg": "invalid webhook url" }
  }
}
```

**审计**：仅真实外呼记 `NOTIFICATION_TEST_SEND`——成功 meta
`{channelId, templateId, result:'success', httpStatus:200}`；失败 meta
`{channelId, templateId, result:'failure', httpStatus:502, wecomErrCode,
wecomErrMsg}`。meta 一律不含渲染正文；Webhook 地址/key 只出现在出站请求里，
不进日志、异常消息或审计（设计 §5/§7）。

## 测试

- 单元测试（mock Prisma / undici MockAgent，无需数据库）：
  - `apps/api/src/notifications/notifications.service.spec.ts`——CRUD、掩码、
    密文保留/替换、损坏密文 `<unavailable>` 占位、NEWS 标题规则。
  - `apps/api/src/notifications/notification-test-send.service.spec.ts`——
    TEXT/NEWS 渲染、summary 复用、disabled/not-found 分支、WeCom 错误包装。
  - `apps/api/src/notifications/wecom-webhook-sender.spec.ts`——两种载荷形状
    （TEXT→markdown、NEWS→news）、POST 目标、`errcode≠0`、HTTP 错误、非
    JSON、超时；断言异常消息不含 key。
  - `apps/api/src/notifications/notifications.controller.spec.ts`——写操作
    `CONFIG_CHANGE` 审计、test-send 成败审计 + rethrow、404 不审计、
    scope 透传。
- 端到端测试（需要真实 Postgres，已应用 #53 迁移）：
  `apps/api/test/notifications.e2e-spec.ts`。覆盖渠道/模板全生命周期、掩码
  断言、`PUT` 不带 `webhookUrl` 保留密文、`variables` 7 项、NEWS 无标题 400、
  test-send 成功（渲染数字与 `GET /api/monitor/summary` 一致）+ 502 +
  disabled/404、`VIEWER`/`RULE_ADMIN` 写 `403`。`WecomWebhookSender` 被
  fake 替换，测试不触碰真实网络；fake 记录载荷以断言解密后的 URL 与渲染
  markdown 形状。该文件在检测不到可用 Postgres 时每个用例直接判定通过
  （no-op），不会导致无数据库 CI 任务失败；CI 中真正执行在 `.github/
  workflows/ci.yml` 的 `db-migrations` job。

本地验证 real Postgres 的临时实例创建方式（镜像 rules-api.md 配方）：

```bash
initdb -D /tmp/epgs-pgdata -U epgs --auth=trust -E UTF8
pg_ctl -D /tmp/epgs-pgdata -o "-p 5544 -k /tmp" -l /tmp/epgs-pg.log start
createdb -h /tmp -p 5544 -U epgs epgs
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec prisma migrate deploy
DATABASE_URL=postgresql://epgs@localhost:5544/epgs pnpm --filter api exec jest --config ./test/jest-e2e.json test/notifications.e2e-spec.ts
pg_ctl -D /tmp/epgs-pgdata stop
rm -rf /tmp/epgs-pgdata /tmp/epgs-pg.log
```

## 待确认事项（本 issue 不擅自决定）

1. **渠道/模板名称是否要求唯一**——当前允许重名，见设计 §3/§9。
2. **test-send 的频率限制**——是否需要服务端防抖/限流，见设计 §9。
3. **定时自动推送**——V1 明确不做（设计 §2），待业务方确认触发时机后另开
   issue，复用 `apps/worker` 的重排 setTimeout 任务模式。
4. **封面图自动生成**——V1 仅支持静态 `coverImageUrl`（设计 §2）。

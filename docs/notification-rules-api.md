# EPGS 定时推送规则 API（定时推送 V1）

本文档描述 `apps/api/src/notifications/` 实现的**定时推送规则** HTTP 契约：
规则的增删改查、手动补推（「立即执行一次」）、以及推送日志查询。
定时扫描与执行的实现见 `apps/worker/src/notification-push/`，共享发送链路在
`packages/notification-push/`。字段级含义参见 `apps/api/prisma/schema.prisma`
与 `docs/notification-design.md`（§2.1 / §3）——本文档只补充 HTTP 层的
请求/响应约定，不重复字段定义。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`。本文档是对
其的手写补充，着重说明业务规则、安全约束和示例。

## 鉴权

与渠道/模板 API 一致（`docs/notification-api.md`）：要求 Issue #31 的有效
登录 Cookie；未登录或会话过期返回 `401 AUTH_REQUIRED`。

- **读取**（规则列表/详情/推送日志）：任意已登录账号。
- **写**（新增/编辑规则、「立即执行一次」）：仅 `SYSTEM_ADMIN`，否则
  `403 FORBIDDEN`（全局 `RolesGuard`）。

执行者以**服务端登录账号**为准，请求体中的 `actorId` 已废弃、被忽略
（同 `notification-api.md`）。

每次创建/编辑规则落一条 `CONFIG_CHANGE` 审计；每次手动补推落一条
`NOTIFICATION_RULE_RUN` 审计，meta 为 `{result, status, pushLogId}`（`result`
= `executed` 或 `already_pushed`）。**定时推送不写审计**——定时执行没有操作
人，`push_log` 即其审计轨迹。审计 meta 绝不含 Webhook 地址/渲染正文（设计
§7）。规则不存在时的手动补推不落审计。

## 统一错误格式

复用 issue #1 的全局异常过滤器，所有错误响应形如：

```json
{
  "error": {
    "code": "NOTIFICATION_RULE_NOT_FOUND",
    "message": "...",
    "correlationId": "..."
  }
}
```

| 错误码                            | HTTP 状态 | 触发场景                                               |
| --------------------------------- | --------- | ------------------------------------------------------ |
| `NOTIFICATION_RULE_NOT_FOUND`     | 404       | 规则 id 不存在（读取/编辑/补推/查日志）                |
| `NOTIFICATION_TEMPLATE_NOT_FOUND` | 404       | 规则引用的模板 id 不存在                                |
| `NOTIFICATION_CHANNEL_NOT_FOUND`  | 404       | 规则 `channelIds` 中的渠道 id 不存在                    |
| `NOTIFICATION_RULE_NO_CHANNELS`   | 400       | `channelIds` 为空（`ArrayMinSize(1)` 之外的 service 兜底） |
| `BAD_REQUEST`                     | 400       | DTO 校验失败，如非法 cron（`message` 含 "cron"）、非法 UUID、`windowDate` 非 `YYYY-MM-DD` |

> 手动补推的**执行失败**（渠道/模板被停用、Webhook 调用失败等）不抛 HTTP
> 错误：`POST :id/run` 仍返回 `200`，`status` 为 `FAILED`/`PARTIAL`，
> 失败细节记录在 `push_log` / `push_delivery`（前端日志弹窗可见）。非法
> `windowDate`（如 `2026-02-30`）同样按一次 FAILED 运行落库，绝不 500。

## 接口一览

| 方法 | 路径                          | 角色       | 说明                             |
| ---- | ----------------------------- | ---------- | -------------------------------- |
| GET  | `/api/notification-rules`     | 任意登录   | 规则列表（可按启用状态筛选，分页） |
| POST | `/api/notification-rules`     | SYSTEM_ADMIN | 新建规则                       |
| GET  | `/api/notification-rules/:id` | 任意登录   | 规则详情                         |
| PUT  | `/api/notification-rules/:id` | SYSTEM_ADMIN | 编辑规则（`channelIds` 全量替换） |
| POST | `/api/notification-rules/:id/run` | SYSTEM_ADMIN | 手动补推（立即执行一次）      |
| GET  | `/api/notification-rules/:id/push-logs` | 任意登录 | 推送日志（含逐渠道明细，分页） |

## GET /api/notification-rules

查询参数：

| 参数       | 类型     | 默认 | 说明                          |
| ---------- | -------- | ---- | ----------------------------- |
| `isEnabled`| boolean  | —    | 只返回启用/停用规则           |
| `page`     | int ≥1   | 1    | 页码                          |
| `pageSize` | int 1–200| 20   | 每页条数                      |

响应 200：

```json
{
  "items": [
    {
      "id": "e6ad80f0-5fae-477d-b13e-184331f2ad28",
      "name": "每日 9 点推送到总值班室群",
      "cron": "0 9 * * *",
      "templateId": "16854446-6b57-4f84-b446-b99060181632",
      "templateName": "每日汇总",
      "channels": [
        { "id": "6ad137e8-d2d0-4273-8c22-430340d7c4ff",
          "channelId": "340059b0-e98c-465a-bd29-b5df770e6683",
          "name": "总值班室群" }
      ],
      "isEnabled": true,
      "createdAt": "2026-08-23T06:34:48.725Z",
      "updatedAt": "2026-08-23T06:34:48.725Z",
      "createdBy": "dev",
      "updatedBy": "dev"
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

## POST /api/notification-rules

请求体：

| 字段          | 类型     | 必填 | 说明                                                        |
| ------------- | -------- | ---- | ----------------------------------------------------------- |
| `name`        | string≤100 | 是 | 规则名称                                                    |
| `cron`        | string≤100 | 是 | **5 字段** cron 表达式（分 时 日 月 周），**Asia/Shanghai** 求值 |
| `templateId`  | UUID     | 是   | 推送模板 id（`msgType` 决定 TEXT text / NEWS news 发送）|
| `channelIds`  | UUID[]≥1 | 是   | 绑定的渠道 id 列表；一条规则推送到每个选中渠道（M:N）        |
| `isEnabled`   | boolean  | 否   | 默认 `true`；`false` 时定时扫描跳过，但可手动补推            |
| `actorId`     | string   | 否   | 已废弃，被忽略（兼容旧 DTO）                                |

响应 201：完整 `NotificationRuleDto`（同上，`channels` 按绑定顺序）。

`cron` 校验：非法 5 字段表达式 → 400 `BAD_REQUEST`（`message` 含 "cron"）。
时区一律按 Asia/Shanghai，不受服务器进程 TZ 影响。

## PUT /api/notification-rules/:id

请求体：`POST` 的同名字段全部可选；**`channelIds` 一旦出现即全量替换**绑定
集合（至少 1 个）。响应 200：更新后的 `NotificationRuleDto`。

## POST /api/notification-rules/:id/run（立即执行一次）

查询参数：

| 参数         | 类型     | 默认 | 说明                                                        |
| ------------ | -------- | ---- | ----------------------------------------------------------- |
| `windowDate` | `YYYY-MM-DD` | 今天（Asia/Shanghai） | 推送哪个上海日的「今日新报告」汇总；支持历史补推 |

语义：
- 手动补推**永远允许**（幂等只约束定时推送，不影响手动）。渠道/模板停用时
  手动补推照常尝试，失败记录到日志。
- 「今日新报告」口径：`monitor_record.examTime` 落在该上海日
  `00:00:00+08:00 ≤ examTime < 次日 00:00:00+08:00` 的记录按 `currentLevel`
  计数，渲染进模板变量（`redCount/yellowCount/greenCount/totalCount`）。
  `windowDate` 缺省时与定时推送同口径（今日）；**这不是** test-send 的全量
  计数口径，两者有意的不同。
- 响应 200：

```json
{
  "alreadyPushed": false,
  "pushLogId": "9150a473-0491-45d2-b477-f9756c287d92",
  "status": "SUCCESS",
  "deliveries": [
    { "id": "f18ac78d-4b15-4dbc-87f1-6d5870a13ce3",
      "channelId": "340059b0-e98c-465a-bd29-b5df770e6683",
      "channelName": "总值班室群",
      "status": "SUCCESS",
      "wecomErrCode": null,
      "wecomErrMsg": null,
      "sentAt": "2026-08-23T06:35:42.546Z" }
  ]
}
```

`status` 聚合：所有渠道 SUCCESS → `SUCCESS`；部分成功部分失败 → `PARTIAL`；
全部失败 → `FAILED`。`alreadyPushed` 在手动补推下总是 `false`（保留字段，
供共享 executor 的定时路径使用）。

## GET /api/notification-rules/:id/push-logs

查询参数：`page` / `pageSize`（同列表）。响应 200：

```json
{
  "items": [
    {
      "id": "0e0be619-9d2c-42dc-a048-bacba35b102a",
      "ruleId": "e6ad80f0-5fae-477d-b13e-184331f2ad28",
      "windowDate": "2026-08-23",
      "trigger": "SCHEDULED",
      "status": "SUCCESS",
      "errorSummary": null,
      "startedAt": "2026-08-23T06:38:24.618Z",
      "finishedAt": "2026-08-23T06:38:24.700Z",
      "deliveries": [
        { "id": "0b202a6a-d819-44c4-acf3-4238f538fcf1",
          "channelId": "340059b0-e98c-465a-bd29-b5df770e6683",
          "channelName": "总值班室群",
          "status": "SUCCESS",
          "wecomErrCode": null,
          "wecomErrMsg": null,
          "sentAt": "2026-08-23T06:38:24.618Z" }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 20
}
```

`trigger`：`SCHEDULED`（worker 定时扫描执行）\| `MANUAL`（页面「立即执行
一次」）。`status`：`SUCCESS` \| `PARTIAL` \| `FAILED`（运行进行中时为
`null`）。`wecomErrMsg` 只含企业微信返回的错误文案，**绝不含 webhook URL/
key**。

## 幂等说明（定时路径，非 HTTP 契约）

定时推送由 worker 每分钟 tick 扫描启用规则，cron 命中且该规则**今日
`windowDate` 未自动推过**才执行；重复触发被
`uq_push_log_scheduled_dedup` 部分唯一索引（`rule_id, window_date`
WHERE `trigger='SCHEDULED'`）+ P2002 吞处理双重保证。手动补推不受此约束，
且同一规则一天内可手动补推多次。

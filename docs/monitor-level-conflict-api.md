# EPGS 关注等级分歧 API（issue #103）

本文档描述 `apps/api/src/level-conflicts/` 实现的「关注等级分歧」待办 API：列出
关键词规则与整份报告判读在同一处给出**不同关注等级**的配置组合，以及标记某一条
已读/未读。判定规则本身与医生端那句提醒的关系见
[ai-semantic-monitor-design.md](./ai-semantic-monitor-design.md) §等级分歧；工作台
只读接口新增的 `levelConflicts` 字段见 [api/monitor-api.md](./api/monitor-api.md)。

自动生成的 OpenAPI/Swagger UI：应用启动后访问 `GET /api/docs`。

## 什么是「关注等级分歧」

关键词侧（`monitor_match`）和整份报告判读侧（`monitor_report_ai_*`）**落在同一列、
区间相交**，但两边给出的关注等级不同，就是一条分歧。判定只有一份实现
（`apps/api/src/monitor/level-conflict.ts` 的 `findLevelConflicts`），医生端提醒与
本列表共用它 —— 不允许出现第二份判定（包括写成 SQL）。

三条边界：

- **落在同一列**才比。关键词侧存的是实际命中的那一列，只有 `FINDINGS`（报告内容）
  与 `IMPRESSION`（诊断）两侧都有文本来源，其余组合（含 AI 的 `EXAM_ITEM`）恒不配对。
- **区间相交**才算（首尾相接 `end === start` 不算）。关键词侧偏移缺失（#87 之前的
  历史数据）时退回「AI 证据原文包含该关键词」，重算不出来就不配对（保守，宁可漏报）。
- **等级不同**才报。相等即一致，不提示。

分歧说明的是**配置**对不上（规则的等级划高了，或那条情况的等级划低了），不是报告
有问题、更不是诊断分歧。等级是管理上的关注等级，不是病情严重程度。

## 不是闭环（issue #26）

表名与路由用 `read`、文案用「已读/未读」，**刻意避开**上报/知晓/处理/误报/日报
那套词。原因：这里标记的是**配置组合**（键 = 规则组 + 语义组 + 列 + 两个等级），
意思是「有管理员看过这组配置了」，**不是**「这位患者的报告被阅读或处置过」。
本接口不接收也不返回任何记录 ID、患者信息或报告正文，
`apps/api/src/security/closed-loop-absence.spec.ts` 的红线门禁照旧通过。

## 鉴权

全部接口要求有效登录 Cookie 且持有 `RULE_ADMIN` 角色：未登录 `401 AUTH_REQUIRED`，
已登录但非 `RULE_ADMIN` `403 FORBIDDEN`。**读也要求 RULE_ADMIN**——与 `/api/rules`
（读对所有登录用户开放）不同：分歧是一处配置缺陷，这个列表是给能改它的人的待办，
给医生看等于把一件他做不了的事推到他面前。控制器上挂的是**类级** `@RequireRoles`，
fail-closed：以后往这个控制器里加路由会默认继承它。

## 审计

两个写操作各落一条审计：`MONITOR_LEVEL_CONFLICT_READ` / `MONITOR_LEVEL_CONFLICT_UNREAD`，
执行者取服务端登录账号（`@CurrentUser()`，前端传什么都不作数）。`resourceId` 恒为
`null`——该列是 Uuid，而分歧键不是；键进 `meta`，只含配置键与两个等级，**不含患者
数据**。列表查询不单独审计：它是一次配置查看，审计的价值在于回答「谁把哪个状态改成
了什么」。

## 统一错误格式

复用全局异常过滤器：

```json
{
  "error": {
    "code": "BAD_REQUEST",
    "message": "...",
    "correlationId": "..."
  }
}
```

| 错误码         | HTTP 状态 | 触发场景                                                                   |
| -------------- | --------- | -------------------------------------------------------------------------- |
| `AUTH_REQUIRED`| 401       | 未登录                                                                     |
| `FORBIDDEN`    | 403       | 已登录但非 `RULE_ADMIN`                                                    |
| `BAD_REQUEST`  | 400       | 查询参数非法（`days` 越界、`read` 不是布尔、多传了未知参数）或 `:conflictKey` 形状不合法 |

## 接口

### `GET /api/monitor/level-conflicts`

待办列表。**不分页**，见下方「为什么不分页」。

Query 参数：

| 参数   | 类型    | 默认 | 说明                                                                 |
| ------ | ------- | ---- | -------------------------------------------------------------------- |
| `days` | integer | 90   | 统计窗口（最近 N 天，含今天），范围 1..365，越界返回 400（不静默截断） |
| `read` | boolean | 省略 | `true` 只看已读、`false` 只看未读；省略 = 都看                        |

`read` 的解析注意一处**已修的坑**：全局 `ValidationPipe` 打开了
`enableImplicitConversion`，隐式转换会在自定义 `@Transform` **之前**跑一遍
`Boolean(value)`，于是裸写 `@Transform(({ value }) => value === 'true')` 会把
`?read=false` 变成 `true`。本 DTO（`list-level-conflicts.query.dto.ts`）从原始对象
读字符串再判定，并有专门的 spec 用真实 `ValidationPipe` 钉住这个行为。**其余 5 个
列表 DTO（rules / users / attention-semantics / notifications ×2）目前仍是错的写法**，
见 issue #103 的 PR 说明，本 PR 不顺手改（避免夹带无关修改）。

响应：

```json
{
  "items": [
    {
      "conflictKey": "«规则组 uuid»:«语义组 uuid»:FINDINGS:YELLOW:RED",
      "keyword": "腺癌",
      "keywordLevel": "YELLOW",
      "semanticName": "明确或高度疑似恶性病变",
      "semanticLevel": "RED",
      "field": "FINDINGS",
      "recordCount": 4,
      "lastSeenAt": "2026-09-26T02:30:00.000Z",
      "readAt": null
    }
  ],
  "days": 90,
  "unreadCount": 1
}
```

- `conflictKey` 由**组 ID + 列 + 两个等级**拼成，跨版本稳定：规则/语义改文字会生成
  新版本行，用版本行做键会让每次改词都变成一条「新问题」，已经核对过的人反复看到
  它诈尸。**等级变了键就变**——那是真的另一种分歧。
- `recordCount` 是窗口内出现该分歧的记录数，也是这个列表唯一的量级感；
  `lastSeenAt` 是其中最近一条的时间。
- 排序：未读优先，其次 `lastSeenAt` 倒序。
- 响应里**没有任何患者信息**：一个关键词、一个配置名、两个等级、一个列名和两个数字。

**为什么不分页**：条目数是**配置规模**的函数（≤ 规则组 × 语义组 × 3 × 3），不是
记录数的函数，边界由管理员手工控制。仓库里另外两个分页列表（`rules`、
`attention-semantics`）是按行增长的表，这个不会。

### `PUT /api/monitor/level-conflicts/:conflictKey/read`

标记已读。**幂等**：重复标记只更新时间戳。`:conflictKey` 是 url-safe 的键（uuid +
3 字母等级，`:` 需按 `encodeURIComponent` 编码）。

响应（不返回 204，客户端据此就地更新那一行，不必整表重取）：

```json
{ "conflictKey": "…", "readAt": "2026-09-27T08:00:00.000Z" }
```

### `DELETE /api/monitor/level-conflicts/:conflictKey/read`

标回未读。**双向幂等**：键不存在也返回成功（`readAt: null`），因为请求的状态本就成立。

## 只存已读状态，不落待办副本

`monitor_level_conflict_read` 只存「谁在什么时候标记了哪一组」，列表每次用同一套
`findLevelConflicts` 从既有记录实算。这样避免两个事实来源，也避免待办表与判定规则
各自漂移。字段见 [data-dictionary.md](./data-dictionary.md)。

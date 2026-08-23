# EPGS 消息推送模块设计

> 状态：已按本设计拆分落地。
> - issue #53：数据模型 + Webhook URL 加密（`NotificationChannel` /
>   `NotificationTemplate` / `NotificationMsgType` / `NotificationSecretCipher`）。
> - issue #54：§8 的全部 HTTP API 已实现并附 e2e 测试——接口契约以
>   `docs/notification-api.md` 为准（本节的响应示例可能略旧），读取字段按
>   §5 收敛为 `webhookUrlMasked`，`PUT` 的 `webhookUrl` 只写不回填。
> - 尚未实现：定时/自动推送（§2 明确 V1 不做）。
> - **2026-08-23 范围修订**：配置页前端 V1 只开放文本（`TEXT`）消息类型，
>   图文（`NEWS`）标为"待开发"（前端隐藏入口）。API 与发送能力（含
>   Webhook news 发送）均保留，未来开放时只需放开前端入口。

## 1. 背景与目标

系统已在医院内网稳定运行（issue #1–#38 交付的 MVP），但业务方缺少主动
触达机制——目前只能靠人工打开工作台查看红/黄/绿关注患者。医院内部使用
企业微信作为日常沟通工具，希望系统能把当日重点患者摘要**主动推送**到
企业微信群，而不是完全依赖人工登录查看。

通过手动构造真实请求验证：企业微信自建应用消息接口默认要求"企业可信
IP"白名单，配置该白名单又要求先绑定已备案域名/可信域名，形成循环依赖，
不适合当前无公网域名的内网部署场景。**群机器人 Webhook**
（`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...`）不受此限制，
markdown 与 news（图文）两种消息类型均已通过真实发送验证，是当前唯一
可行的推送方式。本设计基于 Webhook 机制。

医院内网与企业微信之间目前**不互通**（无出站白名单、无专线/VPN）——
本模块只解决"系统内如何配置和触发推送"，网络打通是另一个独立问题，
不在本设计范围内。

## 2. V1 范围

**做什么**：

- 在系统内配置任意数量的推送渠道（企业微信 Webhook 地址）。
- 在系统内配置任意数量的推送内容模板（文字 `TEXT` 或图文 `NEWS` 两种
  消息类型），模板正文/标题/跳转链接支持插入动态数据占位符。
  > 2026-08-23 修订：配置页前端只开放 `TEXT`，`NEWS` 标为"待开发"——前端
  > 不提供图文入口；API 与发送能力保留（见页首状态块）。
- 提供"发送测试"操作：选择一个渠道 + 一个模板的组合，用当前真实数据
  渲染后同步发送，用于人工验证内容与渠道是否符合预期。

**不做**（明确排除，避免范围蔓延）：

- **不做定时/自动触发推送**。触发时机（每日几点、什么条件触发）属于
  业务规则，尚未与业务方确认；且自动化一旦配置错误就是每天对医生造成
  骚扰，风险与收益不对称。V1 只做"人工点按钮触发"，验证内容/渠道本身
  是否有价值后，再评估是否要做定时任务。
- **不做封面图自动生成**。`NEWS` 消息的封面图 V1 仅支持业务人员填写
  静态图片 URL（如医院/科室 logo）。按当日数据动态渲染统计图（此前
  手动验证用 HTML→PNG→图床的方式）技术链路更长（需要引入渲染依赖 +
  图片托管），列为 V2 候选，不在 V1 实现。
- **不做"渠道组"或"渠道-模板绑定"实体**。发送测试时临时选择渠道与
  模板的组合，不预先绑定。多数场景下这已经够用；若后续出现"每次都要
  固定发给这几个群"的高频诉求，再补一层绑定关系，不在 V1 预判。
- **不做规则式的版本化**（对比 `MonitorRule` 的版本化+软停用模式）。
  Webhook 地址和模板内容修改后不需要追溯"历史某条消息用的是哪个版本"
  ——这与监测规则不同：规则版本化是为了让历史 `monitor_match` 可追溯
  判定依据，而推送配置纯粹是"当前往哪投、发什么"，改了就是改了。

## 3. 数据模型

### `notification_channel` — 推送渠道

| 字段          | 类型         | 敏感级别 | 说明                                             |
| ------------- | ------------ | -------- | ------------------------------------------------ |
| `id`          | UUID PK      | LOW      | 主键                                              |
| `name`        | varchar(100) | LOW      | 渠道名称（如"内镜中心红色关注群"），业务可读标识  |
| `webhookUrl`  | text         | **HIGH** | 企业微信 Webhook 地址（含 key）；**加密存储**，见 §5 |
| `isEnabled`   | boolean      | LOW      | 软启停；停用后不可作为发送目标，但记录保留        |
| `createdAt`/`updatedAt` | timestamptz | LOW | 审计时间戳                                    |
| `createdBy`/`updatedBy` | varchar(100) | MEDIUM | 操作人账号                                  |

不做版本化（理由见 §2）。同一渠道名称是否要求唯一，待评审确定——倾向
不强制唯一（允许"内镜中心群（备用）"这类命名），只在前端列表里提示。

### `notification_template` — 推送内容模板

| 字段               | 类型         | 敏感级别 | 说明                                                  |
| ------------------ | ------------ | -------- | ----------------------------------------------------- |
| `id`               | UUID PK      | LOW      | 主键                                                    |
| `name`             | varchar(100) | LOW      | 模板名称（如"红色关注日报"）                            |
| `msgType`          | enum         | LOW      | `TEXT` \| `NEWS`（对应企业微信 Webhook 的 markdown/news） |
| `titleTemplate`    | varchar(200)?| LOW      | 标题模板（`NEWS` 必填；`TEXT` 不使用）                  |
| `contentTemplate`  | text         | LOW      | 正文/摘要模板，含占位符（见 §4）                        |
| `coverImageUrl`    | text?        | LOW      | 封面图静态地址（`NEWS` 时使用；V1 无动态生成，见 §2）   |
| `linkUrl`          | text?        | LOW      | 点击跳转地址（`NEWS` 时使用；当前医院内网未打通，指向内网地址暂不可达，仅作展示占位） |
| `isEnabled`        | boolean      | LOW      | 软启停                                                  |
| `createdAt`/`updatedAt` | timestamptz | LOW  | 审计时间戳                                              |
| `createdBy`/`updatedBy` | varchar(100) | MEDIUM | 操作人账号                                        |

模板内容本身（标题/正文文案措辞）判定为 LOW——不含患者数据，只是文案
结构；渲染后发送出去的**实际消息内容**（含当日统计数字）不落库，只在
发送时临时生成，避免和 `monitor_record`/`monitor_match` 产生数据冗余。

## 4. 占位符机制

模板文本中允许插入固定格式的占位符，如 `{{redCount}}`、`{{reportDate}}`。
可用占位符来自后端维护的**固定字典**（非用户自定义变量名），避免业务
人员需要理解底层数据结构或查询逻辑：

```
GET /api/notification-templates/variables
```

返回类似：

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

前端模板编辑表单在正文/标题输入框旁提供"插入变量"下拉，选中后插入
对应的 `{{key}}` 到光标位置，业务人员不需要记忆或手写占位符语法。

**扩展方式**：新增一个统计口径（如"科室名"、"7 日环比"）只需在后端
字典里加一项并实现对应取值逻辑，前端下拉自动出现，不需要改前端代码
——这是"易扩展"的落地点。

占位符取值口径**必须复用** `GET /api/monitor/summary` 的统计逻辑
（issue #7），保证推送消息里的数字与工作台首页展示的统计卡片一致，
不允许推送模块另起一套统计查询。

## 5. 敏感凭证处理（Webhook URL）

这是本项目首次需要在数据库中存储**可逆**敏感凭证（对比：`app_user.
passwordHash` 是 Argon2id 单向哈希，`JWT_SECRET`/`PACS_HTTP_SERVICE_
TOKEN` 是环境变量、从未落库）。现有基础设施没有可直接复用的加解密
方案，需要新增：

- **加密存储**：应用层对称加密（如 AES-256-GCM），加密密钥来自新增
  环境变量 `NOTIFICATION_SECRET_KEY`（不落库，管理级别对齐
  `JWT_SECRET`），启动时经 Joi 校验必填。
- **脱敏展示**：`GET` 接口返回渠道列表/详情时，`webhookUrl` 只回显
  掩码形式（如 `https://qyapi.weixin.qq.com/...key=8d24****`），不
  回传可用于重放的明文。
- **只写不回填**：编辑渠道时，若不修改 Webhook 地址，前端不需要（也
  拿不到）明文回填；仅当业务人员主动粘贴新地址时才提交更新。这是
  常见的"密码类"字段处理模式的变体。
- **审计**：`webhookUrl` 明文**禁止**出现在 `audit_log.meta`
  （对齐 data-dictionary.md 的既有原则——meta 只含低敏感字段）。

## 6. 权限

复用现有 `AppRole` 枚举，不新增角色：

- **读取**（渠道/模板列表、可用占位符字典）：任意已登录账号，与
  `monitor_rule` 读取权限一致。
- **写**（新增/编辑/启停渠道与模板、发送测试）：仅 `SYSTEM_ADMIN`。
  选择 `SYSTEM_ADMIN` 而非 `RULE_ADMIN`——推送配置涉及系统对外集成
  和敏感凭证写入，语义上不同于 `RULE_ADMIN` 负责的业务判定口径维护。

## 7. 审计

复用 `AuditAction` 枚举中已预留的 `CONFIG_CHANGE`（见 `audit_log`
表设计注释"issue #31 / future config-write endpoints"），用于渠道/
模板的创建、编辑、启停。

新增一个审计动作 `NOTIFICATION_TEST_SEND`，用于"发送测试"操作——这是
一次真实的对外数据推送（哪怕是测试性质），必须独立于普通配置变更留痕：
记录操作人、时间、目标渠道 id、模板 id、发送结果（成功/失败/HTTP 状态
码），**不记录渲染后的消息正文**（可能含当日患者统计数字组合，虽然
不是患者姓名等直接标识信息，但从审慎角度不必要地扩大 audit_log 的
数据面）。

## 8. HTTP 接口（已实现，issue #54）

已全部落地于 `apps/api/src/notifications/`，e2e 见
`apps/api/test/notifications.e2e-spec.ts`。接口契约以
`docs/notification-api.md` 为准；与本节草案的差异已在状态头与下方注明。

参考 `docs/rules-api.md` 的既有惯例：统一错误格式、`RolesGuard` 鉴权、
执行者以服务端登录账号为准（body 中 `actorId` 已废弃、忽略）。

| 接口                                             | 方法 | 权限          | 说明                       |
| ------------------------------------------------ | ---- | ------------- | -------------------------- |
| `/api/notification-channels`                     | GET  | 任意已登录     | 渠道列表（分页信封），只回 `webhookUrlMasked` |
| `/api/notification-channels`                     | POST | SYSTEM_ADMIN  | 新增渠道（webhookUrl 加密存储） |
| `/api/notification-channels/{id}`                | PUT  | SYSTEM_ADMIN  | 编辑渠道（含启停）；`webhookUrl` 只写不回填，缺失保留原密文 |
| `/api/notification-templates`                    | GET  | 任意已登录     | 模板列表（分页信封，可按 msgType/启停过滤） |
| `/api/notification-templates`                    | POST | SYSTEM_ADMIN  | 新增模板                    |
| `/api/notification-templates/{id}`                | PUT  | SYSTEM_ADMIN  | 编辑模板（含启停）          |
| `/api/notification-templates/variables`           | GET  | 任意已登录     | 可用占位符字典（见 §4）     |
| `/api/notification-channels/{id}/test-send`       | POST | SYSTEM_ADMIN  | 用指定模板渲染当日数据并同步发送，见下 |

实现与草案的差异：读取字段按 §5 收敛为 `webhookUrlMasked`（掩码
`key=` 值前 4 字符 + `****`，解密失败回 `<unavailable>` 占位、不 500 列表）；
`PUT` 的 `webhookUrl` 为**只写**字段——提交则替换并重新加密，缺失则保留
原密文，响应永远只含 `webhookUrlMasked`，因此前端无需（也无法）回填明文。

`POST /api/notification-channels/{id}/test-send` 请求体：

```json
{ "templateId": "b1f2...uuid" }
```

响应（发送成功）：

```json
{
  "success": true,
  "renderedTitle": "内镜重点患者监测日报 · 红色关注 3 例待复核",
  "renderedContent": "菏泽市中医医院 · 内镜中心\n2026-08-23\n红色 3 · 黄色 7 · 绿色 12 · 未分级 45",
  "sentAt": "2026-08-23T08:30:00.000Z"
}
```

响应（企业微信侧返回错误，如 Webhook key 失效）：

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

实现附加语义：

- **HTTP 状态**：`200` = 企业微信已接收（`errcode==0`）；`502` = 企业微信
  拒绝/网络失败，`NOTIFICATION_SEND_FAILED` 的 `details` 透传
  `{wecomErrCode, wecomErrMsg}`。渠道/模板不存在或停用 → `404`/`400`
  （`NOTIFICATION_CHANNEL_NOT_FOUND` / `NOTIFICATION_TEMPLATE_NOT_FOUND` /
  `NOTIFICATION_CHANNEL_DISABLED` / `NOTIFICATION_TEMPLATE_DISABLED`），
  此时未发起真实外呼，**不记** test-send 审计。
- **审计（§7）**：仅真实外呼（成功或被企业微信拒绝）记
  `NOTIFICATION_TEST_SEND`——成功 meta
  `{channelId, templateId, result:'success', httpStatus:200}`；失败 meta
  `{..., result:'failure', httpStatus:502, wecomErrCode, wecomErrMsg}`。
  meta 一律**不含**渲染后的消息正文（§7 决定）。
- **渲染口径**：数字来自 `MonitorService.summary`（§4），医院名来自
  `HOSPITAL_NAME` 环境变量（可选，默认 `菏泽市中医医院`）。消息发送目标
  为解密后的 webhook URL——key 明文只出现在出站请求里，不进日志/异常/审计。

## 9. 待确认事项（本设计不擅自决定）

1. **渠道/模板名称是否要求唯一**——是否允许重名（见 §3）。
2. **`test-send` 的频率限制**——是否需要防止误触导致短时间内重复
   发送同一渠道（企业微信 Webhook 本身有调用频率限制，超限会返回
   错误，但用户体验上可能需要前端做防抖/二次确认）。
3. **是否需要预留"消息类型"扩展点**——V1 只做 `TEXT`/`NEWS`，未来若
   要支持企业微信 `textcard`/模板卡片，需要走自建应用接口（涉及企业
   可信 IP 配置，见 §1 背景），届时 `msgType` 枚举需要扩展，且发送
   逻辑需要区分 Webhook 与自建应用两种调用路径——本设计的 `msgType`
   已按可扩展枚举设计，但自建应用路径的实现不在 V1 范围。
4. **定时自动推送何时启动**——见 §2，V1 故意不做，待业务方确认触发
   时机后另开 issue，复用 `apps/worker` 现有"自重排 setTimeout"任务
   模式（对齐 `sync.service.ts`），而非 `@Cron`。
5. **封面图自动生成何时启动**——见 §2，若确认要做，技术方案参考本次
   手动验证使用的路径（HTML 渲染→PNG→图片托管），但生产环境图片
   托管方式需要重新选型（当前验证使用的第三方图床服务不适合生产）。

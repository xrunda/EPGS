# EPGS 消息推送模块设计

> 状态：已按本设计拆分落地。
> - issue #53：数据模型 + Webhook URL 加密（`NotificationChannel` /
>   `NotificationTemplate` / `NotificationMsgType` / `NotificationSecretCipher`）。
> - issue #54：§8 的全部 HTTP API 已实现并附 e2e 测试——接口契约以
>   `docs/notification-api.md` 为准（本节的响应示例可能略旧），读取字段按
>   §5 收敛为 `webhookUrlMasked`，`PUT` 的 `webhookUrl` 只写不回填。
> - 定时/自动推送：V1 已实现（§2.1，本次 issue，含 `NotificationRule` /
>   `PushLog` / worker 调度器，见 §3 与 `docs/notification-rules-api.md`）。
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
text 与 news（图文）两种消息类型均已通过真实发送验证（`markdown` 在
个人微信企业会话不渲染，见 docs/deployment.md §2.5），是当前唯一
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

- **不做定时/自动触发推送**——**该决策已随业务方确认而反转（2026-08-23，
  本次 issue）**：定时推送规则 V1 已实现，见 §2.1。原"先人工验证内容/渠道
  再评估定时"的路径已完成验证，值班场景确认为"每天固定时刻把今日新报告
  汇总推到指定群"。
- **不做封面图自动生成**。`NEWS` 消息的封面图 V1 仅支持业务人员填写
  静态图片 URL（如医院/科室 logo）。按当日数据动态渲染统计图（此前
  手动验证用 HTML→PNG→图床的方式）技术链路更长（需要引入渲染依赖 +
  图片托管），列为 V2 候选，不在 V1 实现。
- **不做"渠道组"或"渠道-模板绑定"实体**——**该决策已演进（2026-08-23）**：
  发送测试仍临时选择组合；定时推送规则 V1 引入"规则 × 渠道 M:N"绑定
  （一条规则勾选多个渠道，见 §2.1 与 §3 `notification_rule_channel`），
  以规则为聚合单位，取代了原先设想的"渠道-模板二选一绑定"。发送测试的
  临时组合行为保持不变。
- **不做规则式的版本化**（对比 `MonitorRule` 的版本化+软停用模式）。
  Webhook 地址和模板内容修改后不需要追溯"历史某条消息用的是哪个版本"
  ——这与监测规则不同：规则版本化是为了让历史 `monitor_match` 可追溯
  判定依据，而推送配置纯粹是"当前往哪投、发什么"，改了就是改了。

### 2.1 定时推送规则 V1（2026-08-23 落地）

业务方确认：值班场景需要每天固定时刻把"今日新报告的重点患者汇总"自动
推到指定的一个或多个企业微信群。在 §2"人工点按钮"基础上增加**规则化
自动推送**，但保留手动补推兜底。

**锁定决策**（与业务方逐项确认，本次 issue 实现）：

1. **触发方式**：`apps/worker` 每分钟 tick，扫描启用规则，cron 到期且该
   规则**今日（上海时区）未自动推过** → 执行。沿用既有"自重排
   setTimeout"任务模式（对齐 `sync.service.ts`），非 `@Cron`。
2. **今日新报告口径**：`monitor_record.examTime` 落在今天（上海时区）
   `00:00:00+08:00 ≤ examTime < 次日 00:00:00+08:00` 的记录按
   `currentLevel` 计数，渲染进模板变量（`redCount/yellowCount/greenCount/
   totalCount`）。⚠️ 与 test-send 现在的**全量计数**（不带日期窗）不同，
   test-send 行为不变。
3. **推送时间自定义**：规则存完整 **5 字段 cron 表达式**，Asia/Shanghai
   时区求值（不受服务器进程 TZ 影响）。
4. **多渠道勾选**：一条规则勾选多个渠道（M:N，`notification_rule_channel`
   关联表），逐渠道发送、独立记录成功/失败，聚合为
   `SUCCESS`/`PARTIAL`/`FAILED`。
5. **手动补推**：规则页「立即执行一次」，走与定时完全相同的执行路径，
   **永远允许**（幂等只约束定时推送）；支持 `?windowDate=` 指定历史日期
   补推（如网络故障后重推昨日汇总）。
6. **幂等**：定时推送按 `(rule_id, window_date)` 部分唯一索引
   （WHERE `trigger='SCHEDULED'`）+ 应用层守卫双重防重；同日第二次定时
   触发直接跳过，不重复外呼。
7. **架构**：完整发送链路抽到共享包 `@epgs/notification-push`（加载渠道/
   模板 → 取汇总 → 装变量 → 渲染 → 解密 webhook → 发送），api 的
   test-send 与 worker 定时调度共用同一实现；worker 自带汇总适配
   （GROUP BY 计数），定时推送不依赖 api 存活。
8. **事件推送（新红色即推）**：V2 候选，本次明确不做。

**执行与审计**：手动补推落 `NOTIFICATION_RULE_RUN` 审计（有操作人）；
定时推送**不写审计**——无操作人，`push_log` 即其审计轨迹。规则 CRUD 落
`CONFIG_CHANGE`。

**前端**：配置页新增「规则」标签页，支持规则增删改、启停、cron 常用预设
（每天 9:00 等）、模板下拉、渠道多选、逐渠道执行结果反馈与推送日志弹窗
（含每渠道的 `wecomErrMsg`）。

### 2.2 预警详情跳转卡片（issue #72，2026-09-05 落地）

聚合文本只回答"今天有几例"，医生看到红色 2 例之后的下一步仍是回工作台手动
找人。本次在**保留文本消息不变**的前提下，为每次推送追加**一条** WeCom
`news` 消息，内含红 / 黄 / 绿最多三张卡片（**按颜色分组，不是按患者**；
0 例的颜色不发卡片），点开进入 web 的 `/alert` H5 页面：该颜色患者列表
（脱敏）→ 点击某患者 → 报告详情（含命中高亮）。

**锁定决策**（与业务方逐项确认）：

1. **免登**：一次性签发的不透明 token 短链（不是企微 OAuth）；链接即凭证，
   24 小时内可重复打开、不限次数、不做用完即焚。安全模型与接口见
   `docs/auth.md`「预警链接受限凭证」。
2. **快照固定**：token 绑定推送时刻该颜色的 `monitor_record.id` 列表
   （`alert_link.record_ids`），之后患者转色 / 新增不影响旧链接。
3. **隐私边界放开一层**：卡片与列表可出现脱敏姓名（姓氏 + `*`）+ 床号 +
   科室；报告正文只在鉴权后的详情页出现。三色都可点进列表和详情。
4. **失败隔离**：链接签发失败 → 仍推正文、不发卡片、worker 记 warn；卡片
   发送失败但正文已发出 → 该渠道 `FAILED`，`wecomErrMsg` 以「正文已发送，
   关注卡片发送失败」开头。
5. **开关**：`ALERT_LINK_BASE_URL` 未配置即整体关闭（不签发、不发卡片），
   推送行为与本次之前完全一致；配置后 api 与 worker 必须同值。

**实现落点**：签发逻辑在共享包 `@epgs/notification-push`（`AlertLinkIssuer`，
执行器每次运行签发一次、所有渠道共用同一批链接），api / worker 各自提供
`AlertLinkStore` 适配（`PrismaAlertLinkStore` / `WorkerAlertLinkStore`）；
解析与只读接口在 `apps/api/src/alert-links/`；页面在 `apps/web/src/AlertApp.tsx`
（与工作台同一构建产物，`/alert` 路径分流，反代 `try_files` 无需改动）。
`test-send` 不追加卡片（仍是单条消息，用于校验模板渲染）。

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
| `msgType`          | enum         | LOW      | `TEXT` \| `NEWS`（对应企业微信 Webhook 的 text/news） |
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

### `notification_rule` — 定时推送规则（定时推送 V1）

| 字段          | 类型         | 敏感级别 | 说明                                             |
| ------------- | ------------ | -------- | ------------------------------------------------ |
| `id`          | UUID PK      | LOW      | 主键                                              |
| `name`        | varchar(100) | LOW      | 规则名称（如"每日 9 点推送到总值班室群"）          |
| `cron`        | varchar(100) | LOW      | **5 字段 cron 表达式**，Asia/Shanghai 求值（§2.1 决策 3） |
| `templateId`  | UUID FK      | LOW      | 推送模板（`notification_template.id`，Restrict）  |
| `isEnabled`   | boolean      | LOW      | 软启停；停用后定时扫描跳过，但可手动补推          |
| `createdAt`/`updatedAt` | timestamptz | LOW | 审计时间戳                                    |
| `createdBy`/`updatedBy` | varchar(100) | MEDIUM | 操作人账号                                  |

索引：`@@index([isEnabled])`（worker 定时扫描按启用过滤）、
`@@index([templateId])`。规则与渠道为 M:N，见下。不做版本化（理由同 §2
渠道/模板：改了就是改了，历史推送以 `push_log` 为准）。

### `notification_rule_channel` — 规则-渠道绑定（M:N）

| 字段          | 类型         | 敏感级别 | 说明                                             |
| ------------- | ------------ | -------- | ------------------------------------------------ |
| `id`          | UUID PK      | LOW      | 主键                                              |
| `ruleId`      | UUID FK      | LOW      | 规则 id（Cascade 删除）                           |
| `channelId`   | UUID FK      | LOW      | 渠道 id（Cascade 删除）                           |
| `createdAt`   | timestamptz  | LOW      | 绑定时间                                          |

`@@unique([ruleId, channelId])` 防重复绑定。编辑规则时 `channelIds` 全量
替换（先删后插），无需版本化。

### `push_log` — 推送运行日志（审计轨迹）

| 字段          | 类型         | 敏感级别 | 说明                                             |
| ------------- | ------------ | -------- | ------------------------------------------------ |
| `id`          | UUID PK      | LOW      | 主键                                              |
| `ruleId`      | UUID FK      | LOW      | 规则 id（**Restrict**，保留审计轨迹，规则不可带日志删除） |
| `windowDate`  | varchar(10)  | LOW      | 推送的上海日 `YYYY-MM-DD`（§2.1 决策 2 的口径日期）|
| `trigger`     | enum         | LOW      | `SCHEDULED` \| `MANUAL`                            |
| `status`      | enum         | LOW      | `SUCCESS` \| `PARTIAL` \| `FAILED`（完成后写）     |
| `errorSummary`| text?        | LOW      | 聚合失败摘要（不含患者数据/URL）                   |
| `startedAt`/`finishedAt` | timestamptz | LOW | 起止时间（finishedAt 完成后补写）            |

索引：`@@index([ruleId, startedAt])`（日志查询）、`@@index([trigger])`。
**幂等关键**：`uq_push_log_scheduled_dedup` 部分唯一索引
（`rule_id, window_date` WHERE `trigger='SCHEDULED'`）——Prisma `@@unique`
无法表达部分索引，该索引在 migration.sql 手写维护，`migrate dev` 可能提议
DROP，需人工补回（见 §3 后注释与迁移头注释）。

### `push_delivery` — 单渠道发送明细

| 字段          | 类型         | 敏感级别 | 说明                                             |
| ------------- | ------------ | -------- | ------------------------------------------------ |
| `id`          | UUID PK      | LOW      | 主键                                              |
| `pushLogId`   | UUID FK      | LOW      | 所属推送日志（Cascade 删除）                      |
| `channelId`   | UUID FK      | LOW      | 渠道 id（**Restrict**；渠道停用/删除不影响历史明细，但删除渠道前需先处理日志） |
| `status`      | enum         | LOW      | `SUCCESS` \| `FAILED`                              |
| `wecomErrCode`| int?         | LOW      | 企业微信返回的 errcode（失败时）                   |
| `wecomErrMsg` | varchar(255)?| LOW      | 企业微信错误文案；**绝不含 webhook URL/key**       |
| `sentAt`      | timestamptz? | LOW      | 真实外呼时刻；未外呼（如停用拦截）为 null          |

索引：`@@index([pushLogId])`、`@@index([channelId])`。

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
4. **定时自动推送何时启动**——✅ **已落地（2026-08-23，本次 issue）**，见
   §2.1 与 §3。按原计划复用了 `apps/worker` 现有"自重排 setTimeout"任务
   模式（`NotificationScheduler`，对齐 `sync.service.ts`），非 `@Cron`。
5. **封面图自动生成何时启动**——见 §2，若确认要做，技术方案参考本次
   手动验证使用的路径（HTML 渲染→PNG→图片托管），但生产环境图片
   托管方式需要重新选型（当前验证使用的第三方图床服务不适合生产）。

# EPGS 安全现状与加固方案（运维讨论稿）

> **状态：讨论稿。本文只做现状记录与方案建议，未实施任何修改。**
> 编写日期：2026-09-11 ｜ 对应线上版本：`507e6fd`（管理员模块上线后）
> 每一项"现状"都标注了代码/配置出处，便于逐条核对；标注**待确认**的项需要在会上由运维
> 补充实际情况后再定方案。

配套文档：[上线检查清单与回滚 runbook](./go-live.md)（§1 凭据轮换、§2 数据库最小权限、
§4 备份演练）、[认证与账号](./auth.md)、[部署模式](./deployment.md)。

---

## 1. 本文要回答的问题

> "系统可以用命令行创建用户、改密码、执行 SQL，一旦这个命令行被别人知道了，
> 系统岂不是很不安全？"

答案分两半：

- **知道命令本身不构成风险。** CLI 源码在仓库里，命令名人人可见，但它必须在
  **生产主机的 shell 里**才能跑。它的安全边界就是主机的安全边界。
- **但担心指向的方向是对的。** 真正的薄弱点不在"命令被知道"，而在
  **主机入口与数据库入口的防线太单薄**，以及几处本该做而没做的加固（见 §4）。

本文把"谁能碰到什么"重新划清，再给出逐项方案。

## 2. 信任模型：三类入口

| 入口       | 到达方式                                      | 拥有什么能力                                                                          |
| ---------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| 网络入口   | 浏览器访问 `http://<入口>:5173`               | 只能走 HTTP 接口，受 JWT + 角色校验约束                                                |
| 主机入口   | 堡垒机 → 应用主机 `/data/epgs-git` 的 shell   | 跑 CLI、读 `.env`、直接 `psql`、改代码、重启服务、删日志                                |
| 数据库入口 | 拿到 `DATABASE_URL`（或网络可达 5432 + 口令） | **绕过全部应用层校验**：读写任意表、改权限、删审计日志                                  |

**结论一**：应用层那套角色体系（`VIEWER` / `RULE_ADMIN` / `SYSTEM_ADMIN` / `AUDITOR` /
`USER_ADMIN`）**只约束第一类入口**。对第二、第三类入口它不起任何作用。

**结论二**：CLI 不新增任何能力。能跑 `pnpm auth:assign-access` 的人，本来就能打开
`psql` 执行 `UPDATE app_user_access SET roles = '{SYSTEM_ADMIN}'`，或者直接
`SELECT patient_name FROM monitor_record` 把全部患者数据拖走。**`psql` 永远比这套 CLI
强**，所以 CLI 不是最弱环节，不需要也不应该通过隐藏命令来防护。

**结论三**：防线应该收在两个地方——**限制谁能进主机**，以及**让滥用行为在主机之外留痕**。
后者是本文多数方案背后的同一条主线：只要审计与备份还躺在被审计的那台机器上，
拿到 root 的人就能连同痕迹一起抹干净。

## 3. 现在已经做对的（不用动）

这一节是给讨论定基准线的：下面这些已经在代码里落地，评审时不必再提。

| 项                          | 证据                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| 密码用 Argon2 哈希           | `apps/api/src/auth/password-hasher.service.ts`（`argon2` 依赖）       |
| 密码永不进命令行             | `auth-cli.ts` 主动拒绝 `--password`，改用隐藏式交互输入                |
| 会话失效可强制                | `app_user.password_version` 参与 JWT 载荷校验，改密码即让旧 token 失效 |
| Cookie 属性                  | `httpOnly: true`、`sameSite: 'lax'`、`path: '/'`（`auth.module.ts`）   |
| 角色实时读取                  | `/api/auth/me` 每请求读 `app_user_access`，token 里不缓存角色          |
| CORS 收口                    | `main.ts` `enableCors({ origin: webOrigin, credentials: true })`      |
| 请求体白名单                  | `ValidationPipe({ whitelist, forbidNonWhitelisted })`                  |
| 环境变量 fail-fast            | `env.validation.ts` Joi 校验，`JWT_SECRET` 强制 ≥32 字符               |
| 企微 Webhook 地址加密落库      | `NOTIFICATION_SECRET_KEY` + `NotificationSecretCipher`                 |
| 免登卡片只存 token 哈希        | `alert_link` 表（不存明文 token，24h TTL）                             |
| 前端产物不含 IP               | 全部相对路径 + nginx 单端口反向代理（`deploy/nginx.conf.template`）    |
| 无 XSS 注入面                 | 前端无 `dangerouslySetInnerHTML` / `innerHTML`（已全库扫描确认）        |
| 日志脱敏有 CI 门禁            | `apps/api/src/security/log-sanitization.spec.ts`                       |
| 变更类操作留审计              | `audit_log` 记 `actor_username` / `actor_role` / `ip` / `correlation_id` |

## 4. 薄弱点清单

按"被利用的难易 × 影响面"排序。**P0 = 建议本周内定方案**；P1 = 本季度内；
P2 = 视等保要求排期。

| #   | 薄弱点                                             | 优先级 | 证据                                                                 |
| --- | -------------------------------------------------- | ------ | -------------------------------------------------------------------- |
| S1  | **数据库仍是默认口令 + 5432 发布到宿主机**          | **P0** | `docker-compose.yml`：`POSTGRES_PASSWORD: epgs`、`ports: "5432:5432"` |
| S2  | **无 TLS**，会话 cookie 明文过网                    | **P0** | nginx 模板只有 `listen __LISTEN_PORT__`，无 `ssl`；入口为 `http://`   |
| S3  | `.env` 明文持有 `JWT_SECRET` 与 `DATABASE_URL`       | **P0** | `apps/api/.env`、`apps/worker/.env`（文件权限待确认）                  |
| S4  | **数据库账号未拆分**，运行账号持有 DDL 权限          | **P0** | [go-live.md](./go-live.md) §2 两条未勾选                              |
| S5  | **登录无频率限制、无锁定**                          | P1     | `auth.service.ts` 无失败计数；依赖中无 `@nestjs/throttler`             |
| S6  | **登录成功/失败都不写审计**                         | P1     | `AuditAction.LOGIN` 枚举存在但**全库无写入点**（`auth.service.ts` 无审计调用） |
| S7  | CLI 的写操作不写审计                                | P1     | `auth-cli.ts` / `access-cli.ts` 不引用 `AuditService`                  |
| S8  | Swagger `/api/docs` 在对外端口可达                  | P1     | `main.ts` 无条件 `SwaggerModule.setup('api/docs')`；nginx `/api/` 直接转发 |
| S9  | 自动每日备份情况不明                                | P1     | [go-live.md](./go-live.md) §4 未勾选；本次上线是手工备份               |
| S10 | 无安全响应头                                        | P2     | nginx 模板与 `main.ts` 均未设置 `X-Content-Type-Options` / CSP 等      |
| S11 | `audit_log` 可被有 DB 写权限者删除                  | P2     | 审计表与被审计系统同库同主机；无外发、无异地副本                       |
| S12 | 卡片 token 明文过网、落入 nginx 访问日志             | P2     | `alert_link` 走 HTTP；nginx 未对 `/alert` 关 `access_log`             |

### S1 展开（最高危，也最容易被忽略）

`docker-compose.yml` 里 Postgres 用的是**仓库里的默认口令**，并且
`ports: "5432:5432"` 把端口发布到宿主机**所有网卡**。这意味着：

> 内网任意一台机器，只要能路由到这台主机，就可以用 `psql -h <主机> -U epgs epgs`
> 加上默认口令**直连数据库**——不需要堡垒机、不需要 `.env`、不需要任何账号。
> 拿到之后可以读全部患者数据、给自己加 `USER_ADMIN`、清空 `audit_log`。

[go-live.md](./go-live.md) §1 已经写明"生产库不用 `docker-compose.yml` 的 `epgs/epgs`
默认值"，但**这一条至今没有执行**。同时 `ports` 映射本身在单机部署下也**完全不必要**
——api 与 worker 都在宿主机上，走 `127.0.0.1:5432` 即可。

### S2 展开

`cookieSecure` 的默认值是 `nodeEnv === 'production'`（`configuration.ts:80-82`），也就是说
生产环境默认会带 `Secure` 标记。但**线上入口是 HTTP**，而登录是可用的——由此可以推断
`apps/api/.env` 里显式设了 `COOKIE_SECURE=false`，否则浏览器会直接丢弃这个 cookie。

结论：**会话令牌目前以明文经过网络**。内网抓包、或链路上任何一台被控主机都能拿到它，
拿到即等于拿到该账号 8 小时（`JWT_EXPIRES_SECONDS` 默认 28800）内的全部权限。

> 待会上确认：`.env` 里 `COOKIE_SECURE` 的实际取值。确认命令见 §7。

## 5. 逐项修改方案

每条给出：改动内容 / 影响面 / 验收方式。**工作量与停机窗口需运维确认后排期。**

### S1 数据库默认口令与端口发布（P0）

**改**：

1. 生成强口令，改 `docker-compose.yml` 的 `POSTGRES_PASSWORD` 与两端 `.env` 的
   `DATABASE_URL`（改口令需重建容器或用 `ALTER USER`，见下方影响面）。
2. `ports` 由 `"5432:5432"` 改为 `"127.0.0.1:5432:5432"`——只监听回环。
   若运维确认宿主机防火墙已挡 5432，此项优先级可降，但**仍然建议改**（纵深防御）。

**影响面**：改口令需要 `ALTER USER epgs WITH PASSWORD '<新口令>'` 并同步两端 `.env`，
然后 `bash start.sh nopull`。**不停机**，但改的瞬间到重启完成之间 api 会连不上库
（秒级）。若走"重建容器"路线则需停服并保留 volume。

**验收**：从**另一台内网机器**执行 `psql -h <主机> -U epgs epgs` 应连接失败
（超时或拒绝）；在本机上 `psql -h 127.0.0.1 -U epgs epgs` 仍正常。

### S2 启用 TLS（P0，需运维定证书来源）

**改**：在 nginx 模板增加 `listen __LISTEN_PORT__ ssl;` 与证书/私钥路径，
然后把两端 `.env` 的 `COOKIE_SECURE=true`、`ALERT_LINK_BASE_URL` 改成 `https://...`。

**影响面**：入口地址从 `http://` 变 `https://`，**所有医生的书签与已发出的企微卡片链接
都会失效**（卡片 24h 内自然过期）。要提前通知科室，并同步改网闸映射。

**方案选项**（会上定）：

- **A. 医院内部 CA 签发**——最规范，但需要把 CA 根证书装到每台医生手机的信任列表，
  在移动端推行成本高；
- **B. 自签证书**——同上，浏览器会报"不安全"，医生需要每次点继续，体验差；
- **C. 维持 HTTP，靠网络隔离兜底**——如果该端口只在受控内网可达、且运维能保证
  链路上没有不可信主机，**这是可以接受的取舍**，但需在文档里明确记录并定期复核。

如果最终选 C，必须同时做：把 `JWT_EXPIRES_SECONDS` 从 8 小时调低（如 2 小时），
缩短明文凭证的有效窗口。

**验收**（选 A/B 时）：`curl -sI https://<入口>/` 返回 200；浏览器地址栏显示锁标志；
`COOKIE_SECURE=true` 下登录、刷新、退出全流程正常。

### S3 `.env` 文件保护（P0，成本最低）

**改**（先做这一步，不依赖任何决策）：

```bash
chown <部署账号>:<部署账号> /data/epgs-git/apps/api/.env /data/epgs-git/apps/worker/.env
chmod 600 /data/epgs-git/apps/api/.env /data/epgs-git/apps/worker/.env
```

同时确认 `/data/epgs-git` 目录本身不对无关账号开放。

**影响面**：无。唯一风险是**别把属主改错**——api/worker 由 `start.sh` 以当前登录用户
启动，改了属主而该用户读不到 `.env`，服务起不来。改完 `bash start.sh nopull` 验证一次。

**说明**：这一步**不能**消除"有 root 的人读到密钥"的问题，它的价值是**收窄读取范围**
到部署账号一个人，并让越权读取在文件权限层面就失败。

### S4 拆分数据库账号（P0）

**改**：建两个角色——

```sql
-- 迁移账号：只在发布窗口使用，持有 DDL
CREATE ROLE epgs_migrate LOGIN PASSWORD '<强口令>';
GRANT ALL ON SCHEMA public TO epgs_migrate;
GRANT ALL ON DATABASE epgs TO epgs_migrate;

-- 运行账号：api/worker 使用，只有 DML，没有 DDL
CREATE ROLE epgs_app LOGIN PASSWORD '<强口令>';
GRANT USAGE ON SCHEMA public TO epgs_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO epgs_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO epgs_app;
```

然后把 `DATABASE_URL` 分成两份：`start.sh` 跑 `prisma migrate deploy` 时用迁移账号，
api/worker 运行时用运行账号。

**影响面**：**这是本次改动里最需要测试的一条**——Prisma 运行期可能需要
`_prisma_migrations` 的读权限，或有未预料到的 DDL（如某些扩展）。建议先在**生产库的
一份恢复副本**上跑通完整流程（建号 / 改权限 / 停用 / 删除 / 同步入库 / 推送），
再上生产。

**价值**：即使 `.env` 泄漏，攻击者能读写数据但**删不掉表结构**，恢复成本从"重建"
降到"清数据"。

**验收**：用 `epgs_app` 执行 `DROP TABLE alert_link;` 应报 `permission denied`；
而完整的建号闭环、同步、推送全部正常。

### S5 + S6 登录防爆破与登录审计（P1，建议同时做）

**改**：

1. 引入 `@nestjs/throttler`，对 `POST /api/auth/login` 按 **IP + 账号**双维度限流
   （如 1 分钟 10 次），并在连续失败 N 次（如 5 次）后对该账号临时锁定 15 分钟。
2. 在 `auth.service.ts` 的登录路径上补审计：**成功与失败都记**，失败时记
   `actor_username` 为尝试的账号名、`ip`、失败原因。

**注意**：`AuditAction.LOGIN` 枚举**已经存在**（迁移
`20260911000000_add_user_admin_role_and_audit_actions` 的枚举清单里能看到），
但全库没有任何地方写它。所以第 2 条更像是"把已经设计好的东西接上"，而不是新增能力。

**影响面**：锁定策略要**避免误伤**——内镜中心可能多人共用一台工作站的浏览器、
或有人连续输错密码。建议阈值先放宽（如 10 次/5 分钟），观察一段时间再收紧。
**必须**同时保留 CLI 应急通道（`auth:reset-password`），否则锁定会变成拒绝服务。

### S7 CLI 写审计（P1）

**改**：让 `auth-cli.ts` 与 `access-cli.ts` 的写操作（建号 / 改密 / 改授权）写一条
`audit_log`，actor 记为 `cli:<系统用户>@<主机名>`。

**落地方式**：两个 CLI 目前都用"纯函数 + 注入依赖"的结构（便于单测），建议抽一个
独立的 `audit-writer.ts`（只依赖 `PrismaService`），由 CLI 与 Nest 的 `AuditService`
共用，避免 CLI 去启动整个 Nest 容器。

**影响面**：小，纯新增写入。**但必须诚实说明它的边界**：这只让**经过 CLI 的**操作留痕；
有人直接 `psql` 改数据仍然不留痕——那要靠 S11 解决，单靠这条补不上。

### S8 收敛 Swagger（P1，成本最低）

**改**：任选其一——

- nginx 层直接挡掉（最省事，不动代码）：
  ```nginx
  location = /api/docs { return 404; }
  location /api/docs/ { return 404; }
  ```
- 或 `main.ts` 里改成仅非生产环境启用。

**影响面**：运维若依赖 Swagger 做接口联调会受影响；建议保留"临时放开→查完→再关"的流程。

**验收**：`curl -sI http://<入口>/api/docs` 返回 404。

### S9 每日自动备份（P1，需运维确认）

**改**：落地 [go-live.md](./go-live.md) §4——每日定时 `pg_dump`、**备份异地/异盘**、
并做一次**从备份恢复到空实例**的演练并留存记录。

**为什么这条重要**：它同时是 S11 的兜底。备份在**另一台机器**上且**不可被本机修改**，
那么即使有人清了生产库的 `audit_log`，备份里仍然留着事发前的版本。

### S10 安全响应头（P2）

**改**：优先在 **nginx 层**加：

```nginx
add_header X-Content-Type-Options nosniff always;
add_header X-Frame-Options DENY always;
add_header Referrer-Policy same-origin always;
add_header Content-Security-Policy "default-src 'self'" always;
```

**说明与取舍**：不在 API 进程里加 helmet——它主要面向"会被浏览器渲染的 HTML 响应"，
而本项目的 API 只返回 JSON，价值有限，加在 nginx 覆盖静态页面更划算。

`Content-Security-Policy` **需要先在生产等价环境测一遍**：Vite 构建产物若含内联
样式或字体资源，`default-src 'self'` 可能把页面打白。建议先只加前三条，CSP 单独排期。

### S11 审计日志防篡改（P2，取决于等保要求）

**改**：把 `audit_log` 实时或准实时**发送到本机之外**，任选：

- 应用侧双写：`AuditService.record` 同时 `syslog`（UDP/TCP 到日志服务器）；
- 数据库侧启用 `pgaudit`，由运维把日志收集到集中平台；
- 最低成本：每日把 `audit_log` 导出并连同校验和存到备份机（与 S9 合并做）。

**说明**：这条是本文唯一**无法靠改代码单独完成**的——需要运维提供日志服务器或备份
通道。如果医院没有集中日志平台，实务上退化为"每日异地导出"，防护力弱但聊胜于无。

### S12 卡片 token 与访问日志（P2）

**改**：随 S2（TLS）一并解决；若维持 HTTP，则至少在 nginx 对卡片路径关日志：

```nginx
location /alert { access_log off; }
```

并考虑把 `ALERT_LINK_TTL_HOURS` 从 24 调低到 8。

**影响面**：TTL 调低会让医生手上的旧卡片提前失效。影响有限——卡片内容是**脱敏**的
（见 [go-live.md](./go-live.md) §9.1），泄漏的后果不是患者隐私直接外泄。

## 6. 建议的实施顺序

**第一阶段（本周内定方案，多数可立即执行）**

- S3 文件权限——**今天就能做，零风险**
- S1 `ports` 收回到 `127.0.0.1` + 换库口令
- S8 Swagger 收敛（nginx 两行）
- 确认 S9 现有备份实情

**第二阶段（需要测试窗口）**

- S2 TLS 决策（A/B/C 三选一）
- S4 数据库账号拆分——**必须在副本上先演练**
- S5 + S6 登录限流与登录审计

**第三阶段（视等保要求）**

- S7 CLI 审计 → S10 安全响应头 → S11 审计外发 → S12 卡片 TTL

## 7. 需运维在会上确认的事项

每一条都给了确认命令，建议会前先把输出准备好。

1. **`.env` 的实际权限与属主**
   ```bash
   ls -l /data/epgs-git/apps/api/.env /data/epgs-git/apps/worker/.env
   ```
2. **`.env` 里 `COOKIE_SECURE` 的实际取值**（决定 S2 的严重程度）
   ```bash
   grep -c '^COOKIE_SECURE=false$' /data/epgs-git/apps/api/.env
   ```
   （只输出计数，**不要把 `.env` 内容打印到终端或聊天里**）
3. **ssh 配置**：root 能否直登、是否允许口令登录、是否强制密钥
   ```bash
   sshd -T | grep -E 'permitrootlogin|passwordauthentication|pubkeyauthentication'
   ```
4. **堡垒机账号是否一人一号**、能否直接落到应用主机 / 有无操作录屏
   ```bash
   last -n 20
   ```
5. **5432 是否真的被宿主机防火墙挡住**
   ```bash
   ss -lntp | grep 5432
   ```
   （若显示 `0.0.0.0:5432` 或 `[::]:5432`，说明 Docker 已绕过 ufw/firewalld
   直接发布了端口——Docker 的 iptables 规则**优先于**宿主机的 ufw 规则，
   这是本次最需要核实的点）
6. **是否已有每日自动备份、是否异地、恢复演练做过没有**
   ```bash
   crontab -l | grep -i dump; ls -lh /data/epgs-backups/ | head
   ```
7. **医院是否有可用 TLS 证书**（内网 CA / 自签），决定 S2 走 A 还是 B
8. **是否有集中日志服务器**可接审计外发，决定 S11 能否落地
9. **等保/合规要求**：审计日志保留周期、是否要求三权分立（系统管理 / 审计 / 业务分离）
10. **现有 5 个账号的归属与口令保管方式**——特别注意 `dev`（显示名"管理员"）与
    `5378 刘国庆` **都是 `SYSTEM_ADMIN` 且 `patient_detail=t`**，而 `dev` 刚刚又被授予
    了 `USER_ADMIN`。这两个账号的密码由谁保管、是否共用，需要在会上明确。

## 8. 明确不在本方案范围内

以下问题**不是**靠本文能解决的，需要单独判断：

- **已有 root 或 DB 写权限的内部人员**。在 `.env` 可读、`audit_log` 可删的前提下，
  这类人原则上无法被技术手段防住。本文的 S9 / S11 是把"事后能发现"这件事做得更好，
  不是"让他做不到"。
- **等保测评材料的编制**（本文可作为输入，但不等于测评文档）。
- **网络层策略**（防火墙规则、网闸映射、VPN 准入）的调整——由运维主导，本文只提出需求。
- **第三方依赖漏洞扫描**（`pnpm audit` / SCA）。当前仓库有 CI，但没有依赖漏洞门禁，
  建议单独排期。

## 9. 待办追踪

本文列出的每一项在实施时应同步更新 [go-live.md](./go-live.md) 的对应检查项
（§1 凭据轮换、§2 数据库最小权限、§4 备份演练），避免两处文档各说各话。实施完成后
本文档的状态行应从"讨论稿"改为"已实施"，并记录实施日期与版本。

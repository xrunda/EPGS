# 部署与运维（部署故障记录）

> `start.sh` 引用的「部署故障记录」即本文件。记录 EPGS 在跨安全域（网闸）环境下从多端口直连到单端口反代的真实故障与当前架构，供部署、排障与后续项目参考。跨项目可复用的规范提炼见 `hospital-deploy` skill。

## 1. 当前架构：单端口反向代理

背景：网闸按「任务号」把内网地址映射到 DMZ 的单个 IP:端口，无法同时映射 web(5173)/api(3000)/worker(3001) 三个独立端口；前端此前把 api 地址写死进构建产物（`VITE_API_BASE_URL`），换一个访问入口后浏览器仍直连原始物理 IP，被网闸拦截。

- 对外仅一个端口 `LISTEN_PORT`（默认 5173，沿用网闸已映射端口，避免改网闸规则）
- Nginx 反代收口：
  - `/api/*` → `127.0.0.1:3000`（不剥前缀、保留 Host/Cookie）
  - `= /health` → `127.0.0.1:3000/health`
  - `/` → `apps/web/dist` 静态产物 + SPA fallback
- 前端请求一律相对路径（同源），构建产物不含任何内网 IP
- 配置模板：`deploy/nginx.conf.template`；`start.sh` 自动替换占位符、`nginx -t` 校验后 (re)load

## 2. 故障记录

### 2.1 网闸登录失败（硬编码 IP）

- 现象：前端 `VITE_API_BASE_URL` 构建时写死 `10.10.10.91`（DMZ 物理 IP）进 bundle；换内网入口访问时浏览器仍直连该 IP → 被网闸拦截 → 登录卡顿/鉴权失败。
- 修复：`067f64d` 前端改相对路径 + Nginx 单端口反代。
- 教训：任何 IP/域名/端口都不许写进构建产物；跨网闸访问入口会变，唯一稳定的是「当前页面的 origin」。

### 2.2 nginx mime.types 找不到

- 现象：堡垒机报 `nginx: [emerg] open() "/data/epgs-git/mime.types" failed`。
- 原因：`include mime.types;` 是相对路径，按 nginx 编译期 `--conf-path` 前缀解析（`/etc/nginx`、`/usr/local/nginx/conf` 等），与独立配置文件所在目录无关。
- 修复：`bf05006` 配置改为内联 `types{}`，完全自包含。
- 教训：独立配置文件要自包含（pid、types、server 全内联），不依赖宿主 nginx 安装布局。

### 2.3 NODE_ENV=production + 纯 HTTP 登录后立即 401（COOKIE_SECURE）

- 现象：登录接口返回成功，但之后的每个请求都 401，反复跳回登录页。
- 原因：`start.sh` 强制 `NODE_ENV=production`，cookie 默认带 `Secure`；内网纯 HTTP 下浏览器静默丢弃 Secure cookie。
- 修复：`b634e59` 把 cookieSecure 与 NODE_ENV 解耦，`COOKIE_SECURE` 环境变量可覆盖（`apps/api/.env`）。
- 教训：生产构建不意味着 HTTPS；内网纯 HTTP 部署必须显式允许关闭 Secure。

### 2.4 测试消息收不到（webhook 指向本地 mock）

- 现象：点「发送测试」没收到消息；排查发现「冒烟测试群」渠道的 webhook 指向本地 `localhost:38999` mock 服务。
- 教训：真实环境的 webhook 地址要核对（加密存储），别拿本地 mock 当真实。

### 2.5 个人微信「企业会话」不显示 markdown

- 现象：`msgtype:'markdown'` 在个人微信企业会话显示「暂不支持此消息类型」；`text` 与 `news` 正常。
- 修复：`2a1fdc6` TEXT → `text`、NEWS → `news`。
- 详见 `docs/notification-design.md` §1、`packages/notification-push/src/wecom-webhook-sender.ts`。

### 2.6 孤儿进程占端口

- 现象：`nest start --watch` 的 `dist/main` 子进程脱离父进程存活，杀不干净，重启后端口被占。
- 修复：`5dcec33` start.sh 按端口（`ss` → `lsof`）杀进程，不只依赖 PID 文件。

## 3. start.sh 运维要点

- 用法：`bash start.sh`（git pull + 重启）/ `bash start.sh nopull`（改完 .env 快速重启）/ `bash start.sh stop`
- 流程：git pull → env 校验 → docker postgres → 构建 libs → prisma migrate → 构建 web → 后台启动 api/worker → 生成并 reload nginx → 就绪等待
- env fail-fast 预检：`NOTIFICATION_SECRET_KEY` 强制必填（`openssl rand -hex 24` 生成），缺了立刻报错，避免 60 秒等待后以「未就绪」收场
- `.env` 不进 git，缺失即报错
- 构建顺序：`pnpm run build:libs`（shared-types/matching-engine）→ `prisma migrate deploy` → `pnpm --filter web run build`
- `LISTEN_PORT` 默认沿用 5173；换端口用 `LISTEN_PORT=xxxx bash start.sh nopull`
- Nginx：`nginx -t -c` 通过再 reload

## 4. 企业微信集成要点

- 消息类型：TEXT → `text`、NEWS → `news`（`markdown` 已弃用，个人微信企业会话不渲染）
- Webhook 地址 AES-256-GCM 加密存储（`NotificationSecretCipher`），密钥 `NOTIFICATION_SECRET_KEY` 启动强制必填、不落日志
- 测试推送与定时推送统计口径一致：都按当日新增（`windowDate`）；缺省 = 全量库存（`packages/notification-push/src/summary.ts`、`apps/api/src/notifications/notification-push.adapters.ts`）

## 5. 相关文档

- 上线清单与回滚 runbook：`docs/go-live.md`
- 账号与权限：`docs/auth.md`（角色/科室范围/脱敏）
- 推送设计：`docs/notification-design.md`、`docs/notification-api.md`、`docs/notification-rules-api.md`
- 本地开发启动：`start.local.sh`（无 git pull、不强制 NODE_ENV=production、`pnpm dev`）

# 首次安装 runbook（堡垒机）

本文件补齐 [deployment.md](./deployment.md) §1.1 一直标注为「待补」的那一环：**一台全新的堡垒机
从零到跑起来要做什么**。

> **本文件是记录，不是未经执行的设想。** 下面的顺序与命令来自 2026-09-27 在新堡垒机上完成首次
> 安装时的实际操作与现场输出；踩到的坑见 §11，那一天真实的失败信息也都保留着。仓库为**公开**仓库，
> 因此本文件**不记录任何内网 IP、访问入口地址、模型地址、账号名与口令**——这些一律向项目所有者索取。
>
> 日常重启、改配置、回滚**不在本文件**：那些看 [deployment.md](./deployment.md) §3 与
> [go-live.md](./go-live.md) §7。本文件只在**机器是空的**时候用。

## 0. 先判断目标机器属于哪种形态

|                    | 容器形态                                         | 宿主机原生形态                     |
| ------------------ | ------------------------------------------------ | ---------------------------------- |
| PostgreSQL         | 本仓库 `docker-compose.yml` 起的 `epgs-postgres` | 发行版包管理器装的 PostgreSQL 18.x |
| 机器上有 Docker 吗 | 有（且必须一直有）                               | **没有，也不需要**                 |
| `PG_MODE`          | `docker`                                         | `native`                           |

`start.sh` 的 `[1/7]` 步会自动识别，一般不需要指定；判定顺序与「为什么容器优先」见
[deployment.md](./deployment.md) §1.1。**两种形态的差异只在第 3 节**，其余步骤完全一样。

判断自己在哪台机器上：看仓库路径，以及 `docker ps` 里有没有 `epgs-postgres`。

## 1. 前置：机器上要有什么

```bash
node -v      # 需要 v24，见仓库根的 .nvmrc
pnpm -v      # >= 9
nginx -v     # 必须装了；start.sh 自己起 nginx，见 §7
git --version
```

- **Node 与 pnpm 要装在所有会执行 `start.sh` 的用户下**（脚本用 `pnpm` 拉起 api/worker）。
- **`sudo` 可用**：`start.sh` 用 `sudo nginx ...` 起反向代理。
- **Docker 只在容器形态需要**。宿主机原生形态的机器上没装 Docker 是正常的，`start.sh` 全程不会
  调用它。

## 2. 取代码，并处理 `/root` 下的目录权限

```bash
cd /root
git clone <仓库地址> EPGS
cd EPGS
```

**仓库放在 `/root` 下面时，必须先做这一步**（见 §11 第 4 条）：

```bash
chmod o+x /root
```

`/root` 默认是 `0700`。start.sh 起的 nginx 以 root 启动、worker 进程降权到 `www-data`（或发行版
默认的 nginx 用户），它要读 `apps/web/dist` 下的静态文件——**没有 o+x，worker 连 `/root` 这一层都
穿不过去，页面直接 403**，而 nginx 的错误日志只会说 `Permission denied`，不看目录权限很难想到。

> 这是最小改动：`o+x` 只给「穿过」权限，不给「列出目录内容」权限。若安全要求不允许放宽 `/root`，
> 替代方案是把仓库放到 `/opt` 或 `/srv` 下——本仓库的路径假设不绑定 `/root`。

三个 `.env` 从未进 git，`git pull` 不会生成它们，需要手工创建（见 §4）。

## 3. PostgreSQL

### 3.1 容器形态

交给 `docker-compose.yml`，不需要手工建库：

```bash
docker compose up -d postgres
```

`start.sh` 的 `[1/7]` 步会在容器缺失或不健康时自动 `docker compose up -d postgres`。

### 3.2 宿主机原生形态

```bash
systemctl enable --now postgresql
sudo -u postgres psql
```

```sql
-- 角色往往已经存在（新堡垒机上就是），所以用 ALTER 而不是 CREATE：
-- 直接 CREATE 会以 "role already exists" 失败，看起来像权限问题，其实只是重名。
ALTER ROLE epgs WITH LOGIN PASSWORD '<强口令>';

-- 库不存在才建（PostgreSQL 没有 CREATE DATABASE IF NOT EXISTS）：
SELECT 'CREATE DATABASE epgs OWNER epgs'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'epgs')\gexec

-- 跨日筛选边界依赖这个时区（go-live.md §2）：
ALTER DATABASE epgs SET timezone TO 'Asia/Shanghai';
```

验证：

```bash
pg_isready -h 127.0.0.1 -p 5432     # 期望 "accepting connections"
```

`DATABASE_URL` 就写成刚建好的这个库，**主机写 `127.0.0.1`（或本机实际地址），不要写
`localhost`** —— `start.sh` 会从这条连接串里取 host:port 去探测「库活了没有」，写 `localhost`
在只监听 IPv4 的机器上会探测失败。

## 4. 三个 `.env`

```bash
cp apps/api/.env.example    apps/api/.env
cp apps/worker/.env.example apps/worker/.env
cp apps/web/.env.example    apps/web/.env      # 内容无关紧要，见下
```

逐个改。**每份的键都以其 `.env.example` 为准**（那里面有逐行注释），这里只列首次安装必须定下来的：

### `apps/api/.env`

| 键                        | 首次安装怎么定                                                                  |
| ------------------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`            | §3 建好的那条连接串                                                             |
| `JWT_SECRET`              | `openssl rand -base64 48`，**每套环境独立，禁止复用开发值**                     |
| `NOTIFICATION_SECRET_KEY` | `openssl rand -hex 24`；加密企微 Webhook 地址用。**缺失时 `start.sh` 直接退出** |
| `WEB_ORIGIN`              | 会被 `start.sh` 自动改成 `http://localhost:<LISTEN_PORT>`，不用手填             |
| `ALERT_LINK_BASE_URL`     | **先不填**。见 §10                                                              |

### `apps/worker/.env`

| 键                                               | 首次安装怎么定                                                 |
| ------------------------------------------------ | -------------------------------------------------------------- |
| `DATABASE_URL`                                   | 与 api **同值**                                                |
| `PACS_ADAPTER_MODE`                              | 对接医院网关用 `soap`；`start.sh` 会检查并在不是 `soap` 时警告 |
| `PACS_SOAP_BASE_URL`                             | 向信息科要                                                     |
| `PACS_SOAP_USERNAME` / `_PASSWORD` / `_KEY_NAME` | 向信息科要，注意 §11 第 1 条                                   |
| `PACS_SOAP_TLS_INSECURE`                         | 网关用自签证书时 `true`                                        |
| `SEMANTIC_*`                                     | **先全部留空/`false`**。接入模型是独立一步，见 §10             |

### `apps/web/.env`

生产构建**不读这个文件**——单端口反向代理之后前端全部走相对路径，仓库里已无任何代码读
`VITE_API_BASE_URL`。它之所以存在，只是 `start.sh` 的历史检查项；照 `.env.example` 复制一份即可。
（issue #127 已把这条硬性检查去掉，之后可以不必创建。）

## 5. 首次迁移与种子

```bash
pnpm install --frozen-lockfile
pnpm run build:libs
pnpm --filter api exec prisma migrate deploy
pnpm --filter api exec prisma db seed
```

- `migrate deploy` 输出应当**逐条列出**应用的迁移；这条命令幂等，重复执行只会显示
  `No pending migrations`。
- 种子是**幂等**的，可重复执行；它写入的是内镜中心定稿的 RED / YELLOW 词库。
- **种子不写入任何医学配置**——「关注语义」表在刚建好的库里是空的，这是预期状态，不是故障。

验证：

```bash
psql "$DATABASE_URL" -c "\dt monitor_*" | head
psql "$DATABASE_URL" -c "select count(*) from monitor_rule;"
```

## 6. 管理员账号

```bash
pnpm --filter @epgs/api auth:create-user --username <账号> --display-name <姓名>
pnpm --filter @epgs/api auth:assign-access --username <账号> --roles SYSTEM_ADMIN
```

按 [auth.md](./auth.md) 的角色矩阵分配。**注意 `auth:create-user` 需要交互式终端**（密码不通过参数
传递，系统主动拒绝 `--password`），所以它不能被无 TTY 的脚本直接调用，需要开一个真实终端执行。
其余账号在配置页里由管理员创建，不必都走命令行。

## 7. nginx

```bash
apt install -y nginx          # 若尚未安装；start.sh 在找不到 nginx 时直接报错退出
systemctl disable --now nginx # 关键，见 §11 第 3 条
```

`start.sh` 自己用 `nginx -c .run-nginx.conf` 起一个**独立实例**（配置自包含：`pid`、`types{}`、
`server` 全内联，不依赖 `/etc/nginx`）。发行版自带的那份配置留着只会占 80 端口、并在排障时让人
分不清看的是哪一份 master。

反向代理的架构与「为什么是单端口」见 [deployment.md](./deployment.md) §1。

## 8. 起服务

```bash
bash start.sh
```

脚本会依次做（脚本自己按 0 起编号，即 `[0/7]`…`[7/7]`）：停旧进程 → `git pull` → 校验 `.env` →
准备 PostgreSQL → 校正 `.env` → 装依赖 → **构建全部产物**（libs + web + api/worker 的 `dist`）→
迁移 → 后台起 api/worker（`node dist/main.js`）→ 生成并 reload nginx → 等就绪。

**看到「错误: ...」就停下改 `.env`，不要绕过**——那些检查对应的都是「绕过之后要等 60 秒才以
『api 未就绪』收场」的坑。

验证：

```bash
curl -s http://localhost:3000/health          # api
curl -s http://localhost:3001/health          # worker
ss -tlnp | grep ":$LISTEN_PORT"               # nginx 对外端口
```

## 9. 首次同步

worker 起来后会按 `SYNC_INTERVAL_MINUTES` 自己跑；也可以手工触发一次：

```bash
pnpm --filter @epgs/worker run sync:once
```

看到 `read=N success=N failure=0` 即通。**注意 `sync:once`（以及本仓库所有 `*:once` 脚本）起的是一个
完整的 Nest 进程**，它会连同**同步与推送的定时任务一起跑起来**，见 §11 第 6 条。

## 10. 首次安装之后再做的三件事

首次安装到 §9 就算完成，系统已在做关键词监测。下面三件按需、按顺序做：

1. **企微推送**：在配置页「渠道」里配置群机器人 Webhook 并「发送测试」。测试群先验证，再切正式群。
2. **预警卡片**：需要医生在企微里点开链接时，才在 api 与 worker 的 `.env` 里配 **同值** 的
   `ALERT_LINK_BASE_URL`（医生手机在医院网络下能打开的入口地址，**不是 localhost**）。
   不配 = 只推文本，其余功能不受影响。配错会被 `start.sh` 拦下。
3. **AI 语义监控**：这是一条有前置门禁的独立上线路径，**不要顺手打开**。
   完整步骤见 [go-live.md](./go-live.md) §10；最简形态是在 `apps/worker/.env` 里配好模型连接
   （`SEMANTIC_MODEL_BASE_URL` / `_NAME` / `_API_KEY` / `_API_STYLE=openai-chat`），
   再设 `SEMANTIC_REPORT_ENABLED=true`。**配了开关却没配地址时，分类模块会自我禁用并只打一条日志**
   ——这是 §11 第 5 条那个坑。

## 11. 首次安装当天踩到的坑

1. **PACS 账号不要按默认名去猜。** 用信息科给的账号原样填写；当天先按常见默认账号名配，一直认证
   失败，看起来像网络或证书问题，其实只是账号名不对。**口令按原样使用，不要做 URL 解码**——口令里
   若含 `%`、`+` 这类字符，解码一次就变成了另一个口令，报错仍然是「认证失败」。
2. **`apps/web/.env` 曾经是必需的。** `start.sh` 缺它会直接退出，而生产构建根本不用它。issue #127
   已去掉该校验；若从更早的版本安装，照着 `.env.example` 复制一份即可。
3. **发行版自带的 nginx 服务要先停掉并禁用**（§7）。`nginx -s stop -c <某份配置>` 只作用于使用同一
   份 pid 文件的实例，系统服务不受影响，两个 master 并存会让「nginx 到底起没起」变得难以判断。
4. **仓库在 `/root` 下要 `chmod o+x /root`**（§2）。症状是页面 403、nginx 日志只写
   `Permission denied`。
5. **「开关是 true 但模型地址为空」是静默的。** `.env` 里写了 `SEMANTIC_REPORT_ENABLED=true`，
   但三个 `SEMANTIC_MODEL_*` 一个都没写，worker 照常启动、同步照常跑，只有分类永远不动——
   直到手工执行 `classify:once` 才报「分类器已禁用或未配置」。`start.sh` 现在会把这几项的状态
   打印在启动输出里，先看那几行再去查日志。
6. **`*:once` 脚本不只是一个函数调用。** 它们是完整的 Nest 应用，会把自己模块里的定时任务一起
   启起来：跑一次 `classify:once` 会顺带触发一次真实同步，并让推送调度器在这几分钟里保持存活。
   在已经配好企微 Webhook 的环境里手工跑这些脚本，**会真的发出通知**——跑之前先确认这一点。
7. **`nest start --watch` 的孤儿进程（已根治）。** 首次安装时 `start.sh` 用 `start:dev`
   （`nest start --watch`）拉起 api/worker，它派生出的 `dist/main` 子进程会在父进程被杀后存活、
   继续占着端口，于是下一次启动的新进程以 `EADDRINUSE` 退出。当时按端口（`ss` → `lsof`）清理是
   **缓解**手段；issue #129 起改用 `start:prod`（`node dist/main.js`），这条根因已经消失，脚本里
   那段按端口的清扫只剩防御作用。若在**有历史的机器上**仍看到端口被占，手工兜底是
   `pkill -f 'nest start'` —— 那是改造之前遗留的孤儿。

## 12. 与本文相关的文档

- 架构、故障记录、`start.sh` 运维要点：[deployment.md](./deployment.md)
- 上线检查清单、功能开关回退、迁移回滚：[go-live.md](./go-live.md)
- 账号、角色矩阵与授权：[auth.md](./auth.md)
- 数据源适配与运行模式：[pacs-ris-adapter.md](./pacs-ris-adapter.md)
- AI 语义监控的门禁与验证顺序：[go-live.md](./go-live.md) §10、[ai-semantic-monitor-design.md](./ai-semantic-monitor-design.md)

#!/usr/bin/env bash
# EPGS 堡垒机启动脚本 - git 工作流版本
#
# 用法:
#   bash start.sh          先 git pull 拉最新代码，再重启全部服务
#   bash start.sh nopull    跳过 git pull，仅重启（用于 .env 手动改完后快速重启）
#   bash start.sh stop      仅停止 api/worker，并 reload nginx（不动 Postgres 容器）
#
# 前置条件:
#   - node/pnpm/docker/nginx 已装好 (node -v / pnpm -v / docker -v / nginx -v 确认)
#   - apps/api/.env、apps/worker/.env 已手动创建好
#     (.env 从不进 git，git pull 不会自动生成它们 - 首次部署需要手动
#     创建，参考本仓库 README 或直接问维护者要一份现成的)
#
# 架构说明（跨安全域/网闸部署）:
#   web/api/worker 曾各自监听独立端口 (5173/3000/3001)，前端把 api 地址
#   写死进构建产物 (VITE_API_BASE_URL)。这在网闸环境下会炸：网闸按
#   "任务号" 把内网地址映射到 DMZ 的单个 IP:端口，无法同时映射三个独立
#   端口，而写死的 api 地址在换一个访问入口后仍然指向原始物理 IP，被
#   网闸拦截，导致登录卡顿/鉴权失败（见 docs/ 部署故障记录）。
#
#   现在改为单端口反向代理：web 构建成静态文件，由 Nginx 和 api 一起
#   挂在同一个对外端口 (LISTEN_PORT，默认 5173) 上，前端请求全部走相对
#   路径。网闸只需要映射这一个端口，浏览器/网闸都不需要知道 api 的真实
#   IP:端口。见 deploy/nginx.conf.template。

set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/.run-logs"
PID_FILE="$REPO_ROOT/.run-pids"
mkdir -p "$LOG_DIR"

# 对外监听端口：网闸/NAT 映射的那一个端口。默认沿用旧的 5173，避免要求
# 运维同步改动现有网闸规则；如环境不同，用 LISTEN_PORT=xxxx bash start.sh 覆盖。
LISTEN_PORT="${LISTEN_PORT:-5173}"
WEB_DIST="$REPO_ROOT/apps/web/dist"
NGINX_CONF="$REPO_ROOT/.run-nginx.conf"
NGINX_PID_FILE="$REPO_ROOT/.run-nginx.pid"

stop_all() {
  echo "===== 停止已运行的 api/worker ====="
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "kill $pid"
        kill "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  for port in 3000 3001; do
    # lsof isn't installed on every host this runs on, and `nest start
    # --watch` spawns a `dist/main` child that survives its parent being
    # killed (reparented to PID 1) still holding the port - so this must
    # find listeners by port, not rely on the PID_FILE loop above. `ss`
    # is present on any modern distro (part of iproute2); fall back to
    # /proc/net/tcp parsing only if even that is missing.
    pids=""
    if command -v ss >/dev/null 2>&1; then
      pids=$(ss -tlnp "sport = :$port" 2>/dev/null \
        | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u || true)
    fi
    if [ -z "$pids" ] && command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -ti ":$port" 2>/dev/null || true)
    fi
    if [ -n "$pids" ]; then
      echo "端口 $port 仍被 PID $pids 占用，强制清理"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  done
  sleep 1
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  if [ -f "$NGINX_CONF" ]; then
    sudo nginx -s stop -c "$NGINX_CONF" 2>/dev/null || true
  fi
  echo "已停止。"
  exit 0
fi

stop_all

if [ "${1:-}" != "nopull" ]; then
  echo ""
  echo "===== [0/8] git pull 最新代码 ====="
  git pull origin main
fi

if [ ! -f apps/api/.env ] || [ ! -f apps/worker/.env ] || [ ! -f apps/web/.env ]; then
  echo ""
  echo "错误: apps/{api,worker,web}/.env 缺失一个或多个。"
  echo ".env 从不进 git，需要手动创建 - 参考之前的部署记录或问维护者要配置。"
  exit 1
fi

# 校验 apps/api/.env 的必需环境变量（对齐 src/config/env.validation.ts 的
# Joi 规则）。缺了就 fail-fast，而不是等 API 启动时报
# "Config validation error: ... is required" 才暴露——否则等待循环会干
# 等 60 秒后以"api 未就绪"收场，排查成本高。
check_required_api_env() {
  local key="$1" min_len="$2" hint="$3"
  local line val
  line=$(grep -E "^${key}=" apps/api/.env | head -n 1 || true)
  if [ -z "$line" ]; then
    echo ""
    echo "错误: apps/api/.env 缺少必需环境变量 ${key}。"
    echo "      ${hint}"
    exit 1
  fi
  val="${line#*=}"
  # dotenv 允许值带双引号；剥掉首尾引号再统计长度
  val="${val%\"}"; val="${val#\"}"
  if [ "${#val}" -lt "$min_len" ]; then
    echo ""
    echo "错误: apps/api/.env 的 ${key} 长度不足（期望 ≥${min_len} 字符，当前 ${#val}）。"
    echo "      ${hint}"
    exit 1
  fi
  if [ "$val" = "replace-with-at-least-32-random-characters" ]; then
    echo ""
    echo "错误: apps/api/.env 的 ${key} 仍是 .env.example 的占位符，请换成随机生成的真实值。"
    echo "      ${hint}"
    exit 1
  fi
}

# issue #53: Webhook 地址 AES-256-GCM 加密密钥，API 启动强制必填。
check_required_api_env "NOTIFICATION_SECRET_KEY" 32 \
  "加密企业微信 Webhook 地址的密钥（见 docs/notification-design.md §5）。生成方式: openssl rand -hex 24"

echo ""
echo "===== [1/8] 启动 Postgres (Docker) ====="
if docker ps --filter "name=^epgs-postgres$" --filter "health=healthy" --format '{{.Names}}' \
    | grep -q epgs-postgres; then
  echo "epgs-postgres 容器已在运行且健康，跳过重建。"
else
  if docker ps -a --filter "name=^epgs-postgres$" --format '{{.Names}}' | grep -q epgs-postgres; then
    echo "epgs-postgres 容器存在但不健康，先移除再重建。"
    docker rm -f epgs-postgres >/dev/null
  fi
  docker compose up -d postgres
fi
echo "等待 Postgres 就绪..."
for i in $(seq 1 30); do
  if docker exec epgs-postgres pg_isready -U epgs -d epgs >/dev/null 2>&1; then
    echo "Postgres 就绪。"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "Postgres 30 秒内未就绪，检查 docker logs epgs-postgres"
    exit 1
  fi
done

echo ""
echo "===== [2/8] 校正 .env（首次部署才需要改；已配好则跳过）====="
# 修改前先备份一份 .env，防止意外覆盖后无法恢复（.env.bak 已加入 .gitignore，
# 不会被误提交；需要回滚时 cp .env.bak .env 即可）。
for env_file in apps/api/.env apps/worker/.env; do
  cp -f "$env_file" "$env_file.bak"
done

# WEB_ORIGIN 只用于 CORS：Nginx 反代后浏览器请求 api 是同源的，正常情况下
# 不会触发 CORS 检查；这里仍然设成对外访问地址，作为运维绕过 Nginx 直连
# api:3000 调试时的兜底，而不是让登录路径依赖它。
if ! grep -q "^WEB_ORIGIN=http://localhost:$LISTEN_PORT" apps/api/.env; then
  sed -i "s#^WEB_ORIGIN=.*#WEB_ORIGIN=http://localhost:$LISTEN_PORT#" apps/api/.env
  echo "apps/api/.env  WEB_ORIGIN -> http://localhost:$LISTEN_PORT"
fi
# NODE_ENV 只在缺失或值为空时才写入 production；已正确配置则保持原样，
# 避免每次启动静默覆盖人工设置（例如临时改为 development 调试）。
for env_file in apps/api/.env apps/worker/.env; do
  current=$(grep -E "^NODE_ENV=" "$env_file" | head -n 1 || true)
  if [ -z "$current" ]; then
    # 文件末尾若没有换行先补一个，避免拼到上一行
    [ -n "$(tail -c 1 "$env_file")" ] && printf '\n' >> "$env_file"
    printf 'NODE_ENV=production\n' >> "$env_file"
    echo "$env_file  NODE_ENV -> production（原配置缺失，已新增）"
    continue
  fi
  value=${current#NODE_ENV=}
  # 去掉可能存在的引号（如 NODE_ENV="production" / NODE_ENV='production'）
  value=${value%\"}; value=${value#\"}
  value=${value%\'}; value=${value#\'}
  if [ -z "$value" ]; then
    sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' "$env_file"
    echo "$env_file  NODE_ENV -> production（原值空，已修正）"
  else
    echo "$env_file  NODE_ENV 已配置 ($value)，保持原样"
  fi
done
if ! grep -q "^PACS_ADAPTER_MODE=soap" apps/worker/.env; then
  echo "警告: apps/worker/.env 的 PACS_ADAPTER_MODE 不是 soap - 请手动确认"
  echo "      PACS_SOAP_BASE_URL/USERNAME/PASSWORD/KEY_NAME 是否已正确配置。"
fi

echo ""
echo "===== [3/8] 安装依赖 (pnpm install) ====="
pnpm install --frozen-lockfile

echo ""
echo "===== [4/8] 构建 shared-types / matching-engine ====="
pnpm run build:libs

echo ""
echo "===== [5/8] 数据库迁移 (prisma migrate deploy) ====="
pnpm --filter api exec prisma migrate deploy

echo ""
echo "===== [6/8] 构建 web 静态文件 ====="
pnpm --filter web run build

echo ""
echo "===== [7/8] 后台启动 api / worker，生成并 reload nginx ====="
: > "$PID_FILE"

nohup pnpm --filter api run start:dev > "$LOG_DIR/api.log" 2>&1 &
echo $! >> "$PID_FILE"

nohup env PORT=3001 pnpm --filter worker run start:dev > "$LOG_DIR/worker.log" 2>&1 &
echo $! >> "$PID_FILE"

sed -e "s#__LISTEN_PORT__#$LISTEN_PORT#" -e "s#__WEB_ROOT__#$WEB_DIST#" \
  -e "s#__PID_FILE__#$NGINX_PID_FILE#" \
  deploy/nginx.conf.template > "$NGINX_CONF"
if ! command -v nginx >/dev/null 2>&1; then
  echo "错误: 未找到 nginx，请先安装 (如 apt/yum install nginx)。"
  exit 1
fi
sudo nginx -t -c "$NGINX_CONF"
sudo nginx -s stop -c "$NGINX_CONF" 2>/dev/null || true
sudo nginx -c "$NGINX_CONF"
echo "nginx 已启动，监听 :$LISTEN_PORT，配置见 $NGINX_CONF"

echo ""
echo "===== [8/8] 等待服务就绪 ====="
for i in $(seq 1 60); do
  api_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/health" || true)
  worker_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3001/health" || true)
  if [ "$api_up" = "200" ] && [ "$worker_up" = "200" ]; then
    break
  fi
  sleep 1
done

echo ""
echo "===== 启动完成 ====="
echo "web+api (经 nginx 单端口对外):  http://<本机地址或网闸映射地址>:$LISTEN_PORT"
echo "worker 健康检查 (仅本机):        http://localhost:3001/health"
echo ""
echo "日志目录: $LOG_DIR"
echo "停止服务: bash start.sh stop"
echo "仅重启(不pull): bash start.sh nopull"
echo "更换对外端口: LISTEN_PORT=8080 bash start.sh nopull"
echo ""
curl -s "http://localhost:3000/health" || echo "(api 未就绪，查看 $LOG_DIR/api.log)"
echo ""
curl -s "http://localhost:3001/health" || echo "(worker 未就绪，查看 $LOG_DIR/worker.log)"
echo ""
ss -tlnp | grep ":$LISTEN_PORT" || echo "(nginx 端口未监听，检查 nginx -c $NGINX_CONF 的输出)"

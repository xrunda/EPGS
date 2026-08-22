#!/usr/bin/env bash
# EPGS 堡垒机启动脚本 (10.10.10.91) - git 工作流版本
#
# 用法:
#   bash start.sh          先 git pull 拉最新代码，再重启全部服务
#   bash start.sh nopull    跳过 git pull，仅重启（用于 .env 手动改完后快速重启）
#   bash start.sh stop      仅停止 api/worker/web（不动 Postgres 容器）
#
# 前置条件:
#   - node/pnpm/docker 已装好 (node -v / pnpm -v / docker -v 确认)
#   - apps/api/.env、apps/worker/.env、apps/web/.env 已手动创建好
#     (.env 从不进 git，git pull 不会自动生成它们 - 首次部署需要手动
#     创建，参考本仓库 README 或直接问维护者要一份现成的)

set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/.run-logs"
PID_FILE="$REPO_ROOT/.run-pids"
mkdir -p "$LOG_DIR"

BASTION_IP="10.10.10.91"

stop_all() {
  echo "===== 停止已运行的 api/worker/web ====="
  if [ -f "$PID_FILE" ]; then
    while read -r pid; do
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        echo "kill $pid"
        kill "$pid" 2>/dev/null || true
      fi
    done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
  for port in 3000 3001 5173; do
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
  echo "已停止。"
  exit 0
fi

stop_all

if [ "${1:-}" != "nopull" ]; then
  echo ""
  echo "===== [0/7] git pull 最新代码 ====="
  git pull origin main
fi

if [ ! -f apps/api/.env ] || [ ! -f apps/worker/.env ] || [ ! -f apps/web/.env ]; then
  echo ""
  echo "错误: apps/{api,worker,web}/.env 缺失一个或多个。"
  echo ".env 从不进 git，需要手动创建 - 参考之前的部署记录或问维护者要配置。"
  exit 1
fi

echo ""
echo "===== [1/7] 启动 Postgres (Docker) ====="
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
echo "===== [2/7] 校正 .env 中的地址（首次部署才需要改；已配好则跳过）====="
if ! grep -q "^WEB_ORIGIN=http://$BASTION_IP" apps/api/.env; then
  sed -i "s#^WEB_ORIGIN=.*#WEB_ORIGIN=http://$BASTION_IP:5173#" apps/api/.env
  echo "apps/api/.env  WEB_ORIGIN -> http://$BASTION_IP:5173"
fi
if ! grep -q "^VITE_API_BASE_URL=http://$BASTION_IP" apps/web/.env; then
  sed -i "s#^VITE_API_BASE_URL=.*#VITE_API_BASE_URL=http://$BASTION_IP:3000#" apps/web/.env
  echo "apps/web/.env  VITE_API_BASE_URL -> http://$BASTION_IP:3000"
fi
sed -i 's/^NODE_ENV=.*/NODE_ENV=production/' apps/api/.env apps/worker/.env
if ! grep -q "^PACS_ADAPTER_MODE=soap" apps/worker/.env; then
  echo "警告: apps/worker/.env 的 PACS_ADAPTER_MODE 不是 soap - 请手动确认"
  echo "      PACS_SOAP_BASE_URL/USERNAME/PASSWORD/KEY_NAME 是否已正确配置。"
fi

echo ""
echo "===== [3/7] 安装依赖 (pnpm install) ====="
pnpm install --frozen-lockfile

echo ""
echo "===== [4/7] 构建 shared-types / matching-engine ====="
pnpm run build:libs

echo ""
echo "===== [5/7] 数据库迁移 (prisma migrate deploy) ====="
pnpm --filter api exec prisma migrate deploy

echo ""
echo "===== [6/7] 后台启动 api / worker / web ====="
: > "$PID_FILE"

nohup pnpm --filter api run start:dev > "$LOG_DIR/api.log" 2>&1 &
echo $! >> "$PID_FILE"

nohup env PORT=3001 pnpm --filter worker run start:dev > "$LOG_DIR/worker.log" 2>&1 &
echo $! >> "$PID_FILE"

nohup env VITE_DEV_HOST=0.0.0.0 pnpm --filter web run dev > "$LOG_DIR/web.log" 2>&1 &
echo $! >> "$PID_FILE"

echo ""
echo "===== [7/7] 等待服务就绪 ====="
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
echo "api:    http://$BASTION_IP:3000/health"
echo "worker: http://$BASTION_IP:3001/health"
echo "web:    http://$BASTION_IP:5173"
echo ""
echo "日志目录: $LOG_DIR"
echo "停止服务: bash start.sh stop"
echo "仅重启(不pull): bash start.sh nopull"
echo ""
curl -s "http://localhost:3000/health" || echo "(api 未就绪，查看 $LOG_DIR/api.log)"
echo ""
curl -s "http://localhost:3001/health" || echo "(worker 未就绪，查看 $LOG_DIR/worker.log)"
echo ""
ss -tlnp | grep 5173 || echo "(web 端口未监听，查看 $LOG_DIR/web.log)"


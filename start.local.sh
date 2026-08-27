#!/usr/bin/env bash
# EPGS 本地开发启动脚本 - start.sh 的本地版
#
# 与 start.sh（堡垒机 10.10.10.91 专用）的区别:
#   - 不做 git pull（本地由你自己管理分支/提交）
#   - 不改写 apps/{api,web}/.env（不会把 WEB_ORIGIN/VITE_API_BASE_URL 强改成堡垒机 IP）
#   - 不强制 NODE_ENV=production（保留 .env 里已有的值，通常是 development）
#   - 用 `pnpm dev`（concurrently）启动，而不是三个独立 nohup 进程
#
# 用法:
#   bash start.local.sh          启动 Postgres(docker) + api/worker/web
#   bash start.local.sh stop     仅停止 api/worker/web（不动 Postgres 容器）
#
# 前置条件:
#   - node/pnpm/docker 已装好 (node -v / pnpm -v / docker -v 确认)
#   - apps/api/.env、apps/worker/.env、apps/web/.env 已手动创建好
#     (从各自的 .env.example 复制一份即可，DATABASE_URL 默认指向
#     docker-compose.yml 里的 epgs-postgres 容器)

set -euo pipefail
cd "$(dirname "$0")"

REPO_ROOT="$(pwd)"
LOG_DIR="$REPO_ROOT/.run-logs-local"
PID_FILE="$REPO_ROOT/.run-pids-local"
mkdir -p "$LOG_DIR"

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
    # `nest start --watch` 的子进程 (dist/main) 在父进程被杀后会被 reparent，
    # 继续占用端口 - 所以必须按端口查找监听者，而不是只依赖 PID_FILE。
    pids=""
    if command -v lsof >/dev/null 2>&1; then
      pids=$(lsof -ti ":$port" 2>/dev/null || true)
    elif command -v ss >/dev/null 2>&1; then
      pids=$(ss -tlnp "sport = :$port" 2>/dev/null \
        | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u || true)
    fi
    if [ -n "$pids" ]; then
      echo "端口 $port 仍被 PID $pids 占用，强制清理"
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  done
  sleep 2
}

if [ "${1:-}" = "stop" ]; then
  stop_all
  echo "已停止。"
  exit 0
fi

stop_all

if [ ! -f apps/api/.env ] || [ ! -f apps/worker/.env ] || [ ! -f apps/web/.env ]; then
  echo ""
  echo "错误: apps/{api,worker,web}/.env 缺失一个或多个。"
  echo "从对应的 .env.example 复制一份即可，例如:"
  echo "  cp apps/api/.env.example apps/api/.env"
  echo "  cp apps/worker/.env.example apps/worker/.env"
  echo "  cp apps/web/.env.example apps/web/.env"
  exit 1
fi

echo ""
echo "===== [1/5] 准备 Postgres ====="
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "检测到可用的 Docker，使用 docker-compose 的 epgs-postgres 容器。"
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
else
  # Docker 不可用（未安装或未运行）时，不接管 Postgres 生命周期 - 假定
  # 你本地已经用别的方式（Homebrew/系统服务等）跑着一个 Postgres，这里
  # 只按 apps/api/.env 的 DATABASE_URL 做一次连通性检查，跑不通就提示。
  echo "未检测到可用的 Docker，跳过容器管理，假定本地已有 Postgres 在运行。"
  db_url=$(grep -m1 '^DATABASE_URL=' apps/api/.env | cut -d= -f2-)
  db_host="localhost"
  db_port="5432"
  if [ -n "$db_url" ]; then
    # postgresql://user:pass@host:port/db 中提取 host/port
    hostport=$(echo "$db_url" | sed -E 's#^[a-zA-Z]+://[^@]*@##; s#/.*##')
    db_host="${hostport%%:*}"
    db_port="${hostport##*:}"
  fi
  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -h "$db_host" -p "$db_port" >/dev/null 2>&1; then
      echo "Postgres ($db_host:$db_port) 就绪。"
    else
      echo "警告: Postgres ($db_host:$db_port) 未就绪，请先手动启动你本地的 Postgres。"
      exit 1
    fi
  elif (exec 3<>"/dev/tcp/$db_host/$db_port") 2>/dev/null; then
    exec 3<&- 3>&-
    echo "Postgres ($db_host:$db_port) 端口可连通。"
  else
    echo "警告: 无法确认 Postgres ($db_host:$db_port) 是否就绪（未安装 pg_isready），请自行确认后重试。"
    exit 1
  fi
fi

echo ""
echo "===== [2/5] 安装依赖 (pnpm install) ====="
pnpm install

echo ""
echo "===== [3/5] 构建 shared-types / matching-engine ====="
pnpm run build:libs

echo ""
echo "===== [4/5] 数据库迁移 (prisma migrate deploy) ====="
pnpm --filter api exec prisma migrate deploy

echo ""
echo "===== [5/5] 后台启动 api / worker / web (pnpm dev) ====="
: > "$PID_FILE"
nohup pnpm dev > "$LOG_DIR/dev.log" 2>&1 &
echo $! >> "$PID_FILE"

echo ""
echo "===== 等待服务就绪 ====="
web_up=""
for i in $(seq 1 60); do
  api_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3000/health" || true)
  worker_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:3001/health" || true)
  web_up=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:5173/" || true)
  if [ "$api_up" = "200" ] && [ "$worker_up" = "200" ] && [ "$web_up" = "200" ]; then
    break
  fi
  sleep 1
done

echo ""
echo "===== 启动完成 ====="
echo "api:    http://localhost:3000/health"
echo "worker: http://localhost:3001/health"
echo "web:    http://localhost:5173"
echo ""
echo "日志: $LOG_DIR/dev.log (或直接看终端里 concurrently 的彩色输出)"
echo "停止服务: bash start.local.sh stop"
echo ""
curl -s "http://localhost:3000/health" || echo "(api 未就绪，查看 $LOG_DIR/dev.log)"
echo ""
curl -s "http://localhost:3001/health" || echo "(worker 未就绪，查看 $LOG_DIR/dev.log)"
echo ""
if [ "$web_up" = "200" ]; then
  echo "web 已就绪 (http://localhost:5173)"
else
  echo "(web 未就绪，查看 $LOG_DIR/dev.log)"
fi

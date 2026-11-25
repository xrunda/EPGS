#!/usr/bin/env bash
# 把 api / worker / nginx 交给 systemd 托管（issue #155）。
#
# 用法（必须 root）:
#   sudo bash deploy/install-systemd.sh
#
# 前置条件:
#   - 已经至少成功跑过一次 `bash start.sh`（它会构建产物并生成 .run-nginx.conf，
#     这份 unit 直接用那个配置启动 nginx）
#   - apps/api/.env 与 apps/worker/.env 已配置好
#
# 本脚本只「安装 + enable」，不启动、不停止任何正在运行的服务。
# 安装完成后执行 `bash start.sh nopull`，start.sh 会检测到 unit 并改用
# systemctl 重启服务，服务中断窗口与原来一致。
#
# 回滚到 nohup 模式:
#   sudo systemctl disable --now epgs-nginx epgs-worker epgs-api
#   sudo rm -f /etc/systemd/system/epgs-{api,worker,nginx}.service
#   sudo systemctl daemon-reload
#   cd <repo> && bash start.sh nopull

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/deploy/systemd"
# 可用 UNIT_DIR 覆盖，便于在非 root 环境做渲染验证。
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
# RENDER_ONLY=1：只渲染 unit 到 UNIT_DIR，不检查前置条件、不调用 systemctl。
# 供 CI 与本地验证占位符替换是否完整（真正的安装仍需 root）。
RENDER_ONLY="${RENDER_ONLY:-0}"

die() {
  echo ""
  echo "错误: $*"
  exit 1
}

if [ "$RENDER_ONLY" != "1" ]; then
  [ "$(id -u)" = "0" ] || die "需要 root 权限: sudo bash deploy/install-systemd.sh"
  command -v systemctl >/dev/null 2>&1 || die "本机没有 systemd，无法使用本安装脚本（保持原有 nohup 方式即可）"
fi

# 允许外部注入，便于渲染验证；正常安装时按 PATH 解析绝对路径。
PNPM_BIN="${PNPM_BIN:-$(command -v pnpm || true)}"
NGINX_BIN="${NGINX_BIN:-$(command -v nginx || true)}"
[ -n "$PNPM_BIN" ] || die "找不到 pnpm，请先按 docs/first-install.md 安装 Node/pnpm"
[ -n "$NGINX_BIN" ] || die "找不到 nginx，请先安装（apt install nginx）"

NGINX_CONF="$REPO_ROOT/.run-nginx.conf"
NGINX_PID_FILE="$REPO_ROOT/.run-nginx.pid"

if [ "$RENDER_ONLY" != "1" ]; then
  [ -f "$REPO_ROOT/apps/api/.env" ] || die "apps/api/.env 不存在，参考 docs/first-install.md §4"
  [ -f "$REPO_ROOT/apps/worker/.env" ] || die "apps/worker/.env 不存在，参考 docs/first-install.md §4"
  if [ ! -f "$NGINX_CONF" ]; then
    die "找不到 ${NGINX_CONF}。它由 start.sh 生成 —— 请先执行一次 'bash start.sh nopull'（或用已部署机器上现成的那份），再运行本脚本。"
  fi
fi

# 发行版自带的 nginx.service 会监听默认 80，而本项目用独立配置监听 5173；
# 两者同时存在时容易「以为改的是这份、实际跑的是另一份」。显式关掉并提示。
if [ "$RENDER_ONLY" != "1" ] && systemctl cat nginx.service >/dev/null 2>&1; then
  if systemctl is-enabled nginx.service >/dev/null 2>&1 || systemctl is-active nginx.service >/dev/null 2>&1; then
    echo "检测到系统 nginx.service，正在 disable --now（与 EPGS 的独立 nginx 配置冲突）"
    systemctl disable --now nginx.service || true
  fi
fi

render() {
  local template="$1" dest="$2"
  # 用 | 作分隔符，避免路径里的 / 与 sed 冲突。__REPO_ROOT__ 等占位符
  # 在模板中只出现在赋值位置，不会与其它文本误匹配。
  sed -e "s|__REPO_ROOT__|$REPO_ROOT|g" \
      -e "s|__PNPM_BIN__|$PNPM_BIN|g" \
      -e "s|__NGINX_BIN__|$NGINX_BIN|g" \
      -e "s|__NGINX_CONF__|$NGINX_CONF|g" \
      -e "s|__PID_FILE__|$NGINX_PID_FILE|g" \
      "$template" > "$dest"
  echo "已渲染 $dest"
}

mkdir -p "$UNIT_DIR"
render "$TEMPLATE_DIR/epgs-api.service.template"    "$UNIT_DIR/epgs-api.service"
render "$TEMPLATE_DIR/epgs-worker.service.template" "$UNIT_DIR/epgs-worker.service"
render "$TEMPLATE_DIR/epgs-nginx.service.template"  "$UNIT_DIR/epgs-nginx.service"

if [ "$RENDER_ONLY" = "1" ]; then
  echo ""
  echo "RENDER_ONLY=1：已渲染到 ${UNIT_DIR}，未调用 systemctl。"
  exit 0
fi

# 让 systemd 重新读取 unit 文件。
systemctl daemon-reload
systemctl enable epgs-api.service epgs-worker.service epgs-nginx.service

echo ""
echo "===== 安装完成 ====="
echo "  仓库:   $REPO_ROOT"
echo "  pnpm:   $PNPM_BIN"
echo "  nginx:  $NGINX_BIN"
echo "  配置:   $NGINX_CONF"
echo ""
echo "接下来执行（会把正在运行的 api/worker/nginx 切换到 systemd 托管）："
echo "  cd $REPO_ROOT && bash start.sh nopull"
echo ""
echo "验证:"
echo "  systemctl status epgs-api epgs-worker epgs-nginx --no-pager"
echo "  curl -s http://localhost:3000/health && echo"
echo "  curl -s http://localhost:3001/health && echo"
echo ""
echo "验证崩溃自愈（约 10 秒后应自动恢复）:"
echo "  sudo systemctl kill -s KILL epgs-api && sleep 8 && systemctl is-active epgs-api"
echo ""
echo "日志改到 journald 之后:"
echo "  journalctl -u epgs-api -n 200 --no-pager"
echo "  journalctl -u epgs-worker -f"

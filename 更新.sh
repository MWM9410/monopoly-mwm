#!/usr/bin/env bash
# 网页大富翁 - 一键更新（游戏逻辑/前端 + signal）
set -e
cd "$(dirname "$0")"

echo "========================================"
echo " 网页大富翁 - 一键更新（游戏逻辑/前端 + signal）"
echo "========================================"

SIGNAL_DIR="/tmp/monopoly-signal"
read -p "请输入本次改动说明（直接回车用默认）: " MSG
if [ -z "$MSG" ]; then MSG="更新游戏逻辑和前端"; fi

echo "[1/5] 重新构建 public/server-browser.js ..."
npm run build

echo "[2/5] 提交 monopoly-mwm ..."
git add -A
git commit -m "$MSG" || echo "[提示] 没有新改动需要提交，跳过"

echo "[3/5] 推送到 GitHub ..."
git push

echo "[4/5] 更新 monopoly-signal ..."
if [ -d "$SIGNAL_DIR" ]; then
  cd "$SIGNAL_DIR"
  git pull
else
  git clone https://github.com/MWM9410/monopoly-signal.git "$SIGNAL_DIR"
  cd "$SIGNAL_DIR"
fi

# 复制核心文件
cp -f "$OLDPWD/signal-worker.js"  "$SIGNAL_DIR/"
cp -f "$OLDPWD/wrangler.toml"     "$SIGNAL_DIR/"
cp -f "$OLDPWD/package.json"      "$SIGNAL_DIR/"
cp -f "$OLDPWD/build-browser.mjs" "$SIGNAL_DIR/"
cp -f "$OLDPWD/dev-server.mjs"    "$SIGNAL_DIR/"

echo "  重新生成依赖 ..."
rm -f package-lock.json
rm -rf node_modules
npm install

echo "[5/5] 提交 + 推送 monopoly-signal ..."
git add -A
git commit -m "$MSG" || echo "[提示] 没有新改动需要提交，跳过"
git push

cd "$OLDPWD"

echo ""
echo "========================================"
echo " 完成！两个仓库均已更新："
echo "   monopoly-mwm    (主仓库)"
echo "   monopoly-signal (Cloudflare Pages)"
echo " Cloudflare 将自动重新部署。"
echo "========================================"

#!/usr/bin/env bash
# 网页大富翁 - 一键更新（游戏逻辑/前端）
set -e
cd "$(dirname "$0")"

echo "========================================"
echo " 网页大富翁 - 一键更新（游戏逻辑/前端）"
echo "========================================"

echo "[1/3] 重新构建 public/server-browser.js ..."
npm run build

echo "[2/3] 提交到 Git ..."
git add -A
read -p "请输入本次改动说明（直接回车用默认）: " MSG
if [ -z "$MSG" ]; then MSG="更新游戏逻辑和前端"; fi
git commit -m "$MSG" || echo "[提示] 没有新改动需要提交，跳过"

echo "[3/3] 推送到 GitHub ..."
git push

echo ""
echo "========================================"
echo " 完成！GitHub 已更新。"
echo " 若 Cloudflare Pages 已连 GitHub，会自动重新部署。"
echo " 信令 Worker / TURN 未改动，无需更新。"
echo "========================================"

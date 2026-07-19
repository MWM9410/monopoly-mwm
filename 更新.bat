@echo off
chcp 65001 >nul
cd /d %~dp0

echo ========================================
echo  网页大富翁 - 一键更新（游戏逻辑/前端）
echo ========================================

echo [1/3] 重新构建 public/server-browser.js ...
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败，请检查 server.js / build-browser.mjs
  pause
  exit /b 1
)

echo [2/3] 提交到 Git ...
git add -A
set /p MSG="请输入本次改动说明（直接回车用默认）: "
if "%MSG%"=="" set MSG=更新游戏逻辑和前端
git commit -m "%MSG%"
if errorlevel 1 (
  echo [提示] 没有新改动需要提交，跳过
)

echo [3/3] 推送到 GitHub ...
git push
if errorlevel 1 (
  echo [错误] 推送失败（可能需先 git pull 或检查网络）
  pause
  exit /b 1
)

echo.
echo ========================================
echo  完成！GitHub 已更新。
echo  若 Cloudflare Pages 已连 GitHub，会自动重新部署。
echo  信令 Worker / TURN 未改动，无需更新。
echo ========================================
pause

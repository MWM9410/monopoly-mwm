@echo off
chcp 65001 >nul
cd /d %~dp0

echo ========================================
echo  Monopoly - Update
echo  Pages Function (/signal) built into project
echo ========================================

:: ---- step 1: build ----
echo [1/3] Build public/server-browser.js ...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed
  pause
  exit /b 1
)

:: ---- step 2: commit ----
echo [2/3] Commit to Git ...
git add -A
for /f "tokens=1-3 delims=/- " %%a in ('date /t') do set TD=%%a%%b%%c
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set TT=%%a%%b
git commit -m "update %TD%_%TT%" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Nothing to commit, skip
) else (
  echo [INFO] Committed
)

:: ---- step 3: push ----
echo [3/3] Push to GitHub ...
git push
if errorlevel 1 (
  echo [ERROR] Push failed
  pause
  exit /b 1
)

echo.
echo ========================================
echo  Done! GitHub updated.
echo  Cloudflare will auto-redeploy.
echo  Signal server via Pages Function (/signal)
echo ========================================
pause

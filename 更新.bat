@echo off
chcp 65001 >nul
cd /d %~dp0

echo ========================================
echo  Monopoly - Update (game logic / frontend + signal)
echo ========================================

:: ---- step 1: build ----
echo [1/5] Build public/server-browser.js ...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed
  pause
  exit /b 1
)

:: ---- step 2: commit monopoly-mwm ----
echo [2/5] Commit monopoly-mwm ...
git add -A
for /f "tokens=1-3 delims=/- " %%a in ('date /t') do set TD=%%a%%b%%c
for /f "tokens=1-2 delims=: " %%a in ('time /t') do set TT=%%a%%b
git commit -m "update %TD%_%TT%" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Nothing to commit, skip
) else (
  echo [INFO] Committed
)

:: ---- step 3: push monopoly-mwm ----
echo [3/5] Push monopoly-mwm to GitHub ...
git push
if errorlevel 1 (
  echo [ERROR] Push failed
  pause
  exit /b 1
)

:: ---- step 4: update monopoly-signal repo ----
set SIGNAL_DIR=%TEMP%\monopoly-signal
echo [4/5] Updating monopoly-signal ...

if not exist "%SIGNAL_DIR%" (
  echo   Cloning monopoly-signal ...
  git clone https://github.com/MWM9410/monopoly-signal.git "%SIGNAL_DIR%"
) else (
  cd /d "%SIGNAL_DIR%"
  git pull
  cd /d %~dp0
)

:: copy core files from monopoly-mwm to monopoly-signal
xcopy /y /q "%~dp0signal-worker.js"    "%SIGNAL_DIR%\" >nul
xcopy /y /q "%~dp0wrangler.toml"       "%SIGNAL_DIR%\" >nul
xcopy /y /q "%~dp0package.json"        "%SIGNAL_DIR%\" >nul
xcopy /y /q "%~dp0build-browser.mjs"   "%SIGNAL_DIR%\" >nul
xcopy /y /q "%~dp0dev-server.mjs"      "%SIGNAL_DIR%\" >nul

:: regenerate node_modules + lock file
cd /d "%SIGNAL_DIR%"
echo   Rebuilding dependencies ...
del /f /q package-lock.json 2>nul
rmdir /s /q node_modules 2>nul
call npm install >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm install failed for monopoly-signal
  pause
  exit /b 1
)

:: commit monopoly-signal
echo [5/5] Commit + Push monopoly-signal ...
git add -A
git commit -m "update %TD%_%TT%" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Nothing to commit in monopoly-signal, skip
) else (
  echo [INFO] Committed
)

git push
if errorlevel 1 (
  echo [ERROR] Push monopoly-signal failed
  pause
  exit /b 1
)

cd /d %~dp0

echo.
echo ========================================
echo  Done! Both repos updated:
echo    monopoly-mwm    (main repo)
echo    monopoly-signal (Cloudflare Pages)
echo  Cloudflare will auto-redeploy.
echo ========================================
pause

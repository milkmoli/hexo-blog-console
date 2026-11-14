@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting Blog Console...
start "blog-console" /b node server.js
timeout /t 2 >nul
set /p PORT=<.port
if "%PORT%"=="" set PORT=4180
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
  start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --app=http://127.0.0.1:%PORT% --window-size=1440,940
) else (
  start "" http://127.0.0.1:%PORT%
)

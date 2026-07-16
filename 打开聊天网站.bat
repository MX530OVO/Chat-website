@echo off
cd /d "%~dp0"
title Open Cyber Mystery Chat
set ALLOW_DEV_DEFAULTS=1
if "%ADMIN_PASSWORD%"=="" set ADMIN_PASSWORD=727577
if "%APP_SECRET%"=="" set APP_SECRET=local-only-secret-20260714-727577
if "%HOST%"=="" set HOST=127.0.0.1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue; if (-not $port) { Start-Process -FilePath python -ArgumentList 'server.py' -WorkingDirectory (Get-Location) -WindowStyle Hidden }; Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787/'"
echo Opened: http://127.0.0.1:8787/
echo Do not open the HTML files in public directly.
pause

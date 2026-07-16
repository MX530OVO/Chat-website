@echo off
cd /d "%~dp0"
title Cyber Mystery Chat
set ALLOW_DEV_DEFAULTS=1
if "%ADMIN_PASSWORD%"=="" set ADMIN_PASSWORD=727577
if "%APP_SECRET%"=="" set APP_SECRET=local-only-secret-20260714-727577
if "%HOST%"=="" set HOST=127.0.0.1
python server.py
pause

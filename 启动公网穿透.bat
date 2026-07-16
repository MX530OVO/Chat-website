@echo off
cd /d "%~dp0"
title Public Tunnel for Isekai Chat

echo Starting public tunnel for:
echo http://127.0.0.1:8787
echo.
echo Keep this window open.
echo Copy the public https address and send it to classmates.
echo.

if exist "tools\cloudflared.exe" (
  echo Using Cloudflare Tunnel.
  echo.
  "tools\cloudflared.exe" tunnel --url http://127.0.0.1:8787
  pause
  exit /b %errorlevel%
)

where ssh >nul 2>nul
if errorlevel 1 (
  echo No tunnel tool found.
  echo.
  echo cloudflared.exe is missing, and Windows SSH is not available.
  echo Please install OpenSSH Client in Windows optional features,
  echo or download cloudflared.exe to:
  echo %cd%\tools\cloudflared.exe
  echo.
  pause
  exit /b 1
)

echo cloudflared.exe is missing, using SSH tunnel fallback.
echo If Windows asks to trust serveo.net, type yes and press Enter.
echo.
ssh -o ServerAliveInterval=30 -o StrictHostKeyChecking=accept-new -R 80:127.0.0.1:8787 serveo.net
pause

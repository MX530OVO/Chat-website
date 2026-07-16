@echo off
cd /d "%~dp0"
title Install cloudflared

if not exist "tools" mkdir "tools"

echo 正在检查 cloudflared...
where cloudflared >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where cloudflared') do (
    copy /y "%%i" "tools\cloudflared.exe" >nul
    goto done
  )
)

echo.
echo 尝试使用 Windows winget 自动安装 cloudflared...
winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements

where cloudflared >nul 2>nul
if %errorlevel%==0 (
  for /f "delims=" %%i in ('where cloudflared') do (
    copy /y "%%i" "tools\cloudflared.exe" >nul
    goto done
  )
)

echo.
echo 自动安装没有成功。
echo 如果这里也卡住，说明你的网络访问国外下载源比较慢。
echo 可以让朋友帮你下载这个文件：
echo https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
echo.
echo 然后把文件改名为 cloudflared.exe，放到：
echo %cd%\tools\cloudflared.exe
echo.
pause
exit /b 1

:done
echo.
echo 安装完成：
"tools\cloudflared.exe" --version
echo.
echo 接下来双击 启动公网穿透.bat 就可以生成公网链接。
pause

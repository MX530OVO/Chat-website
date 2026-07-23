@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo === 暗号频道：迁移本地 SQLite 数据到 Supabase ===
echo.
echo 这个脚本不会显示你输入的密码以外的内容，也不会把连接串写入文件。
echo 请粘贴完整 DATABASE_URL，然后按回车。
echo 示例：postgresql://postgres.xxxxx:password@aws-xxx.pooler.supabase.com:6543/postgres
echo.

set /p DATABASE_URL=DATABASE_URL: 

if "%DATABASE_URL%"=="" (
  echo.
  echo 没有输入 DATABASE_URL，已取消。
  pause
  exit /b 1
)

echo.
echo 正在安装/检查依赖...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo 依赖安装失败。
  pause
  exit /b 1
)

echo.
echo 正在迁移数据...
python tools\migrate_sqlite_to_supabase.py
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo 迁移失败，退出码：%EXIT_CODE%
) else (
  echo 迁移命令已完成。请打开 Supabase 的 Table Editor，刷新 public schema 查看表。
)
echo.
pause
exit /b %EXIT_CODE%

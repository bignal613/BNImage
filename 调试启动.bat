@echo off
chcp 65001 >nul
title BNImage · 调试启动（带开发者工具）
cd /d "%~dp0"

rem 开两个开关：
rem   BNIMAGE_DEV=1    窗口里右键可「检查」，能实时改 CSS 看效果
rem   BNIMAGE_DEBUG=1  把关键动作写进数据目录的 debug.log
set "BNIMAGE_DEV=1"
set "BNIMAGE_DEBUG=1"

echo.
echo   调试模式启动：窗口里右键 -> 检查 -> 就能调样式了
echo   日志：%LOCALAPPDATA%\BNImage\debug.log
echo.

if exist "%~dp0BNImage.exe" (
  start "" "%~dp0BNImage.exe" %*
  exit /b 0
)

where py >nul 2>nul
if not errorlevel 1 (
  py -3 src\app.py %*
) else (
  python src\app.py %*
)
pause

@echo off
chcp 65001 >nul
title BNImage · 统一查看器
cd /d "%~dp0"

rem 优先使用同目录的 BNImage.exe
if exist "%~dp0BNImage.exe" (
  start "" "%~dp0BNImage.exe"
  exit /b 0
)

rem 其次用 Python 运行源码
set "PY="

where py >nul 2>nul
if not errorlevel 1 (
  set "PY=py -3"
)

if not defined PY (
  for %%P in (
    "%~dp0python\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
    "C:\Program Files\Python313\python.exe"
    "C:\Program Files\Python312\python.exe"
  ) do (
    if not defined PY if exist %%P set "PY=%%~P"
  )
)

if not defined PY (
  for /f "delims=" %%I in ('where python 2^>nul') do (
    if not defined PY (
      echo "%%I" | findstr /i "WindowsApps" >nul || set "PY=%%I"
    )
  )
)

if not defined PY (
  echo.
  echo   没有找到 Python，也没有找到 BNImage.exe。
  echo   请把 BNImage.exe 和 _internal 文件夹一起放在本文件同一目录下，
  echo   或安装 Python 3.9 以上版本。
  echo   https://www.python.org/downloads/
  echo.
  pause
  exit /b 1
)

rem 源码在 src 下
%PY% "%~dp0src\app.py"
if errorlevel 1 pause

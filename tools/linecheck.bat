@echo off
chcp 65001 >nul 2>&1
setlocal
title Line Check

set "PY=C:\Users\AHKK\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY="
if not defined PY where python >nul 2>&1 && set "PY=python"
if not defined PY where py >nul 2>&1 && set "PY=py"

if not defined PY (
    echo Python not found.
    pause
    exit /b 1
)

set "PYTHONIOENCODING=utf-8"
"%PY%" "%~dp0linecheck.py" %*
echo.
pause

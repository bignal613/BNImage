@echo off
setlocal
title Refresh Windows Icon Cache
cd /d "%~dp0"

echo.
echo   BNImage - force refresh of the Windows icon cache
echo   ------------------------------------------------------------
echo   The desktop will blink once. Nothing else is affected.
echo.
pause

taskkill /f /im explorer.exe >nul 2>nul
timeout /t 2 /nobreak >nul

del /f /q "%LOCALAPPDATA%\IconCache.db" >nul 2>nul
del /f /q "%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache*.db" >nul 2>nul

start "" explorer.exe
timeout /t 2 /nobreak >nul
ie4uinit.exe -show

echo.
echo   Done. Icon cache rebuilt, desktop refreshed.
echo   If the shortcut still shows the old icon, delete it and run  install.bat  again.
echo.
timeout /t 4 >nul

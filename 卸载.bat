@echo off
chcp 936 >nul
setlocal
title BNImage 统一查看器 · 卸载

set "DEST=D:\BNImage"
if not exist "D:\" set "DEST=%LOCALAPPDATA%\Programs\BNImage"
set "DATA=%LOCALAPPDATA%\BNImage"
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "LNKDIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs"

rem 如果本脚本就在安装目录里，先复制到临时目录再执行，否则删不掉自己
if /i "%HERE%"=="%DEST%" (
  copy /y "%~f0" "%TEMP%\bnimage-uninstall.bat" >nul 2>nul
  start "" "%TEMP%\bnimage-uninstall.bat"
  exit /b 0
)

echo.
echo   BNImage 统一查看器 · 卸载
echo   ------------------------------------------------------------
echo   将移除：程序目录 %DEST%
echo           开始菜单快捷方式
echo           文件关联（HKCU，不影响系统其他部分）
echo   同时清理：旧名字 Folio 残留的程序目录与关联（如果存在）
echo.

taskkill /f /im BNImage.exe >nul 2>nul
taskkill /f /im Folio.exe >nul 2>nul
ping -n 2 127.0.0.1 >nul

echo   [1/3] 撤销文件关联...
if exist "%DEST%\BNImage.exe" (
  start /wait "" "%DEST%\BNImage.exe" --unregister
) else if exist "%HERE%\BNImage.exe" (
  start /wait "" "%HERE%\BNImage.exe" --unregister
)
if exist "%LOCALAPPDATA%\Programs\Folio\Folio.exe" (
  start /wait "" "%LOCALAPPDATA%\Programs\Folio\Folio.exe" --unregister
)

echo   [2/3] 删除快捷方式与程序目录...
if exist "%LNKDIR%\BNImage 统一查看器.lnk" (
  del /f /q "%LNKDIR%\BNImage 统一查看器.lnk" >nul 2>nul
)
if exist "%USERPROFILE%\Desktop\BNImage 统一查看器.lnk" (
  del /f /q "%USERPROFILE%\Desktop\BNImage 统一查看器.lnk" >nul 2>nul
)
if exist "%LNKDIR%\Folio 统一查看器.lnk" (
  del /f /q "%LNKDIR%\Folio 统一查看器.lnk" >nul 2>nul
)
if exist "%DEST%" rmdir /s /q "%DEST%" >nul 2>nul
if exist "%LOCALAPPDATA%\Programs\Folio" rmdir /s /q "%LOCALAPPDATA%\Programs\Folio" >nul 2>nul

echo   [3/3] 用户数据：%DATA%
echo         （缩略图缓存、界面设置、诊断日志，删除不影响任何原图）
if exist "%DATA%" (
  choice /c YN /n /m "        是否一并删除这些缓存数据？[Y=删除 / N=保留]: "
  if errorlevel 2 (
    echo         已保留。需要时可直接删除该文件夹。
  ) else (
    rmdir /s /q "%DATA%" >nul 2>nul
    echo         已删除。
  )
)
if exist "%LOCALAPPDATA%\Folio" rmdir /s /q "%LOCALAPPDATA%\Folio" >nul 2>nul

echo.
echo   卸载完成。原图、原视频文件一个都没动。
echo.
pause
exit /b 0

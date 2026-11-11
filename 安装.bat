@echo off
chcp 936 >nul
setlocal
title BNImage 统一查看器 · 安装
cd /d "%~dp0"

set "SRC=%~dp0"
rem ---- 0. 选择安装位置：有 D 盘装 D 盘，否则装到用户目录（免管理员）----
set "DEST=D:\BNImage"
if not exist "D:\" set "DEST=%LOCALAPPDATA%\Programs\BNImage"
set "OLD=%LOCALAPPDATA%\Programs\Folio"
set "OLDDATA=%LOCALAPPDATA%\Folio"
set "LNKDIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs"

echo.
echo   BNImage 统一查看器 · 本地安装
echo   ------------------------------------------------------------
echo   程序目录：%DEST%
echo   数据目录：%LOCALAPPDATA%\BNImage
echo.

if not exist "%SRC%BNImage.exe" (
  echo   [!] 当前目录里没有 BNImage.exe。
  echo       请把本文件和 BNImage.exe、_internal 文件夹放在同一个目录再运行。
  echo.
  pause
  exit /b 1
)

rem ---- 1. 关掉正在运行的实例 -------------------------------------------
taskkill /f /im BNImage.exe >nul 2>nul
taskkill /f /im Folio.exe >nul 2>nul
ping -n 2 127.0.0.1 >nul

rem ---- 2. 清理旧名字 Folio 留下的东西（改名迁移，只做一次）-------------
if exist "%OLD%\Folio.exe" (
  echo   [1/5] 清理旧版本 Folio...
  start /wait "" "%OLD%\Folio.exe" --unregister
  rmdir /s /q "%OLD%" >nul 2>nul
  if exist "%LNKDIR%\Folio 统一查看器.lnk" del /f /q "%LNKDIR%\Folio 统一查看器.lnk" >nul 2>nul
  if exist "%OLDDATA%" rmdir /s /q "%OLDDATA%" >nul 2>nul
) else (
  echo   [1/5] 没有旧版本需要清理。
)

rem ---- 3. 复制程序文件 -------------------------------------------------
if not exist "%DEST%" mkdir "%DEST%" >nul 2>nul
echo   [2/5] 复制程序文件...
robocopy "%SRC%_internal" "%DEST%\_internal" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
  echo   [!] 复制 _internal 失败，请检查磁盘空间或杀毒软件拦截。
  pause
  exit /b 1
)
copy /y "%SRC%BNImage.exe" "%DEST%\BNImage.exe" >nul
copy /y "%SRC%bnimage.ico" "%DEST%\bnimage.ico" >nul
if exist "%SRC%web" robocopy "%SRC%web" "%DEST%\web" /E /NFL /NDL /NJH /NJS >nul
if exist "%SRC%icons" robocopy "%SRC%icons" "%DEST%\icons" /E /NFL /NDL /NJH /NJS >nul
if exist "%SRC%使用说明.md" copy /y "%SRC%使用说明.md" "%DEST%\使用说明.md" >nul
if exist "%SRC%卸载.bat" copy /y "%SRC%卸载.bat" "%DEST%\卸载.bat" >nul

rem ---- 4. 写入文件关联（只动 HKCU，不需要管理员）-----------------------
echo   [3/5] 登记文件关联（21 种图片 + 20 种视频 + PDF）...
start /wait "" "%DEST%\BNImage.exe" --register

rem ---- 5. 开始菜单快捷方式 ---------------------------------------------
echo   [4/5] 创建开始菜单快捷方式...
set "LNK=%LNKDIR%\BNImage 统一查看器.lnk"
set "PS1=$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%LNK%'); $s.TargetPath='%DEST%\BNImage.exe'; $s.WorkingDirectory='%DEST%'; $s.IconLocation='%DEST%\bnimage.ico'; $s.Description='BNImage 统一查看器'; $s.Save()"
powershell -NoProfile -ExecutionPolicy Bypass -Command "%PS1%" >nul 2>nul
if exist "%LNK%" copy /y "%LNK%" "%USERPROFILE%\Desktop\BNImage.lnk" >nul 2>nul

echo   [5/5] 完成。
echo.
echo   ------------------------------------------------------------
echo   最后一步（Windows 规定只能手动确认一次）：
echo     1. 在弹出的「默认应用」页里搜索 BNImage
echo     2. 点进去，选「将 BNImage 设为默认值」
echo     3. 42 个格式会一次全部设置好
echo.
echo   之后双击任意图片/视频，就是这个程序打开了。
echo   开始菜单与桌面都已放好「BNImage」快捷方式。
echo   ------------------------------------------------------------
echo.
pause

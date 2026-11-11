@echo off
chcp 936 >nul
setlocal
title BNImage · 重新打包
cd /d "%~dp0"

echo.
echo   BNImage · 把 src\app.py 重新打包成 BNImage.exe
echo   ------------------------------------------------------------
echo   需要先装好 Python 3.13 和依赖：
echo     pip install -r requirements.txt
echo.

where py >nul 2>nul
if not errorlevel 1 (set "PY=py -3") else (set "PY=python")

"%PY%" -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  echo   [!] 没有找到 PyInstaller。
  echo       先运行：pip install -r requirements.txt
  echo.
  pause
  exit /b 1
)

rem ffmpeg 不是必需：没有它也能打包，只是视频转码会降级
set "FFARG="
if exist "ffmpeg.exe" (set "FFARG=--add-binary ffmpeg.exe;.") else (echo   [!] 未找到 ffmpeg.exe，打包后视频转码不可用)
echo   [1/3] 打包中（约 30-60 秒）...
"%PY%" -m PyInstaller --noconfirm --onedir --windowed ^
  --name BNImage --icon bnimage.ico ^
  --add-data "web;web" --add-data "bnimage.ico;." %FFARG% ^
  --collect-all webview ^
  --hidden-import webview.platforms.edgechromium ^
  --hidden-import webview.platforms.winforms ^
  --hidden-import clr --hidden-import clr_loader ^
  src\app.py
if errorlevel 1 (
  echo   [!] 打包失败，看上面最后几行报错。
  pause
  exit /b 1
)

echo   [2/3] 覆盖本目录里的运行文件...
copy /y "dist\BNImage\BNImage.exe" "BNImage.exe" >nul
if exist "_internal" rmdir /s /q "_internal"
xcopy "dist\BNImage\_internal" "_internal\" /e /i /q /y >nul
copy /y "dist\BNImage\bnimage.ico" "bnimage.ico" >nul

echo   [3/3] 完成。双击 BNImage.exe 就是新版本。
echo.
echo   提示：只改界面（web 文件夹）不需要打包，关掉窗口重开就生效。
echo.
pause

# BNImage · 统一查看器

一个用 Python + HTML 写的 Windows 看图工具，用来替代系统自带的「照片」。
双击图片是**直接打开看图窗口**，不是打开文件夹；视频、PDF、网页也在同一个窗口里看。

界面克制、留白充足，没有多余的按钮和设置。

![界面预览](docs/preview.png)

## 它解决什么问题

| Windows 照片 | BNImage |
|---|---|
| 双击图片偶尔先弹文件夹 | 双击就是看图窗口 |
| 视频、PDF 要另开别的软件 | 图片 / 视频 / PDF / 网页同一个窗口 |
| 没有影调调整 | 曝光、亮度、对比度、阴影、饱和度五项，导出按原图分辨率处理 |
| HEVC 视频靠系统解码器，缺了就黑屏 | 内核能解就直接播，解不了自动转 H.264 并缓存 |

## 功能

- **单实例**：再双击另一张图，换图而不是再开一个窗口
- **格式覆盖**：20+ 种图片（含 HEIC / AVIF / JXL）、20+ 种视频、PDF、HTML
- **影调调整**：五项参数各自独立，导出与预览用同一套算法，色彩一致
- **视频**：H.264 直接播放；HEVC / 冷门容器自动转码，首次转完进缓存，再次打开零等待；转码优先走显卡硬件编码（NVENC / QSV / AMF）
- **主题**：深浅色跟随系统，连窗口标题栏一起染色（DWM），不留白杠
- **交互**：左右翻页按钮默认完全隐藏，鼠标靠近才浮出，不挡画面

## 环境要求

- Windows 10 1809+ / Windows 11，64 位
- Python 3.10+（仅源码运行时需要）
- WebView2 运行时（Win11 自带；Win10 可能需要单独安装）

## 从源码运行

```bash
pip install -r requirements.txt
python src/app.py
```

也可以双击 `启动 BNImage.bat`（会优先找同目录的 `BNImage.exe`，没有再找 Python）。

## 打包成 exe

```bash
pip install -r requirements.txt
python -m PyInstaller --noconfirm --onedir --windowed ^
  --name BNImage --icon bnimage.ico ^
  --add-data "web;web" --add-data "bnimage.ico;." ^
  --collect-all webview --hidden-import webview.platforms.edgechromium ^
  --hidden-import webview.platforms.winforms --hidden-import clr ^
  --hidden-import clr_loader src/app.py
```

或者直接双击 `打包.bat`。

产物在 `dist/BNImage/`，把里面的 `BNImage.exe` 和 `_internal/` 一起拷出去就能用。

## 关于 ffmpeg（重要）

本仓库**不包含 ffmpeg.exe**。原因有两个：它有 100MB，而且官方构建是 GPL 授权，
放进仓库会把整个项目的许可证复杂化。

没有 ffmpeg 时程序照常工作：图片、PDF、网页全部正常，只有视频的转码和封面帧会降级
（H.264 视频仍可直接播放）。

需要视频完整能力时，任选一种方式：

1. 从 [ffmpeg.org](https://ffmpeg.org/download.html) 或 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
   下载 Windows 构建，把 `ffmpeg.exe` 放到项目根目录
2. 用环境变量指定路径：

```cmd
set BNIMAGE_FFMPEG=D:\tools\ffmpeg.exe
python src/app.py
```

程序会依次在这些位置找：环境变量 `BNIMAGE_FFMPEG` → 程序根目录 → `_internal/` → 源码同级目录。

## 目录结构

```
BNImage/
├─ src/app.py          主程序（HTTP 服务 + 窗口 + 转码调度）
├─ web/                界面：index.html / style.css / app.js / editor.*
├─ icons/              各类文件在系统里的类型图标
├─ tools/              测试与辅助脚本（playwright 自检、图标生成）
├─ requirements.txt
├─ BNImage.spec        PyInstaller 配置
├─ 安装.bat / 卸载.bat  分发给别人用的一键安装
└─ 使用说明.md          给使用者的完整说明
```

运行时产生的缓存都放在 `%LOCALAPPDATA%\BNImage\`（转码结果、缩略图、界面主题），
不会污染程序目录，也不进版本库。

## 快捷键

| 键 | 作用 |
|---|---|
| `←` `→` | 上一张 / 下一张 |
| `+` `-` `0` | 放大 / 缩小 / 适应窗口 |
| `L` | 打开影调面板 |
| `Esc` | 关闭当前查看 |
| `Enter` | 用系统默认程序打开 |

## 许可证

代码本身采用 MIT，见 [LICENSE](LICENSE)。
内置或另行下载的 ffmpeg 遵循其自身许可证（官方 GPL 构建为 GPL v3），与本项目分开授权。

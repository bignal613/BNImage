"""标题栏染色实测：对正在运行的窗口直接调 DWM，截图对比深/浅两套配色。

不依赖打包、不依赖页面，先确认这三个 DWM 属性在本机（Win11 26200）
是否生效、按钮与文字是否仍然清晰。
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from PIL import Image, ImageGrab  # noqa: E402

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi

DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

COLORS = {
    "dark":  {"caption": 0x00141212, "border": 0x002E2A2A, "text": 0x00F0EDED},
    "light": {"caption": 0x00FAFBFB, "border": 0x00D6DCDC, "text": 0x001A1616},
}

OUT = Path(__file__).resolve().parent / "示例证据图"
OUT.mkdir(exist_ok=True)


def find_window():
    found = []

    @ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
    def cb(hwnd, _lp):
        if not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if n <= 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        if "BNImage" in buf.value:
            found.append((hwnd, buf.value))
        return True

    user32.EnumWindows(cb, 0)
    return found


def rect(hwnd):
    r = wt.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return r.left, r.top, r.right - r.left, r.bottom - r.top


def apply(hwnd, mode):
    col = COLORS[mode]
    dark = 1 if mode == "dark" else 0
    res = {}

    def _set(attr, val):
        buf = ctypes.c_uint(val & 0xFFFFFFFF)
        res[attr] = dwmapi.DwmSetWindowAttribute(
            ctypes.c_void_p(int(hwnd)), attr, ctypes.byref(buf), 4)

    _set(DWMWA_USE_IMMERSIVE_DARK_MODE, dark)
    _set(DWMWA_CAPTION_COLOR, col["caption"])
    _set(DWMWA_BORDER_COLOR, col["border"])
    _set(DWMWA_TEXT_COLOR, col["text"])
    user32.SetWindowPos(ctypes.c_void_p(int(hwnd)), None, 0, 0, 0, 0,
                        0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)
    return res


def grab(hwnd, tag):
    user32.SetForegroundWindow(ctypes.c_void_p(int(hwnd)))
    user32.BringWindowToTop(ctypes.c_void_p(int(hwnd)))
    time.sleep(0.7)
    x, y, w, h = rect(hwnd)
    img = ImageGrab.grab(bbox=(x, y, x + w, y + 96))
    img.save(OUT / f"caption_{tag}.png")
    img.resize((w, 96), Image.LANCZOS).save(OUT / f"caption_{tag}_2x.png")
    # 取标题栏中部底色（避开图标与按钮）
    px = img.convert("RGB").getpixel((w // 2, 12))
    print(f"  {tag}: 标题栏底色 {px}  尺寸 {w}x{h}")
    return img


def main():
    ws = find_window()
    if not ws:
        print("没找到 BNImage 窗口，先把应用打开")
        return 1
    for hwnd, title in ws:
        print(f"窗口 {hwnd}: {title}")

    hwnd = ws[0][0]
    print("原样:")
    grab(hwnd, "origin")

    for mode in ("dark", "light"):
        print(f"套用 {mode}:")
        print("  返回码:", apply(hwnd, mode))
        time.sleep(0.45)
        grab(hwnd, mode)

    print("已恢复为深色")
    apply(hwnd, "dark")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

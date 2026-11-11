"""读出 Windows 资源管理器会为某个文件画的那个图标，另存 PNG。

用途：改完文件关联/图标后，不靠肉眼猜，直接问 shell 要图标做核对。
用法: python tools/shell_icon.py <文件或文件夹>... [--out 目录]
"""
import ctypes
import sys
from ctypes import wintypes
from pathlib import Path

from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32
shell32 = ctypes.windll.shell32

gdi32.GetObjectW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p]
gdi32.GetObjectW.restype = ctypes.c_int
gdi32.GetDIBits.argtypes = [wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                            ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT]
gdi32.GetDIBits.restype = ctypes.c_int
gdi32.DeleteObject.argtypes = [wintypes.HANDLE]
user32.GetDC.argtypes = [wintypes.HWND]
user32.GetDC.restype = wintypes.HDC
user32.GetIconInfo.argtypes = [wintypes.HICON, ctypes.c_void_p]
user32.DestroyIcon.argtypes = [wintypes.HICON]
shell32.SHGetFileInfoW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.c_void_p,
                                   wintypes.UINT, wintypes.UINT]
shell32.SHGetFileInfoW.restype = ctypes.c_size_t

SHGFI_ICON = 0x000000100
SHGFI_LARGEICON = 0x000000000
SHGFI_TYPENAME = 0x000000400
SHGFI_USEFILEATTRIBUTES = 0x000000010
FILE_ATTRIBUTE_NORMAL = 0x00000080
DIB_RGB_COLORS = 0


class SHFILEINFOW(ctypes.Structure):
    _fields_ = [
        ("hIcon", wintypes.HICON),
        ("iIcon", ctypes.c_int),
        ("dwAttributes", wintypes.DWORD),
        ("szDisplayName", wintypes.WCHAR * 260),
        ("szTypeName", wintypes.WCHAR * 80),
    ]


class ICONINFO(ctypes.Structure):
    _fields_ = [
        ("fIcon", wintypes.BOOL),
        ("xHotspot", wintypes.DWORD),
        ("yHotspot", wintypes.DWORD),
        ("hbmMask", wintypes.HBITMAP),
        ("hbmColor", wintypes.HBITMAP),
    ]


class BITMAP(ctypes.Structure):
    _fields_ = [
        ("bmType", wintypes.LONG),
        ("bmWidth", wintypes.LONG),
        ("bmHeight", wintypes.LONG),
        ("bmWidthBytes", wintypes.LONG),
        ("bmPlanes", wintypes.WORD),
        ("bmBitsPixel", wintypes.WORD),
        ("bmBits", ctypes.c_void_p),
    ]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


def hicon_to_image(hicon):
    info = ICONINFO()
    if not user32.GetIconInfo(hicon, ctypes.byref(info)):
        raise OSError("GetIconInfo 失败")
    bm = BITMAP()
    gdi32.GetObjectW(info.hbmColor, ctypes.sizeof(bm), ctypes.byref(bm))
    w, h = bm.bmWidth, bm.bmHeight
    bi = BITMAPINFO()
    bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bi.bmiHeader.biWidth = w
    bi.bmiHeader.biHeight = -h          # 负数 = 自上而下
    bi.bmiHeader.biPlanes = 1
    bi.bmiHeader.biBitCount = 32
    bi.bmiHeader.biCompression = 0
    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(ctypes.windll.user32.GetDC(0), info.hbmColor, 0, h, buf,
                    ctypes.byref(bi), DIB_RGB_COLORS)
    im = Image.frombuffer("RGBA", (w, h), buf, "raw", "BGRA", 0, 1).copy()
    if info.hbmMask:
        gdi32.DeleteObject(info.hbmMask)
    if info.hbmColor:
        gdi32.DeleteObject(info.hbmColor)
    return im


def shell_icon(path, large=True):
    flags = SHGFI_ICON | SHGFI_TYPENAME | (SHGFI_LARGEICON if large else 0)
    shfi = SHFILEINFOW()
    ok = shell32.SHGetFileInfoW(str(path), 0, ctypes.byref(shfi),
                               ctypes.sizeof(shfi), flags)
    if not ok or not shfi.hIcon:
        return None, shfi.szTypeName
    try:
        return hicon_to_image(shfi.hIcon), shfi.szTypeName
    finally:
        user32.DestroyIcon(shfi.hIcon)


def main():
    args = sys.argv[1:]
    out = Path("_icon_test/_shell")
    if "--out" in args:
        i = args.index("--out")
        out = Path(args[i + 1])
        del args[i:i + 2]
    out.mkdir(parents=True, exist_ok=True)
    for a in args:
        p = Path(a)
        if not p.exists():
            print(f"{a}: 不存在")
            continue
        im, typ = shell_icon(p)
        if im is None:
            print(f"{p.name}: 取图标失败")
            continue
        dst = out / (p.name.replace(".", "_") + ".png")
        im.save(dst)
        print(f"{p.name:22} 类型名={typ!r:24} 尺寸={im.size} -> {dst}")


if __name__ == "__main__":
    main()

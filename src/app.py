#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
BNImage · 统一查看器
--------------------------------------------------------------------
本地只读文件预览服务：照片 / 图片 / 图形 / 视频 / PDF / HTML。
纯本地运行，不联网，不上传，不需要账号。

运行： python app.py
"""

import ctypes
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# ---------------------------------------------------------------- 环境自净
# 本程序有时会被别的宿主拉起来（编辑器、自动化外壳、批处理、安装器……），
# 那些进程的环境里常带着 PYTHONPATH / PYTHONHOME 指向它们自己的 shim 目录。
# 冻结包里的 pythonnet 会把这些路径当成 CLR 程序集的探测目录，初始化时逐层扫，
# 一旦扫到不兼容的东西就停在原地——窗口出来是一片白，系统判定"未响应"。
# 这些变量对已经打包的 exe 毫无用处（解释器、库都已经在包里），直接清掉最干净。
_PY_ENV = ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
           "PYTHONEXECUTABLE", "PYTHONUSERBASE", "PYTHONCASEOK")


def _sanitize_env():
    """剥离外来的 Python 解释器环境，连同它们注入的 sys.path 条目"""
    dropped = []
    for key in _PY_ENV:
        val = os.environ.pop(key, None)
        if val and key == "PYTHONPATH":
            dropped = [p for p in val.split(os.pathsep) if p.strip()]
    if not dropped:
        return
    norm = set()
    for p in dropped:
        try:
            norm.add(os.path.normcase(os.path.abspath(p)))
        except OSError:
            pass
    sys.path[:] = [
        p for p in sys.path
        if os.path.normcase(os.path.abspath(p or ".")) not in norm
    ]


_sanitize_env()

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP_NAME = "BNImage"
APP_VERSION = "1.6"
MAX_UPLOAD = 200 * 1024 * 1024      # 编辑结果回写的上限
FROZEN = bool(getattr(sys, "frozen", False))
if FROZEN:
    ROOT = Path(sys.executable).resolve().parent
    RES = Path(getattr(sys, "_MEIPASS", ROOT))
else:
    ROOT = RES = Path(__file__).resolve().parent
if FROZEN and (ROOT / "web").exists():
    WEB = ROOT / "web"        # 允许沿用外部 web 目录，便于改界面
elif not FROZEN and (ROOT.parent / "web").exists():
    WEB = ROOT.parent / "web"  # 源码运行：web 与 src 并列，不用再复制一份
else:
    WEB = RES / "web"
if FROZEN and (ROOT / "icons").exists():
    ICON_DIR = ROOT / "icons"     # 按格式区分的文件类型图标
else:
    ICON_DIR = RES / "icons"


def _data_dir():
    """用户数据目录。安装版写到 %LOCALAPPDATA%\\BNImage，源码运行仍用 ./.cache。
    这样程序可以装进任意目录（包括只读位置），缩略图与界面配置始终可写、
    也便于备份和整体清理。设置 BNIMAGE_DATA（旧名 FOLIO_DATA 仍认）可指定到别处。"""
    env = os.environ.get("BNIMAGE_DATA") or os.environ.get("FOLIO_DATA")
    if env:
        return Path(env)
    if FROZEN:
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "BNImage"
    return ROOT / ".cache"


CACHE = _data_dir()
try:
    CACHE.mkdir(parents=True, exist_ok=True)
except OSError:
    CACHE = Path(tempfile.gettempdir()) / "bnimage-cache"
    CACHE.mkdir(parents=True, exist_ok=True)

# 界面浅色/深色记在磁盘上：开窗那一瞬间就要用（标题栏和窗口底色），
# 那时页面还没加载，读不到 localStorage。
UI_THEME_FILE = CACHE / "ui-theme.json"


def read_ui_theme():
    try:
        v = json.loads(UI_THEME_FILE.read_text(encoding="utf-8")).get("theme")
    except (OSError, ValueError):
        return ""
    return v if v in ("dark", "light") else ""


def save_ui_theme(mode):
    if mode not in ("dark", "light"):
        return
    try:
        UI_THEME_FILE.write_text(json.dumps({"theme": mode}), encoding="utf-8")
    except OSError:
        pass

# ---------------------------------------------------------------- 图像解码

HAS_PIL = False
try:
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 400_000_000
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:
        pass
    HAS_PIL = True
except Exception:
    pass


# ---------------------------------------------------------------- 格式表

# 浏览器可原生渲染的位图 / 矢量
NATIVE_IMAGE = {
    ".jpg", ".jpeg", ".jpe", ".jfif", ".pjpeg",
    ".png", ".apng", ".gif", ".webp", ".avif",
    ".bmp", ".dib", ".ico", ".cur",
    ".svg", ".svgz",
}

# 浏览器不支持，由服务端用 Pillow 转码后渲染
DECODE_IMAGE = {
    ".tif", ".tiff", ".tff",
    ".heic", ".heif", ".hif",
    ".ppm", ".pgm", ".pbm", ".pnm",
    ".jxl",
}

VIDEO = {
    ".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mov", ".qt",
    ".mkv", ".avi", ".wmv", ".asf", ".flv", ".f4v",
    ".ts", ".m2ts", ".mts", ".mpg", ".mpeg", ".vob",
    ".3gp", ".3g2", ".rm", ".rmvb", ".divx", ".mxf",
}

PDF = {".pdf"}
ILLUSTRATOR = {".ai"}          # PDF 兼容的 ai 可预览
HTML = {".html", ".htm", ".xhtml", ".shtml"}
RAW_IMAGE = {".cr2", ".cr3", ".nef", ".arw", ".dng", ".orf", ".rw2",
             ".raf", ".srw", ".pef", ".rwl", ".raw", ".3fr", ".erf", ".mef"}

# 明确不纳入：演示文稿
PRESENTATION = {".ppt", ".pptx", ".pps", ".ppsx", ".pot", ".potx",
                ".pptm", ".potm", ".ppsm", ".key", ".odp", ".dps", ".dpt"}

IMAGE_ANY = NATIVE_IMAGE | DECODE_IMAGE
SUPPORTED = IMAGE_ANY | VIDEO | PDF | ILLUSTRATOR | HTML

# 系统/资源管理器自动生成的垃圾文件，列表里直接跳过
JUNK_FILES = {"thumbs.db", "ehthumbs.db", "ehthumbs_vista.db", "desktop.ini",
              "iconcache.db", "folder.ini"}

MIME_OVERRIDE = {
    ".svg": "image/svg+xml",
    ".svgz": "image/svg+xml",
    ".avif": "image/avif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".jxl": "image/jxl",
    ".mov": "video/quicktime",
    ".qt": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".m2ts": "video/mp2t",
    ".mts": "video/mp2t",
    ".ts": "video/mp2t",
    ".flv": "video/x-flv",
    ".rmvb": "application/vnd.rn-realmedia-vbr",
    ".pdf": "application/pdf",
    ".ai": "application/pdf",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".xhtml": "application/xhtml+xml; charset=utf-8",
}


def ext_of(path: str) -> str:
    return os.path.splitext(path)[1].lower()


def mime_of(path: str) -> str:
    ext = ext_of(path)
    if ext in MIME_OVERRIDE:
        return MIME_OVERRIDE[ext]
    guess, _ = mimetypes.guess_type(path)
    return guess or "application/octet-stream"


def classify(path: str) -> str:
    ext = ext_of(path)
    if ext in IMAGE_ANY:
        return "image"
    if ext in VIDEO:
        return "video"
    if ext in PDF or ext in ILLUSTRATOR:
        return "pdf"
    if ext in HTML:
        return "html"
    if ext in RAW_IMAGE:
        return "raw"
    if ext in PRESENTATION:
        return "presentation"
    return "other"


def is_supported(path: str) -> bool:
    return classify(path) in ("image", "video", "pdf", "html")


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


# ---------------------------------------------------------------- 缩略图

def _thumb_path(key: str) -> Path:
    return CACHE / key[:2] / (key + ".webp")


def _open_image(path: str):
    im = Image.open(path)
    try:
        im.draft("RGB", (2048, 2048))
    except Exception:
        pass
    im = ImageOps.exif_transpose(im)
    return im


def _to_webp(im, box: int, quality: int) -> bytes:
    im = im.copy()
    has_alpha = im.mode in ("RGBA", "LA", "PA") or (
        im.mode == "P" and "transparency" in im.info
    )
    im = im.convert("RGBA" if has_alpha else "RGB")
    im.thumbnail((box, box), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=quality, method=4)
    return buf.getvalue()


def build_thumb(path: str, size: int):
    """返回 (bytes, mime) 或 None"""
    if not HAS_PIL:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = hashlib.md5(
        f"{path}|{st.st_mtime_ns}|{st.st_size}|{size}".encode("utf-8", "replace")
    ).hexdigest()
    cached = _thumb_path(key)
    if cached.exists():
        try:
            return cached.read_bytes(), "image/webp"
        except OSError:
            pass
    im = _open_image(path)
    data = _to_webp(im, size, 82)
    im.close()
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cached)
    except OSError:
        pass
    return data, "image/webp"


def _vframe_path(key: str) -> Path:
    return CACHE / "vf" / key[:2] / (key + ".webp")


_vf_sem = threading.Semaphore(3)   # 同时最多 3 个 ffmpeg，避免整目录视频把 CPU 打满


def _ffmpeg_frame(path: str, at: float, width: int) -> bytes:
    """用 ffmpeg 抓一帧，返回 png bytes（失败返回空）"""
    cmd = [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", f"{at:.3f}", "-i", path,
        "-frames:v", "1", "-an", "-sn",
        "-vf", f"scale={width}:-2:flags=lanczos",
        "-f", "image2pipe", "-vcodec", "png", "-",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=25)
    except (OSError, subprocess.SubprocessError):
        return b""
    return out.stdout if out.returncode == 0 else b""


def build_vframe(path: str, width: int):
    """视频封面：用内置 ffmpeg 抓帧（HEVC 也能出），存 webp 缓存。

    为什么不用 <video> 当封面：WebView2 里 preload=metadata 不解码首帧，
    #t= 媒体片段也不一定生效，格子里就是一片空白。
    """
    if not FFMPEG or not HAS_PIL:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    width = max(120, min(1024, int(width)))
    key = "v" + hashlib.md5(
        f"{path}|{st.st_mtime_ns}|{st.st_size}|{width}".encode("utf-8", "replace")
    ).hexdigest()
    cached = _vframe_path(key)
    if cached.exists():
        try:
            return cached.read_bytes(), "image/webp"
        except OSError:
            pass

    # 先试 1s（多数视频开场是黑场），短于 1s 或失败再退回第一帧
    with _vf_sem:
        raw = _ffmpeg_frame(path, 1.0, width)
        if not raw:
            raw = _ffmpeg_frame(path, 0.0, width)
    if not raw:
        return None
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
        data = _to_webp(im, width, 78)
        im.close()
    except Exception:
        return None
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_name(key + f".{os.getpid()}.tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cached)
    except OSError:
        pass
    return data, "image/webp"


def build_render(path: str, max_side: int):
    """把浏览器不认识的格式转码成 webp"""
    if not HAS_PIL:
        return None
    try:
        st = os.stat(path)
    except OSError:
        return None
    key = "r" + hashlib.md5(
        f"{path}|{st.st_mtime_ns}|{st.st_size}|{max_side}".encode("utf-8", "replace")
    ).hexdigest()
    cached = _thumb_path(key)
    if cached.exists():
        try:
            return cached.read_bytes()
        except OSError:
            pass
    im = _open_image(path)
    data = _to_webp(im, max_side, 92)
    im.close()
    try:
        cached.parent.mkdir(parents=True, exist_ok=True)
        tmp = cached.with_suffix(".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, cached)
    except OSError:
        pass
    return data


def read_exif(path: str):
    if not HAS_PIL:
        return None
    try:
        im = Image.open(path)
    except Exception:
        return None
    info = {"w": im.width, "h": im.height, "format": im.format or "", "exif": {}}
    try:
        raw = im.getexif()
        ex = info["exif"]
        pairs = [
            (271, "make"), (272, "model"), (305, "software"),
            (36867, "taken"), (36868, "digitized"),
            (33437, "fnumber"), (33434, "exposure"), (34855, "iso"),
            (37386, "focal"), (42036, "lens"), (37500, "maker"),
        ]
        for tag, name in pairs:
            v = raw.get(tag)
            if v in (None, ""):
                continue
            if tag == 33437:
                v = f"f/{float(v):g}"
            elif tag == 33434:
                try:
                    f = float(v)
                    v = f"1/{round(1 / f)}s" if f and f < 1 else f"{f:g}s"
                except Exception:
                    v = str(v)
            elif tag == 37386:
                try:
                    v = f"{float(v):g}mm"
                except Exception:
                    v = str(v)
            elif tag == 34855:
                v = f"ISO {v}"
            else:
                v = str(v).strip()
            ex[name] = v
        # 子 IFD
        try:
            sub = raw.get_ifd(0x8769)
            for tag, name in ((33437, "fnumber"), (33434, "exposure"),
                              (34855, "iso"), (37386, "focal")):
                if name in ex:
                    continue
                v = sub.get(tag)
                if v in (None, ""):
                    continue
                if tag == 33437:
                    v = f"f/{float(v):g}"
                elif tag == 33434:
                    f = float(v)
                    v = f"1/{round(1 / f)}s" if f and f < 1 else f"{f:g}s"
                elif tag == 37386:
                    v = f"{float(v):g}mm"
                elif tag == 34855:
                    v = f"ISO {v}"
                ex[name] = str(v)
        except Exception:
            pass
    except Exception:
        pass
    try:
        if getattr(im, "is_animated", False):
            info["frames"] = getattr(im, "n_frames", 1)
    except Exception:
        pass
    im.close()
    return info


# ---------------------------------------------------------------- 视频转码
# 浏览器内核（WebView2/Chromium）只认 H.264 / VP8 / VP9 / AV1，且容器基本只认
# mp4 / mov / webm。手机拍的 H.265（HEVC）、相机和剪辑软件导出的 ProRes、以及
# mkv / avi / wmv / rmvb 这些，画面都出不来。这里在本地用 ffmpeg 转成 H.264
# 的 mp4，按「路径 + 大小 + 修改时间」做键缓存，只转一次。

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

# 浏览器能直接解的编码（不必转）
SAFE_CODEC = {"h264", "vp8", "vp9", "av1"}
# 容器本身浏览器就可能打不开（有编码也不管用）
SAFE_BOX = {".mp4", ".m4v", ".mov", ".webm"}


def _find_ffmpeg():
    env = os.environ.get("BNIMAGE_FFMPEG")
    cands = [Path(env)] if env else []
    here = Path(__file__).resolve().parent
    cands += [
        ROOT / "ffmpeg.exe",
        ROOT / "_internal" / "ffmpeg.exe",
        RES / "ffmpeg.exe",
        RES / "_internal" / "ffmpeg.exe",
        here.parent / "ffmpeg.exe",
        here.parent / "_internal" / "ffmpeg.exe",
    ]
    for c in cands:
        try:
            if c.is_file():
                return str(c)
        except OSError:
            pass
    return shutil.which("ffmpeg")


FFMPEG = _find_ffmpeg()
TX_DIR = CACHE / "tx"

_INFO_LOCK = threading.Lock()
_INFO: dict = {}

# 硬件编码器：N 卡 / 核显 / A 卡各试一次，都不行才用 libx264 软编。
# 测一次结果落盘，之后每次启动直接读，不再花几百毫秒重新试。
_ENC_FILE = CACHE / "h264-encoder.txt"
_ENC_LOCK = threading.Lock()
_ENC = {"name": ""}

_ENCODER_ARGS = {
    "h264_nvenc": ["-c:v", "h264_nvenc", "-preset", "p4", "-tune", "hq",
                   "-rc", "vbr", "-cq", "26", "-b:v", "0", "-profile:v", "high"],
    "h264_qsv": ["-c:v", "h264_qsv", "-preset", "veryfast",
                 "-global_quality", "26", "-look_ahead", "0"],
    "h264_amf": ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp",
                 "-qp_i", "24", "-qp_p", "26"],
    "libx264": ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
                "-profile:v", "high"],
}


def _encoder_works(name: str) -> bool:
    if not FFMPEG:
        return False
    try:
        p = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-nostdin",
             "-f", "lavfi", "-i", "color=c=black:s=256x144:d=0.2",
             "-c:v", name, "-f", "null", "-"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=15, creationflags=CREATE_NO_WINDOW)
        return p.returncode == 0
    except Exception:  # noqa: BLE001
        return False


def h264_encoder() -> str:
    """挑一个本机能用的 H.264 编码器，优先显卡。"""
    with _ENC_LOCK:
        if _ENC["name"]:
            return _ENC["name"]
        try:
            saved = _ENC_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            saved = ""
        if saved in _ENCODER_ARGS and _encoder_works(saved):
            _ENC["name"] = saved
            return saved
        for name in ("h264_nvenc", "h264_qsv", "h264_amf"):
            if name != saved and _encoder_works(name):
                _ENC["name"] = name
                try:
                    _ENC_FILE.write_text(name, encoding="utf-8")
                except OSError:
                    pass
                _note(f"视频转码用硬件编码 {name}")
                return name
        _ENC["name"] = "libx264"
        try:
            _ENC_FILE.write_text("libx264", encoding="utf-8")
        except OSError:
            pass
        return "libx264"


def _info_key(path: str):
    try:
        st = os.stat(path)
    except OSError:
        return None
    return (path, int(st.st_mtime), st.st_size)


def probe_video(path: str):
    """读容器头，拿到视频编码 / 尺寸 / 时长。结果按文件指纹缓存。"""
    key = _info_key(path)
    if not key:
        return None
    with _INFO_LOCK:
        hit = _INFO.get(key)
    if hit:
        return hit

    info = {"codec": "", "w": 0, "h": 0, "dur": 0.0, "audio": False,
            "container": ext_of(path), "tx": False, "reason": ""}
    if FFMPEG:
        try:
            p = subprocess.run(
                [FFMPEG, "-hide_banner", "-nostdin", "-i", path],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                timeout=25, creationflags=CREATE_NO_WINDOW,
            )
            txt = p.stderr.decode("utf-8", "replace")
            m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", txt)
            if m:
                info["dur"] = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
            vm = re.search(r"Stream #\d+:\d+.*?Video:\s*([a-zA-Z0-9_]+)", txt)
            if vm:
                info["codec"] = vm.group(1).lower()
            dm = re.search(r"Video:[^\n]*?(\d{2,5})x(\d{2,5})", txt)
            if dm:
                info["w"], info["h"] = int(dm.group(1)), int(dm.group(2))
            info["audio"] = bool(re.search(r"Stream #\d+:\d+.*?Audio:", txt))
        except Exception as exc:  # noqa: BLE001
            _dbg(f"ffmpeg 探测失败 {path}: {exc!r}")

    if not FFMPEG:
        info["reason"] = "没找到 ffmpeg"
    elif info["codec"] and info["codec"] not in SAFE_CODEC:
        info["tx"] = True
        info["reason"] = f"{info['codec']} 编码"
    elif info["container"] not in SAFE_BOX:
        info["tx"] = True
        info["reason"] = f"{info['container']} 容器"

    with _INFO_LOCK:
        if len(_INFO) > 800:
            _INFO.clear()
        _INFO[key] = info
    return info


def tx_key(path: str):
    key = _info_key(path)
    if not key:
        return None
    return hashlib.sha1(f"{key[0]}|{key[1]}|{key[2]}".encode("utf-8")).hexdigest()[:16]


def tx_target(path: str):
    k = tx_key(path)
    return TX_DIR / f"{k}.mp4" if k else None


TX_LOCK = threading.Lock()
TX_JOB: dict = {}


def tx_status(path: str):
    tgt = tx_target(path)
    if not tgt:
        return {"state": "error", "pct": 0, "msg": "路径无效"}
    if tgt.exists() and tgt.stat().st_size > 1024:
        return {"state": "ready", "pct": 100}
    with TX_LOCK:
        job = TX_JOB.get(tx_key(path))
        if job:
            return dict(job)
    return {"state": "idle", "pct": 0}


def tx_start(path: str):
    info = probe_video(path) or {}
    dur = info.get("dur") or 0
    key = tx_key(path)
    if not key:
        return
    with TX_LOCK:
        job = TX_JOB.get(key)
        if job and job.get("state") == "running":
            return
        TX_JOB[key] = {"state": "running", "pct": 0, "msg": ""}
    threading.Thread(target=_tx_worker, args=(path, key, dur), daemon=True).start()


def _tx_worker(path: str, key: str, dur: float):
    tgt = TX_DIR / f"{key}.mp4"
    part = TX_DIR / f"{key}.part.mp4"
    info = probe_video(path) or {}
    remux = info.get("codec") in SAFE_CODEC
    try:
        TX_DIR.mkdir(parents=True, exist_ok=True)
        cmd = [
            FFMPEG, "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
            "-i", path,
            "-map", "0:v:0", "-map", "0:a:0?",
        ]
        if remux:
            # 编码本身就合法（h264 等），只是容器打不开：直接换壳，不重编码，几秒钟搞定。
            cmd += ["-c:v", "copy"]
        else:
            enc = h264_encoder()
            cmd += ["-vf", "scale='min(1600,iw)':-2"]
            cmd += _ENCODER_ARGS.get(enc, _ENCODER_ARGS["libx264"])
            cmd += ["-pix_fmt", "yuv420p"]
        cmd += [
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats",
            "-f", "mp4", str(part),
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                creationflags=CREATE_NO_WINDOW)
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("out_time_us=") and dur > 0:
                try:
                    done = int(line.split("=", 1)[1]) / 1_000_000
                except ValueError:
                    continue
                pct = max(0, min(99, int(done / dur * 100)))
                with TX_LOCK:
                    if key in TX_JOB:
                        TX_JOB[key]["pct"] = pct
        proc.wait(timeout=600)
        err = b""
        if proc.stderr is not None:
            err = proc.stderr.read()[-500:]
        if proc.returncode == 0 and part.exists() and part.stat().st_size > 1024:
            os.replace(part, tgt)
            with TX_LOCK:
                TX_JOB[key] = {"state": "ready", "pct": 100, "msg": ""}
            _dbg(f"转码完成 {path}")
        else:
            msg = err.decode("utf-8", "replace").strip() or f"ffmpeg 退出码 {proc.returncode}"
            with TX_LOCK:
                TX_JOB[key] = {"state": "error", "pct": 0, "msg": msg[:300]}
            _dbg(f"转码失败 {path}: {msg[:300]}")
    except Exception as exc:  # noqa: BLE001
        with TX_LOCK:
            TX_JOB[key] = {"state": "error", "pct": 0, "msg": f"{exc!r}"[:300]}
        _dbg(f"转码异常 {path}: {exc!r}")
    finally:
        try:
            if part.exists():
                part.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------- 路径工具

def drives():
    out = []
    if os.name == "nt":
        mask = ctypes.windll.kernel32.GetLogicalDrives()
        for i, letter in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
            if mask & (1 << i):
                out.append({"name": f"{letter}:", "path": f"{letter}:\\"})
    else:
        out.append({"name": "/", "path": "/"})
    return out


def shortcuts():
    home = Path.home()
    cand = [
        ("桌面", home / "Desktop"),
        ("图片", home / "Pictures"),
        ("下载", home / "Downloads"),
        ("文档", home / "Documents"),
        ("视频", home / "Videos"),
    ]
    out = []
    for name, p in cand:
        if p.exists():
            out.append({"name": name, "path": str(p)})
    return out


def _image_head_ok(data: bytes) -> bool:
    """只认文件头，避免把不相干的内容写进图片扩展名。"""
    if len(data) < 16:
        return False
    if data[:2] == b"\xff\xd8":
        return True                                  # JPEG
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return True                                  # PNG
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True                                  # WebP
    if data[:2] == b"BM":
        return True                                  # BMP
    return False


def safe_path(raw: str):
    if not raw:
        return None
    p = urllib.parse.unquote(raw)
    p = p.replace("/", os.sep) if os.sep == "\\" else p
    if "\x00" in p:
        return None
    norm = os.path.normpath(p)
    if ".." in norm.split(os.sep):
        return None
    return norm


def crumbs_for(path: str):
    out = [{"name": "此电脑", "path": ""}]
    if not path:
        return out
    parts = [x for x in path.split(os.sep) if x]
    cur = ""
    for i, part in enumerate(parts):
        if i == 0:
            cur = part + os.sep
            out.append({"name": part, "path": cur})
        else:
            cur = os.path.join(cur, part)
            out.append({"name": part, "path": cur})
    return out


def list_dir(path: str):
    dirs, files, ignored, presentations = [], [], 0, 0
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if e.name.startswith(".") or e.name.startswith("~$"):
                        continue
                    # 系统自己生成的文件，不算「不支持的文件」，免得白提醒
                    if e.name.lower() in JUNK_FILES:
                        continue
                    if e.is_dir(follow_symlinks=False):
                        dirs.append({"name": e.name, "path": e.path, "kind": "dir"})
                        continue
                    if not e.is_file():
                        continue
                    k = classify(e.name)
                    if k == "presentation":
                        presentations += 1
                        continue
                    if k == "other":
                        ignored += 1
                        continue
                    st = e.stat()
                    ext = ext_of(e.name)
                    files.append({
                        "name": e.name,
                        "path": e.path,
                        "kind": k,
                        "ext": ext.lstrip("."),
                        "size": st.st_size,
                        "mtime": int(st.st_mtime),
                        "native": ext in NATIVE_IMAGE,
                    })
                except OSError:
                    continue
    except PermissionError:
        pass
    dirs.sort(key=lambda x: natural_key(x["name"]))
    files.sort(key=lambda x: natural_key(x["name"]))
    return dirs, files, ignored, presentations


# ---------------------------------------------------------------- HTTP

def error_box(msg):
    if os.name == "nt":
        try:
            ctypes.windll.user32.MessageBoxW(None, str(msg), APP_NAME, 0x10)
            return
        except Exception:
            pass
    say(msg)


def say(msg=""):
    try:
        if sys.stdout is not None:
            print(msg, flush=True)
    except Exception:
        pass


DEBUG = bool(os.environ.get("BNIMAGE_DEBUG") or os.environ.get("FOLIO_DEBUG"))
# 调试模式：打开 WebView2 开发者工具（窗口里右键「检查」），方便现场调界面。
# 只影响开发，正常使用不要开——开着会多占一点内存。
DEV = bool(os.environ.get("BNIMAGE_DEV"))


def _dbg(msg):
    """BNIMAGE_DEBUG=1 时把关键动作写进数据目录的 debug.log。
    窗口版没有控制台，出问题时这是唯一能看到线程到底跑没跑的地方。"""
    if not DEBUG:
        return
    try:
        with (CACHE / "debug.log").open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} [{threading.current_thread().name}] {msg}\n")
    except Exception:
        pass


LAST_HIT = time.time()
LAST_INDEX = time.time()
AUTO_EXIT = True
PENDING = {"path": None, "ts": 0.0, "id": 0, "taken": 0.0}
PENDING_LOCK = threading.Lock()
PENDING_EVENT = threading.Event()
# 投递后必须由页面回执（/api/ack）才算送达。没有回执说明这条通道其实
# 已经死了（连接还在、渲染进程没了，或者请求被浏览器挂起），目标过一会儿
# 自动重新变成可投递，绝不"被幽灵连接吞掉"。
ACK_TIMEOUT = 2.5
# 启动器决定"关掉旧窗口、按新地址重开"时会先申请一个保护期。
# 这期间窗口必然短暂消失，服务不能把它当成"用户关闭了界面"而自杀。
WINDOW_GRACE = 0.0
# 上一个实例的 pid / 窗口句柄：必须在写自己的锁之前抓住，
# 否则收拾"卡死的旧实例"时读到的已经是自己了。
PREV_PID = 0
PREV_HWND = 0


def _maybe_exit(mark):
    """页面卸载后收尾。不能用“最近有没有请求”来判断：
    长轮询会让连接几乎一直有请求，永远等不到空闲。
    改为看页面有没有重新加载（刷新会重新请求首页）。"""
    if not AUTO_EXIT:
        return
    if time.time() < WINDOW_GRACE:      # 正在换窗口，别收摊
        return
    if LAST_INDEX <= mark:
        say("\n  窗口已关闭，服务退出。")
        clear_lock()
        os._exit(0)


class Handler(BaseHTTPRequestHandler):
    server_version = f"{APP_NAME}/{APP_VERSION}"
    protocol_version = "HTTP/1.1"

    def _touch(self):
        global LAST_HIT
        LAST_HIT = time.time()

    def log_message(self, fmt, *args):
        pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError,
                TimeoutError, OSError):
            # 浏览器关窗/切页时连接被中止，属于正常情况，不必写日志
            self.close_connection = True
        except Exception as exc:  # noqa: BLE001
            _dbg(f"请求处理异常 {self.path}: {exc!r}")
            self.close_connection = True

    # -- helpers ---------------------------------------------------
    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8",
                   {"Cache-Control": "no-store"})

    def _file(self, path, ctype, download=False, no_cache=False):
        try:
            st = os.stat(path)
        except OSError:
            return self._send(404, "not found")
        size = st.st_size
        etag = f'"{int(st.st_mtime)}-{size}"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        partial = False
        if rng and rng.startswith("bytes="):
            spec = rng[6:].split(",")[0].strip()
            try:
                if spec.startswith("-"):
                    start = max(0, size - int(spec[1:]))
                else:
                    a, _, b = spec.partition("-")
                    start = int(a)
                    if b:
                        end = min(int(b), size - 1)
                if start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                partial = True
            except ValueError:
                start, end = 0, size - 1
        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache" if no_cache else "private, max-age=600")
        if download:
            self.send_header("Content-Disposition", "inline")
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command == "HEAD":
            return
        try:
            with open(path, "rb") as f:
                f.seek(start)
                left = length
                while left > 0:
                    chunk = f.read(min(262144, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- 保存编辑结果 -----------------------------------------------
    def do_POST(self):
        self._touch()
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path != "/api/save":
            return self._send(404, "not found")
        q = urllib.parse.parse_qs(parsed.query)

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            return self._json({"ok": False, "error": "内容为空或超过 200MB"}, 400)

        try:
            data = self.rfile.read(length)
        except (OSError, ValueError):
            return self._json({"ok": False, "error": "读取上传失败"}, 400)
        if len(data) < length:
            return self._json({"ok": False, "error": "上传未完成"}, 400)

        target = safe_path(q.get("path", [""])[0])
        if not target:
            return self._json({"ok": False, "error": "路径不合法"}, 400)

        ext = os.path.splitext(target)[1].lower()
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".bmp"):
            return self._json({"ok": False, "error": "不支持写入该格式"}, 400)

        folder = os.path.dirname(target)
        if not folder or not os.path.isdir(folder):
            return self._json({"ok": False, "error": "目标文件夹不存在"}, 404)

        overwrite = q.get("over", ["0"])[0] == "1"
        existed = os.path.exists(target)
        if existed and not overwrite:
            return self._json({"ok": False, "error": "同名文件已存在"}, 409)

        if not _image_head_ok(data):
            return self._json({"ok": False, "error": "图像数据不完整"}, 400)

        tmp = target + ".bnpart"
        try:
            with open(tmp, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, target)
        except OSError as exc:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass
            return self._json({"ok": False, "error": f"写入失败：{exc.strerror or exc}"}, 500)

        return self._json({
            "ok": True,
            "path": target,
            "name": os.path.basename(target),
            "size": len(data),
            "overwrote": existed,
        })

    # -- routing ---------------------------------------------------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        _dbg("GET " + self.path)
        self._touch()
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        q = urllib.parse.parse_qs(parsed.query)

        try:
            if route in ("/", "/index.html"):
                global LAST_INDEX
                LAST_INDEX = time.time()          # 记录页面加载，用于区分刷新与关闭
                html = (WEB / "index.html").read_text(encoding="utf-8")
                try:
                    ver = int(max((WEB / "style.css").stat().st_mtime,
                                  (WEB / "app.js").stat().st_mtime))
                except OSError:
                    ver = 0
                html = html.replace("?v=0", f"?v={ver}")
                return self._send(200, html, "text/html; charset=utf-8",
                                  {"Cache-Control": "no-cache"})
            if route.startswith("/static/"):
                name = route[8:]
                if "/" in name or ".." in name:
                    return self._send(404, "not found")
                target = WEB / name
                if not target.exists():
                    return self._send(404, "not found")
                return self._file(str(target), mime_of(name), no_cache=True)

            if route == "/api/route":
                raw = q.get("path", [""])[0]
                pth = safe_path(raw) or urllib.parse.unquote(raw)
                with PENDING_LOCK:
                    PENDING["path"] = pth
                    PENDING["ts"] = time.time()
                    PENDING["id"] += 1
                    PENDING["taken"] = 0.0       # 新目标，等页面回执
                    rid = PENDING["id"]
                PENDING_EVENT.set()          # 唤醒正在长轮询的页面
                return self._json({"ok": True, "id": rid})

            if route == "/api/ack":
                # 页面确认"我收到了"，这时才真正把目标清掉
                try:
                    rid = int(q.get("id", ["0"])[0])
                except ValueError:
                    rid = 0
                with PENDING_LOCK:
                    ok = bool(rid) and rid == PENDING["id"]
                    if ok:
                        PENDING["path"] = None
                        PENDING["taken"] = 0.0
                return self._json({"ok": ok})

            if route == "/api/keep":
                global WINDOW_GRACE
                try:
                    sec = float(q.get("sec", ["10"])[0])
                except ValueError:
                    sec = 10.0
                WINDOW_GRACE = time.time() + max(0.0, min(sec, 60.0))
                return self._json({"ok": True, "grace": WINDOW_GRACE})

            if route == "/api/clear":
                # 启动器已经换了窗口、靠 URL 直接打开了目标，别让旧目标再投一次
                with PENDING_LOCK:
                    PENDING["path"] = None
                    PENDING["taken"] = 0.0
                return self._json({"ok": True})

            if route == "/api/peek":
                # 只读：目标还在（没被回执）就说明页面上没人接住
                with PENDING_LOCK:
                    pth = PENDING["path"]
                    stamp = PENDING["ts"]
                if pth and (time.time() - stamp) < 15:
                    return self._json({"path": pth})
                return self._json({"path": None})

            if route == "/api/pending":
                # 长轮询：没目标就挂着，有目标立刻返回；省掉 800ms 空转。
                # 投递出去不删，等 /api/ack；回执超时就重新变成可投递。
                try:
                    wait = float(q.get("wait", ["0"])[0])
                except ValueError:
                    wait = 0.0
                deadline = time.time() + max(0.0, min(wait, 25.0))
                while True:
                    now = time.time()
                    give = None
                    with PENDING_LOCK:
                        pth = PENDING["path"]
                        stamp = PENDING["ts"]
                        taken = PENDING["taken"]
                        free = (taken == 0.0) or (now - taken > ACK_TIMEOUT)
                        if pth and (now - stamp) < 15 and free:
                            PENDING["taken"] = now
                            PENDING["id"] += 1        # 每次投递换号，旧回执失效
                            give = (pth, PENDING["id"])
                    if give:
                        pth, rid = give
                        return self._json({"path": pth, "id": rid,
                                           "dir": os.path.isdir(pth)})
                    remain = deadline - time.time()
                    if remain <= 0:
                        return self._json({"path": None})
                    PENDING_EVENT.clear()
                    with PENDING_LOCK:              # 关掉 clear 与 wait 之间的缝隙
                        if PENDING["path"]:
                            continue
                    PENDING_EVENT.wait(min(remain, 5.0))

            if route == "/api/settings":
                try:
                    os.startfile("ms-settings:defaultapps")  # noqa: S606
                except Exception:
                    return self._json({"ok": False})
                return self._json({"ok": True})

            if route == "/api/assoc":
                ok, extra = assoc_status()
                return self._json({"registered": ok, "hint": extra,
                                   "frozen": FROZEN})

            if route == "/api/register":
                ok, msg = register_files()
                if ok:
                    try:
                        os.startfile("ms-settings:defaultapps")  # noqa: S606
                    except Exception:
                        pass
                return self._json({"ok": ok, "msg": msg})

            if route == "/api/unregister":
                ok, msg = unregister_files()
                return self._json({"ok": ok, "msg": msg})

            if route == "/api/hello":
                return self._json({"app": "bnimage", "version": APP_VERSION})

            if route == "/api/theme":
                # 页面切浅色/深色时顺手把系统标题栏一起换掉
                m = (q.get("mode", ["dark"])[0] or "dark").strip().lower()
                m = "light" if m == "light" else "dark"
                return self._json({"ok": set_caption_theme(m), "mode": m})

            if route == "/api/bye":
                mark = time.time()
                if AUTO_EXIT:
                    threading.Timer(1.2, _maybe_exit, args=(mark,)).start()
                return self._send(200, "bye", "text/plain; charset=utf-8")

            if route == "/api/drives":
                return self._json({"drives": drives(), "shortcuts": shortcuts(),
                                   "home": str(Path.home())})

            if route == "/api/list":
                raw = q.get("path", [""])[0]
                if not raw.strip():
                    return self._json({"path": "", "crumbs": crumbs_for(""),
                                       "items": [], "ignored": 0, "presentations": 0,
                                       "root": True})
                path = safe_path(raw)
                if not path or not os.path.isdir(path):
                    return self._json({"error": "目录不可访问"}, 404)
                dirs, files, ignored, pres = list_dir(path)
                parent = os.path.dirname(path.rstrip(os.sep))
                if parent == path or (len(path) <= 3):
                    parent = ""
                return self._json({
                    "path": path,
                    "parent": parent,
                    "crumbs": crumbs_for(path),
                    "items": dirs + files,
                    "ignored": ignored,
                    "presentations": pres,
                })

            if route == "/api/vframe":
                raw = q.get("path", [""])[0]
                path = safe_path(raw)
                if not path or not os.path.isfile(path):
                    return self._send(404, "not found")
                try:
                    size = max(120, min(1024, int(q.get("w", ["420"])[0] or 420)))
                    res = build_vframe(path, size)
                except Exception:
                    res = None
                if res is None:
                    return self._send(404, "no frame")
                data, ctype = res
                return self._send(200, data, ctype,
                                  {"Cache-Control": "private, max-age=86400"})

            if route in ("/api/thumb", "/api/render"):
                raw = q.get("path", [""])[0]
                path = safe_path(raw)
                if not path or not os.path.isfile(path):
                    return self._send(404, "not found")
                try:
                    if route == "/api/thumb":
                        size = max(48, min(1024, int(q.get("w", ["360"])[0] or 360)))
                        res = build_thumb(path, size)
                    else:
                        size = max(256, min(4096, int(q.get("w", ["2560"])[0] or 2560)))
                        data = build_render(path, size)
                        res = (data, "image/webp") if data else None
                except Exception:
                    res = None
                if res is None:
                    # 无法转码，退回原文件
                    return self._file(path, mime_of(path))
                data, ctype = res
                return self._send(200, data, ctype,
                                  {"Cache-Control": "private, max-age=86400"})

            if route == "/api/meta":
                path = safe_path(q.get("path", [""])[0])
                if not path or not os.path.isfile(path):
                    return self._json({"error": "文件不存在"}, 404)
                info = read_exif(path) if classify(path) == "image" else None
                try:
                    st = os.stat(path)
                    base = {"size": st.st_size, "mtime": int(st.st_mtime),
                            "name": os.path.basename(path), "path": path,
                            "kind": classify(path), "ext": ext_of(path).lstrip(".")}
                except OSError:
                    base = {}
                if info:
                    base.update(info)
                return self._json(base)

            if route == "/api/open":
                path = safe_path(q.get("path", [""])[0])
                if path and os.path.exists(path):
                    try:
                        if os.name == "nt":
                            os.startfile(path)  # noqa: S606
                        else:
                            subprocess.Popen(["xdg-open", path])
                    except Exception:
                        return self._json({"ok": False}, 500)
                    return self._json({"ok": True})
                return self._json({"ok": False}, 404)

            if route == "/api/vprobe":
                path = safe_path(q.get("path", [""])[0])
                if not path or not os.path.isfile(path):
                    return self._json({"ok": False}, 404)
                info = probe_video(path) or {}
                return self._json({
                    "ok": True,
                    "codec": info.get("codec", ""),
                    "container": info.get("container", ""),
                    "tx": bool(info.get("tx")),
                    "reason": info.get("reason", ""),
                    "dur": info.get("dur", 0),
                    "w": info.get("w", 0),
                    "h": info.get("h", 0),
                    "ffmpeg": bool(FFMPEG),
                })

            if route == "/api/tx":
                path = safe_path(q.get("path", [""])[0])
                if not path or not os.path.isfile(path):
                    return self._json({"state": "error", "pct": 0, "msg": "文件不存在"})
                st = tx_status(path)
                retry = q.get("retry", ["0"])[0] == "1"
                if FFMPEG and (st.get("state") == "idle" or (retry and st.get("state") == "error")):
                    info = probe_video(path) or {}
                    if info.get("tx") or retry:
                        tx_start(path)
                        st = tx_status(path)
                st["url"] = "/tx/" + urllib.parse.quote(path, safe="")
                return self._json(st)

            if route.startswith("/tx/"):
                path = safe_path(route[4:])
                if not path or not os.path.isfile(path):
                    return self._send(404, "not found")
                tgt = tx_target(path)
                if not tgt or not tgt.exists():
                    return self._send(409, "转码尚未完成")
                return self._file(tgt, "video/mp4", download=True, no_cache=True)

            if route.startswith("/fs/"):
                rel = route[4:]
                path = safe_path(rel)
                if not path or not os.path.isfile(path):
                    return self._send(404, "not found")
                return self._file(path, mime_of(path), download=True)

            return self._send(404, "not found")
        except Exception as exc:  # noqa: BLE001
            try:
                return self._send(500, f"error: {exc}")
            except Exception:
                return


PORT_START = 8787
LOCK = CACHE / "instance.json"


def _direct_open(url, timeout=0.8):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return opener.open(url, timeout=timeout)


def _pid_alive(pid):
    """进程是否还在（毫秒级判定，不做任何网络等待）"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    k32 = ctypes.windll.kernel32
    handle = k32.OpenProcess(0x00100000, False, pid)   # SYNCHRONIZE
    if not handle:
        return False
    try:
        return k32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT = 仍在运行
    finally:
        k32.CloseHandle(handle)


def read_lock_info():
    try:
        info = json.loads(LOCK.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return info if isinstance(info, dict) else {}


def _kill_pid(pid, wait=1.5):
    """结束指定进程（只用于已经确认卡死的自家实例）"""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0 or pid == os.getpid() or os.name != "nt":
        return False
    k32 = ctypes.windll.kernel32
    h = k32.OpenProcess(0x0001 | 0x00100000, False, pid)   # TERMINATE | SYNCHRONIZE
    if not h:
        return False
    try:
        k32.TerminateProcess(h, 1)
        k32.WaitForSingleObject(h, int(wait * 1000))
        return True
    finally:
        k32.CloseHandle(h)


def _profile_dir():
    """WebView2 的用户数据目录（缓存、localStorage 都放这儿）"""
    return CACHE / "ui"


def _profile_locked():
    """WebView2 的用户数据目录是否还被别的进程攥着。

    WebView2 对同一个 user-data-dir 是独占的。判断方式不是猜进程名，
    而是直接试着给 EBWebView 目录改名——被占用就一定失败，
    这个信号比枚举 msedgewebview2.exe 精确得多，也不会误伤别的程序。"""
    d = _profile_dir() / "EBWebView"
    if not d.exists():
        return False
    tmp = d.with_name(f"EBWebView.probe{os.getpid()}")
    try:
        os.rename(d, tmp)
    except OSError:
        return True
    try:
        os.rename(tmp, d)
    except OSError:
        pass
    return False


def _retire_profile():
    """把当前这份 WebView2 数据目录整个挪开，让下一次从零建。

    强杀上一个进程后，目录里的 lockfile 与共享内存未必立刻干净；
    直接在它上面再建一次环境，两边会互相等着，谁都动不了——
    实测表现就是窗口出来一片白、UI 线程挂起、连 HTTP 都不应。
    挪开是最省事的解：新建一份，旧的整体丢掉（缓存而已）。"""
    d = _profile_dir()
    if not d.exists():
        return True
    dst = d.with_name("ui.old-" + time.strftime("%Y%m%d%H%M%S"))
    try:
        os.rename(d, dst)
        return True
    except OSError as exc:
        _note(f"旧数据目录挪不动：{exc!r}")
        return False


def sweep_old_profiles():
    """清掉挪开的历史数据目录（删不掉就留在下次，绝不阻塞启动）"""
    try:
        for p in CACHE.glob("ui.old-*"):
            shutil.rmtree(p, ignore_errors=True)
    except OSError:
        pass


def reap_stale_instance(pid=None):
    """把卡死的旧实例收拾干净。

    这是"重开两次也各自未响应"的关键：旧进程虽然界面已经死了，但它的
    WebView2 浏览器进程还活着，还占着 %LOCALAPPDATA%\\BNImage\\ui 这个目录。
    新进程在 CreateCoreWebView2Environment 里会一直等这把锁，
    于是每一次重新打开都跟着一起挂——用户看到的就是"连续几次都未响应"。
    顺序必须是：先结束旧进程 → 等它把目录交出来 → 挪开旧目录 → 再建自己的窗口。"""
    if pid is None:
        pid = read_lock_info().get("pid")
    alive = _pid_alive(pid)
    locked = _profile_locked()
    _note(f"收拾旧实例：pid={pid} alive={alive} locked={locked}")
    killed = _kill_pid(pid) if alive else False
    if killed:
        _note(f"已结束无响应的旧实例 pid={pid}")
    elif not locked:
        return True                     # 旧进程早没了，目录也没被占，不必多动
    deadline = time.time() + 4.0
    while time.time() < deadline:
        if not _profile_locked():
            break
        time.sleep(0.1)
    else:
        return False
    if killed or locked:
        _retire_profile()               # 换一份干净的数据目录，绕开残留状态
        time.sleep(0.4)                 # 让系统把文件句柄收干净
    return True


def write_lock(port):
    try:
        LOCK.write_text(
            json.dumps({"pid": os.getpid(), "port": port, "ts": time.time()}),
            encoding="utf-8",
        )
    except OSError:
        pass


def clear_lock():
    try:
        LOCK.unlink()
    except OSError:
        pass


def running_port():
    """返回已在运行的实例端口，没有则 None。

    早先的实现是直接请求 /api/hello，但本机对未监听的回环端口不会立刻拒绝，
    而是一路挂到 connect 超时（实测 0.8~2s），冷启动白等近 1 秒。
    改成锁文件判定：读一个 JSON + 查进程存活，都是毫秒级；
    仅当锁里的 PID 被系统复用时才补一次 120ms 的极短连接确认。
    """
    try:
        info = json.loads(LOCK.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    port = info.get("port")
    if not isinstance(port, int) or not 1 <= port <= 65535:
        clear_lock()
        return None
    if not _pid_alive(info.get("pid")):
        clear_lock()          # 上次是崩溃/强杀退出的，锁是陈的
        return None
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.12):
            return port
    except OSError:
        clear_lock()
        return None


def _exclusive_socket():
    """Windows 上必须用 SO_EXCLUSIVEADDRUSE：SO_REUSEADDR 会允许**两个进程
    同时监听同一端口**，连接归最后绑定的那个，表现就是"服务在、请求没人应"。
    实测两个 BNImage 同时 LISTEN 127.0.0.1:8787，页面因此一片空白。"""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if os.name == "nt":
        try:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        except OSError:
            pass
    return s


def free_port(start=8787, tries=24):
    for p in range(start, start + tries):
        s = _exclusive_socket()
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return 0


class LocalServer(ThreadingHTTPServer):
    """独占端口的 HTTP 服务（见 _exclusive_socket 的说明）"""
    daemon_threads = True
    allow_reuse_address = False

    def server_bind(self):
        if os.name == "nt":
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        super().server_bind()



# ---------------------------------------------------------------- 系统文件关联

ASSOC_IMAGE = [
    "jpg", "jpeg", "jpe", "jfif", "pjpeg", "png", "apng", "gif",
    "webp", "avif", "bmp", "dib", "ico", "cur", "svg",
    "tif", "tiff", "heic", "heif", "hif", "jxl",
]
ASSOC_VIDEO = [
    "mp4", "m4v", "mov", "webm", "ogv", "ogg", "ts", "m2ts", "mts",
    "mkv", "avi", "wmv", "flv", "f4v", "mpg", "mpeg", "vob", "3gp", "3g2", "rmvb",
]
ASSOC_PDF = ["pdf"]

ASSOC_PROGIDS = [
    ("BNImage.Image", "BNImage 图片", ASSOC_IMAGE),
    ("BNImage.Video", "BNImage 视频", ASSOC_VIDEO),
    ("BNImage.Pdf", "BNImage 文档", ASSOC_PDF),
]
ASSOC_HTML = ["html", "htm", "xhtml"]


def type_table():
    """按格式区分的类型表（icons/types.json 由 tools/make_type_icons.py 生成）。

    返回 [{label, group, ico, exts}]；文件缺失时返回空表，注册会退回旧的分组方式。
    """
    try:
        data = json.loads((ICON_DIR / "types.json").read_text(encoding="utf-8"))
        return data.get("types") or []
    except Exception:  # noqa: BLE001
        return []


def _type_progid(item):
    return f"BNImage.{item['group']}.{item['label']}"


def _reg_set(path, name, value):
    import winreg
    try:
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_WRITE) as k:
            winreg.SetValueEx(k, name, 0, winreg.REG_SZ, value)
        return True
    except OSError:
        return False


def _reg_del_value(path, name):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path, 0, winreg.KEY_ALL_ACCESS) as k:
            winreg.DeleteValue(k, name)
        return True
    except OSError:
        return False


def _reg_get(path, name=""):
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def _reg_del_tree(path):
    import winreg
    subs = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as k:
            i = 0
            while True:
                try:
                    subs.append(winreg.EnumKey(k, i))
                except OSError:
                    break
                i += 1
    except OSError:
        return
    for sub in subs:
        _reg_del_tree(path + "\\" + sub)
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
    except OSError:
        pass


def _notify_shell():
    try:
        ctypes.windll.shell32.SHChangeNotify(0x08000000, 0, None, None)
    except Exception:
        pass


def assoc_status():
    if os.name != "nt":
        return False, "仅支持 Windows"
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\RegisteredApplications") as k:
            winreg.QueryValueEx(k, "BNImage")
        return True, ""
    except OSError:
        return False, ""


def _purge_legacy():
    """清掉旧名 Folio 留下的关联。
    程序改名后如果不清，右键"打开方式"里会同时挂着 Folio 和 BNImage 两套，
    默认应用页面也会多出一条已经不存在的程序。顺带在安装时自动做一次迁移。"""
    if os.name != "nt":
        return
    import winreg
    exts = {e for _p, _l, lst in ASSOC_PROGIDS for e in lst}
    for prog in ("Folio.Image", "Folio.Video", "Folio.Pdf"):
        _reg_del_tree(rf"Software\Classes\{prog}")
        for e in exts:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                    rf"Software\Classes\.{e}\OpenWithProgids",
                                    0, winreg.KEY_ALL_ACCESS) as k:
                    winreg.DeleteValue(k, prog)
            except OSError:
                pass
    _reg_del_tree(r"Software\Classes\Applications\Folio.exe")
    _reg_del_tree(r"Software\Folio")
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\RegisteredApplications",
                            0, winreg.KEY_ALL_ACCESS) as k:
            winreg.DeleteValue(k, "Folio")
    except OSError:
        pass


def register_files():
    if os.name != "nt":
        return False, "仅支持 Windows"
    if not FROZEN:
        return False, "请使用打包后的 BNImage.exe 注册"
    exe = str(Path(sys.executable).resolve())
    cmd = f'"{exe}" "%1"'
    icon = f"{exe},0"
    try:
        _purge_legacy()

        app = r"Software\Classes\Applications\BNImage.exe"
        _reg_set(app, "", "BNImage")
        _reg_set(app, "FriendlyAppName", "BNImage 统一查看器")
        _reg_set(app + r"\DefaultIcon", "", icon)
        _reg_set(app + r"\shell\open\command", "", cmd)

        cap = r"Software\BNImage\Capabilities"
        _reg_set(cap, "ApplicationName", "BNImage")
        _reg_set(cap, "ApplicationDescription",
                 "统一文件查看器：照片 / 图形 / 视频 / PDF / HTML")

        types = type_table()
        if types:
            for t in types:
                prog = _type_progid(t)
                ico = ICON_DIR / t["ico"]
                base = rf"Software\Classes\{prog}"
                _reg_set(base, "", f"BNImage {t['label']} 文件")
                _reg_set(base + r"\DefaultIcon", "",
                         str(ico) if ico.exists() else icon)
                _reg_set(base + r"\shell\open\command", "", cmd)
                for e in t["exts"]:
                    _reg_set(rf"Software\Classes\.{e}\OpenWithProgids", prog, "")
                    # 扩展名默认值指向本格式的 ProgID，资源管理器才会按格式画图标。
                    # 只在本机没设过默认应用时补上，已有选择（UserChoice）不动。
                    cur = _reg_get(rf"Software\Classes\.{e}", "")
                    if not cur or str(cur).startswith("BNImage"):
                        _reg_set(rf"Software\Classes\.{e}", "", prog)
                    _reg_set(cap + r"\FileAssociations", f".{e}", prog)
            # 旧的三个分组 ProgID 图标是同一个 BN，留着会让「打开方式」出现两套；
            # 删掉 ProgID 后还要把它从各扩展名的候选里摘掉，否则图标会退成白页
            for prog, _label, exts in ASSOC_PROGIDS:
                _reg_del_tree(rf"Software\Classes\{prog}")
                for e in exts:
                    _reg_del_value(rf"Software\Classes\.{e}\OpenWithProgids", prog)
        else:
            for prog, label, exts in ASSOC_PROGIDS:
                base = rf"Software\Classes\{prog}"
                _reg_set(base, "", label)
                _reg_set(base + r"\DefaultIcon", "", icon)
                _reg_set(base + r"\shell\open\command", "", cmd)
                for e in exts:
                    _reg_set(rf"Software\Classes\.{e}\OpenWithProgids", prog, "")
                    _reg_set(cap + r"\FileAssociations", f".{e}", prog)

        _reg_set(r"Software\RegisteredApplications", "BNImage",
                 r"Software\BNImage\Capabilities")
        _notify_shell()
        return True, "已写入系统关联"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)


def unregister_files():
    import winreg
    if os.name != "nt":
        return False, "仅支持 Windows"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\RegisteredApplications",
                            0, winreg.KEY_ALL_ACCESS) as k:
            winreg.DeleteValue(k, "BNImage")
    except OSError:
        pass
    groups = [(prog, exts) for prog, _label, exts in ASSOC_PROGIDS]
    for t in type_table():
        groups.append((_type_progid(t), t["exts"]))
    for prog, exts in groups:
        _reg_del_tree(rf"Software\Classes\{prog}")
        for e in exts:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                    rf"Software\Classes\.{e}\OpenWithProgids",
                                    0, winreg.KEY_ALL_ACCESS) as k:
                    winreg.DeleteValue(k, prog)
            except OSError:
                pass
            # 扩展名默认值是我们写进去的才撤掉，别动别人的
            cur = _reg_get(rf"Software\Classes\.{e}", "")
            if cur and str(cur) == prog:
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                        rf"Software\Classes\.{e}",
                                        0, winreg.KEY_ALL_ACCESS) as k:
                        winreg.DeleteValue(k, "")
                except OSError:
                    pass
    _reg_del_tree(r"Software\Classes\Applications\BNImage.exe")
    _reg_del_tree(r"Software\BNImage")
    _purge_legacy()
    _notify_shell()
    return True, "已移除关联"


WINDOW_KEYS = ("统一查看器", "BNImage", "127.0.0.1", "localhost")

# ---------------------------------------------------------------- 窗口层
# 首选：进程内原生窗口（WinForms 外壳 + Edge WebView2 内核）。
# 窗口属于本进程，关闭事件由我们自己收到，不再需要"猜窗口还在不在"。
# 退路：环境里没有 WebView2 运行时时，仍可用 Edge 的 --app 窗口。

HAS_WEBVIEW = False
webview = None
WEBVIEW2_PV = ""
WIN_HWND = 0        # 本进程原生窗口的句柄（shown 之后才有），给标题栏染色用


def _webview2_version():
    """读 WebView2 运行时版本；没有则返回空串"""
    if os.name != "nt":
        return ""
    import winreg
    key = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for root, prefix in ((winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node"),
                         (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE"),
                         (winreg.HKEY_CURRENT_USER, r"SOFTWARE")):
        try:
            with winreg.OpenKey(root, prefix + "\\" + key) as k:
                pv = str(winreg.QueryValueEx(k, "pv")[0])
            if pv and pv != "0.0.0.0":
                return pv
        except OSError:
            continue
    return ""


def _init_gui():
    global HAS_WEBVIEW, webview, WEBVIEW2_PV
    if os.name != "nt":
        return
    ui_mode = (os.environ.get("BNIMAGE_UI") or os.environ.get("FOLIO_UI") or "").strip().lower()
    if ui_mode == "edge":
        # 可选：用 Edge 应用窗口代替内置窗口。冷启动快约 0.4 秒，
        # 但要额外起一个浏览器进程，窗口也不再由本进程所有。
        _note("BNIMAGE_UI=edge：改用 Edge 应用窗口")
        return
    WEBVIEW2_PV = _webview2_version()
    if not WEBVIEW2_PV:
        _note("没有 WebView2 运行时，退回 Edge 应用窗口")
        return
    try:
        import webview as _wv
        webview = _wv
        HAS_WEBVIEW = True
    except Exception as exc:  # noqa: BLE001
        _note(f"import webview 失败：{exc!r}")
        return
    # 建窗口前先确认 WebView2 的数据目录没人占着。占着就先收拾旧实例；
    # 收拾不动就干脆不用内置窗口——宁可退回 Edge 窗口，也绝不给用户一个白屏。
    locked = _profile_locked()
    if locked:
        _note("WebView2 数据目录被占用，尝试清掉旧实例")
        if not reap_stale_instance(PREV_PID or None):
            _note("数据目录仍未释放，本次改用 Edge 应用窗口")
            HAS_WEBVIEW = False
    else:
        _note(f"数据目录空闲（locked={locked}, prev={PREV_PID}）")


def find_app_windows(match=None):
    """找出标题命中的可见窗口（用于判断界面是否还存在）
    注意：Edge 应用模式刚打开时标题是主机名，页面加载完才变成 <title>，
    所以必须同时认 127.0.0.1，否则会把活窗口当成已关闭。"""
    if os.name != "nt":
        return []
    from ctypes import wintypes
    keys = (match,) if match else WINDOW_KEYS
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        try:
            n = user32.GetWindowTextLengthW(hwnd)
            if n:
                buf = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(hwnd, buf, n + 1)
                title = buf.value
                if any(k in title for k in keys) and user32.IsWindowVisible(hwnd):
                    found.append(hwnd)
        except Exception:
            pass
        return True

    try:
        user32.EnumWindows(_cb, 0)
    except Exception:
        return []
    return found


def focus_app_window():
    """把已有窗口提到前台，成功返回 True"""
    hs = find_app_windows()
    if not hs:
        return False
    user32 = ctypes.windll.user32
    h = hs[0]
    try:
        if user32.IsIconic(h):
            user32.ShowWindow(h, 9)      # SW_RESTORE
        user32.SetForegroundWindow(h)
        return True
    except Exception:
        return False


def close_app_windows():
    """主动关掉界面窗口（页面已卡死、只能整页重开时用）"""
    hs = find_app_windows()
    if not hs:
        return False
    user32 = ctypes.windll.user32
    for h in hs:
        try:
            user32.PostMessageW(h, 0x0010, 0, 0)     # WM_CLOSE
        except Exception:
            pass


def _account_hwnd(hwnd):
    """把窗口句柄记进锁文件：下次双击可以精确定位这个窗口，
    不用再靠标题枚举去猜（也就能把最小化的窗口正确还原）。"""
    try:
        info = json.loads(LOCK.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {"pid": os.getpid(), "port": None, "ts": time.time()}
    info["hwnd"] = int(hwnd)
    try:
        LOCK.write_text(json.dumps(info), encoding="utf-8")
    except OSError:
        pass


def window_hung(hwnd, timeout=1200):
    """问窗口一句"你还活着吗"：给它的消息队列发 WM_NULL，带上 SMTO_ABORTIFHUNG，
    超时没回应就说明 UI 线程卡住了。这是系统判定"未响应"的同一套信号。"""
    if os.name != "nt" or not hwnd:
        return False
    try:
        res = ctypes.c_size_t(0)
        ok = ctypes.windll.user32.SendMessageTimeoutW(
            ctypes.c_void_p(int(hwnd)), 0x0000, 0, 0, 0x0002, int(timeout),
            ctypes.byref(res))
        return not bool(ok)
    except Exception:
        return False


def focus_window(hwnd):
    if os.name != "nt" or not hwnd:
        return False
    user32 = ctypes.windll.user32
    try:
        if not user32.IsWindow(hwnd):
            return False
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)          # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        user32.BringWindowToTop(hwnd)
        return True
    except Exception:
        return False


def focus_live():
    """前置正在运行的窗口：先用锁里的句柄，取不到再按标题找"""
    try:
        hwnd = json.loads(LOCK.read_text(encoding="utf-8")).get("hwnd")
    except (OSError, ValueError):
        hwnd = None
    if focus_window(hwnd):
        return True
    return focus_app_window()


# DWM 属性号（Win11 22000+ 才认，认不出就静默跳过）
_DWMWA_USE_IMMERSIVE_DARK_MODE = 20
_DWMWA_BORDER_COLOR = 34
_DWMWA_CAPTION_COLOR = 35
_DWMWA_TEXT_COLOR = 36

# COLORREF = 0x00BBGGRR，取色对齐界面自己的配色：
# 深色 #0C0C0D（=--bg，与顶栏同色，接缝不可见）/ 浅色 #FBFBFA（=--bg 浅色）
CAPTION_COLORS = {
    "dark":  {"caption": 0x000D0C0C, "border": 0x002E2A2A, "text": 0x00F0EDED},
    "light": {"caption": 0x00FAFBFB, "border": 0x00D6DCDC, "text": 0x001A1616},
}


def set_caption_theme(mode="dark"):
    """把系统标题栏染成与界面同一个颜色，浅色/深色跟着一起变。

    pywebview 的窗口是原生 WinForms 窗，标题栏归 DWM 画，默认跟系统主题
    （本机是浅色），于是出现了「上面白、下面黑」。这里用 DWM 的三个属性
    直接改标题栏底色、边框和文字色，深色下同时打开沉浸式深色让
    最小化/最大化/关闭三个按钮也变亮，不需要自绘标题栏。"""
    global WIN_HWND
    if os.name != "nt":
        return False
    hwnd = WIN_HWND
    if not hwnd:
        return False        # 窗口还在初始化，页面能发请求时必然已经填上了
    try:
        dwm = ctypes.windll.dwmapi
        user32 = ctypes.windll.user32
    except Exception:
        return False
    if not user32.IsWindow(ctypes.c_void_p(int(hwnd))):
        win_hwnd_reset()
        return False

    dark = (mode != "light")
    col = CAPTION_COLORS["dark" if dark else "light"]
    save_ui_theme("dark" if dark else "light")

    def _attr(attr, value):
        buf = ctypes.c_uint(value & 0xFFFFFFFF)
        return dwm.DwmSetWindowAttribute(
            ctypes.c_void_p(int(hwnd)), attr,
            ctypes.byref(buf), ctypes.sizeof(buf))

    ok = _attr(_DWMWA_USE_IMMERSIVE_DARK_MODE, 1 if dark else 0) == 0
    ok = (_attr(_DWMWA_CAPTION_COLOR, col["caption"]) == 0) or ok
    _attr(_DWMWA_BORDER_COLOR, col["border"])
    _attr(_DWMWA_TEXT_COLOR, col["text"])

    # 改完属性 DWM 不一定立刻重画非客户区，踢一下让它立即生效
    try:
        user32.SetWindowPos(ctypes.c_void_p(int(hwnd)), None, 0, 0, 0, 0,
                            0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)
    except Exception:
        pass
    return ok


def win_hwnd_reset():
    global WIN_HWND
    WIN_HWND = 0


def _window_icon(hwnd):
    """给窗口和任务栏换上自己的图标（WebView2 外壳默认是通用图标）。

    早先是在 shown 回调里用 pythonnet 设 win.native.Icon —— 那等于在
    .NET 事件回调里再回头调 CLR，实测会概率性死锁：窗口出来了但内容
    永远是白的，UI 线程挂起，连 HTTP 都不应（Python 的 GIL 被卡死）。
    改成纯 Win32：LoadImageW 取图标句柄，PostMessage 给窗口，不碰 CLR。"""
    if os.name != "nt" or not hwnd:
        return
    user32 = ctypes.windll.user32
    for cand in (ROOT / "bnimage.ico", RES / "bnimage.ico"):
        if not cand.exists():
            continue
        try:
            hicon = user32.LoadImageW(None, str(cand), 1, 0, 0, 0x0010)  # IMAGE_ICON|LR_LOADFROMFILE
            if hicon:
                user32.PostMessageW(ctypes.c_void_p(int(hwnd)), 0x0080, 0, hicon)  # WM_SETICON ICON_SMALL
                user32.PostMessageW(ctypes.c_void_p(int(hwnd)), 0x0080, 1, hicon)  # ICON_BIG
        except Exception:
            pass
        return


def open_native_window(url):
    """在本进程里开一个真窗口，阻塞到窗口被关闭。
    返回 False 表示这个环境起不来（调用方退回 Edge 应用窗口）。"""
    global AUTO_EXIT
    if not HAS_WEBVIEW:
        return False

    theme = read_ui_theme() or "dark"
    win = webview.create_window(
        f"{APP_NAME} · 统一查看器", url,
        width=1520, height=960, min_size=(880, 560),
        # 底色跟着上次的主题走，深色下开窗不会先白一下
        background_color=("#0C0C0D" if theme == "dark" else "#F6F6F4"),
    )

    shown = [False]

    def _after_shown(*_args):
        # 这个回调跑在 .NET 的事件派发线程上，手里握着 GIL。
        # 只做最轻的事：标记 + 交给后台线程去取句柄，绝不在回调里调 CLR。
        shown[0] = True
        threading.Thread(target=_post_show, args=(win,), daemon=True,
                         name="post-show").start()

    def _post_show(window):
        global WIN_HWND
        for _ in range(80):
            try:
                h = int(window.native.Handle.ToInt64())
            except Exception:
                h = 0
            if h:
                WIN_HWND = h
                _account_hwnd(h)
                _window_icon(h)
                # 页面还没加载完，先用上次的主题把标题栏染上，避免白杠一闪
                set_caption_theme(read_ui_theme() or "dark")
                return
            time.sleep(0.05)

    try:
        win.events.shown += _after_shown
    except Exception:
        threading.Thread(target=_post_show, args=(win,), daemon=True).start()

    def _on_closing(*_args):
        # 窗口一关就立刻注销实例：WebView2 的收尾要 2 秒左右，
        # 这期间如果用户马上双击下一张图，不该再往这个正在退出的实例上投递。
        clear_lock()

    try:
        win.events.closing += _on_closing
    except Exception:
        pass

    if DEBUG:
        def _beat():
            while True:
                time.sleep(1.0)
                _dbg("heartbeat")
        threading.Thread(target=_beat, daemon=True, name="beat").start()

    def _watchdog():
        # 窗口迟迟不出现时留一条证据，免得下次只能靠猜
        for _ in range(40):
            time.sleep(0.5)
            if shown[0]:
                return
        _note("窗口 20 秒没有出现：窗口初始化卡死")
        _dbg("window not shown in 20s")

    threading.Thread(target=_watchdog, daemon=True, name="watchdog").start()

    AUTO_EXIT = False      # 关窗事件由我们自己收到，不再靠 /api/bye 猜
    if DEV:
        _note("BNIMAGE_DEV=1：已打开开发者工具（窗口内右键可检查）")
    webview.start(gui="edgechromium", debug=DEV, private_mode=False,
                  storage_path=str(_profile_dir()))
    return True


def reopen_window(url, timeout=3.0):
    """换一个新窗口，但不要"先关后开"。
    同 profile 的 Edge 还在跑时，先关窗会让它进入退出流程，
    紧接着的启动会被这个正在退出的进程吞掉（最后连窗口都没有）。
    正确顺序是：让浏览器自己在同一个进程里开新窗，起来了再关掉旧窗。"""
    before = set(find_app_windows())
    launch(url)
    fresh = []
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(0.12)
        fresh = [h for h in find_app_windows() if h not in before]
        if fresh:
            break
    if not fresh:
        return False
    user32 = ctypes.windll.user32
    for h in before:
        try:
            user32.PostMessageW(h, 0x0010, 0, 0)
        except Exception:
            pass
    return True


def watch_window(url=None):
    """看守窗口：关掉约 3 秒后收尾退出。
    不依赖浏览器的 beforeunload 通知（窗口被关时它未必送达），
    直接枚举窗口判断，开销是毫秒级。"""
    if os.name != "nt" or not AUTO_EXIT:
        return
    time.sleep(1.0)
    seen = False
    misses = 0
    retried = False
    while True:
        time.sleep(1.0)
        if time.time() < WINDOW_GRACE:       # 启动器正在换窗口，先别数缺勤
            seen = True
            misses = 0
            continue
        try:
            alive = bool(find_app_windows())
        except Exception:
            alive = True
        if alive:
            seen = True
            misses = 0
            continue
        misses += 1
        if seen:
            if misses >= 3:          # 连续 3 秒没有窗口 → 界面已关闭
                say("窗口已关闭，服务退出。")
                clear_lock()
                os._exit(0)
            continue
        # 还没见过窗口：浏览器冷启动留点余量，仍没有就补开一次
        if misses == 10 and url and not retried:
            retried = True
            say("没有等到窗口，重试打开。")
            launch(url)
        elif misses >= 25:
            say("始终没有窗口，服务退出。")
            clear_lock()
            os._exit(0)


def handoff(live, target, waits=(0.15, 0.18, 0.22)):
    """把目标交给已运行的窗口；没人接住就返回 False"""
    q = "?path=" + urllib.parse.quote(target)
    try:
        with _direct_open(f"http://127.0.0.1:{live}/api/route{q}", timeout=3.0) as r:
            r.read()
    except Exception:
        return False
    # 页面在长轮询，正常几十毫秒就取走；只读探几次，没人接就是通道断了
    for i, wait in enumerate(waits):
        time.sleep(wait)
        try:
            with _direct_open(f"http://127.0.0.1:{live}/api/peek", timeout=3.0) as r:
                left = json.loads(r.read()).get("path")
        except Exception:
            return False
        if not left:
            focus_live()
            return True
        if i == 1:
            # 探到一半还没人接：把窗口提到前台，逼页面自己来取一次
            # （页面在 focus 时会主动 drain，能救回"长轮询挂死"的现场）
            focus_live()
            time.sleep(0.15)
            try:
                with _direct_open(f"http://127.0.0.1:{live}/api/peek", timeout=3.0) as r:
                    if not json.loads(r.read()).get("path"):
                        return True
            except Exception:
                return False
    return False


def keep_window(port, sec=10.0):
    """给服务申请窗口保护期；返回 False 说明这个实例已经不可用了"""
    try:
        with _direct_open(f"http://127.0.0.1:{port}/api/keep?sec={sec}", timeout=1.5) as r:
            r.read()
        return True
    except Exception:
        return False


def clear_pending(port):
    """重开窗口前把没被接住的目标清掉，避免新页面重复打开一次"""
    try:
        with _direct_open(f"http://127.0.0.1:{port}/api/clear", timeout=1.5) as r:
            r.read()
    except Exception:
        pass


def _note(msg):
    """把启动失败的线索留在 .cache/launch.log，方便排查"""
    try:
        with (CACHE / "launch.log").open("a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%m-%d %H:%M:%S')}  {msg}\n")
    except OSError:
        pass


def launch(url):
    if os.name != "nt":
        webbrowser.open(url)
        return
    edges = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for e in edges:
        if os.path.exists(e):
            try:
                profile = CACHE / "profile"
                # 冻结成窗口程序后没有控制台，标准句柄是无效的；
                # 子进程若继承它们会直接起不来，所以显式给空设备。
                subprocess.Popen([
                    e, f"--app={url}", "--window-size=1520,960",
                    f"--user-data-dir={profile}", "--no-first-run",
                    "--no-default-browser-check",
                ], stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
                return
            except Exception as exc:  # noqa: BLE001
                _note(f"用 {e} 打开失败：{exc!r}")
                break
    _note("回落到系统默认浏览器")
    webbrowser.open(url)


def _prune_tx(limit: int = 4 * 1024 ** 3):
    """转码缓存别无限长：超上限按最久没看过的先删，顺手清掉中断留下的 .part。"""
    try:
        if not TX_DIR.exists():
            return
        now = time.time()
        files, total = [], 0
        for f in TX_DIR.iterdir():
            try:
                st = f.stat()
            except OSError:
                continue
            if f.name.endswith(".part.mp4"):
                if now - st.st_mtime > 24 * 3600:
                    try:
                        f.unlink()
                    except OSError:
                        pass
                continue
            if f.suffix != ".mp4":
                continue
            files.append((st.st_mtime, st.st_size, f))
            total += st.st_size
        if total <= limit:
            return
        files.sort()
        for _mt, size, f in files:
            if total <= limit:
                break
            try:
                f.unlink()
                total -= size
            except OSError:
                pass
    except Exception:  # noqa: BLE001
        pass


def main():
    global AUTO_EXIT
    no_browser = "--no-browser" in sys.argv
    if "--stay" in sys.argv:
        AUTO_EXIT = False

    if "--register" in sys.argv or "--register-quiet" in sys.argv:
        ok, msg = register_files()
        say(msg)
        if ok and "--register-quiet" not in sys.argv:
            try:
                os.startfile("ms-settings:defaultapps")  # noqa: S606
            except Exception:
                pass
        return
    if "--unregister" in sys.argv:
        ok, msg = unregister_files()
        say(msg)
        return

    target = None
    for arg in sys.argv[1:]:
        if arg.startswith("--"):
            continue
        if os.path.exists(arg):
            target = os.path.abspath(arg)
            break
    suffix = ""
    if target:
        key = "path" if os.path.isdir(target) else "file"
        suffix = f"?{key}=" + urllib.parse.quote(target)

    global PREV_PID, PREV_HWND
    # 先记下上一个实例的身份，再做任何会覆盖锁文件的事
    prev = read_lock_info()
    PREV_PID = int(prev.get("pid") or 0) if prev else 0
    PREV_HWND = int(prev.get("hwnd") or 0) if prev else 0
    live = running_port()
    stale = False

    if live and target:
        if handoff(live, target):
            return
        # 没人接单有两种可能：①页面还开着但它的长轮询通道已经挂死（最常见，
        # 就是"关掉一张图再双击另一张毫无反应，刷新才恢复"）；②窗口其实
        # 已经没了，进程还没走完收尾。
        # 两种情况都不能静默聚焦旧窗口了事——用户看到的就是"双击没反应"。
        # 先问一句旧窗口是否还活着：Win32 探针明确说"挂起"，就不用再等 6 秒；
        # 探针没结论才退回到给页面一次喘息机会。
        if window_hung(PREV_HWND):
            _note("旧窗口探针判定挂起，直接接管")
            live = None
            stale = True
        elif not keep_window(live, 6.0):
            _note("旧实例无响应，改为新起服务")
            live = None                     # 实例已经废了，下面重新起服务
            stale = True
        else:
            time.sleep(0.40)
            if handoff(live, target, waits=(0.20, 0.20, 0.25, 0.30)):
                return
            if no_browser:
                say(f"http://127.0.0.1:{live}/{suffix}")
                return
            _note("页面没有回执，换一个新窗口")
            clear_pending(live)             # 新窗口靠 URL 直接打开，别再重复投递
            target_url = f"http://127.0.0.1:{live}/{suffix}"
            if reopen_window(target_url):
                keep_window(live, 1.5)      # 新窗口起来了，保护期可以收掉
            else:
                _note("新窗口没能起来，关旧窗后冷启动")
                close_app_windows()
                time.sleep(0.6)
                launch(target_url)
            return

    if live:
        if not no_browser and focus_live():
            return
        url = f"http://127.0.0.1:{live}/{suffix}"
        if no_browser:
            say(url)
        else:
            launch(url)
        return

    port = free_port()
    if not port:
        error_box("找不到可用端口，请关闭其他程序后重试。")
        return
    url = f"http://127.0.0.1:{port}/{suffix}"
    try:
        srv = LocalServer(("127.0.0.1", port), Handler)
    except OSError:
        error_box("端口被占用，请稍后重试。")
        return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    write_lock(port)                    # 登记实例，下次双击可毫秒级复用
    threading.Thread(target=sweep_old_profiles, daemon=True).start()
    threading.Thread(target=_prune_tx, daemon=True).start()

    say("")
    say(f"  {APP_NAME} · 统一查看器  v{APP_VERSION}")
    say(f"  地址： {url}")
    say(f"  图像解码： {'Pillow 已就绪' if HAS_PIL else '未安装 Pillow（部分格式降级）'}")
    if not no_browser:
        _init_gui()
        say("  窗口： " + (f"原生窗口（WebView2 {WEBVIEW2_PV}）" if HAS_WEBVIEW
                         else "Edge 应用窗口（未检测到 WebView2 运行时）"))
    say("  关闭窗口即退出；也可按 Ctrl+C")
    say("")

    if not no_browser:
        if stale:                       # 旧窗口停在一个已经死掉的服务上，先清掉
            reap_stale_instance(PREV_PID or None)
            close_app_windows()
            time.sleep(0.15)
        if HAS_WEBVIEW:
            try:
                open_native_window(url)     # 阻塞，直到窗口被关闭
                say("  窗口已关闭，服务退出。")
                clear_lock()
                time.sleep(0.2)
                os._exit(0)
            except Exception as exc:        # noqa: BLE001
                _note(f"原生窗口起不来，退回 Edge 应用窗口：{exc!r}")
        # 退路：Edge 的 --app 窗口（没有 WebView2 时常走这里）
        launch(url)                     # 先拉窗口，日志随后再打，省几十毫秒
        threading.Thread(target=watch_window, args=(url,), daemon=True).start()

    try:
        while True:
            time.sleep(0.6)
    except KeyboardInterrupt:
        say("\n  已退出。")
        clear_lock()
        srv.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        error_box(f"启动失败：{exc}")

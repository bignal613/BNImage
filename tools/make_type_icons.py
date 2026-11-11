"""生成按格式区分的文件类型图标（.ico 多尺寸）。

一类格式一个图标：圆角方块 + 白色格式字母，颜色按大类区分
（图片=品牌蓝，视频=紫，PDF=红，网页=橙）。资源管理器读的是
ProgID 的 DefaultIcon，所以这些 ico 由 register_files() 逐个挂上去。

用法: python tools/make_type_icons.py [输出目录]
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
SS = 4                      # 超采样倍数
RADIUS = 0.19               # 圆角半径 / 边长
TEXT_W = 0.78               # 文字最大占宽
FONT_VF = Path("C:/Windows/Fonts/NotoSansSC-VF.ttf")
FONT_STATIC = Path("_icon_test/_src/NotoSansSC-Bold.ttf")

# 大类: (底色, {标识: [扩展名...]})
FAMILIES = [
    ("#002FA7", {                       # 图片：品牌蓝
        "JPG":  ["jpg", "jpeg", "jpe", "jfif", "pjpeg"],
        "PNG":  ["png", "apng"],
        "GIF":  ["gif"],
        "WEBP": ["webp"],
        "AVIF": ["avif"],
        "BMP":  ["bmp", "dib"],
        "ICO":  ["ico", "cur"],
        "SVG":  ["svg"],
        "TIFF": ["tif", "tiff"],
        "HEIC": ["heic", "heif", "hif"],
        "JXL":  ["jxl"],
    }),
    ("#6C3BB5", {                       # 视频：紫
        "MP4":  ["mp4", "m4v"],
        "MOV":  ["mov"],
        "WEBM": ["webm"],
        "OGV":  ["ogv", "ogg"],
        "TS":   ["ts", "m2ts", "mts"],
        "MKV":  ["mkv"],
        "AVI":  ["avi"],
        "WMV":  ["wmv"],
        "FLV":  ["flv", "f4v"],
        "MPG":  ["mpg", "mpeg"],
        "VOB":  ["vob"],
        "3GP":  ["3gp", "3g2"],
        "RMVB": ["rmvb"],
    }),
    ("#C62828", {"PDF": ["pdf"]}),       # 文档：红
    ("#E8710A", {"HTML": ["html", "htm", "xhtml"]}),  # 网页：橙
]

def load_font(px):
    src = FONT_STATIC if FONT_STATIC.exists() else FONT_VF
    return ImageFont.truetype(str(src), px)


def draw_badge(label, color, size):
    """画一枚 size×size 的方块徽标，返回 RGBA 图。"""
    s = size * SS
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = int(round(s * RADIUS))
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=color)

    # 字号：先按占宽推，再按高度封顶
    px = int(s * 0.40)
    while px > 4:
        f = load_font(px)
        l, t, rr, b = d.textbbox((0, 0), label, font=f)
        w, h = rr - l, b - t
        if w <= s * TEXT_W and h <= s * 0.46:
            break
        px -= max(1, int(s * 0.01))
    f = load_font(px)
    l, t, rr, b = d.textbbox((0, 0), label, font=f)
    w, h = rr - l, b - t
    d.text((s / 2 - w / 2 - l, s / 2 - h / 2 - t), label, font=f, fill="#FFFFFF")

    return im.resize((size, size), Image.LANCZOS)


GROUPS = {"#002FA7": "Image", "#6C3BB5": "Video", "#C62828": "Pdf", "#E8710A": "Html"}


def build(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    made = []
    table = []
    for color, group in FAMILIES:
        for label in group:
            frames = [draw_badge(label, color, sz) for sz in SIZES]
            name = f"bn-{label.lower()}.ico"
            frames[-1].save(out / name, format="ICO",
                            sizes=[(sz, sz) for sz in SIZES],
                            append_images=frames[:-1])
            made.append((label, color, name, group[label]))
            table.append({"label": label, "group": GROUPS[color],
                          "color": color, "ico": name, "exts": group[label]})
    # 程序注册时读这张表，保证「生成图标」和「挂进系统」用的是同一份定义
    (out / "types.json").write_text(
        json.dumps({"version": 1, "types": table}, ensure_ascii=False, indent=1),
        encoding="utf-8")
    frames = [draw_badge("FILE", "#5A6470", sz) for sz in SIZES]
    frames[-1].save(out / "bn-file.ico", format="ICO",
                    sizes=[(sz, sz) for sz in SIZES], append_images=frames[:-1])
    return made


def sheet(out_dir, dst):
    """拼一张对照图，方便肉眼过一遍。"""
    out = Path(out_dir)
    order = []
    for _color, group in FAMILIES:
        order += [f"bn-{lb.lower()}.ico" for lb in group]
    order.append("bn-file.ico")
    items = [out / n for n in order if (out / n).exists()]
    cols, cell = 7, 132
    rows = (len(items) + cols - 1) // cols
    c = Image.new("RGB", (cols * cell, rows * (cell + 26) + 10), (246, 247, 249))
    d = ImageDraw.Draw(c)
    lbl = load_font(15)
    for i, p in enumerate(items):
        ico = Image.open(p)
        ico.size = (96, 96)
        im = ico.convert("RGBA").copy()
        x, y = (i % cols) * cell + 18, (i // cols) * (cell + 26) + 14
        c.paste(im, (x, y), im)
        d.text((x, y + 100), p.stem.replace("bn-", "").upper(), fill=(110, 114, 120), font=lbl)
    c.save(dst)


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else r"D:\BNImage\icons"
    rows = build(target)
    print(f"生成 {len(rows)} 个类型图标 -> {target}")
    for label, color, name, exts in rows:
        print(f"  {label:5} {color}  {name:14} {','.join(exts)}")
    sheet(target, r"D:\BNImage\_icon_test\icons-sheet.png")
    print("对照图: _icon_test/icons-sheet.png")

# -*- coding: utf-8 -*-
"""生成一个中性 demo 目录，只用于截 README 预览图（不进版本库）。"""
import math
import os
import shutil

from PIL import Image, ImageDraw, ImageFilter

D = r"D:\BNImage\_demo"
if os.path.isdir(D):
    shutil.rmtree(D)
os.makedirs(os.path.join(D, "效果图"))
os.makedirs(os.path.join(D, "施工记录"))

W, H = 1600, 1000

PALETTES = [
    ((28, 34, 52), (86, 112, 168), (196, 172, 138)),
    ((244, 238, 228), (214, 190, 160), (120, 96, 84)),
    ((22, 44, 38), (58, 110, 92), (206, 196, 156)),
    ((236, 232, 226), (168, 92, 74), (58, 52, 48)),
    ((40, 40, 46), (120, 118, 126), (222, 214, 196)),
    ((232, 226, 216), (140, 156, 168), (72, 78, 88)),
]


def gradient(p1, p2, size=(W, H)):
    img = Image.new("RGB", size, p1)
    px = img.load()
    w, h = size
    for y in range(h):
        f = y / (h - 1)
        for x in range(0, w, 4):
            g = (f * 0.85) + (x / (w - 1)) * 0.15
            c = tuple(int(p1[i] + (p2[i] - p1[i]) * g) for i in range(3))
            for k in range(4):
                if x + k < w:
                    px[x + k, y] = c
    return img


def draw_shapes(img, accent, seed):
    d = ImageDraw.Draw(img, "RGBA")
    w, h = img.size
    for i in range(3):
        cx = int(w * (0.25 + 0.22 * i + 0.03 * math.sin(seed + i)))
        cy = int(h * (0.62 - 0.06 * i))
        r = int(w * (0.16 - 0.02 * i))
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=accent + (110,), width=3)
    d.rectangle([int(w * 0.08), int(h * 0.12), int(w * 0.42), int(h * 0.16)],
                fill=accent + (200,))
    return img


for i in range(20):
    p1, p2, ac = PALETTES[i % len(PALETTES)]
    im = draw_shapes(gradient(p1, p2), ac, i * 1.7)
    im = im.filter(ImageFilter.GaussianBlur(0.4))
    im.save(os.path.join(D, f"方案{i + 1:02d}.jpg"), quality=90)

# 从系统壁纸里取一张，凑成真实照片的感觉
wp = r"C:\Windows\Web\4K\Wallpaper\Windows\img0_1920x1200.jpg"
if os.path.exists(wp):
    im = Image.open(wp).convert("RGB")
    im.thumbnail((1600, 1600))
    im.save(os.path.join(D, "参考图.jpg"), quality=92)
    im.save(os.path.join(D, "效果图", "参考图.jpg"), quality=92)

# 视频：用 ffmpeg 生成一段中性渐变动画，避免把真实项目素材带进来
FF = shutil.which("ffmpeg") or "ffmpeg"
try:
    import subprocess

    for target in (os.path.join(D, "现场巡查.mp4"),
                   os.path.join(D, "施工记录", "现场巡查.mp4")):
        subprocess.run(
            [FF, "-y", "-hide_banner", "-loglevel", "error",
             "-f", "lavfi",
             "-i", "gradients=size=1280x720:duration=4:speed=0.12"
                   ":c0=0x2F4F43:c1=0xC4AC8A:c2=0x1B2422",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", target],
            check=False)
except (OSError, FileNotFoundError):
    print("没找到 ffmpeg，跳过视频生成")

# PDF
try:
    from reportlab.pdfgen import canvas as pdfcanvas
    from reportlab.lib.pagesizes import A4

    def make_pdf(p, title):
        c = pdfcanvas.Canvas(p, pagesize=A4)
        c.setFont("Helvetica-Bold", 20)
        c.drawString(70, 760, title)
        c.setFont("Helvetica", 11)
        for i in range(12):
            c.drawString(70, 710 - i * 26, f"{i + 1:02d}.  ______________________________")
        c.showPage()
        c.save()

    make_pdf(os.path.join(D, "施工记录", "验收单.pdf"), "Site Acceptance Record")
    make_pdf(os.path.join(D, "验收单.pdf"), "Site Acceptance Record")
except Exception as e:
    print("pdf skip", e)

for p in (os.path.join(D, "施工记录", "说明.html"), os.path.join(D, "说明.html")):
    with open(p, "w", encoding="utf-8") as f:
        f.write("<h1>现场说明</h1><p>用于预览演示。</p>")

for root, _, files in os.walk(D):
    print(root, "->", len(files), "个文件")

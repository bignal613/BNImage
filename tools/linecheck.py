# -*- coding: utf-8 -*-
"""
线检 —— 判断照片里那条细白线，是图片文件自带的，还是看图软件缩放渲染出来的。

原理：直接读 JPEG 的原始像素，完全不经过任何显示环节。
      如果原图像素里就有一行明显偏亮/偏暗，那就是文件自带的；
      如果原图像素干净，那屏幕上看到的线就是观看软件缩小显示时算出来的假线。

用法：
    把图片拖到 线检.bat 上
    或  python 线检.py "D:\\照片\\a.jpg" "D:\\照片\\b.jpg"
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

BAND = 3          # 上下各取 3 行做基准
VISIBLE = 3.0     # 一条肉眼能看见的细线，原图里至少偏离 3/255
UNIFORM = 0.85    # 真线整行同向偏移，一致性要高于这个值（纹理边正负混杂）

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\msyhl.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def get_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def load_image(path):
    im = Image.open(path)
    im = ImageOps.exif_transpose(im)
    if im.mode != "RGB":
        im = im.convert("RGB")
    return im


def scan_rows(im):
    """返回 (有符号脊线响应, 异常像素覆盖比例, 同向一致性)"""
    a = np.asarray(im, dtype=np.float32)
    h = a.shape[0]
    if h <= BAND * 2 + 2:
        return None, None, None

    up = np.roll(a, -BAND, axis=0)
    dn = np.roll(a, BAND, axis=0)
    r = a - 0.5 * (up + dn)          # 每像素相对上下邻行的偏离
    r = r.mean(axis=2)               # 三通道平均

    rows = r.mean(axis=1)            # 每行的平均偏离（有符号）
    cover = (np.abs(r) > 1.0).mean(axis=1)
    pos = (r > 1.0).mean(axis=1)
    neg = (r < -1.0).mean(axis=1)
    consist = np.maximum(pos, neg)   # 同向占比：真线接近 1，纹理边约 0.5

    rows[:BAND] = 0.0
    rows[-BAND:] = 0.0
    cover[:BAND] = 0.0
    cover[-BAND:] = 0.0
    return rows, cover, consist


def analyse(path):
    im = load_image(path)
    w, h = im.size
    rows, cover, consist = scan_rows(im)

    result = {
        "path": path,
        "name": os.path.basename(path),
        "w": w,
        "h": h,
        "px": w * h,
        "has_line": False,
        "line_y": None,
        "line_pct": None,
        "line_str": 0.0,
        "line_cover": 0.0,
        "suspect": [],
        "image": im,
    }
    if rows is None:
        return result

    # 参考：全图最强的几条横向边（多半是墙线、地脚线这类真实结构，不是要找的线）
    order = np.argsort(-np.abs(rows))[:10]
    result["suspect"] = [(int(y), float(rows[y]), float(consist[y])) for y in order]

    # 判定对象 = 你实际看到线的那个位置（高度 71.14%）
    probe = int(h * 0.7114)
    if 0 <= probe < h:
        result["probe_y"] = probe
        result["probe_str"] = float(rows[probe])
        result["probe_cover"] = float(cover[probe])
        result["probe_consist"] = float(consist[probe])

        # 真线的两个条件：偏移够大（肉眼可见）+ 整行同向（不是纹理噪声）
        if abs(result["probe_str"]) >= VISIBLE and result["probe_consist"] >= UNIFORM:
            result.update({
                "has_line": True,
                "line_y": probe,
                "line_pct": probe / h * 100.0,
                "line_str": result["probe_str"],
                "line_cover": result["probe_cover"],
            })
        else:
            result["line_y"] = probe
            result["line_pct"] = probe / h * 100.0

    # 万一真实线在别的行，也提示一下
    for y, val, cs in result["suspect"]:
        if abs(val) >= VISIBLE * 2 and cs >= UNIFORM and not result["has_line"]:
            result["other_line"] = (y, y / h * 100.0, val)
            break

    return result


def make_evidence(res, out_path):
    """生成一张 1:1 原始像素的证据图，箭头指向你屏幕上看到线的位置"""
    im = res["image"]
    w, h = res["w"], res["h"]

    crop_w = min(w, 1400)
    crop_h = min(h, 620)
    cy = res["line_y"] if res["line_y"] is not None else int(h * 0.7114)
    top = max(0, min(h - crop_h, cy - crop_h // 2))
    left = max(0, (w - crop_w) // 2)

    crop = im.crop((left, top, left + crop_w, top + crop_h))
    cw, ch = crop.size

    header = 104
    canvas = Image.new("RGB", (cw, ch + header), (18, 20, 24))
    canvas.paste(crop, (0, header))
    d = ImageDraw.Draw(canvas)

    f_big = get_font(26)
    f_mid = get_font(20)

    if res["has_line"]:
        tag = "原图自带细线"
        tag_color = (232, 96, 96)
        note = "原始像素第 %d 行（高度 %.2f%%）确实存在异常，强度 %+.2f/255" % (
            res["line_y"], res["line_pct"], res["line_str"])
    else:
        tag = "原图干净"
        tag_color = (86, 196, 138)
        note = "原始像素在该位置没有异常，线是看图软件缩放渲染产生的"

    d.rectangle([0, 0, cw, header], fill=(18, 20, 24))
    d.text((22, 16), tag, font=f_big, fill=tag_color)
    d.text((22, 56), "1:1 原始像素 | %d x %d | %s" % (w, h, res["name"][:46]),
           font=f_mid, fill=(170, 176, 186))
    d.text((cw - 640 if cw > 660 else 22, 56), note, font=get_font(16),
           fill=(200, 205, 214))

    # 箭头指向该行
    ry = header + (cy - top)
    if header < ry < header + ch:
        col = (232, 96, 96) if res["has_line"] else (86, 196, 138)
        for base in (18, cw - 18):
            direction = 1 if base < cw / 2 else -1
            d.line([(base, ry), (base + 54 * direction, ry)], fill=col, width=3)
            d.line([(base, ry), (base + 16 * direction, ry - 10)], fill=col, width=3)
            d.line([(base, ry), (base + 16 * direction, ry + 10)], fill=col, width=3)

    # 右上角全图缩略窗：红框标出当前裁的是哪一块
    tw = 236
    th = max(1, int(tw * h / w))
    if th <= ch * 0.8:
        thumb = im.resize((tw, th), Image.LANCZOS)
        pad = 12
        tx, ty = cw - tw - pad, header + pad
        d.rectangle([tx - 3, ty - 3, tx + tw + 3, ty + th + 3], fill=(18, 20, 24))
        canvas.paste(thumb, (tx, ty))
        k = tw / w
        d.rectangle([tx + int(left * k), ty + int(top * k),
                     tx + int((left + crop_w) * k), ty + int((top + crop_h) * k)],
                    outline=(255, 210, 90), width=2)
        d.line([(tx, ty + int(cy * k)), (tx + tw, ty + int(cy * k))],
               fill=(86, 196, 138), width=1)
        label = "全图 · 黄框为下方裁切区域"
        fnt = get_font(14)
        bx = d.textbbox((0, 0), label, font=fnt)
        d.rectangle([tx, ty + th + 4, tx + (bx[2] - bx[0]) + 10, ty + th + (bx[3] - bx[1]) + 12],
                    fill=(18, 20, 24))
        d.text((tx + 5, ty + th + 6), label, font=fnt, fill=(200, 205, 214))

    canvas.save(out_path, "PNG")


def report(res):
    print("=" * 66)
    print("文件：%s" % res["name"])
    print("尺寸：%d x %d  (%.1f 万像素)" % (res["w"], res["h"], res["px"] / 10000.0))
    print("")

    if res.get("probe_y") is not None:
        print("你看到线的位置：第 %d 行（高度 %.2f%%）" % (res["probe_y"], res["probe_y"] / res["h"] * 100))
        print("    原始像素偏离    %+.2f / 255" % res["probe_str"])
        print("    同向一致性      %.0f%%   （真线接近 100%%，画面纹路约 50%%）"
              % (res["probe_consist"] * 100))
        if res["suspect"]:
            y, val, cs = res["suspect"][0]
            print("    参考：全图最强横向边 第 %d 行 偏离 %+.2f/255（那是墙线、地脚线之类的真实结构）"
                  % (y, val))
    print("")

    if res["has_line"]:
        print("判定：原图本身就有这条线")
        print("     第 %d 行（高度 %.2f%%）整行同向偏移 %+.2f/255，这是文件里真实存在的像素。"
              % (res["line_y"], res["line_pct"], res["line_str"]))
        print("     换任何软件、放大到 100%% 看，它都还在。要修只能重拍或用修图抹掉。")
    else:
        print("判定：原图干净 —— 你看到的线是看图软件缩放渲染时算出来的")
        print("     该处原始像素和上下邻行几乎一样，差别只有 %.2f/255，肉眼分辨不了。"
              % abs(res.get("probe_str", 0.0)))
        print("     自查：把图放大到 100%，线会消失；用 Windows「照片」打开也不会有。")

    if res.get("other_line"):
        y, pct, val = res["other_line"]
        print("     注意：原图第 %d 行（高度 %.2f%%）有一条更明显的横向边（%+.2f/255），"
              % (y, pct, val))
        print("           如果那条位置也能看到线，那才是文件本身的。")

    if res.get("evidence"):
        print("")
        print("证据图：%s" % res["evidence"])
        print("        （1:1 原始像素，箭头指的就是你说的位置，自己看一眼最实在）")


def main():
    args = [a for a in sys.argv[1:] if a.strip()]
    if not args:
        print("把图片拖到这个脚本（或 线检.bat）上即可。")
        return 1

    ok, bad = 0, 0
    for path in args:
        path = path.strip().strip('"')
        if not os.path.isfile(path):
            print("跳过（找不到）：%s" % path)
            bad += 1
            continue
        try:
            res = analyse(path)
        except Exception as e:
            print("跳过（读不了）：%s  ->  %s" % (os.path.basename(path), e))
            bad += 1
            continue

        evidence = os.path.join(
            os.path.expanduser("~"), "Desktop",
            "线检_%s.png" % os.path.splitext(res["name"])[0][:40])
        try:
            make_evidence(res, evidence)
            res["evidence"] = evidence
        except Exception:
            res["evidence"] = None

        report(res)
        ok += 1

    print("=" * 66)
    print("完成：成功 %d 张，跳过 %d 张" % (ok, bad))
    return 0


if __name__ == "__main__":
    sys.exit(main())

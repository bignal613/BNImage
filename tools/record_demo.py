# -*- coding: utf-8 -*-
"""录制 README 演示 GIF 的原始素材：打开图片 -> 影调调整 -> 播放视频。"""
import os, shutil, urllib.parse, glob
from playwright.sync_api import sync_playwright

D = r"D:\BNImage\_demo"
OUT = r"C:\Users\AHKK\AppData\Local\Temp\bn_rec"
shutil.rmtree(OUT, ignore_errors=True)
os.makedirs(OUT, exist_ok=True)
URL = "http://127.0.0.1:8787/?path=" + urllib.parse.quote(D)

ED_OPEN = ("()=>{const e=document.querySelector('#editor'); if(!e) return false;"
           " const r=e.getBoundingClientRect();"
           " return !e.hidden && getComputedStyle(e).display!=='none' && r.width>0 && r.height>0;}")
VW_OPEN = ("()=>{const v=document.querySelector('#viewer'); if(!v) return false;"
           " const r=v.getBoundingClientRect();"
           " return !v.hidden && getComputedStyle(v).display!=='none' && r.width>0 && r.height>0;}")


def close_editor(pg, tries=8):
    for _ in range(tries):
        if not pg.evaluate(ED_OPEN):
            return True
        pg.evaluate("()=>document.querySelector('#edBack').click()")
        pg.wait_for_timeout(320)
    return not pg.evaluate(ED_OPEN)


def close_viewer(pg, tries=6):
    for _ in range(tries):
        if not pg.evaluate(VW_OPEN):
            return True
        pg.evaluate("()=>document.querySelector('#btnClose').click()")
        pg.wait_for_timeout(360)
    return not pg.evaluate(VW_OPEN)


with sync_playwright() as pw:
    b = pw.chromium.launch()
    ctx = b.new_context(
        viewport={"width": 1280, "height": 760},
        record_video_dir=OUT,
        record_video_size={"width": 1280, "height": 760},
    )
    pg = ctx.new_page()
    pg.add_init_script("localStorage.setItem('bnimage.theme','light')")
    # 退出编辑时会有原生 confirm（"还没有保存，确定退出吗"），默认会被取消
    pg.on("dialog", lambda d: d.accept())
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(3000)

    imgs = pg.locator(".cell:not(.tile):not(.video)")
    print("图片格:", imgs.count())

    # 1) 点开一张图：优先用照片（渐变图做 GIF 压缩容易出色带）
    idx = pg.evaluate("""()=>{
      const cs=[...document.querySelectorAll('.cell:not(.tile):not(.video)')];
      const i = cs.findIndex(c=>c.textContent.includes('参考图'));
      return i >= 0 ? i : 0;
    }""")
    print("选中索引:", idx)
    imgs.nth(idx).click()
    pg.wait_for_timeout(1800)

    # 2) 进编辑，切到影调面板
    pg.click("#zbEdit")
    pg.wait_for_timeout(1700)
    pg.evaluate("()=>document.querySelector('.ed-tool[data-tool=\"light\"]').click()")
    pg.wait_for_timeout(1000)

    # 3) 拖曝光
    sl = pg.locator('#edSide [data-look="exp"]')
    box = sl.bounding_box()
    y = box["y"] + box["height"] / 2
    x0 = box["x"] + box["width"] * 0.5
    x1 = box["x"] + box["width"] * 0.68
    pg.mouse.move(x0, y); pg.wait_for_timeout(200)
    pg.mouse.down()
    for i in range(1, 15):
        pg.mouse.move(x0 + (x1 - x0) * i / 14, y)
        pg.wait_for_timeout(55)
    pg.mouse.up()
    pg.wait_for_timeout(900)

    # 4) 拖饱和度
    sl2 = pg.locator('#edSide [data-look="sat"]')
    b2 = sl2.bounding_box()
    y2 = b2["y"] + b2["height"] / 2
    a0 = b2["x"] + b2["width"] * 0.5
    a1 = b2["x"] + b2["width"] * 0.82
    pg.mouse.move(a0, y2); pg.wait_for_timeout(160)
    pg.mouse.down()
    for i in range(1, 12):
        pg.mouse.move(a0 + (a1 - a0) * i / 11, y2)
        pg.wait_for_timeout(48)
    pg.mouse.up()
    pg.wait_for_timeout(1100)

    # 5) 退出编辑、退出大图
    print("关闭编辑器:", close_editor(pg))
    pg.wait_for_timeout(800)
    print("关闭查看器:", close_viewer(pg))
    pg.wait_for_timeout(1000)

    # 6) 播放视频
    vids = pg.locator(".cell.video")
    print("视频格:", vids.count())
    if vids.count():
        vids.first.click()
        pg.wait_for_timeout(2600)

    ctx.close()
    b.close()

v = glob.glob(os.path.join(OUT, "*.webm"))
print("webm:", v[0] if v else "none")
if v:
    print("size MB:", round(os.path.getsize(v[0]) / 1e6, 2))

# -*- coding: utf-8 -*-
"""在真实运行中的 BNImage 页面里验证箭头工具：
   打开编辑器 -> 切箭头 -> 拖三条线（单向/双向/Shift 吸附）-> 读 info -> 截图。"""
import sys, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8787/"
IMG = r"D:\BNImage\_icon_test\bn-square.png"
OUT = r"D:\BNImage\_icon_test\arrow-test.png"

with sync_playwright() as pw:
    b = pw.chromium.launch()
    pg = b.new_page(viewport={"width": 1600, "height": 1000})
    logs = []
    pg.on("console", lambda m: logs.append(m.type + ": " + m.text))
    pg.on("pageerror", lambda e: logs.append("PAGEERROR: " + str(e)))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_timeout(2500)

    pg.evaluate("""(p) => {
      window.BNImageEditor.open({
        kind: 'image', name: 'bn-square.png', path: p,
        ext: 'png', native: true, rev: 1
      });
    }""", IMG)

    pg.wait_for_function("() => window.BNImageEditor.info && window.BNImageEditor.info()", timeout=15000)
    pg.wait_for_timeout(1200)

    # 切到箭头工具
    pg.click('.ed-tool[data-tool="arrow"]')
    pg.wait_for_timeout(300)
    print("info after tool:", pg.evaluate("() => window.BNImageEditor.info()"))

    box = pg.locator("#edCanvas").bounding_box()
    print("canvas box:", box)

    def drag(x0, y0, x1, y1, shift=False):
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(cx + x0, cy + y0)
        pg.mouse.down()
        if shift:
            pg.keyboard.down("Shift")
        for i in range(1, 13):
            pg.mouse.move(cx + x0 + (x1 - x0) * i / 12, cy + y0 + (y1 - y0) * i / 12)
            pg.wait_for_timeout(12)
        if shift:
            pg.keyboard.up("Shift")
        pg.mouse.up()
        pg.wait_for_timeout(200)

    # 1 单向
    drag(-220, -150, -40, -20)
    # 2 双向
    pg.click('#edArrowStyle button[data-ar="1"]')
    pg.wait_for_timeout(120)
    drag(40, -150, 220, -10)
    # 3 shift 吸附（画一个歪的输入，应被拉成水平）
    pg.click('#edArrowStyle button[data-ar="0"]')
    pg.wait_for_timeout(120)
    drag(-200, 120, 210, 140, shift=True)

    info = pg.evaluate("() => window.BNImageEditor.info()")
    print("info:", info)
    arrows = pg.evaluate("() => window.BNImageEditor.info().arrows")
    print("arrows =", arrows)

    pg.wait_for_timeout(300)
    pg.screenshot(path=OUT)
    print("screenshot ->", OUT)
    if logs:
        print("--- console ---")
        for l in logs[-12:]:
            print(" ", l)
    b.close()

print("RESULT arrows=%s" % arrows)

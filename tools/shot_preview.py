# -*- coding: utf-8 -*-
"""截 README 用的界面预览图。"""
import os
import urllib.parse

from playwright.sync_api import sync_playwright

D = r"D:\BNImage\_demo"
OUT = r"D:\BNImage\docs"
os.makedirs(OUT, exist_ok=True)
URL = "http://127.0.0.1:8787/?path=" + urllib.parse.quote(D)

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--no-proxy-server"])
    for theme in ("light", "dark"):
        pg = b.new_page(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        pg.add_init_script(f"localStorage.setItem('bnimage.theme','{theme}')")
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2600)
        # 把鼠标移开，避免翻页按钮浮出
        pg.mouse.move(720, 450)
        pg.wait_for_timeout(600)
        n = pg.evaluate("()=>document.querySelectorAll('.cell').length")
        name = "preview.png" if theme == "light" else "preview-dark.png"
        pg.screenshot(path=os.path.join(OUT, name))
        print(theme, "cells:", n, "->", name)
        pg.close()
    b.close()

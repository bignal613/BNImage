# -*- coding: utf-8 -*-
"""把 _release 里的分发目录打成 zip。顶层保留文件夹名，解压即得到一个目录。"""
import os
import sys
import time
import zipfile

SRC = r"D:\BNImage\_release\BNImage_1.6_win64"
OUT = r"D:\BNImage\_release\BNImage_1.6_win64.zip"
TOP = "BNImage_1.6_win64"

t0 = time.time()
n = 0
total = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for root, dirs, files in os.walk(SRC):
        for f in files:
            p = os.path.join(root, f)
            arc = TOP + "\\" + os.path.relpath(p, SRC)
            try:
                z.write(p, arc)
                n += 1
                total += os.path.getsize(p)
            except (OSError, PermissionError) as e:
                print("skip", p, e)
dt = time.time() - t0
size = os.path.getsize(OUT)
print(f"files={n} raw={total/1e6:.1f}MB zip={size/1e6:.1f}MB "
      f"ratio={size/total*100:.0f}% time={dt:.1f}s")

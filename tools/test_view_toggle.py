# -*- coding: utf-8 -*-
"""网格视图切换自测：单张 ↔ 网格 来回切换，校验图片、缩放平移、滚动位置是否原样恢复。"""
import json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8787/?path=D%3A%5CBNImage%5C_icon_test"


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 760, "height": 560})
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2600)

        cells = pg.locator(".cell:not(.folder)")
        print("网格里的文件数:", cells.count())

        # 先把网格滚下去一点，验证滚动位置能否保住
        pg.evaluate("()=>{document.querySelector('#grid').scrollTop = 320}")
        pg.wait_for_timeout(300)
        grid_before = pg.evaluate("()=>document.querySelector('#grid').scrollTop")
        print("网格滚动位置:", grid_before)

        # 打开当前可视区里的第 4 张
        target = pg.evaluate("""()=>{
            const g = document.querySelector('#grid');
            const cells = [...g.querySelectorAll('.cell:not(.folder)')];
            const gr = g.getBoundingClientRect();
            const c = cells.find(c=>{const r=c.getBoundingClientRect();
                return r.top > gr.top+40 && r.bottom < gr.bottom-10;}) || cells[cells.length-1];
            c.click();
            return {name: c.querySelector('img') ? (c._item && c._item.name) : '', idx: cells.indexOf(c)};
        }""")
        pg.wait_for_timeout(1400)
        opened = pg.evaluate("""()=>({
            hidden: document.querySelector('#viewer').hidden,
            name: document.querySelector('#viewerInfo .fname').textContent,
            pct: document.querySelector('#zbPct').textContent,
            tf: document.querySelector('#viewerStage img').style.transform,
            btnTitle: document.querySelector('#btnGrid').title,
            btnOn: document.querySelector('#btnGrid').classList.contains('on')
        })""")
        print("打开后:", json.dumps(opened, ensure_ascii=False), "target", target)

        # 放大 + 平移，制造一个可辨识的「图片状态」
        pg.evaluate("()=>{document.querySelector('#zbIn').click();document.querySelector('#zbIn').click();}")
        pg.wait_for_timeout(300)
        box = pg.locator("#viewerStage img").bounding_box()
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx + 70, cy + 45, steps=8)
        pg.mouse.up()
        pg.wait_for_timeout(400)
        before = pg.evaluate("""()=>({
            name: document.querySelector('#viewerInfo .fname').textContent,
            pct: document.querySelector('#zbPct').textContent,
            tf: document.querySelector('#viewerStage img').style.transform
        })""")
        print("离开前状态:", json.dumps(before, ensure_ascii=False))

        def snapshot():
            return pg.evaluate("""()=>({
                hidden: document.querySelector('#viewer').hidden,
                name: (document.querySelector('#viewerInfo .fname')||{}).textContent || '',
                pct: (document.querySelector('#zbPct')||{}).textContent || '',
                tf: (document.querySelector('#viewerStage img')||{style:{}}).style.transform || '',
                scroll: document.querySelector('#grid').scrollTop,
                lastCell: !!document.querySelector('#grid .cell.last'),
                lastName: (document.querySelector('#grid .cell.last img') ? document.querySelector('#grid .cell.last')._item.name : ''),
                btnTitle: document.querySelector('#btnGrid').title,
                btnOn: document.querySelector('#btnGrid').classList.contains('on')
            })""")

        # 1) 进网格
        pg.click("#btnGrid")
        pg.wait_for_timeout(700)
        g = snapshot()
        print("① 点网格按钮后:", json.dumps(g, ensure_ascii=False))

        # 2) 再点一次，应回到同一张、同一缩放
        pg.click("#btnGrid")
        pg.wait_for_timeout(1400)
        v1 = snapshot()
        print("② 再点一次:", json.dumps(v1, ensure_ascii=False))

        # 3) 连续往返两次，检查稳定性
        for k in range(2):
            pg.click("#btnGrid")
            pg.wait_for_timeout(600)
            gm = snapshot()
            pg.click("#btnGrid")
            pg.wait_for_timeout(1200)
            vm = snapshot()
            print("③ 往返 %d: 网格 hidden=%s scroll=%s last=%s | 单张 hidden=%s name=%s pct=%s tf=%s"
                  % (k + 1, gm["hidden"], gm["scroll"], gm["lastCell"], vm["hidden"], vm["name"], vm["pct"], vm["tf"]))

        # 4) 键盘：Esc 退回网格，G 再回去
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(600)
        k1 = snapshot()
        pg.keyboard.press("g")
        pg.wait_for_timeout(1300)
        k2 = snapshot()
        print("④ Esc 后:", json.dumps(k1, ensure_ascii=False))
        print("⑤ G 后:", json.dumps(k2, ensure_ascii=False))

        # 5) 换文件夹后记忆应失效：进网格 → 点文件夹 → 再点网格按钮
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(500)
        pg.evaluate("()=>{const c=document.querySelector('#grid .cell.folder'); if(c) c.click();}")
        pg.wait_for_timeout(1800)
        pg.click("#btnGrid")
        pg.wait_for_timeout(1500)
        other = snapshot()
        print("⑥ 换文件夹后点网格按钮:", json.dumps(other, ensure_ascii=False))

        pg.screenshot(path=r"D:\BNImage\_icon_test\view-toggle.png")
        b.close()

        ok = (opened["hidden"] is False
              and g["hidden"] is True and g["lastCell"] is True and abs(g["scroll"] - grid_before) <= 2
              and v1["hidden"] is False
              and v1["tf"] == before["tf"] and v1["pct"] == before["pct"] and v1["name"] == before["name"])
        print("\n核心校验:", "通过" if ok else "失败")


if __name__ == "__main__":
    main()

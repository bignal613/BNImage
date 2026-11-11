# -*- coding: utf-8 -*-
"""翻页按钮隐藏式交互自测：
默认不可见、不接管指针；指针贴近图标小区域才浮出；点击仍可翻页；
远离图标（含原先左右整块区域）不触发、不挡住底下的画面。
"""
import json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8787/?path=D%3A%5CBNImage%5C_icon_test"

PROBE = """()=>{
  const z = document.querySelector('%s');
  const cs = getComputedStyle(z);
  const r = z.getBoundingClientRect();
  return {op: +cs.opacity, pe: cs.pointerEvents, near: z.classList.contains('near'),
          w: Math.round(r.width), h: Math.round(r.height),
          cx: Math.round(r.left + r.width/2), cy: Math.round(r.top + r.height/2)};
}"""


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 900, "height": 620})
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2400)

        cell = pg.locator(".cell:not(.folder)").first
        cell.click()
        pg.wait_for_timeout(1200)

        name0 = pg.inner_text("#viewerInfo .fname")
        prev = pg.evaluate(PROBE % "#navPrev")
        nxt = pg.evaluate(PROBE % "#navNext")
        print("初始 左:", json.dumps(prev, ensure_ascii=False))
        print("初始 右:", json.dumps(nxt, ensure_ascii=False))

        # 1) 默认不可见、不接管指针
        assert prev["op"] == 0 and prev["pe"] == "none", "默认应隐藏且不接管指针"
        assert prev["w"] <= 90 and prev["h"] <= 90, "热区应只是图标周围的小方块"

        # 2) 命中测试：隐藏时点位应落在图片/舞台上，而不是按钮
        hit = pg.evaluate(f"()=>{{const e=document.elementFromPoint({prev['cx']}, {prev['cy']});"
                          " return e ? (e.id || e.className || e.tagName) : 'null';}")
        print("隐藏时该点的实际元素:", hit)
        assert hit != "navPrev", "隐藏时不应抢走指针"

        # 3) 旧的整块侧栏区域（左边缘、靠上），离图标很远：不应浮出，点击也不翻页
        pg.mouse.move(40, 200)
        pg.wait_for_timeout(220)
        far = pg.evaluate(PROBE % "#navPrev")
        print("左侧上方 (40,200):", json.dumps(far, ensure_ascii=False))
        assert far["op"] == 0, "远离图标时不应显示"
        pg.mouse.click(40, 200)
        pg.wait_for_timeout(500)
        assert pg.inner_text("#viewerInfo .fname") == name0, "远离图标点击不应翻页"

        # 4) 指针贴近图标：浮出
        pg.mouse.move(prev["cx"], prev["cy"], steps=6)
        pg.wait_for_timeout(260)
        on = pg.evaluate(PROBE % "#navPrev")
        print("贴到图标:", json.dumps(on, ensure_ascii=False))
        assert on["op"] == 1 and on["pe"] == "auto", "靠近图标应浮出并可点"

        # 5) 点击可翻页
        pg.mouse.click(prev["cx"], prev["cy"])
        pg.wait_for_timeout(900)
        name1 = pg.inner_text("#viewerInfo .fname")
        print("点上一张后:", name1)
        assert name1 != name0, "点击应正常翻页"

        # 6) 远离后收回
        pg.mouse.move(450, 300, steps=8)
        pg.wait_for_timeout(300)
        off = pg.evaluate(PROBE % "#navPrev")
        print("移开后:", json.dumps(off, ensure_ascii=False))
        assert off["op"] == 0 and off["pe"] == "none", "移开应收回并交出指针"

        # 7) 右侧同理
        pg.mouse.move(nxt["cx"], nxt["cy"], steps=6)
        pg.wait_for_timeout(260)
        ron = pg.evaluate(PROBE % "#navNext")
        print("右侧贴图标:", json.dumps(ron, ensure_ascii=False))
        assert ron["op"] == 1

        # 8) 图片区可正常拖动（按钮隐身时不再吃事件）
        img = pg.locator("#viewerStage img").bounding_box()
        cx, cy = img["x"] + img["width"] / 2, img["y"] + img["height"] / 2
        pg.mouse.move(cx, cy)
        pg.mouse.down()
        pg.mouse.move(cx + 60, cy + 30, steps=6)
        pg.mouse.up()
        pg.wait_for_timeout(300)
        tf = pg.evaluate("()=>document.querySelector('#viewerStage img').style.transform")
        print("拖动后 transform:", tf)

        # 9) 键盘翻页照旧
        pg.keyboard.press("ArrowRight")
        pg.wait_for_timeout(700)
        print("→ 之后:", pg.inner_text("#viewerInfo .fname"))

        print("\n全部通过")
        b.close()


if __name__ == "__main__":
    main()

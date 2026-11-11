# -*- coding: utf-8 -*-
"""影调五项自测：曝光 / 亮度 / 对比度 / 阴影 / 饱和度
逐项验证方向与作用范围，验证可独立调节、互相叠加、整体可还原、可撤销。
"""
import json
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8787/?path=D%3A%5CBNImage%5C_icon_test"

STATS = """()=>{
  const cv = document.querySelector('#edCanvas');
  const c = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const d = c.getImageData(0,0,W,H).data;
  const rect = (x0,x1,y0,y1)=>{
    let sum=0,n=0,ch=0;
    const i0=Math.round(x0*W), i1=Math.round(x1*W), j0=Math.round(y0*H), j1=Math.round(y1*H);
    for(let y=j0;y<j1;y++)for(let x=i0;x<i1;x++){
      const i=(y*W+x)*4;
      if(d[i+3]==0) continue;
      const r=d[i],g=d[i+1],b=d[i+2];
      sum+=0.2126*r+0.7152*g+0.0722*b; ch+=Math.max(r,g,b)-Math.min(r,g,b); n++;
    }
    return {l:sum/n, ch:ch/n};
  };
  const dark = rect(0.08,0.30,0.05,0.95);     // 左：暗部渐变
  const bright = rect(0.70,0.92,0.05,0.95);   // 右：高光渐变
  let gray=0,n=0;
  for(let i=0;i<d.length;i+=4){
    if(d[i+3]==0) continue;
    n++;
    if(Math.abs(d[i]-d[i+1])<3&&Math.abs(d[i+1]-d[i+2])<3) gray++;
  }
  return {dark:+dark.l.toFixed(2), bright:+bright.l.toFixed(2), mean:+((dark.l+bright.l)/2).toFixed(2),
          chroma:+dark.ch.toFixed(2), grayRatio:+(gray/n).toFixed(4)};
}"""

SET = """(kv)=>{
  for (const k in kv){
    const el=document.querySelector('#edSide [data-look="'+k+'"]');
    el.value=String(kv[k]);
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return true;
}"""


def set_look(pg, **kv):
    pg.evaluate(SET, kv)
    pg.wait_for_timeout(420)


def stats(pg):
    return pg.evaluate(STATS)


def main():
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": 1200, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_timeout(2400)

        ok = pg.evaluate("""()=>{
          const c=[...document.querySelectorAll('.cell:not(.folder)')].find(c=>c._item&&c._item.name==='_look_grad.png');
          if(!c) return false; c.click(); return true;
        }""")
        assert ok, "没找到测试图"
        pg.wait_for_timeout(1000)
        pg.click("#zbEdit")
        pg.wait_for_timeout(2200)
        pg.evaluate("()=>document.querySelector('.ed-tool[data-tool=\"light\"]').click()")
        pg.wait_for_timeout(400)

        base = stats(pg)
        print("基准     ", json.dumps(base))

        # 1 曝光：+1EV 整体提亮，高的地方先到顶
        set_look(pg, exp=1)
        e1 = stats(pg)
        print("曝光 +1EV", json.dumps(e1))
        assert e1["mean"] > base["mean"] + 15, "曝光应显著提亮"

        # 2 亮度：150% 提亮中间调，黑场与白场基本不动
        set_look(pg, exp=0, bright=1.5)
        b1 = stats(pg)
        print("亮度 150%", json.dumps(b1))
        assert b1["mean"] > base["mean"] + 5, "亮度应提亮"
        assert abs(b1["bright"] - base["bright"]) < 60, "亮度不该把高光再推爆"

        # 3 对比度：150% 拉开明暗差（暗更暗、亮更亮）
        set_look(pg, bright=1, contrast=1.5)
        c1 = stats(pg)
        print("对比度150%", json.dumps(c1))
        assert c1["dark"] < base["dark"] - 3 and c1["bright"] > base["bright"] + 3, "对比度应拉开明暗"

        # 4 阴影：+100 只提暗部，高光几乎不动
        set_look(pg, contrast=1, shadows=1)
        s1 = stats(pg)
        print("阴影 +100", json.dumps(s1))
        assert s1["dark"] > base["dark"] + 10, "阴影应提亮暗部"
        assert abs(s1["bright"] - base["bright"]) < 4, "阴影不该动高光"

        # 4b 阴影反向
        set_look(pg, shadows=-1)
        s2 = stats(pg)
        print("阴影 -100", json.dumps(s2))
        assert s2["dark"] < base["dark"] - 3, "负阴影应压深暗部"

        # 5 饱和度：0% 全灰
        set_look(pg, shadows=0, sat=0)
        t0 = stats(pg)
        print("饱和度 0%", json.dumps(t0))
        assert t0["grayRatio"] > 0.999, "0% 应完全去色"
        assert t0["chroma"] < 1.5, "去色后不该有彩度"

        # 5b 饱和度 180%：彩度变高
        set_look(pg, sat=1.8)
        t1 = stats(pg)
        print("饱和度180%", json.dumps(t1))
        assert t1["chroma"] > base["chroma"] + 3, "提饱和应增加彩度"

        # 6 五项一起：方向应叠加（提亮 + 提饱和）
        set_look(pg, **{"sat": 1.35, "exp": 0.6, "bright": 1.2, "contrast": 1.15, "shadows": 0.5})
        combo = stats(pg)
        print("组合     ", json.dumps(combo))
        assert combo["mean"] > base["mean"] and combo["chroma"] > base["chroma"]

        # 7 全部还原 → 与基准逐像素一致
        pg.evaluate("()=>document.querySelector('#edLookReset').click()")
        pg.wait_for_timeout(500)
        back = stats(pg)
        print("全部还原 ", json.dumps(back))
        assert abs(back["mean"] - base["mean"]) < 0.01, "还原后应回到原始"

        # 8 撤销 / 重做
        set_look(pg, exp=-1.2)
        pg.wait_for_timeout(200)
        pg.keyboard.press("Control+z")
        pg.wait_for_timeout(400)
        und = pg.evaluate("()=>BNImageEditor.info().look.exp")
        pg.keyboard.press("Control+Shift+z")
        pg.wait_for_timeout(400)
        red = pg.evaluate("()=>BNImageEditor.info().look.exp")
        print("撤销/重做 exp:", und, red)
        assert abs(und) < 1e-6 and abs(red + 1.2) < 1e-6, "撤销重做应还原影调"

        # 9 单参数还原按钮
        pg.evaluate("()=>document.querySelector('[data-look-reset=\"exp\"]').click()")
        pg.wait_for_timeout(400)
        one = pg.evaluate("()=>BNImageEditor.info().look")
        print("单项还原后:", json.dumps(one, ensure_ascii=False))
        assert abs(one["exp"]) < 1e-6 and one["sat"] == 1

        print("页面错误:", errs)
        assert not errs, "有 JS 报错"
        print("\n全部通过")
        b.close()


if __name__ == "__main__":
    main()

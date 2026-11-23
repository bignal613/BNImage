"""把 Word / Excel / PowerPoint 转成一张网页，直接塞进内置查看器里看。

这台机器上没有 Office、WPS、LibreOffice，所以不能靠「导出 PDF」那条老路。
好在 docx / xlsx / pptx 三种文件本身都是 zip + XML，用 python-docx、openpyxl、
python-pptx 读出来，自己拼一份静态 HTML 就行——不依赖任何外部程序，离线可用。

定位是「快速看一眼」：文字、表格、图片、版面位置都尽量还原，
但不追求打印级排版（不做页眉页脚、分页、SmartArt、图表）。
"""

from __future__ import annotations

import base64
import datetime as _dt
import html
import io
import os
import re

MAX_IMAGE = 1280          # 单张图片的最长边，超过就缩，避免 HTML 体积失控
SLIDE_W = 960             # 幻灯片在页面上的显示宽度（px）

COLOR_NAMES = {
    "000000": "#000000", "FFFFFF": "#ffffff", "FF0000": "#ff0000",
}


def esc(s) -> str:
    return html.escape("" if s is None else str(s), quote=False)


def _color(c):
    """python-docx / openpyxl / python-pptx 的 RGBColor → #rrggbb"""
    if c is None:
        return None
    try:
        if isinstance(c, str):
            h = c.strip().lstrip("#")
            if len(h) == 8:
                h = h[2:]
            if len(h) == 6:
                return "#" + h.lower()
            return None
        if getattr(c, "type", None) is not None:      # pptx 的 RGBColor / theme
            pass
        rgb = str(c)
        if len(rgb) == 6:
            return "#" + rgb.lower()
        if len(rgb) == 8:
            return "#" + rgb[2:].lower()
    except Exception:
        pass
    return None


def _png_uri(blob: bytes, mime: str = "") -> str:
    """图片塞成 data URI。一份提案 PPT 里图片动辄十几 MB，直接内联会让
    HTML 大到几千万字节，所以要压：超过 1280px 的缩，超过 180KB 的转 webp。"""
    mime = mime or "image/png"
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(blob))
        w, h = im.size
        big = max(w, h) > MAX_IMAGE
        heavy = len(blob) > 180_000
        if big or heavy:
            if big:
                k = MAX_IMAGE / float(max(w, h))
                im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA" if "A" in im.mode else "RGB")
            buf = io.BytesIO()
            im.save(buf, "WEBP", quality=82, method=4)
            out = buf.getvalue()
            if out and len(out) < len(blob):
                blob, mime = out, "image/webp"
        im.close()
    except Exception:
        pass
    return f"data:{mime};base64," + base64.b64encode(blob).decode("ascii")


# --------------------------------------------------------------------- CSS

def _css(theme: str) -> str:
    dark = theme == "dark"
    if dark:
        bg, card, ink, ink2, line, head = "#0d0d0f", "#16161a", "#f0f0f3", "#b6b6bf", "#2a2a30", "#1c1c21"
    else:
        bg, card, ink, ink2, line, head = "#f7f7f5", "#ffffff", "#17171a", "#4d4d55", "#e2e2de", "#f2f2ef"
    return f"""
:root {{
  color-scheme: {'dark' if dark else 'light'};
  --bg:{bg}; --card:{card}; --ink:{ink}; --ink2:{ink2}; --line:{line}; --head:{head};
}}
* {{ box-sizing: border-box; }}
html, body {{ margin:0; padding:0; }}
body {{
  background: var(--bg); color: var(--ink);
  font: 13px/1.7 "Microsoft YaHei","PingFang SC","Segoe UI",sans-serif;
  padding: 18px 20px 40px;
  -webkit-font-smoothing: antialiased;
}}
h2.sec {{ font-size: 12px; font-weight: 600; color: var(--ink2); margin: 0 0 8px; letter-spacing: .02em; }}

/* ------------------------------------------------------------ Excel */
.xls {{ display: flex; flex-direction: column; gap: 22px; align-items: center; }}
.xls-sheet {{ max-width: 100%; overflow-x: auto; }}
table.grid {{
  border-collapse: separate; border-spacing: 0; background: var(--card);
  box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 0 0 1px var(--line);
  table-layout: fixed;
}}
table.grid td {{
  border-right: 1px solid var(--line); border-bottom: 1px solid var(--line);
  padding: 3px 6px; vertical-align: middle;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  line-height: 1.45;
}}
table.grid tr:first-child td {{ border-top: 0; }}
table.grid td:last-child {{ border-right: 0; }}
table.grid tr:last-child td {{ border-bottom: 0; }}
table.grid td.wrap {{ white-space: pre-wrap; word-break: break-word; }}
table.grid td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}

/* ------------------------------------------------------------ Word */
.doc {{ display: flex; justify-content: center; }}
.page {{
  width: 794px; max-width: 100%; background: var(--card);
  box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 0 0 1px var(--line);
  padding: 64px 72px; border-radius: 2px;
}}
.page p {{ margin: 0 0 .62em; }}
.page .h1 {{ font-size: 22px; font-weight: 700; margin: 0 0 .7em; }}
.page .h2 {{ font-size: 18px; font-weight: 700; margin: 1.1em 0 .5em; }}
.page .h3 {{ font-size: 15.5px; font-weight: 700; margin: 1em 0 .45em; }}
.page .h4, .page .h5, .page .h6 {{ font-size: 14px; font-weight: 700; margin: .9em 0 .4em; }}
.page .li {{ padding-left: 1.6em; position: relative; }}
.page .li::before {{ content: "·"; position: absolute; left: .6em; }}
.page img {{ max-width: 100%; height: auto; }}
.page table {{ border-collapse: collapse; width: 100%; margin: .6em 0 1em; }}
.page table td, .page table th {{
  border: 1px solid var(--line); padding: 5px 8px; vertical-align: top;
}}

/* ------------------------------------------------------------ PPT */
.deck {{ display: flex; flex-direction: column; gap: 18px; align-items: center; }}
.slide {{
  position: relative; overflow: hidden; flex: none;
  background: #fff; border-radius: 3px;
  box-shadow: 0 2px 10px rgba(0,0,0,.13), 0 0 0 1px var(--line);
}}
.slide .sh {{ position: absolute; overflow: hidden; }}
.slide .sh p {{ margin: 0; white-space: pre-wrap; }}
.slide {{ color: #17171a; }}
.slide img.pic {{ width: 100%; height: 100%; object-fit: contain; display: block; }}
.slide table.st {{ border-collapse: collapse; width: 100%; height: 100%; }}
.slide table.st td {{ border: 1px solid rgba(0,0,0,.2); padding: 4px 6px; vertical-align: top; }}
.slide-no {{ font-size: 11px; color: var(--ink2); text-align: center; margin-top: -8px; }}
.empty {{ color: var(--ink2); padding: 40px; text-align: center; }}
"""


def _page(title: str, theme: str, body: str) -> bytes:
    return (
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        f"<title>{esc(title)}</title><style>{_css(theme)}</style></head>"
        f"<body>{body}</body></html>"
    ).encode("utf-8")


# --------------------------------------------------------------------- XLSX

_DATE_FMT = re.compile(r"(yy|mm?/dd|dd|m月|d日|yyyy)")


def _num_fmt(value, fmt: str):
    """把单元格的值按数字格式排成给人看的样子（不追求 Excel 的全套格式语法）"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
        if isinstance(value, _dt.datetime):
            return value.strftime("%Y-%m-%d %H:%M") if (value.hour or value.minute) else value.strftime("%Y-%m-%d")
        if isinstance(value, _dt.date):
            return value.strftime("%Y-%m-%d")
        return value.strftime("%H:%M")
    if isinstance(value, (int, float)):
        f = (fmt or "").lower()
        if "%" in f:
            dec = 2 if "0.00" in f else 0
            return f"{value * 100:.{dec}f}%"
        if "¥" in f or "￥" in f or "cny" in f or "currency" in f:
            dec = 2 if ("0.00" in f or "#,##0.00" in f) else 0
            return f"¥{value:,.{dec}f}"
        if f in ("", "general"):
            if isinstance(value, float) and value.is_integer():
                return f"{int(value):,}"
            return f"{value:,}" if isinstance(value, int) else f"{value:g}"
        if "0.00" in f or "#,##0.00" in f:
            return f"{value:,.2f}"
        if "#,##0" in f:
            return f"{int(round(value)):,}"
        if isinstance(value, float) and value.is_integer():
            return f"{int(value):,}"
        return f"{value:g}"
    return str(value)


def render_xlsx(path: str, theme: str, title: str) -> bytes:
    import openpyxl

    wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    chunks = ['<div class="xls">']
    for ws in wb.worksheets:
        rows, cols = ws.max_row or 0, ws.max_column or 0
        if not rows or not cols:
            continue
        if rows > 4000 or cols > 120:      # 超大表不整张画，先给个提示
            chunks.append(
                f'<div class="xls-sheet"><h2 class="sec">{esc(ws.title)}</h2>'
                f'<p class="empty">这张表太大（{rows} 行 × {cols} 列），'
                f'为免卡顿没有展开，请用 Excel 打开。</p></div>')
            continue

        # 列宽（Excel 的 width 单位≈字符数）
        widths = []
        for ci in range(1, cols + 1):
            letter = openpyxl.utils.get_column_letter(ci)
            w = ws.column_dimensions[letter].width if letter in ws.column_dimensions else None
            widths.append(max(36, min(420, int((w or 8.43) * 7.6 + 6))))

        # 合并单元格：左上角记 (rowspan, colspan)，其余位置跳过
        span = {}
        covered = set()
        for rng in ws.merged_cells.ranges:
            r1, c1, r2, c2 = rng.min_row, rng.min_col, rng.max_row, rng.max_col
            span[(r1, c1)] = (r2 - r1 + 1, c2 - c1 + 1)
            for r in range(r1, r2 + 1):
                for c in range(c1, c2 + 1):
                    if (r, c) != (r1, c1):
                        covered.add((r, c))

        chunks.append(f'<div class="xls-sheet"><h2 class="sec">{esc(ws.title)}</h2>')
        chunks.append('<table class="grid"><colgroup>')
        chunks.extend(f'<col style="width:{w}px">' for w in widths)
        chunks.append('</colgroup>')

        for ri in range(1, rows + 1):
            tds = []
            for ci in range(1, cols + 1):
                if (ri, ci) in covered:
                    continue
                cell = ws.cell(row=ri, column=ci)
                txt = _num_fmt(cell.value, cell.number_format)
                style = []
                cls = []
                font = cell.font
                if font and font.b:
                    style.append("font-weight:700")
                if font and font.i:
                    style.append("font-style:italic")
                if font and font.sz:
                    style.append(f"font-size:{min(28, max(9, float(font.sz) * 1.0)):.1f}px")
                fc = _color(font.color) if (font and font.color and font.color.type == "rgb") else None
                if fc and fc not in ("#000000",):
                    style.append(f"color:{fc}")
                fill = cell.fill
                if fill and getattr(fill, "patternType", None) == "solid":
                    bgc = _color(fill.fgColor)
                    if bgc and bgc != "#ffffff":
                        style.append(f"background:{bgc}")
                al = cell.alignment
                if al:
                    if al.horizontal in ("center", "right"):
                        cls.append("num" if al.horizontal == "right" else "hcenter")
                    if al.horizontal == "right":
                        style.append("text-align:right")
                    elif al.horizontal == "center":
                        style.append("text-align:center")
                    if al.vertical in ("center", "top"):
                        style.append(f"vertical-align:{al.vertical}")
                    if al.wrap_text:
                        cls.append("wrap")
                if isinstance(cell.value, (int, float)) and "num" not in cls:
                    cls.append("num")
                rs, cs = span.get((ri, ci), (1, 1))
                attrs = f' rowspan="{rs}"' if rs > 1 else ""
                attrs += f' colspan="{cs}"' if cs > 1 else ""
                st = f' style="{";".join(style)}"' if style else ""
                c2 = f' class="{" ".join(cls)}"' if cls else ""
                tds.append(f"<td{attrs}{st}{c2}>{esc(txt)}</td>")
            if tds:
                chunks.append("<tr>" + "".join(tds) + "</tr>")
        chunks.append("</table></div>")
    chunks.append("</div>")
    if len(chunks) <= 2:
        chunks.append('<p class="empty">这个工作簿里没有可显示的内容</p>')
    return _page(title, theme, "".join(chunks))


# --------------------------------------------------------------------- DOCX

_DOC_HEADINGS = {"heading 1": "h1", "heading 2": "h2", "heading 3": "h3",
                 "heading 4": "h4", "heading 5": "h5", "heading 6": "h6",
                 "标题 1": "h1", "标题 2": "h2", "标题 3": "h3"}


def _docx_font(run):
    """Word 的中文字体写在 rFonts/@w:eastAsia 里，python-docx 的 font.name 常读不到"""
    try:
        from docx.oxml.ns import qn
        rPr = run._element.rPr
        if rPr is None or rPr.rFonts is None:
            return None
        rf = rPr.rFonts
        return rf.get(qn("w:eastAsia")) or rf.get(qn("w:ascii"))
    except Exception:
        return None


def _docx_runs(par):
    """一段里的文字都带上粗体/斜体/字号/颜色，图片直接内联"""
    out = []
    for run in par.runs:
        txt = run.text
        blobs = []
        try:
            for blip in run._element.findall(
                    ".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip"):
                rid = blip.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
                if not rid:
                    continue
                try:
                    part = par.part.related_parts[rid]
                    blobs.append(_png_uri(part.blob, getattr(part, "content_type", "") or "image/png"))
                except Exception:
                    continue
        except Exception:
            pass
        if txt:
            st = []
            if run.bold:
                st.append("font-weight:700")
            if run.italic:
                st.append("font-style:italic")
            if run.underline:
                st.append("text-decoration:underline")
            if run.font is not None and run.font.size is not None:
                st.append(f"font-size:{run.font.size.pt:.1f}pt")
            fam = _docx_font(run)
            if fam and fam.lower() not in ("microsoft yahei", "微软雅黑"):
                st.append(f"font-family:'{esc(fam)}',inherit")
            fc = _color(run.font.color) if (run.font is not None and run.font.color
                                            and getattr(run.font.color, "rgb", None)) else None
            if fc and fc != "#000000":
                st.append(f"color:{fc}")
            if st:
                out.append(f'<span style="{";".join(st)}">{esc(txt)}</span>')
            else:
                out.append(esc(txt))
        for b in blobs:
            out.append(f'<img src="{b}" alt="">')
    return "".join(out)


def _docx_table(tbl) -> str:
    rows = []
    for tr in tbl.rows:
        tds = []
        for tc in tr.cells:
            tds.append("<td>" + "".join(_docx_cell(tc) for _ in [0]) + "</td>")
        rows.append("<tr>" + "".join(tds) + "</tr>")
    return "<table>" + "".join(rows) + "</table>"


def _docx_cell(tc):
    parts = []
    for p in tc.paragraphs:
        txt = _docx_runs(p)
        if txt:
            parts.append(f"<p>{txt}</p>")
    for t in tc.tables:
        parts.append(_docx_table(t))
    return "".join(parts)


def render_docx(path: str, theme: str, title: str) -> bytes:
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    doc = docx.Document(path)
    body = doc.element.body
    out = []
    for child in body.iterchildren():
        tag = child.tag.split("}")[-1]
        if tag == "p":
            par = Paragraph(child, doc)
            txt = _docx_runs(par)
            style = (par.style.name or "").lower() if par.style is not None else ""
            cls = _DOC_HEADINGS.get(style, "")
            if not txt and not cls:
                out.append('<p style="height:.55em"></p>')
                continue
            if not cls and "list" in style:
                cls = "li"
            al = par.alignment
            st = ""
            if al is not None:
                name = str(al).lower()
                if "center" in name:
                    st = ' style="text-align:center"'
                elif "right" in name:
                    st = ' style="text-align:right"'
                elif "justify" in name:
                    st = ' style="text-align:justify"'
            out.append(f'<p class="{cls}"{st}>{txt}</p>' if cls else f"<p{st}>{txt}</p>")
        elif tag == "tbl":
            out.append(_docx_table(Table(child, doc)))
    if not out:
        out.append('<p class="empty">这个文档里没有可显示的文字</p>')
    return _page(title, theme, '<div class="doc"><div class="page">' + "".join(out) + "</div></div>")


# --------------------------------------------------------------------- PPTX

def _emu(px, scale):
    return int(round((px or 0) / 914400.0 * 96 * scale))


def _pptx_default_pt(shape) -> float:
    """占位符没写字号时，按占位符类型给一个 PowerPoint 的常规值，
    否则标题会缩成 13px，整页看起来像没渲染。"""
    try:
        pf = shape.placeholder_format
        name = str(pf.type).upper()
        if "TITLE" in name:
            return 40
        if "SUBTITLE" in name:
            return 24
        if "BODY" in name or "CONTENT" in name or "OBJECT" in name:
            return 18
    except Exception:
        pass
    return 16


def _pptx_par_pt(par):
    """段落里 <a:pPr><a:defRPr sz="1800"> 这种继承下来的字号"""
    try:
        pPr = par._p.find("{http://schemas.openxmlformats.org/drawingml/2006/main}pPr")
        if pPr is None:
            return None
        d = pPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}defRPr")
        if d is None:
            return None
        sz = d.get("sz")
        return int(sz) / 100.0 if sz else None
    except Exception:
        return None


def _pptx_run_html(run, scale, fallback_pt=16.0, par_pt=None):
    txt = run.text
    if not txt:
        return ""
    st = []
    f = run.font
    pt = None
    if f is not None and f.size is not None:
        pt = f.size.pt
    if pt is None:
        pt = par_pt or fallback_pt
    st.append(f"font-size:{pt * 96 / 72 * scale:.1f}px")
    if f is not None:
        if f.bold:
            st.append("font-weight:700")
        if f.italic:
            st.append("font-style:italic")
        if f.underline:
            st.append("text-decoration:underline")
        c = _color(f.color) if getattr(f.color, "rgb", None) else None
        if c:
            st.append(f"color:{c}")
        if f.name and ("Microsoft YaHei" not in str(f.name)):
            st.append(f"font-family:'{esc(f.name)}',inherit")
    return f'<span style="{";".join(st)}">{esc(txt).replace(chr(10), "<br>")}</span>'


def _pptx_text(shape, scale) -> str:
    tf = shape.text_frame
    if tf is None:
        return ""
    base = _pptx_default_pt(shape)
    ps = []
    for p in tf.paragraphs:
        ppt = _pptx_par_pt(p)
        inner = "".join(_pptx_run_html(r, scale, base, ppt) for r in p.runs)
        if not inner:
            inner = "&nbsp;"
        al = ""
        if p.alignment is not None:
            nm = str(p.alignment).lower()
            if "center" in nm:
                al = "text-align:center;"
            elif "right" in nm:
                al = "text-align:right;"
            elif "justify" in nm:
                al = "text-align:justify;"
        lvl = getattr(p, "level", 0) or 0
        ind = f"padding-left:{lvl * 18 * scale:.0f}px;" if lvl else ""
        ps.append(f'<p style="{al}{ind}">{inner}</p>')
    # 垂直对齐
    va = "flex-start"
    try:
        anch = str(tf.vertical_anchor or "")
        if "MIDDLE" in anch.upper():
            va = "center"
        elif "BOTTOM" in anch.upper():
            va = "flex-end"
    except Exception:
        pass
    return f'<div style="display:flex;flex-direction:column;justify-content:{va};width:100%;height:100%;overflow:hidden">' + "".join(ps) + "</div>"


def _pptx_shape(sh, scale, out, tf=None):
    """tf = (dx, dy, kx, ky)：组合内部坐标到幻灯片坐标的换算"""
    try:
        L, T = sh.left, sh.top
        W, H = sh.width, sh.height
    except Exception:
        return
    if L is None or T is None or W is None or H is None:
        return
    if tf:
        dx, dy, kx, ky = tf
        L, W = (L - 0) * kx, W * kx
        T, H = (T - 0) * ky, H * ky
        L, T = L + dx, T + dy
    left, top = _emu(L, scale), _emu(T, scale)
    w, h = _emu(W, scale), _emu(H, scale)
    if w <= 0 or h <= 0:
        return
    box = f"left:{left}px;top:{top}px;width:{w}px;height:{h}px;"

    # 组合：把子形状按组的 chOff/chExt 换算后继续画
    if str(getattr(sh, "shape_type", "")).upper().find("GROUP") >= 0:
        try:
            gx = sh._element.find(
                "{http://schemas.openxmlformats.org/drawingml/2006/main}xfrm")
            chOff = gx.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chOff")
            chExt = gx.find("{http://schemas.openxmlformats.org/drawingml/2006/main}chExt")
            if chOff is not None and chExt is not None:
                cx, cy = int(chOff.get("x")), int(chOff.get("y"))
                cw, ch = int(chExt.get("cx")), int(chExt.get("cy"))
                kx = W / cw if cw else 1.0
                ky = H / ch if ch else 1.0
                ntf = (L - cx * kx, T - cy * ky, kx, ky)
                for sub in sh.shapes:
                    try:
                        _pptx_shape(sub, scale, out, ntf)
                    except Exception:
                        continue
                return
        except Exception:
            pass

    # 图片
    if getattr(sh, "image", None) is not None:
        try:
            blob = sh.image.blob
            mime = sh.image.content_type or "image/png"
            out.append(f'<div class="sh" style="{box}"><img class="pic" src="{_png_uri(blob, mime)}" alt=""></div>')
            return
        except Exception:
            pass

    # 表格
    if getattr(sh, "has_table", False):
        try:
            tb = sh.table
            rows = []
            for r in tb.rows:
                tds = []
                for c in r.cells:
                    tds.append("<td>" + esc(c.text).replace("\n", "<br>") + "</td>")
                rows.append("<tr>" + "".join(tds) + "</tr>")
            out.append(f'<div class="sh" style="{box}"><table class="st">' + "".join(rows) + "</table></div>")
            return
        except Exception:
            pass

    fill = ""
    try:
        if sh.fill is not None and sh.fill.type is not None and int(sh.fill.type) == 1:
            c = _color(sh.fill.fore_color.rgb) if getattr(sh.fill.fore_color, "rgb", None) else None
            if c:
                fill = f"background:{c};"
    except Exception:
        pass

    text = _pptx_text(sh, scale) if getattr(sh, "has_text_frame", False) else ""
    if text or fill:
        out.append(f'<div class="sh" style="{box}{fill}">{text}</div>')


def _pptx_slide_bg(slide) -> str:
    """幻灯片底色：优先纯色，其次整页背景图（很多提案模板都靠这张图）"""
    try:
        f = slide.background.fill
        if f is not None and f.type is not None and int(f.type) == 1:
            c = _color(f.fore_color.rgb) if getattr(f.fore_color, "rgb", None) else None
            if c:
                return f"background:{c};"
    except Exception:
        pass
    try:
        ns = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
        rns = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
        for blip in slide._element.findall(f".//{ns}bg//{ns}blip"):
            rid = blip.get(rns + "embed")
            if not rid:
                continue
            part = slide.part.related_parts[rid]
            uri = _png_uri(part.blob, getattr(part, "content_type", "") or "image/png")
            return ("background-image:url(" + uri + ");"
                    "background-size:cover;background-position:center;")
    except Exception:
        pass
    return "background:#fff;"


def render_pptx(path: str, theme: str, title: str) -> bytes:
    from pptx import Presentation

    prs = Presentation(path)
    sw = prs.slide_width or 9144000
    sh = prs.slide_height or 6858000
    scale = SLIDE_W / (sw / 914400.0 * 96.0)
    H = int(round((sh / 914400.0 * 96.0) * scale))
    total = len(prs.slides._sldIdLst)
    out = ['<div class="deck">']
    for i, slide in enumerate(prs.slides, 1):
        bg = _pptx_slide_bg(slide)
        out.append(f'<div class="slide" style="width:{SLIDE_W}px;height:{H}px;{bg}">')
        for shp in slide.shapes:
            try:
                _pptx_shape(shp, scale, out)
            except Exception:
                continue
        out.append("</div>")
        out.append(f'<div class="slide-no">{i} / {total}</div>')
    out.append("</div>")
    if total == 0:
        out.append('<p class="empty">这份演示文稿里没有幻灯片</p>')
    return _page(title, theme, "".join(out))


# --------------------------------------------------------------------- 入口

RENDERERS = {".docx": render_docx, ".xlsx": render_xlsx, ".pptx": render_pptx}


def render(path: str, theme: str = "light") -> bytes | None:
    ext = os.path.splitext(path)[1].lower()
    fn = RENDERERS.get(ext)
    if fn is None:
        return None
    title = os.path.basename(path)
    return fn(path, theme, title)

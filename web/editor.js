/* BNImage · 图片编辑器
   ------------------------------------------------------------------
   一个文档 = { crop, look, strokes[], texts[] }
   · look = { exp, bright, contrast, shadows, sat } —— 影调五项，只作用于照片本身
   · 图元坐标统一用「裁剪后的视图坐标」（单位=原图像素，原点=裁剪左上）
   · 屏幕绘制走预览图，导出绘制走原图，两条路径同一套坐标
   · 所有会改变文档的操作都进历史栈，撤销/重做是整份快照
   ------------------------------------------------------------------ */

(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#af52de'];
  const FONTS = [
    ['Microsoft YaHei', '微软雅黑'],
    ['SimHei', '黑体'],
    ['SimSun', '宋体'],
    ['KaiTi', '楷体'],
    ['DengXian', '等线'],
    ['Arial', 'Arial'],
    ['Georgia', 'Georgia'],
  ];
  const PREVIEW_MAX = 2560;
  const LOOK_SHARP_MAX = 4096;   // 放大细看时影调用的高清缓冲上限（长边）
  const HIST_MAX = 80;

  /* ---------------------------------------------------------- 影调五项
     五个参数各有各的活儿，按固定顺序叠加（改顺序会得到不一样的结果）：
       1 曝光   线性增益，整幅一起乘 2^EV；抬得越多高光越先到顶（像开大光圈/加档）
       2 亮度   伽马提亮中间调，黑白场基本不动，用来补整体明暗而不吹高光
       3 阴影   只吃暗部的权重曲线 (1-v)^3：加＝把暗部提回来，减＝压深暗部
       4 对比度 围绕中灰 0.5 缩放明暗差，>100% 更硬、<100% 更灰
       5 饱和度 与灰度混合，0% 全灰、100% 原样、200% 浓艳
     前四项合成为一条 256 级查找表，饱和度按跨通道公式另算，一次遍历出图。 */
  const LOOK_DEF = { exp: 0, bright: 1, contrast: 1, shadows: 0, sat: 1 };
  const LOOK_PARAMS = [
    {
      k: 'exp', name: '曝光', min: -2, max: 2, step: 0.05,
      fmt: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' EV',
      ends: ['−2.00', '+2.00 EV'], hint: '线性增益，整幅乘 2^EV；往右拉高光会先到顶',
    },
    {
      k: 'bright', name: '亮度', min: 0.4, max: 1.8, step: 0.01,
      fmt: (v) => Math.round(v * 100) + '%',
      ends: ['40%', '180%'], hint: '伽马提亮中间调，黑白场不动，不容易吹高光',
    },
    {
      k: 'contrast', name: '对比度', min: 0.5, max: 2, step: 0.01,
      fmt: (v) => Math.round(v * 100) + '%',
      ends: ['50%', '200%'], hint: '围绕中灰缩放明暗差，越大越硬朗，越小越灰',
    },
    {
      k: 'shadows', name: '阴影', min: -1, max: 1, step: 0.01,
      fmt: (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 100)),
      ends: ['−100', '+100'], hint: '只作用于暗部：加＝找回暗部细节，减＝压深暗部',
    },
    {
      k: 'sat', name: '饱和度', min: 0, max: 2, step: 0.01,
      fmt: (v) => Math.round(v * 100) + '%',
      ends: ['0%', '200%'], hint: '与灰度混合，0% 全灰、100% 原样、200% 浓艳',
    },
  ];

  const D = {};
  const S = {
    open: false,
    item: null,
    src: null,          // 原图 Image
    pv: null,           // 预览源（canvas 或原 Image）
    pvScale: 1,         // 预览源 / 原图
    pvW: 0,
    pvH: 0,
    lookCv: null,       // 影调处理后的预览图
    lookCtx: null,
    lookScale: 1,
    lookSig: '',
    lookSharp: null,    // 放大细看用的高清影调图（空闲时才算）
    lookSharpScale: 1,
    lookSharpKey: '',
    W: 0, H: 0,
    doc: null,
    tool: 'crop',
    scale: 1,
    fit: 1,
    panX: 0,
    panY: 0,
    hist: [],
    hi: -1,
    sel: null,          // 选中的文字 id
    aspect: 0,
    cropSel: null,
    brush: { color: '#ff3b30', size: 10 },
    arrow: { color: '#ff3b30', size: 6, both: false },
    txt: { font: 'Microsoft YaHei', size: 56, color: '#ffffff' },
    drawing: null,
    arrowDrag: null,
    textDrag: null,
    cropDrag: null,
    panning: null,
    space: false,
    seq: 0,
    saving: false,
    readyAt: 0,
  };

  let rafId = 0;

  /* ---------------------------------------------------------- 小工具 */

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const uid = () => 't' + (++S.seq) + Date.now().toString(36).slice(-3);

  function node(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function docSize() {
    const c = S.doc.crop;
    return { w: c.w, h: c.h };
  }

  /* ---------------------------------------------------------- 影调计算 */

  const NEAR = 1e-4;

  function numOr(v, def, a, b) {
    const n = typeof v === 'number' && isFinite(v) ? v : def;
    return n < a ? a : n > b ? b : n;
  }

  /* 兼容老文档：以前只有一个 bright（乘性亮度），语义正好等于现在的 brightness */
  function normLook(src) {
    const o = src && typeof src === 'object' ? src : {};
    return {
      exp: numOr(o.exp, LOOK_DEF.exp, -2, 2),
      bright: numOr(o.bright, LOOK_DEF.bright, 0.4, 1.8),
      contrast: numOr(o.contrast, LOOK_DEF.contrast, 0.5, 2),
      shadows: numOr(o.shadows, LOOK_DEF.shadows, -1, 1),
      sat: numOr(o.sat, LOOK_DEF.sat, 0, 2),
    };
  }

  function lookNeutral(l) {
    if (!l) return true;
    return Math.abs(l.exp) < NEAR && Math.abs(l.bright - 1) < NEAR &&
           Math.abs(l.contrast - 1) < NEAR && Math.abs(l.shadows) < NEAR &&
           Math.abs(l.sat - 1) < NEAR;
  }

  /* 曝光/亮度/阴影/对比度 合成一条 256 级查找表 */
  function lookLUT(l) {
    const ev = Math.pow(2, l.exp);      // +1 EV = 通光量翻倍
    const gam = 1 / l.bright;           // 亮度用伽马，端点不动
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let v = (i / 255) * ev;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      v = Math.pow(v, gam);
      const w = (1 - v) * (1 - v) * (1 - v);   // 暗部权重：越亮越不管
      v += l.shadows * 0.45 * w;
      v = 0.5 + (v - 0.5) * l.contrast;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      lut[i] = Math.round(v * 255);
    }
    return lut;
  }

  /* 一次遍历：查表出明暗，再按 0.2126/0.7152/0.0722 的灰度权重混饱和度 */
  function applyLookData(data, l) {
    const lut = lookLUT(l);
    const s = l.sat;
    if (Math.abs(s - 1) < NEAR) {
      for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
      }
      return;
    }
    for (let i = 0; i < data.length; i += 4) {
      const r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];
      const gray = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      data[i] = gray + (r - gray) * s;
      data[i + 1] = gray + (g - gray) * s;
      data[i + 2] = gray + (b - gray) * s;
    }
  }

  function lookSig(l) {
    return [l.exp, l.bright, l.contrast, l.shadows, l.sat].join(',');
  }

  /* 参数没变就不重算：拖动滑块时每帧一次，平移缩放直接复用 */
  function ensureLook() {
    if (!S.doc || !S.pv) return;
    const l = S.doc.look;
    if (lookNeutral(l)) {
      S.lookCv = null;
      S.lookSig = '';
      return;
    }
    if (!S.pvW || !S.pvH) return;
    const sig = lookSig(l) + '|' + S.pvW + 'x' + S.pvH;
    if (S.lookCv && S.lookSig === sig) return;

    const w = S.pvW, h = S.pvH;
    if (!S.lookCv) {
      S.lookCv = document.createElement('canvas');
      S.lookCtx = S.lookCv.getContext('2d', { willReadFrequently: true });
    }
    if (S.lookCv.width !== w || S.lookCv.height !== h) {
      S.lookCv.width = w;
      S.lookCv.height = h;
    }
    S.lookCtx.clearRect(0, 0, w, h);
    S.lookCtx.drawImage(S.pv, 0, 0, w, h);
    const img = S.lookCtx.getImageData(0, 0, w, h);
    applyLookData(img.data, l);
    S.lookCtx.putImageData(img, 0, 0);
    S.lookScale = S.pvScale;
    S.lookSig = sig;
  }

  /* 放到超过预览像素时，预览图会被放大，看着发虚。
     停手 200ms 后按原图再算一张高清的（长边 ≤4096），只此一次，不拖慢拖动。 */
  let sharpTimer = 0;

  function needsSharp() {
    if (!S.doc || !S.lookCv) return false;
    const long = Math.max(S.W, S.H);
    if (long <= Math.max(S.pvW, S.pvH)) return false;
    const c = S.doc.crop;
    return Math.max(c.w, c.h) * S.scale > Math.max(S.lookCv.width, S.lookCv.height) * 0.98;
  }

  function ensureSharpSoon() {
    if (!needsSharp()) return;
    if (S.lookSharp && S.lookSharpKey === lookSig(S.doc.look)) return;
    clearTimeout(sharpTimer);
    sharpTimer = setTimeout(buildSharpLook, 200);
  }

  function buildSharpLook() {
    if (!S.doc || lookNeutral(S.doc.look)) {
      S.lookSharp = null;
      S.lookSharpKey = '';
      return;
    }
    const long = Math.max(S.W, S.H);
    const k = Math.min(1, LOOK_SHARP_MAX / long);
    const w = Math.max(1, Math.round(S.W * k));
    const h = Math.max(1, Math.round(S.H * k));
    const key = lookSig(S.doc.look);
    if (S.lookSharp && S.lookSharpKey === key) return;

    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(S.src, 0, 0, w, h);
    const img = c.getImageData(0, 0, w, h);
    applyLookData(img.data, S.doc.look);
    c.putImageData(img, 0, 0);
    S.lookSharp = cv;
    S.lookSharpScale = w / S.W;
    S.lookSharpKey = key;
    render();
  }

  function dropSharp() {
    clearTimeout(sharpTimer);
    S.lookSharp = null;
    S.lookSharpKey = '';
  }

  /* ---------------------------------------------------------- 打开/关闭 */

  function openEditor(item) {
    if (S.open || !item || item.kind !== 'image') return;
    S.open = true;
    S.item = item;
    S.doc = null;
    S.hist = [];
    S.hi = -1;
    S.sel = null;
    S.cropSel = null;
    S.aspect = 0;
    S.tool = 'crop';
    S.scale = 1;
    S.panX = 0;
    S.panY = 0;

    D.root.hidden = false;
    document.body.classList.add('in-editor');
    D.name.textContent = item.name;
    D.dim.textContent = '正在载入…';
    D.savePanel.hidden = true;
    buildSide();
    setStatus('正在载入原图…');

    /* 二倍图也先清掉，避免上一张的残留 */
    [D.cv, D.live].forEach((cv) => {
      const c = cv.getContext('2d');
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
    });

    const src = item.native ? fsUrl(item.path, item.rev) : renderUrl(item, 4096);
    const img = new Image();
    img.onload = () => {
      if (!S.open || S.item !== item) return;
      if (!img.naturalWidth || !img.naturalHeight) {
        toast('这张图读不出尺寸');
        return closeEditor(true);
      }
      boot(img);
    };
    img.onerror = () => {
      if (!S.open) return;
      toast('无法解码原图，不能编辑');
      closeEditor(true);
    };
    img.src = src;
  }

  function boot(img) {
    S.src = img;
    S.W = img.naturalWidth;
    S.H = img.naturalHeight;
    buildPreview();

    S.doc = {
      crop: { x: 0, y: 0, w: S.W, h: S.H },
      look: { ...LOOK_DEF },
      strokes: [],
      texts: [],
    };
    D.dim.textContent = S.W + ' × ' + S.H;
    updateDim();
    fitNow();
    setTool('crop');
    render();
    pushHistory(true);
    refreshHist();
    S.readyAt = Date.now() + 600;
    setStatus(S.item && !S.item.native
      ? '这张格式靠转码预览，导出以实际解码尺寸为准 · 滚轮缩放'
      : '滚轮缩放 · 右键或空格拖动平移');
  }

  function buildPreview() {
    const long = Math.max(S.W, S.H);
    if (long <= PREVIEW_MAX) {
      S.pv = S.src;
      S.pvScale = 1;
      S.pvW = S.W;
      S.pvH = S.H;
      return;
    }
    const k = PREVIEW_MAX / long;
    const w = Math.max(1, Math.round(S.W * k));
    const h = Math.max(1, Math.round(S.H * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(S.src, 0, 0, w, h);
    S.pv = cv;
    S.pvScale = w / S.W;
    S.pvW = w;
    S.pvH = h;
  }

  function closeEditor(force) {
    if (!S.open) return;
    if (!force && isDirty()) {
      if (!window.confirm('这次编辑还没有保存，确定退出吗？')) return;
    }
    S.open = false;
    dropSharp();
    S.lookCv = null;
    S.lookCtx = null;
    S.lookSig = '';
    S.src = null;
    S.pv = null;
    S.doc = null;
    S.hist = [];
    S.hi = -1;
    S.sel = null;
    S.cropSel = null;
    S.drawing = null;
    S.arrowDrag = null;
    S.textDrag = null;
    S.cropDrag = null;
    S.panning = null;
    D.root.hidden = true;
    D.savePanel.hidden = true;
    document.body.classList.remove('in-editor');
    if (typeof onEditorClosed === 'function') onEditorClosed();
  }

  function isDirty() {
    if (S.hi < 0) return false;
    return S.hist[S.hi] !== S.hist[0];
  }

  /* ---------------------------------------------------------- 历史 */

  function snapshot() {
    return JSON.stringify({
      crop: S.doc.crop,
      look: S.doc.look,
      strokes: S.doc.strokes,
      texts: S.doc.texts,
    });
  }

  function pushHistory(silent) {
    if (!S.doc) return;
    const snap = snapshot();
    if (S.hi >= 0 && S.hist[S.hi] === snap) return;
    S.hist = S.hist.slice(0, S.hi + 1);
    S.hist.push(snap);
    if (S.hist.length > HIST_MAX) {
      S.hist.shift();
    }
    S.hi = S.hist.length - 1;
    refreshHist();
    if (!silent) setStatus('已记录 · 可撤销');
  }

  function applySnap(snap) {
    const d = JSON.parse(snap);
    S.doc = {
      crop: d.crop,
      /* 老快照里只有 bright（乘性亮度），正好对应新的 look.bright */
      look: normLook(d.look || (d.bright != null ? { bright: d.bright } : null)),
      strokes: d.strokes,
      texts: d.texts,
    };
    S.sel = null;
    S.cropSel = null;
    fitNow();
    updateDim();
    render();
    buildSide();
  }

  function undo() {
    if (S.hi <= 0) return;
    S.hi -= 1;
    applySnap(S.hist[S.hi]);
    refreshHist();
    setStatus('已撤销');
  }

  function redo() {
    if (S.hi >= S.hist.length - 1) return;
    S.hi += 1;
    applySnap(S.hist[S.hi]);
    refreshHist();
    setStatus('已重做');
  }

  function refreshHist() {
    D.undo.disabled = S.hi <= 0;
    D.redo.disabled = S.hi >= S.hist.length - 1;
  }

  /* ---------------------------------------------------------- 布局与绘制 */

  function fitNow() {
    if (!S.doc) return;
    const { w, h } = docSize();
    const bw = D.wrap.clientWidth || 1;
    const bh = D.wrap.clientHeight || 1;
    S.fit = Math.min(bw / w, bh / h);
    S.scale = Math.min(1, S.fit);
    if (!isFinite(S.scale) || S.scale <= 0) S.scale = 1;
    S.panX = 0;
    S.panY = 0;
  }

  function applyZoom(next, mx, my) {
    if (!S.doc) return;
    /* live 层是屏幕像素，缩放后必然错位，先把正在画的这一笔落定 */
    if (S.drawing) brushUp();
    if (S.arrowDrag) arrowUp();
    next = clamp(next, 0.02, 16);
    if (Math.abs(next - S.scale) < 1e-6) return;
    const k = next / S.scale;
    if (mx != null) {
      S.panX = mx - (mx - S.panX) * k;
      S.panY = my - (my - S.panY) * k;
    } else {
      S.panX *= k;
      S.panY *= k;
    }
    S.scale = next;
    clampPan();
    render();
  }

  function clampPan() {
    if (!S.doc) return;
    const { w, h } = docSize();
    const bw = D.wrap.clientWidth || 0;
    const bh = D.wrap.clientHeight || 0;
    const maxX = Math.max(0, (w * S.scale - bw) / 2);
    const maxY = Math.max(0, (h * S.scale - bh) / 2);
    S.panX = clamp(S.panX, -maxX, maxX);
    S.panY = clamp(S.panY, -maxY, maxY);
  }

  function scheduleRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  function render() {
    if (!S.doc || !S.pv) return;
    const crop = S.doc.crop;
    const dw = Math.max(1, Math.round(crop.w * S.scale));
    const dh = Math.max(1, Math.round(crop.h * S.scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    D.box.style.width = dw + 'px';
    D.box.style.height = dh + 'px';
    D.box.style.transform =
      'translate(-50%, -50%) translate(' + S.panX + 'px,' + S.panY + 'px)';

    const pw = Math.round(dw * dpr);
    const ph = Math.round(dh * dpr);
    if (D.cv.width !== pw || D.cv.height !== ph) {
      D.cv.width = pw;
      D.cv.height = ph;
      D.live.width = pw;
      D.live.height = ph;
    }

    const c = D.cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, dw, dh);

    /* 影调：先把预览算好（五项都没动就跳过，走原图，零开销） */
    ensureLook();
    const looked = !!S.lookCv;

    /* 底图：屏幕用预览源，放大到 100% 以上换原图保证清晰 */
    const sharp = looked && S.lookSharp && S.lookSharpKey === lookSig(S.doc.look) ? S.lookSharp : null;
    const useSrc = !looked && (S.pvScale === 1 || crop.w * S.scale > S.pvW * 0.98);
    const src = sharp || (looked ? S.lookCv : useSrc ? S.src : S.pv);
    const ps = sharp ? S.lookSharpScale : looked ? S.lookScale : useSrc ? 1 : S.pvScale;

    c.save();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(
      src,
      crop.x * ps, crop.y * ps, crop.w * ps, crop.h * ps,
      0, 0, dw, dh
    );
    c.restore();

    /* 标注层：切到视图坐标后绘制 */
    c.save();
    c.scale(S.scale, S.scale);
    drawStrokes(c, S.doc.strokes);
    drawTexts(c, S.doc.texts, true);
    c.restore();

    syncCropUI();
    D.zoomPct.textContent = Math.round(S.scale * 100) + '%';
    ensureSharpSoon();
  }

  function drawStrokes(c, strokes) {
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      if (s.kind === 'arrow') {
        drawArrow(c, s);
        continue;
      }
      const pts = s.pts;
      if (!pts || !pts.length) continue;
      c.strokeStyle = s.color;
      c.fillStyle = s.color;
      c.lineWidth = s.size;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      if (pts.length === 1) {
        c.beginPath();
        c.arc(pts[0].x, pts[0].y, Math.max(0.5, s.size / 2), 0, TAU);
        c.fill();
        continue;
      }
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) c.lineTo(pts[j].x, pts[j].y);
      c.stroke();
    }
  }

  /* 箭头：一条直杆 + 实心箭头（可双向）。和手绘同属视图坐标，导出时同一套代码 */
  function drawArrow(c, a) {
    const dx = a.x1 - a.x0;
    const dy = a.y1 - a.y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ang = Math.atan2(dy, dx);
    const lw = Math.max(1, a.size);
    /* 头部跟着线宽长，但留下限，细线时也看得清 */
    const hl = Math.max(lw * 3.1, 9);
    const hw = hl * 0.55;
    /* 杆在尖端前收住，免得线头从三角里穿出去 */
    const back = Math.min(hl * 0.86, len * 0.42);

    c.save();
    c.strokeStyle = a.color;
    c.fillStyle = a.color;
    c.lineWidth = lw;
    c.lineCap = 'round';
    c.lineJoin = 'round';

    c.beginPath();
    c.moveTo(a.x0, a.y0);
    c.lineTo(a.x1 - Math.cos(ang) * back, a.y1 - Math.sin(ang) * back);
    c.stroke();

    arrowHead(c, a.x1, a.y1, ang, hl, hw);
    if (a.both) arrowHead(c, a.x0, a.y0, ang + Math.PI, hl, hw);
    c.restore();
  }

  /* 尖端落在 (x,y)、朝 ang 方向；尾部轻微内凹，像标注箭头而不是三角形贴纸 */
  function arrowHead(c, x, y, ang, hl, hw) {
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const px = -sa;
    const py = ca;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x - ca * hl + px * hw, y - sa * hl + py * hw);
    c.lineTo(x - ca * hl * 0.84, y - sa * hl * 0.84);
    c.lineTo(x - ca * hl - px * hw, y - sa * hl - py * hw);
    c.closePath();
    c.fill();
  }

  function drawTexts(c, texts, withSel) {
    c.textBaseline = 'top';
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (!t.text) continue;
      c.font = t.size + 'px "' + t.font + '", "Microsoft YaHei", sans-serif';
      c.fillStyle = t.color;
      c.fillText(t.text, t.x, t.y);
      if (withSel && t.id === S.sel) {
        const w = c.measureText(t.text).width;
        const h = t.size * 1.24;
        const lw = 1 / S.scale;
        c.save();
        c.strokeStyle = '#cdb489';
        c.lineWidth = lw;
        c.setLineDash([4 * lw, 3 * lw]);
        c.strokeRect(t.x - 5 * lw, t.y - 4 * lw, w + 10 * lw, h + 8 * lw);
        c.restore();
      }
    }
  }

  /* ---------------------------------------------------------- 坐标换算 */

  function toView(e) {
    const r = D.cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / S.scale,
      y: (e.clientY - r.top) / S.scale,
    };
  }

  function textBox(t) {
    const c = D.cv.getContext('2d');
    c.font = t.size + 'px "' + t.font + '", "Microsoft YaHei", sans-serif';
    return { x: t.x, y: t.y, w: c.measureText(t.text).width, h: t.size * 1.24 };
  }

  function hitText(vp) {
    const list = S.doc.texts;
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if (!t.text) continue;
      const b = textBox(t);
      const pad = 6 / S.scale;
      if (vp.x >= b.x - pad && vp.x <= b.x + b.w + pad &&
          vp.y >= b.y - pad && vp.y <= b.y + b.h + pad) {
        return t;
      }
    }
    return null;
  }

  /* ---------------------------------------------------------- 工具切换 */

  function setTool(name) {
    S.tool = name;
    [...D.tools.querySelectorAll('.ed-tool')].forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === name);
    });
    D.crop.hidden = name !== 'crop';
    D.cv.style.cursor = name === 'brush' || name === 'arrow' ? 'crosshair'
      : name === 'text' ? 'text' : 'default';
    if (name !== 'crop') S.cropSel = null;
    if (name !== 'text') S.sel = null;
    buildSide();
    render();
  }

  /* ---------------------------------------------------------- 侧栏 */

  function swatchRow(active, id) {
    return SWATCHES.map((c) =>
      '<button data-sw="' + c + '" data-swfor="' + id + '" class="' + (c === active ? 'on' : '') +
      '" style="background:' + c + '" title="' + c + '"></button>'
    ).join('');
  }

  /* key 为空 = 五项全还原 */
  function resetLook(key) {
    if (!S.doc) return;
    if (key && LOOK_DEF[key] != null) {
      S.doc.look[key] = LOOK_DEF[key];
    } else {
      S.doc.look = { ...LOOK_DEF };
    }
    buildSide();
    render();
    pushHistory();
    const p = key ? LOOK_PARAMS.find((x) => x.k === key) : null;
    setStatus(p ? '影调 · ' + p.name + ' 已还原' : '影调五项已全部还原');
  }

  function buildSide() {
    if (!S.doc) return;
    const t = S.tool;
    let html = '';

    if (t === 'crop') {
      const a = S.aspect;
      const opt = (v, label) =>
        '<button data-a="' + v + '" class="' + (String(a) === String(v) ? 'on' : '') + '">' + label + '</button>';
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">裁剪比例</h4>' +
          '<div class="ed-seg" id="edAspect">' +
            opt('0', '自由') + opt('1', '1:1') + opt('1.333', '4:3') + opt('0.75', '3:4') +
            opt('1.778', '16:9') + opt('0.5625', '9:16') + opt('orig', '原图') +
          '</div>' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">裁剪区域</h4>' +
          '<div class="ed-row"><span>输出尺寸</span><span class="v" id="edCropSizeV">' +
            (S.cropSel ? Math.round(S.cropSel.w) + ' × ' + Math.round(S.cropSel.h) : '整幅') +
          '</span></div>' +
          '<div class="ed-grid2">' +
            '<button class="ed-line-btn" id="edCropAll">全选</button>' +
            '<button class="ed-line-btn" id="edCropApply">应用裁剪</button>' +
          '</div>' +
          '<p class="ed-tip">在画面上拖出要保留的区域，可用手柄微调；双击画面恢复整幅。</p>' +
        '</div>';
    } else if (t === 'light') {
      const l = S.doc.look;
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">影调</h4>' +
          LOOK_PARAMS.map((p) =>
            '<div class="ed-param">' +
              '<div class="ed-row">' +
                '<span title="' + p.hint + '">' + p.name + '</span>' +
                '<button class="ed-val" data-look-reset="' + p.k + '" title="点一下还原这个参数">' +
                  p.fmt(l[p.k]) + '</button>' +
              '</div>' +
              '<input class="ed-slider" type="range" data-look="' + p.k + '"' +
                ' min="' + p.min + '" max="' + p.max + '" step="' + p.step + '"' +
                ' value="' + l[p.k] + '" title="' + p.hint + '">' +
              '<div class="ed-range"><span>' + p.ends[0] + '</span><span>' + p.ends[1] + '</span></div>' +
            '</div>'
          ).join('') +
          '<div style="margin-top:14px"><button class="ed-line-btn" id="edLookReset">五项全部还原</button></div>' +
          '<p class="ed-tip">' +
            '叠加顺序：曝光 → 亮度 → 阴影 → 对比度 → 饱和度。<br>' +
            '曝光是线性增益，最容易吹高光；亮度只提中间调；阴影只动暗部；' +
            '对比度围绕中灰缩放明暗差；饱和度 0% 即黑白。' +
            '点右侧数值可单独还原。<br>' +
            '影调只作用于照片，手绘与文字的颜色不受影响。' +
          '</p>' +
        '</div>';
    } else if (t === 'brush') {
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">颜色</h4>' +
          '<div class="ed-swatches" id="edBrushColors">' + swatchRow(S.brush.color, 'brush') + '</div>' +
          '<div class="ed-color" style="margin-top:10px">' +
            '<input type="color" id="edBrushPick" value="' + S.brush.color + '">' +
            '<span id="edBrushHex">' + S.brush.color + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">粗细</h4>' +
          '<div class="ed-row"><span>线宽</span><span class="v" id="edBrushSizeV">' + S.brush.size + ' px</span></div>' +
          '<input class="ed-slider" id="edBrushSize" type="range" min="1" max="60" step="1" value="' + S.brush.size + '">' +
          '<p class="ed-tip">按住左键绘制；右键或空格拖动平移画面，不影响已画内容。</p>' +
        '</div>';
    } else if (t === 'arrow') {
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">箭头样式</h4>' +
          '<div class="ed-seg" id="edArrowStyle">' +
            '<button data-ar="0" class="' + (S.arrow.both ? '' : 'on') + '">单向</button>' +
            '<button data-ar="1" class="' + (S.arrow.both ? 'on' : '') + '">双向</button>' +
          '</div>' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">颜色</h4>' +
          '<div class="ed-swatches" id="edArrowColors">' + swatchRow(S.arrow.color, 'arrow') + '</div>' +
          '<div class="ed-color" style="margin-top:10px">' +
            '<input type="color" id="edArrowPick" value="' + S.arrow.color + '">' +
            '<span id="edArrowHex">' + S.arrow.color + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">粗细</h4>' +
          '<div class="ed-row"><span>线宽</span><span class="v" id="edArrowSizeV">' + S.arrow.size + ' px</span></div>' +
          '<input class="ed-slider" id="edArrowSize" type="range" min="1" max="40" step="1" value="' + S.arrow.size + '">' +
          '<p class="ed-tip">在画面上拖出箭头，起点到终点就是方向和长度；按住 Shift 吸附 0°/45°/90°，右键或空格拖动可平移画面。</p>' +
        '</div>';
    } else {
      const cur = S.sel ? S.doc.texts.find((x) => x.id === S.sel) : null;
      const t2 = cur
        ? { font: cur.font, size: cur.size, color: cur.color }
        : S.txt;
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">文字内容</h4>' +
          '<textarea class="ed-textarea" id="edTextContent" placeholder="' +
            (cur ? '' : '先在画面上点一下，定位文字') + '">' + (cur ? escapeText(cur.text) : '') + '</textarea>' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">字体</h4>' +
          '<select class="ed-select" id="edTextFont">' +
            FONTS.map((f) => '<option value="' + f[0] + '"' + (f[0] === t2.font ? ' selected' : '') + '>' + f[1] + '</option>').join('') +
          '</select>' +
          '<div class="ed-row" style="margin-top:12px"><span>字号</span><span class="v" id="edTextSizeV">' + t2.size + ' px</span></div>' +
          '<input class="ed-slider" id="edTextSize" type="range" min="10" max="400" step="1" value="' + t2.size + '">' +
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">颜色</h4>' +
          '<div class="ed-swatches" id="edTextColors">' + swatchRow(t2.color, 'text') + '</div>' +
          '<div class="ed-color" style="margin-top:10px">' +
            '<input type="color" id="edTextPick" value="' + t2.color + '">' +
            '<span id="edTextHex">' + t2.color + '</span>' +
          '</div>' +
        '</div>' +
        (cur
          ? '<div class="ed-sec"><button class="ed-line-btn warn" id="edTextDel">删除这段文字</button></div>'
          : '<div class="ed-sec"><p class="ed-tip">在画面上单击添加文字，拖动可移动位置；选中后按 Delete 删除。</p></div>');
    }

    D.side.innerHTML = html;
  }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function currentText() {
    if (!S.sel) return null;
    return S.doc.texts.find((x) => x.id === S.sel) || null;
  }

  /* ---------------------------------------------------------- 裁剪 */

  function syncCropUI() {
    if (S.tool !== 'crop' || !S.cropSel) {
      D.cropBox.hidden = true;
      D.cropTag.hidden = true;
      const v = document.getElementById('edCropSizeV');
      if (v) v.textContent = S.cropSel ? Math.round(S.cropSel.w) + ' × ' + Math.round(S.cropSel.h) : '整幅';
      return;
    }
    const r = S.cropSel;
    const k = S.scale;
    D.cropBox.hidden = false;
    D.cropBox.style.left = r.x * k + 'px';
    D.cropBox.style.top = r.y * k + 'px';
    D.cropBox.style.width = Math.max(1, r.w * k) + 'px';
    D.cropBox.style.height = Math.max(1, r.h * k) + 'px';

    D.cropTag.hidden = false;
    D.cropTag.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
    const bh = docSize().h * k;
    const below = (r.y + r.h) * k + 8;
    if (below + 22 < bh) {
      D.cropTag.style.top = below + 'px';
    } else {
      D.cropTag.style.top = Math.max(4, r.y * k - 26) + 'px';
    }
    D.cropTag.style.left = r.x * k + 'px';

    const v = document.getElementById('edCropSizeV');
    if (v) v.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
  }

  function normRect(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  /* 收进画面内：先按比例缩放尺寸，再挪回边界 */
  function clampRect(r, dsz, aspect) {
    if (!isFinite(r.w) || !isFinite(r.h) || r.w <= 0 || r.h <= 0) {
      return { x: clamp(r.x, 0, 0), y: clamp(r.y, 0, 0), w: 0, h: 0 };
    }
    const k = Math.min(1, dsz.w / r.w, dsz.h / r.h);
    if (k < 1) {
      r.w *= k;
      r.h *= k;
    }
    r.x = clamp(r.x, 0, Math.max(0, dsz.w - r.w));
    r.y = clamp(r.y, 0, Math.max(0, dsz.h - r.h));
    return r;
  }

  /* 按比例约束拖动：锚点固定，取变化更大的方向定尺寸 */
  function aspectRect(ax, ay, px, py, aspect) {
    let w = px - ax;
    let h = py - ay;
    if (aspect > 0) {
      if (Math.abs(w) / aspect >= Math.abs(h)) {
        h = (w < 0 ? -1 : 1) * Math.abs(w) / aspect;
      } else {
        w = (h < 0 ? -1 : 1) * Math.abs(h) * aspect;
      }
    }
    return normRect(ax, ay, ax + w, ay + h);
  }

  function onCropDown(e) {
    if (!S.doc || e.button !== 0 || S.space) return;
    /* 刚打开的那一下可能是切进来的残留指针事件，先忽略，免得凭空冒出一个框 */
    if (Date.now() < S.readyAt) return;
    const dsz = docSize();
    const handle = e.target.dataset ? e.target.dataset.h : null;
    const vp = toView(e);

    if (handle && S.cropSel) {
      const r = S.cropSel;
      /* 锚点取「对角的那个角」：拖右边就钉住左边，拖左边就钉住右边 */
      let ax = r.x, ay = r.y;
      if (handle.includes('w')) ax = r.x + r.w;
      if (handle.includes('e')) ax = r.x;
      if (handle.includes('n')) ay = r.y + r.h;
      if (handle.includes('s')) ay = r.y;
      /* 只拖上下边时，横向继续以中线为轴，反之亦然 */
      if (handle === 'n' || handle === 's') ax = r.x + r.w / 2;
      if (handle === 'w' || handle === 'e') ay = r.y + r.h / 2;
      S.cropDrag = {
        mode: 'resize',
        handle,
        anchorX: ax,
        anchorY: ay,
        aspect: S.aspect,
        r0: { ...r },
      };
      e.preventDefault();
      return;
    }

    if (S.cropSel && e.target === D.cropBox) {
      S.cropDrag = {
        mode: 'move',
        ox: vp.x - S.cropSel.x,
        oy: vp.y - S.cropSel.y,
        aspect: S.aspect,
        r0: { ...S.cropSel },
      };
      e.preventDefault();
      return;
    }

    /* 空白处按下：重新拉一个框 */
    const ax = clamp(vp.x, 0, dsz.w);
    const ay = clamp(vp.y, 0, dsz.h);
    S.cropDrag = { mode: 'new', ax, ay, aspect: S.aspect };
    S.cropSel = { x: ax, y: ay, w: 0, h: 0 };
    syncCropUI();
    e.preventDefault();
  }

  function onCropMove(e) {
    const g = S.cropDrag;
    if (!g) return;
    const dsz = docSize();
    const vp = toView(e);

    if (g.mode === 'new') {
      const px = clamp(vp.x, 0, dsz.w);
      const py = clamp(vp.y, 0, dsz.h);
      S.cropSel = clampRect(aspectRect(g.ax, g.ay, px, py, g.aspect), dsz, g.aspect);
    } else if (g.mode === 'resize') {
      const px = clamp(vp.x, 0, dsz.w);
      const py = clamp(vp.y, 0, dsz.h);
      let r;
      if (g.aspect > 0) {
        r = aspectRect(g.anchorX, g.anchorY, px, py, g.aspect);
        if (g.handle === 'n' || g.handle === 's') r.x = g.anchorX - r.w / 2;
        if (g.handle === 'w' || g.handle === 'e') r.y = g.anchorY - r.h / 2;
      } else {
        /* 自由比例：只动被拖的那条边，其余边保持不动 */
        const o = g.r0;
        r = { x: o.x, y: o.y, w: o.w, h: o.h };
        if (g.handle.indexOf('e') >= 0) r.w = px - o.x;
        if (g.handle.indexOf('w') >= 0) { r.x = px; r.w = o.x + o.w - px; }
        if (g.handle.indexOf('s') >= 0) r.h = py - o.y;
        if (g.handle.indexOf('n') >= 0) { r.y = py; r.h = o.y + o.h - py; }
        if (r.w < 0) { r.x += r.w; r.w = -r.w; }
        if (r.h < 0) { r.y += r.h; r.h = -r.h; }
      }
      r.x = clamp(r.x, 0, dsz.w);
      r.y = clamp(r.y, 0, dsz.h);
      r.w = Math.min(r.w, dsz.w - r.x);
      r.h = Math.min(r.h, dsz.h - r.y);
      S.cropSel = clampRect(r, dsz, g.aspect);
    } else if (g.mode === 'move') {
      const r0 = g.r0;
      let nx = clamp(vp.x - g.ox, 0, dsz.w - r0.w);
      let ny = clamp(vp.y - g.oy, 0, dsz.h - r0.h);
      S.cropSel = { x: nx, y: ny, w: r0.w, h: r0.h };
    }
    syncCropUI();
  }

  function onCropUp() {
    if (!S.cropDrag) return;
    S.cropDrag = null;
    if (S.cropSel && (S.cropSel.w < 6 || S.cropSel.h < 6)) S.cropSel = null;
    syncCropUI();
  }

  function applyCrop() {
    const s = S.cropSel;
    if (!s || s.w < 8 || s.h < 8) {
      toast('先拖出要保留的区域');
      return;
    }
    const crop = S.doc.crop;
    const nx = Math.round(s.x);
    const ny = Math.round(s.y);
    const nw = Math.max(1, Math.round(s.w));
    const nh = Math.max(1, Math.round(s.h));
    if (nx === 0 && ny === 0 && nw === crop.w && nh === crop.h) {
      toast('选区就是整幅，无需裁剪');
      return;
    }

    S.doc.crop = { x: crop.x + nx, y: crop.y + ny, w: nw, h: nh };
    S.doc.strokes.forEach((st) => {
      st.pts.forEach((p) => { p.x -= nx; p.y -= ny; });
    });
    S.doc.texts.forEach((t) => { t.x -= nx; t.y -= ny; });

    S.cropSel = null;
    S.sel = null;
    fitNow();
    updateDim();
    render();
    buildSide();
    pushHistory();
    setStatus('已裁剪为 ' + nw + ' × ' + nh);
  }

  /* ---------------------------------------------------------- 画笔 */

  function brushDown(e) {
    const vp = toView(e);
    S.drawing = {
      color: S.brush.color,
      size: S.brush.size,
      pts: [{ x: vp.x, y: vp.y }],
    };
    liveReset();
    liveDot(vp.x, vp.y, S.brush.size, S.brush.color);
    liveSegment(vp.x, vp.y, vp.x + 0.01, vp.y, S.brush.size, S.brush.color);
  }

  function brushMove(e) {
    const g = S.drawing;
    if (!g) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const list = evs && evs.length ? evs : [e];
    for (let i = 0; i < list.length; i++) {
      const vp = toView(list[i]);
      const last = g.pts[g.pts.length - 1];
      const dx = vp.x - last.x;
      const dy = vp.y - last.y;
      if (dx * dx + dy * dy < 0.5) continue;
      g.pts.push({ x: vp.x, y: vp.y });
      liveSegment(last.x, last.y, vp.x, vp.y, g.size, g.color);
    }
  }

  function brushUp() {
    const g = S.drawing;
    S.drawing = null;
    if (!g) return;
    if (g.pts.length < 1) return;
    S.doc.strokes.push(g);
    liveReset();
    render();
    pushHistory();
  }

  function liveCtx() {
    const c = D.live.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.scale(S.scale, S.scale);
    c.lineCap = 'round';
    c.lineJoin = 'round';
    return c;
  }

  function liveReset() {
    const c = D.live.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, D.live.width, D.live.height);
  }

  function liveDot(x, y, size, color) {
    const c = liveCtx();
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, Math.max(0.5, size / 2), 0, TAU);
    c.fill();
  }

  function liveSegment(x0, y0, x1, y1, size, color) {
    const c = liveCtx();
    c.strokeStyle = color;
    c.lineWidth = size;
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }

  /* ---------------------------------------------------------- 箭头 */

  function arrowDown(e) {
    const vp = toView(e);
    S.arrowDrag = {
      kind: 'arrow',
      x0: vp.x,
      y0: vp.y,
      x1: vp.x,
      y1: vp.y,
      color: S.arrow.color,
      size: S.arrow.size,
      both: S.arrow.both,
    };
    liveReset();
  }

  function arrowMove(e) {
    const g = S.arrowDrag;
    if (!g) return;
    const vp = toView(e);
    let x = vp.x;
    let y = vp.y;
    /* 按住 Shift 吸附到 0/45/90 度，画水平或垂直标注时不会画歪 */
    if (e.shiftKey) {
      const dx = x - g.x0;
      const dy = y - g.y0;
      const len = Math.hypot(dx, dy);
      const step = Math.PI / 4;
      const snap = Math.round(Math.atan2(dy, dx) / step) * step;
      x = g.x0 + Math.cos(snap) * len;
      y = g.y0 + Math.sin(snap) * len;
    }
    g.x1 = x;
    g.y1 = y;
    liveReset();
    drawArrow(liveCtx(), g);
  }

  function arrowUp() {
    const g = S.arrowDrag;
    S.arrowDrag = null;
    liveReset();
    if (!g) return;
    /* 太短的当误触丢掉 */
    if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < 6) {
      render();
      return;
    }
    S.doc.strokes.push(g);
    render();
    pushHistory();
    setStatus('已加一条箭头');
  }

  /* ---------------------------------------------------------- 文字 */

  function addText(vp) {
    const t = {
      id: uid(),
      text: '双击改字',
      x: vp.x,
      y: vp.y,
      size: S.txt.size,
      color: S.txt.color,
      font: S.txt.font,
    };
    S.doc.texts.push(t);
    S.sel = t.id;
    render();
    buildSide();
    /* 点击画布会让焦点落回 body，等这一轮事件走完再把光标交给输入框 */
    setTimeout(() => {
      const ta = document.getElementById('edTextContent');
      if (ta) {
        ta.focus();
        ta.select();
      }
    }, 0);
    pushHistory();
  }

  /* ---------------------------------------------------------- 指针总入口 */

  function onDown(e) {
    if (!S.doc) return;
    if (e.button === 1 || e.button === 2 || S.space) {
      startPan(e);
      return;
    }
    if (e.button !== 0) return;

    const vp = toView(e);

    if (S.tool === 'brush') {
      brushDown(e);
      D.cv.setPointerCapture(e.pointerId);
      return;
    }

    if (S.tool === 'arrow') {
      arrowDown(e);
      D.cv.setPointerCapture(e.pointerId);
      return;
    }

    if (S.tool === 'text') {
      const hit = hitText(vp);
      if (hit) {
        S.sel = hit.id;
        S.textDrag = { id: hit.id, dx: vp.x - hit.x, dy: vp.y - hit.y, moved: false };
        render();
        buildSide();
        D.cv.setPointerCapture(e.pointerId);
      } else {
        addText(vp);
      }
      return;
    }
  }

  function onMove(e) {
    if (S.panning) {
      S.panX = S.panning.sx + (e.clientX - S.panning.cx);
      S.panY = S.panning.sy + (e.clientY - S.panning.cy);
      clampPan();
      render();
      return;
    }
    if (S.drawing) {
      brushMove(e);
      return;
    }
    if (S.arrowDrag) {
      arrowMove(e);
      return;
    }
    if (S.textDrag) {
      const t = S.doc.texts.find((x) => x.id === S.textDrag.id);
      if (!t) return;
      const vp = toView(e);
      t.x = vp.x - S.textDrag.dx;
      t.y = vp.y - S.textDrag.dy;
      S.textDrag.moved = true;
      render();
    }
  }

  function onUp(e) {
    if (S.panning) {
      S.panning = null;
      D.wrap.classList.remove('panning');
      return;
    }
    if (S.drawing) {
      brushUp();
      if (e && D.cv.hasPointerCapture && D.cv.hasPointerCapture(e.pointerId)) {
        D.cv.releasePointerCapture(e.pointerId);
      }
      return;
    }
    if (S.arrowDrag) {
      arrowUp();
      if (e && D.cv.hasPointerCapture && D.cv.hasPointerCapture(e.pointerId)) {
        D.cv.releasePointerCapture(e.pointerId);
      }
      return;
    }
    if (S.textDrag) {
      if (S.textDrag.moved) pushHistory();
      S.textDrag = null;
      if (e && D.cv.hasPointerCapture && D.cv.hasPointerCapture(e.pointerId)) {
        D.cv.releasePointerCapture(e.pointerId);
      }
    }
  }

  function startPan(e) {
    S.panning = { cx: e.clientX, cy: e.clientY, sx: S.panX, sy: S.panY };
    D.wrap.classList.add('panning');
    if (e.button === 2) e.preventDefault();
  }

  function onWheel(e) {
    if (!S.doc) return;
    e.preventDefault();
    const r = D.wrap.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2;
    const my = e.clientY - r.top - r.height / 2;
    const f = Math.exp(-e.deltaY * 0.0016);
    applyZoom(S.scale * f, mx, my);
  }

  /* ---------------------------------------------------------- 侧栏交互 */

  function onSideClick(e) {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.dataset.lookReset) {
      resetLook(btn.dataset.lookReset);
      return;
    }

    if (btn.dataset.sw) {
      const v = btn.dataset.sw;
      const swfor = btn.dataset.swfor;
      if (swfor === 'brush' || swfor === 'arrow') {
        const tgt = swfor === 'brush' ? S.brush : S.arrow;
        tgt.color = v;
        const p = document.getElementById(swfor === 'brush' ? 'edBrushPick' : 'edArrowPick');
        if (p) p.value = v;
        const h = document.getElementById(swfor === 'brush' ? 'edBrushHex' : 'edArrowHex');
        if (h) h.textContent = v;
        syncSwatch(swfor, v);
      } else {
        S.txt.color = v;
        const cur = currentText();
        if (cur) {
          cur.color = v;
          render();
          pushHistory();
        }
        const p = document.getElementById('edTextPick');
        if (p) p.value = v;
        const h = document.getElementById('edTextHex');
        if (h) h.textContent = v;
        syncSwatch('text', v);
      }
      return;
    }

    if (btn.dataset.ar != null && btn.closest('#edArrowStyle')) {
      S.arrow.both = btn.dataset.ar === '1';
      [...D.side.querySelectorAll('#edArrowStyle button')].forEach((b) => {
        b.classList.toggle('on', b === btn);
      });
      return;
    }

    if (btn.dataset.a) {
      const v = btn.dataset.a;
      if (v === 'orig') {
        S.aspect = S.W / S.H;
      } else {
        S.aspect = parseFloat(v);
      }
      [...D.side.querySelectorAll('#edAspect button')].forEach((b) => {
        b.classList.toggle('on', b === btn);
      });
      if (S.cropSel && S.aspect > 0) {
        const r = S.cropSel;
        const nw = Math.min(r.w, r.h * S.aspect);
        const nh = nw / S.aspect;
        S.cropSel = {
          x: clamp(r.x, 0, docSize().w - nw),
          y: clamp(r.y, 0, docSize().h - nh),
          w: nw,
          h: nh,
        };
        syncCropUI();
      }
      return;
    }

    switch (btn.id) {
      case 'edCropAll':
        S.cropSel = { x: 0, y: 0, w: S.doc.crop.w, h: S.doc.crop.h };
        S.aspect = 0;
        [...D.side.querySelectorAll('#edAspect button')].forEach((b) => {
          b.classList.toggle('on', b.dataset.a === '0');
        });
        syncCropUI();
        break;
      case 'edCropApply':
        applyCrop();
        break;
      case 'edLookReset':
        resetLook(null);
        break;
      case 'edTextDel':
        if (S.sel) {
          S.doc.texts = S.doc.texts.filter((t) => t.id !== S.sel);
          S.sel = null;
          render();
          buildSide();
          pushHistory();
        }
        break;
      default:
        break;
    }
  }

  function syncSwatch(kind, color) {
    const ids = { brush: 'edBrushColors', text: 'edTextColors', arrow: 'edArrowColors' };
    const box = document.getElementById(ids[kind] || ids.text);
    if (!box) return;
    [...box.querySelectorAll('button')].forEach((b) => {
      b.classList.toggle('on', b.dataset.sw.toLowerCase() === String(color).toLowerCase());
    });
  }

  function onSideInput(e) {
    const id = e.target.id;

    /* 影调五项：同一个处理器，靠 data-look 区分 */
    const lk = e.target.dataset ? e.target.dataset.look : null;
    if (lk) {
      const p = LOOK_PARAMS.find((x) => x.k === lk);
      const v = parseFloat(e.target.value);
      if (!p || !isFinite(v)) return;
      S.doc.look[lk] = v;
      const val = D.side.querySelector('[data-look-reset="' + lk + '"]');
      if (val) val.textContent = p.fmt(v);
      scheduleRender();
      return;
    }

    if (id === 'edBrushSize') {
      S.brush.size = parseInt(e.target.value, 10);
      const lb = document.getElementById('edBrushSizeV');
      if (lb) lb.textContent = S.brush.size + ' px';
      return;
    }

    if (id === 'edArrowSize') {
      S.arrow.size = parseInt(e.target.value, 10);
      const lb = document.getElementById('edArrowSizeV');
      if (lb) lb.textContent = S.arrow.size + ' px';
      return;
    }

    if (id === 'edArrowPick') {
      S.arrow.color = e.target.value;
      const h = document.getElementById('edArrowHex');
      if (h) h.textContent = e.target.value;
      syncSwatch('arrow', e.target.value);
      return;
    }

    if (id === 'edTextContent') {
      const cur = currentText();
      if (!cur) return;
      cur.text = e.target.value;
      scheduleRender();
      return;
    }

    if (id === 'edTextSize') {
      const v = parseInt(e.target.value, 10);
      S.txt.size = v;
      const lb = document.getElementById('edTextSizeV');
      if (lb) lb.textContent = v + ' px';
      const cur = currentText();
      if (cur) {
        cur.size = v;
        scheduleRender();
      }
      return;
    }

    if (id === 'edBrushPick') {
      S.brush.color = e.target.value;
      const h = document.getElementById('edBrushHex');
      if (h) h.textContent = e.target.value;
      syncSwatch('brush', e.target.value);
      return;
    }

    if (id === 'edTextPick') {
      S.txt.color = e.target.value;
      const h = document.getElementById('edTextHex');
      if (h) h.textContent = e.target.value;
      syncSwatch('text', e.target.value);
      const cur = currentText();
      if (cur) {
        cur.color = e.target.value;
        scheduleRender();
      }
    }
  }

  function onSideChange(e) {
    const id = e.target.id;
    const lk = e.target.dataset ? e.target.dataset.look : null;
    if (lk) {
      const p = LOOK_PARAMS.find((x) => x.k === lk);
      pushHistory();
      if (p) setStatus(p.name + ' ' + p.fmt(S.doc.look[lk]));
    } else if (id === 'edTextContent') {
      const cur = currentText();
      if (cur && !cur.text.trim()) {
        S.doc.texts = S.doc.texts.filter((t) => t.id !== cur.id);
        S.sel = null;
        render();
        buildSide();
      }
      pushHistory();
    } else if (id === 'edTextSize') {
      pushHistory();
    } else if (id === 'edTextFont') {
      S.txt.font = e.target.value;
      const cur = currentText();
      if (cur) {
        cur.font = e.target.value;
        render();
        pushHistory();
      }
    }
  }

  /* ---------------------------------------------------------- 保存 */

  function openSave() {
    if (!S.doc) return;
    const item = S.item;
    const base = String(item.name).replace(/\.[^.]+$/, '');
    const ext = (item.ext || 'jpg').toLowerCase();
    const keepPng = ext === 'png' || ext === 'webp';
    const fmt = keepPng ? 'png' : 'jpg';
    D.saveName.value = base + '_编辑';
    D.saveFmt.value = fmt;
    D.overwrite.checked = false;
    D.savePanel.hidden = false;
    syncFmtLock();
    refreshSaveInfo();
    setTimeout(() => {
      D.saveName.focus();
      D.saveName.select();
    }, 30);
  }

  function closeSave() {
    D.savePanel.hidden = true;
  }

  /* 覆盖原文件时格式必须保持不变，避免把 .png 写成 jpg */
  function syncFmtLock() {
    if (!S.item) return;
    const over = D.overwrite.checked;
    const ext = String(S.item.ext || 'jpg').toLowerCase();
    D.saveFmt.disabled = over;
    if (over) {
      D.saveFmt.value = ext === 'png' ? 'png' : 'jpg';
      D.qualityRow.hidden = D.saveFmt.value !== 'jpg';
    }
  }

  function refreshSaveInfo() {
    const fmt = D.saveFmt.value;
    D.qualityRow.hidden = fmt !== 'jpg';
    const { w, h } = docSize();
    const name = (D.saveName.value.trim() || '未命名') + '.' + fmt;
    const dir = dirOf(S.item.path);
    const target = D.overwrite.checked ? S.item.path : joinPath(dir, name);
    D.saveInfo.textContent =
      '尺寸 ' + w + ' × ' + h + ' px\n' +
      '保存到 ' + target;
  }

  function dirOf(p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    return i > 0 ? s.slice(0, i) : s;
  }

  function joinPath(dir, name) {
    const sep = dir.includes('\\') ? '\\' : '/';
    return dir.replace(/[\\/]+$/, '') + sep + name;
  }

  function exportCanvas() {
    const { w, h } = docSize();
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d', { willReadFrequently: true });

    c.save();
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.drawImage(S.src, S.doc.crop.x, S.doc.crop.y, w, h, 0, 0, w, h);
    c.restore();

    /* 影调落到原图上，和屏幕预览同一套公式（手绘和文字在之后画，不受影响） */
    if (!lookNeutral(S.doc.look)) {
      const img = c.getImageData(0, 0, w, h);
      applyLookData(img.data, S.doc.look);
      c.putImageData(img, 0, 0);
    }

    drawStrokes(c, S.doc.strokes);
    drawTexts(c, S.doc.texts, false);
    return cv;
  }

  async function doSave() {
    if (S.saving) return;
    const fmt = D.saveFmt.value;
    const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    const q = parseInt(D.quality.value, 10) / 100;
    const over = D.overwrite.checked;

    const dir = dirOf(S.item.path);
    let target;
    if (over) {
      const ext = (S.item.ext || 'jpg').toLowerCase();
      const want = fmt === 'jpg' ? ['jpg', 'jpeg'] : ['png'];
      if (want.indexOf(ext) < 0) {
        toast('覆盖原文件时必须保持原格式（.' + ext + '）');
        return;
      }
      target = S.item.path;
    } else {
      const name = (D.saveName.value.trim() || '未命名') + '.' + fmt;
      if (!name || /[\\/:*?"<>|]/.test(name)) {
        toast('文件名里有不能用的字符');
        return;
      }
      target = joinPath(dir, name);
    }

    S.saving = true;
    D.saveGo.disabled = true;
    D.saveGo.textContent = '保存中…';
    try {
      const cv = exportCanvas();
      const blob = await new Promise((res) => cv.toBlob(res, mime, q));
      if (!blob) throw new Error('导出失败');

      const r = await fetch(
        '/api/save?path=' + encodeURIComponent(target) + '&over=' + (over ? 1 : 0),
        { method: 'POST', headers: { 'Content-Type': mime }, body: blob }
      );
      const d = await r.json().catch(() => ({ ok: false }));
      if (!d.ok) throw new Error(d.error || '写入失败');

      toast(over ? '已覆盖原文件' : '已保存 ' + d.name);
      closeSave();
      closeEditor(true);
      if (typeof onEditorSaved === 'function') onEditorSaved(d.path, over);
    } catch (err) {
      toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
    } finally {
      S.saving = false;
      D.saveGo.disabled = false;
      D.saveGo.textContent = '保存';
    }
  }

  /* ---------------------------------------------------------- 状态 */

  function setStatus(msg) {
    D.status.textContent = msg;
  }

  function updateDim() {
    if (!S.doc) return;
    const c = S.doc.crop;
    D.dim.textContent = c.w + ' × ' + c.h;
    D.dim.title = (c.w === S.W && c.h === S.H) ? '' : '原图 ' + S.W + ' × ' + S.H;
  }

  /* ---------------------------------------------------------- 键盘 */

  function onKey(e) {
    if (!S.open) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

    /* 编辑态下截住所有按键，不让查看器的快捷键穿透 */
    e.stopPropagation();

    if (e.key === 'Escape') {
      e.preventDefault();
      if (!D.savePanel.hidden) return closeSave();
      if (typing) {
        e.target.blur();
        return;
      }
      if (S.sel) {
        S.sel = null;
        render();
        buildSide();
        return;
      }
      if (S.cropSel) {
        S.cropSel = null;
        syncCropUI();
        return;
      }
      return closeEditor(false);
    }

    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      return e.shiftKey ? redo() : undo();
    }
    if (mod && e.key.toLowerCase() === 'y') {
      if (typing) return;
      e.preventDefault();
      return redo();
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      return openSave();
    }

    if (typing) return;

    if (e.key === ' ') {
      S.space = true;
      D.wrap.classList.add('panning');
      e.preventDefault();
      return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
      const cur = currentText();
      if (cur) {
        e.preventDefault();
        S.doc.texts = S.doc.texts.filter((t) => t.id !== cur.id);
        S.sel = null;
        render();
        buildSide();
        pushHistory();
      }
      return;
    }

    const k = e.key.toLowerCase();
    if (k === 'c') return setTool('crop');
    if (k === 'l') return setTool('light');
    if (k === 'b') return setTool('brush');
    if (k === 'a') return setTool('arrow');
    if (k === 'v') return setTool('text');
    if (k === '0') {
      fitNow();
      return render();
    }
    if (k === '1') return applyZoom(1);
    if (e.key === '[' || e.key === ']') {
      const up = e.key === ']';
      if (S.tool === 'arrow') {
        S.arrow.size = clamp(S.arrow.size + (up ? 1 : -1), 1, 40);
      } else if (S.tool === 'brush') {
        S.brush.size = clamp(S.brush.size + (up ? 2 : -2), 1, 60);
      } else {
        return;
      }
      buildSide();
      return;
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') {
      S.space = false;
      if (!S.panning) D.wrap.classList.remove('panning');
    }
  }

  /* ---------------------------------------------------------- 初始化 */

  function init() {
    D.root = document.getElementById('editor');
    if (!D.root) return;

    D.wrap = document.getElementById('edWrap');
    D.box = document.getElementById('edBox');
    D.cv = document.getElementById('edCanvas');
    D.live = document.getElementById('edLive');
    D.crop = document.getElementById('edCrop');
    D.cropBox = document.getElementById('edCropBox');
    D.cropTag = document.getElementById('edCropTag');
    D.side = document.getElementById('edSide');
    D.tools = document.getElementById('edTools');
    D.name = document.getElementById('edName');
    D.dim = document.getElementById('edDim');
    D.status = document.getElementById('edStatus');
    D.undo = document.getElementById('edUndo');
    D.redo = document.getElementById('edRedo');
    D.zoomPct = document.getElementById('edZoomPct');
    D.savePanel = document.getElementById('edSavePanel');
    D.saveName = document.getElementById('edSaveName');
    D.saveFmt = document.getElementById('edSaveFmt');
    D.quality = document.getElementById('edQuality');
    D.qualityRow = document.getElementById('edQualityRow');
    D.qualityVal = document.getElementById('edQualityVal');
    D.overwrite = document.getElementById('edOverwrite');
    D.saveInfo = document.getElementById('edSaveInfo');
    D.saveGo = document.getElementById('edSaveGo');

    document.getElementById('edBack').onclick = () => closeEditor(false);
    D.undo.onclick = undo;
    D.redo.onclick = redo;
    document.getElementById('edReset').onclick = () => {
      if (!S.doc) return;
      if (!window.confirm('清除这次的全部编辑，回到原始图片？')) return;
      S.doc = {
        crop: { x: 0, y: 0, w: S.W, h: S.H },
        look: { ...LOOK_DEF },
        strokes: [],
        texts: [],
      };
      S.sel = null;
      S.cropSel = null;
      S.aspect = 0;
      fitNow();
      updateDim();
      render();
      buildSide();
      pushHistory();
      setStatus('已还原到原始图片');
    };
    document.getElementById('edSave').onclick = openSave;

    D.tools.addEventListener('click', (e) => {
      const b = e.target.closest('.ed-tool');
      if (b) setTool(b.dataset.tool);
    });

    D.side.addEventListener('click', onSideClick);
    D.side.addEventListener('input', onSideInput);
    D.side.addEventListener('change', onSideChange);

    D.zoomPct.onclick = () => applyZoom(1);
    document.getElementById('edZoomIn').onclick = () => applyZoom(S.scale * 1.25);
    document.getElementById('edZoomOut').onclick = () => applyZoom(S.scale * 0.8);
    document.getElementById('edZoomFit').onclick = () => {
      fitNow();
      render();
    };
    document.getElementById('edZoomOne').onclick = () => applyZoom(1);

    D.cv.addEventListener('pointerdown', (e) => {
      if (S.tool === 'crop') return;
      onDown(e);
    });
    D.cv.addEventListener('pointermove', onMove);
    D.cv.addEventListener('pointerup', onUp);
    D.cv.addEventListener('pointercancel', onUp);
    D.cv.addEventListener('contextmenu', (e) => e.preventDefault());
    D.cv.addEventListener('dblclick', () => {
      if (S.tool === 'crop') {
        S.cropSel = null;
        syncCropUI();
      } else if (S.tool === 'text') {
        const cur = currentText();
        if (cur) {
          const ta = document.getElementById('edTextContent');
          if (ta) { ta.focus(); ta.select(); }
        }
      }
    });

    D.crop.addEventListener('pointerdown', onCropDown);
    D.crop.addEventListener('pointermove', (e) => {
      if (S.cropDrag) {
        onCropMove(e);
        /* 拖到画面外也要跟得住 */
        if (D.crop.hasPointerCapture && !D.crop.hasPointerCapture(e.pointerId)) {
          D.crop.setPointerCapture(e.pointerId);
        }
      }
    });
    D.crop.addEventListener('pointerup', onCropUp);
    D.crop.addEventListener('pointercancel', onCropUp);
    D.crop.addEventListener('contextmenu', (e) => e.preventDefault());

    D.wrap.addEventListener('wheel', onWheel, { passive: false });
    D.wrap.addEventListener('pointerdown', (e) => {
      if (S.tool === 'crop') return;
      if (e.button === 1 || e.button === 2) {
        onDown(e);
        D.wrap.setPointerCapture(e.pointerId);
      }
    });
    D.wrap.addEventListener('pointermove', (e) => {
      if (S.panning) onMove(e);
    });
    D.wrap.addEventListener('pointerup', onUp);
    D.wrap.addEventListener('contextmenu', (e) => e.preventDefault());

    D.saveFmt.onchange = () => {
      D.qualityRow.hidden = D.saveFmt.value !== 'jpg';
      refreshSaveInfo();
    };
    D.saveName.oninput = refreshSaveInfo;
    D.overwrite.onchange = () => {
      syncFmtLock();
      refreshSaveInfo();
    };
    D.quality.oninput = () => {
      D.qualityVal.textContent = D.quality.value;
    };
    document.getElementById('edSaveCancel').onclick = closeSave;
    document.getElementById('edSaveX').onclick = closeSave;
    D.saveGo.onclick = doSave;
    D.savePanel.addEventListener('click', (e) => {
      if (e.target === D.savePanel) closeSave();
    });
    D.saveName.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') closeSave();
    });

    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('resize', () => {
      if (!S.open || !S.doc) return;
      if (S.drawing) brushUp();
      if (S.arrowDrag) arrowUp();
      fitNow();
      render();
    });

    window.openEditor = openEditor;
    window.BNImageEditor = {
      open: openEditor,
      close: closeEditor,
      /* 只读摘要，给自检和排错用 */
      info: () => (S.doc ? {
        tool: S.tool,
        crop: { x: S.doc.crop.x, y: S.doc.crop.y, w: S.doc.crop.w, h: S.doc.crop.h },
        look: { ...S.doc.look },
        lookSharp: S.lookSharp ? S.lookSharp.width : 0,
        strokes: S.doc.strokes.length,
        arrows: S.doc.strokes.filter((s) => s.kind === 'arrow').length,
        texts: S.doc.texts.length,
        hist: S.hist.length,
        hi: S.hi,
        scale: S.scale,
        sel: S.sel,
      } : null),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

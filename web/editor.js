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
  /* 画布四周留白：图片贴到窗口边时，裁剪手柄会压在窗口边框上，
   一拖就变成拖窗口。留 14px 让手柄始终落在画面里面。 */
const EDIT_SAFE = 14;
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
    /* 方向：T 是「原图坐标 → 当前画面坐标」的 2x3 矩阵 [a,b,c,d,e,f]，
       旋转/镜像都乘到它上面；底图由它从原图重新生成，撤销也能还原。 */
    T: [1, 0, 0, 1, 0, 0],
    origSrc: null, origPv: null,
    origW: 0, origH: 0, origPvW: 0, origPvH: 0, origPvScale: 1,
    doc: null,
    tool: 'brush',
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
    eraser: { size: 40 },   // 直径，和笔刷同一个量纲
    arrow: { color: '#ff3b30', size: 6, both: false },
    txt: { font: 'Microsoft YaHei', size: 56, color: '#ffffff' },
    /* 透视尺：mode 0 关 / 1 一点 / 2 两点；p1/p2 是消失点，存原图坐标，
       缩放平移时跟着画面走，导出时绝不画进去 */
    persp: {
      mode: 0, p1: { x: 0, y: 0 }, p2: { x: 0, y: 0 }, hz: 0,
      placed: false, drag: null, lock: null,
    },
    drawing: null,
    erasing: null,
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

  /* ---------------------------------------------------------- 方向变换 */

  const T_ID = [1, 0, 0, 1, 0, 0];

  function tApply(T, x, y) {
    return { x: T[0] * x + T[2] * y + T[4], y: T[1] * x + T[3] * y + T[5] };
  }

  /* 先应用 B 再应用 A */
  function tMul(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1],
      A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3],
      A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4],
      A[1] * B[4] + A[3] * B[5] + A[5],
    ];
  }

  function tSize(T, w, h) {
    return {
      w: Math.abs(T[0]) * w + Math.abs(T[2]) * h,
      h: Math.abs(T[1]) * w + Math.abs(T[3]) * h,
    };
  }

  function tSame(A, B) {
    for (let i = 0; i < 6; i++) if (A[i] !== B[i]) return false;
    return true;
  }

  function tCanvas(src, T, w, h) {
    const d = tSize(T, w, h);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(d.w));
    cv.height = Math.max(1, Math.round(d.h));
    const c = cv.getContext('2d');
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    c.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    c.drawImage(src, 0, 0);
    return cv;
  }

  /* 按当前 T 从原图重新生成底图（原图永远不动，所以旋转多少次都不掉画质） */
  function applyOrient() {
    if (!S.origSrc) return;
    const id = tSame(S.T, T_ID);
    S.src = id ? S.origSrc : tCanvas(S.origSrc, S.T, S.origW, S.origH);

    /* 预览图是缩过的，矩阵的平移量要跟着缩放 */
    const kv = S.origPvScale;
    const Tp = [S.T[0], S.T[1], S.T[2], S.T[3], S.T[4] * kv, S.T[5] * kv];
    S.pv = tSame(S.T, T_ID) ? S.origPv : tCanvas(S.origPv, Tp, S.origPvW, S.origPvH);

    const d = tSize(S.T, S.origW, S.origH);
    S.W = Math.round(d.w);
    S.H = Math.round(d.h);
    const pd = tSize(S.T, S.origPvW, S.origPvH);
    S.pvW = Math.max(1, Math.round(pd.w));
    S.pvH = Math.max(1, Math.round(pd.h));
    S.pvScale = S.pvW / Math.max(1, S.W);

    S.lookCv = null;
    S.lookCtx = null;
    S.lookSig = '';
    dropSharp();
  }

  /* 一次方向操作：A 是「当前画面坐标」上的变换 */
  function applyDir(A) {
    if (!S.doc) return;
    const W = S.W;
    const H = S.H;

    for (const st of S.doc.strokes) {
      if (st.kind === 'arrow') {
        const p0 = tApply(A, st.x0, st.y0);
        const p1 = tApply(A, st.x1, st.y1);
        st.x0 = p0.x; st.y0 = p0.y; st.x1 = p1.x; st.y1 = p1.y;
      } else {
        for (const pt of st.pts) {
          const q = tApply(A, pt.x, pt.y);
          pt.x = q.x; pt.y = q.y;
        }
      }
    }

    /* 文字保持正立：把它的中心搬过去，再按原尺寸摆回左上角 */
    for (const t of S.doc.texts) {
      if (!t.text) { const q0 = tApply(A, t.x, t.y); t.x = q0.x; t.y = q0.y; continue; }
      const b = textBox(t);
      const c0 = tApply(A, b.x + b.w / 2, b.y + b.h / 2);
      t.x = Math.round(c0.x - b.w / 2);
      t.y = Math.round(c0.y - b.h / 2);
    }

    const cr = S.doc.crop;
    const cs = [
      tApply(A, cr.x, cr.y),
      tApply(A, cr.x + cr.w, cr.y),
      tApply(A, cr.x, cr.y + cr.h),
      tApply(A, cr.x + cr.w, cr.y + cr.h),
    ];
    const xs = cs.map((q) => q.x);
    const ys = cs.map((q) => q.y);
    const x0 = Math.max(0, Math.round(Math.min.apply(null, xs)));
    const y0 = Math.max(0, Math.round(Math.min.apply(null, ys)));
    S.doc.crop = {
      x: x0,
      y: y0,
      w: Math.round(Math.max.apply(null, xs) - x0),
      h: Math.round(Math.max.apply(null, ys) - y0),
    };

    S.T = tMul(A, S.T);
    applyOrient();
    S.sel = null;
    S.cropSel = null;
    fitNow();
    updateDim();
    render();
    pushHistory();
    setStatus('方向已调整 · 可撤销');
  }

  function turnDir(sign) {
    const W = S.W;
    const H = S.H;
    /* 顺时针：x' = H - y, y' = x；逆时针反过来 */
    applyDir(sign > 0 ? [0, 1, -1, 0, H, 0] : [0, -1, 1, 0, 0, W]);
  }

  function mirrorDir(axis) {
    const W = S.W;
    const H = S.H;
    applyDir(axis === 'h' ? [-1, 0, 0, 1, W, 0] : [1, 0, 0, -1, 0, H]);
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

  let pendingDir = null;

  function openEditor(item, dir) {
    if (S.open || !item || item.kind !== 'image') return;
    /* 从看图页带着旋转/镜像进来，编辑时保持同样的朝向 */
    pendingDir = dir && (dir.rot || dir.flipH || dir.flipV) ? dir : null;
    S.open = true;
    S.item = item;
    S.doc = null;
    S.hist = [];
    S.hi = -1;
    S.sel = null;
    S.cropSel = null;
    S.aspect = 0;
    S.tool = 'brush';
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
    S.T = T_ID.slice();
    S.origSrc = img;
    S.origW = img.naturalWidth;
    S.origH = img.naturalHeight;
    S.src = img;
    S.W = S.origW;
    S.H = S.origH;
    buildPreview();
    /* 预览图也留一份干净的，旋转/镜像都从它派生 */
    S.origPv = S.pv;
    S.origPvW = S.pvW;
    S.origPvH = S.pvH;
    S.origPvScale = S.pvScale;

    S.doc = {
      crop: { x: 0, y: 0, w: S.W, h: S.H },
      look: { ...LOOK_DEF },
      strokes: [],
      texts: [],
    };
    D.dim.textContent = S.W + ' × ' + S.H;

    /* 先把朝向摆成看图页看到的样子，再当作初始状态（不占一步撤销） */
    if (pendingDir) {
      const d = pendingDir;
      pendingDir = null;
      const turns = ((d.rot || 0) % 4 + 4) % 4;
      for (let i = 0; i < turns; i++) applyDir([0, 1, -1, 0, S.H, 0]);
      if (d.flipH) applyDir([-1, 0, 0, 1, S.W, 0]);
      if (d.flipV) applyDir([1, 0, 0, -1, 0, S.H]);
      S.hist = [];
      S.hi = -1;
      S.sel = null;
      S.cropSel = null;
      S.doc.crop = { x: 0, y: 0, w: S.W, h: S.H };
    }

    updateDim();
    fitNow();
    setTool('brush');
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
      T: S.T,
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
    const T = Array.isArray(d.T) ? d.T : T_ID;
    const changed = !tSame(T, S.T);
    S.T = T.slice();
    if (changed) applyOrient();
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
    const bw = Math.max(1, (D.wrap.clientWidth || 1) - EDIT_SAFE * 2);
    const bh = Math.max(1, (D.wrap.clientHeight || 1) - EDIT_SAFE * 2);
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
    const bw = Math.max(1, (D.wrap.clientWidth || 0) - EDIT_SAFE * 2);
    const bh = Math.max(1, (D.wrap.clientHeight || 0) - EDIT_SAFE * 2);
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

    if (S.persp.mode) syncPersp();

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
    // 进裁剪就有框：默认给整幅，直接拖手柄往里收，比先划一个框直观
    if (name === 'crop' && !S.cropSel && S.W && S.H) {
      S.cropSel = { x: 0, y: 0, w: S.W, h: S.H };
    }
    [...D.tools.querySelectorAll('.ed-tool')].forEach((b) => {
      b.classList.toggle('on', b.dataset.tool === name);
    });
    D.crop.hidden = name !== 'crop';
    D.cv.style.cursor = name === 'brush' || name === 'arrow' || name === 'eraser' ? 'crosshair'
      : name === 'text' ? 'text' : 'default';
    if (name !== 'eraser') { S.erasing = null; liveReset(); }
    if (name !== 'crop') S.cropSel = null;
    if (name !== 'text') S.sel = null;
    buildSide();
    render();
    syncPersp();
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
          '<p class="ed-tip">框已经按整幅摆好，拖四角或边往里收即可；在框外拖一下可以重新框选，双击画面恢复整幅。</p>' +
        '</div>';
    } else if (t === 'eraser') {
      html +=
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">橡皮大小</h4>' +
          '<div class="ed-row"><span>直径</span><span class="v" id="edEraserSizeV">' + S.eraser.size + ' px</span></div>' +
          '<input class="ed-slider" id="edEraserSize" type="range" min="10" max="180" step="2" value="' + S.eraser.size + '">' +
          '<p class="ed-tip">擦的是标注，不动照片：划过一条线会把它截断，箭头和文字整块删掉。擦错了按 Ctrl+Z 撤销。</p>' +
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
          '<details class="ed-help"><summary>这几项是怎么算的</summary>' +
            '<p class="ed-tip">' +
              '叠加顺序：曝光 → 亮度 → 阴影 → 对比度 → 饱和度。' +
              '曝光是线性增益，最容易吹高光；亮度只提中间调；阴影只动暗部；' +
              '对比度围绕中灰缩放明暗差；饱和度 0% 即黑白。' +
              '点右侧数值可单独还原。影调只作用于照片，手绘与文字的颜色不受影响。' +
            '</p>' +
          '</details>' +
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
        '</div>' +
        '<div class="ed-sec">' +
          '<h4 class="ed-sec-h">透视尺</h4>' +
          '<div class="ed-seg" id="edPerspMode">' +
            '<button data-pm="0" class="' + (S.persp.mode === 0 ? 'on' : '') + '">关</button>' +
            '<button data-pm="1" class="' + (S.persp.mode === 1 ? 'on' : '') + '">一点</button>' +
            '<button data-pm="2" class="' + (S.persp.mode === 2 ? 'on' : '') + '">两点</button>' +
          '</div>' +
          (S.persp.mode
            ? '<p class="ed-tip">画面上的 1 / 2 就是消失点，直接拖到你要的位置。' +
              '每一笔会自己贴到方向最接近的那条线上——两条透视、一条横线（地平线）、一条竖线，' +
              '所以画出来天然符合透视。</p>' +
              '<button class="ed-line-btn" id="edPerspReset" style="margin-top:10px">消失点归位</button>'
            : '<p class="ed-tip">打开后每一笔都会被一条透视线管住，画背景的梁、地砖、柜体分缝时不用再对着消失点描。</p>') +
        '</div>' +
        '<div class="ed-sec">' +
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

    html +=
      '<div class="ed-sec">' +
        '<h4 class="ed-sec-h">方向</h4>' +
        '<div class="ed-dirs">' +
          '<button class="ed-dir" data-dir="ccw" title="逆时针 90°  Shift+R">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h9a5 5 0 0 1 0 10H8"/><path d="M8 4 4 8l4 4"/></svg>' +
          '</button>' +
          '<button class="ed-dir" data-dir="cw" title="顺时针 90°  R">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 8h-9a5 5 0 0 0 0 10h5"/><path d="M16 4l4 4-4 4"/></svg>' +
          '</button>' +
          '<button class="ed-dir" data-dir="h" title="左右镜像  M">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18" stroke-dasharray="2.5 3"/><path d="M8 7 3 12l5 5V7Z"/><path d="M16 7l5 5-5 5V7Z"/></svg>' +
          '</button>' +
          '<button class="ed-dir" data-dir="v" title="上下镜像  Shift+M">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18" stroke-dasharray="2.5 3"/><path d="M7 8 12 3l5 5H7Z"/><path d="M7 16l5 5 5-5H7Z"/></svg>' +
          '</button>' +
        '</div>' +
        '<p class="ed-tip">旋转的是整张画：照片、标注、裁剪框一起转；文字会跟着挪位置但保持正立。原图不做任何修改。</p>' +
      '</div>';

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

  /* 指针捕获：合成事件（自检用）没有真实指针，捕获失败也不该让工具失效 */
  function capture(e) {
    try { D.cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }

  function release(e) {
    try {
      release(e);
    } catch (err) { /* ignore */ }
  }

  /* ---------------------------------------------------------- 透视尺 */

  const PERSP_HIT = 18;      // 抓消失点的半径（屏幕像素）
  const PERSP_DIR_MIN = 14;  // 移动多少像素后才判定「这笔锁哪条线」

  function perspInit() {
    const p = S.persp;
    if (p.placed || !S.W || !S.H) return;
    /* 两个消失点共用一条地平线：拖动任何一个，横线跟着一起动 */
    p.hz = S.H * 0.46;
    p.p1 = { x: S.W * 0.5, y: p.hz };
    p.p2 = { x: S.W * 0.82, y: p.hz };
    p.placed = true;
  }

  function perspSetY(y) {
    S.persp.hz = y;
    S.persp.p1.y = y;
    S.persp.p2.y = y;
  }

  function setPerspMode(m) {
    S.persp.mode = m | 0;
    S.persp.lock = null;
    S.persp.drag = null;
    if (S.persp.mode) perspInit();
    buildSide();
    syncPersp();
  }

  /* 消失点命中：只在透视尺打开、手绘工具下生效 */
  function perspHit(vp) {
    const p = S.persp;
    if (!p.mode || S.tool !== 'brush') return null;
    const near = (q) => Math.hypot(q.x - vp.x, q.y - vp.y) * S.scale <= PERSP_HIT;
    if (p.mode >= 2 && near(p.p2)) return 'p2';
    if (near(p.p1)) return 'p1';
    return null;
  }

  /* 这一笔锁在哪条线上：p1 / p2 / 'v'（竖直线） 里挑方向最接近的 */
  function perspPick(ax, ay, dx, dy) {
    const p = S.persp;
    const cands = [{ k: 'p1', x: p.p1.x - ax, y: p.p1.y - ay }];
    if (p.mode >= 2) cands.push({ k: 'p2', x: p.p2.x - ax, y: p.p2.y - ay });
    cands.push({ k: 'v', x: 0, y: 1 });
    /* 平等于画面的横线：两点透视里没有消失点能吃住它，得单独给一条 */
    cands.push({ k: 'h', x: 1, y: 0 });

    let best = null;
    let bestA = Infinity;
    for (const c of cands) {
      const len = Math.hypot(c.x, c.y);
      if (len < 1e-6) continue;
      /* 线没有正反：往回拉和往外推都算同一条 */
      let cos = (dx * c.x + dy * c.y) / (len * Math.hypot(dx, dy) || 1);
      cos = Math.abs(cos);
      const ang = Math.acos(clamp(cos, -1, 1));
      if (ang < bestA) { bestA = ang; best = c; }
    }
    return best ? best.k : null;
  }

  /* 把点吸附到「过 anchor、朝 lock 方向」的那条线上 */
  function perspSnap(lock, ax, ay, x, y) {
    const p = S.persp;
    let ux = 0, uy = 1;
    if (lock === 'p1') { ux = p.p1.x - ax; uy = p.p1.y - ay; }
    else if (lock === 'p2') { ux = p.p2.x - ax; uy = p.p2.y - ay; }
    else if (lock === 'h') { ux = 1; uy = 0; }
    const len = Math.hypot(ux, uy);
    if (len < 1e-6) return { x, y };
    ux /= len; uy /= len;
    const t = (x - ax) * ux + (y - ay) * uy;
    return { x: ax + ux * t, y: ay + uy * t };
  }

  /* 画指引线：消失点、地平线、当前这笔锁定的那条线 */
  function syncPersp() {
    const p = S.persp;
    const svg = D.persp;
    if (!svg) return;
    const on = !!p.mode && S.tool === 'brush' && !S.doc?.crop ? false : !!p.mode && S.tool === 'brush';
    if (!on || !S.doc || !S.W) { svg.setAttribute('hidden', ''); return; }
    svg.removeAttribute('hidden');

    const crop = S.doc.crop;
    svg.setAttribute('viewBox', crop.x + ' ' + crop.y + ' ' + crop.w + ' ' + crop.h);
    const k = 1 / Math.max(0.05, S.scale);   // 让线和点在任何缩放下都是同一个屏幕粗细
    const r = 10 * k;

    const v1 = D.perspV1, v2 = D.perspV2;
    v1.setAttribute('cx', p.p1.x); v1.setAttribute('cy', p.p1.y); v1.setAttribute('r', r);
    v2.setAttribute('cx', p.p2.x); v2.setAttribute('cy', p.p2.y); v2.setAttribute('r', r);
    v2.style.display = p.mode >= 2 ? '' : 'none';
    D.perspTag1.setAttribute('x', p.p1.x + 13 * k);
    D.perspTag1.setAttribute('y', p.p1.y - 11 * k);
    D.perspTag1.style.fontSize = 13 * k + 'px';
    D.perspTag1.style.display = '';
    D.perspTag2.setAttribute('x', p.p2.x + 13 * k);
    D.perspTag2.setAttribute('y', p.p2.y - 11 * k);
    D.perspTag2.style.fontSize = 13 * k + 'px';
    D.perspTag2.style.display = p.mode >= 2 ? '' : 'none';

    /* 地平线：整幅横穿的一条，两个消失点都挂在它上面 */
    const hx0 = crop.x - crop.w * 0.2;
    const hx1 = crop.x + crop.w * 1.2;
    D.perspHorizon.setAttribute('x1', hx0); D.perspHorizon.setAttribute('y1', p.hz);
    D.perspHorizon.setAttribute('x2', hx1); D.perspHorizon.setAttribute('y2', p.hz);
    D.perspHorizon.style.display = '';

    /* 正在画的这条线：从消失点一路铺到画面外，提示「就这一条」 */
    const lock = p.lock;
    const anchor = p.anchor;
    const far = Math.hypot(S.W, S.H) * 3;
    const rays = [D.perspRay1, D.perspRay2];
    rays.forEach((ln) => ln.style.display = 'none');
    if (lock && anchor) {
      let ux, uy;
      if (lock === 'v') { ux = 0; uy = 1; }
      else if (lock === 'h') { ux = 1; uy = 0; }
      else {
        const q = lock === 'p2' ? p.p2 : p.p1;
        ux = q.x - anchor.x; uy = q.y - anchor.y;
      }
      const len = Math.hypot(ux, uy) || 1;
      ux /= len; uy /= len;
      const ln = rays[0];
      ln.setAttribute('x1', anchor.x - ux * far);
      ln.setAttribute('y1', anchor.y - uy * far);
      ln.setAttribute('x2', anchor.x + ux * far);
      ln.setAttribute('y2', anchor.y + uy * far);
      ln.style.display = '';
    }
  }

  function brushDown(e) {
    const vp = toView(e);
    S.drawing = {
      color: S.brush.color,
      size: S.brush.size,
      pts: [{ x: vp.x, y: vp.y }],
      /* 透视尺打开时，这一笔先不定方向，等手移动一段再判断锁哪条线 */
      persp: S.persp.mode ? { ax: vp.x, ay: vp.y, lock: null } : null,
    };
    if (S.drawing.persp) {
      S.persp.lock = null;
      S.persp.anchor = { x: vp.x, y: vp.y };
    }
    liveReset();
    syncPersp();
    liveDot(vp.x, vp.y, S.brush.size, S.brush.color);
    liveSegment(vp.x, vp.y, vp.x + 0.01, vp.y, S.brush.size, S.brush.color);
  }

  function brushMove(e) {
    const g = S.drawing;
    if (!g) return;
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const list = evs && evs.length ? evs : [e];
    for (let i = 0; i < list.length; i++) {
      let vp = toView(list[i]);
      const last = g.pts[g.pts.length - 1];

      if (g.persp) {
        const px = vp.x - g.persp.ax;
        const py = vp.y - g.persp.ay;
        if (!g.persp.lock) {
          if (Math.hypot(px, py) * S.scale >= PERSP_DIR_MIN) {
            g.persp.lock = perspPick(g.persp.ax, g.persp.ay, px, py);
            S.persp.lock = g.persp.lock;
            syncPersp();
          } else {
            continue;
          }
        }
        if (g.persp.lock) vp = perspSnap(g.persp.lock, g.persp.ax, g.persp.ay, vp.x, vp.y);
      }

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
    S.persp.lock = null;
    syncPersp();
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

  /* ---------------------------------------------------------- 橡皮
     擦的是「标注」而不是照片：划过一笔就把这笔画断，断成两截各自还是一条线；
     箭头整条删掉，文字整块删掉。全部可撤销，底层照片一点不动。 */

  function segDist(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy;
    if (l2 < 1e-6) return Math.hypot(px - x0, py - y0);
    let t = ((px - x0) * dx + (py - y0) * dy) / l2;
    t = clamp(t, 0, 1);
    return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
  }

  /* 返回 null＝没碰到；返回数组＝被切断后剩下的几段（空数组＝整笔擦干净） */
  function splitStroke(st, x, y, r) {
    const tol = r + (st.size || 1) / 2;
    let touched = false;
    const runs = [];
    let cur = [];
    for (const p of st.pts) {
      if (Math.hypot(p.x - x, p.y - y) <= tol) {
        touched = true;
        if (cur.length > 1) runs.push(cur);
        cur = [];
      } else {
        cur.push(p);
      }
    }
    if (!touched) return null;
    if (cur.length > 1) runs.push(cur);
    return runs;
  }

  function eraseAt(x, y) {
    const r = Math.max(3, S.eraser.size / 2);
    const keep = [];
    let changed = false;

    for (const st of S.doc.strokes) {
      if (st.kind === 'arrow') {
        if (segDist(x, y, st.x0, st.y0, st.x1, st.y1) <= r + st.size / 2) {
          changed = true;
          continue;
        }
        keep.push(st);
        continue;
      }
      const runs = splitStroke(st, x, y, r);
      if (!runs) {
        keep.push(st);
        continue;
      }
      changed = true;
      for (const pts of runs) keep.push({ ...st, pts });
    }

    if (changed) S.doc.strokes = keep;

    const texts = S.doc.texts.filter((t) => {
      const b = textBox(t);
      const hit = x >= b.x - r && x <= b.x + b.w + r && y >= b.y - r && y <= b.y + b.h + r;
      if (hit) changed = true;
      return !hit;
    });
    if (texts.length !== S.doc.texts.length) S.doc.texts = texts;

    if (changed) scheduleRender();
    return changed;
  }

  /* 擦的过程中画个圈，告诉用户擦头多大 */
  function eraseRing(x, y) {
    const r = Math.max(3, S.eraser.size / 2);
    const c = liveCtx();
    c.save();
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.strokeStyle = 'rgba(0,0,0,.5)';
    c.lineWidth = 3 / Math.max(0.05, S.scale);
    c.stroke();
    c.strokeStyle = 'rgba(255,255,255,.95)';
    c.lineWidth = 1.5 / Math.max(0.05, S.scale);
    c.stroke();
    c.restore();
  }

  function eraserDown(e) {
    const vp = toView(e);
    S.erasing = { last: { x: vp.x, y: vp.y }, changed: false };
    liveReset();
    if (eraseAt(vp.x, vp.y)) S.erasing.changed = true;
    eraseRing(vp.x, vp.y);
  }

  function eraserMove(e) {
    const g = S.erasing;
    const vp = toView(e);
    liveReset();
    if (!g) {
      eraseRing(vp.x, vp.y);
      return;
    }
    /* 手快的时候两点之间会跳，按擦头半径插值补上 */
    const r = Math.max(3, S.eraser.size / 2);
    const dx = vp.x - g.last.x;
    const dy = vp.y - g.last.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / Math.max(2, r * 0.7)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (eraseAt(g.last.x + dx * t, g.last.y + dy * t)) g.changed = true;
    }
    g.last = { x: vp.x, y: vp.y };
    eraseRing(vp.x, vp.y);
  }

  function eraserUp() {
    const g = S.erasing;
    S.erasing = null;
    liveReset();
    if (g && g.changed) pushHistory();
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
      const grab = perspHit(vp);
      if (grab) {
        S.persp.drag = grab;
        capture(e);
        return;
      }
      brushDown(e);
      capture(e);
      return;
    }

    if (S.tool === 'eraser') {
      eraserDown(e);
      capture(e);
      return;
    }

    if (S.tool === 'arrow') {
      arrowDown(e);
      capture(e);
      return;
    }

    if (S.tool === 'text') {
      const hit = hitText(vp);
      if (hit) {
        S.sel = hit.id;
        S.textDrag = { id: hit.id, dx: vp.x - hit.x, dy: vp.y - hit.y, moved: false };
        render();
        buildSide();
        capture(e);
      } else {
        addText(vp);
      }
      return;
    }
  }

  function onMove(e) {
    /* 悬在消失点上就换成抓手，否则还是十字 */
    if (!S.panning && !S.drawing && S.tool === 'brush' && S.persp.mode) {
      D.cv.style.cursor = perspHit(toView(e)) ? 'grab' : 'crosshair';
    }
    if (S.panning) {
      S.panX = S.panning.sx + (e.clientX - S.panning.cx);
      S.panY = S.panning.sy + (e.clientY - S.panning.cy);
      clampPan();
      render();
      return;
    }
    if (S.persp.drag) {
      D.cv.style.cursor = 'grabbing';
      const vp = toView(e);
      const q = S.persp[S.persp.drag];
      /* 允许拖到画面外，那里才是多数透视的消失点 */
      q.x = clamp(vp.x, -S.W, S.W * 2);
      perspSetY(clamp(vp.y, -S.H * 0.5, S.H * 1.5));
      syncPersp();
      return;
    }
    if (S.drawing) {
      brushMove(e);
      return;
    }
    if (S.tool === 'eraser' && !S.panning) {
      eraserMove(e);
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
    if (S.persp.drag) {
      S.persp.drag = null;
      D.cv.style.cursor = 'grab';
      release(e);
      return;
    }
    if (S.panning) {
      S.panning = null;
      D.wrap.classList.remove('panning');
      return;
    }
    if (S.drawing) {
      brushUp();
      release(e);
      return;
    }
    if (S.tool === 'eraser') {
      eraserUp();
      release(e);
      return;
    }
    if (S.arrowDrag) {
      arrowUp();
      release(e);
      return;
    }
    if (S.textDrag) {
      if (S.textDrag.moved) pushHistory();
      S.textDrag = null;
      release(e);
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

    if (btn.dataset.dir != null) {
      const dir = btn.dataset.dir;
      if (dir === 'cw') turnDir(1);
      else if (dir === 'ccw') turnDir(-1);
      else mirrorDir(dir);
      return;
    }
    if (btn.dataset.pm != null) {
      setPerspMode(+btn.dataset.pm);
      return;
    }
    if (btn.id === 'edPerspReset') {
      S.persp.placed = false;
      perspInit();
      syncPersp();
      setStatus('消失点已归位');
      return;
    }

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
    if (e.target.id === 'edEraserSize') {
      S.eraser.size = +e.target.value;
      const v = document.getElementById('edEraserSizeV');
      if (v) v.textContent = S.eraser.size + ' px';
      return;
    }

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
    if (k === 'e') return setTool('eraser');
    if (k === 'r') return turnDir(e.shiftKey ? -1 : 1);
    if (k === 'm') return mirrorDir(e.shiftKey ? 'v' : 'h');
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
      } else if (S.tool === 'eraser') {
        S.eraser.size = clamp(S.eraser.size + (up ? 6 : -6), 10, 180);
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
    D.persp = document.getElementById('edPersp');
    D.perspHorizon = document.getElementById('edPerspHorizon');
    D.perspRay1 = document.getElementById('edPerspRay1');
    D.perspRay2 = document.getElementById('edPerspRay2');
    D.perspV1 = document.getElementById('edPerspV1');
    D.perspV2 = document.getElementById('edPerspV2');
    D.perspTag1 = document.getElementById('edPerspTag1');
    D.perspTag2 = document.getElementById('edPerspTag2');
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
        /* 双击回到整幅，而不是把框清掉——框一直都在，只是大小变了 */
        S.cropSel = S.W && S.H ? { x: 0, y: 0, w: S.W, h: S.H } : null;
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

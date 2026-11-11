/* BNImage · 统一查看器 —— 前端逻辑
   只读浏览：网格 → 单张 / 视频 / PDF / HTML
   ------------------------------------------------------------------ */

const $ = (s) => document.querySelector(s);
const el = {
  bar: $('#bar'),
  crumbs: $('#crumbs'),
  count: $('#count'),
  grid: $('#grid'),
  empty: $('#empty'),
  viewer: $('#viewer'),
  stage: $('#viewerStage'),
  info: $('#viewerInfo'),
  close: $('#btnClose'),
  prev: $('#navPrev'),
  next: $('#navNext'),
  panel: $('#panel'),
  panelBody: $('#panelBody'),
  toast: $('#toast'),
  locate: $('#locate'),
  locateInput: $('#locateInput'),
  zoomBar: $('#zoomBar'),
  zoomPct: $('#zbPct'),
  zoomIn: $('#zbIn'),
  zoomOut: $('#zbOut'),
  zoomFit: $('#zbFit'),
  zoomOne: $('#zbOne'),
  edit: $('#zbEdit'),
};

const state = {
  path: '',
  items: [],
  viewable: [],
  index: -1,
  theme: 'dark',
  loading: false,
};

/* ------------------------------------------------------------ 工具 */

function fsUrl(p, rev) {
  const norm = String(p).replace(/\\/g, '/');
  const segs = norm.split('/').filter((s) => s !== '');
  const base = '/fs/' + segs.map(encodeURIComponent).join('/');
  return rev ? base + '?r=' + rev : base;
}

function thumbUrl(item, w = 380) {
  return `/api/thumb?path=${encodeURIComponent(item.path)}&w=${w}${item.rev ? '&r=' + item.rev : ''}`;
}

/* 视频封面：服务端用 ffmpeg 抓帧，浏览器只负责显示这张图 */
function vframeUrl(item, w = 420) {
  return `/api/vframe?path=${encodeURIComponent(item.path)}&w=${w}${item.rev ? '&r=' + item.rev : ''}`;
}

function renderUrl(item, w = 2560, rev) {
  const r = rev || item.rev;
  return `/api/render?path=${encodeURIComponent(item.path)}&w=${w}${r ? '&r=' + r : ''}`;
}

function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function extLabel(item) {
  return (item.ext || '').toUpperCase().slice(0, 5);
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), ms);
}

/* ------------------------------------------------------------ 图标 */

const ICON = {
  folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M3 6.6c0-.6.5-1.1 1.1-1.1h4.3l1.7 2.1h9.8c.6 0 1.1.5 1.1 1.1v9.6c0 .6-.5 1.1-1.1 1.1H4.1c-.6 0-1.1-.5-1.1-1.1V6.6Z"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M6 3.5h7.6L18.5 8.4V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"/><path d="M13.4 3.6v4.9h4.9"/><path d="M8.6 16.6v-4.2h1.3a1.3 1.3 0 0 1 0 2.6H8.6M13 16.6v-4.2h1.1c1.2 0 1.9.9 1.9 2.1s-.7 2.1-1.9 2.1H13Z" stroke-width=".9"/></svg>`,
  html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><path d="M6 3.5h7.6L18.5 8.4V20a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5Z"/><path d="M13.4 3.6v4.9h4.9"/><path d="m9.6 12.4-2 2 2 2M14.4 12.4l2 2-2 2" stroke-width=".9"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="3.4" y="5.4" width="17.2" height="13.2" rx=".6"/><circle cx="8.6" cy="10.2" r="1.35"/><path d="m4.4 17.6 4.9-4.9 3.4 3.4 2.6-2.4 4.4 4.1"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="3.2" y="5.4" width="17.6" height="13.2" rx=".6"/><path d="m10.2 9.3 5 2.7-5 2.7V9.3Z"/></svg>`,
  drive: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="3.2" y="6" width="17.6" height="12" rx="1.6"/><path d="M3.2 12.6h17.6"/><circle cx="6.6" cy="15.3" r=".85" fill="currentColor" stroke="none"/></svg>`,
};

/* ------------------------------------------------------------ 主题 */

function applyTheme(t) {
  state.theme = t;
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="color-scheme"]').content = t;
  localStorage.setItem('bnimage.theme', t);
  const btn = $('#btnTheme');
  btn.classList.toggle('on', t === 'light');
  syncCaptionTheme(t);
}

/* 系统标题栏归 DWM 画，默认跟 Windows 系统主题走，不会自己跟界面的浅/深色。
   切主题时告诉后端一句，由它把标题栏底色、边框、文字一起换掉。 */
let cappedTheme = '';
function syncCaptionTheme(t) {
  if (cappedTheme === t) return;
  cappedTheme = t;
  try {
    fetch('/api/theme?mode=' + encodeURIComponent(t), { cache: 'no-store' })
      .catch(() => {});
  } catch (_) { /* 浏览器里预览时没有后端，忽略即可 */ }
}

function initTheme() {
  const forced = new URLSearchParams(location.search).get('theme');
  if (forced === 'dark' || forced === 'light') return applyTheme(forced);
  const saved = localStorage.getItem('bnimage.theme');
  if (saved) return applyTheme(saved);
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark ? 'dark' : 'light');
}

/* ------------------------------------------------------------ 载入目录 */

async function load(path, opts = {}) {
  if (state.loading) return;
  state.loading = true;
  closeViewer(true);
  /* 换文件夹了，上一张的位置记忆作废 */
  viewMemo = null;
  pendingView = null;
  el.empty.hidden = true;

  let data;
  try {
    const r = await fetch(`/api/list?path=${encodeURIComponent(path || '')}`);
    data = await r.json();
    if (data.error) throw new Error(data.error);
  } catch (e) {
    state.loading = false;
    if (path) {
      toast('无法打开：' + path);
      if (path === state.path) return;
    }
    return renderRoot();
  }

  state.path = data.path || '';
  localStorage.setItem('bnimage.path', state.path);
  state.items = data.items || [];
  state.viewable = state.items.filter((i) => i.kind !== 'dir');
  state.index = -1;

  renderCrumbs(data.crumbs || []);
  renderGrid(data, opts);
  state.loading = false;
  syncViewChrome();
}

async function renderRoot() {
  state.loading = true;
  closeViewer(true);
  viewMemo = null;
  pendingView = null;
  el.empty.hidden = true;
  const r = await fetch('/api/drives');
  const data = await r.json();
  state.path = '';
  state.items = [];
  state.viewable = [];
  renderCrumbs([{ name: '此电脑', path: '' }]);

  el.grid.innerHTML = '';
  el.grid.scrollTop = 0;
  el.count.textContent = '';

  const add = (name, path, icon, sub) => {
    const c = document.createElement('div');
    c.className = 'cell tile folder';
    c.innerHTML = `<div class="glyph">${icon}<span class="name">${escapeHtml(name)}</span></div>`;
    c.title = path;
    c.onclick = () => load(path);
    el.grid.appendChild(c);
  };

  (data.shortcuts || []).forEach((s) => add(s.name, s.path, ICON.folder));
  const sep = document.createElement('div');
  sep.className = 'grid-note';
  sep.textContent = '磁盘';
  el.grid.appendChild(sep);
  (data.drives || []).forEach((d) => add(d.name, d.path, ICON.drive));

  syncCellHeight();
  state.loading = false;
  syncViewChrome();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function renderCrumbs(crumbs) {
  el.crumbs.innerHTML = '';
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const s = document.createElement('span');
      s.className = 'sep';
      s.textContent = '›';
      el.crumbs.appendChild(s);
    }
    const b = document.createElement('button');
    b.textContent = c.name || '此电脑';
    b.title = c.path || '此电脑';
    const isLast = i === crumbs.length - 1;
    b.className = isLast ? 'current' : '';
    if (!isLast) b.onclick = () => (c.path ? load(c.path) : renderRoot());
    el.crumbs.appendChild(b);
  });
  // 滚动到最右
  requestAnimationFrame(() => {
    el.crumbs.scrollLeft = el.crumbs.scrollWidth;
    el.crumbs.classList.toggle('overflow', el.crumbs.scrollWidth > el.crumbs.clientWidth + 2);
  });
}

/* ------------------------------------------------------------ 网格 */

let observer = null;

/* 网格行高兜底：新版 Chromium 里 aspect-ratio 撑不开 grid 自动行，
   缩略图会互相压盖。这里量一次实际列宽，写回 --cell-h 当作行高。 */
function syncCellHeight() {
  if (!el.grid) return;
  const first = el.grid.querySelector('.cell');
  const w = first ? first.getBoundingClientRect().width : 0;
  if (w > 0) el.grid.style.setProperty('--cell-h', w.toFixed(2) + 'px');
  else el.grid.style.removeProperty('--cell-h');
}

function renderGrid(data, opts = {}) {
  el.grid.innerHTML = '';
  el.grid.scrollTop = 0;

  const items = data.items || [];
  const fileCount = items.filter((i) => i.kind !== 'dir').length;
  const dirCount = items.length - fileCount;
  el.count.textContent = items.length
    ? `${dirCount ? dirCount + ' 文件夹 · ' : ''}${fileCount} 项`
    : '';

  if (!items.length) {
    el.empty.hidden = false;
    el.empty.querySelector('.empty-title').textContent = '这个文件夹里没有可预览的内容';
    el.empty.querySelector('.empty-sub').innerHTML =
      '支持照片、图片、视频、PDF、HTML · <kbd>?</kbd> 查看完整格式列表';
    syncCellHeight();
    return;
  }
  el.empty.hidden = true;

  if (observer) observer.disconnect();
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const node = e.target;
      const item = node._item;
      if (!item) continue;
      observer.unobserve(node);
      attachMedia(node, item);
    }
  }, { root: el.grid, rootMargin: '600px 0px' });

  const frag = document.createDocumentFragment();
  for (const item of items) {
    frag.appendChild(makeCell(item));
  }

  const tail = [];
  if (data.ignored) tail.push(`另有 <em>${data.ignored}</em> 个文件不在支持范围内，未显示`);
  if (data.presentations) tail.push(`<em>${data.presentations}</em> 个演示文稿文件按要求不纳入预览`);
  if (tail.length) {
    const note = document.createElement('div');
    note.className = 'grid-note';
    note.innerHTML = tail.join(' · ');
    frag.appendChild(note);
  }

  el.grid.appendChild(frag);
  syncCellHeight();
}

function makeCell(item) {
  const cell = document.createElement('div');

  if (item.kind === 'dir') {
    cell.className = 'cell tile folder';
    cell.innerHTML = `<div class="glyph">${ICON.folder}<span class="name">${escapeHtml(item.name)}</span></div>`;
    cell.title = item.name;
    cell.onclick = () => load(item.path);
    return cell;
  }

  if (item.kind === 'image') {
    cell.className = 'cell pulse';
    const img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = () => { cell.classList.remove('pulse'); img.classList.add('ready'); };
    img.onerror = () => {
      cell.classList.remove('pulse');
      img.remove();
      cell.classList.add('tile');
      cell.innerHTML = `<div class="glyph">${ICON.image}<span>${extLabel(item)}</span></div>`;
    };
    cell.appendChild(img);
    cell._item = item;
    cell._media = img;
    addLabel(cell, item.name);
    cell.onclick = () => openViewer(item);
    observer.observe(cell);
    return cell;
  }

  if (item.kind === 'video') {
    /* 封面走服务端抓帧（ffmpeg），不再塞 <video>：
       WebView2 里 preload=metadata 不解首帧、#t= 也时常不生效，格子里就是空白。 */
    cell.className = 'cell video pulse';
    const img = document.createElement('img');
    img.alt = item.name;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onload = () => { cell.classList.remove('pulse'); img.classList.add('ready'); };
    img.onerror = () => {
      cell.classList.remove('pulse');
      img.remove();
      cell.classList.add('tile');
      cell.innerHTML = `<div class="glyph">${ICON.video}<span>${extLabel(item)}</span></div>`;
    };
    cell.appendChild(img);
    const badge = document.createElement('span');
    badge.className = 'vbadge';
    badge.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7.2 16.6 12 9 16.8V7.2Z"/></svg>`;
    cell.appendChild(badge);
    cell._item = item;
    cell._media = img;
    addLabel(cell, item.name);
    cell.onclick = () => openViewer(item);
    observer.observe(cell);
    return cell;
  }

  // 相机 RAW：识别但不解码
  if (item.kind === 'raw') {
    cell.className = 'cell tile';
    cell.innerHTML = `<div class="glyph">${ICON.image}<span>${extLabel(item)}</span></div>`;
    addLabel(cell, item.name);
    cell._item = item;
    cell.onclick = () => openViewer(item);
    return cell;
  }

  // PDF / HTML / AI
  cell.className = 'cell tile';
  const icon = item.kind === 'pdf' ? ICON.pdf : ICON.html;
  cell.innerHTML = `<div class="glyph">${icon}<span>${extLabel(item)}</span></div>`;
  addLabel(cell, item.name);
  cell._item = item;
  cell.onclick = () => openViewer(item);
  return cell;
}

function addLabel(cell, name) {
  const l = document.createElement('div');
  l.className = 'label';
  l.textContent = name;
  cell.appendChild(l);
}

function attachMedia(node, item) {
  const media = node._media;
  if (!media) return;
  if (item.kind === 'image') {
    media.src = item.native ? fsUrl(item.path) : thumbUrl(item, 420);
  } else if (item.kind === 'video') {
    media.src = vframeUrl(item, 420);
  }
}

/* ------------------------------------------------------------ 单张视图 */

let zoomEl = null;
let infoTimer = null;
let lastInfoMove = 0;
let currentItem = null;

/* 信息条只在需要时露一下：打开/切图停 1.5s，鼠标动停手 0.7s 就走，
   免得一直压在画面底部挡内容。 */
const INFO_HOLD_OPEN = 1500;
const INFO_HOLD_MOVE = 700;

function infoFlash(hold) {
  el.info.classList.add('show');
  clearTimeout(infoTimer);
  infoTimer = setTimeout(() => el.info.classList.remove('show'), hold);
}

function infoHide() {
  clearTimeout(infoTimer);
  el.info.classList.remove('show');
}

/* 视图切换的记忆：退回网格时记下「哪张图 + 缩放平移 + 网格滚动」，
   再点一次网格按钮原样回到这张。pendingView 只在一次渲染内有效，用完即弃。 */
let viewMemo = null;
let pendingView = null;

/* 缩放模型：scale 是相对原始像素的显示比例，1 即 100%（像素 1:1）。
   fitScale 是「图片刚好铺满窗口」时的比例，由原图尺寸与窗口尺寸算出。
   实际 transform 的倍率 = scale / fitScale。 */
let fitScale = 1;
let natW = 0, natH = 0;
let scale = 1, tx = 0, ty = 0;
let dragging = false, dragStart = null;

/* 高分辨率图的源分级：缩小显示时用服务端预缩放版本，放大时换回原图 */
let srcHi = '', srcLo = '', loW = 0, usingLo = false;

function resetZoomState() {
  fitScale = 1;
  natW = 0; natH = 0;
  scale = 1; tx = 0; ty = 0;
  srcHi = ''; srcLo = ''; loW = 0; usingLo = false;
  dragging = false; dragStart = null;
}

function openViewer(item) {
  state.index = state.viewable.findIndex((x) => x.path === item.path);
  if (state.index < 0) return;
  /* 主动打开某一张，之前记的「返回位置」作废 */
  viewMemo = null;
  markLastCell(null);
  el.viewer.hidden = false;
  document.body.classList.add('in-viewer');
  renderViewer();
  syncViewChrome();
}

function closeViewer(silent = false) {
  if (el.viewer.hidden) return;
  /* 退回网格前，把当前位置整份记下来 */
  if (!silent && currentItem && state.index >= 0) {
    const v = el.stage.querySelector('video');
    viewMemo = {
      folder: state.path,
      path: currentItem.path,
      kind: currentItem.kind,
      scale, tx, ty,
      mediaTime: v ? v.currentTime : 0,
      scrollTop: el.grid.scrollTop,
    };
  } else {
    viewMemo = null;
  }
  el.viewer.hidden = true;
  el.stage.innerHTML = '';
  el.prev.classList.remove('near');
  el.next.classList.remove('near');
  el.viewer.classList.remove('nav-fixed');
  infoHide();
  el.zoomBar.hidden = true;
  el.edit.hidden = true;
  zoomEl = null;
  currentItem = null;
  resetZoomState();
  document.body.classList.remove('in-viewer');
  if (!silent) {
    const cell = [...el.grid.children].find((c) => c._item && state.viewable[state.index] && c._item.path === state.viewable[state.index].path);
    if (cell) cell.scrollIntoView({ block: 'nearest' });
    markLastCell(viewMemo ? viewMemo.path : null);
  }
  syncViewChrome();
}

/* 网格 → 回到进入前那张，缩放、平移、滚动位置一并还原 */
function restoreViewerFromMemo() {
  const m = viewMemo;
  if (!m) return false;
  /* 换了文件夹或那张图不在了，记忆失效，走普通逻辑 */
  if (m.folder !== state.path) { viewMemo = null; return false; }
  const i = state.viewable.findIndex((x) => x.path === m.path);
  if (i < 0) { viewMemo = null; return false; }

  state.index = i;
  pendingView = m;
  viewMemo = null;
  el.viewer.hidden = false;
  document.body.classList.add('in-viewer');
  renderViewer();
  el.grid.scrollTop = m.scrollTop;
  markLastCell(null);
  syncViewChrome();
  return true;
}

/* 网格按钮 = 单张 / 网格 的开关，来回都保持原样 */
function toggleViewMode() {
  if (!el.viewer.hidden) return closeViewer();
  if (restoreViewerFromMemo()) return;
  if (state.viewable.length) return openViewer(state.viewable[0]);
  if (state.path) return load(state.path);
  return renderRoot();
}

function syncViewChrome() {
  const btn = $('#btnGrid');
  if (!btn) return;
  const inGrid = el.viewer.hidden;
  btn.classList.toggle('on', inGrid);
  btn.setAttribute('aria-pressed', inGrid ? 'true' : 'false');
  btn.title = inGrid
    ? (viewMemo ? '回到刚才那张  G' : '单张视图  G')
    : '网格视图  G';
}

/* 网格里给「上次看的那张」留个标记，回来一眼能找到 */
function markLastCell(path) {
  el.grid.querySelectorAll('.cell.last').forEach((c) => c.classList.remove('last'));
  if (!path) return;
  const cell = [...el.grid.children].find((c) => c._item && c._item.path === path);
  if (cell) cell.classList.add('last');
}


function step(delta) {
  if (!state.viewable.length) return;
  let i = state.index + delta;
  if (i < 0) i = state.viewable.length - 1;
  if (i >= state.viewable.length) i = 0;
  state.index = i;
  renderViewer();
}

function updateNav() {
  const multi = state.viewable.length > 1;
  el.prev.classList.toggle('off', !multi);
  el.next.classList.toggle('off', !multi);
  if (!multi) {
    el.prev.classList.remove('near');
    el.next.classList.remove('near');
  }
}

function renderViewer() {
  const item = state.viewable[state.index];
  if (!item) return;
  currentItem = item;
  el.stage.innerHTML = '';
  el.stage.onwheel = null;
  zoomEl = null;
  resetZoomState();
  /* 只对本次渲染生效：从网格回来时还原离开前的缩放与平移 */
  const restore = pendingView && pendingView.path === item.path ? pendingView : null;
  pendingView = null;
  el.zoomBar.hidden = true;
  el.edit.hidden = true;
  updateNav();
  /* PDF / HTML 走 iframe，指针消息到不了外层：这类改由按钮自身 hover 唤出 */
  el.viewer.classList.toggle('nav-fixed', item.kind !== 'image' && item.kind !== 'video');

  if (item.kind === 'image') {
    const img = document.createElement('img');
    img.alt = item.name;
    img.draggable = false;
    img.className = 'fit';
    el.zoomBar.hidden = false;
    el.edit.hidden = !window.BNImageEditor;

    srcHi = item.native ? fsUrl(item.path, item.rev) : renderUrl(item, 4096, item.rev);
    img.src = srcHi;
    img.dataset.src = srcHi;

    img.addEventListener('load', () => {
      if (!img.naturalWidth || !img.naturalHeight) return;
      zoomEl = img;
      natW = img.naturalWidth;
      natH = img.naturalHeight;
      fitScale = computeFit() || 1;
      /* 大图缩到刚好铺满窗口，小图按原始尺寸显示；两种都不放大超过 100% */
      scale = Math.min(1, fitScale);
      tx = 0; ty = 0;
      /* 从网格回来：按离开时的比例与位移站回原处 */
      if (restore) {
        scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, restore.scale || scale));
        tx = restore.tx || 0;
        ty = restore.ty || 0;
        clampPan();
      }
      applyT(img);
      bindZoom(img);
      showInfo(item, `${natW} × ${natH}`);
      if (item.native) setupLowSource(item);
    }, { once: true });

    img.addEventListener('error', () => {
      showInfo(item, '无法解码此格式');
      errorState(item, '浏览器与本地解码器都无法读取这张图片');
    }, { once: true });

    el.stage.appendChild(img);
  } else if (item.kind === 'video') {
    showVideo(item, restore && restore.kind === 'video' ? restore.mediaTime : 0);
  } else if (item.kind === 'pdf') {
    const wrap = document.createElement('div');
    wrap.className = 'frame-wrap';
    wrap.innerHTML = `<div class="frame-note"><span>内置阅读器预览${item.kind === 'pdf' && item.ext === 'ai' ? ' · AI 以 PDF 兼容方式打开' : ''}</span><button onclick="openExternal('${encodeURIComponent(item.path)}')">用默认程序打开</button></div>`;
    const f = document.createElement('iframe');
    f.src = fsUrl(item.path) + '#view=FitH';
    wrap.appendChild(f);
    el.stage.appendChild(wrap);
    showInfo(item, 'PDF');
  } else if (item.kind === 'raw') {
    errorState(item, '相机 RAW 原片暂不解码，可用系统默认程序或相机厂商软件打开');
    showInfo(item, 'RAW 原片');
  } else {
    const wrap = document.createElement('div');
    wrap.className = 'frame-wrap';
    wrap.innerHTML = `<div class="frame-note"><span>沙箱预览 · 脚本在独立环境运行</span><button onclick="openExternal('${encodeURIComponent(item.path)}')">在浏览器中打开</button></div>`;
    const f = document.createElement('iframe');
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-modals');
    f.src = fsUrl(item.path);
    wrap.appendChild(f);
    el.stage.appendChild(wrap);
    showInfo(item, 'HTML');
  }
}

function errorState(item, message) {
  const enc = encodeURIComponent(item.path);
  el.stage.innerHTML = `
    <div class="stage-error">
      <div class="stage-error-icon">${ICON[item.kind] || ICON.image}</div>
      <div class="stage-error-text">${escapeHtml(message)}</div>
      <button onclick="openExternal('${enc}')">用系统默认程序打开</button>
    </div>`;
}

/* ------------------------------------------------------------ 视频播放 */

const vprobeCache = new Map();

async function probeVideo(path) {
  if (vprobeCache.has(path)) return vprobeCache.get(path);
  let info = { ok: false, tx: false, ffmpeg: false, reason: '' };
  try {
    const r = await fetch(`/api/vprobe?path=${encodeURIComponent(path)}`);
    info = await r.json();
  } catch (e) {
    /* 服务端没有这条路由时，按普通视频直接播 */
  }
  vprobeCache.set(path, info);
  return info;
}

/* 内核能直接解的编码 → MIME 组合。canPlayType 返回非空就说明这台机器能自己解，
   可以完全跳过转码；装了「HEVC 视频扩展」的机器，H.265 会走这条路。 */
const CODEC_MIME = {
  hevc: ['video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="hev1.1.6.L93.B0"'],
  h264: ['video/mp4; codecs="avc1.42E01E"'],
  av1: ['video/mp4; codecs="av01.0.05M.08"'],
  vp9: ['video/webm; codecs="vp9"'],
  vp8: ['video/webm; codecs="vp8"'],
};
const SAFE_BOX = ['.mp4', '.m4v', '.mov', '.webm'];

function nativePlayable(codec, container) {
  if (!codec) return false;
  if (SAFE_BOX.indexOf(String(container || '').toLowerCase()) < 0) return false;
  const types = CODEC_MIME[codec];
  if (!types) return false;
  const probe = document.createElement('video');
  return types.some((t) => probe.canPlayType(t) !== '');
}

function playVideo(item, src, seekAt = 0, onFail = null) {
  const v = document.createElement('video');
  v.controls = true;
  v.autoplay = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  /* 直接播原文件时的退路：真解不出来就回落到转码，别让用户卡住 */
  let dead = false;
  const bail = () => {
    if (dead) return;
    dead = true;
    try { v.remove(); } catch (e) { /* ignore */ }
    if (onFail) { onFail(); return; }
    errorState(item, '这段视频在应用内仍然解不出来，可以用系统默认程序打开');
    showInfo(item, '不支持的编码');
  };
  v.onloadedmetadata = () => {
    showInfo(item, `${v.videoWidth} × ${v.videoHeight} · ${fmtDur(v.duration)}`);
    /* 从网格回来时接着上次的进度播 */
    if (seekAt > 0.2 && isFinite(v.duration)) {
      v.currentTime = Math.min(seekAt, Math.max(0, v.duration - 0.15));
    }
  };
  v.onerror = bail;
  el.stage.appendChild(v);
  v.focus();

  // 兜底：解出了音轨但没解出画面（H.265 等），不会触发 onerror，画面就是一片空白
  let told = false;
  const checkFrames = () => {
    if (dead || told || v.videoWidth > 0) return;
    told = true;
    if (onFail) bail(); else codecHint(item);
  };
  v.addEventListener('loadedmetadata', () => setTimeout(checkFrames, 600));
  v.addEventListener('playing', () => setTimeout(checkFrames, 1000));
  return v;
}

async function showVideo(item, seekAt = 0) {
  const got = await probeVideo(item.path);
  if (currentItem !== item || el.viewer.hidden) return;

  /* 两条路都不转码：本来就不用转的，以及内核其实能自己解的
     （装了 HEVC 视频扩展之后，H.265 也属于这一类 → 打开即播）。 */
  const direct = !!got.tx && nativePlayable(got.codec, got.container);
  if (!got.tx || direct) {
    el.stage.innerHTML = '';
    playVideo(item, fsUrl(item.path), seekAt,
      direct ? () => transcodePlay(item, got, seekAt) : null);
    return;
  }
  if (!got.ffmpeg) {          // 没有 ffmpeg 就只能给说明
    el.stage.innerHTML = '';
    codecHint(item);
    showInfo(item, '不支持的编码');
    return;
  }
  transcodePlay(item, got, seekAt);
}

/* 需要转码时：先摆进度面板（带一张封面帧，别让人对着黑屏等），转完换成播放器 */
async function transcodePlay(item, got, seekAt = 0) {
  el.stage.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'tx-panel';
  panel.innerHTML = `
    <img class="tx-shot" src="${vframeUrl(item, 720)}" alt="" onerror="this.remove()">
    <div class="tx-head">${escapeHtml(got.reason || '该编码')} · 正在转成可播放的 H.264</div>
    <div class="tx-bar"><i></i></div>
    <div class="tx-note">只在第一次打开时转一遍，之后直接用缓存，不再重复转。</div>
    <div class="tx-act">
      <button onclick="openExternal('${encodeURIComponent(item.path)}')">不等了，用系统程序打开</button>
    </div>`;
  el.stage.appendChild(panel);
  showInfo(item, `${got.reason || '转码'} · 准备中`);

  const bar = panel.querySelector('.tx-bar i');
  const head = panel.querySelector('.tx-head');
  const t0 = Date.now();
  let retried = false;

  while (currentItem === item && !el.viewer.hidden) {
    let d = null;
    try {
      d = await (await fetch(`/api/tx?path=${encodeURIComponent(item.path)}`)).json();
    } catch (e) { /* 轮询抖动，下一轮再说 */ }

    if (d && d.state === 'ready') {
      panel.remove();
      el.stage.innerHTML = '';
      playVideo(item, d.url, seekAt);
      return;
    }
    if (d && d.state === 'error') {
      if (!retried) {
        retried = true;
        try { await fetch(`/api/tx?path=${encodeURIComponent(item.path)}&retry=1`); } catch (e) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      el.stage.innerHTML = '';
      errorState(item, '转码失败：' + String(d.msg || '未知原因').slice(0, 180));
      showInfo(item, '转码失败');
      return;
    }
    const pct = d && typeof d.pct === 'number' ? d.pct : 0;
    bar.style.width = Math.max(4, pct) + '%';
    head.textContent = `${got.reason || '该编码'} · 正在转码 ${pct}%`;
    showInfo(item, `转码 ${pct}%`);
    if (Date.now() - t0 > 20 * 60 * 1000) break;
    await new Promise((r) => setTimeout(r, 450));
  }
}

function codecHint(item) {
  if (el.stage.querySelector('.codec-hint')) return;
  const probe = document.createElement('video');
  const noHevc = !probe.canPlayType('video/mp4; codecs="hvc1"')
    && !probe.canPlayType('video/mp4; codecs="hev1"');
  const why = noHevc
    ? '这段视频的画面是 <b>H.265 / HEVC</b> 编码（手机拍的视频常见），当前渲染内核没有 H.265 解码器，所以只有声音、没有画面。'
    : '这段视频的画面编码当前内核解不出来，所以只有声音、没有画面。';
  const box = document.createElement('div');
  box.className = 'codec-hint';
  box.innerHTML = `
    <div class="codec-hint-t">${why}<br>
      正常情况下程序会自动用内置 ffmpeg 转码播放，这次没能转成功
      （可能缺少 ffmpeg.exe 或文件本身损坏）。先用系统默认程序看吧。</div>
    <div class="codec-hint-a">
      <button class="primary" onclick="openExternal('${encodeURIComponent(item.path)}')">用系统默认程序打开</button>
      <button onclick="this.closest('.codec-hint').remove()">知道了</button>
    </div>`;
  el.stage.appendChild(box);
}

function fmtDur(s) {
  if (!s || !isFinite(s)) return '';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}

async function showInfo(item, extra) {
  const idx = state.viewable.length > 1
    ? `<span class="idx">${String(state.index + 1).padStart(2, '0')}</span> / ${String(state.viewable.length).padStart(2, '0')}`
    : '';
  const bits = [idx, extra, fmtSize(item.size)].filter(Boolean);
  el.info.innerHTML = `<span class="fname">${escapeHtml(item.name)}</span><span class="meta">${bits.join(' · ')}</span>`;
  infoFlash(INFO_HOLD_OPEN);
}

/* ------------------------------------------------------------ 缩放 */

const MIN_SCALE = 0.04;   // 最小 4%
const MAX_SCALE = 8;      // 最大 800%

let swapSeq = 0;

function computeFit() {
  const sw = el.stage.clientWidth || 0;
  const sh = el.stage.clientHeight || 0;
  if (!sw || !sh || !natW || !natH) return 1;
  return Math.min(sw / natW, sh / natH);
}

function updateZoomBar() {
  if (!el.zoomPct || el.zoomBar.hidden) return;
  el.zoomPct.textContent = Math.round(scale * 100) + '%';
  el.zoomOut.disabled = scale <= MIN_SCALE * 1.002;
  el.zoomIn.disabled = scale >= MAX_SCALE * 0.998;
}

function applyT(img) {
  /* 盒子始终是窗口大小，图片在其中 contain 居中；
     transform 只叠加「当前比例相对铺满比例」的倍数与位移 */
  const z = fitScale > 0 ? scale / fitScale : scale;
  img.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  updateZoomBar();
  syncSource();
}

function clampPan() {
  const sw = el.stage.clientWidth || 0;
  const sh = el.stage.clientHeight || 0;
  const maxX = Math.max(0, (natW * scale - sw) / 2);
  const maxY = Math.max(0, (natH * scale - sh) / 2);
  tx = Math.min(maxX, Math.max(-maxX, tx));
  ty = Math.min(maxY, Math.max(-maxY, ty));
}

/* ox / oy 是缩放锚点，相对窗口中心 */
function applyScale(next, ox = 0, oy = 0) {
  if (!zoomEl || !natW) return;
  next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  if (Math.abs(next - scale) < 1e-5) return;
  const k = next / scale;
  tx = ox - (ox - tx) * k;
  ty = oy - (oy - ty) * k;
  scale = next;
  clampPan();
  applyT(zoomEl);
}

function zoomBy(f) {
  applyScale(scale * f, 0, 0);
}

function fitToWindow() {
  if (!zoomEl) return;
  fitScale = computeFit() || fitScale;
  scale = fitScale;
  tx = 0; ty = 0;
  applyT(zoomEl);
}

function actualSize() {
  if (!zoomEl) return;
  scale = 1;
  tx = 0; ty = 0;
  clampPan();
  applyT(zoomEl);
}

/* --- 源分级：缩小用预缩放图，放大回原图 --- */

function setupLowSource(item) {
  const ok = ['jpg', 'jpeg', 'png', 'webp'];
  if (!ok.includes(String(item.ext || '').toLowerCase())) return;
  if (!natW || !natH) return;

  const box = Math.max(el.stage.clientWidth || 0, el.stage.clientHeight || 0);
  if (!box) return;

  const dpr = window.devicePixelRatio || 1;
  const want = Math.ceil(box * dpr * 1.4);
  const level = Math.min(4096, Math.max(512, want));
  const long = Math.max(natW, natH);
  if (level >= long * 0.8) return;      // 原图本来就不大，不必换源

  loW = Math.round(level * natW / long);
  srcLo = renderUrl(item, level);
  usingLo = true;
  swapTo(srcLo);
}

function swapTo(url) {
  if (!zoomEl || !url || zoomEl.dataset.src === url) return;
  const seq = ++swapSeq;
  const pre = new Image();
  pre.onload = () => {
    if (!zoomEl || seq !== swapSeq) return;
    /* 服务端按最长边缩放，实际宽度以真解码结果为准 */
    if (url === srcLo && pre.naturalWidth) loW = pre.naturalWidth;
    zoomEl.src = url;
    zoomEl.dataset.src = url;
  };
  pre.src = url;
}

function syncSource() {
  if (!srcHi || !srcLo || !zoomEl || !loW) return;
  const need = natW * scale;
  if (usingLo && need > loW * 1.05) {
    usingLo = false;
    swapTo(srcHi);
  } else if (!usingLo && need < loW * 0.72) {
    usingLo = true;
    swapTo(srcLo);
  }
}

/* --- 交互 --- */

function bindZoom(img) {
  const stage = el.stage;

  stage.onwheel = (e) => {
    if (el.viewer.hidden || !zoomEl) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const ox = e.clientX - rect.left - rect.width / 2;
    const oy = e.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-e.deltaY * 0.0016);
    applyScale(scale * factor, ox, oy);
    showInfo(currentItem, natW + ' × ' + natH);
  };

  img.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragStart = { x: e.clientX - tx, y: e.clientY - ty };
    img.setPointerCapture(e.pointerId);
    img.classList.add('grabbing');
  });
  img.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    tx = e.clientX - dragStart.x;
    ty = e.clientY - dragStart.y;
    clampPan();
    applyT(img);
  });
  const stop = (e) => {
    dragging = false;
    img.classList.remove('grabbing');
    if (img.hasPointerCapture && img.hasPointerCapture(e.pointerId)) {
      img.releasePointerCapture(e.pointerId);
    }
  };
  img.addEventListener('pointerup', stop);
  img.addEventListener('pointercancel', stop);

  /* 双击在「适应窗口」与「原始大小」之间切换 */
  img.addEventListener('dblclick', () => {
    if (Math.abs(scale - computeFit()) < 0.02) actualSize();
    else fitToWindow();
  });
}

/* ------------------------------------------------------------ 面板 */

function showPanel() {
  el.panelBody.innerHTML = panelContent();
  el.panel.hidden = false;
  refreshAssoc();
}

async function refreshAssoc() {
  const row = document.getElementById('assocRow');
  if (!row) return;
  try {
    const d = await (await fetch('/api/assoc')).json();
    if (!d.frozen) {
      row.innerHTML = '<span class="assoc-label">文件关联</span><span class="assoc-state">请用 BNImage.exe 运行后再注册</span>';
      return;
    }
    row.innerHTML = d.registered
      ? '<span class="assoc-label">文件关联</span><span class="assoc-state on">已注册</span>'
        + '<button class="assoc-btn" onclick="openSettings()">设为默认</button>'
      : '<span class="assoc-label">文件关联</span><span class="assoc-state">未注册</span>'
        + '<button class="assoc-btn" onclick="doRegister(this)">注册为看图程序</button>';
  } catch (e) { /* 忽略 */ }
}

window.doRegister = async (btn) => {
  if (btn) { btn.disabled = true; btn.textContent = '注册中…'; }
  try {
    const d = await (await fetch('/api/register')).json();
    toast(d.ok ? '已注册，正在打开默认应用设置' : (d.msg || '注册失败'));
  } catch (e) {
    toast('注册失败');
  }
  refreshAssoc();
};

window.openSettings = () => { fetch('/api/settings'); };

function closePanel() {
  el.panel.hidden = true;
}

function panelContent() {
  const row = (k, v, cls = '') => `<div class="fmt-group"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  return `
  <h1>BNImage</h1>
  <p class="sub">统一文件查看器 · v1.0 · 本地只读</p>

  <h2>支持的格式</h2>
  ${row('照片与位图', 'JPG JPEG JPE JFIF PJPG PNG APNG GIF WEBP AVIF BMP DIB ICO CUR<br>TIF TIFF HEIC HEIF HIF PPM PGM PBM PNM')}
  ${row('图形与矢量', 'SVG SVGZ<br><span class="dim">AI（PDF 兼容部分以 PDF 方式打开）· RAW 相机原片暂不解码</span>')}
  ${row('视频', 'MP4 M4V MOV WEBM OGV OGG TS M2TS MTS MKV AVI WMV FLV F4V MPG MPEG VOB 3GP 3G2<br><span class="dim">能否播放取决于系统与浏览器内的编码支持，失败时可一键交给系统播放器</span>')}
  ${row('文档', 'PDF<br><span class="dim">使用内置阅读器，可翻页、缩放、搜索</span>')}
  ${row('网页', 'HTML HTM XHTML<br><span class="dim">沙箱内渲染，可直接查看本地导出的作品页</span>')}
  ${row('不纳入', '<span class="x">PPT PPTX PPS PPSX POT POTX KEY ODP</span><br><span class="dim">按需求明确排除演示文稿，避免与浏览器内置行为冲突</span>')}

  <h2>操作</h2>
  <div class="kbd-grid">
    <div class="kbd-row"><span>切换上一张 / 下一张</span><span class="keys"><kbd>←</kbd><kbd>→</kbd></span></div>
    <div class="kbd-row"><span>返回网格</span><span class="keys"><kbd>Esc</kbd></span></div>
    <div class="kbd-row"><span>放大 / 缩小</span><span class="keys"><kbd>+</kbd><kbd>−</kbd><kbd>滚轮</kbd></span></div>
    <div class="kbd-row"><span>还原视图</span><span class="keys"><kbd>0</kbd></span></div>
    <div class="kbd-row"><span>输入文件夹路径</span><span class="keys"><kbd>Ctrl</kbd><kbd>L</kbd></span></div>
    <div class="kbd-row"><span>视频播放 / 暂停</span><span class="keys"><kbd>空格</kbd></span></div>
    <div class="kbd-row"><span>全屏</span><span class="keys"><kbd>F</kbd></span></div>
    <div class="kbd-row"><span>本面板</span><span class="keys"><kbd>?</kbd></span></div>
  </div>

  <h2>系统关联</h2>
  <div class="assoc-row" id="assocRow">
    <span class="assoc-label">文件关联</span>
    <span class="assoc-state">读取中…</span>
  </div>
  <p>注册后，右键图片 → 打开方式里会出现 <em>BNImage</em>；在「设置 → 默认应用」里还能一次性把所有图片格式都交给它。Windows 不允许程序自行夺取默认地位，最后这一步必须你自己点。</p>

  <h2>说明</h2>
  <p>所有文件只在你的电脑上被读取，不上传、不联网、不修改原文件。缩略图缓存在程序目录的 <code>.cache</code> 中，可随时删除。</p>

  <div class="panel-foot"><span>BNImage 1.3</span><span>Esc 关闭</span></div>`;
}

/* ------------------------------------------------------------ 地址栏 */

function openLocate() {
  el.locate.hidden = false;
  el.locateInput.value = state.path || '';
  el.locateInput.focus();
  el.locateInput.select();
}

function closeLocate() {
  el.locate.hidden = true;
}

function submitLocate() {
  const v = el.locateInput.value.trim().replace(/^"|"$/g, '');
  closeLocate();
  if (!v) return;
  load(v);
}

/* ------------------------------------------------------------ 图片编辑 */

function openEditorFor(item) {
  if (!item || item.kind !== 'image') return;
  if (!window.BNImageEditor) {
    toast('编辑器还没准备好');
    return;
  }
  window.BNImageEditor.open(item);
}

/* 编辑器退出：viewer 还在原位，什么都不用做 */
function onEditorClosed() { /* 保留钩子 */ }

/* 保存完成：刷新目录并定位到结果文件 */
async function onEditorSaved(path, over) {
  const dir = String(path).replace(/[\\/][^\\/]+$/, '');
  const key = normPath(path);
  if (over) {
    const cur = state.viewable[state.index];
    if (cur && normPath(cur.path) === key) {
      cur.rev = Date.now();
      delete cur.size;
      renderViewer();
      return;
    }
  }
  await load(dir);
  const hit = state.viewable.find((i) => normPath(i.path) === key);
  if (hit) {
    openViewer(hit);
  } else {
    toast('已保存到 ' + path);
  }
}

/* ------------------------------------------------------------ 外部打开 */
window.openExternal = async (encoded) => {
  const p = decodeURIComponent(encoded);
  try {
    const r = await fetch(`/api/open?path=${encodeURIComponent(p)}`);
    const d = await r.json();
    if (!d.ok) toast('无法调用系统程序');
  } catch (e) {
    toast('无法调用系统程序');
  }
};

/* ------------------------------------------------------------ 事件 */

function handleResize() {
  if (!zoomEl || el.viewer.hidden) return;
  const wasFit = Math.abs(scale - fitScale) < 0.012;
  const nextFit = computeFit();
  if (!nextFit) return;
  fitScale = nextFit;
  /* 原本贴着窗口的，跟着窗口一起变；用户手动缩放过的不动 */
  if (wasFit) scale = Math.min(1, fitScale);
  clampPan();
  applyT(zoomEl);
}

function bindEvents() {
  window.addEventListener('resize', () => {
    syncCellHeight();
    handleResize();
  });
  /* 窗口宽度变化、滚动条出现/消失都会改变列宽，行高跟着重算 */
  if (window.ResizeObserver) new ResizeObserver(() => syncCellHeight()).observe(el.grid);
  $('#btnTheme').onclick = () => applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  $('#btnInfo').onclick = showPanel;
  $('#btnGrid').onclick = () => toggleViewMode();
  $('#btnLocate').onclick = openLocate;

  el.close.onclick = () => closeViewer();
  el.prev.onclick = () => step(-1);
  el.next.onclick = () => step(1);
  el.edit.onclick = () => openEditorFor(currentItem);

  /* 翻页按钮默认隐身：指针进到图标外扩 NAV_PAD 之内才浮出，
     其余区域按钮不接管指针，画面拖动/点击完全不受影响 */
  const NAV_PAD = 22;
  let navTick = 0;
  const revealNav = (x, y) => {
    navTick = 0;
    [el.prev, el.next].forEach((zone) => {
      if (!zone || zone.classList.contains('off')) return;
      const r = zone.getBoundingClientRect();
      const near = x >= r.left - NAV_PAD && x <= r.right + NAV_PAD &&
                   y >= r.top - NAV_PAD && y <= r.bottom + NAV_PAD;
      zone.classList.toggle('near', near);
    });
  };
  el.viewer.addEventListener('mousemove', (e) => {
    if (navTick || el.viewer.hidden) return;
    const x = e.clientX, y = e.clientY;
    navTick = requestAnimationFrame(() => revealNav(x, y));
  });
  const hideNav = () => {
    el.prev.classList.remove('near');
    el.next.classList.remove('near');
  };
  el.viewer.addEventListener('mouseleave', hideNav);
  /* 指针跑到顶栏、边框上时按钮也不该赖着 */
  window.addEventListener('mousemove', (e) => {
    if (navTick || el.viewer.hidden) return;
    const x = e.clientX, y = e.clientY;
    if (el.viewer.contains(e.target)) return;
    navTick = requestAnimationFrame(() => revealNav(x, y));
  });
  window.addEventListener('blur', hideNav);

  el.zoomIn.onclick = () => zoomBy(1.25);
  el.zoomOut.onclick = () => zoomBy(0.8);
  el.zoomFit.onclick = () => fitToWindow();
  el.zoomOne.onclick = () => actualSize();
  el.zoomPct.onclick = () => actualSize();
  /* 拖按钮时不触发舞台上的指针事件 */
  el.zoomBar.addEventListener('pointerdown', (e) => e.stopPropagation());

  /* 鼠标滑动时露一下，停手 0.7s 就收；拖动画面/缩放的当口不再弹 */
  el.stage.addEventListener('mousemove', () => {
    if (!currentItem || dragging) return;
    const now = Date.now();
    if (now - lastInfoMove < 120 && el.info.classList.contains('show')) return;
    lastInfoMove = now;
    infoFlash(INFO_HOLD_MOVE);
  });
  el.stage.addEventListener('pointerleave', infoHide);
  el.stage.addEventListener('pointerdown', infoHide);

  el.panel.onclick = (e) => { if (e.target === el.panel) closePanel(); };

  el.locateInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitLocate();
    if (e.key === 'Escape') closeLocate();
    e.stopPropagation();
  });
  el.locateInput.addEventListener('blur', () => setTimeout(closeLocate, 120));

  el.grid.addEventListener('scroll', () => {
    el.bar.classList.toggle('scrolled', el.grid.scrollTop > 4);
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (document.body.classList.contains('in-editor')) return;
    const typing = document.activeElement === el.locateInput;

    if (e.key === 'Escape') {
      if (!el.panel.hidden) return closePanel();
      if (!el.locate.hidden) return closeLocate();
      if (!el.viewer.hidden) return closeViewer();
      return;
    }
    if (typing) return;

    if (e.key === '?' || (e.key === '/' && e.shiftKey)) { e.preventDefault(); return showPanel(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); return openLocate(); }
    if (e.key === 'g' || e.key === 'G') {
      e.preventDefault();
      return toggleViewMode();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
      e.preventDefault();
      return toggleViewMode();
    }

    if (!el.viewer.hidden) {
      const vid = el.stage.querySelector('video');
      if (!e.ctrlKey && !e.metaKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        return openEditorFor(currentItem);
      }
      switch (e.key) {
        case 'ArrowRight': case 'ArrowDown': e.preventDefault(); return step(1);
        case 'ArrowLeft': case 'ArrowUp': e.preventDefault(); return step(-1);
        case '+': case '=': e.preventDefault(); return zoomBy(1.25);
        case '-': case '_': e.preventDefault(); return zoomBy(0.8);
        case '0': e.preventDefault(); return fitToWindow();
        case '1': e.preventDefault(); return actualSize();
        case ' ': if (vid) { e.preventDefault(); vid.paused ? vid.play() : vid.pause(); } return;
        default: break;
      }
    }

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // 关闭窗口时通知服务退出
  window.addEventListener('beforeunload', () => {
    try { navigator.sendBeacon('/api/bye'); } catch (e) { /* 忽略 */ }
  });

  // 拖拽：把文件夹拖进窗口直接打开（仅在支持时）
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    const f = dt.files && dt.files[0];
    if (f && f.path) { load(f.path); return; }
    const item = dt.items && dt.items[0];
    if (item && item.webkitGetAsEntry) {
      const entry = item.webkitGetAsEntry();
      if (entry && entry.isDirectory) {
        toast('浏览器不提供文件夹的完整路径，请用 Ctrl+L 粘贴路径');
      }
    }
  });
}

/* ------------------------------------------------------------ 启动 */

async function openFilePath(p) {
  try {
    const meta = await (await fetch('/api/meta?path=' + encodeURIComponent(p))).json();
    if (!meta || meta.error) {
      toast('打不开这个文件：' + (meta && meta.error ? meta.error : p));
      return false;
    }
    const dir = p.replace(/[\\/][^\\/]*$/, '') || p;
    const d = await (await fetch('/api/list?path=' + encodeURIComponent(dir))).json();
    if (!d || d.error) {
      toast('无法读取所在文件夹：' + dir);
      return false;
    }
    state.path = d.path;
    state.items = d.items || [];
    state.viewable = state.items.filter((i) => i.kind !== 'dir');
    viewMemo = null;
    pendingView = null;
    renderCrumbs(d.crumbs || []);
    renderGrid(d);
    /* 服务端返回的路径可能和传入的大小写/斜杠不同，按不敏感比较 */
    const it = state.viewable.find((x) => normPath(x.path) === normPath(p));
    if (it) openViewer(it);
    else toast('已定位到文件夹，这张图不在可预览列表里');
    return true;
  } catch (e) {
    toast('打开失败：' + (e && e.message ? e.message : e));
    return false;
  }
}

/* ------------------------------------------------------------ 外部唤起 */

/* 长轮询：没有目标时服务端挂着不回，双击图片能立刻跳转，也不空转。
   关键：这条通道如果只有一条，一旦某个请求变成"僵尸"——连接还在、页面
   已经不处理（浏览器把请求挂起、渲染进程被换掉、页面进后台）——目标就会
   被这条死连接吞掉：服务端以为送到了，页面其实没收到。表现就是关掉一张图
   后再双击另一张毫无反应，只有刷新页面才恢复（刷新等于换掉所有连接）。
   所以这里四重保险：
   ① 每个请求都带超时，绝不无限等待；
   ② 收到目标必须回执 /api/ack，不回的会在 2.5 秒后重新变成可投递；
   ③ 失败退避后继续同一循环，不退出；超过 12 秒无应答就整体重建；
   ④ 窗口获得焦点时再兜底取一次，绕过那条可能已经死掉的连接。 */

const POLL_WAIT = 10;              /* 服务端挂起秒数 */
let pollToken = 0;                 /* 每次重置自增，旧循环自动作废 */
let activeCtl = null;              /* 当前请求，重置时主动中断 */
let lastPollOK = Date.now();
let pollStarted = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 回执：告诉服务端"这个目标我真的收到了，别再投了" */
function ack(id) {
  if (!id) return;
  fetch(`/api/ack?id=${id}`, { cache: 'no-store' }).catch(() => { /* 回执丢了也无妨 */ });
}

function takeRoute(d) {
  if (!d || !d.path) return;
  ack(d.id);
  try {
    handleRoute(d.path, d.dir);
  } catch (e) {
    toast('打开失败：' + (e && e.message ? e.message : e));
  }
}

async function pollOnce(wait) {
  const ctl = new AbortController();
  activeCtl = ctl;
  const timer = setTimeout(() => ctl.abort(), wait * 1000 + 4000);
  try {
    const r = await fetch(`/api/pending?wait=${wait}`, { cache: 'no-store', signal: ctl.signal });
    const d = await r.json();
    lastPollOK = Date.now();
    takeRoute(d);
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
    if (activeCtl === ctl) activeCtl = null;
  }
}

async function pollLoop() {
  const my = ++pollToken;
  while (my === pollToken) {
    const t0 = Date.now();
    const ok = await pollOnce(POLL_WAIT);
    if (my !== pollToken) return;
    if (!ok) {
      await sleep(1200);                    /* 断线：退避后接着来，不退出 */
      continue;
    }
    if (Date.now() - t0 < 250) await sleep(300);   /* 服务端没挂起，别空转 */
  }
}

function restartPolling() {
  if (activeCtl) { try { activeCtl.abort(); } catch (e) { /* 忽略 */ } }
  pollLoop();
}

/* 兜底取一次：wait=0 立刻返回，有新目标就处理掉。
   通道挂死时，这条新连接往往还能通——等于绕过那条死连接。 */
async function checkNow() {
  try {
    const r = await fetch('/api/pending?wait=0', { cache: 'no-store' });
    const d = await r.json();
    takeRoute(d);
    return true;
  } catch (e) {
    return false;
  }
}

function nudge() {
  /* 回到窗口：先把积压的目标取走，通道长时间没应答就重建 */
  checkNow();
  if (Date.now() - lastPollOK > 2500) restartPolling();
}

function startPolling() {
  if (pollStarted) return;
  pollStarted = true;
  pollLoop();
  setInterval(() => {
    const stale = Date.now() - lastPollOK;
    if (stale > 4000) checkNow();          /* 兜底取走积压目标 */
    if (stale > 12000) restartPolling();   /* 通道确实死了，重建 */
  }, 4000);
  window.addEventListener('focus', nudge);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') nudge();
  });
}

/* 路径比较：Windows 下大小写与斜杠方向都不敏感，任一形式都可能出现 */
const normPath = (s) => String(s || '').replace(/\//g, '\\').toLowerCase();

async function handleRoute(p, isDir) {
  if (isDir) return load(p);
  const hit = state.viewable.find((x) => normPath(x.path) === normPath(p));
  if (hit) {
    if (el.viewer.hidden) openViewer(hit);
    else {
      state.index = state.viewable.indexOf(hit);
      renderViewer();
    }
    return;
  }
  await openFilePath(p);
}

async function boot() {
  initTheme();
  bindEvents();
  /* 尽早建立接管通道：启动器只等约 1 秒，晚了就会被判成"页面没接单" */
  setTimeout(startPolling, 60);

  const params = new URLSearchParams(location.search);
  const qf = params.get('file');
  if (qf && await openFilePath(qf)) return;

  if (params.get('panel')) setTimeout(showPanel, 120);

  const qp = params.get('path');
  const last = qp || localStorage.getItem('bnimage.path');
  if (last) {
    try {
      const r = await fetch(`/api/list?path=${encodeURIComponent(last)}`);
      const d = await r.json();
      if (!d.error && d.items) {
        state.path = d.path;
        state.items = d.items;
        state.viewable = state.items.filter((i) => i.kind !== 'dir');
        renderCrumbs(d.crumbs || []);
        renderGrid(d);
        return;
      }
    } catch (err) { /* 忽略，回退到根 */ }
  }
  await renderRoot();
}

boot();

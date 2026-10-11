/* imgport 前端
 *
 * 发送方（无 ?r 参数）：选文件 → 生成二维码 → 等接收方 → 协商 WebRTC
 *   - 全部 DataChannel 打开   → P2P 直连，文件切 SLOTS 个分段并行传输
 *   - 收到 relay-mode         → 关闭 PeerConnection，打开 SLOTS 条数据 WebSocket
 *                               经服务器并行中转
 * 接收方（?r=房间号）：连接即等待 → 自动接收 → 自动保存 + 缩略图网格
 *
 * 数据帧格式（DataChannel 与数据 WebSocket 通用）：
 *   [u16 文件序号(小端)][u16 分段号(小端)][文件内容分片]
 * 每个文件切 SLOTS 个连续分段，分段 p 走槽位 p（段内有序），接收端按
 * 「已收字节 = 文件大小」判定完成并按分段顺序拼接。
 * 控制消息为 JSON 文本帧，统一走控制 WebSocket。
 */
'use strict';

/* ================= 通用工具 ================= */

const $ = (sel, root) => (root || document).querySelector(sel);

function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 3);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fileIcon(name, mime) {
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return '🎬';
  if (/^audio\//.test(mime)) return '🎵';
  return '📄';
}

function fileKind(name, mime) {
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(name)) return '图片';
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return '视频';
  return '文件';
}

const ROOM = new URLSearchParams(location.search).get('r');
const FORCE_RELAY = new URLSearchParams(location.search).get('relay') === '1';

const ICE_SERVERS = [{
  urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
}];

const SLOTS = 3;                 // 并行数据通道数（DataChannel 或数据 WebSocket）
const DC_CHUNK = 16 * 1024;      // DataChannel 单帧上限（跨浏览器安全值）
const RELAY_CHUNK = 64 * 1024;   // WebSocket 中转分片
const DC_HIGH_WATER = 1024 * 1024;        // DataChannel 背压阈值
const RELAY_HIGH_WATER = 2 * 1024 * 1024; // WebSocket 背压阈值

function wsUrl(room, role, slot) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws?r=${encodeURIComponent(room)}&role=${role}`;
  if (slot != null) url += '&slot=' + slot;
  return url;
}

/* ================= 页面骨架 ================= */

const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6" fill="#fff" stroke="none"/><path d="M5 17.5l4.5-4 3 2.7 3.5-3.2L20 16.5"/></svg>`;

function renderShell() {
  $('#app').innerHTML = `
    <header class="hero">
      <div class="logo">${LOGO_SVG}</div>
      <div class="hero-text">
        <h1>快传</h1>
        <p>图片视频无损传输 · 扫码即收</p>
      </div>
      <div class="hero-actions" id="heroActions" hidden></div>
    </header>
    <main id="main"></main>
  `;
}

/* ================= 发送方 ================= */

let S = null; // 发送方状态

function initSender() {
  S = {
    files: [],
    room: null,
    ws: null,          // 控制 WebSocket（信令与控制消息）
    dataWs: [],        // 中转模式的数据 WebSocket（按槽位）
    pc: null,
    dc: [],            // P2P 模式的 DataChannel（按槽位）
    dcOpen: 0,
    dataWsOpen: 0,
    receiverReady: false,
    onReceiverReady: null,
    closing: false,    // 主动关闭 WS（销毁房间）时不触发报错提示
    token: localStorage.getItem('imgport.token') || '',
    tiles: [],         // {wrap, ring, check} 每个文件的缩略图环引用
    thumbUrls: [],
    thumbGen: 0,       // 缩略图队列版本号，列表变化即递增
    gen: 0,            // 传输代数，接收方重连时自增以中止旧循环
    transfer: { started: false, mode: null, finished: false, sent: 0, total: 0, fileSent: [] },
    lastUi: 0,
    lastBytes: 0,
    lastTime: 0,
  };

  $('#main').innerHTML = `
    <section class="card" id="pickCard">
      <!-- 发送面板：生成后置顶显示（二维码 + 状态进度），文件预览在下方 -->
      <div id="sendPanel" hidden>
        <h2 class="panel-title">用接收方手机扫码</h2>
        <div class="qr-row">
          <div class="qr-box-wrap">
            <div class="qr-box loading" id="qrBox">二维码生成中…</div>
            <button class="qr-refresh" id="btnReqr" title="刷新二维码">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>
              </svg>
            </button>
          </div>
          <div class="send-info">
            <div class="status-line"><span class="dot" id="stDot"></span><span id="stText">等待接收方扫码…</span><span class="mode-badge" id="modeBadge" hidden></span></div>
            <div class="progress" id="prog" hidden><div class="fill" id="progFill"></div></div>
            <div class="progress-meta" id="progMeta" hidden><span id="progBytes"></span><span id="progSpeed"></span></div>
            <div class="join-url">
              <input id="joinUrl" spellcheck="false" title="接收方访问的地址，可改成局域网 IP 或公网域名">
              <button class="btn ghost" id="btnCopy">复制链接</button>
            </div>
            <div class="banner err" id="errBanner" hidden></div>
          </div>
        </div>
      </div>
      <div class="dropzone" id="dz">
        <span class="dz-circle">
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 16V7"/><path d="m8.5 10.5 3.5-3.5 3.5 3.5"/><path d="M6.5 19h11a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 7.2 10.1 4.5 4.5 0 0 0 6.5 19z"/>
          </svg>
        </span>
        <span class="dz-title">点击选择文件</span>
        <span class="dz-hint">图片与视频，可多选</span>
      </div>
      <input type="file" id="picker" multiple hidden>
      <div class="sel-bar" id="selBar" hidden>
        <span class="total-hint" id="totalHint"></span>
        <span class="sel-actions">
          <button class="link" id="btnClear">清空</button>
          <button class="btn" id="btnStart" hidden>生成二维码，开始发送</button>
        </span>
      </div>
      <ul class="fgrid" id="fileList"></ul>
    </section>
  `;

  // 顶部栏右侧的操作按钮：开始发送后显示「新建传输」，完成后显示「再传一批」
  $('#heroActions').hidden = false;
  $('#heroActions').innerHTML = `
    <button class="btn ghost sm" id="btnRestart" hidden>新建传输</button>
    <button class="btn ghost sm" id="btnReset" hidden>再传一批</button>
  `;

  const dz = $('#dz'), picker = $('#picker');
  dz.addEventListener('click', () => picker.click());
  picker.addEventListener('change', () => { addSenderFiles(picker.files); picker.value = ''; });
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('drag');
    if (e.dataTransfer.files.length) addSenderFiles(e.dataTransfer.files);
  });
  $('#btnStart').addEventListener('click', beginSend);
  $('#btnClear').addEventListener('click', clearSenderFiles);
  $('#btnReqr').addEventListener('click', refreshQr);
  $('#btnCopy').addEventListener('click', copyJoinUrl);
  $('#joinUrl').addEventListener('change', refreshQr);
  $('#btnRestart').addEventListener('click', restartSend);
  $('#btnReset').addEventListener('click', restartSend);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
  });
}

function addSenderFiles(list) {
  for (const f of list) {
    if (S.files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) continue;
    S.files.push(f);
  }
  renderSenderFiles();
}

function clearSenderFiles() {
  S.files = [];
  S.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  S.thumbUrls = [];
  renderSenderFiles();
}

function renderSenderFiles() {
  const ul = $('#fileList');
  ul.innerHTML = '';
  S.tiles = [];
  S.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  S.thumbUrls = [];
  S.thumbGen = (S.thumbGen || 0) + 1;
  const gen = S.thumbGen;
  // 先用占位图标立即渲染完整列表，缩略图由后台串行队列生成，
  // 避免一次性全尺寸解码大量原图卡住界面
  S.files.forEach((f, i) => {
    const kind = fileKind(f.name, f.type);
    const ph = kind === '图片' ? '🖼️' : kind === '视频' ? '🎬' : '📄';
    const li = h(`<li class="fitem">
      <div class="thumbwrap" style="--p:0">
        <div class="ring"></div>
        <div class="thumb-inner${kind === '文件' ? '' : ' zoomable'}">${ph}</div>
        <span class="ftag">${kind}</span>
        <button class="remove-btn" title="移除">✕</button>
        <span class="check" hidden>✓</span>
      </div>
      <div class="fname"></div>
      <div class="fsize">${fmtBytes(f.size)}</div>
    </li>`);
    li.querySelector('.fname').textContent = f.name;
    if (kind !== '文件') {
      li.querySelector('.thumb-inner').addEventListener('click', () => openPreview(f, f.name, f.size));
    }
    li.querySelector('.remove-btn').addEventListener('click', () => {
      S.files.splice(i, 1);
      renderSenderFiles();
    });
    S.tiles.push({
      wrap: li.querySelector('.thumbwrap'),
      ring: li.querySelector('.ring'),
      check: li.querySelector('.check'),
      inner: li.querySelector('.thumb-inner'),
    });
    ul.appendChild(li);
  });
  const total = S.files.reduce((a, f) => a + f.size, 0);
  const has = S.files.length > 0;
  $('#selBar').hidden = !has;
  $('#btnStart').hidden = !has;
  // 显隐与可用状态都从这里统一恢复，避免上一轮 beginSend 遗留的 disabled 卡住按钮
  $('#btnStart').disabled = !has;
  $('#totalHint').innerHTML = `已选择 <b>${S.files.length}</b> 个文件 · <b>${fmtBytes(total)}</b>`;
  runThumbQueue(gen);
}

// 串行缩略图队列：一次只解码一张，降采样到 192px，避免主界面被解码压死
async function runThumbQueue(gen) {
  for (let i = 0; i < S.files.length; i++) {
    if (gen !== S.thumbGen) return; // 列表已变化，丢弃本轮
    const f = S.files[i];
    const kind = fileKind(f.name, f.type);
    const tile = S.tiles[i];
    if (!tile) continue;
    if (kind === '视频') {
      // 视频由 <video> 异步取首帧，不阻塞
      const url = URL.createObjectURL(f);
      S.thumbUrls.push(url);
      tile.inner.innerHTML = `<video src="${url}" muted preload="metadata"></video>`;
      const v = tile.inner.querySelector('video');
      v.addEventListener('error', () => { if (gen === S.thumbGen) tile.inner.innerHTML = '🎬'; });
      continue;
    }
    if (kind !== '图片') continue;
    const url = await makeThumb(f);
    if (gen !== S.thumbGen) { if (url) URL.revokeObjectURL(url); return; }
    if (url && S.tiles[i]) {
      S.tiles[i].inner.innerHTML = `<img src="${url}" alt="">`;
      S.thumbUrls.push(url);
    }
  }
}

async function makeThumb(f) {
  try {
    let bmp;
    try {
      bmp = await createImageBitmap(f, { resizeWidth: 192, resizeHeight: 192 });
    } catch { /* 不支持缩放参数时全尺寸解码再由画布缩小 */
      bmp = await createImageBitmap(f);
    }
    const scale = Math.min(192 / bmp.width, 192 / bmp.height, 1);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null; // HEIC 等桌面端无法解码 → 保持占位图标
  }
}

/* ---------- 原图预览（灯箱） ---------- */

function openPreview(blob, name, size) {
  closePreview();
  const kind = fileKind(name, blob.type);
  const url = URL.createObjectURL(blob);
  const box = h(`<div class="lightbox" id="lightbox">
    <button class="lb-close" title="关闭">✕</button>
    ${kind === '图片'
      ? `<img src="${url}" alt="">`
      : `<video src="${url}" controls playsinline></video>`}
    <div class="lb-caption"></div>
  </div>`);
  box.querySelector('.lb-caption').textContent = `${name} · ${fmtBytes(size)}`;
  if (kind === '图片') {
    // HEIC 等格式浏览器无法解码时提示原样可传
    box.querySelector('img').addEventListener('error', () => {
      box.querySelector('img').replaceWith(h(`<div class="lb-fallback">🖼️<br>该格式无法在线预览<br>文件会原样传输，不影响接收</div>`));
    });
  }
  box.querySelector('.lb-close').addEventListener('click', closePreview);
  box.addEventListener('click', (e) => { if (e.target === box) closePreview(); });
  document.body.appendChild(box);
  document.body.style.overflow = 'hidden';
}

function closePreview() {
  const box = $('#lightbox');
  if (!box) return;
  const media = box.querySelector('img, video');
  if (media) {
    if (media.tagName === 'VIDEO') { try { media.pause(); } catch { /* noop */ } }
    URL.revokeObjectURL(media.src);
  }
  box.remove();
  document.body.style.overflow = '';
}

/* ---------- 密钥门禁 ---------- */

async function bootSender() {
  let required = true;
  let days = 30;
  try {
    const r = await fetch('/api/auth/info');
    const j = await r.json();
    required = !!j.required;
    days = j.days || 30;
  } catch { /* 服务不可达时直接进入，后续操作会给出明确错误 */ }

  if (required) {
    const saved = localStorage.getItem('imgport.token');
    if (saved) {
      try {
        const r = await fetch('/api/auth/check?token=' + encodeURIComponent(saved));
        if (r.ok) { initSender(); return; }
      } catch { /* 网络异常则按未登录处理 */ }
      localStorage.removeItem('imgport.token');
    }
    renderKeyGate(days);
    return;
  }
  initSender();
}

function renderKeyGate(days) {
  $('#main').innerHTML = `
    <section class="card center key-card">
      <div class="key-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15" r="1.4" fill="#fff" stroke="none"/>
        </svg>
      </div>
      <h2>请输入访问密钥</h2>
      <p class="muted" style="margin:0 0 18px">本服务仅供授权使用，验证后 ${days} 天内免输入</p>
      <input type="password" id="keyInput" class="key-input" placeholder="访问密钥" autocomplete="off" autofocus>
      <button class="btn block" id="btnKey">进入</button>
      <div class="banner err" id="keyErr" hidden></div>
    </section>
  `;
  $('#btnKey').addEventListener('click', submitKey);
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(); });
  $('#keyInput').focus();
}

async function submitKey() {
  const key = $('#keyInput').value.trim();
  if (!key) { $('#keyInput').focus(); return; }
  const btn = $('#btnKey');
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    const r = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!r.ok) throw new Error('密钥错误，请重新输入');
    const j = await r.json();
    localStorage.setItem('imgport.token', j.token);
    $('#main').innerHTML = '';
    initSender();
  } catch (e) {
    const err = $('#keyErr');
    err.hidden = false;
    err.textContent = e.message || '验证失败，请重试';
    btn.disabled = false;
    btn.textContent = '进入';
    $('#keyInput').select();
  }
}

/* ---------- 发送流程 ---------- */

async function beginSend() {
  if (!S.files.length) return;
  // 进入传输阶段：先做方向/镜像归一化（大批照片耗时较长，按钮上显示进度），
  // 再锁定文件列表
  const btn = $('#btnStart');
  btn.disabled = true;
  btn.textContent = '正在准备文件…';
  await normalizeOrientations((done, total) => {
    btn.textContent = `正在处理图片 ${done}/${total}…`;
  });
  btn.textContent = '生成二维码，开始发送';
  renderSenderFiles();
  $('#pickCard').classList.add('picked');
  $('#dz').hidden = true;
  $('#btnClear').hidden = true;
  $('#btnStart').hidden = true;
  $('#btnStart').disabled = true;
  try {
    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: S.token ? { 'X-Token': S.token } : undefined,
    });
    if (!res.ok) throw new Error(res.status === 401 ? '密钥已失效，请刷新页面重新输入' : '创建房间失败，请重试');
    const { id } = await res.json();
    S.room = id;
  } catch (e) {
    setSenderStatus('err', e.message || '创建房间失败，请重试');
    $('#pickCard').classList.remove('picked');
    $('#dz').hidden = false;
    $('#btnClear').hidden = false;
    $('#btnStart').hidden = false;
    $('#btnStart').disabled = false;
    return;
  }

  $('#sendPanel').hidden = false;
  $('#btnRestart').hidden = false;
  $('#btnReset').hidden = true;
  $('#joinUrl').value = `${location.origin}/?r=${S.room}`;
  await refreshQr();
  openSenderWs();
}

async function refreshQr() {
  const url = $('#joinUrl').value.trim();
  if (!url) return;
  S.qrText = url;
  const box = $('#qrBox');
  box.classList.add('loading');
  box.textContent = '二维码生成中…';
  try {
    const res = await fetch('/api/qr?text=' + encodeURIComponent(url));
    if (!res.ok) throw new Error();
    const svg = await res.text();
    box.classList.remove('loading');
    box.innerHTML = svg;
  } catch {
    box.textContent = '二维码生成失败，请重试';
  }
}

async function copyJoinUrl() {
  const url = $('#joinUrl').value.trim();
  const btn = $('#btnCopy');
  let ok = false;
  if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(url); ok = true; } catch { /* 无权限时降级 */ }
  }
  if (!ok) {
    // 非 HTTPS（如局域网 IP）或剪贴板 API 被拒时的降级方案
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  btn.textContent = ok ? '已复制 ✓' : '复制失败';
  setTimeout(() => { btn.textContent = '复制链接'; }, 1600);
}

function openSenderWs() {
  let url = wsUrl(S.room, 'sender');
  if (S.token) url += '&token=' + encodeURIComponent(S.token);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => {
    S.closing = false;
    sendWsCtl({ t: 'meta', files: S.files.map((f) => fileMeta(f)) });
    setSenderStatus('', '等待接收方扫码…');
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') senderOnCtl(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    if (!S.closing && !S.transfer.finished) setSenderStatus('err', '与服务器的连接已断开，请刷新页面重试');
  };
}

function fileMeta(f) {
  return { name: f.name, size: f.size, mime: f.type || '' };
}

function sendWsCtl(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function senderOnCtl(msg) {
  switch (msg.t) {
    case 'peer-joined':
      senderResetRound();
      setSenderStatus('', '接收方已连接，正在尝试 P2P 直连…');
      senderWebRTC();
      break;
    case 'sdp': // 接收方的 answer
      if (S.pc && msg.type === 'answer') {
        S.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }).catch(() => {});
      }
      break;
    case 'ice':
      if (S.pc && msg.candidate) {
        S.pc.addIceCandidate(msg.candidate).catch(() => {});
      }
      break;
    case 'ready':
      S.receiverReady = true;
      break;
    case 'relay-mode': {
      if (S.transfer.started && S.transfer.mode === 'p2p') break; // P2P 已在传输，忽略
      S.transfer.mode = 'relay';
      teardownPc();
      (async () => {
        try {
          await openSenderDataWs();
          const t0 = Date.now();
          while (!S.receiverReady && Date.now() - t0 < 8000) await sleep(50);
          startPump('relay');
        } catch {
          setSenderStatus('err', '建立中转连接失败');
          $('#btnReset').hidden = false;
        }
      })();
      break;
    }
    case 'received':
      S.transfer.doneCount = (S.transfer.doneCount || 0) + 1;
      if (S.tiles[msg.i]) {
        S.tiles[msg.i].wrap.classList.remove('sent', 'sending');
        S.tiles[msg.i].wrap.classList.add('ack');
        S.tiles[msg.i].check.hidden = false;
      }
      break;
    case 'peer-left':
      if (!S.transfer.finished) setSenderStatus('', '接收方已断开，等待新的扫码…');
      break;
    case 'cancel':
      if (!S.transfer.finished) setSenderStatus('err', '接收方已取消');
      break;
  }
}

function senderResetRound() {
  S.gen++;
  S.transfer = { started: false, mode: null, finished: false, sent: 0, total: 0, fileSent: [] };
  S.lastBytes = 0; S.lastTime = 0;
  S.tiles.forEach((t) => {
    t.wrap.className = 'thumbwrap';
    t.wrap.style.setProperty('--p', 0);
    t.check.hidden = true;
  });
  $('#modeBadge').hidden = true;
  $('#errBanner').hidden = true;
  $('#btnRestart').hidden = false;
  $('#btnReset').hidden = true;
  $('#prog').hidden = true;
  $('#progMeta').hidden = true;
}

function senderWebRTC() {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  S.pc = pc;
  S.dc = [];
  S.dcOpen = 0;
  // SLOTS 条 DataChannel：文件切成 SLOTS 个分段，分段 p 走通道 p 并行传输
  for (let p = 0; p < SLOTS; p++) {
    const dc = pc.createDataChannel('data' + p, { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = DC_HIGH_WATER;
    dc.onopen = () => {
      S.dcOpen++;
      if (S.dcOpen === SLOTS && !S.transfer.started && S.transfer.mode !== 'relay') startPump('p2p');
    };
    dc.onclose = () => {
      if (S.transfer.mode === 'p2p' && !S.transfer.finished) {
        setSenderStatus('err', 'P2P 连接中断，请让接收方重新扫码');
        sendWsCtl({ t: 'cancel' });
        $('#btnReset').hidden = false;
      }
    };
    S.dc.push(dc);
  }
  pc.onicecandidate = (e) => { if (e.candidate) sendWsCtl({ t: 'ice', candidate: e.candidate }); };
  pc.createOffer()
    .then(async (offer) => {
      await pc.setLocalDescription(offer);
      sendWsCtl({ t: 'sdp', type: 'offer', sdp: pc.localDescription.sdp });
    })
    .catch(() => {
      // WebRTC 完全不可用时直接中转
      if (!S.transfer.started) {
        S.transfer.mode = 'relay';
        teardownPc();
        (async () => {
          await openSenderDataWs();
          const t0 = Date.now();
          while (!S.receiverReady && Date.now() - t0 < 8000) await sleep(50);
          startPump('relay');
        })();
      }
    });
}

function teardownPc() {
  if (S.pc) { try { S.pc.close(); } catch { /* noop */ } }
  S.pc = null;
  S.dc = [];
  S.dcOpen = 0;
}

/* ---------- 中转模式的数据连接 ---------- */

function openSenderDataWs() {
  return new Promise((resolve) => {
    let opened = 0;
    S.dataWs = [];
    for (let p = 0; p < SLOTS; p++) {
      let url = wsUrl(S.room, 'sender', p);
      if (S.token) url += '&token=' + encodeURIComponent(S.token);
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => { if (++opened === SLOTS) resolve(); };
      ws.onerror = () => {};
      ws.onclose = () => {};
      S.dataWs[p] = ws;
    }
    setTimeout(resolve, 8000); // 兜底：超时后由 sendSlot 的状态检查兜底报错
  });
}

/* ---------- 销毁当前房间，回到选择阶段重新开始 ---------- */

function restartSend() {
  try { sendWsCtl({ t: 'cancel' }); } catch { /* 对端可能已不在线 */ }
  S.gen++;              // 终止进行中的发送循环
  S.closing = true;     // 主动关闭，不走 onclose 的报错提示
  teardownPc();
  S.dataWs.forEach((w) => { try { w.close(); } catch { /* noop */ } });
  S.dataWs = [];
  S.receiverReady = false;
  if (S.ws) { try { S.ws.close(); } catch { /* noop */ } S.ws = null; }
  // 发送方 WebSocket 关闭后，服务器会自动销毁房间并通知接收方
  senderResetRound();
  clearSenderFiles();
  $('#sendPanel').hidden = true;
  $('#btnRestart').hidden = true;
  $('#btnReset').hidden = true;
  $('#pickCard').classList.remove('picked');
  $('#dz').hidden = false;
  $('#btnClear').hidden = false;
}

function setSenderStatus(kind, text) {
  $('#stDot').className = 'dot' + (kind ? ' ' + kind : '');
  $('#stText').textContent = text;
}

// 发送方与接收方共用：更新各自页面上存在的模式徽标
function setModeBadge(mode) {
  for (const id of ['modeBadge', 'rBadge']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.hidden = false;
    if (mode === 'p2p') { b.textContent = 'P2P 直连'; b.className = 'mode-badge p2p'; }
    else { b.textContent = '服务器中转'; b.className = 'mode-badge relay'; }
  }
}

/* ---------- 并行传输泵 ----------
 * 每个文件切成 SLOTS 个连续分段，分段 p 走槽位 p；
 * 各分段并行发送（读预取流水线：读下一块与发送当前块重叠），
 * 槽位独立背压（bufferedAmount），接收端按段号重组。 */

async function startPump(mode) {
  const T = S.transfer;
  if (T.started) return;
  T.started = true;
  T.mode = mode;
  T.gen = S.gen;
  T.total = S.files.reduce((a, f) => a + f.size, 0);
  T.fileSent = new Array(S.files.length).fill(0);
  setModeBadge(mode);
  setSenderStatus(mode === 'p2p' ? 'p2p' : '', mode === 'p2p' ? 'P2P 直连已建立，开始传输…' : '已切换服务器中转，开始传输…');
  $('#prog').hidden = false;
  $('#progMeta').hidden = false;
  sendWsCtl({ t: 'meta', files: S.files.map((f) => fileMeta(f)) });

  try {
    for (let i = 0; i < S.files.length; i++) {
      if (T.gen !== S.gen) return;
      T.cur = i;
      if (S.tiles[i]) S.tiles[i].wrap.classList.add('sending');
      sendWsCtl({ t: 'file-start', i, parts: SLOTS, ...fileMeta(S.files[i]) });
      await sendFileParallel(i, mode);
      if (T.gen !== S.gen) return;
      sendWsCtl({ t: 'file-end', i });
      const t = S.tiles[i];
      if (t) {
        t.wrap.classList.remove('sending');
        t.wrap.classList.add('sent');
        t.ring.style.setProperty('--p', 100);
      }
    }
    sendWsCtl({ t: 'complete' });
    T.finished = true;
    T.sent = T.total;
    $('#progFill').style.width = '100%';
    $('#progBytes').textContent = `${fmtBytes(T.total)} / ${fmtBytes(T.total)}`;
    $('#btnRestart').hidden = true;
    $('#btnReset').hidden = false;
    setSenderStatus('ok', '全部传输完成');
  } catch (e) {
    if (T.gen === S.gen) {
      setSenderStatus('err', '传输出错：' + (e && e.message ? e.message : '连接已断开'));
      sendWsCtl({ t: 'error' });
      $('#btnReset').hidden = false;
    }
  }
}

async function sendFileParallel(i, mode) {
  const f = S.files[i];
  const partSize = Math.ceil(f.size / SLOTS);
  const parts = [];
  for (let p = 0; p < SLOTS; p++) {
    parts.push({ start: Math.min(p * partSize, f.size), end: Math.min((p + 1) * partSize, f.size) });
  }
  await Promise.all(parts.map((part, p) => (part.start < part.end ? sendPart(i, p, part, f, mode) : Promise.resolve())));
}

async function sendPart(i, p, part, f, mode) {
  const T = S.transfer;
  const chunkSize = mode === 'p2p' ? DC_CHUNK : RELAY_CHUNK;
  let off = part.start;
  let pending = readChunk(f, off, Math.min(off + chunkSize, part.end));
  while (off < part.end) {
    if (T.gen !== S.gen) return;
    const buf = await pending;
    const next = off + buf.byteLength;
    // 读预取流水线：发送当前块的同时预读下一块
    pending = next < part.end ? readChunk(f, next, Math.min(next + chunkSize, part.end)) : null;
    const frame = new Uint8Array(4 + buf.byteLength);
    frame[0] = i & 255;
    frame[1] = (i >> 8) & 255;
    frame[2] = p & 255;
    frame[3] = (p >> 8) & 255;
    frame.set(buf, 4);
    await drainSlot(p, mode);
    if (T.gen !== S.gen) return;
    sendSlot(p, mode, frame);
    off = next;
    T.sent += buf.byteLength;
    T.fileSent[i] += buf.byteLength;
    updateSenderProgress(i, (T.fileSent[i] / f.size) * 100);
  }
}

function readChunk(f, from, to) {
  return f.slice(from, to).arrayBuffer().then((ab) => new Uint8Array(ab));
}

async function drainSlot(p, mode) {
  if (mode === 'p2p') {
    const dc = S.dc[p];
    while (dc && dc.readyState === 'open' && dc.bufferedAmount > DC_HIGH_WATER) {
      await new Promise((resolve) => {
        const handler = () => { dc.removeEventListener('bufferedamountlow', handler); resolve(); };
        dc.addEventListener('bufferedamountlow', handler);
        setTimeout(resolve, 2000); // 兜底，避免事件丢失导致卡死
      });
    }
    if (!dc || dc.readyState !== 'open') throw new Error('数据通道已关闭');
  } else {
    while (S.dataWs[p] && S.dataWs[p].readyState === 1 && S.dataWs[p].bufferedAmount > RELAY_HIGH_WATER) {
      await sleep(20);
    }
  }
}

function sendSlot(p, mode, frame) {
  if (mode === 'p2p') {
    if (!S.dc[p] || S.dc[p].readyState !== 'open') throw new Error('数据通道已关闭');
    S.dc[p].send(frame);
  } else {
    const ws = S.dataWs[p];
    if (!ws || ws.readyState !== 1) throw new Error('数据连接已关闭');
    ws.send(frame);
  }
}

let progTimer = 0;
function updateSenderProgress(i, filePct) {
  const now = Date.now();
  if (now - progTimer < 120) return;
  progTimer = now;
  const T = S.transfer;
  const pct = T.total ? Math.min(100, (T.sent / T.total) * 100) : 0;
  $('#progFill').style.width = pct.toFixed(1) + '%';
  $('#progBytes').textContent = `${fmtBytes(T.sent)} / ${fmtBytes(T.total)}`;
  if (T.lastTime && now > T.lastTime) {
    const speed = ((T.sent - T.lastBytes) * 1000) / (now - T.lastTime);
    $('#progSpeed').textContent = fmtBytes(speed) + '/s';
  }
  T.lastBytes = T.sent;
  T.lastTime = now;
  // 当前文件的缩略图进度环
  if (S.tiles[i]) {
    S.tiles[i].ring.style.setProperty('--p', Math.min(100, filePct).toFixed(1));
  }
}

/* ================= 接收方 ================= */

let R = null; // 接收方状态

function initReceiver() {
  R = {
    room: ROOM,
    ws: null,          // 控制 WebSocket
    dataWs: [],        // 中转模式的数据 WebSocket（按槽位）
    dataWsOpen: 0,
    readySent: false,
    pc: null,
    dc: [],            // P2P DataChannel（按槽位）
    dcOpen: 0,
    metas: null,
    pending: new Map(), // i -> {meta, parts: [][SLOTS], got}
    finalized: new Set(),
    mode: null,
    decided: false,
    got: 0,
    total: 0,
    received: 0,
    completeSeen: false,
    items: [], // {meta, url}
    tiles: [], // {wrap, ring, check, inner, filled} 缩略图网格
    lastUi: 0,
    lastBytes: 0,
    lastTime: 0,
  };

  $('#main').innerHTML = `
    <section class="card" id="rCard">
      <div class="center" id="rWait">
        <div class="spin"></div>
        <p class="muted">正在连接房间 ${ROOM} …</p>
      </div>
      <div id="rMain" hidden>
        <h2 id="rTitle">准备接收</h2>
        <div class="status-line"><span class="dot" id="rDot"></span><span id="rText">等待发送方…</span><span class="mode-badge" id="rBadge" hidden></span></div>
        <div class="progress" id="rProg" hidden><div class="fill" id="rProgFill"></div></div>
        <div class="progress-meta" id="rProgMeta" hidden><span id="rProgBytes"></span><span id="rProgSpeed"></span></div>
        <ul class="fgrid" id="rList"></ul>
        <div class="banner err" id="rErr" hidden></div>
      </div>
    </section>
  `;
  // 顶部栏右侧的快捷操作：有文件落地后可用
  $('#heroActions').hidden = false;
  $('#heroActions').innerHTML = `<button class="btn ghost sm" id="btnSaveAll" hidden>保存全部</button>`;
  $('#btnSaveAll').addEventListener('click', saveAll);

  fetch('/api/rooms/' + encodeURIComponent(ROOM))
    .then((res) => {
      if (!res.ok) throw new Error('gone');
      openReceiverWs();
    })
    .catch(() => {
      $('#rWait').innerHTML = `<p style="font-size:34px;margin:8px 0">🕳️</p>
        <p class="muted">房间不存在或已过期，<br>请让发送方重新生成二维码后再扫一次。</p>`;
    });
}

function openReceiverWs() {
  const ws = new WebSocket(wsUrl(ROOM, 'receiver'));
  ws.binaryType = 'arraybuffer';
  R.ws = ws;
  ws.onopen = () => {
    setReceiverStatus('', '已连接，等待发送方…');
    openReceiverDataWs();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') receiverOnCtl(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    if (!R.completeSeen || R.received < R.metas.length) {
      setReceiverStatus('err', '与服务器的连接已断开，请刷新重试');
    }
  };
}

// 数据槽位提前连接好，中转决策后立即可用
function openReceiverDataWs() {
  for (let p = 0; p < SLOTS; p++) {
    const ws = new WebSocket(wsUrl(ROOM, 'receiver', p));
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => { if (typeof ev.data !== 'string') onBinaryChunk(ev.data); };
    ws.onopen = () => {
      R.dataWsOpen++;
      maybeSendReady();
    };
    R.dataWs.push(ws);
  }
}

function maybeSendReady() {
  if (R.readySent || R.mode !== 'relay' || R.dataWsOpen < SLOTS) return;
  R.readySent = true;
  sendReceiverCtl({ t: 'ready' });
}

function setReceiverStatus(kind, text) {
  $('#rDot').className = 'dot' + (kind ? ' ' + kind : '');
  $('#rText').textContent = text;
}

function receiverOnCtl(msg) {
  switch (msg.t) {
    case 'meta':
      renderReceiverFiles(msg.files);
      break;
    case 'sdp':
      if (msg.type === 'offer') {
        if (FORCE_RELAY || R.mode === 'relay') {
          receiverRelayFallback();
        } else {
          receiverWebRTC(msg.sdp).catch(() => receiverRelayFallback());
        }
      }
      break;
    case 'ice':
      if (R.pc && msg.candidate) R.pc.addIceCandidate(msg.candidate).catch(() => {});
      break;
    case 'file-start': {
      if (R.finalized.has(msg.i)) break; // 已完成的文件收到迟到的控制帧，忽略
      ensurePending(msg.i, { name: msg.name, size: msg.size, mime: msg.mime });
      break;
    }
    case 'file-end': {
      const st = R.pending.get(msg.i);
      if (st && st.got >= st.meta.size && !R.finalized.has(msg.i)) {
        R.finalized.add(msg.i);
        finalizeFile(msg.i);
      }
      break;
    }
    case 'complete':
      R.completeSeen = true;
      maybeAllDone();
      break;
    case 'cancel':
      setReceiverStatus('err', '发送方已取消传输');
      break;
    case 'room-closed':
      setReceiverStatus('err', '发送方已关闭，请重新扫码');
      closeReceiverDataWs();
      break;
  }
}

function ensurePending(i, meta) {
  let st = R.pending.get(i);
  if (st) return st;
  if (R.finalized.has(i)) return null; // 已完成，忽略迟到的控制帧
  st = {
    meta,
    parts: Array.from({ length: SLOTS }, () => []),
    got: 0,
  };
  R.pending.set(i, st);
  const t = R.tiles && R.tiles[i];
  if (t) { t.wrap.classList.add('sending'); }
  $('#rProg').hidden = false;
  $('#rProgMeta').hidden = false;
  return st;
}

async function receiverWebRTC(offerSdp) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  R.pc = pc;
  R.dc = [];
  R.dcOpen = 0;
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    R.dc.push(dc);
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') receiverOnCtl(JSON.parse(ev.data));
      else onBinaryChunk(ev.data);
    };
    dc.onopen = () => {
      R.dcOpen++;
      if (!R.decided) {
        R.decided = true;
        R.mode = 'p2p';
        setModeBadge('p2p');
        setReceiverStatus('p2p', 'P2P 直连已建立，自动接收中…');
        closeReceiverDataWs(); // P2P 可用，中转通道不再需要
      }
    };
  };
  pc.onicecandidate = (e) => { if (e.candidate) sendReceiverCtl({ t: 'ice', candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (!R.decided && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
      receiverRelayFallback();
    }
  };
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendReceiverCtl({ t: 'sdp', type: 'answer', sdp: pc.localDescription.sdp });

  // P2P 打洞超时看门狗：超时未建立则自动回退到服务器中转
  setTimeout(() => {
    if (!R.decided) receiverRelayFallback();
  }, 8000);
}

function receiverRelayFallback() {
  if (R.decided) return;
  R.decided = true;
  R.mode = 'relay';
  if (R.pc) { try { R.pc.close(); } catch { /* noop */ } R.pc = null; R.dc = []; }
  setModeBadge('relay');
  setReceiverStatus('', '无法 P2P 直连，已切换服务器中转…');
  sendReceiverCtl({ t: 'relay-mode' }); // 通知发送方也切换到中转
  maybeSendReady();
}

function closeReceiverDataWs() {
  R.dataWs.forEach((w) => { try { w.close(); } catch { /* noop */ } });
  R.dataWs = [];
  R.dataWsOpen = 0;
}

function sendReceiverCtl(obj) {
  if (R.ws && R.ws.readyState === 1) R.ws.send(JSON.stringify(obj));
}

function renderReceiverFiles(files) {
  if (!files || !files.length) return;
  const first = !R.metas;
  R.metas = files;
  R.total = files.reduce((a, f) => a + f.size, 0);
  if (!first) return; // 传输开始的重复 meta，不重复渲染
  $('#rWait').hidden = true;
  $('#rMain').hidden = false;
  $('#rTitle').textContent = `准备接收 ${files.length} 个文件 · ${fmtBytes(R.total)}`;
  const ul = $('#rList');
  ul.innerHTML = '';
  R.tiles = files.map((f) => {
    const kind = fileKind(f.name, f.mime);
    const ph = kind === '图片' ? '🖼️' : kind === '视频' ? '🎬' : '📄';
    const li = h(`<li class="fitem">
      <div class="thumbwrap" style="--p:0">
        <div class="ring"></div>
        <div class="thumb-inner">${ph}</div>
        <span class="ftag">${kind}</span>
        <span class="check" hidden>✓</span>
      </div>
      <div class="fname"></div>
      <div class="fsize">${fmtBytes(f.size)}</div>
    </li>`);
    li.querySelector('.fname').textContent = f.name;
    ul.appendChild(li);
    return {
      wrap: li.querySelector('.thumbwrap'),
      ring: li.querySelector('.ring'),
      check: li.querySelector('.check'),
      inner: li.querySelector('.thumb-inner'),
      filled: false,
    };
  });
  setReceiverStatus('', '等待发送方开始传输…');
}

function onBinaryChunk(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 4) return;
  const i = u[0] | (u[1] << 8);
  const partId = u[2] | (u[3] << 8);
  if (partId >= SLOTS) return;
  // 控制帧（WebSocket）与数据帧（DataChannel/数据 WebSocket）可能乱序到达，
  // 二进制先到时从已缓存的文件清单兜底建立接收状态
  let st = R.pending.get(i);
  if (!st && R.metas && R.metas[i]) {
    st = ensurePending(i, R.metas[i]);
  }
  if (!st) return;
  const chunk = u.subarray(4);
  st.parts[partId].push(chunk);
  st.got += chunk.length;
  R.got += chunk.length;
  if (st.got >= st.meta.size) {
    if (!R.finalized.has(i)) {
      R.finalized.add(i);
      finalizeFile(i);
    }
    return;
  }
  updateReceiverProgress(i, st.meta.size ? (st.got / st.meta.size) * 100 : 100);
}

function updateReceiverProgress(i, filePct, force) {
  const now = Date.now();
  if (!force && now - R.lastUi < 120) return;
  R.lastUi = now;
  $('#rProg').hidden = false;
  $('#rProgMeta').hidden = false;
  const pct = R.total ? Math.min(100, (R.got / R.total) * 100) : 0;
  $('#rProgFill').style.width = pct.toFixed(1) + '%';
  $('#rProgBytes').textContent = `${fmtBytes(R.got)} / ${fmtBytes(R.total)}`;
  if (R.lastTime && now > R.lastTime) {
    const speed = ((R.got - R.lastBytes) * 1000) / (now - R.lastTime);
    $('#rProgSpeed').textContent = fmtBytes(speed) + '/s';
  }
  R.lastBytes = R.got;
  R.lastTime = now;
  // 当前文件的缩略图进度环
  if (i != null && R.tiles && R.tiles[i]) {
    R.tiles[i].ring.style.setProperty('--p', Math.min(100, filePct).toFixed(1));
  }
}

function finalizeFile(i) {
  const st = R.pending.get(i);
  if (!st) return;
  const blob = new Blob(st.parts.flat(), { type: st.meta.mime || '' });
  st.parts = null;
  R.pending.delete(i);
  const url = URL.createObjectURL(blob);
  R.items.push({ meta: st.meta, url });
  R.received++;
  // 缩略图：填充真实预览，绿色完成环 + 打勾，点击可预览，右下角可单独保存
  const t = R.tiles && R.tiles[i];
  if (t && !t.filled) {
    t.filled = true;
    const kind = fileKind(st.meta.name, st.meta.mime);
    if (kind === '图片') {
      t.inner.innerHTML = `<img src="${url}" alt="">`;
      // HEIC 等浏览器无法解码的原图，预览失败回退为图标
      t.inner.querySelector('img').addEventListener('error', () => { t.inner.innerHTML = '🖼️'; });
    } else if (kind === '视频') {
      t.inner.innerHTML = `<video src="${url}" muted preload="metadata"></video>`;
      t.inner.querySelector('video').addEventListener('error', () => { t.inner.innerHTML = '🎬'; });
    } else {
      t.inner.innerHTML = fileIcon(st.meta.name, st.meta.mime);
    }
    t.wrap.classList.remove('sending');
    t.wrap.classList.add('ack');
    t.ring.style.setProperty('--p', 100);
    t.check.hidden = false;
    if (kind !== '文件') {
      t.inner.classList.add('zoomable');
      t.inner.addEventListener('click', () => openPreview(blob, st.meta.name, st.meta.size));
    }
    const saveBtn = h(`<button class="tile-save" title="单独保存 ${st.meta.name}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>
      </svg>
    </button>`);
    saveBtn.addEventListener('click', () => saveOne(st.meta, url, saveBtn));
    t.wrap.appendChild(saveBtn);
  }
  autoDownload(st.meta, url, R.items.length * 350);
  $('#btnSaveAll').hidden = false;
  sendReceiverCtl({ t: 'received', i });
  maybeAllDone();
}

function saveOne(meta, url, btn) {
  const a = document.createElement('a');
  a.href = url;
  a.download = meta.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (btn) {
    btn.classList.add('saved');
    btn.title = '已保存';
    setTimeout(() => btn.classList.remove('saved'), 1500);
  }
}

function autoDownload(meta, url, delay) {
  setTimeout(() => {
    const a = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, delay || 0);
}

function saveAll() {
  R.items.forEach((it, idx) => autoDownload(it.meta, it.url, idx * 400));
}

function maybeAllDone() {
  if (!R.completeSeen || !R.metas) return;
  if (R.received < R.metas.length) return;
  R.got = R.total;
  updateReceiverProgress(null, 100, true);
  setReceiverStatus('ok', '全部接收完成');
  $('#btnSaveAll').hidden = false;
}

/* ---------- 方向/镜像归一化 ----------
 * iPhone 的实况/自拍方向与前置镜像效果存放在 HEIC/EXIF 元数据里，不同查看器解释
 * 不一致会导致接收方看到被"反转回去"的图片。发送前用浏览器解码（与拍照预览同一
 * 解码器，所见即所得）把像素烘焙成 JPEG，保证任何设备上显示完全一致。
 * PNG、视频保持字节原样；无方向标记的 JPEG 也不重编码。 */

function jpegOrientation(buf) {
  // 兼容 ArrayBuffer 输入（File.slice().arrayBuffer() 的返回值）
  if (!(buf instanceof Uint8Array)) buf = new Uint8Array(buf);
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return 1;
  let o = 2;
  while (o + 4 < buf.length) {
    if (buf[o] !== 0xFF) { o++; continue; }
    const marker = buf[o + 1];
    if (marker === 0xFF) { o++; continue; }
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { o += 2; continue; }
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS：EXIF 只在前面
    const len = (buf[o + 2] << 8) | buf[o + 3];
    if (marker === 0xE1 && len > 10 &&
        buf[o + 4] === 0x45 && buf[o + 5] === 0x78 && buf[o + 6] === 0x69 &&
        buf[o + 7] === 0x66 && buf[o + 8] === 0x00 && buf[o + 9] === 0x00) {
      const tiff = o + 10;
      const le = buf[tiff] === 0x49 && buf[tiff + 1] === 0x49;
      const rd16 = (p) => le ? buf[p] | (buf[p + 1] << 8) : (buf[p] << 8) | buf[p + 1];
      const rd32 = (p) => le
        ? (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24))
        : ((buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3]);
      const ifd = tiff + rd32(tiff + 4);
      const count = rd16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (rd16(e) === 0x0112) return rd16(e + 8); // Orientation
      }
      return 1;
    }
    o += 2 + len;
  }
  return 1;
}

async function bakeImage(f) {
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const area = img.naturalWidth * img.naturalHeight;
    const scale = Math.min(1, Math.sqrt((16 * 1024 * 1024) / area)); // 兼容 iOS 画布面积上限
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
    if (!blob) return null;
    const name = f.name.replace(/\.(heic|heif|jpe?g|tiff?)$/i, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: f.lastModified });
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function normalizeOrientations(onProgress) {
  const total = S.files.length;
  for (let i = 0; i < S.files.length; i++) {
    const f = S.files[i];
    if (onProgress) onProgress(i + 1, total);
    try {
      const isPng = f.type === 'image/png' || /\.png$/i.test(f.name);
      const isHeic = /\.(heic|heif)$/i.test(f.name) || f.type === 'image/heic' || f.type === 'image/heif';
      const isJpg = /\.(jpe?g)$/i.test(f.name) || f.type === 'image/jpeg';
      if (isPng || (!isHeic && !isJpg)) continue;
      if (isJpg && jpegOrientation(await f.slice(0, 262144).arrayBuffer()) === 1) continue;
      const replaced = await bakeImage(f);
      if (replaced) S.files[i] = replaced;
    } catch { /* 解码失败（如桌面端无 HEIC 解码器）则保持原文件 */ }
  }
}

/* ================= 启动与测试钩子 ================= */

renderShell();
if (ROOM) initReceiver();
else bootSender();

window.__test = {
  sender: {
    addFiles: (files) => addSenderFiles(files),
    start: () => beginSend(),
    state: () => S && ({
      room: S.room,
      mode: S.transfer.mode,
      started: S.transfer.started,
      finished: S.transfer.finished,
      sent: S.transfer.sent,
      total: S.transfer.total,
      rows: S.tiles.map((t) => t.wrap.className.replace('thumbwrap', '').trim() || 'wait'),
      status: $('#stText').textContent,
    }),
  },
  receiver: {
    state: () => R && ({
      mode: R.mode,
      metas: R.metas && R.metas.length,
      received: R.received,
      completeSeen: R.completeSeen,
      done: !!R.metas && R.received >= R.metas.length && R.completeSeen,
      status: $('#rText') ? $('#rText').textContent : '',
      gallery: R.items.length,
      tiles: R.tiles ? R.tiles.map((t) => t.wrap.className.replace('thumbwrap', '').trim() || 'wait') : [],
    }),
  },
};

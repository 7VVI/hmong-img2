/* 发送方：文件选择/缩略图队列、发送流程、WebRTC 协商、并行传输泵、中转数据连接 */

import { $, h, fmtBytes, sleep, fileKind, setModeBadge } from './util.js';
import { ICE_SERVERS, SLOTS, DC_CHUNK, RELAY_CHUNK, DC_HIGH_WATER, RELAY_HIGH_WATER, wsUrl } from './config.js';
import { openPreview, closePreview } from './preview.js';
import { normalizeOrientations } from './normalize.js';

let S = null; // 发送方状态

export function initSender() {
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
    transfer: { started: false, mode: null, finished: false, sent: 0, total: 0, fileSent: [], doneCount: 0 },
    lastUi: 0,
    lastBytes: 0,
    lastTime: 0,
  };

  $('#main').innerHTML = `
    <section class="card" id="pickCard">
      <!-- 发送面板：生成后置顶显示（二维码 + 状态进度），文件预览在下方 -->
      <div id="sendPanel" hidden>
        <h2 class="panel-title">快传扫码</h2>
        <div class="send-panel-col">
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
            <div class="join-url">
              <input id="joinUrl" spellcheck="false" title="接收方访问的地址">
              <button class="btn ghost" id="btnCopy">复制链接</button>
            </div>
            <div class="progress" id="prog" hidden><div class="fill" id="progFill"></div></div>
            <div class="progress-meta" id="progMeta" hidden><span id="progBytes"></span><span id="progSpeed"></span></div>
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
          <button class="btn" id="btnStart" hidden>开始发送</button>
        </span>
      </div>
      <ul class="fgrid" id="fileList"></ul>
    </section>
  `;

  // 顶部栏右侧的操作按钮：开始发送后显示「新建快传」，完成后显示「再传一批」
  $('#heroActions').hidden = false;
  $('#heroActions').innerHTML = `
    <button class="btn ghost sm" id="btnRestart" hidden>新建快传</button>
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

/* ---------- 文件选择与缩略图 ---------- */

export function addSenderFiles(list) {
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
      // preload=metadata 只加载元数据不渲染画面；seek 到首帧附近让浏览器渲染海报帧
      v.addEventListener('loadedmetadata', () => {
        try { v.currentTime = Math.min(0.1, (v.duration || 0.2) / 2); } catch { /* noop */ }
      }, { once: true });
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

/* ---------- 发送流程 ---------- */

export async function beginSend() {
  if (!S.files.length) return;
  // 进入传输阶段：先做方向/镜像归一化（大批照片耗时较长，按钮上显示进度），
  // 再锁定文件列表
  const btn = $('#btnStart');
  btn.disabled = true;
  btn.textContent = '正在准备文件…';
  await normalizeOrientations(S.files, (done, total) => {
    btn.textContent = `正在处理图片 ${done}/${total}…`;
  });
  btn.textContent = '开始发送';
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
  // 仅在安全上下文使用现代剪贴板 API；HTTP 部署（如局域网 IP）下它多为
  // undefined 或被策略拒绝，先 await 失败再降级还会丢失用户手势
  if (window.isSecureContext && navigator.clipboard) {
    try { await navigator.clipboard.writeText(url); ok = true; } catch { /* 降级 */ }
  }
  if (!ok) {
    try {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.setAttribute('readonly', '');  // 防安卓聚焦弹软键盘抢走选区
      ta.style.cssText = 'position:fixed;top:0;left:0;font-size:16px;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, url.length); // 部分安卓内核 select() 不产生选区
      ok = document.execCommand('copy');
      ta.remove();
    } catch { ok = false; }
  }
  if (!ok) {
    // 终极兜底：全选地址输入框，让用户长按手动复制
    const input = $('#joinUrl');
    input.focus();
    input.select();
    try { input.setSelectionRange(0, url.length); } catch { /* noop */ }
    btn.textContent = '长按地址复制';
    setTimeout(() => { btn.textContent = '复制链接'; }, 3000);
    return;
  }
  btn.textContent = '已复制 ✓';
  setTimeout(() => { btn.textContent = '复制链接'; }, 1600);
}

/* ---------- 控制通道（信令） ---------- */

function openSenderWs() {
  let url = wsUrl(S.room, 'sender');
  if (S.token) url += '&token=' + encodeURIComponent(S.token);
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => {
    S.closing = false;
    S.wsAttempts = 0;
    sendWsCtl({ t: 'meta', files: S.files.map((f) => fileMeta(f)) });
    if (S.transfer.started && S.transfer.mode === 'p2p' && !S.transfer.finished) {
      // P2P 传输中控制通道重连成功，数据通道不受影响
      setSenderStatus('p2p', 'P2P 传输中…');
    } else if (!S.transfer.started) {
      setSenderStatus('', '等待接收方扫码…');
    }
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') senderOnCtl(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    if (S.closing) return;
    const p2pActive = S.transfer.started && S.transfer.mode === 'p2p' && !S.transfer.finished;
    if (!p2pActive) {
      if (!S.transfer.finished) setSenderStatus('err', '与服务器的连接已断开，请刷新页面重试');
      return;
    }
    // P2P 传输中：数据走 DataChannel 不受影响，静默重连控制通道
    if ((S.wsAttempts || 0) < 12 && !S.transfer.finished) {
      S.wsAttempts = (S.wsAttempts || 0) + 1;
      setSenderStatus('p2p', 'P2P 传输中…');
      setTimeout(() => {
        if (!S.closing && !S.transfer.finished && (!S.ws || S.ws.readyState > 1)) openSenderWs();
      }, 2000);
    }
  };
}

function fileMeta(f) {
  return { name: f.name, size: f.size, mime: f.type || '' };
}

function sendWsCtl(obj) {
  const s = JSON.stringify(obj);
  if (S.ws && S.ws.readyState === 1) { S.ws.send(s); return; }
  // 控制通道断开时 P2P 传输经 DataChannel 旁路发送
  if (S.transfer.mode === 'p2p') {
    const dc = S.dc.find((d) => d && d.readyState === 'open');
    if (dc) { dc.send(s); return; }
  }
}

// 直走服务器控制通道（不经 DataChannel 旁路）：
// 旁路只通往当前活跃接收方，发给新扫码接收方的消息必须经服务器转达
function sendWsCtlDirect(obj) {
  if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj));
}

function senderOnCtl(msg) {
  switch (msg.t) {
    case 'peer-joined':
      // 传输开始后（进行中或已完成）控制通道重连会触发重复通知，忽略——
      // 数据通道仍工作，重新协商只会破坏现有连接
      if (S.transfer.started) {
        // 但若是新接收方扫码（旧的已被服务器顶替），回复会话状态让其得到明确提示
        sendWsCtlDirect({ t: 'session-state', done: !!S.transfer.finished });
        break;
      }
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
      if (!S.transfer.finished) setSenderStatus('', '接收方已断开');
      break;
    case 'cancel':
      if (!S.transfer.finished) setSenderStatus('err', '接收方已取消');
      break;
  }
}

function senderResetRound() {
  S.gen++;
  S.transfer = { started: false, mode: null, finished: false, sent: 0, total: 0, fileSent: [], doneCount: 0 };
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

/* ---------- WebRTC 协商（P2P） ---------- */

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
    dc.onmessage = (ev) => {
      // 控制通道断开时，接收方回执经 DataChannel 旁路到达
      if (typeof ev.data === 'string') senderOnCtl(JSON.parse(ev.data));
    };
    dc.onclose = () => {
      if (S.transfer.mode === 'p2p' && !S.transfer.finished) {
        setSenderStatus('err', 'P2P 连接中断');
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
  setSenderStatus(mode === 'p2p' ? 'p2p' : '', mode === 'p2p' ? 'P2P 开始传输' : '服务器开始传输');
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
    T.sent = T.total;
    $('#progFill').style.width = '100%';
    $('#progBytes').textContent = `${fmtBytes(T.total)} / ${fmtBytes(T.total)}`;
    // 端到端完成门控：等接收方逐文件保存回执后再提示完成。
    // 中转模式下服务器转发可能远慢于发送方出字节的速率（背压只保证不丢，
    // 不保证已送达），此时若发送方提前关页会销毁房间、掐断接收方。
    const deadline = Date.now() + 300000;
    while ((T.doneCount || 0) < S.files.length && Date.now() < deadline && T.gen === S.gen) {
      setSenderStatus('', `等待接收方保存完成 (${Math.min(T.doneCount || 0, S.files.length)}/${S.files.length})…`);
      await sleep(500);
    }
    if (T.gen !== S.gen) return;
    T.finished = true;
    $('#btnRestart').hidden = true;
    $('#btnReset').hidden = false;
    if ((T.doneCount || 0) >= S.files.length) {
      // 全部文件已被接收保存：通知服务器记录任务完成，
      // 之后的扫码直接提示传输已结束（一次任务只允许接收一次）
      sendWsCtlDirect({ t: 'task-done' });
      setSenderStatus('ok', '全部传输完成');
    } else {
      setSenderStatus('err', '部分文件未确认保存完成，请勿关闭本页');
    }
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

/* ---------- 对外状态（测试钩子/调试用） ---------- */

export function getState() {
  return S && ({
    room: S.room,
    mode: S.transfer.mode,
    started: S.transfer.started,
    finished: S.transfer.finished,
    sent: S.transfer.sent,
    total: S.transfer.total,
    rows: S.tiles.map((t) => t.wrap.className.replace('thumbwrap', '').trim() || 'wait'),
    status: document.getElementById('stText').textContent,
  });
}

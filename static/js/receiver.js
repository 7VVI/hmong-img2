/* 接收方：连接、WebRTC 协商、并行接收重组、完成落盘 */

import { $, h, fmtBytes, fileIcon, fileKind, setModeBadge } from './util.js';
import { ROOM, FORCE_RELAY, ICE_SERVERS, SLOTS, wsUrl } from './config.js';
import { openPreview } from './preview.js';
import { autoDownload } from './download.js';

let R = null; // 接收方状态

export function initReceiver() {
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
    sessionEnded: false, // 已收到会话结束提示（任务完成/无法加入），不再重连
    pending: new Map(), // i -> {meta, parts: [][SLOTS], got}
    finalized: new Set(),
    mode: null,
    decided: false,
    got: 0,
    total: 0,
    received: 0,
    completeSeen: false,
    items: [], // {meta, url, blob}
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

  // 连接兜底：长时间既无文件清单也无任何推进时给出明确提示，避免一直转圈
  setTimeout(() => {
    if (!R.metas && !R.decided && !R.completeSeen) {
      $('#rWait').innerHTML = `<p style="font-size:34px;margin:8px 0">⏱️</p>
        <p class="muted">连接超时，可能发送方已离开。</p>`;
      closeReceiverDataWs();
    }
  }, 30000);

  fetch('/api/rooms/' + encodeURIComponent(ROOM))
    .then((res) => {
      if (!res.ok) throw new Error('gone');
      openReceiverWs();
    })
    .catch(() => {
      $('#rWait').innerHTML = `<p style="font-size:34px;margin:8px 0">🕳️</p>
        <p class="muted">房间不存在或已过期</p>`;
    });
}

/* ---------- 控制通道 ---------- */

function openReceiverWs() {
  const ws = new WebSocket(wsUrl(ROOM, 'receiver'));
  ws.binaryType = 'arraybuffer';
  R.ws = ws;
  ws.onopen = () => {
    R.wsAttempts = 0;
    if (R.decided && R.mode === 'p2p') {
      setReceiverStatus('p2p', 'P2P 接收中…');
    } else {
      setReceiverStatus('', '已连接，等待发送方…');
    }
    // 数据槽位只在首次（决策前）预建，P2P 重连不需要也不该重复注册
    if (!R.decided) openReceiverDataWs();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') receiverOnCtl(JSON.parse(ev.data));
  };
  ws.onclose = () => {
    // 会话已结束提示已展示（任务完成或无法加入），被后续扫码顶替属预期，无需动作
    if (R.sessionEnded) return;
    // 任务已完整接收：停留在完成界面，不重连（重连会顶掉新扫码的接收方）
    if (isTaskDone()) return;
    // P2P 模式数据走 DataChannel，控制通道断开不致命，自动重连
    if (R.decided && R.mode === 'p2p') {
      if ((R.wsAttempts || 0) < 12) {
        R.wsAttempts = (R.wsAttempts || 0) + 1;
        setReceiverStatus('p2p', 'P2P 接收中…');
        setTimeout(() => { if (!R.ws || R.ws.readyState > 1) openReceiverWs(); }, 2000);
      }
      return;
    }
    if (!R.completeSeen || !R.metas || R.received < R.metas.length) {
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
        if (R.decided) break; // 已决策通道后忽略迟到的协商请求
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
    case 'session-state': {
      // 发送方会话已开始：本接收方无法加入本次传输
      R.sessionEnded = true;
      $('#rWait').hidden = true;
      $('#rMain').hidden = false;
      setReceiverStatus('err', msg.done ? '传输已结束' : '传输已终止');
      closeReceiverDataWs();
      break;
    }
    case 'cancel':
      // 任务已完整接收后，发送方后续动作（关页/再传一批）不影响完成状态
      if (isTaskDone() || R.sessionEnded) break;
      setReceiverStatus('err', '发送方已取消传输');
      break;
    case 'room-closed':
      if (isTaskDone() || R.sessionEnded) { closeReceiverDataWs(); break; }
      setReceiverStatus('err', '发送方已结束传输');
      closeReceiverDataWs();
      break;
  }
}

// 任务是否已被本接收方完整接收（完成后状态不再受发送方动作影响）
function isTaskDone() {
  return !!(R.completeSeen && R.metas && R.received >= R.metas.length);
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

/* ---------- WebRTC 协商（P2P） ---------- */

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
        setReceiverStatus('p2p', 'P2P 开始接收');
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
  setReceiverStatus('', '服务器开始接收');
  sendReceiverCtl({ t: 'relay-mode' }); // 通知发送方也切换到中转
  maybeSendReady();
}

function closeReceiverDataWs() {
  R.dataWs.forEach((w) => { try { w.close(); } catch { /* noop */ } });
  R.dataWs = [];
  R.dataWsOpen = 0;
}

function sendReceiverCtl(obj) {
  const s = JSON.stringify(obj);
  // P2P 模式优先走 DataChannel：控制通道断开时回执依然可达
  if (R.mode === 'p2p') {
    const dc = R.dc.find((d) => d && d.readyState === 'open');
    if (dc) { dc.send(s); return; }
  }
  if (R.ws && R.ws.readyState === 1) R.ws.send(s);
}

/* ---------- 接收与重组 ---------- */

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
  R.items.push({ meta: st.meta, url, blob });
  R.received++;
  // 缩略图：填充真实预览，绿色完成环 + 打勾，点击可预览
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
  }
  autoDownload(st.meta, blob, R.items.length * 350);
  sendReceiverCtl({ t: 'received', i });
  maybeAllDone();
}

function maybeAllDone() {
  if (!R.completeSeen || !R.metas) return;
  if (R.received < R.metas.length) return;
  R.got = R.total;
  updateReceiverProgress(null, 100, true);
  setReceiverStatus('ok', '全部接收完成');
}

/* ---------- 对外状态（测试钩子/调试用） ---------- */

export function getState() {
  return R && ({
    mode: R.mode,
    metas: R.metas && R.metas.length,
    received: R.received,
    completeSeen: R.completeSeen,
    done: !!R.metas && R.received >= R.metas.length && R.completeSeen,
    status: document.getElementById('rText') ? document.getElementById('rText').textContent : '',
    gallery: R.items.length,
    tiles: R.tiles ? R.tiles.map((t) => t.wrap.className.replace('thumbwrap', '').trim() || 'wait') : [],
  });
}

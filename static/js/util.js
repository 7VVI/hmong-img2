/* 通用工具：DOM、格式化、类型判断（无状态，全模块可用） */

export const $ = (sel, root) => (root || document).querySelector(sel);

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < 3);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fileIcon(name, mime) {
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return '🎬';
  if (/^audio\//.test(mime)) return '🎵';
  return '📄';
}

export function fileKind(name, mime) {
  if (/^image\//.test(mime) || /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i.test(name)) return '图片';
  if (/^video\//.test(mime) || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return '视频';
  return '文件';
}

// 发送方与接收方共用：更新各自页面上存在的模式徽标
export function setModeBadge(mode) {
  for (const id of ['modeBadge', 'rBadge']) {
    const b = document.getElementById(id);
    if (!b) continue;
    b.hidden = false;
    if (mode === 'p2p') { b.textContent = 'P2P 直连'; b.className = 'mode-badge p2p'; }
    else { b.textContent = '服务器中转'; b.className = 'mode-badge relay'; }
  }
}

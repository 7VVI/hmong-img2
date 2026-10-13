/* 原图预览（灯箱）：发送方与接收方共用 */

import { $, h, fileKind, fmtBytes } from './util.js';

export function openPreview(blob, name, size) {
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

export function closePreview() {
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

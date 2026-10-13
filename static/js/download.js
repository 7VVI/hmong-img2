/* 下载：文件名补全扩展名 + 触发落盘（发送方/接收方共用，接收方主用） */

/* 下载文件名：微信等来源的文件常没有扩展名，系统无法识别类型入库
 * （视频没扩展名就不会进相册），按 MIME 自动补全 */
const MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'image/heic': '.heic', 'image/heif': '.heif', 'image/bmp': '.bmp',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-m4v': '.m4v',
};

export function downloadName(meta) {
  const name = (meta.name || 'file').trim() || 'file';
  if (/\.[a-z0-9]{2,5}$/i.test(name)) return name;
  const ext = MIME_EXT[(meta.mime || '').toLowerCase()] || '.bin';
  return name + ext;
}

/* 触发下载。用 slice 零拷贝把 MIME 改写为 application/octet-stream：
 * 浏览器（尤其移动端微信/X5 内核）对 video/* 会接管成"边看边下载"式的
 * 内联播放下载，传输结束后页面状态变化即中断；通用文件类型则直接落盘。 */
export function triggerDownload(meta, blob) {
  const dl = blob.slice(0, blob.size, 'application/octet-stream');
  const url = URL.createObjectURL(dl);
  const a = document.createElement('a');
  a.href = url;
  a.download = downloadName(meta);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function autoDownload(meta, blob, delay) {
  setTimeout(() => triggerDownload(meta, blob), delay || 0);
}

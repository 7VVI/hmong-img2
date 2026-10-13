/* 方向/镜像归一化（发送前）
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

// 原地替换 files 数组中需要烘焙的元素（数组引用保持不变）
export async function normalizeOrientations(files, onProgress) {
  const total = files.length;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (onProgress) onProgress(i + 1, total);
    try {
      const isPng = f.type === 'image/png' || /\.png$/i.test(f.name);
      const isHeic = /\.(heic|heif)$/i.test(f.name) || f.type === 'image/heic' || f.type === 'image/heif';
      const isJpg = /\.(jpe?g)$/i.test(f.name) || f.type === 'image/jpeg';
      if (isPng || (!isHeic && !isJpg)) continue;
      if (isJpg && jpegOrientation(await f.slice(0, 262144).arrayBuffer()) === 1) continue;
      const replaced = await bakeImage(f);
      if (replaced) files[i] = replaced;
    } catch { /* 解码失败（如桌面端无 HEIC 解码器）则保持原文件 */ }
  }
}

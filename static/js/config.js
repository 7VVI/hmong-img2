/* 全局配置与协议常量 */

export const ROOM = new URLSearchParams(location.search).get('r');
export const FORCE_RELAY = new URLSearchParams(location.search).get('relay') === '1';

export const ICE_SERVERS = [{
  urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
}];

export const SLOTS = 3;                 // 并行数据通道数（DataChannel 或数据 WebSocket）
export const DC_CHUNK = 16 * 1024;      // DataChannel 单帧上限（跨浏览器安全值）
export const RELAY_CHUNK = 64 * 1024;   // WebSocket 中转分片
export const DC_HIGH_WATER = 1024 * 1024;        // DataChannel 背压阈值
export const RELAY_HIGH_WATER = 2 * 1024 * 1024; // WebSocket 背压阈值

export function wsUrl(room, role, slot) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/ws?r=${encodeURIComponent(room)}&role=${role}`;
  if (slot != null) url += '&slot=' + slot;
  return url;
}

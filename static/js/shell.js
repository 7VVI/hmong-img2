/* 页面骨架：顶栏 + 主区域挂载点 */

const LOGO_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.6" fill="#fff" stroke="none"/><path d="M5 17.5l4.5-4 3 2.7 3.5-3.2L20 16.5"/></svg>`;

export function renderShell() {
  document.getElementById('app').innerHTML = `
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

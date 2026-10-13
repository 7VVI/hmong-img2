/* 发送方密钥门禁：校验/门禁界面/令牌存取。
 * ensureSenderAccess() 返回 Promise<boolean>，通过后由入口进入发送界面。 */

import { $ } from './util.js';

export async function ensureSenderAccess() {
  let required = true;
  let days = 30;
  try {
    const r = await fetch('/api/auth/info');
    const j = await r.json();
    required = !!j.required;
    days = j.days || 30;
  } catch { /* 服务不可达时直接进入，后续操作会给出明确错误 */ }

  if (!required) return true;
  const saved = localStorage.getItem('imgport.token');
  if (saved) {
    try {
      const r = await fetch('/api/auth/check?token=' + encodeURIComponent(saved));
      if (r.ok) return true;
    } catch { /* 网络异常则按未登录处理 */ }
    localStorage.removeItem('imgport.token');
  }
  return await promptKey(days);
}

function promptKey(days) {
  return new Promise((resolve) => {
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
    $('#btnKey').addEventListener('click', () => submitKey(resolve));
    $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitKey(resolve); });
    $('#keyInput').focus();
  });
}

async function submitKey(resolve) {
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
    resolve(true);
  } catch (e) {
    const err = $('#keyErr');
    err.hidden = false;
    err.textContent = e.message || '验证失败，请重试';
    btn.disabled = false;
    btn.textContent = '进入';
    $('#keyInput').select();
  }
}

/* 入口：渲染骨架 → 门禁分流 → 进入发送方或接收方界面；
 * 组装自动化测试钩子 window.__test */

import { renderShell } from './shell.js';
import { ROOM } from './config.js';
import { ensureSenderAccess } from './auth-gate.js';
import { initSender, addSenderFiles, beginSend, getState as senderState } from './sender.js';
import { initReceiver, getState as receiverState } from './receiver.js';

renderShell();
if (ROOM) {
  initReceiver();
} else {
  ensureSenderAccess().then((ok) => { if (ok) initSender(); });
}

window.__test = {
  sender: {
    addFiles: (files) => addSenderFiles(files),
    start: () => beginSend(),
    state: () => senderState(),
  },
  receiver: {
    state: () => receiverState(),
  },
};

'use strict';
import cardKit from '../../程序/接入/_取卡.cjs';
/**
 * 假人保活（2026-10-04，老大问"能不能弄不会被清掉的假人"）
 *
 * **干嘛的**：给几个"假成员"挂上那条**一直不关的连接**（`GET /api/alive?memberId=x`）。
 *   成员"在线"的凭据就是这条连接 —— 不挂它，系统 1 秒扫一次探活、扫不到就判「连壳死」踢人
 *   （这就是早先假人注册后 2 秒就掉线的原因）。
 *
 * **不干嘛**：它**不做任何动作** —— 不接活、不交付、不验收。
 *   那些全由人（或手工工具调用）一步步做，这样前端看着才是"一步步来"。
 *
 * 跑法：node 假人保活.mjs                 （默认 8787；OFFICE_URL 可覆盖）
 *       FAKE_IDS=a,b,c node 假人保活.mjs   （指定是谁）
 * 收工：Ctrl+C（或在后台 job 里停掉）。
 */

const BASE = String(process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const IDS = String(process.env.FAKE_IDS || 'a,b,c').split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = { a: ['甲方机', '小甲'], b: ['乙方机', '小乙'], c: ['丙方机', '小丙'] };

const call = async (memberId, tool, args) => {
  const r = await fetch(BASE + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, tool, args: args || {} }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const alive = [];
for (const id of IDS) {
  const [name, nick] = NAMES[id] || [id, ''];
  // ⭐ 2026-10-05 修：**先挂连接、再报到** —— 后端那道「没连着不许调工具」的门（2026-10-04 加）
  //    会把"还没连上就跑来报到／上线"的调用直接拒掉（实测 `presence` 回 400、卡也建不上，
  //    于是后面派活被判"收件人不存在"）。正确顺序：连上（`/api/alive`）→ register → presence online
  //    —— M8 验收里就是这么走的（它第 0 步就是"先挂连接＝门的入场券"）。
  const res = await fetch(`${BASE}/api/alive?memberId=${encodeURIComponent(id)}`, {
    headers: cardKit.aliveHeaders(id),
  });
  await call(id, 'register', {
    memberId: id, sessionId: 'sess-' + id, name, nick, model: '假人-v1',
    // ⚠️ 2026-10-05 改：**不报门牌号**（原来报 `127.0.0.1:1999x`，可本脚本没起那个服务 ⇒ 探活必然 `fail` ⇒ 假警报）。
    //    规范 `接入\01` §2.4：**没有门牌号 ⇒ 判「不适用」**。
  });
  const p = await call(id, 'presence', { memberId: id, presence: 'online' });
  console.log(`[假人 ${id}] ${name}${nick ? '／' + nick : ''} —— 上线=${p.status} 连接挂着（HTTP ${res.status}）`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { console.log(`[假人 ${id}] 连接断了（要留人得重跑本脚本）`); break; }
      /* 探活每 10 秒来一次 —— **不打印**（原来会刷屏，2026-10-04 老大提的） */
    }
  })().catch(() => {});
  alive.push(id);
}
console.log(`\n假人挂好了：${alive.join(' ')} —— 只保活、不做动作。要收工就 Ctrl+C。`);
setInterval(() => {}, 3600 * 1000);

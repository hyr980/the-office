'use strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⭐ 2026-10-05 加：产出目录跟着本脚本自己走（原来写死「0.1 的 办公室\程序\产出\」）。
//    ⚠️ ESM 里没有 __dirname ⇒ 用 import.meta.url 反推本文件所在目录；
//    0.2 起 数据/日志/产出/收件 都在 运行\ 下 ⇒ 「验收\_假人」往上两级 ＝ 项目根。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = path.join(HERE, '..', '..', '运行', '产出');
/**
 * 让假人"开口"（验收\_假人\speak.mjs）—— 那把扳手，不是流程脚本
 *
 * **为什么非得有它**：后端守一条规矩「消息 source 必须等于调用者」（实测报错：
 *   `消息 source（a）必须等于调用者（fish）`）⇒ **我（fish）没法替假人发消息**；
 *   而假人只是保活脚本、不会自己说话。⇒ 用它替假人敲一句话。
 *
 * **它不是"一口气跑完的脚本"**：没有任何流程、没有等待、没有串联 ——
 *   一次只做**一步**，每一步都由人手敲一条命令。
 *
 * ⚠️ 收件人（`to`）**不能自己挑**（规范 §0 第 4 条：真值由系统推，填错当场拒 ——
 *   实测被拒过一次：`收件人由系统推：这条应发给 a（填的是 空）⇒ 拒`）
 *   ⇒ 本工具**自己去账本查**：接／交 ⇒ 那条**派活**的 `source`；验收 ⇒ 那条**交付**的 `source`。
 *
 * 用法：node speak.mjs <谁> <动作> <id> [数字] [派给谁]
 *   assign  <主任务id> <时限分钟> <派给谁>   派活
 *   ack     <子任务id>                       接活（收条）
 *   deliver <子任务id>                       交付（产出目录按规则拼：产出\<谁>\<日期>）
 *   done    <子任务id>                       验收通过
 *   over    <主任务id>                       收口（工具，不是消息）
 * 例：node speak.mjs b ack 00001-20261004080355-1
 */

const BASE = String(process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const [who, act, id, num, toWho] = process.argv.slice(2);

async function call(memberId, tool, args) {
  const r = await fetch(BASE + '/api/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, tool, args: args || {} }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function send(memberId, envelope) {
  const r = await fetch(BASE + '/api/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, envelope }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function show(tag, r) {
  const d = (r && r.body && r.body.data) || {};
  const f = (a) => `[${(a || []).map((x) => x.targetId + (x.reason ? ':' + x.reason : '')).join(' ') || '空'}]`;
  console.log(`${tag}：HTTP ${r.status} ok=${!!(r.body && r.body.ok)}`
    + ` delivered=${f(d.delivered)} silent=${f(d.silent)} skipped=${f(d.skipped)}`
    + (r.body && r.body.error ? ` error=${JSON.stringify(r.body.error)}` : ''));
}

/** 收件人真值：那条 `type` 类型的消息里、跟这个子任务有关的那条，看它是谁发的 */
async function findSender(subId, type) {
  const r = await call(who, 'read_messages', { limit: 300 });
  const msgs = (r.body && r.body.data && r.body.data.messages) || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.type !== type || !m.data) continue;
    if (m.data.task === subId) return m.source;
    if (Array.isArray(m.data.subtasks) && m.data.subtasks.some((s) => s.id === subId)) return m.source;
  }
  return null;
}
/* ⚠️ 2026-10-04 修：必须给**数字** —— 后端是按 `typeof st.timeout === 'number'` 才登记计时器的
   （`timeout.js:245`）；给字符串 ⇒ **静默不登记** ⇒ 那件永远不判超时、也不会插话（我实测踩到）。 */
const stamp = () => Number(num) || 30;
/* ⭐ 2026-10-05 改：消息 id 带上**时刻 + 随机尾**。
   原来固定是 `sp-<谁>-<动作>-<子任务>` ⇒ 同一件做**两次同一动作**（比如重派后再交一次），
   第二次会撞 M2 幂等键被**静默丢掉** —— 看起来像"消息发不出去"，其实是被当成重复消息拦了
   （今晚演示时真撞上）。每次调用都是新意图 ⇒ id 必须唯一。 */
const newId = (tag) => `sp-${who}-${tag}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const today = () => { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };

(async () => {
  if (!who || !act || !id) {
    console.log('用法：node speak.mjs <谁> <动作> <id> [数字] [派给谁]\n动作：assign <主任务id> <时限分钟> <派给谁> ／ ack ／ deliver ／ done ／ over');
    process.exit(1);
  }
  /* ⚠️ 子任务 id 别硬拼 "-1" —— 重派后会出现 "-2" 这种号（2026-10-04 实测踩到：传 "-2" 被拼成 "-2-1"
      ⇒ 账本里查不到那条派活）。⇒ 只有 assign 是"传主任务 id"，其余动作**传的就是子任务 id**。 */
  const sub = (act === 'assign') ? id + '-1' : id;

  if (act === 'assign') {
    const target = toWho || who;
    show(`${who} 派活给 ${target}`, await send(who, {
      id: newId('assign-' + id), source: who, specversion: '1.0', type: 'task.assign', to: [target],
      data: {
        task: id, title: `${who} 派给 ${target} 的活`, note: '演习：一步步来',
        subtasks: [{ to: target, id: sub, timeout: stamp(), heavy: false, note: '把东西交出来' }],
      },
    }));
    return;
  }
  if (act === 'ack' || act === 'deliver' || act === 'done') {
    const fromType = (act === 'done') ? 'task.deliver' : 'task.assign';
    const to = await findSender(sub, fromType);
    if (!to) { console.log(`查不到该发给谁（账本里没有跟 ${sub} 有关的 ${fromType}）`); process.exit(1); }
    const env = (act === 'ack')
      ? { type: 'task.ack', data: { task: sub, note: '我收到了' } }
      : (act === 'deliver')
        ? { type: 'task.deliver', data: { task: sub, where: path.join(OUT_ROOT, who, today()) } }
        : { type: 'task.status', data: { task: sub, state: 'done', note: '验收通过' } };
    const label = (act === 'ack') ? '接活' : (act === 'deliver') ? '交付' : '验收通过';
    show(`${who} ${label}（发给 ${to}）`, await send(who, {
      id: newId(`${act}-${sub}`), source: who, specversion: '1.0', to: [to], ...env,
    }));
    return;
  }
  if (act === 'reassign') {
    // 换人重派（`assignRetry` 只认派发者 ⇒ 得用派发者的名义发）
    const to = toWho || num;   /* ⚠️ 用法是 `reassign <旧子任务id> <换给谁>` ⇒ "换给谁"落在第 4 格 */
    if (!to) { console.log('用法：node speak.mjs a reassign <旧子任务id> <换给谁>'); process.exit(1); }
    const r = await call(who, 'reassign', { subId: id, to });
    console.log(`${who} 换人重派 ${id} ⇒ ${to}：HTTP ${r.status} ${JSON.stringify(r.body && (r.body.data || r.body.error))}`);
    return;
  }
  if (act === 'over') {
    const r = await call(who, 'over', { taskId: id });
    console.log(`${who} 收口：HTTP ${r.status} ${JSON.stringify(r.body && (r.body.data || r.body.error))}`);
    return;
  }
  console.log(`不认识的动作：${act}`);
  process.exit(1);
})();

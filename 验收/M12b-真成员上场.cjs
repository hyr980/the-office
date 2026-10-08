'use strict';
/**
 * 办公室 · M12b —— 让**真成员**（成员 id `fish`）上场跑一轮（不是假人）
 *
 * 用法（两步之间是"接活、交付"，由那个真 AI 用办公室工具亲自做 —— 那才叫上场）：
 *   node M12b-真成员上场.cjs 派     ← 假人 a 派一包活给 fish（子任务 1 件，时限 30 分钟）
 *   （此时 fish 会被叫醒 ⇒ 它读账本 ⇒ 发 task.ack 接活 ⇒ 做产物 ⇒ 发 task.deliver 交付）
 *   node M12b-真成员上场.cjs 收     ← 假人 a 验收通过（task.status done）＋ 收口 over
 *
 * ⭐ 判据落点：a 验收通过那条**不该叫醒 fish**（2026-10-04 新口径「打回了才叫」）。
 * 打真后端：默认 http://127.0.0.1:8787（OFFICE_URL 可覆盖）。
 */

const BASE = String(process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const ACT = String(process.argv[2] || '').trim();

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
function why(r) {
  const d = (r && r.body && r.body.data) || {};
  const f = (a) => `[${(a || []).map((x) => x.targetId + (x.reason ? ':' + x.reason : '')).join(' ') || '空'}]`;
  return `HTTP ${r.status} ok=${!!(r.body && r.body.ok)} delivered=${f(d.delivered)} silent=${f(d.silent)} skipped=${f(d.skipped)}`
    + (r.body && r.body.error ? ` error=${JSON.stringify(r.body.error)}` : '');
}

(async () => {
  const h = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
  if (!h || h.ok !== true) { console.log(`办公室没开：${BASE} 连不上`); process.exit(1); }

  if (ACT === '派' || ACT === 'give') {
    const T = (await call('a', 'next_task_id', {})).body.data.taskId;
    const S = T + '-1';
    const r = await send('a', {
      id: `m12b-assign-${S}`, source: 'a', specversion: '1.0', type: 'task.assign', to: ['fish'],
      data: {
        task: T, title: '演练·真成员上场', note: '这一包派给真成员 fish：它接、它交',
        subtasks: [{ to: 'fish', id: S, timeout: 30, heavy: false, note: '交一份东西出来' }],
      },
    });
    console.log(`主任务 ${T}　子任务 ${S}`);
    console.log(`派活：${why(r)}`);
    console.log('（fish 应该被叫醒 —— 接下来由我用工具接活、交付）');
    return;
  }

  if (ACT === '收' || ACT === 'take') {
    const tasks = (await call('a', 'list_tasks', {})).body.data.tasks;
    const mine = [];
    for (const t of tasks) for (const s of (t.subtasks || [])) if (s.to === 'fish') mine.push({ t, s });
    const last = mine[mine.length - 1];
    if (!last) { console.log('找不到派给 fish 的子任务'); process.exit(1); }
    console.log(`拿这件验收：${last.s.id}（状态 ${last.s.state}）`);
    const r1 = await send('a', {
      id: `m12b-done-${last.s.id}`, source: 'a', specversion: '1.0', type: 'task.status', to: ['fish'],
      data: { task: last.s.id, state: 'done', note: '验收通过' },
    });
    console.log(`验收通过：${why(r1)}　← ⭐ fish 应当出现在 skipped（不叫醒）`);
    const r2 = await call('a', 'over', { memberId: 'a', taskId: last.t.id });
    console.log(`收口 over：HTTP ${r2.status} ${JSON.stringify(r2.body && (r2.body.data || r2.body.error))}`);
    return;
  }

  console.log('用法：node M12b-真成员上场.cjs 派  ／  node M12b-真成员上场.cjs 收');
  process.exit(1);
})();

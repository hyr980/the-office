'use strict';
const cardKit = require('../程序/接入/_取卡.cjs');
/**
 * 办公室 · M13 慢放全流程（给老大看的版本）
 *
 * 跟 M12 的区别就一个字：**慢**。每一步之间停一下（默认 4 秒，`PACE_MS` 可调），
 * 而且**超时那一段真等到点** —— 时限是分钟级的，跑太快那些路径根本不会触发
 * （老大 2026-10-04：「别弄那么快，所有步骤放慢」「任务超时的最少是一分钟」）。
 *
 * 覆盖：① 正常链 ② 打回链 ③ **超时链（真等，约 1 分半）** ④ 拒绝链（只到 refuse，判挂那步留给人点）
 *
 * 跑法：node M13-慢放全流程.cjs
 *       PACE_MS=8000 node M13-慢放全流程.cjs     （每步停 8 秒）
 * ⚠️ 真后端（默认 8787）：只发 HTTP，不 require 后端、不清数据。
 */

const BASE = String(process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

// ⭐ 2026-10-05 加：交付时声明的产出目录 —— 原来写死「0.1 的 办公室\程序\产出\b\20261004」（连日期都写死），
//    改成跟着本脚本自己走（0.2 起 数据/日志/产出/收件 都在 运行\ 下），日期取当天 ⇒ 哪天跑都对。
const path = require('path');
const TODAY = (() => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; })();
const OUT = (who) => path.join(__dirname, '..', '运行', '产出', who, TODAY);
const PACE = Math.max(0, Number(process.env.PACE_MS || 4000));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stepNo = 0;
const step = async (label) => { stepNo++; console.log(`\n—— 第 ${stepNo} 步：${label} ——`); await sleep(PACE); };

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  const line = `[${tag}] ${name}\n         ${detail}`;
  out.push(line);
  console.log(line);                       // 边跑边看
}

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
const woke = (r, id) => { const d = (r.body && r.body.data) || {}; return (d.delivered || []).some((x) => x.targetId === id) || (d.silent || []).some((x) => x.targetId === id); };
const notWoke = (r, id) => { const d = (r.body && r.body.data) || {}; return (d.skipped || []).some((x) => x.targetId === id); };
// ⚠️ 2026-10-05 改：原来这里用 `call('boss', ...)` —— **第 0 刀之后 `boss` 的调用要带"界面口令"**
//    （壳每次启动随机生成、只在内存里，脚本拿不到）⇒ 会被拒 ⇒ 返回里没有 `data`。
//    这一处是**只读**（读任务表）⇒ 改用成员身份 `a`（它在这份脚本里就是派发者，连接在开头就挂上了）。
const taskOf = async (id) => ((await call('a', 'list_tasks', {})).body.data.tasks || []).find((x) => x.id === id);

let n = 0;
const env = (source, type, to, data, extra) => Object.assign({
  id: `m13-${source}-${++n}-${Math.random().toString(36).slice(2, 6)}`,
  source, specversion: '1.0', type, to, data,
}, extra || {});

(async () => {
  const h = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
  if (!h || h.ok !== true) { console.log(`办公室没开：${BASE} 连不上`); process.exit(1); }
  console.log(`真后端 ${BASE}　每步停 ${PACE} ms`);

  // ── ⭐ 2026-10-05 补：**先挂连接**（门落地后的入场券）──
  //   门（`bridge.js` 的 `invokeTool`）要求：调任何工具前，这个成员得挂着一条 `GET /api/alive`；
  //   唯一例外是 boss。本脚本写于门之前 ⇒ 只 register／presence 的话，**第一次调工具就被拒**
  //   （实测 2026-10-05：`next_task_id` 回来的 `data` 是空 ⇒ 脚本崩在下面要号那行）。
  //   M8／M10 当时都补过这一手，这份漏了 —— 补法照抄 M8（泵着读，别把流读干）。
  const aliveCtrls = [];
  const keepAlive = (id) => {
    const ctrl = new AbortController();
    aliveCtrls.push(ctrl);
    fetch(`${BASE}/api/alive?memberId=${id}`, { signal: ctrl.signal, headers: cardKit.aliveHeaders(id) })
      .then((r) => {
        const rd = r.body.getReader();
        const pump = () => rd.read().then(({ done }) => { if (!done) pump(); }).catch(() => {});
        pump();
      })
      .catch(() => {});
  };
  ['a', 'b', 'c'].forEach(keepAlive);
  await new Promise((r) => setTimeout(r, 400));

  for (const m of [{ id: 'a', name: '甲方机', nick: '小甲' }, { id: 'b', name: '乙方机', nick: '小乙' }, { id: 'c', name: '丙方机', nick: '小丙' }]) {
    // ⚠️ 2026-10-05 改：**不报门牌号** —— 原来报 `127.0.0.1:1999x`，可脚本没起那个服务
    //    ⇒ 办公室按规范探活必然 `fail` ⇒ 日志里塞假警报。规范 `接入\01` §2.4：**没有门牌号 ⇒ 判「不适用」**。
    await call(m.id, 'register', { memberId: m.id, sessionId: 'sess-' + m.id, name: m.name, nick: m.nick, model: '假人-v1' });
    await call(m.id, 'presence', { memberId: m.id, presence: 'online' });
  }
  await step('三个假人报到 ＋ 上线（⚠️ 三个假人**只挂连接**、不跑假人进程 —— 超时链那 90 秒就靠"没有进程替它表态"）');

  // ─────────── ① 正常链 ───────────
  const T1 = (await call('a', 'next_task_id', {})).body.data.taskId;
  const S1 = T1 + '-1';
  console.log(`\n【正常链】主任务 ${T1} ／ 子任务 ${S1}`);
  await step('a 派活给 b（30 分钟时限）');
  let r = await send('a', env('a', 'task.assign', ['b'], { task: T1, title: '慢放·正常链', note: '接 → 交 → 验收', subtasks: [{ to: 'b', id: S1, timeout: 30, heavy: false, note: '把东西交出来' }] }));
  rec(r.body && r.body.ok === true, '① a 派活成功', why(r));
  rec(woke(r, 'b'), '① 派活叫了 b', why(r));

  await step('b 接活（收条 ⇒ 应该不叫醒 a）');
  r = await send('b', env('b', 'task.ack', ['a'], { task: S1, note: '我收到了' }));
  rec(notWoke(r, 'a'), '① 收条**不叫醒** a', why(r));

  await step('b 交付（⇒ 应该叫醒 a 来验收）');
  r = await send('b', env('b', 'task.deliver', ['a'], { task: S1, where: OUT('b') }));
  rec(woke(r, 'a'), '① 交付叫了 a', why(r));

  await step('a 验收通过（⇒ 不叫醒 b）＋ 收口');
  r = await send('a', env('a', 'task.status', ['b'], { task: S1, state: 'done', note: '验收通过' }));
  rec(notWoke(r, 'b'), '① 验收通过**不叫醒** b', why(r));
  r = await call('a', 'over', { memberId: 'a', taskId: T1 });
  rec(r.body && r.body.ok === true, '① 收口 over', why(r));

  // ─────────── ② 打回链 ───────────
  const T2 = (await call('a', 'next_task_id', {})).body.data.taskId;
  const S2 = T2 + '-1';
  console.log(`\n【打回链】主任务 ${T2} ／ 子任务 ${S2}`);
  await step('a 派活给 c');
  await send('a', env('a', 'task.assign', ['c'], { task: T2, title: '慢放·打回链', note: '第一遍会被打回', subtasks: [{ to: 'c', id: S2, timeout: 30, heavy: false, note: '先交一版' }] }));
  await step('c 接 ＋ 交');
  await send('c', env('c', 'task.ack', ['a'], { task: S2, note: '我收到了' }));
  const dId = `m13-c-deliver-${S2}`;
  await send('c', env('c', 'task.deliver', ['a'], { task: S2, where: OUT('c') }, { id: dId }));
  await step('a 打回（inreplyto 指回交付）⇒ 这一声**该叫醒** c');
  r = await send('a', env('a', 'task.assign', ['c'], { task: T2, title: '慢放·打回链', note: '哪里没过：再来一遍', subtasks: [{ to: 'c', id: S2, timeout: 30, heavy: false, note: '再干一遍' }] }, { inreplyto: dId }));
  rec(woke(r, 'c'), '② 打回**叫了** c（「打回了才叫」）', why(r));
  await step('c 再接 ＋ 再交 ＋ a 通过 ＋ 收口');
  await send('c', env('c', 'task.ack', ['a'], { task: S2, note: '我收到了' }));
  await send('c', env('c', 'task.deliver', ['a'], { task: S2, where: OUT('c') }));
  await send('a', env('a', 'task.status', ['c'], { task: S2, state: 'done', note: '验收通过' }));
  r = await call('a', 'over', { memberId: 'a', taskId: T2 });
  rec(r.body && r.body.ok === true, '② 收口 over', why(r));
  const t2 = await taskOf(T2);
  rec(!!t2 && t2.rounds >= 2, '② 那件记了 2 轮', `rounds=${t2 && t2.rounds}`);

  // ─────────── ③ 超时链（真等）───────────
  const T3 = (await call('a', 'next_task_id', {})).body.data.taskId;
  const S3 = T3 + '-1';
  const WAIT = 90 * 1000;
  console.log(`\n【超时链】主任务 ${T3} ／ 子任务 ${S3}　时限 1 分钟`);
  await step('a 派活给 b，时限设 1 分钟 —— 然后 **b 故意不表态**');
  r = await send('a', env('a', 'task.assign', ['b'], { task: T3, title: '慢放·超时链', note: 'b 故意不表态，等它到点', subtasks: [{ to: 'b', id: S3, timeout: 1, heavy: false, note: '不表态' }] }));
  rec(r.body && r.body.ok === true, '③ 派活成功（1 分钟时限）', why(r));
  console.log(`\n…… 等 ${WAIT / 1000} 秒（时限到点 ＋ 系统处理）—— 这期间前端会自己动 ……`);
  await sleep(WAIT);

  await step('看系统把这件事怎么办了');
  const t3 = await taskOf(T3);
  const sub = t3 && (t3.subtasks || []).find((x) => x.id === S3);
  rec(!!sub && sub.state === 'cancelled', '③ 到点的那件被标成 cancelled',
    `子任务=[${(t3 && t3.subtasks || []).map((x) => x.id + '(' + x.state + ')').join(', ')}]`);

  // ⭐ 2026-10-05 修：这里原来只有一条「换人重派：多出了一件挂在新人名下」—— **预期写错了**：
  //    规范（`时限\01` §一）里，服务端判超时**只做三件事**：标 `cancelled` ＋ **主动通知派发者
  //    「请重派」**（四样齐）＋ 断开连接；**重派是派发者自己的动作**（规范原话「换人由派发者
  //    自行安排」）⇒ 服务端**不会**自动多出一件。⇒ 拆成"服务端该做的"＋"派发者该做的"两段。
  {
    const board = ((await call('a', 'read_messages', { limit: 200 })).body.data || {}).messages || [];
    const notice = [...board].reverse().find((m) => m.type === 'task.status' && m.source === 'system'
      && m.data && m.data.task === S3 && m.data.state === 'cancelled');
    rec(!!notice && /请重派/.test(String(notice.data.note || '')),
      '③ 服务端主动通知派发者（四样齐：谁异常 ＋ 主任务 id ＋ 子任务 id ＋「请重派」）',
      notice
        ? `source=${notice.source} to=[${(notice.to || []).join(',')}] data.task=${notice.data.task} data.state=${notice.data.state}｜note=${notice.data.note}`
        : `账本里没找到跟 ${S3} 有关的那条系统通知`);
  }

  await step('派发者 a 换人重派给 c（规范：换人由派发者自行安排）');
  r = await call('a', 'reassign', { memberId: 'a', subId: S3, to: 'c' });
  rec(r.body && r.body.ok === true, '③ 派发者重派成功（必须换人）', why(r));
  const t3b = await taskOf(T3);
  const subs3 = (t3b && t3b.subtasks) || [];
  rec(subs3.length >= 2, '③ 重派后多出一件（新 id，不复用旧号）',
    `共 ${subs3.length} 件：` + subs3.map((x) => `${x.id}→${x.to}(${x.state})`).join(' '));
  const newSub3 = subs3.find((x) => x.id !== S3);
  rec(!!newSub3 && newSub3.to === 'c', '③ 那件挂在**没试过的人**名下（＝c，不是原执行者 b）',
    newSub3 ? `${newSub3.id}→${newSub3.to}(${newSub3.state})` : '没找到新件');

  await step('新件走完（c 接 → 交 → a 通过）⇒ 整包收口');
  if (newSub3) {
    await send('c', env('c', 'task.ack', ['a'], { task: newSub3.id, note: '我收到了' }));
    await send('c', env('c', 'task.deliver', ['a'], { task: newSub3.id, where: OUT('c') }));
    await send('a', env('a', 'task.status', ['c'], { task: newSub3.id, state: 'done', note: '验收通过' }));
  }
  r = await call('a', 'over', { memberId: 'a', taskId: T3 });
  rec(r.body && r.body.ok === true, '③ 重派链走完能收口（cancelled 的老件不挡 over）', why(r));

  // ─────────── ④ 拒绝链（只到 refuse）───────────
  const T4 = (await call('a', 'next_task_id', {})).body.data.taskId;
  const S4 = T4 + '-1';
  console.log(`\n【拒绝链】主任务 ${T4} ／ 子任务 ${S4}`);
  // ⭐ 2026-10-05 修：这一段原来用 b —— 但 b 刚在超时链里被判「断开连接」（判异常的收尾动作之一），
  //    再拿 b 调工具会被门拒（实测报错原文：`没连着就不能调工具：b 现在没有接入连接`）。
  //    ⇒ 改用 c（丙方机）：它刚干完重派那件、空闲，连接也还挂着。
  await step('a 派活给 c');
  await send('a', env('a', 'task.assign', ['c'], { task: T4, title: '慢放·拒绝链', note: 'c 当场说不干', subtasks: [{ to: 'c', id: S4, timeout: 30, heavy: false, note: '这活干不了' }] }));
  await step('c 说不干（refuse）');
  r = await call('c', 'refuse', { memberId: 'c', subId: S4 });
  rec(r.body && r.body.ok === true, '④ refuse 成功（系统转告派发者）', `HTTP ${r.status} ${JSON.stringify(r.body && (r.body.data || r.body.error))}`);
  console.log('\n⚠️ 后面那步"判挂 ⇒ 弹老大 ⇒ 点我知道了"是**分钟级**的（5 分钟窗口），留给老大手动点；');
  console.log('   要看它，等窗口过了再点成员卡上的「待处理」→「我知道了」。');

  console.log('\n' + out.join('\n'));
  console.log(`\n=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
  aliveCtrls.forEach((c) => c.abort());   // ⭐ 收尾：把三条 /api/alive 连接关掉（照 M8 的做法）
  process.exit(0);
})();

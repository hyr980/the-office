'use strict';
const cardKit = require('../程序/接入/_取卡.cjs');
/**
 * 办公室 · M12 多成员全流程演练（假人 a/b/c 跑整条链）
 *
 * ⭐ **跟别的验收脚本不一样**：这份**打真后端**（默认 `http://127.0.0.1:8787`，就是壳起的那个）
 *    —— 老大要在**前端界面**上实时看着这轮跑，所以必须走同一个后端、同一份数据。
 *    ⇒ 本脚本**不 require 后端任何模块、不自己起服务、不清数据**（清数据由人先做好）。
 *
 * 覆盖的环节：
 *   ① 三个假人报到 ＋ 上线（宿主进程名 ＋ 昵称都给，前端能看出"两个名字并排"）
 *   ② 正常链：派活 → 接 → 交付 → 验收通过 → 收口
 *   ③ ⭐ 新口径实测：**收条不叫醒**、**验收通过不叫醒**、**打回要叫醒**
 *   ④ 打回链：派活 → 接 → 交 → 打回 → 再接 → 再交 → 通过
 *   ⑤ 拒绝链：派活 → 干不了（refuse）→ 系统转告派发者
 * 不覆盖：超时换人（分钟级，见 `M4-时限与兜底.cjs`）。
 *
 * 跑法：node M12-多成员全流程.cjs          （默认 8787）
 *       OFFICE_URL=http://127.0.0.1:8787 node M12-多成员全流程.cjs
 */

const BASE = String(process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');

// ⭐ 2026-10-05 加：交付时声明的产出目录 —— 原来写死「0.1 的 办公室\程序\产出\b\20261004」（连日期都写死），
//    改成跟着本脚本自己走（0.2 起 数据/日志/产出/收件 都在 运行\ 下），日期取当天 ⇒ 哪天跑都对。
const path = require('path');
const TODAY = (() => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; })();
const OUT = (who) => path.join(__dirname, '..', '运行', '产出', who, TODAY);

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
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
/** 把一条投递回执写成一行：叫了谁／该叫没推成／本来就不叫 */
function why(r) {
  const d = (r && r.body && r.body.data) || {};
  const f = (a, k) => `[${(a || []).map((x) => x.targetId + (x.reason ? ':' + x.reason : '')).join(' ') || '空'}]`;
  return `HTTP ${r.status} ok=${!!(r.body && r.body.ok)}`
    + ` delivered=${f(d.delivered)} silent=${f(d.silent)} skipped=${f(d.skipped)}`
    + (r.body && r.body.error ? ` error=${JSON.stringify(r.body.error)}` : '');
}
const woke = (r, id) => {
  const d = (r && r.body && r.body.data) || {};
  return (d.delivered || []).some((x) => x.targetId === id) || (d.silent || []).some((x) => x.targetId === id);
};
const notWoke = (r, id) => {
  const d = (r && r.body && r.body.data) || {};
  return (d.skipped || []).some((x) => x.targetId === id);
};

let n = 0;
const env = (source, type, to, data, extra) => Object.assign({
  id: `m12-${source}-${++n}-${Math.random().toString(36).slice(2, 6)}`,
  source, specversion: '1.0', type, to, data,
}, extra || {});

const NAMES = [
  { id: 'a', name: '甲方机', nick: '小甲' },
  { id: 'b', name: '乙方机', nick: '小乙' },
  { id: 'c', name: '丙方机', nick: '小丙' },
];

(async () => {
  // ── 0. 后端在不在（这份专打真后端）──
  const h = await fetch(BASE + '/health').then((r) => r.json()).catch(() => null);
  if (!h || h.ok !== true) {
    console.log(`办公室没开：${BASE} 连不上 —— 先把办公室打开再跑这份脚本。`);
    process.exit(1);
  }
  rec(true, '0 真后端活着（壳起的那个）', `${BASE} ⇒ ${JSON.stringify(h)}`);

  // ── ⭐ 2026-10-05 补：**先挂连接**（门落地后的入场券）──
  //    门（`bridge.js` 的 `invokeTool`）要求：调任何工具前这个成员得挂着一条 `GET /api/alive`；
  //    唯一例外是 boss。本脚本写于门之前、只做 register／presence ⇒ 第一次调工具就被门拒
  //    （下一步 `get_members` 拿到空、后面全崩）。M8／M10／M13 都补过这一手，这份漏了。
  const aliveCtrls = [];
  const keepAlive = (id) => {
    const ctrl = new AbortController();
    aliveCtrls.push(ctrl);
    fetch(`${BASE}/api/alive?memberId=${id}`, { signal: ctrl.signal, headers: cardKit.aliveHeaders(id) })
      .then((r) => {
        // SSE：不把流读干，连接会被判空闲关掉 ⇒ 泵着读、内容丢掉
        const rd = r.body.getReader();
        const pump = () => rd.read().then(({ done }) => { if (!done) pump(); }).catch(() => {});
        pump();
      })
      .catch(() => {});
  };
  ['a', 'b', 'c'].forEach(keepAlive);
  await new Promise((r) => setTimeout(r, 400));

  try {
    // ── 1. 三个假人报到 ＋ 上线 ──
    for (const m of NAMES) {
      await call(m.id, 'register', {
        memberId: m.id, sessionId: 'sess-' + m.id,
        name: m.name, nick: m.nick, model: '假人-v1',
        // ⚠️ 2026-10-05 改：**不报门牌号** —— 这里原来报 `127.0.0.1:1999x`，可脚本没起那个服务
        //    ⇒ 办公室按规范探活必然 `fail` ⇒ 日志里全是假警报。规范 `接入\01` §2.4：**没有门牌号 ⇒ 判「不适用」**。
        //    （脚本本来也收不到推送，"不报"才是如实。）
      });
      await call(m.id, 'presence', { memberId: m.id, presence: 'online' });
    }
    // ⚠️ 2026-10-05 改：原来这里是 `call('boss', ...)` —— **第 0 刀之后，`boss` 的调用必须带"界面口令"**
    //    （壳每次启动随机生成、只存在内存里，脚本拿不到）⇒ 会被拒 ⇒ 返回里没有 `data`
    //    ⇒ 脚本崩在 `.body.data.members`（实测「Cannot read properties of undefined (reading 'members')」）。
    //    这一处是**只读**（拿成员名单）⇒ 改用成员身份 `a`，更贴近被测的东西（成员能不能看到名单）。
    const ls = (await call('a', 'get_members', {})).body.data.members;
    const three = ls.filter((m) => ['a', 'b', 'c'].includes(m.id));
    rec(three.length === 3 && three.every((m) => m.name && m.nick),
      '1 三个假人都进了成员表（宿主进程名 ＋ 昵称都有）—— ⚠️ 假人没挂真连接 ⇒ 2 秒后会被判「连壳死」离线，这是预期，不是 bug',
      ls.map((m) => `${m.id}=${m.name}/${m.nick}:${m.presence}`).join('  '));

    // ── 2. 正常链：a 派活给 b ──
    const T1 = (await call('a', 'next_task_id', {})).body.data.taskId;
    const S1 = T1 + '-1';
    let r = await send('a', env('a', 'task.assign', ['b'], {
      task: T1, title: '演练·正常链', note: '走一遍：接 → 交 → 验收',
      subtasks: [{ to: 'b', id: S1, timeout: 30, heavy: false, note: '把东西交出来' }],
    }));
    rec(r.body && r.body.ok === true, '2a 派活（a ⇒ b）成功', why(r));
    rec(woke(r, 'b'), '2b 派活**叫了** b（该叫）', why(r));

    // ── 3. b 接（收条）── ⭐ 新口径：不叫醒 a
    r = await send('b', env('b', 'task.ack', ['a'], { task: S1, note: '我收到了' }));
    rec(r.body && r.body.ok === true, '3a b 接活（收条进账本）', why(r));
    rec(notWoke(r, 'a'), '3b ⭐ 收条**不叫醒** a（2026-10-04 新口径：「打回了才叫」）', why(r));

    // ── 4. b 交付 ── 该叫 a
    r = await send('b', env('b', 'task.deliver', ['a'], {
      task: S1, where: OUT('b'),
    }));
    rec(r.body && r.body.ok === true, '4a b 交付成功', why(r));
    rec(woke(r, 'a'), '4b 交付**叫了** a（要它来验收）', why(r));
    const t1 = (await call('a', 'list_tasks', {})).body.data.tasks.find((x) => x.id === T1);
    rec(!!t1 && t1.subtasks[0].state === 'delivered', '4c 子任务状态记成 delivered（待验）',
      JSON.stringify(t1 && t1.subtasks.map((s) => s.id + '→' + s.state)));

    // ── 5. a 验收通过 ── ⭐ 新口径：不叫醒 b
    r = await send('a', env('a', 'task.status', ['b'], { task: S1, state: 'done', note: '验收通过' }));
    rec(notWoke(r, 'b'), '5a ⭐ 验收通过**不叫醒** b（它不用知道，系统自己记账）', why(r));
    r = await call('a', 'over', { memberId: 'a', taskId: T1 });
    rec(r.body && r.body.ok === true, '5b 收口 over（子任务全 done）', why(r));

    // ── 6. 打回链：a 派活给 c → 交 → 打回 → 重交 → 通过 ──
    const T2 = (await call('a', 'next_task_id', {})).body.data.taskId;
    const S2 = T2 + '-1';
    await send('a', env('a', 'task.assign', ['c'], {
      task: T2, title: '演练·打回链', note: '第一遍会被打回',
      subtasks: [{ to: 'c', id: S2, timeout: 30, heavy: false, note: '先交一版' }],
    }));
    await send('c', env('c', 'task.ack', ['a'], { task: S2, note: '我收到了' }));
    const deliverId = `m12-c-deliver-${S2}`;
    await send('c', env('c', 'task.deliver', ['a'], { task: S2, where: OUT('c') }, { id: deliverId }));
    // 打回：信封 inreplyto 指回那条交付
    r = await send('a', env('a', 'task.assign', ['c'], {
      task: T2, title: '演练·打回链', note: '哪里没过：再来一遍',
      subtasks: [{ to: 'c', id: S2, timeout: 30, heavy: false, note: '再干一遍' }],
    }, { inreplyto: deliverId }));
    rec(r.body && r.body.ok === true, '6a 打回（inreplyto 指回那次交付）成功', why(r));
    rec(woke(r, 'c'), '6b ⭐ 打回**叫了** c（「打回了才叫」就是这一声）', why(r));
    await send('c', env('c', 'task.ack', ['a'], { task: S2, note: '我收到了' }));
    await send('c', env('c', 'task.deliver', ['a'], { task: S2, where: OUT('c') }));
    await send('a', env('a', 'task.status', ['c'], { task: S2, state: 'done', note: '验收通过' }));
    r = await call('a', 'over', { memberId: 'a', taskId: T2 });
    rec(r.body && r.body.ok === true, '6c 打回后重交 → 通过 → 收口', why(r));
    const t2 = (await call('a', 'list_tasks', {})).body.data.tasks.find((x) => x.id === T2);
    rec(!!t2 && t2.rounds >= 2, '6d 那件记了 2 轮（打回算一轮）',
      `rounds=${t2 && t2.rounds}；子任务=[${(t2 && t2.subtasks || []).map((s) => s.id + '(' + s.state + ',跑' + s.rounds + '轮)').join(', ')}]`);

    // ── 7. 拒绝链：a 派活给 b → b 干不了 ──
    const T3 = (await call('a', 'next_task_id', {})).body.data.taskId;
    const S3 = T3 + '-1';
    await send('a', env('a', 'task.assign', ['b'], {
      task: T3, title: '演练·拒绝链', note: 'b 会当场说不干',
      subtasks: [{ to: 'b', id: S3, timeout: 30, heavy: false, note: '这活干不了' }],
    }));
    r = await call('b', 'refuse', { memberId: 'b', subId: S3 });
    rec(r.body && r.body.ok === true, '7a b 干不了（refuse ⇒ 系统转告派发者 a）',
      `HTTP ${r.status} ${JSON.stringify(r.body && (r.body.data || r.body.error))}`);
    rec(null, '7b 收尾（老大点「我知道了」那一步）',
      '要等"派发者 5 分钟窗口"到点才允许点 —— 本次不占时间，留给 M4 脚本 / 老大手动点');

    // ── 8. 门：同时只有一个主任务（T3 还没收口 ⇒ 现在 a 再派应被拒）──
    r = await send('a', env('a', 'task.assign', ['c'], {
      task: (await call('a', 'next_task_id', {})).body.data.taskId, title: '演练·门', note: '应该被拒',
      subtasks: [{ to: 'c', id: 'x-1', timeout: 30, heavy: false, note: 'x' }],
    }));
    rec(r.body && r.body.ok === false && /已有主任务/.test(String(r.body.error || '')),
      '8 同时只有一个主任务（上一包没收口 ⇒ 再派被拒）', `error=${JSON.stringify(r.body && r.body.error)}`);
  } catch (e) {
    rec(false, '（脚本自身抛异常）', String((e && e.message) || e));
  }

  console.log(out.join('\n'));
  console.log('');
  console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
  aliveCtrls.forEach((c) => c.abort());   // ⭐ 收尾：把三条 /api/alive 连接关掉（照 M8 的做法）
  process.exit(0);
})();

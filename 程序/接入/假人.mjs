'use strict';

import fs from 'node:fs';
import path from 'node:path';
// ⭐ 2026-10-05：**接入手续**（那张卡）—— 测试脚本共用的取卡小工具（定位说明见 `_取卡.cjs`）
import cardKit from './_取卡.cjs';

/**
 * 假人 —— 三个假成员 a／b／c（演习／验收用）
 *
 * 干什么（每个假人四件事）：
 *   ① 报到（`register`）—— 让办公室有它那张卡；⚠️ **不报门牌号**（不需要被"叫醒"，它靠轮询账本自己读）
 *   ② 上线（`presence online`）
 *   ③ **挂住那条长连接**（`GET /api/alive`）—— 这就是"我在线"的凭据；
 *      ⚠️ 办公室**每 1 秒扫那条连接**，断了就判离线（老大原话：「别让假人被系统两秒杀掉」）
 *   ④ **看到派给自己的任务，回一条收条**（`task.ack`）—— ⚠️ 必须有：
 *      派发进账本起 5 分钟内既没 ack 也没 refuse ⇒ 判异常（规范 `01-信封` §3）
 *
 * ⚠️ 它**不监听端口、不填门牌号**：门牌号是给"办公室主动推"用的，推失败还会留脏日志；
 *    假人不需要那条路 —— 它自己轮询账本。
 *
 * 用法：node 假人.mjs [--work=<秒>] [--quiet]
 *   · `--work=<秒>`  接任务之后"干"多久才交（默认 5 秒）—— ⭐ **测"超时"时要用它设长**（例 `--work=600`）
 *   · `--quiet`      不打印
 *   （Ctrl+C 停；三个假人一起停）
 * 依据：规范 `接入\01` §2.4／`接入\02`（成员怎么接进来）、`01-信封` §3（表态）
 */

const BASE = process.env.OFFICE_URL || 'http://127.0.0.1:8787';
const POLL_MS = 1500;          // 轮询账本的间隔
/* 接任务之后"假装干"多久才交（毫秒）。
   ⚠️ 默认 5 秒 —— 留着让人看得见"干着"那个中间状态。
   ⚠️ **测"超时"时要用 `--work=<秒>` 把它设长**（例：`--work=600` ＝ 10 分钟），
      否则它 5 秒就交、超时根本造不出来。 */
const workArg = process.argv.find((a) => a.startsWith('--work='));
const WORK_SEC = workArg ? Number(workArg.slice('--work='.length)) : 5;
const WORK_MS = (Number.isFinite(WORK_SEC) && WORK_SEC >= 0 ? WORK_SEC : 5) * 1000;
/* ⭐ `--refuse=a,b`：**点名的人接任务时直接说"干不了"**（走 `refuse` 工具，不进账本）。
   用来造「执行者干不了 ⇒ 系统转告派发者重派」那个场景。 */
const refuseArg = process.argv.find((a) => a.startsWith('--refuse='));
const REFUSE = new Set((refuseArg ? refuseArg.slice('--refuse='.length) : '')
  .split(',').map((s) => s.trim()).filter(Boolean));
/* ⭐ `--noack=a,b`：**点名的人接任务时什么都不发**（不 ack、也不 refuse）。
   用来造 M11「**派发后 5 分钟不表态 ⇒ 判异常**」那个场景 —— 默认三个都秒回收条，造不出来。 */
const noackArg = process.argv.find((a) => a.startsWith('--noack='));
const NOACK = new Set((noackArg ? noackArg.slice('--noack='.length) : '')
  .split(',').map((s) => s.trim()).filter(Boolean));
const SPEAK = process.argv.includes('--quiet') ? () => {} : (...a) => console.log(...a);

/** 三个假人的样子（id 别改，改了就是新成员） */
const FAKES = [
  { id: 'a', name: '甲方机', nick: '小甲', model: '假人-v1' },
  { id: 'b', name: '乙方机', nick: '小乙', model: '假人-v1' },
  { id: 'c', name: '丙方机', nick: '小丙', model: '假人-v1' },
];

const now = () => new Date().toTimeString().slice(0, 8);

/** 调一个办公室工具 */
async function call(memberId, tool, args) {
  const res = await fetch(`${BASE}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, tool, args: args || {} }),
  });
  return await res.json();
}

/** "从什么时候起算做任务"（子任务 id → 时间戳）。
 *  ⚠️ 只用来控制"干多久才交"；**丢了无害**（重启后立刻交，反正它早算干完了）。 */
const workFrom = new Map();
/* ⭐ 已经说过"干不了"的子任务。
   ⚠️ 这个**只能记在内存** —— 因为 `refuse` 是**工具调用、不进账本**，假人没法从账本知道"我拒过了"；
      不记的话它会**每轮都再拒一次**（实测：1.5 秒一次，把系统通知刷了一屏）。
   ⚠️ 重启后最多重复拒一次，可接受（真要更严，就去查任务表看那件是不是已经 cancelled）。 */
const refused = new Set();
/* ⭐ 已经认定"不用交"的子任务（那件被系统作废了：超时／打回满轮／别人 refuse 收场…）。
   ⚠️ 为什么需要它：`refuse` 和"被取消"**都不进账本**，光看账本只会觉得"该我交"
      （2026-10-04 实测撞到：b 把一件早就取消的老任务又交了一遍）。
   ⚠️ 记内存是为了**少问几次任务表** —— 核出来一次就够，以后每轮直接跳过。 */
const skipped = new Set();

/** ① 报到 ＋ ② 上线 */
async function registerAndOnline(f) {
  const r1 = await call(f.id, 'register', {
    memberId: f.id,
    sessionId: `fake-${f.id}-${Date.now()}`,   // ⚠️ 假人没有真会话，给个稳定的假会话号
    name: f.name,
    nick: f.nick,
    model: f.model,
    // ⚠️ **不传 host**：假人没有门牌号（见文件头注释）
  });
  SPEAK(`[${now()}] ${f.id} 报到：`, r1.ok ? 'ok' : JSON.stringify(r1));
  const r2 = await call(f.id, 'presence', { memberId: f.id, presence: 'online' });
  SPEAK(`[${now()}] ${f.id} 上线：`, r2.ok ? 'ok' : JSON.stringify(r2));
}

/** ③ 挂住长连接（断了就重挂 —— 假人跟插件不同：它自己就是"接入端"，断了重挂更省事）
 *
 *  ⭐ 返回 `{ attached }`：`attached` 是**只在第一次挂上时** resolve 的 Promise。
 *     为什么要它 —— 进门顺序是「**先挂连接、再报到**」（`接入\01` §2.4 那道门，2026-10-04）：
 *     报到前得先等这一个信号，否则 `register` 会被门拒掉（"没连着"）。
 *  ⚠️ 为了拿这个信号，本函数**不再 async**（它照样一直挂着；那条死循环挪进内部匿名 async 里）。
 */
function holdAlive(f) {
  let markAttached;
  const attached = new Promise((resolve) => { markAttached = resolve; });
  (async () => {
    for (;;) {
      try {
        // ⭐ 2026-10-05：挂连接带上**接入手续**（那张卡）；没有就空手（走"新人"档放行）
        const res = await fetch(`${BASE}/api/alive?memberId=${f.id}`, { headers: cardKit.aliveHeaders(f.id) });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        SPEAK(`[${now()}] ${f.id} 连接挂上了`);
        markAttached();                    // ⭐ 第一次挂上就放行（之后重挂不再重复 resolve）
        const reader = res.body.getReader();
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
        SPEAK(`[${now()}] ${f.id} 连接被对端关掉了，2 秒后重挂`);
      } catch (e) {
        SPEAK(`[${now()}] ${f.id} 连接断了（${String((e && e.message) || e)}），3 秒后重挂`);
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  return { attached };
}

/**
 * ④ 轮询账本：有派给我的任务 ⇒ 回一条收条；收条回过、还没交的 ⇒ 干一会儿再交。
 * ⚠️ **状态全靠账本判**（谁派给我的／我 ack 过没／我交过没），不靠内存 ⇒ **假人重启也不丢**。
 */
async function watchTasks(f) {
  for (;;) {
    try {
      const r = await call(f.id, 'read_messages', { limit: 300 });
      const msgs = (r && r.data && r.data.messages) || [];

      /* ⭐ 判"这件现在该我干什么"，靠**账本里这件最后一条事件**：
         · 最后是「派发」（含**打回** —— 打回本身就是一条新的 `task.assign`）⇒ 该我干、该我交
         · 最后是「我交了」⇒ 交过了，等派发者验收
         ⚠️ "被打了回要重交"靠这个**天然成立**：打回那条会把它刷回 'assign'，不用另写一套比对。 */
      const lastEv = new Map();          // 子任务 id -> 'assign' | 'deliver'
      const fromOf = new Map();          // 子任务 id -> 派发者（最后那条派发的 source）
      const myAck = new Set();           // 我回过收条的子任务
      const deliverN = new Map();        // 子任务 id -> 我交过几次（重交要换新 id）
      for (const m of msgs) {
        if (m.type === 'task.assign' && m.data && Array.isArray(m.data.subtasks)) {
          for (const s of m.data.subtasks) {
            if (s && s.to === f.id && s.id) { lastEv.set(s.id, 'assign'); fromOf.set(s.id, m.source); }
          }
        } else if (m.source === f.id && m.type === 'task.ack' && m.data && m.data.task) {
          myAck.add(m.data.task);
        } else if (m.source === f.id && m.type === 'task.deliver' && m.data && m.data.task) {
          lastEv.set(m.data.task, 'deliver');
          deliverN.set(m.data.task, (deliverN.get(m.data.task) || 0) + 1);
        }
      }

      // 只处理"最后是派发"的（＝还没交，或者**被打回**了）
      for (const [subId, ev] of lastEv) {
        if (ev !== 'assign') continue;
        const from = fromOf.get(subId) || 'fish';

        if (!myAck.has(subId)) {
          // ① 还没表态
          // ⭐ `--noack` 点名的：**故意什么都不发**（不 ack、也不 refuse）—— 专门用来造
          //    M11「派发后 5 分钟不表态 ⇒ 判异常」那个场景。⚠️ 它会每轮都进这里，但什么都不做，
          //    那正是要的效果（"没唤醒到／唤醒了没选，结果一样"）。
          if (NOACK.has(f.id)) continue;
          if (REFUSE.has(f.id)) {
            // ⭐ `--refuse` 点名的：**说"干不了"** —— 工具调用、不进账本；系统会转告派发者
            // ⚠️ **只拒一次**（`refuse` 不进账本 ⇒ 不从账本判"拒过没"，只能靠内存那个 `refused`；
            //    不拦的话它会每轮都再拒一次，把系统通知刷屏 —— 2026-10-04 实测撞到）
            if (refused.has(subId)) continue;
            const rr = await call(f.id, 'refuse', { memberId: f.id, subId });
            if (rr && rr.ok) refused.add(subId);
            SPEAK(`[${now()}] ${f.id} 说干不了 ${subId}：`, JSON.stringify(rr));
            continue;
          }
          const env = {
            id: `${f.id}-ack-${subId}`,
            source: f.id,
            specversion: '1.0',
            type: 'task.ack',
            // ⭐ 收件人真值 ＝ 那条派发的 `source`（规范 `01` §5 第 12 条）；这里照填，系统会核对
            to: [from],
            data: { task: subId, note: '我收到了' },
          };
          const r2 = await call(f.id, 'send_message', { memberId: f.id, envelope: env });
          if (r2 && r2.ok) {
            workFrom.set(subId, Date.now());   // 从这个点起算"做任务"
            SPEAK(`[${now()}] ${f.id} 接了 ${subId}（回了收条）`);
          } else {
            SPEAK(`[${now()}] ${f.id} 回收条失败：`, JSON.stringify(r2));
          }
          continue;
        }

        // ② 表过态了 ⇒ 干满时长就交（⚠️ 被打回之后再进来，`workFrom` 是老的 ⇒ 会立刻重交）
        const started = workFrom.get(subId) || 0;
        if (started && Date.now() - started < WORK_MS) continue;
        const n = deliverN.get(subId) || 0;
        // ⭐ 2026-10-04 加：**交之前先核一眼那件是不是已经被作废了**
        //    （超时／打回满轮／别人说"干不了"收场…）。
        //    ⚠️ 为什么非得问任务表、光看账本不行：**`refuse` 和"被取消"都不进账本** ⇒
        //       按"最后一条事件"判，它只会觉得"该我交"（实测撞到：b 把一件早取消的老任务又交了一遍）。
        //    ⚠️ 只问一次：核出来是终态就记进 `skipped`，往后每轮直接跳过、不再重复问。
        if (skipped.has(subId)) continue;
        {
          const lt = await call(f.id, 'list_tasks', {});
          const tk = ((lt && lt.data && lt.data.tasks) || [])
            .find((t) => (t.subtasks || []).some((s) => s.id === subId));
          const sub = tk && tk.subtasks.find((s) => s.id === subId);
          if (sub && (sub.state === 'cancelled' || sub.state === 'done')) {
            skipped.add(subId);
            SPEAK(`[${now()}] ${f.id} 跳过 ${subId}：那件已经「${sub.state}」了，不用交`);
            continue;
          }
        }
        // 产出目录：问系统要（它会按天建好）—— 返回 `{ path, date }`
        const d = await call(f.id, 'my_dirs', { memberId: f.id });
        const dir = d && d.data && d.data.path;
        if (!dir) { SPEAK(`[${now()}] ${f.id} 拿不到产出目录，跳过 ${subId}`); continue; }
        const tag = n ? `-r${n + 1}` : '';       // ⭐ 重交要新 id（幂等按 source+id 判，别撞）
        try {
          fs.writeFileSync(path.join(dir, `交付-${subId}${tag}.txt`),
            `我是 ${f.id}，这是子任务 ${subId} 的产出（第 ${n + 1} 次交）。\n`, 'utf8');
        } catch (e) {
          SPEAK(`[${now()}] ${f.id} 写产出失败：`, String((e && e.message) || e));
          continue;
        }
        const env = {
          id: `${f.id}-deliver-${subId}${tag}`,
          source: f.id,
          specversion: '1.0',
          type: 'task.deliver',
          // ⭐ 收件人真值 ＝ 那条派发的 `source`（＝派发者）
          to: [from],
          data: { task: subId, where: dir },
        };
        const r3 = await call(f.id, 'send_message', { memberId: f.id, envelope: env });
        if (r3 && r3.ok) { workFrom.set(subId, Date.now() + WORK_MS); SPEAK(`[${now()}] ${f.id} 交了 ${subId}（第 ${n + 1} 次，产出在 ${dir}）`); }
        else SPEAK(`[${now()}] ${f.id} 交付失败：`, JSON.stringify(r3));
      }
    } catch (e) {
      /* 办公室没开／网络抖：下一轮再说，别把循环打断 */
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

(async () => {
  // 先探一下办公室在不在
  try {
    const h = await fetch(`${BASE}/health`);
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
    SPEAK(`[${now()}] 办公室在（${BASE}），三个假人这就上：${FAKES.map((f) => f.id).join(' / ')}`);
  } catch (e) {
    console.error(`[${now()}] 连不上办公室（${BASE}）：${String((e && e.message) || e)}`);
    console.error('先把办公室开起来，再跑这个。');
    process.exit(1);
  }
  // ⭐ **进门顺序：先挂连接、再报到**（`接入\01` §2.4 那道门，2026-10-04 加）——
  //    ⚠️ 反过来（先报到、再挂）的话，`register` 会被门拒掉：「没连着就不能调工具」。
  for (const f of FAKES) {
    const { attached } = holdAlive(f);   // ⚠️ 不 await 它本身 —— 那条连接要一直挂着
    await attached;                      // ⭐ 只等"第一次挂上"这一个信号
    watchTasks(f);                       // 另一个循环，也不 await
  }
  for (const f of FAKES) await registerAndOnline(f);
  SPEAK(`[${now()}] 都挂上了。Ctrl+C 停。`);
})();

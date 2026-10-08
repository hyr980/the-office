'use strict';
const cardKit = require('../程序/接入/_取卡.cjs');
/**
 * 办公室 · M8 对外接口 验收脚本（2026-10-04 按新口径重写）
 *
 * ⭐ 本份**合并**了原来的 M8-对外接口 / M8b-换人重派 / M8b-重启不丢 / M8d-全体收件人四份脚本 ——
 *    那三份的判据整段建在**"收件箱"**上（`GET /api/inbox` ＋ 插件轮询 ＋ `@all` 不算叫醒），
 *    而这个模型 2026-10-04 已整个删掉（`接入\03` §4-1）⇒ 旧判据正好相反，逐条改不如并成一份。
 *    旧三份已删（`08` §五：不留双份实现）。
 *
 * 依据：规范\接入\01-接入与连接.md §2.4（端点表）／§5.1（★ 唤醒正本：只看 `to`）；
 *      规范\08-落地结构.md §四（多口接入：口只是通道）。
 * ⚠️ 会写 <程序>\数据\ —— 跑完自己恢复（脚本末尾清一遍）
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}

function resetData() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
}

(async () => {
  resetData();
  const bridge = require(path.join(BACKEND, 'bridge.js'));
  const dl = require(path.join(BACKEND, 'data-layer.js'));

  // ── A. 起 HTTP 口（自起，随机端口；不依赖外部服务）──
  const http = bridge.startHttp(0);
  // ⭐ 2026-10-05 修（原 A11）：传 0（随机端口）时 `url` 要等 `listening` 之后才被补正成真端口
  //   —— 不 await 会拿到 `http://127.0.0.1:0`，所有 fetch 空打（见 `http-api.js` 那段注释）。
  await http.ready;
  const base = http.url;
  out.push(`         后端起在 ${base}`);
  const call = async (memberId, tool, args) => {
    const r = await fetch(base + '/api/call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, tool, args: args || {} }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const send = async (memberId, envelope) => {
    const r = await fetch(base + '/api/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId, envelope }),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  // ── A2. ⭐ 2026-10-04 加：先挂连接（门落地后的入场券）──
  //   门（`bridge.js` 的 `invokeTool`）要求：调任何工具前，这个成员得挂着一条
  //   `GET /api/alive` 连接；唯一例外是 boss。老大 2026-10-04：「裸连进来的不行，
  //   只有通过插件的可以」。本脚本写于门落地之前、直接调接口 ⇒ 10 条判据全被门拒
  //   —— 那不是代码坏了，是脚本过期。
  const aliveCtrls = [];
  const keepAlive = (id) => {
    const ctrl = new AbortController();
    aliveCtrls.push(ctrl);
    fetch(`${base}/api/alive?memberId=${id}`, { signal: ctrl.signal, headers: cardKit.aliveHeaders(id) })
      .then((r) => {
        // SSE：不把流读干，连接会被判空闲关掉 ⇒ 泵着读、内容丢掉
        const rd = r.body.getReader();
        const pump = () => rd.read().then(({ done }) => { if (!done) pump(); }).catch(() => {});
        pump();
      })
      .catch(() => {});
  };

  try {
    // ── A2b. 给 a／b／c 各挂一条连接，等后端登记完，再报到 ──
    const aliveIds = ['a', 'b', 'c'];
    aliveIds.forEach(keepAlive);
    await new Promise((r) => setTimeout(r, 400));
    rec(bridge.getState().aliveConns >= 3,
      '0. ⭐ 先挂连接（三条 /api/alive）—— 门的入场券',
      `后端报的连接数 = ${bridge.getState().aliveConns}`);

    // ── B. 健康检查 ＋ 报到 ＋ 上线 ──
    {
      const h = await fetch(base + '/health').then((r) => r.json()).catch(() => null);
      rec(!!h && h.ok === true, '1a GET /health ⇒ 通了', JSON.stringify(h));
    }
    {
      // ⚠️ 2026-10-05 改：**别报"自己没有的门牌号"**。原来这三行报了 `127.0.0.1:1900x`，
      //    可脚本**根本没起那个服务** ⇒ 办公室按规范去探活、必然 `fail` ⇒ 日志里塞满假警报
      //    （实测一轮攒了 49 条 `probe-fail`，全是这种）。
      //    规范 `接入\01` §2.4：**没有门牌号 ⇒ 判「不适用」** ⇒ 不报就是对的（脚本本来也收不到推）。
      const a = await call('a', 'register', { memberId: 'a', sessionId: 'sess-a', name: '甲' });
      const b = await call('b', 'register', { memberId: 'b', sessionId: 'sess-b', name: '乙' });
      const c = await call('c', 'register', { memberId: 'c', sessionId: 'sess-c', name: '丙' });
      rec(a.body.ok && b.body.ok && c.body.ok, '1b 三个成员报到成功（register）',
        `a=${a.body.ok} b=${b.body.ok} c=${c.body.ok}`);
      await call('a', 'presence', { memberId: 'a', presence: 'online' });
      await call('b', 'presence', { memberId: 'b', presence: 'online' });
      await call('c', 'presence', { memberId: 'c', presence: 'online' });
      const ls = (await call('boss', 'get_members', {})).body.data.members;
      const onlineIds = ls.filter((m) => m.id !== 'boss' && m.presence === 'online').map((m) => m.id).sort();
      rec(onlineIds.join(',') === 'a,b,c', '1c 三个成员都上线了（boss 恒在线，不算）',
        `在线 = ${onlineIds.join(',')}（全表：${ls.map((m) => `${m.id}:${m.presence}`).join(' ')}）`);
    }

    // ── C. POST /api/message ⇒ 账本一字不差 ──
    {
      const env = {
        id: 'm-http-1', source: 'a', specversion: '1.0', type: 'chat.message',
        to: ['b'], time: '2026-10-04T12:00:00+08:00', data: { text: '这条是 HTTP 口发的' },
      };
      const r = await send('a', env);
      rec(r.body.ok === true, '2a POST /api/message 发一条 ⇒ 成功', `HTTP ${r.status}；${JSON.stringify(r.body.error || 'ok')}`);
      const back = (await call('boss', 'read_messages', {})).body.data.messages.find((m) => m.id === 'm-http-1');
      const diffs = [];
      for (const k of ['id', 'source', 'specversion', 'type', 'to', 'data', 'time']) {
        if (JSON.stringify(back && back[k]) !== JSON.stringify(env[k])) {
          diffs.push(`${k}: 期望 ${JSON.stringify(env[k])} 实得 ${JSON.stringify(back && back[k])}`);
        }
      }
      rec(!!back && diffs.length === 0, '2b 六个字段逐字对：发出去的和读回来的一模一样',
        diffs.length ? diffs.join('；') : `读回 ${JSON.stringify({ ...env, seq: back.seq })}`);
    }

    // ── D. 各投各的（按 `to`）──
    {
      const r1 = await send('a', { id: 'm-d1', source: 'a', specversion: '1.0', type: 'chat.message', to: ['b'], data: { text: '只给 b' } });
      const r2 = await send('a', { id: 'm-d2', source: 'a', specversion: '1.0', type: 'chat.message', to: ['c'], data: { text: '只给 c' } });
      // ⚠️ 2026-10-05 改：原来查 `bridge.getState().recentDeliveries` —— 那张表**只在推送成功时才记**
      //    ⇒ 脚本型接入端没有门牌号（推不进去）就查不到，判据成了"测推送技术"而不是"测该叫谁"。
      //    ⇒ 改成看**这次调用的返回**：`delivered`（推到了）＋ `silent`（**该叫但推不到**）。
      //    ⚠️ 顺带**判得更紧**了：不只判"有没有记录"，还判"**只叫了那一个**" —— 这才对得上"只看 `to`"。
      const t1 = [...((r1.body.data || {}).delivered || []), ...((r1.body.data || {}).silent || [])].map((d) => d.targetId);
      const t2 = [...((r2.body.data || {}).delivered || []), ...((r2.body.data || {}).silent || [])].map((d) => d.targetId);
      rec(t1.length === 1 && t1[0] === 'b' && t2.length === 1 && t2[0] === 'c',
        '3. 该叫谁只看 `to`（点谁就叫谁）',
        `m-d1 ⇒ [${t1.join(',')}]；m-d2 ⇒ [${t2.join(',')}]`);
    }

    // ── E. ⭐ `@all` ⇒ 展开成全体叫醒（旧口径是"不算叫醒"）──
    {
      const r = await send('boss', { id: 'm-all', source: 'boss', specversion: '1.0', type: 'chat.message', to: ['@all'], data: { text: '全员' } });
      // ⚠️ 2026-10-05 改：**"叫了谁"要算上 `silent`** —— 规范 `接入\01` §5.1 的正本是"**该叫谁只看 `to`**"，
      //    要验的是"**该叫的人**"，不是"推送技术成不成功"。`silent` 记的正是"**该叫但推不到**"
      //    （脚本型接入端没有门牌号就落在这；它仍然是"被叫了"，只是推不进去）。
      const sq = r.body.data || {};
      const targets = [...(sq.delivered || []), ...(sq.silent || [])].map((d) => d.targetId).sort();
      rec(r.body.ok === true && targets.length >= 3,
        '4a ⭐ @all（老大发）⇒ 展开成全体、逐个叫醒', `叫了 [${targets.join(',')}]`);
      const rb = await send('b', { id: 'm-all-2', source: 'b', specversion: '1.0', type: 'chat.message', to: ['@all'], data: { text: '我也想@all' } });
      rec(rb.body.ok === false && /只有老大/.test(String(rb.body.error || '')),
        '4b ⭐ @all 只有老大能发（b 发 ⇒ 拒）', `HTTP ${rb.status}；${JSON.stringify(rb.body.error)}`);
    }

    // ── F. 收件箱这个模型已经没了 ──
    {
      const r = await fetch(base + '/api/inbox?memberId=b');
      rec(r.status === 404, '5a ⛔ GET /api/inbox 已经没了（404）', `HTTP ${r.status}`);
      const t = await call('b', 'inbox', { memberId: 'b' });
      rec(t.body.ok === false && /不认识工具/.test(String(t.body.error || '')), '5b ⛔ inbox 工具已经撤了',
        JSON.stringify(t.body.error));
    }

    // ── G. stdio 代理那一口拿得到工具清单 ──
    {
      const r = await fetch(base + '/api/tools').then((x) => x.json());
      const names = (r.tools || []).map((t) => t.name);
      rec(r.ok === true && names.includes('send_message') && !names.includes('inbox') && !names.includes('busy'),
        '6. GET /api/tools ⇒ 工具清单（stdio 口当代理时取它；inbox/busy 已不在）',
        `共 ${names.length} 个：${names.join(' ')}`);
    }

    // ── H. 换人重派（合并原 M8b-换人重派）──
    {
      const T = (await call('a', 'next_task_id', {})).body.data.taskId;
      const S = T + '-1';
      await send('a', {
        id: 'asg-r1', source: 'a', specversion: '1.0', type: 'task.assign', to: ['b'],
        data: { task: T, title: '会超时的活', note: '', subtasks: [{ to: 'b', id: S, timeout: 30, note: '干' }] },
      });
      await send('b', { id: 'ack-r1', source: 'b', specversion: '1.0', type: 'task.ack', to: ['a'], data: { task: S, note: '收到' } });
      const to = require(path.join(BACKEND, 'timeout.js'));
      to.handleTimeout(S);                       // 判超时 ⇒ 那件 cancelled ＋ 人进"试过谁"名单
      const r = await call('a', 'reassign', { memberId: 'a', subId: S, to: 'c' });
      const subs = dl.getTask(T).subtasks;
      rec(r.body.ok === true && subs.length === 2 && subs[1].to === 'c',
        '7a 换人重派 ⇒ 新子任务挂在 c 名下（旧件仍是 cancelled）',
        `reassign=${JSON.stringify(r.body.data || r.body.error)}；子任务=[${subs.map((s) => s.id + '→' + s.to + '(' + s.state + ')').join(', ')}]`);
      const r2 = await call('a', 'reassign', { memberId: 'a', subId: subs[0].id, to: 'b' });
      rec(r2.body.ok === false && /已经试过/.test(String(r2.body.error || '')),
        '7b 重派必须换人（派回原人 ⇒ 拒）', JSON.stringify(r2.body.error));
    }

    // ── H2. ⭐ over 只有派发者能报（2026-10-05 加）──
    // 改前：`over` 只查"每件都有结果"、**不查调用者是谁** ⇒ 任何成员都能把别人派的活收口。
    {
      const tasks = (await call('boss', 'list_tasks', {})).body.data.tasks;
      const open = tasks.find((t) => !t.closed);
      if (!open) {
        rec(false, '（没有未收口的任务 ⇒ over 用例没法演）', '前置不成立');
      } else {
        // 把那包收尾：剩下的件先接、交、验收通过 ⇒ 全到终态（才轮到 over 的门）
        for (const s of open.subtasks) {
          if (s.state === 'done' || s.state === 'cancelled') continue;
          await send(s.to, { id: `h2-ack-${s.id}`, source: s.to, specversion: '1.0', type: 'task.ack', to: [open.from || 'a'], data: { task: s.id, note: '收到' } });
          await send(s.to, { id: `h2-dlv-${s.id}`, source: s.to, specversion: '1.0', type: 'task.deliver', to: [open.from || 'a'], data: { task: s.id, where: 'x' } });
          await send('a', { id: `h2-done-${s.id}`, source: 'a', specversion: '1.0', type: 'task.status', to: [s.to], data: { task: s.id, state: 'done', note: '通过' } });
        }
        const rC = await call('c', 'over', { memberId: 'c', taskId: open.id });
        rec(rC.body.ok === false && /派发者/.test(String(rC.body.error || '')),
          'H2a ⭐ over 只有派发者能报（c 替 a 报 ⇒ 拒）',
          JSON.stringify(rC.body.error || rC.body.data));
        const rA = await call('a', 'over', { memberId: 'a', taskId: open.id });
        rec(rA.body.ok === true,
          'H2b 派发者自己报 over ⇒ 过（收口）',
          JSON.stringify(rA.body.data || rA.body.error));
      }
    }

    // ── I. 重启不丢（合并原 M8b-重启不丢）：账本落盘、新实例读得到 ──
    {
      const beforeCount = dl.readMessages().length;
      delete require.cache[require.resolve(path.join(BACKEND, 'data-layer.js'))];
      const dl2 = require(path.join(BACKEND, 'data-layer.js'));
      const afterCount = dl2.readMessages().length;
      rec(beforeCount > 0 && afterCount === beforeCount,
        '8. 账本落盘：重启（重新加载模块）后读得到同样多的消息',
        `重启前 ${beforeCount} 条 ⇒ 重启后 ${afterCount} 条`);
      const card = (await call('boss', 'get_member', { memberId: 'a' })).body.data;
      rec(!!card && card.id === 'a', '8b 成员卡也在盘上（重启后查得到）',
        JSON.stringify({ id: card && card.id, host: card && card.host }));
    }
  } catch (e) {
    rec(false, '（脚本自身抛异常）', String((e && e.message) || e));
  } finally {
    aliveCtrls.forEach((c) => c.abort());
    bridge.stop();
  }

  console.log(out.join('\n'));
  console.log('');
  console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
  process.exit(0);
})();

'use strict';
/**
 * 办公室 · M15 收口唤醒 验收脚本（hyr980 写，2026-10-05）
 *
 * 依据：规范\时限\01-异常与重新派发.md 二·「**活全都有结果了，服务端要把派发者叫回来收口**」
 *       ＋ 唤醒正本 规范\接入\01-接入与连接.md §5.1 触发表里那一行
 *       ＋ 代码 `程序\后端\timeout.js` 的 `nudgeAssignerToOver()` / `setSubtaskState()`
 *
 * 盯的就一件事：**这包活每一件都有结果了、而主任务还没收口 ⇒ 系统要叫派发者回来报 `over`** ——
 *   ① 最后一件验收通过 ⇒ **真发一条消息给派发者**（不是只写日志）；
 *   ② 形态对：`type=task.status`、`source=system`、id 前缀 `sys-please-over-`、
 *      **不带 `state`**（⭐ 带了 `done` 就落进"验收通过不叫"那档 ⇒ 叫不动人）；
 *   ③ 那条消息过得去 M2 信封校验（不会被拒收）；
 *   ④ 同一包**只叫一次**；
 *   ⑤ 没全齐（还有活没结果）⇒ 一条都不发；
 *   ⑥ `boss` 派的活**不叫**（他那一套由 `bridge.handleBossDeliver()` 自动收口）；
 *   ⑦ 打回／补派之后又重新全齐 ⇒ **允许再叫一次**；
 *   ⑧ 判失联那条路**不叫**（派发者已经没了 —— 源码断言 `noNudge`）；
 *   ⑨ 日志 `please-over` 过得去 M7 固定词校验。
 *
 * ⚠️ **全隔离**：假数据层／假账本／假日志／假出口 —— **不碰 8787、不写 `运行\数据\`、不写 `运行\日志\`**。
 * ⚠️ 只 `require` 模块、**不启服务**；无计时器、无监听 ⇒ **跑完自己退出**。
 * 用法：node "验收\M15-收口唤醒.cjs"
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const TO = require(path.join(BACKEND, 'timeout.js'));
const ENV_MOD = require(path.join(BACKEND, 'envelope.js'));
const LOG = require(path.join(BACKEND, 'log.js'));

const NOW = Date.now();
const pad = (x) => String(x).padStart(2, '0');
/** 本地秒串 YYYYMMDDHHMMSS（与 M1 的 localStamp 同格式，M4 的 parseStamp 认它） */
const stamp = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}
/** 每个用例包一层：崩了也留一行，不丢前面的结果 */
function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', e.message); }
}

/**
 * 隔离实例：假数据层 ＋ 假账本 ＋ 假日志 ＋ 假出口
 * @param {object[]} store 假任务表
 * @param {object[]} board 假账本（`findAssigner()` 要从这里推"谁派的"）
 */
function fresh(store, board) {
  const logs = [], sent = [];
  const dl = {
    listTasks: () => store,
    getTask: (id) => store.find((t) => t.id === id) || null,
    readMessages: () => board || [],
    setSubtaskState: (taskId, subId, state) => {
      const t = store.find((x) => x.id === taskId);
      const s = t && t.subtasks.find((x) => x.id === subId);
      if (s) { s.state = state; s.stateUpdatedAt = stamp(NOW); }
      return s || null;
    },
    closeTaskBySystem: (id) => {
      const t = store.find((x) => x.id === id);
      if (t) t.closed = true;
      return { ok: true };
    },
    // ⭐ 15/30 分钟兜底那条会调它（"这件试过谁"）—— 假数据层给个空实现就够
    addTried: () => null,
  };
  const to = TO.createTimeout(dl, { log: (e) => logs.push(e) });
  // 系统消息的真实出口由 bridge 注入（`receiveAndDeliver`：入账 ＋ 投递）；这里换成记录器
  to.setSender((env) => { sent.push(env); return { ok: true, seq: sent.length }; });
  return { to, sent, logs };
}

/** 信封校验器（**注入版**）：判定逻辑是 M2 那一份，数据源是假的 ⇒ 不读生产文件 */
function makeEnvelope(store) {
  const env = ENV_MOD.createEnvelope({
    readMessages: () => [],
    listTasks: () => store,
    getTask: (id) => store.find((t) => t.id === id) || null,
  });
  // ⚠️ 成员表要自己喂：`createEnvelope()` 里默认只有 `['boss']`（`envelope.js:40`）
  //    ⇒ 不喂的话，"收件人 a"会被判成"收件人不存在: a"
  env.setMembers(['boss', 'a', 'b', 'c']);
  return env;
}

/** 造一个主任务：按给定状态表造子任务（`states` 例 `['done','working']`） */
function mkTask(id, states) {
  return {
    id, title: '验证用的活', closed: false, from: 'a', rounds: 1,
    subtasks: states.map((st, i) => ({
      id: `${id}-${i + 1}`, to: 'b', state: st, timeout: 5, rounds: 1, stateUpdatedAt: stamp(NOW),
    })),
  };
}
/** 假账本里那条派活消息 —— `findAssigner()` 靠它推"谁派的" */
function assignMsg(taskId, source) {
  return { id: 'm-' + taskId, type: 'task.assign', source, data: { task: taskId, subtasks: [] } };
}
/** 派发者验收那一条（真实入口 `onMessage` 认的就是这个形态） */
function accept(subId, by) {
  return {
    id: 'msg-' + subId + '-' + Math.random().toString(36).slice(2, 6),
    type: 'task.status', source: by, data: { task: subId, state: 'done', note: '验收通过' },
  };
}

console.log('=== 收口唤醒：活全齐了 ⇒ 叫派发者回来报 over（全隔离）===\n');

// ===== 1. 主用例：最后一件验收通过 ⇒ 叫派发者，且只叫一次 =====
group('1 段', () => {
  const t = mkTask('00101-20261005030000', ['done', 'working']);
  const c = fresh([t], [assignMsg(t.id, 'a')]);
  const env = makeEnvelope([t]);

  c.to.onMessage(accept(t.subtasks[1].id, 'a'));      // 派发者验收最后一件
  c.to.sweepOrphanTasks(NOW);                        // ⭐ 叫醒挂在秒级扫描里（`bridge.js` 的 ticker 每秒调一次）
  const m = c.sent[0];
  rec(c.sent.length === 1,
    '1. 最后一件验收通过 ⇒ 真发了一条消息（不多不少）',
    `条数=${c.sent.length}；消息 id=${m && m.id}`);
  rec(!!m && JSON.stringify(m.to) === JSON.stringify(['a']),
    '1b 收件人是派发者（不是 boss、也不是执行者）',
    `to=${JSON.stringify(m && m.to)}`);
  rec(!!m && m.source === 'system' && String(m.id).startsWith('sys-please-over-'),
    '1c 形态：来源 system、id 前缀 sys-please-over-',
    `source=${m && m.source}；id=${m && m.id}`);
  rec(!!m && m.type === 'task.status' && !(m.data && m.data.state),
    '1d ⭐ **不带 `state`** —— 带了 `done` 就落进"验收通过不叫"那档、叫不动人',
    `type=${m && m.type}；data=${JSON.stringify(m && m.data)}`);
  /* ⭐ 2026-10-06 随文案一起改：后端那句已改成「…这批任务已全部完成，请回来收口（不收口，下一批任务无法派出）」。
     ⚠️ 只换字面，判据不变（"全齐了要真发一条消息给派发者"）。 */
  rec(!!m && /请回来收口/.test(String(m.data && m.data.note)),
    '1e 文案＝"…这批任务已全部完成，请回来收口（不收口，下一批任务无法派出）"',
    `note=${m && m.data && m.data.note}`);
  const v = env.validate(JSON.parse(JSON.stringify(m)));
  rec(v.ok === true,
    '1f 这条消息过得去 M2 信封校验（不会被拒收）',
    `validate=${JSON.stringify(v)}（校验器＝envelope.createEnvelope 注入版）`);

  const lg = c.logs.filter((e) => e.event === 'please-over');
  rec(lg.length === 1,
    '1g 日志留痕（please-over 恰好一条）',
    `logs=${JSON.stringify(c.logs)}`);
  const ev = c.to.getEvents().find((e) => e.kind === 'please-over');
  rec(!!ev,
    '1h 事件流留痕（please-over）',
    `事件=${ev ? JSON.stringify(ev) : '(无)'}`);

  c.to.onMessage(accept(t.subtasks[1].id, 'a'));      // 再验收一次（仍然全齐）
  c.to.sweepOrphanTasks(NOW);                        // 再扫一遍
  rec(c.sent.length === 1,
    '1i 同一包**只叫一次**（再触发一次 ⇒ 还是 1 条）',
    `条数=${c.sent.length}`);
});

// ===== 2. 反例：没全齐 ⇒ 一条都不发 =====
group('2 段', () => {
  const t = mkTask('00102-20261005030000', ['done', 'working']);
  const c = fresh([t], [assignMsg(t.id, 'a')]);
  c.to.onMessage(accept(t.subtasks[0].id, 'a'));      // 只验了其中一件（还有一件在干）
  c.to.sweepOrphanTasks(NOW);
  rec(c.sent.length === 0,
    '2. 没全齐（还有一件在干）⇒ 一条都不发',
    `条数=${c.sent.length}；子任务=${JSON.stringify(t.subtasks.map((s) => s.id + '→' + s.state))}`);
});

// ===== 3. `boss` 派的活不叫 =====
group('3 段', () => {
  const t = mkTask('00103-20261005030000', ['done', 'working']);
  const c = fresh([t], [assignMsg(t.id, 'boss')]);
  c.to.onMessage(accept(t.subtasks[1].id, 'boss'));
  c.to.sweepOrphanTasks(NOW);
  rec(c.sent.length === 0,
    '3. `boss` 派的活**不叫**（他那一套由 `handleBossDeliver()` 自动判验收 ＋ 代报 over）',
    `条数=${c.sent.length}`);
});

// ===== 4. 打回／补派之后又重新全齐 ⇒ 允许再叫一次 =====
group('4 段', () => {
  const t = mkTask('00104-20261005030000', ['done', 'working']);
  const c = fresh([t], [assignMsg(t.id, 'a')]);
  c.to.onMessage(accept(t.subtasks[1].id, 'a'));      // 第一次全齐
  c.to.sweepOrphanTasks(NOW);                        // ⇒ 叫
  const after1 = c.sent.length;
  // 补派一件（打回／补派的形态：新子任务、状态 null）⇒ 扫一遍，标记要被清掉，后面才允许再叫
  t.subtasks.push({ id: t.id + '-3', to: 'b', state: null, timeout: 5, rounds: 1, stateUpdatedAt: stamp(NOW) });
  c.to.sweepOrphanTasks(NOW);                        // 不齐 ⇒ 清标记
  c.to.onMessage(accept(t.subtasks[2].id, 'a'));      // 又全齐
  c.to.sweepOrphanTasks(NOW);                        // ⇒ 允许再叫一次
  rec(after1 === 1 && c.sent.length === 2,
    '4. 打回／补派之后又重新全齐 ⇒ **允许再叫一次**（不是"叫过就永远不叫"）',
    `第一次后=${after1} 条；补派并重新全齐后=${c.sent.length} 条`);
});

// ===== 5. 判失联那条路不叫（源码断言） =====
group('5 段', () => {
  // 已收口（closed）的包不再叫 —— 判失联那条路正落在这一档（它判完紧接着 `systemOver` 就收了口）
  const t = mkTask('00105-20261005030000', ['done']);
  t.closed = true;
  const c = fresh([t], [assignMsg(t.id, 'a')]);
  c.to.nudgeAssignerToOver(t);                       // 直接调（nudge 已导出）
  rec(c.sent.length === 0,
    '5. 已收口的包**不再叫**（判失联那条路落在这里：判完系统自己就把 over 代报了）',
    `条数=${c.sent.length}；closed=${t.closed}`);
});

// ===== 6. 日志事件名过得去 M7 固定词校验 =====
group('6 段', () => {
  const mapped = TO.toLogEvent({ event: 'please-over', taskId: '00101-x', assigner: 'a', sent: true });
  rec(LOG.EVENT_TYPES.includes(mapped.type) && /已通知派发者收口/.test(String(mapped.why)),
    '6. 日志 `please-over` 过得去 M7 固定词校验（type 是固定词 state，不是自由文本）',
    `映射=${JSON.stringify(mapped)}；M7 词表=[${LOG.EVENT_TYPES.join(' ')}]`);
});

// ===== 7. 打回重做（老大 2026-10-05 问到的场景） =====
group('7 段', () => {
  // 打回发生在**验收之前** ⇒ 那件是 `delivered`（不是终态）⇒ 不该叫
  const t = mkTask('00106-20261005030000', ['done', 'delivered']);
  const board = [
    assignMsg(t.id, 'a'),
    // 那条打回（`inreplyto` 指回一次交付；`envelope.receive()` 只入账＋算轮次，不动子任务状态）
    { id: 'm-rework-1', type: 'task.assign', source: 'a', inreplyto: 'd-1', data: { task: t.id, subtasks: [{ to: 'b', id: t.id + '-2' }] } },
  ];
  const c = fresh([t], board);
  c.to.sweepOrphanTasks(NOW);
  rec(c.sent.length === 0,
    '7. 打回重做中（账本里有打回那条、那件是 `delivered`）⇒ **不叫** —— 打回发生在验收之前，它不是终态',
    `条数=${c.sent.length}；子任务=${JSON.stringify(t.subtasks.map((s) => s.id + '→' + s.state))}`);

  t.subtasks[1].state = 'done';                      // 重做完、验收通过
  c.to.sweepOrphanTasks(NOW);
  rec(c.sent.length === 1,
    '7b 打回的那件干完、验收通过 ⇒ **这时才叫**（全齐了）',
    `条数=${c.sent.length}；子任务=${JSON.stringify(t.subtasks.map((s) => s.id + '→' + s.state))}`);
});

// ===== 8. 交付后派发者一直不验收：15 分钟叫一次、30 分钟兜底（2026-10-05 加）=====
group('8 段', () => {
  const t = mkTask('00108-20261005030000', ['delivered']);
  const c = fresh([t], [assignMsg(t.id, 'a')]);
  c.to.rebuildAcceptWatch();                 // 从任务表恢复"等验收表"（重启后也是走这条）
  const base = Date.now();

  c.to.sweepAcceptDeadline(base + 14 * 60 * 1000);
  rec(c.sent.length === 0,
    '8a 14 分钟：还没到点 ⇒ 一条都不发',
    `条数=${c.sent.length}`);

  c.to.sweepAcceptDeadline(base + 16 * 60 * 1000);
  const m1 = c.sent[0];
  rec(c.sent.length === 1 && JSON.stringify(m1 && m1.to) === JSON.stringify(['a'])
      && /请验收/.test(String(m1 && m1.data && m1.data.note)),
    '8b 16 分钟：叫派发者一次「任务已经提交，请验收」',
    `条数=${c.sent.length}；to=${JSON.stringify(m1 && m1.to)}；note=${m1 && m1.data && m1.data.note}`);

  c.to.sweepAcceptDeadline(base + 20 * 60 * 1000);
  rec(c.sent.length === 1,
    '8c 同一件只叫一次（再扫一遍不重复叫）',
    `条数=${c.sent.length}`);

  c.to.sweepAcceptDeadline(base + 31 * 60 * 1000);
  const m2 = c.sent[1];
  rec(c.sent.length === 2 && t.closed === true && t.subtasks[0].state === 'done',
    '8d ⭐ 31 分钟：兜底 —— 产出全转老大 ＋ 那件由系统代判通过 ＋ 整包收口',
    `条数=${c.sent.length}；给谁=${JSON.stringify(m2 && m2.to)}；closed=${t.closed}；那件状态=${t.subtasks[0].state}`);

  const lg = c.logs.map((e) => e.event);
  rec(lg.includes('accept-nudge') && lg.includes('accept-fallback'),
    '8e 两档都有日志留痕（accept-nudge／accept-fallback）',
    `日志事件=${JSON.stringify(lg)}`);
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

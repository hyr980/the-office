'use strict';
/**
 * 办公室 · M14 系统代收 验收脚本（hyr980 写，2026-10-05）
 *
 * 依据：规范\时限\01-异常与重新派发.md 二·「**无人收口的任务，由服务端自行收口**」
 *       ＋ 代码 `程序\后端\timeout.js` 的 `sweepOrphanTasks()` / `systemNotify()`
 *
 * 盯的就一件事：**代收成立时，系统要真发一条消息给 `boss`**（不是只记内部事件）——
 *   ① 代收成 ⇒ 代报 `over` ＋ 写日志（照旧）＋ **真发一条消息给 `boss`**；
 *   ② 那条消息过得去 M2 信封校验（不会被拒收）；
 *   ③ 同一件**不重复发**；
 *   ④ 收不成（名下还有 `delivered` 那档）⇒ **一条都不发**（发出去就是假话）；
 *   ⑤ 出口没接线（bridge 忘了 `setSender`）⇒ **不静默**：内存事件 ＋ 落盘日志都留痕。
 *
 * ⚠️ **全隔离**：假数据层／假日志／假出口 —— **不碰 8787、不写 `运行\数据\`、不写 `运行\日志\`**。
 *    信封校验用**注入版**（`envelope.createEnvelope(假数据层)`）：判定逻辑仍是 M2 那一份，
 *    但**连生产数据文件都不读**（默认实例的 `validate` 会读 `运行\数据\`）。
 * ⚠️ 只 `require` 模块、**不启服务**；无计时器、无监听 ⇒ **跑完自己退出**。
 * 用法：node "验收\M14-系统代收.cjs"
 */

const path = require('path');

const BACKEND = path.join(__dirname, '..', '程序', '后端');
const TO = require(path.join(BACKEND, 'timeout.js'));
const ENV_MOD = require(path.join(BACKEND, 'envelope.js'));
const LOG = require(path.join(BACKEND, 'log.js'));

const MIN = 60 * 1000;
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

/** 造一个主任务：一件子任务、给定状态、最后动静在 agoMs 之前 */
function mkTask(id, subState, agoMs) {
  return {
    id, title: '验证用的活', closed: false, from: 'a', rounds: 1,
    subtasks: [{ id: id + '-1', to: 'b', state: subState, timeout: 5, rounds: 1, stateUpdatedAt: stamp(NOW - agoMs) }],
  };
}

/**
 * 隔离实例：假数据层 ＋ 假日志 ＋ 假出口
 * @param {object[]} store 假任务表
 * @param {{sender?:boolean}} [opts] sender:false ⇒ **不接出口**（试降级那条路）
 */
function fresh(store, opts) {
  const withSender = !(opts && opts.sender === false);
  const logs = [], closed = [], sent = [];
  const dl = {
    listTasks: () => store,
    getTask: (id) => store.find((t) => t.id === id) || null,
    closeTaskBySystem: (id, by) => {
      const t = store.find((x) => x.id === id);
      if (t) t.closed = true;
      closed.push({ id, by });
      return { ok: true };
    },
  };
  const to = TO.createTimeout(dl, { log: (e) => logs.push(e) });
  // 系统消息的真实出口由 bridge 注入（`receiveAndDeliver`：入账 ＋ 投递）；这里换成记录器
  if (withSender) to.setSender((env) => { sent.push(env); return { ok: true, seq: sent.length }; });
  return { to, sent, logs, closed };
}

/** 信封校验器（**注入版**）：判定逻辑是 M2 那一份，数据源是假的 ⇒ 不读生产文件 */
function makeEnvelope(store) {
  return ENV_MOD.createEnvelope({
    readMessages: () => [],
    listTasks: () => store,
    getTask: (id) => store.find((t) => t.id === id) || null,
  });
}

console.log('=== 系统代收：真发一条消息给 boss（全隔离）===\n');

// ===== 1~3. 代收成 ＋ 真发一条 ＋ 不重复发 =====
group('1 段', () => {
  const t1 = mkTask('00099-20261005010000', 'done', 6 * MIN);
  const c1 = fresh([t1]);
  const env = makeEnvelope([t1]);

  const got1 = c1.to.sweepOrphanTasks(NOW);
  rec(JSON.stringify(got1) === JSON.stringify([t1.id]),
    '1. 代收成：一件"没人管的活"（子任务已 done、6 分钟没动静）⇒ sweepOrphanTasks 返回被代收的主任务 id',
    `返回=${JSON.stringify(got1)}`);
  rec(t1.closed === true,
    '1b 代报 over 照旧（任务被标 closed）',
    `closed=${t1.closed}；closeTaskBySystem=${JSON.stringify(c1.closed)}`);
  const log1 = c1.logs.filter((e) => e.event === 'over-system');
  rec(log1.length === 1,
    '1c 写日志照旧（over-system 恰好一条，没多写）',
    `logs=${JSON.stringify(c1.logs)}`);

  const m1 = c1.sent[0];
  rec(c1.sent.length === 1,
    '2. ⭐ 真发了一条消息给 boss（不多不少）',
    `条数=${c1.sent.length}；消息 id=${m1 && m1.id}`);
  rec(!!m1 && JSON.stringify(m1.to) === JSON.stringify(['boss']),
    '2b 收件人是 boss',
    `to=${JSON.stringify(m1 && m1.to)}`);
  rec(!!m1 && m1.source === 'system',
    '2c 发件人是 system（不冒充成员）',
    `source=${m1 && m1.source}；type=${m1 && m1.type}`);
  /* ⭐ 2026-10-06 随文案一起改：后端那句"系统替你收口了（不用你点）"已改成
     "系统已代为收口（无需确认）"（老大要求系统通知去口语、去人称）⇒ 断言里的字符串跟着换。
     ⚠️ 只换字面；判据本身（"代收成时必须真发一条给 boss 的消息"）一个字没动。 */
  rec(!!m1 && /系统已代为收口/.test(String(m1.data && m1.data.note)),
    '2d 文案＝"…系统已代为收口（无需确认）"',
    `note=${m1 && m1.data && m1.data.note}`);
  const v = env.validate(JSON.parse(JSON.stringify(m1)));
  rec(v.ok === true,
    '2e 这条消息过得去 M2 信封校验（不会被拒收）',
    `validate=${JSON.stringify(v)}（校验器＝envelope.createEnvelope 注入版）`);

  const got3 = c1.to.sweepOrphanTasks(NOW);
  rec(got3.length === 0 && c1.sent.length === 1,
    '3. 同一件不重复发（再扫一遍：0 条新消息）',
    `再扫返回=${JSON.stringify(got3)}；消息总数=${c1.sent.length}`);
});

// ===== 4. 反例：有"交了没验"的件 ⇒ 代收不碰它（改由 15/30 分钟兜底管）=====
group('4 段', () => {
  const t2 = mkTask('00098-20261005010000', 'delivered', 6 * MIN);
  const c2 = fresh([t2]);
  const got4 = c2.to.sweepOrphanTasks(NOW);
  rec(c2.sent.length === 0 && t2.closed === false,
    '4. 有 delivered 的件 ⇒ 代收不碰它（2026-10-05 起 `ACTIVE` 含 `delivered`；改前会走进 `systemOver`、被拒、还连日志都不写）',
    `sent=${c2.sent.length}；返回=${JSON.stringify(got4)}；closed=${t2.closed}`);
});

// ===== 5. 出口没接线 ⇒ 不能静默降级 =====
group('5 段', () => {
  const t3 = mkTask('00097-20261005010000', 'done', 6 * MIN);
  const c3 = fresh([t3], { sender: false });
  const got5 = c3.to.sweepOrphanTasks(NOW);

  const ev5 = c3.to.getEvents().find((e) => e.kind === 'system-notify-unsent');
  rec(!!ev5,
    '5a 没接线时代收仍成立、事件流里留痕（system-notify-unsent）',
    `返回=${JSON.stringify(got5)}；事件=${ev5 ? JSON.stringify({ to: ev5.to, text: ev5.text, reason: ev5.reason }) : '(无)'}`);

  const lg5 = c3.logs.find((e) => e.event === 'system-notify-unsent');
  rec(!!lg5,
    '5b ⭐ 降级**写日志**（改前只有内存事件、日志里一个字没有 ⇒ 接线断了没人发现）',
    `日志行=${lg5 ? JSON.stringify(lg5) : '(无)'}`);

  const mapped = TO.toLogEvent({
    event: 'system-notify-unsent', to: ['boss'], taskId: '00097-x', subId: null,
    note: 'n', reason: 'sender 未接线（bridge 未注入），只记了事件',
  });
  rec(LOG.EVENT_TYPES.includes(mapped.type) && /系统通知未能发出/.test(String(mapped.why)),
    '5c 这条日志过得去 M7 固定词校验（type 是固定词 state，不是自由文本 ⇒ 真落盘不会抛）',
    `映射=${JSON.stringify(mapped)}；M7 词表=[${LOG.EVENT_TYPES.join(' ')}]`);

  const r5 = c3.to.systemNotify({ to: ['boss'], taskId: '00097-x', note: '再来一条试试' });
  rec(r5 && r5.ok === false && typeof r5.reason === 'string' && c3.sent.length === 0,
    '5d 降级**不抛错**（行为兼容：还是回 { ok:false, reason }，一条也发不出去）',
    `返回=${JSON.stringify(r5)}；sent=${c3.sent.length}`);
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

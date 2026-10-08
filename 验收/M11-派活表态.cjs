'use strict';
/**
 * 办公室 · M11 派活后「接／不接」表态 验收脚本（hyr980 写，2026-10-03）
 *
 * 依据（老大 2026-10-03 定）：
 *   规范 01 §3 / 03 §3.1 / 05 §5 第 6 步 ＋ §7.1：
 *   ① 从派活消息发出去那一刻起算 5 分钟；
 *   ② 没唤醒到 / 唤醒了没选接不接 ⇒ 怎么样都判异常；
 *   ③ 判异常动作：标 cancelled ＋ 断开连接（踢下线）＋ 通知派发者；
 *   ④ 通知必须带齐四样：谁异常了 ＋ 主任务 id ＋ 子任务 id ＋「请重派」；
 *   ⑤ 通知由系统发（source='system'，type='task.status'），走唯一大门（入账＋投递）。
 *
 * ⚠️ 会写 <程序>\数据\ —— 本脚本跑前备份、跑完恢复（真数据不留痕）
 */
const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');
const DL = require(path.join(BACKEND, 'data-layer.js'));
const ST = require(path.join(BACKEND, 'status.js'));
const TO = require(path.join(BACKEND, 'timeout.js'));

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}
function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', e.message); }
}

// ── 数据备份／恢复 ──
const FILES = ['board.jsonl', 'tasks.json', 'seq.txt', 'members.json'];
const backup = new Map();
for (const f of FILES) {
  const p = path.join(DATA, f);
  backup.set(f, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
function restore() {
  for (const [f, buf] of backup) {
    const p = path.join(DATA, f);
    if (buf === null) { try { fs.unlinkSync(p); } catch (_) {} }
    else fs.writeFileSync(p, buf);
  }
}
function resetData() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
}

/** 隔离实例：数据层 ＋ 状态机 ＋ 超时（每次新建 ⇒ 内存表清空） */
function fresh() {
  const st = ST.createStatus(DL);
  st.setMembers(['a', 'b', 'c']);
  const to = TO.createTimeout(DL, { status: st, log: null });
  return { st, to };
}

const MAIN = '00001-20261003140000';
const SUB = MAIN + '-1';

/** 造任务 ＋ 账本里那条 task.assign；agoMin ＝ 这条派活是几分钟前发的 */
function makeAssign(agoMin = 6, extra = {}) {
  DL.createTask({ id: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] });
  const t = new Date(Date.now() - agoMin * 60 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
  DL.appendMessage({
    id: 'assign-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: ['b'], time: stamp,
    data: { task: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] },
    ...extra,
  });
  return stamp;
}
function addAck() {
  DL.appendMessage({
    id: 'ack-1', source: 'b', specversion: '1.0', type: 'task.ack',
    to: ['a'], time: new Date().toISOString(),
    data: { task: SUB, note: '收到了' },
  });
}
function stateNow() {
  const t = DL.getTask(MAIN);
  if (!t) return '（没有这个任务）';
  const s = t.subtasks.find((x) => x.id === SUB);
  return s ? String(s.state) : '（没有这个子任务）';
}
/** 假出口：记录系统实际会发出去的消息 */
function fakeSender() {
  const sent = [];
  const fn = (env) => { sent.push(env); return { ok: true, seq: 100 + sent.length }; };
  return { sent, fn };
}

console.log('=== 清空数据目录，开始验 M11（派活后「接／不接」）===');

// ===== 1. 没表态 ⇒ 到点判异常 =====
group('1 段', () => {
  resetData();
  const { st, to } = fresh();
  makeAssign(6);                       // 6 分钟前发的派活，早过 5 分钟
  const { sent, fn } = fakeSender();
  to.setSender(fn);
  to.rebuildPendingAck();
  const kickedBefore = to.getKicked().length;
  const due = to.sweepPendingAck();
  const kicked = to.getKicked();
  rec(
    due.length === 1 && stateNow() === 'cancelled' && sent.length === 1 && kicked.length > kickedBefore,
    '1 派活 6 分钟没表态 ⇒ 判异常：标 cancelled ＋ 通知派发者 ＋ 踢下线',
    `到点件数=${due.length}；子任务状态=${stateNow()}；系统发出=${sent.length} 条；踢名单=[${kicked.join(',')}]`
  );
  const env = sent[0] || {};
  const d = (env.data || {});
  rec(
    env.source === 'system' && env.type === 'task.status' && Array.isArray(env.to) && env.to[0] === 'a'
      && d.task === SUB && d.state === 'cancelled'
      && typeof d.note === 'string' && d.note.includes('b') && d.note.includes(MAIN) && d.note.includes(SUB) && d.note.includes('请重派'),
    '1b 通知形态对：source=system / type=task.status / 给派发者 a / 四样齐（谁＋主任务 id＋子任务 id＋请重派）',
    `source=${env.source}；type=${env.type}；to=${JSON.stringify(env.to)}；data.task=${d.task}；data.state=${d.state}\n         note=「${d.note}」`
  );
});

// ===== 2. 表过态（发过 task.ack）⇒ 不判 =====
group('2 段', () => {
  resetData();
  const { st, to } = fresh();
  makeAssign(6);
  addAck();                            // 执行者 b 发过收条 ⇒ 已表态
  const { sent, fn } = fakeSender();
  to.setSender(fn);
  to.rebuildPendingAck();
  const due = to.sweepPendingAck();
  rec(
    due.length === 0 && sent.length === 0 && stateNow() !== 'cancelled',
    '2 账户里有 b 的 task.ack ⇒ 不判异常（表过态就算数）',
    `到点件数=${due.length}；系统发出=${sent.length} 条；子任务状态=${stateNow()}`
  );
});

// ===== 3. 没到点 ⇒ 不动 =====
group('3 段', () => {
  resetData();
  const { st, to } = fresh();
  makeAssign(1);                       // 1 分钟前发的，还没到 5 分钟
  const { sent, fn } = fakeSender();
  to.setSender(fn);
  to.rebuildPendingAck();
  const due = to.sweepPendingAck();
  rec(
    due.length === 0 && sent.length === 0 && stateNow() !== 'cancelled',
    '3 派活才 1 分钟 ⇒ 不判（5 分钟没到）',
    `到点件数=${due.length}；系统发出=${sent.length} 条；子任务状态=${stateNow()}`
  );
});

// ===== 4. 重启恢复：表在 startTimers 里被重建 =====
group('4 段', () => {
  resetData();
  const { st, to } = fresh();
  makeAssign(6);
  const { sent, fn } = fakeSender();
  to.setSender(fn);
  to.startTimers();                    // 相当于服务端重启后的重建
  const due = to.sweepPendingAck();
  rec(
    due.length === 1 && stateNow() === 'cancelled',
    '4 重启恢复：startTimers() 重建"等表态"表，6 分钟前那条照样判',
    `到点件数=${due.length}；子任务状态=${stateNow()}`
  );
});

// ===== 5. 派活消息由系统挂上「接／不接」 =====
group('5 段', () => {
  resetData();
  const ENV = require(path.join(BACKEND, 'envelope.js'));
  ENV.setMembers(['boss', 'a', 'b', 'c']);
  const msg = {
    id: 'assign-ask-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: ['b'], time: new Date().toISOString(),
    data: { task: MAIN + '-ask', title: '挂选项试验', subtasks: [{ id: MAIN + '-ask-1', to: 'b', timeout: 600 }] },
  };
  const r = ENV.receive(msg);
  const board = DL.readMessages();
  const got = board.find((m) => m.id === 'assign-ask-1');
  const ask = got && got.data && got.data.ask;
  rec(
    r.ok === true && !!ask && Array.isArray(ask.choices) && ask.choices.join('/') === '接/不接' && ask.by === 'system',
    '5 入账的 task.assign 自带 data.ask（by=system、choices=接/不接）',
    `入账结果=${JSON.stringify(r)}；data.ask=${JSON.stringify(ask)}`
  );
});

// ===== 6. 真出口：系统消息能过信封校验、进账本 =====
group('6 段', () => {
  resetData();
  const ENV = require(path.join(BACKEND, 'envelope.js'));
  ENV.setMembers(['boss', 'a', 'b', 'c']);
  DL.createTask({ id: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] });
  const { to } = fresh();              // ⚠️ 这个实例只用来造消息，出口走真 bridge
  const BR = require(path.join(BACKEND, 'bridge.js'));
  ENV.setMembers(['boss', 'a', 'b', 'c']);   // ⚠️ bridge 载入后会按 members.json 重设成员，这里再设一次（测试成员 a/b/c）
  // 用真 bridge 的唯一大门当出口（入账 ＋ 投递）
  to.setSender((env) => BR.receiveAndDeliver(env));
  const r = to.notifyAssigner({
    taskId: MAIN, subId: SUB, assigner: 'a', who: 'b',
    state: 'cancelled', why: '试验：真出口', kind: 'assign-ack-timeout',
  });
  const board = DL.readMessages();
  const sys = board.find((m) => m.source === 'system');
  rec(
    r.ok === true && !!sys && sys.type === 'task.status' && sys.data && sys.data.state === 'cancelled',
    '6 真出口打通：系统通知经 receiveAndDeliver 入账成功（source=system 过校验）',
    `发送结果=${JSON.stringify(r)}；账本里的系统消息=${sys ? JSON.stringify({ id: sys.id, type: sys.type, to: sys.to, state: sys.data.state }) : '没有'}`
  );
});

// ===== 7. 反例：没有派发者 ⇒ 不发空通知 =====
group('7 段', () => {
  resetData();
  const { to } = fresh();
  const { sent, fn } = fakeSender();
  to.setSender(fn);
  const r = to.notifyAssigner({ taskId: MAIN, subId: SUB, assigner: null, who: 'b', why: '没人可通知' });
  rec(
    r.ok === false && sent.length === 0,
    '7 没有派发者 ⇒ 不发（返回 not ok，系统消息 0 条）',
    `返回=${JSON.stringify(r)}；系统发出=${sent.length} 条`
  );
});

// ── 收尾 ──
console.log(out.join('\n'));
console.log(`\n=== M11 结果：过 ${pass} / 没过 ${fail} / 没法验 ${skip} ===`);
restore();
console.log('数据已恢复原样。');
process.exit(0);

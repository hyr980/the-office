'use strict';
/**
 * 办公室 · M4 时限与兜底 验收脚本（hyr980 写，2026-10-03）
 * 依据：验收清单-20261003.md 二·M4（九条）＋ 规范\03-状态机制.md §3.1 / §3.2
 * ⚠️ 会写 <程序>\数据\ —— 先备份、跑完恢复
 * ⚠️ 清单第 7 条把"判挂"与"refuse+派发者死"揉成一条，规范是分开的 ⇒ 分 7a / 7b 两条验
 * ⚠️ 修正：每个用例按需让成员报到（canAssign 会查在线），每段包 try/catch 免得一处崩全丢
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
function resetData() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
}
/** 隔离实例：M1 数据层 + M3 状态机 + M4（每次新建 ⇒ 内存计时表清空） */
function fresh() {
  const st = ST.createStatus(DL);
  st.setMembers(['a', 'b', 'c']);
  const to = TO.createTimeout(DL, { status: st, log: null });
  return { st, to };
}
/** 造一个主任务（a 派的、子任务给 to）＋账本里放那条 task.assign */
const MAIN = '00001-20261003100000';
const SUB = MAIN + '-1';
function makeTask(to = 'b', timeout = 5) {
  DL.createTask({ id: MAIN, subtasks: [{ id: SUB, to, timeout }] });
  DL.appendMessage({
    seq: 1, id: 'assign-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: [to], time: '2026-10-03T09:00:00+08:00',
    data: { task: MAIN, subtasks: [{ id: SUB, to, timeout }] },
  });
}
function hasSub(subId) {
  return DL.getTask(MAIN).subtasks.some((s) => s.id === subId);
}
/** 每个用例包一层：崩了也留一行，不丢前面的结果 */
function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', e.message); }
}

console.log('=== 清空数据目录，开始验 M4 ===');

// ===== 1. 到点判超时 =====
group('1 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.startTimers();
  const t0 = Date.now();
  // ⚠️ 2026-10-04：时限单位统一成**分钟**（原来是秒）⇒ 5 ⇒ 3 分钟不到点、6 分钟到点
  const early = to.checkTimeouts(t0 + 3 * 60 * 1000);
  const due = to.checkTimeouts(t0 + 6 * 60 * 1000);
  const r = due.length ? to.handleTimeout(due[0].subId) : { ok: false, reason: '没到点' }; // ⭐ 不再传 type
  const stateNow = DL.getTask(MAIN).subtasks[0].state;
  const evs = to.getEvents().map((e) => e.kind);
  const notify = to.getEvents().find((e) => e.kind === 'assigner-notify');
  rec(early.length === 0 && due.length === 1 && stateNow === 'cancelled',
    '1. timeout=5（分钟）⇒ 3 分钟不到点、6 分钟到点判超时、状态 cancelled',
    `3 分钟时 due=${early.length} 件；6 分钟时 due=${due.length} 件；handleTimeout=${JSON.stringify(r)}；状态=${stateNow}；事件=[${evs.join(',')}]`);
  rec(!!notify && /时限超过/.test(notify.text || '') && (notify.text || '').includes(SUB),
    '1b 系统主动叫派发者：带子任务 id、说"时限超过"',
    `通知文案="${notify ? notify.text : '(无)'}"，收件人=${notify ? notify.assigner : '(无)'}`);
});

// ===== 2. ⭐ 超时收尾：先插一句"停"，随即断开（**不等回话** —— 宽限期 2026-10-04 已废）=====
group('2 段', () => {
  resetData();
  const { st, to } = fresh();
  st.setPresence('b', 'online');            // ⚠️ 壳还活着 ⇒ 才走"先插话"那条
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  const interrupts = [];
  const kicks = [];
  to.setInterrupt((memberId, text) => interrupts.push({ memberId, text }));
  to.setKick((memberId, why) => kicks.push({ memberId, why }));
  to.startTimers();
  to.handleTimeout(SUB);
  rec(interrupts.length === 1 && /请停/.test(interrupts[0].text),
    '2a 在线时先插一句"时间到了，请停"', `插话内容="${interrupts[0] ? interrupts[0].text : '(无)'}"`);
  rec(kicks.length === 1, '2b ⭐ 插完**当即**断开（不设宽限期、不等它回话）',
    `收尾=[${kicks.map((k) => k.memberId + ':' + k.why).join(' | ')}]`);

  // 壳都没了（不在线）⇒ 连插话都不发，直接断开
  resetData();
  const { st: st2, to: to2 } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  const intr2 = [];
  const kicks2 = [];
  to2.setInterrupt((id, text) => intr2.push(text));
  to2.setKick((id, why) => kicks2.push(why));
  to2.startTimers();
  to2.handleTimeout(SUB);
  rec(intr2.length === 0 && kicks2.length === 1,
    '2c 它不在线（壳已经没了）⇒ 不插话、直接断开', `插话=${intr2.length} 条；收尾=${kicks2.length} 条`);
});

// ===== 3. 重派拒原人 =====
group('3 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  st.setPresence('c', 'online');      // ⚠️ 新口径：要显式上线（心跳不拉人上线）
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.setInterrupt(() => {});
  to.startTimers();
  to.handleTimeout(SUB);
  const tried = to.triedList(SUB);
  const back = to.assignRetry(SUB, 'b', { newSubId: MAIN + '-2' });
  rec(tried.includes('b') && back.ok === false && /已经试过/.test(back.reason),
    '3. 重派给原来那个人 ⇒ 拒',
    `试过谁=${JSON.stringify(tried)}；重派给 b = ${JSON.stringify(back)}`);
});

// ===== 4. 没人换 ⇒ 自己干（不进服务端）=====
group('4 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  st.setPresence('c', 'online');      // ⚠️ c 必须在线，否则 canAssign 拒、新件进不了表
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.setInterrupt(() => {});
  to.startTimers();
  to.handleTimeout(SUB);
  const ok = to.assignRetry(SUB, 'c', { newSubId: MAIN + '-2' });
  const afterOk = DL.getTask(MAIN).subtasks.length;
  rec(ok.ok === true && !ok.selfDo && afterOk === 2,
    '4a 换给没试过的人 ⇒ 正常重派（新子任务进任务表）',
    `assignRetry(b→c) = ${JSON.stringify(ok)}；任务表里子任务数=${afterOk}`);

  // 4b：连 c 也不行 ⇒ 名单外没人 ⇒ 派发者自己干
  if (hasSub(MAIN + '-2')) {
    DL.setSubtaskState(MAIN, MAIN + '-2', 'working');
    to.startTimers();
    to.handleTimeout(MAIN + '-2');
    const triedAll = to.triedList(MAIN + '-2');
    const self = to.assignRetry(MAIN + '-2', 'a', { newSubId: MAIN + '-3' });
    const countAfter = DL.getTask(MAIN).subtasks.length;
    rec(self.ok === true && self.selfDo === true,
      '4b 名单外没人可挑 ⇒ 系统判"派发者自己干"',
      `试过谁=${JSON.stringify(triedAll)}；assignRetry(→a) = ${JSON.stringify(self)}`);
    rec(countAfter === 2 && !hasSub(MAIN + '-3'),
      '4c 自己干**不进服务端**：任务表没长新件',
      `任务表子任务数=${countAfter}；-3 在表里=${hasSub(MAIN + '-3')}`);
  } else {
    rec(null, '4b / 4c', `前置没成立：-2 没进任务表（assignRetry 返回 ${JSON.stringify(ok)}）`);
  }
});

// ===== 5. refuse =====
group('5 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  st.setPresence('b', 'online');   // ⚠️ 新口径：要显式上线；忙闲由系统按账本判，不再手设
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.onMessage(DL.readMessages().find((m) => m.id === 'assign-1'));

  const r = to.onRefuse(SUB);
  /* ⭐ 2026-10-06 随文案一起改：后端那句从"执行者干不了 ⇒ 转告派发者重新派发"改成
     "执行者无法完成，已转告派发者重新派发" ⇒ 这里跟着换关键词（判据不变：要有一条转告派发者的通知）。 */
  const ev = to.getEvents().find((e) => e.kind === 'assigner-notify' && /无法完成/.test(e.text || ''));
  rec(r.ok === true && !!ev,
    '5a refuse ⇒ 系统转告派发者"执行者无法完成，重新派发"',
    `onRefuse=${JSON.stringify(r)}；通知文案="${ev ? ev.text : '(无)'}"，收件人=${ev ? ev.assigner : '(无)'}`);

  const rr = to.resolveRefuse(SUB);
  const stState = DL.getTask(MAIN).subtasks[0].state;
  const memberB = st.listMembers().find((m) => m.id === 'b');
  rec(rr.ok === true && stState === 'cancelled' && memberB.busy === 'idle',
    '5b 派发者回应 ⇒ 那件 cancelled ＋ 执行者**当场** idle',
    `resolveRefuse=${JSON.stringify(rr)}；那件状态=${stState}；b 的 busy=${memberB.busy}`);
});

// ===== 6. blocked 照样超时 =====
group('6 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.onMessage({
    id: 'blk-1', source: 'b', specversion: '1.0', type: 'task.status',
    to: ['a'], data: { task: SUB, state: 'blocked' },
  });
  const stAfterBlocked = DL.getTask(MAIN).subtasks[0].state;
  to.startTimers();
  const due = to.checkTimeouts(Date.now() + 6 * 60 * 1000);   // ⚠️ 单位＝分钟
  const r = due.length ? to.handleTimeout(due[0].subId) : { ok: false, reason: '没到点' };
  const finalState = DL.getTask(MAIN).subtasks[0].state;
  rec(stAfterBlocked === 'blocked' && due.length === 1 && finalState === 'cancelled',
    '6. blocked 照样计时 ⇒ 到点一样超时判 cancelled（无"解套"）',
    `报 blocked 后状态=${stAfterBlocked}；到点时 due=${due.length} 件；handleTimeout=${JSON.stringify(r)}；最终状态=${finalState}`);
});

// ===== 7a. 判挂 =====
group('7a 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'delivered');
  const okDeliver = to.onDeliver(SUB, 'deliver-1');
  const t = Date.now();
  const early = to.checkAssignerDeaths(t + 4 * 60 * 1000);
  const dead = to.checkAssignerDeaths(t + 5 * 60 * 1000 + 1000);
  const stateNow = DL.getTask(MAIN).subtasks[0].state;
  const kinds = to.getEvents().map((e) => e.kind);
  // ⭐ 2026-10-04 改：救不活的派发者 ⇒ **系统自己判"验收通过"**（那件转 done），不再是 cancelled
  rec(okDeliver.ok === true && early.length === 0 && dead.length === 1 && stateNow === 'done',
    '7a 交付后派发者不回话 ⇒ 5 分钟到 ⇒ 判挂 ＋ **系统自动判验收通过**（那件 done）',
    `onDeliver=${JSON.stringify(okDeliver)}；4 分钟时判挂 ${early.length} 件；5 分零 1 秒时判挂 ${dead.length} 件 [${dead.map((x) => x.subId).join(',')}]；状态=${stateNow}`);
  rec(kinds.includes('output-to-boss') && kinds.includes('executor-told'),
    '7a2 事件齐：产出物转老大 ＋ 告知执行者"先空闲、等老大找你"',
    `事件序列=[${kinds.join(' → ')}]；告知文案="${(to.getEvents().find((e) => e.kind === 'executor-told') || {}).text || '(无)'}"`);

  // 这一包已经全收尾 ⇒ 判挂那一步系统已经代报 over 了
  const closed = DL.getTask(MAIN).closed;
  rec(closed === true, '7a3 全收尾 ⇒ 系统代派发者报 over（主任务 closed）',
    `主任务 closed=${closed}，closedBy=${DL.getTask(MAIN).closedBy}`);
});

// ===== 7b. 干不了 ＋ 派发者死 =====
group('7b 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  st.setPresence('b', 'online');   // ⚠️ 新口径：要显式上线；忙闲由系统按账本判，不再手设
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.onRefuse(SUB);
  const t = Date.now();
  const before = to.sweepRefuseDead(t + 4 * 60 * 1000);
  const after = to.sweepRefuseDead(t + 5 * 60 * 1000 + 1000);
  const pending = to.listRefuseDeadConfirm();
  const notify = to.getEvents().find((e) => e.kind === 'refuse-and-dead');
  rec(before.length === 0 && after.length === 1 && pending.length === 1,
    '7b 干不了＋派发者死：5 分钟到 ⇒ 弹老大（进"等我知道了"清单）',
    `4 分钟时 ${before.length} 件；5 分零 1 秒时 ${after.length} 件；待确认清单 ${pending.length} 件`);
  /* ⭐ 2026-10-06 随文案一起改：后端那句从"派发者连不上，执行者做不了任务，现在停止"
     改成"执行者无法完成、派发者未回应，任务已停止" ⇒ 断言关键词跟着换（判据不变）。 */
  rec(!!notify && /派发者未回应/.test(notify.text || '') && notify.waitAck === true
      && !!notify.taskId && (notify.taskTitle !== undefined || notify.taskNote !== undefined),
    '7b2 弹窗文案＋任务 id／内容一起带上、且要求点"我知道了"',
    `文案="${notify ? notify.text : '(无)'}"；waitAck=${notify ? notify.waitAck : '(无)'}；taskId=${notify ? notify.taskId : '(无)'}；标题="${notify ? notify.taskTitle : ''}"`);

  const ack = to.ackRefuseDead(SUB);
  const stateNow = DL.getTask(MAIN).subtasks[0].state;
  rec(ack.ok === true && stateNow === 'cancelled',
    '7b3 点"我知道了" ⇒ 那件取消',
    `ackRefuseDead=${JSON.stringify(ack)}；那件状态=${stateNow}`);
  const memberB = st.listMembers().find((m) => m.id === 'b');
  rec(memberB.busy === 'idle',
    '7b4 执行者变空闲',
    `b 的 busy=${memberB.busy}`);
});

// ===== 8. 不到点不打扰 =====
group('8 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'delivered');
  to.onDeliver(SUB, 'deliver-1');
  to.clearEvents();
  const t = Date.now();
  to.checkAssignerDeaths(t + 4 * 60 * 1000);
  const evs = to.getEvents();
  const stateNow = DL.getTask(MAIN).subtasks[0].state;
  rec(evs.length === 0 && stateNow === 'delivered',
    '8. 4 分钟时：什么也不弹、不转、状态不动',
    `4 分钟时事件数=${evs.length}；那件状态=${stateNow}`);
});

// ===== 9. over 代报 =====
group('9 段', () => {
  resetData();
  const { st, to } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  const reject = to.systemOver(MAIN);
  DL.setSubtaskState(MAIN, SUB, 'cancelled');
  const ok = to.systemOver(MAIN, { reason: 'test' });
  const t = DL.getTask(MAIN);
  rec(reject.ok === false && /还有子任务未收尾/.test(reject.reason),
    '9a 还有活的子任务 ⇒ 系统不代报（拒）', `systemOver=${JSON.stringify(reject)}`);
  rec(ok.ok === true && t.closed === true && /system-over/.test(t.closedBy || ''),
    '9b 没有活跃子任务 ⇒ 系统代派发者报 over',
    `systemOver=${JSON.stringify(ok)}；closed=${t.closed}；closedBy=${t.closedBy}`);
});

// ===== 附A：时限起点 ＝ 派发者提交那一刻（2026-10-05 定；不是「接活」那一刻）=====
// ⭐ 判据设计：把"派发时刻"往前挪 10 分钟，让「派发」和「接活」**拉开** ——
//    按"派发起算" ⇒ 现在就该到点；按"接活起算" ⇒ 还差 5 分钟没到。
//    ⚠️ 两种口径**能分辨**才算真验到（既有用例里两者同毫秒，分辨不出）。
group('附A 时限起点', () => {
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };

  resetData();
  const { to } = fresh();
  makeTask('b', 5);
  // 手工把「派发时刻」挪到 10 分钟前（模拟"派出去很久了、执行者刚接"）
  const tf = path.join(DATA, 'tasks.json');
  const tasks = JSON.parse(fs.readFileSync(tf, 'utf8'));
  tasks[MAIN].subtasks[0].assignedAt = stamp(Date.now() - 10 * 60 * 1000);
  fs.writeFileSync(tf, JSON.stringify(tasks), 'utf8');

  DL.setSubtaskState(MAIN, SUB, 'working');   // "状态变动时刻"＝现在（比派发晚 10 分钟）
  to.startTimers();
  const due = to.checkTimeouts(Date.now());
  rec(due.length === 1,
    '附A ⭐ 时限按「派发者提交那一刻」算：10 分钟前派的活、刚接 ⇒ 现在就到点',
    `到点件数=${due.length}（若按「接活起算」应为 0 —— 两种口径分得开）`);

  // 反例：刚派出去的活 ⇒ 现在**不该**到点
  resetData();
  const { to: to2 } = fresh();
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  to2.startTimers();
  const due2 = to2.checkTimeouts(Date.now());
  rec(due2.length === 0,
    '附A2 刚派出去的活 ⇒ 现在还没到点（起算点没被算成"很久以前"）',
    `到点件数=${due2.length}`);
});

// ===== 附B：换人重派追加的新件，也要有「派发时刻」（2026-10-05 修）=====
// 改前：`appendSubtask` 造的行漏了 `assignedAt` ⇒ 计时起点退成"现在"，而重建计时每秒跑一次
//      ⇒ deadline 永远追不上现在 ⇒ 那件永远不到点、没有任何计时器管它 ⇒ 整包活锁死。
group('附B 重派的新件', () => {
  resetData();
  const { to } = fresh();
  makeTask('b', 5);
  DL.appendSubtask(MAIN, { id: MAIN + '-2', to: 'c', timeout: 5 });
  const nt = DL.getTask(MAIN).subtasks.find((s) => s.id === MAIN + '-2');
  rec(!!nt && !!nt.assignedAt,
    '附B ⭐ 换人重派追加的新件也记「派发时刻」（改前漏了 ⇒ 它永远不到点）',
    `新件 assignedAt=${nt && nt.assignedAt}`);

  // 而且它真的进得了计时表：把起点挪到 10 分钟前 ⇒ 现在就该到点
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  };
  const tf = path.join(DATA, 'tasks.json');
  const tasks = JSON.parse(fs.readFileSync(tf, 'utf8'));
  tasks[MAIN].subtasks.find((s) => s.id === MAIN + '-2').assignedAt = stamp(Date.now() - 10 * 60 * 1000);
  fs.writeFileSync(tf, JSON.stringify(tasks), 'utf8');
  to.startTimers();
  const due = to.checkTimeouts(Date.now());
  rec(due.length === 1 && due[0].subId === MAIN + '-2',
    '附B2 ⭐ 新件同样按「派发时刻」到点（10 分钟前派的 ⇒ 现在就到点）',
    `到点件=${JSON.stringify(due.map((x) => x.subId))}`);
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

'use strict';
/**
 * 办公室 · M3 状态机制 验收脚本（hyr980 写；2026-10-04 按新口径重写）
 *
 * 依据（2026-10-04 口径）：
 *   - 规范\状态\02-忙闲.md             ★ 忙闲正本：**两态、系统判**、给老大留一个口
 *   - 规范\接入\01-接入与连接.md §2.2   ★ 被处理过的人怎么回来（正本表）
 * 与旧版的差别（旧口径已废）：**隐身整档砍掉**；**"心跳回来就回在线"作废**；忙闲不再由成员自己填。
 * ⚠️ 会写 <程序>\数据\ —— 先备份、跑完恢复
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');
const DL = require(path.join(BACKEND, 'data-layer.js'));
const ST = require(path.join(BACKEND, 'status.js'));

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
/** 每个用例都造一个全新实例 ＝ 模拟服务端重启（内存态清空） */
function fresh() {
  const s = ST.createStatus(DL);
  s.setMembers(['a', 'b', 'c']);
  return s;
}
/** 造一件活：主任务 00001-…，子任务 -1 派给 b */
function makeTask(state) {
  DL.createTask({ id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 30 }] });
  if (state) DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', state);
}

console.log('=== 清空数据目录，开始验 M3（新口径）===');
resetData();

// ===== 1. 停掉心跳 ⇒ 约 2 秒内变离线（⚠️ 2026-10-04：探活周期 10 秒 ⇒ 2 秒 ⇒ **1 秒**，
//          判离线仍是"连续 2 拍"⇒ 从 ≈20 秒 → ≈4 秒 → **≈2 秒**。判据跟着改，别拿旧秒数当期望）=====
{
  const s = fresh();
  s.setPresence('b', 'online');   // ⚠️ 新口径：报到 ≠ 在线 —— 要单独"上线"这一下
  s.receiveHeartbeat('b');
  const t0 = Date.now();
  const before = s.listMembers().find((m) => m.id === 'b');
  const kickedAt1 = s.sweepOffline(t0 + 1 * 1000);
  const at1 = s.listMembers().find((m) => m.id === 'b');
  const kickedAt3 = s.sweepOffline(t0 + 3 * 1000);
  const at3 = s.listMembers().find((m) => m.id === 'b');
  rec(before.presence === 'online', '1a 上线 ＋ 心跳 ⇒ 在线', `presence=${before.presence}`);
  rec(at1.presence === 'online' && kickedAt1.length === 0, '1b 1 秒（还没超 2 拍）仍在线', `1 秒时 ${at1.presence}`);
  rec(at3.presence === 'offline' && kickedAt3.some((k) => k.id === 'b'), '1c 3 秒（超 2 拍）⇒ 判离线',
    `3 秒时 ${at3.presence}，踢掉 ${JSON.stringify(kickedAt3)}`);
}

// ===== 2. ⭐ 掉线后心跳回来 ⇒ 不许自动回在线（2026-10-04 作废旧口径）=====
{
  const s = fresh();
  s.setPresence('b', 'online');
  s.receiveHeartbeat('b');
  s.sweepOffline(Date.now() + 60 * 1000);
  const off = s.listMembers().find((m) => m.id === 'b').presence;
  s.receiveHeartbeat('b');
  const after = s.listMembers().find((m) => m.id === 'b').presence;
  rec(off === 'offline' && after === 'offline',
    '2. ⭐ 心跳不把人拉回来（要人重新点「连接」再点「上线」）',
    `掉线时 ${off} ⇒ 心跳又报了一次，还是 ${after}`);
}

// ===== 3. ⭐ 上下线分界（正本 `接入\01` §2.2）=====
{
  const s = fresh();
  s.setPresence('b', 'online');
  s.kickMember('b');                       // 踢下线：线还挂着
  const r1 = s.setPresence('b', 'online'); // 它能自己上线 ✅
  rec(r1.ok === true, '3a 「踢下线」⇒ 它能自己上线回来', `setPresence(online)=${JSON.stringify(r1)}`);

  const s2 = fresh();
  s2.setPresence('b', 'online');
  s2.disconnect('b', '测试-判异常');        // 断开连接：真断
  const r2 = s2.setPresence('b', 'online'); // 它上不了 ❌
  rec(r2.ok === false && /断开/.test(r2.reason), '3b 「断开连接」⇒ 它自己上不了',
    `setPresence(online)=${JSON.stringify(r2)}`);
  const kicked = s2.callOnline('b');        // 老大也叫不上（线真断了）
  rec(kicked.ok === false, '3c 断开连接后老大也点不亮（要先重新点「连接」）', JSON.stringify(kicked));
}

// ===== 4. 已交付未验收：只有派发者能派（且只能打回）=====
{
  resetData();
  const s = fresh();
  makeTask();
  s.setPresence('b', 'online');
  DL.appendMessage({
    seq: 1, id: 'assign-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: ['b'], time: '2026-10-03T09:00:00+08:00',
    data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 30 }] },
  });
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'delivered');

  const byOther = s.canAssign('b', 'c');
  const byAssigner = s.canAssign('b', 'a');
  const busy = s.listMembers().find((m) => m.id === 'b').busy;
  rec(byOther.ok === false && /等验收/.test(byOther.reason), '4a 已交付未验收时别人派 ⇒ 拒',
    `canAssign(b, by=c) = ${JSON.stringify(byOther)}；名单里 busy=${busy}`);
  rec(byAssigner.ok === true && /只能打回/.test(byAssigner.reason || ''), '4b 派发者派 ⇒ 过（且注明只能打回）',
    `canAssign(b, by=a) = ${JSON.stringify(byAssigner)}`);
}

// ===== 5. ⭐ 忙闲：两态、系统判（`状态\02` 判据表）=====
{
  resetData();
  const s = fresh();
  s.setPresence('b', 'online');
  const idle0 = s.currentBusy('b');
  makeTask();                                  // 派活发出（b 还没接）
  const afterAssign = s.currentBusy('b');
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'working');
  const working = s.currentBusy('b');
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'delivered');
  const delivered = s.currentBusy('b');
  rec(idle0 === 'idle', '5a 手上没活 ⇒ 空闲', `busy=${idle0}`);
  rec(afterAssign === 'busy', '5b ⭐ 派活发出去那一刻就是"忙"（不用等它接）', `busy=${afterAssign}`);
  rec(working === 'busy' && delivered === 'busy', '5c working / delivered 都算忙（"等验收"不是第三种状态）',
    `working=${working} delivered=${delivered}`);
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'done');
  const done = s.currentBusy('b');
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'cancelled');
  const cancelled = s.currentBusy('b');
  rec(done === 'idle' && cancelled === 'idle', '5d 收尾后（done / cancelled）⇒ 空闲',
    `done=${done} cancelled=${cancelled}`);
}

// ===== 6. ⭐ 给老大留的那个口（改忙闲）=====
{
  resetData();
  const s = fresh();
  s.setPresence('b', 'online');
  const setOk = s.setBusyByBoss('b', 'busy');
  const readBack = s.currentBusy('b');
  rec(setOk.ok === true && readBack === 'busy', '6a 老大能手动把 b 改成"忙"（系统判的时候本来是空闲）',
    `setBusyByBoss=${JSON.stringify(setOk)} ⇒ currentBusy=${readBack}`);
  // 账本一变 ⇒ 回到系统判
  makeTask();
  const afterLedger = s.currentBusy('b');
  rec(afterLedger === 'busy', '6b 账本一变就回到系统判（手动值不会永久盖住）', `busy=${afterLedger}`);
  const bad = s.setBusyByBoss('b', 'awaiting');
  rec(bad.ok === false, '6c 忙闲只有两态（传 awaiting ⇒ 拒）', JSON.stringify(bad));
}

// ===== 7. ⭐ 离线／断开的：忙闲不显示（那一栏空着）=====
{
  resetData();
  const s = fresh();
  makeTask('working');
  s.setPresence('b', 'online');
  const online = s.listMembers().find((m) => m.id === 'b');
  s.disconnect('b', '测试');
  const off = s.listMembers().find((m) => m.id === 'b');
  rec(online.busy === 'busy' && off.busy === null, '7. 在线才有忙闲；断开后 busy=null（不写"忙"也不写"空闲"）',
    `在线 busy=${online.busy} ⇒ 断开后 busy=${off.busy}`);
}

// ===== 8. 重启 ⇒ 全员离线（不自动回来）=====
{
  resetData();
  const s1 = fresh();
  s1.setPresence('b', 'online'); s1.setPresence('c', 'online');
  const before = s1.listMembers().map((m) => `${m.id}:${m.presence}`).join(' ');
  const s2 = fresh(); // 重启 ＝ 内存态全清
  const atBoot = s2.listMembers().map((m) => `${m.id}:${m.presence}`).join(' ');
  s2.receiveHeartbeat('b');
  const afterHb = s2.listMembers().find((m) => m.id === 'b').presence;
  rec(atBoot.includes('offline') && afterHb === 'offline',
    '8. 重启后全员离线；心跳也带不回来（要人重新点「连接」「上线」）',
    `重启前 [${before}]；开机 [${atBoot}]；b 报到后 ${afterHb}`);
}

// ===== 附验：⭐ 自己下线（2026-10-04 老大定：「点了下线得先跟办公室说我下线了，才解绑，这样子办公室才知道你下线了」）=====
{
  const s = fresh();
  s.setPresence('b', 'online');
  const off = s.setPresence('b', 'offline');
  const st1 = s.listMembers().find((m) => m.id === 'b');
  rec(off.ok === true && st1.presence === 'offline',
    '附4 ⭐ presence=offline（自己下线）⇒ 接受，状态真的变离线',
    `返回 ${JSON.stringify(off)}；名单里 presence=${st1 && st1.presence}`);

  const back = s.setPresence('b', 'online');
  rec(back.ok === true,
    '附5 ⭐ 自己下线之后**还能自己上线回来**（那条线没断 ⇒ 跟"踢下线"同一档）',
    `setPresence(online)=${JSON.stringify(back)}`);

  const idem1 = s.setPresence('b', 'offline');
  const idem2 = s.setPresence('b', 'offline');
  rec(idem1.ok === true && idem2.ok === true,
    '附6 自己下线是幂等的（已经离线了再报一次也不报错）',
    `第一次 ${JSON.stringify(idem1)}；第二次 ${JSON.stringify(idem2)}`);
}

// ===== 附验：boss 不进状态机 / 未知成员 / 非法值 =====
{
  const s = fresh();
  const hb = s.receiveHeartbeat('boss');
  const ca = s.canAssign('boss', 'a');
  const inList = s.listMembers().some((m) => m.id === 'boss');
  rec(hb === false && ca.ok === false && !inList,
    '附1 boss 不进状态机（心跳不受理、不能被派活、不在名单）',
    `receiveHeartbeat(boss)=${hb}；canAssign(boss)=${JSON.stringify(ca)}；名单里有 boss=${inList}`);

  const r1 = s.receiveHeartbeat('不存在的人');
  const r2 = s.setPresence('b', '隐形');
  const r3 = s.setPresence('b', 'ghost');
  rec(r1 === false, '附2 未知成员心跳 ⇒ 不受理', `返回 ${r1}`);
  rec(r2.ok === false && r3.ok === false && /只有 online/.test(r3.reason), '附3 presence 只认 online／offline（"隐形""ghost"这种写法都拒）',
    `隐形=${JSON.stringify(r2)}；ghost=${JSON.stringify(r3)}`);
}

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

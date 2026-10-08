'use strict';
/**
 * 办公室 · M5 成员与卡 验收脚本（hyr980 写，2026-10-03）
 * 依据：验收清单-20261003.md 二·M5（七条）＋ 规范\02-成员卡.md / 03-状态机制.md §5 §7
 * ⚠️ 会写 <程序>\数据\members.json 等 —— 先备份、跑完恢复
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');
const DL = require(path.join(BACKEND, 'data-layer.js'));
const ST = require(path.join(BACKEND, 'status.js'));
const MEM = require(path.join(BACKEND, 'members.js'));

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
  const mf = path.join(DATA, 'members.json');
  if (fs.existsSync(mf)) fs.unlinkSync(mf);   // 每次从零建卡
}
/**
 * 隔离实例：一个全新的状态机 + 一个全新的 members 实例（共用 M1 数据层文件）
 * ⚠️ 顺序要紧：先建卡（ensureMember 会 syncMembers ⇒ 用"卡里有谁"覆盖状态机成员表），再报到。
 * ⚠️ 名单源头是"有卡的人"，不是状态机成员表 ⇒ 不建卡名单就是空的。
 * @param {string[]} withCards 要给谁建卡（默认 a/b/c；测"自动建卡"那条传 []）
 */
function fresh(withCards = ['a', 'b', 'c']) {
  const st = ST.createStatus(DL);
  const mem = MEM.createMembers(DL, { status: st });
  for (const id of withCards) mem.ensureMember(id);
  return { st, mem };
}
const MAIN = '00001-20261003100000';
const SUB = MAIN + '-1';

function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', e.message); }
}

console.log('=== 清空数据目录，开始验 M5 ===');

// ===== 1. 自动建卡：只有 id ＋ joined =====
group('1 段', () => {
  resetData();
  const { mem } = fresh();
  const card = mem.ensureMember('新来的');
  const m = mem.getMember('新来的');
  const keys = Object.keys(card).sort();
  rec(keys.length === 2 && keys.join(',') === 'id,joined' && /\d{14}/.test(card.joined),
    '1. 没见过的 id 接入 ⇒ 只有 id ＋ joined',
    `建出来的卡字段=[${keys.join(',')}]；joined=${card.joined}；getMember 查回来 name=${JSON.stringify(m.name)} model=${JSON.stringify(m.model)} icon=${JSON.stringify(m.icon)}`);
});

// ===== 2. 自己报名字 =====
group('2 段', () => {
  resetData();
  const { mem } = fresh();
  mem.ensureMember('b');
  mem.reportIdentity('b', { name: '小螃蟹', model: '模型甲' });
  const m = mem.getMember('b');
  rec(m.name === '小螃蟹', '2. 自己报名字 ⇒ 查回来是它报的值',
    `报的 name="小螃蟹" ⇒ 查回来 name=${JSON.stringify(m.name)}（model=${JSON.stringify(m.model)}）`);
});

// ===== 2b. 昵称 nick（2026-10-04 新口径：宿主进程名取自宿主进程、由插件报；昵称＝AI 自己填／自己改）=====
group('2b 段', () => {
  resetData();
  const { mem } = fresh();
  mem.ensureMember('b');
  mem.reportIdentity('b', { name: 'DeepSeek Harness', model: '模型甲', nick: '小螃蟹' });
  const withNick = mem.getMember('b');
  rec(withNick.nick === '小螃蟹' && withNick.name === 'DeepSeek Harness',
    '2b-1 报昵称 ⇒ 查回来有它，且跟宿主进程名各占一格',
    `宿主进程名 name=${JSON.stringify(withNick.name)}；昵称 nick=${JSON.stringify(withNick.nick)}`);

  // ⚠️ 关键行为：**不传 nick ⇒ 已有的昵称不许被抹掉**（插件没填过就不带 ⇒ 办公室不能顺手清空它）
  mem.reportIdentity('b', { model: '模型乙' });
  const kept = mem.getMember('b');
  rec(kept.nick === '小螃蟹', '2b-2 不传昵称 ⇒ 已有的不被抹掉（这条最要紧）',
    `只报 model 之后：nick=${JSON.stringify(kept.nick)}（应为 "小螃蟹"）`);

  // ⚠️ 传空串 ＝ 明确"改回没有"
  mem.reportIdentity('b', { nick: '' });
  const cleared = mem.getMember('b');
  rec(cleared.nick === null, '2b-3 传空串 ⇒ 改回"没有昵称"',
    `传 nick="" 之后：nick=${JSON.stringify(cleared.nick)}（应为 null）`);

  // ⭐ 从没起过昵称 ⇒ 就是 null（名单表靠它判"要不要显示第二个名字"）
  mem.ensureMember('c');
  const none = mem.getMember('c');
  rec(none.nick === null, '2b-4 没起过昵称 ⇒ 查回来是 null（界面据此只显示宿主进程名）',
    `没报过的成员：nick=${JSON.stringify(none.nick)}`);
});

// ===== 3. 换模型：值变、其他格不动 =====
group('3 段', () => {
  resetData();
  const { mem } = fresh();
  mem.ensureMember('b');
  mem.reportIdentity('b', { name: '小螃蟹', model: '模型甲' });
  mem.setIcon('b', Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const before = mem.getMember('b');
  mem.reportIdentity('b', { model: '模型乙' });
  const after = mem.getMember('b');
  rec(after.model === '模型乙' && after.name === before.name && after.joined === before.joined && after.icon === before.icon,
    '3. 换模型 ⇒ model 变、其他格不动',
    `换前 model=${before.model}；换后 model=${after.model}｜name ${before.name}→${after.name}；joined ${before.joined}→${after.joined}；icon 是否不变=${before.icon === after.icon}`);
});

// ===== 4. boss 在成员里、不在候选里 =====
group('4 段', () => {
  resetData();
  const { st, mem } = fresh();
  ['a', 'b'].forEach((id) => st.setPresence(id, 'online')); // ⚠️ 新口径：要显式上线
  const bossCard = mem.getMember('boss');
  const list = mem.listAssignable('a');
  const ids = list.map((x) => x.id);
  rec(bossCard !== null && !ids.includes('boss'),
    '4. boss 在成员里、不在候选里',
    `getMember(boss)=${bossCard ? `{id:${bossCard.id}, presence:${bossCard.presence}, busy:${bossCard.busy}}` : 'null'}；listAssignable(a) 的 id=[${ids.join(',')}]`);
});

// ===== 5. 现算：awaiting 的人，派发者能派、别人不能 =====
group('5 段', () => {
  resetData();
  const { st, mem } = fresh();
  ['a', 'b', 'c'].forEach((id) => st.setPresence(id, 'online')); // ⚠️ 新口径：心跳不拉人上线，要显式上线
  // ⚠️ 新口径：没有"awaiting"这个状态档了 —— "等验收"由**账本现算**（那件是 delivered），不用手设。
  // 账本里造：a 派的那包活，b 那件已交付 ⇒ b 在等 a 验收
  DL.createTask({ id: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] });
  DL.appendMessage({
    seq: 1, id: 'assign-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: ['b'], time: '2026-10-03T09:00:00+08:00', data: { task: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] },
  });
  DL.setSubtaskState(MAIN, SUB, 'delivered');

  const seenByA = mem.listAssignable('a').find((x) => x.id === 'b');
  const seenByC = mem.listAssignable('c').find((x) => x.id === 'b');
  rec(!!seenByA && seenByA.assignable === true && /只能打回/.test(seenByA.why),
    '5a 派发者 a 查 ⇒ b 在名单里、可派（只能打回）',
    `a 视角：${JSON.stringify(seenByA)}`);
  rec(!!seenByC && seenByC.assignable === false && seenByC.why === '等验收',
    '5b 别人 c 查 ⇒ b 还在名单里、但标"等验收"（不可派）',
    `c 视角：${JSON.stringify(seenByC)}`);
});

// ===== 6. 不在线的不进名单（"隐身"整档 2026-10-04 已砍）=====
group('6 段', () => {
  resetData();
  const { st, mem } = fresh();
  ['a', 'b', 'c'].forEach((id) => st.setPresence(id, 'online')); // ⚠️ 新口径：心跳不拉人上线，要显式上线
  const base = mem.listAssignable('a').map((x) => x.id).join(',');
  st.disconnect('b', '测试-判异常');                 // b 被断开（真断）
  const afterDisconnect = mem.listAssignable('a').map((x) => x.id).join(',');
  st.sweepOffline(Date.now() + 60 * 1000);          // 剩下的也全判离线
  const afterOffline = mem.listAssignable('a').map((x) => x.id).join(',');
  rec(base.includes('b') && base.includes('c'),
    '6a 都在线时：b、c 都在名单', `初始名单=[${base}]`);
  rec(!afterDisconnect.includes('b') && afterDisconnect.includes('c'),
    '6b b 被「断开连接」⇒ 不进名单（c 还在）', `断开后名单=[${afterDisconnect}]`);
  rec(!afterOffline.includes('b') && !afterOffline.includes('c'),
    '6c 判离线 ⇒ 不进名单', `离线名单=[${afterOffline}]`);
});

// ===== 7. icon 传进去、查回来是图 =====
group('7 段', () => {
  resetData();
  const { mem } = fresh();
  mem.ensureMember('b');
  // 一张真 PNG 的字节（PNG 魔数 89 50 4E 47 0D 0A 1A 0A）
  const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01, 0x02, 0x03]);
  mem.setIcon('b', png);
  const got = mem.getMember('b').icon;
  const back = Buffer.from(got, 'base64');
  const isPng = back.slice(0, 8).equals(png.slice(0, 8));
  const looksLikePath = /^[A-Za-z]:[\\/]|^[.~]?[\\/]/.test(got);
  rec(isPng && !looksLikePath,
    '7. icon 传进去 ⇒ 查回来是图本身（不是路径字符串）',
    `传进去 ${png.length} 字节；查回来解 base64 ${back.length} 字节，头 8 字节是不是 PNG 魔数=${isPng}（${back.slice(0, 8).toString('hex')}）；像不像路径=${looksLikePath}`);
  rec(got === png.toString('base64'),
    '7b 查回来的 base64 与传进去的字节一字不差', `${got.slice(0, 24)}…（共 ${got.length} 字符）`);

  // 附：路径字符串会怎样（记着，不当判据）
  let pathResult;
  try { mem.setIcon('b', 'D:\\图片\\头像.png'); pathResult = mem.getMember('b').icon; }
  catch (e) { pathResult = '抛错: ' + e.message; }
  rec(null, '附：传路径字符串会怎样（记着）',
    `传 'D:\\图片\\头像.png' ⇒ 存成了 "${pathResult}"（代码里字符串直接当 base64 存，不校验）`);
});

// ===== 附：卡文件落在哪、形如什么 =====
group('附 段', () => {
  const mf = path.join(DATA, 'members.json');
  const raw = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const firstId = Object.keys(raw)[0];
  const m5 = MEM.createMembers(DL, {});
  const m2nd = m5.getMember(firstId);
  rec(!!raw.boss && Object.keys(raw).length >= 2,
    '附1 卡只存一份在 <数据>\\members.json（权威在服务端）',
    `文件里 id=[${Object.keys(raw).join(',')}]；boss 卡=${JSON.stringify(raw.boss)}`);
  rec(!!m2nd && m2nd.id === firstId,
    '附2 新实例从文件读回（重启不丢）', `重启后查 ${firstId} ⇒ name=${JSON.stringify(m2nd.name)}，joined=${m2nd.joined}`);
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

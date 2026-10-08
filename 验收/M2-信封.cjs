'use strict';
/**
 * 办公室 · M2 信封与校验 验收脚本（hyr980 写，2026-10-03）
 *
 * 依据：验收清单-20261003.md 二·M2（九条，逐条造样本，每条要看到"拒 ＋ 正确理由"）
 * 用法：node M2-信封.cjs
 * ⚠️ 会写 <程序>\数据\ —— 先备份、跑完恢复
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');
const DL = require(path.join(BACKEND, 'data-layer.js'));
const EV = require(path.join(BACKEND, 'envelope.js'));

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

/** 造一条合法信封 */
function mk(over = {}) {
  return Object.assign({
    id: 'msg-' + Math.random().toString(36).slice(2, 8),
    source: 'a', specversion: '1.0', type: 'chat.message',
    to: ['boss'], time: '2026-10-03T09:00:00+08:00', data: { text: 'hi' },
  }, over);
}

function mustReject(name, msg, keywords) {
  const v = EV.validate(msg);
  if (v.ok) return rec(false, name, `没有拒！返回 ${JSON.stringify(v)}`);
  const blob = `${v.reason || ''} | ${v.notify || ''}`;
  const miss = keywords.filter((k) => !blob.includes(k));
  return rec(miss.length === 0, name,
    miss.length === 0 ? `拒了 ✓ 理由「${v.reason}」／回话「${v.notify}」` : `拒了但缺关键词 ${JSON.stringify(miss)}，实际「${blob}」`);
}

function mustPass(name, msg) {
  const v = EV.validate(msg);
  return rec(v.ok === true, name, v.ok ? `放行 ✓（duplicate=${!!v.duplicate}）` : `被拒了！「${v.reason}」`);
}

console.log('=== 清空数据目录，开始验 M2 ===');
resetData();
// 成员：boss + a + b + c（a＝派发者，b/c＝干活的）
EV.setMembers(['boss', 'a', 'b', 'c']);

// ===== 第 1 条 =====
mustReject('1. 缺 to ⇒ 拒', mk({ to: undefined, id: 'm1' }), ['to']);

// ===== 第 2 条 =====
mustReject('2. to:["不存在的人"] ⇒ 拒', mk({ id: 'm2', to: ['不存在的人'] }), ['不存在的人']);

// ===== 第 3 条：幂等 =====
{
  resetData();
  const m = mk({ id: 'm3', source: 'a' });
  const r1 = EV.receive(m);
  const nAfter1 = fs.readFileSync(path.join(DATA, 'board.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  const r2 = EV.receive(mk({ id: 'm3', source: 'a' })); // 内容完全一样（除随机 id 已固定）
  const nAfter2 = fs.readFileSync(path.join(DATA, 'board.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  rec(r1.ok && r2.ok && r2.duplicate === true && nAfter2 === nAfter1,
    '3a 同 source+id 重发 ⇒ 不报错、账本只多一条',
    `首次 ok=${r1.ok} seq=${r1.seq}；重发 ok=${r2.ok} duplicate=${r2.duplicate}；账本行数 ${nAfter1} → ${nAfter2}`);

  const r3 = EV.receive(mk({ id: 'm3', source: 'a', data: { text: '改了一个字' } }));
  rec(r3.ok === false && /内容不同|撞已有记录/.test(r3.reason || ''),
    '3b 改一个字再发 ⇒ 拒',
    r3.ok === false ? `拒了 ✓「${r3.reason}」` : `没有拒！返回 ${JSON.stringify(r3)}`);
}

// ===== 第 4 条：未知 type =====
{
  resetData();
  mustReject('4a type="task.xyz"（带路由含义）⇒ 拒', mk({ id: 'm4a', type: 'task.xyz' }), ['不认识 type', '路由']);
  mustPass('4b type="xyz"（纯附带）⇒ 放行', mk({ id: 'm4b', type: 'xyz' }));
}

// ===== 第 5 条：打回的目标不许 AI 挑 =====
{
  resetData();
  // 造一条 b 发的交付（task.deliver，data.task = 子任务 id）
  EV.receive(mk({ id: 'd1', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-x-1', where: 'D:\\产出' } }));
  mustReject('5. inreplyto 指交付但 to 填第三人 ⇒ 拒，理由含原执行者 id',
    mk({ id: 'm5', source: 'a', type: 'task.assign', to: ['c'], inreplyto: 'd1', data: { task: '00001-x', subtasks: [{ id: '00001-x-1', to: 'c', timeout: 60 }] } }),
    ['打回只能发给原执行者', 'b']);
}

// ===== 第 6 条：awaiting =====
{
  resetData();
  // 造主任务 + 子任务派给 b，且 b 交过（delivered，未收口）⇒ b 处于 awaiting
  DL.createTask({
    id: '00001-20261003100000',
    subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }],
  });
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'delivered');

  mustReject('6a b 在 awaiting 时给他普通 task.assign ⇒ 拒',
    mk({ id: 'm6a', source: 'a', type: 'task.assign', to: ['b'], data: { task: '00002-new', subtasks: [{ id: '00002-new-1', to: 'b', timeout: 60 }] } }),
    ['等验收', 'awaiting']);

  // 打回那条：inreplyto 指向 b 的交付、to＝[b] ⇒ 应当过
  EV.receive(mk({ id: 'd2', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-20261003100000-1', where: 'x' } }));
  mustPass('6b 打回那条（inreplyto 指回他自己交付）⇒ 过',
    mk({ id: 'm6b', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'd2', data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 60 }] } }));
}

// ===== 第 7 条：已有主任务在跑 =====
{
  resetData();
  DL.createTask({
    id: '00001-20261003100000',
    subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }],
  });
  const v = EV.validate(mk({
    id: 'm7', source: 'a', type: 'task.assign', to: ['c'],
    data: { task: '00002-20261003100000', subtasks: [{ id: '00002-20261003100000-1', to: 'c', timeout: 60 }] },
  }));
  rec(v.ok === false && (v.notify || '').includes('当前已有任务'),
    '7. 已有主任务在跑时再建 ⇒ 拒，回话含"当前已有任务"',
    v.ok === false ? `拒了 ✓ reason「${v.reason}」／notify「${v.notify}」` : `没有拒！${JSON.stringify(v)}`);
}

// ===== 第 8 条：没全 done 就 over =====
{
  resetData();
  DL.createTask({
    id: '00001-20261003100000',
    subtasks: [
      { id: '00001-20261003100000-1', to: 'b', timeout: 600 },
      { id: '00001-20261003100000-2', to: 'c', timeout: 600 },
    ],
  });
  DL.setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'done');
  const r = EV.checkOver('00001-20261003100000');
  rec(r.ok === false && /还有子任务没完/.test(r.reason),
    '8. 子任务没全 done 就报 over ⇒ 拒',
    r.ok === false ? `拒了 ✓「${r.reason}」／通知「${r.notify}」` : `没有拒！${JSON.stringify(r)}`);
}

// ===== 第 9 条：一包活里 to 重复 =====
{
  resetData();
  const v = EV.validate(mk({
    id: 'm9', source: 'a', type: 'task.assign', to: ['b'],
    data: {
      task: '00001-20261003100000',
      subtasks: [
        { id: '00001-20261003100000-1', to: 'b', timeout: 60 },
        { id: '00001-20261003100000-2', to: 'b', timeout: 60 },
      ],
    },
  }));
  rec(v.ok === false && (v.notify || '').includes('一个人一次只能接一件'),
    '9. 一包里 subtasks 两次 to:"b" ⇒ 拒，回话"一个人一次只能接一件"',
    v.ok === false ? `拒了 ✓ reason「${v.reason}」／notify「${v.notify}」` : `没有拒！${JSON.stringify(v)}`);
}

// ===== 附验：打回轮次上限（envelope.js:201-220，注释称"老大 2026-10-03 定"）=====
{
  resetData();
  DL.createTask({ id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }] });

  // 用户第 1 次打回：合法
  EV.receive(mk({ id: 'd-1', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-20261003100000-1', where: 'v1' } }));
  const r1 = EV.receive(mk({ id: 'a-1', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'd-1', data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }] } }));
  rec(r1.ok === true, '附1 第 1 次打回 ⇒ 过', r1.ok ? `放行 ✓ seq=${r1.seq}` : `被拒了「${r1.reason}」`);

  // 用户第 2 次打回：合法
  EV.receive(mk({ id: 'd-2', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-20261003100000-1', where: 'v2' } }));
  const r2 = EV.receive(mk({ id: 'a-2', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'd-2', data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }] } }));
  rec(r2.ok === true, '附2 第 2 次打回 ⇒ 过', r2.ok ? `放行 ✓ seq=${r2.seq}` : `被拒了「${r2.reason}」`);

  // 用户第 3 次打回：应当拒
  EV.receive(mk({ id: 'd-3', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-20261003100000-1', where: 'v3' } }));
  const r3 = EV.receive(mk({ id: 'a-3', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'd-3', data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }] } }));
  rec(r3.ok === false && /max-rounds|最多 3 轮/.test(r3.reason || ''),
    '附3 第 3 次打回 ⇒ 拒（上限 3 轮）',
    r3.ok === false ? `拒了 ✓「${r3.reason}」／通知「${r3.notify}」` : `没有拒！${JSON.stringify(r3)}`);
}

// ===== 附验：schema 层（不是清单条目，只看有没有明显问题）=====
{
  resetData();
  const v = EV.validate('我不是对象');
  rec(v.ok === false, '附4 非对象入参 ⇒ 拒（不崩）', `返回 ok=${v.ok} reason=${v.reason}`);
  const v2 = EV.validate(mk({ id: 'm-x', to: 'boss' }));
  rec(v2.ok === false && /数组/.test(v2.reason), '附5 to 不是数组 ⇒ 拒', `返回「${v2.reason}」`);
}

// ===== 附6：打回不新起号（规范 01-信封.md:166；2026-10-03 新加）=====
// ⚠️ 首次跑出「没有拒 ⇒ {"ok":true,"seq":2}」：信封层没拦"打回换号"，缺口确认。
// 现有实现只拦"打回发给谁"（第 5 条），没拦"子任务 id 必须沿用原号"。
// 后果：打回方换号能过；执行者若跟着新号交付，第 8 条（最多 3 轮）的计数链就断 ⇒ 可无限打回。
{
  resetData();
  DL.createTask({ id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 600 }] });
  EV.receive(mk({ id: 'd-n', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00001-20261003100000-1', where: 'v1' } }));
  const r = EV.receive(mk({
    id: 'a-n', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'd-n',
    data: { task: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-9', to: 'b', timeout: 600 }] },
  }));
  rec(r.ok === false && /沿用原号|不新起号|换号/.test(r.reason || ''),
    '附6 打回时把子任务 id 换成新号 ⇒ 拒（打回不新起号）',
    r.ok === false ? `拒了 ✓「${r.reason}」` : `没有拒！返回 ${JSON.stringify(r)}`);
}

// ===== 附7：打回 ⇒ 那件当场退回「从未表态」（2026-10-05 加；规范 流程\01 §4）=====
// 改前：`task.ack` 只在 `state === null` 时才记 `working`，而打回时那件是 `delivered`
// ⇒ **回不到 working** ⇒ 状态卡在"已交付待验收"、任务表说假话。现在打回那条一进账本就退回初始。
{
  resetData();
  DL.createTask({ id: '00002-20261005120000', subtasks: [{ id: '00002-20261005120000-1', to: 'b', timeout: 600 }] });

  EV.receive(mk({ id: 'ack-1', source: 'b', type: 'task.ack', to: ['a'], data: { task: '00002-20261005120000-1' } }));
  const st1 = DL.getTask('00002-20261005120000').subtasks[0].state;
  EV.receive(mk({ id: 'dlv-1', source: 'b', type: 'task.deliver', to: ['a'], data: { task: '00002-20261005120000-1', where: 'v1' } }));
  const st2 = DL.getTask('00002-20261005120000').subtasks[0].state;
  rec(st1 === 'working' && st2 === 'delivered',
    '附7a 先走到 delivered（接 ⇒ 干着；交 ⇒ 待验收）',
    `状态：${st1} → ${st2}`);

  // 打回（inreplyto 指回那条交付）⇒ 当场退回
  const rw = EV.receive(mk({
    id: 'rw-1', source: 'a', type: 'task.assign', to: ['b'], inreplyto: 'dlv-1',
    data: { task: '00002-20261005120000', subtasks: [{ id: '00002-20261005120000-1', to: 'b', timeout: 600 }] },
  }));
  const st3 = DL.getTask('00002-20261005120000').subtasks[0].state;
  rec(rw.ok === true && st3 === null,
    '附7b ⭐ 打回 ⇒ 那件当场退回「从未表态」（改前卡在 delivered、退不回去）',
    `打回 ok=${rw.ok}；退回后状态=${JSON.stringify(st3)}`);

  // 退回之后，执行者再回「收到」⇒ 自然变回 working
  EV.receive(mk({ id: 'ack-2', source: 'b', type: 'task.ack', to: ['a'], data: { task: '00002-20261005120000-1' } }));
  const st4 = DL.getTask('00002-20261005120000').subtasks[0].state;
  rec(st4 === 'working',
    '附7c 退回之后执行者再回「收到」⇒ 变回 working（链子一次顺到底）',
    `状态=${JSON.stringify(st4)}`);
}

// ===== 附8：建不出来就当场拒收（2026-10-05 改；代码审查第 3 条）=====
// 改前：建任务排在**入账之后**、失败被空 `catch` 吞掉 ⇒ 造出"账本里有这条派活、任务表里没这张卡"
// 的幽灵主任务 ⇒ ① 门口的"一次只跑一包"形同虚设 ② 执行者回「收到」/交付时 findSubtask 找不到。
{
  resetData();
  const before = DL.readMessages().length;
  const r = EV.receive(mk({
    id: 'ghost-1', source: 'a', type: 'task.assign', to: ['b'],
    // ⚠️ 故意缺 `to`：`validate` 拦不到这条，只有 `createTask` 才拒
    data: { task: '00003-20261005130000', subtasks: [{ id: '00003-20261005130000-1', timeout: 600 }] },
  }));
  const after = DL.readMessages().length;
  rec(r.ok === false && after === before && !DL.getTask('00003-20261005130000'),
    '附8 ⭐ 建不出来（子任务缺 to）⇒ 当场拒收：账本不落、任务表不建（改前会留下幽灵主任务）',
    `ok=${r.ok}；拒因「${r.reason}」；账本 ${before}→${after} 条；任务卡=${JSON.stringify(DL.getTask('00003-20261005130000'))}`);
}

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

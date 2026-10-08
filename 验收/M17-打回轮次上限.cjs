'use strict';
/**
 * 办公室 · M17 打回轮次上限 验收脚本（hyr980 写，2026-10-06）
 *
 * 为什么要它：这条口径 **2026-10-03 就定死了**（老大原话「你打回第二次的时候，他做完了交上来
 * 还是不行，选择重派，不然自己做」），代码也**早就写了**（`envelope.js` L353-366 ＋ `timeout.js`
 * `handleMaxRounds`）—— **但从来没有验收脚本跑过它**：M1–M15 各有读数，就它没有。
 * ⚠️ 而且 M10「轮次口径」验的是**轮次怎么算**（显示口径），**不是**"第 3 次打回被不被拒" —— 两回事。
 *
 * 判据（正本）：
 *   · 规范 `01-信封.md` §5 第 10 条 ＋ 老大 2026-10-03 定
 *   · `程序\后端\envelope.js` L353-366：`countRework(board, subId) >= 2` ⇒ 拒
 *     （`reason` 以 `max-rounds:` 开头、`notify` ＝「这件已经干满 3 轮，换人重派」）
 *   · `程序\后端\bridge.js` L503-508：认出 `max-rounds:` ⇒ 调 `timeout.handleMaxRounds(subId)`
 *   · `程序\后端\timeout.js` L495-512：`handleMaxRounds` ＝ 标 `cancelled` ＋ 删计时器 ＋ 记 tried
 *     ＋ **通知派发者**（出口 `setSender`，没接线才退回 `emit`）＋ 留痕；已 cancelled／done ⇒ 幂等跳过
 *
 * ⭐ 判据设计（**关键：要能分辨**）：第 1、2 次打回**必须放行**，只有第 3 次才拒 ——
 *    这两条"对照"比"拒"本身更重要：少了它们，一个"见打回就拒"的坏实现也能骗过脚本。
 * ⭐ 通知那条同理：光看"事件产生了"不算数 —— 要**装上发信口**看它真送到派发者手上，
 *    并且确认**没有** `system-notify-unsent`（那个事件就是"通知丢了"的意思）。
 *
 * ⚠️ 会清写 `运行\数据\`（board／tasks／seq／**members 卡**）—— 已按 M10 的做法读完原件、
 *    进程退出时**逐字还原**。⚠️ 纯模块直调：**不起任何进程**（不 startHttp、不挂连接）。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');

const DL = require(path.join(BACKEND, 'data-layer.js'));
const ST = require(path.join(BACKEND, 'status.js'));
const TO = require(path.join(BACKEND, 'timeout.js'));
const ENV = require(path.join(BACKEND, 'envelope.js'));
const MEM = require(path.join(BACKEND, 'members.js'));

// ─────────────────────────── 结果记录（照 M4）

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}
function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', String(e && e.message || e)); }
}

// ─────────────────────────── ⚠️ 生产数据的"跑完自动还原"（照 M10）

const ORIG = {};
const ORIG_LIST = fs.existsSync(DATA) ? fs.readdirSync(DATA) : [];
for (const f of ORIG_LIST) {
  const p = path.join(DATA, f);
  try { if (fs.statSync(p).isFile()) ORIG[f] = fs.readFileSync(p, 'utf8'); } catch (_) {}
}
process.on('exit', () => {
  try {
    for (const f of fs.readdirSync(DATA)) {
      if (f === '.gitkeep') continue;
      if (ORIG[f] === undefined) { try { fs.unlinkSync(path.join(DATA, f)); } catch (_) {} }
    }
    for (const f of Object.keys(ORIG)) {
      try { fs.writeFileSync(path.join(DATA, f), ORIG[f], 'utf8'); } catch (_) {}
    }
  } catch (_) { /* 还原失败也别把退出流程带崩 */ }
});

function resetData() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
  fs.writeFileSync(path.join(DATA, 'members.json'), '{}', 'utf8');
}

/**
 * 隔离实例（照 M4：每次新建 ⇒ 内存计时表清空）。
 * ⭐ 另外两件**必须**做的事（2026-10-06 实撞）：
 *  ① **给收件人建卡**：`envelope` 会先查"收件人存在吗"，只塞状态机名单不算数
 *     （我第一次跑就是全被「收件人不存在: b」拦掉，7 条读数全废）；
 *  ② **给计时器装发信口** `setSender`：不装 ⇒ 通知走 `emit` 只落事件，
 *     盘上还会记一条 `system-notify-unsent`（"通知丢了"）⇒ 那就验不出"派发者真收到"。
 */
function fresh() {
  const st = ST.createStatus(DL);
  st.setMembers(['a', 'b', 'c']);
  const to = TO.createTimeout(DL, { status: st, log: null });
  const sent = [];
  to.setSender((m) => { sent.push(m); return { ok: true }; });
  return { st, to, sent };
}

// ─────────────────────────── 造场景

const MAIN = '90002-20261006120000';
const SUB = MAIN + '-1';
const T = '2026-10-06T12:00:00+08:00';

let n = 0;
function put(msg) {
  n++;
  const m = Object.assign({ id: 'm17-' + n, source: 'a', specversion: '1.0', time: T }, msg);
  DL.appendMessage(m);
  return m;
}

function build() {
  resetData();
  MEM.ensureMember('a');
  MEM.ensureMember('b');
  MEM.ensureMember('c');
  DL.createTask({
    id: MAIN, title: 'M17 打回轮次上限', note: '轮次上限',
    subtasks: [{ id: SUB, to: 'b', timeout: 600, note: '要被反复打回的那件', state: 'working' }],
  });
  // 派发（a ⇒ b）
  put({
    type: 'task.assign', source: 'a', to: ['b'],
    data: { task: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] },
  });
}

/**
 * 交一次 ＋ 打回一次。
 * ⚠️⚠️ **别自己再入账**（2026-10-06 连撞）：`envelope.receive()` **不只是校验 —— 它会入账**
 *    （`bridge.receiveAndDeliver` 从头到尾只调它一次、之后再没 `append` ⇒ 入账就在它内部）。
 *    我原来在校验后又 `DL.appendMessage(msg)` ⇒ 同一条打回写了两遍 ⇒ `countRework` 第 2 次就数到 2
 *    ⇒ "第 2 次打回"被误拒、看起来像实现坏了。
 * @returns {{r:object, msg:object}} r ＝ `ENV.receive` 的回话
 */
function deliverThenRework(round) {
  const d = put({ type: 'task.deliver', source: 'b', to: ['a'], data: { task: SUB, text: '第 ' + round + ' 版' } });
  const msg = {
    id: 'rework-' + round, source: 'a', specversion: '1.0', time: T, type: 'task.assign',
    // ⚠️ `data.subtasks:[{id}]` **必须带**：`envelope.js` L262-272「打回不新起号」那条校验
    //    要求子任务 id **沿用原号**（不带 ⇒ 判"写的是空" ⇒ 拒，而且它排在"打回轮次"那条**前面**，
    //    会先把读数全拦掉 —— 2026-10-06 实撞）。用意：换号能过的话，计数链就断 ⇒ 可无限打回。
    // ⚠️⚠️ 两个字段**含义不同、别混**（2026-10-06 连撞两次）：
    //   · `data.task` —— `task.assign` 里它是**主任务 id**（`envelope.js` L338 拿它 `dl.getTask()`
    //     判断"这是不是新建主任务那条"；写成子任务 id ⇒ 查不到 ⇒ 被当成新建 ⇒ 撞「已有主任务在跑」）；
    //   · `data.subtasks[].id` —— 要**沿用原子任务号**（L262-272「打回不新起号」那条校验）。
    //    · 打回的 `subtasks` 项**照抄首派的形状**（`{id, to, timeout}`）—— 理由：打回就是
    //      "同一件任务的下一轮"，派发那关要什么它就要什么；⚠️ 少一个 `timeout` 会被第 10 条
    //      「时限必须是正数」拦掉（`envelope.js` L368-377），**而那条排在 max-rounds 后面**
    //      ⇒ 前两次打回全被它拦、没入账 ⇒ countRework 永远 0 ⇒ max-rounds 永远触发不到
    //      （2026-10-06 连撞四次的完整教训）。
    to: ['b'], inreplyto: d.id, data: { task: MAIN, subtasks: [{ id: SUB, to: 'b', timeout: 600 }] },
  };
  const r = ENV.receive(msg);   // ⚠️ 它**自己就入账**了，别再 `appendMessage`（见函数头注释）
  return { r, msg };
}

// ═══════════════════════════ 开跑

console.log('=== 办公室 M17 打回轮次上限 验收 ===');
console.log('数据目录：' + DATA + '（跑完自动还原）');
console.log('判据：打回满 2 次 ⇒ 第 3 次打回被拒（最多 3 轮），随后走"换人重派"收尾');
console.log('');

// ── 一 · 前两次打回必须放行（对照组：少了它们，坏实现也能骗过脚本）

group('一 · 前两次打回', () => {
  build();
  const { to } = fresh();
  const r1 = deliverThenRework(1);
  const r2 = deliverThenRework(2);
  rec(r1.r && r1.r.ok === true, '第 1 次打回：**放行**（打回满 2 次才拒）', JSON.stringify(r1.r));
  rec(r2.r && r2.r.ok === true, '第 2 次打回：**放行**', JSON.stringify(r2.r));
  rec(ENV.countRework(DL.readMessages(), SUB) === 2, '此时账本里打回次数 = 2', String(ENV.countRework(DL.readMessages(), SUB)));
  rec(!!to, '计时器实例建起来了（下面用它验收尾）', typeof to.handleMaxRounds);
});

// ── 二 · 第 3 次打回：被服务端拒

group('二 · 第 3 次打回', () => {
  const r3 = deliverThenRework(3);
  const rr = r3.r || {};
  rec(rr.ok === false, '第 3 次打回：**被拒**（ok:false）', JSON.stringify(rr));
  rec(typeof rr.reason === 'string' && rr.reason.startsWith('max-rounds:'),
    'reason 以 `max-rounds:` 开头（`bridge.js` 就是靠这个前缀认出该收尾）', String(rr.reason));
  rec(/换人重派/.test(String(rr.notify || '')), 'notify 说了人话：「换人重派」', String(rr.notify));
  rec(ENV.countRework(DL.readMessages(), SUB) === 2,
    '被拒的那条**没进账本**（打回次数仍是 2，不是 3）', String(ENV.countRework(DL.readMessages(), SUB)));
});

// ── 三 · 同族规矩：打回只能发给原执行者

group('三 · 打回发给别人', () => {
  const d = put({ type: 'task.deliver', source: 'b', to: ['a'], data: { task: SUB, text: '再来一版' } });
  const bad = {
    id: 'rework-to-other', source: 'a', specversion: '1.0', time: T, type: 'task.assign',
    to: ['c'], inreplyto: d.id, data: { task: SUB },
  };
  const r = ENV.receive(bad);
  rec(r && r.ok === false && /只能发给原执行者/.test(String(r.reason || '')),
    '打回发给**非原执行者** ⇒ 拒（`envelope.js` L254-259）', JSON.stringify(r));
});

// ── 四 · 拒了之后的收尾（`bridge.js` L503 ⇒ `timeout.handleMaxRounds`）

group('四 · 收尾：handleMaxRounds', () => {
  const { to, sent } = fresh();
  const r = to.handleMaxRounds(SUB);
  rec(r && r.ok === true, 'handleMaxRounds 返回 ok', JSON.stringify(r));
  const stt = DL.getTask(MAIN).subtasks.find((s) => s.id === SUB);
  rec(stt && stt.state === 'cancelled', '那件子任务被标成 `cancelled`', stt && stt.state);

  const kinds = (typeof to.getEvents === 'function' ? to.getEvents() : []).map((e) => e && e.kind);
  rec(kinds.includes('max-rounds'), '留痕：事件 `max-rounds`', JSON.stringify(kinds));
  rec(!kinds.includes('system-notify-unsent'),
    '⭐ **没有** `system-notify-unsent`（通知没丢）', JSON.stringify(kinds));

  // ⭐ 硬判据：通知**真送到派发者手上**（装了发信口之后）
  const toAssigner = sent.filter((m) => {
    const to2 = (m && m.to) || [];
    return Array.isArray(to2) ? to2.includes('a') : String(to2) === 'a';
  });
  rec(toAssigner.length > 0, '⭐ 派发者**真的收到**一条通知（`setSender` 出口有东西）',
    JSON.stringify(sent).slice(0, 220));
  rec(toAssigner.some((m) => /换人重派|干满 3 轮/.test(JSON.stringify(m))),
    '那条通知里写着「干满 3 轮／换人重派」（人话）', JSON.stringify(toAssigner).slice(0, 220));

  // 幂等：已经 cancelled 的再叫一次 ⇒ 跳过（别重复通知、别重复标）
  const r2 = to.handleMaxRounds(SUB);
  rec(r2 && r2.ok === true && r2.skipped === true, '再叫一次 ⇒ 幂等跳过（`skipped:true`）', JSON.stringify(r2));

  // 不存在的子任务 ⇒ 明确报错
  const r3 = to.handleMaxRounds('不存在的号');
  rec(r3 && r3.ok === false, '给一个不存在的子任务 ⇒ ok:false（不静默）', JSON.stringify(r3));
});

// ── 五 · 收尾之后，"换人重派"这条路还在（派发者要能接着重派）

group('五 · 重派入口还在', () => {
  const { to } = fresh();
  rec(typeof to.handleMaxRounds === 'function', 'handleMaxRounds 在（收尾入口）', typeof to.handleMaxRounds);
  rec(typeof to.assignRetry === 'function' || typeof to.handleAssignRetry === 'function',
    '换人重派入口在（`assignRetry`）—— 收尾完派发者要靠它把活转出去',
    typeof to.assignRetry === 'function' ? 'assignRetry' : (typeof to.handleAssignRetry === 'function' ? 'handleAssignRetry' : '都没导出'));
});

// ── 出结果

console.log(out.join('\n'));
console.log('\n════════ 结果：' + pass + ' 过 / ' + fail + ' 没过 / ' + skip + ' 没法验 ════════');
process.exit(fail === 0 ? 0 : 1);

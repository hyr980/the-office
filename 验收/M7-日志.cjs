'use strict';
/**
 * 办公室 · M7 日志 验收脚本（hyr980 写，2026-10-03）
 * 依据：验收清单-20261003.md 二·M7（六条）＋ 规范\05-规矩与说明书.md / 08-落地结构.md
 *
 * 做法：
 *   A 段：日志模块本身（隔离目录 + 假时钟）—— 不脏任何生产文件
 *   B 段：拒收留痕（真 bridge，log 注入到沙盒）—— 拒收不落账本，跑完核账本没变
 *   E 段：跟账本分开（用跑前快照，因为 C 段会清数据）
 *   C 段：踢人三型（每型重造一次场景）
 *   D 段：轮次 —— 真链路：timeout 事件 ⇒ toLogEvent 折成固定词 ⇒ 落 .jsonl（沙盒）
 *   F 段（并入 D 段）：交叉核对 —— timeout.js 里的每个事件名都能折进 7 词表
 *
 * ⚠️ 会写 <程序>\数据\（C 段 resetData）—— 跑前备份、跑完恢复
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const SANDBOX = path.join(__dirname, '_沙盒');       // ⚠️ 脚本自己建（不再依赖预先存在）
const SBOX_LOG = path.join(SANDBOX, '日志');
const PROD_LOG = path.join(ROOT, '运行', '日志');    // ⚠️ 0.2 起：日志在 运行\ 下
const PROD_DATA = path.join(ROOT, '运行', '数据');   // ⚠️ 0.2 起：数据在 运行\ 下

const LOG = require(path.join(BACKEND, 'log.js'));
const BR = require(path.join(BACKEND, 'bridge.js'));
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
  try { fn(); } catch (e) {
    rec(false, name + '（抛异常）', e.message + '\n         栈: ' + String((e.stack || '').split('\n')[1] || '').trim());
  }
}
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const lines = (p) => read(p).split('\n').filter((x) => x.trim());
const parseAll = (p) => lines(p).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
// ⭐ 2026-10-05 加：**跑完自动还原生产数据** —— 本脚本会**清空并写入** `运行\数据\`
//    （就是下面这个 resetData），原来跑完就留着、要靠人手工恢复；当天就因为跑完没还原，
//    紧接着起的"假人"读到了这里的残留派活、回收条时报「收件人不存在」（假象）。
//    ⇒ 在清之前把原内容读进内存，进程一退出（`process.exit` 也会触发 `exit`）就写回。
const ORIG_DATA = {};
const ORIG_FILES = fs.existsSync(PROD_DATA) ? fs.readdirSync(PROD_DATA) : [];
for (const f of ORIG_FILES) {
  const p = path.join(PROD_DATA, f);
  try { if (fs.statSync(p).isFile()) ORIG_DATA[f] = fs.readFileSync(p, 'utf8'); } catch (_) {}
}
process.on('exit', () => {
  try {
    // 先删"跑完多出来的"（原样还原的题中之义），再逐字写回原内容。
    for (const f of fs.readdirSync(PROD_DATA)) {
      if (f === '.gitkeep') continue;                       // 占位文件，别动
      if (ORIG_DATA[f] === undefined) { try { fs.unlinkSync(path.join(PROD_DATA, f)); } catch (_) {} }
    }
    for (const f of Object.keys(ORIG_DATA)) {
      try { fs.writeFileSync(path.join(PROD_DATA, f), ORIG_DATA[f], 'utf8'); } catch (_) {}
    }
  } catch (_) { /* 还原失败也别把退出流程带崩 */ }
});

function resetData() {
  fs.mkdirSync(PROD_DATA, { recursive: true });
  fs.writeFileSync(path.join(PROD_DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(PROD_DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(PROD_DATA, 'seq.txt'), '0', 'utf8');
}

// ── 跑前快照（C 段会清数据，E 段要用快照）──
const BOARD_SNAPSHOT = parseAll(path.join(PROD_DATA, 'board.jsonl'));
const MAIN = '00001-20261003100000';
const SUB = MAIN + '-1';

// ── 造场景（照 M4 那套）──
function fresh(collector) {
  const st = ST.createStatus(DL);
  st.setMembers(['a', 'b', 'c']);
  const to = TO.createTimeout(DL, { status: st, log: collector });
  return { st, to };
}
function makeTask(to = 'b', timeout = 5) {
  DL.createTask({ id: MAIN, subtasks: [{ id: SUB, to, timeout }] });
  DL.appendMessage({
    seq: 1, id: 'assign-1', source: 'a', specversion: '1.0', type: 'task.assign',
    to: [to], time: '2026-10-03T09:00:00+08:00',
    data: { task: MAIN, subtasks: [{ id: SUB, to, timeout }] },
  });
}

console.log('=== M7 验收（隔离日志目录 ' + SBOX_LOG + '）===');

// ============ A 段：日志模块本身 ============
group('A 段', () => {
  rmrf(SBOX_LOG);
  let fake = new Date('2026-10-03T10:00:00+08:00');
  const lg = LOG.createLogger({ logDir: SBOX_LOG, dateProvider: () => fake });

  lg.logEvent({ type: 'reject', who: 'a', why: '今天第一条' });
  lg.logEvent({ type: 'reject', who: 'a', why: '今天第二条' });
  fake = new Date('2026-10-04T09:00:00+08:00');
  lg.logEvent({ type: 'reject', who: 'a', why: '明天第一条' });

  const files = fs.existsSync(SBOX_LOG) ? fs.readdirSync(SBOX_LOG).sort() : [];
  rec(files.length === 2,
    '1. 按天：今天两条 ＋ 明天一条 ⇒ 日志目录里两个文件',
    `目录里 = [${files.join(', ')}]（${files.length} 个）`);
  const f1 = path.join(SBOX_LOG, '20261003.jsonl');
  const f2 = path.join(SBOX_LOG, '20261004.jsonl');
  rec(lines(f1).length === 2 && lines(f2).length === 1,
    '1b 两个文件里条数对得上（今天 2 行、明天 1 行）',
    `20261003.jsonl = ${lines(f1).length} 行；20261004.jsonl = ${lines(f2).length} 行`);

  const row = JSON.parse(lines(f1)[0]);
  rec(['ts', 'type', 'taskId', 'subId', 'who', 'why', 'extra'].every((k) => k in row),
    '1c 一行一个 JSON 对象，字段齐（ts/type/taskId/subId/who/why/extra）',
    `实际键 = [${Object.keys(row).join(', ')}]`);

  const rl = lg.readLog('20261003');
  rec(Array.isArray(rl) && rl.length === 2,
    '1d readLog("20261003") 读回 2 条', `返回 ${Array.isArray(rl) ? rl.length : typeof rl} 条`);
  const rlDefault = lg.readLog();
  rec(Array.isArray(rlDefault) && rlDefault.length === 1,
    '1e readLog() 不传日期 ⇒ 读"今天"（假时钟已推到明天 ⇒ 1 条）',
    `返回 ${rlDefault.length} 条（以假时钟为准）`);
  let bad = '';
  try { lg.readLog('2026-10-03'); } catch (e) { bad = e.message; }
  rec(bad === '日期必须是 YYYYMMDD 八位数字: 2026-10-03', '1f 非法日期拒绝', `抛 = ${bad}`);

  let okWord = '', badWord = '';
  try { lg.logEvent({ type: 'retry', why: '词表里的词' }); okWord = '放行'; } catch (e) { okWord = '抛: ' + e.message; }
  rec(okWord === '放行', '1g 词表里的词（retry）放行', okWord);
  try { lg.logEvent({ type: '随便编的词', why: 'x' }); badWord = '居然放行了'; } catch (e) { badWord = e.message; }
  rec(/必须是固定词/.test(badWord), '1h 词表外的词 ⇒ 拒（拒绝自由文本）', badWord);
});

// ============ B 段：拒收留痕 ============
group('B 段', () => {
  const boardBefore = lines(path.join(PROD_DATA, 'board.jsonl')).length;
  const lg = LOG.createLogger({ logDir: SBOX_LOG, dateProvider: () => new Date('2026-10-03T10:00:00+08:00') });
  const br = BR.createBridge({ log: lg, stateFile: path.join(SANDBOX, 'bridge-state.json') });
  const before = lines(path.join(SBOX_LOG, '20261003.jsonl')).length;

  const cases = [
    ['缺必填字段', { id: 'x1', source: 'a', specversion: '1.0', type: 'chat.message', data: {} }],
    ['收件人不存在', { id: 'x2', source: 'a', specversion: '1.0', type: 'chat.message', to: ['查无此人'], data: {} }],
    ['不认识的 type', { id: 'x3', source: 'a', specversion: '1.0', type: 'task.不存在', to: ['boss'], data: {} }],
  ];
  const reasons = [];
  for (const [name, msg] of cases) {
    const r = br.receiveAndDeliver(msg);
    reasons.push(`${name} ⇒ ok=${r.ok}，reason=${r.reason}`);
  }
  const after = lines(path.join(SBOX_LOG, '20261003.jsonl')).length;
  const added = after - before;

  rec(added === 3, '2. 不合规消息 ⇒ 日志里各留一行', `拒收前 ${before} 行 ⇒ 拒收后 ${after} 行（＋${added}）`);
  const newRows = parseAll(path.join(SBOX_LOG, '20261003.jsonl')).slice(before);
  const allReject = newRows.length === 3 && newRows.every((r) => r.type === 'reject');
  const allHaveWhy = newRows.every((r) => typeof r.why === 'string' && r.why.length > 0);
  rec(allReject && allHaveWhy, '2b 留痕带"为什么"（type=reject ＋ why 有内容）',
    newRows.map((r) => `why=${r.why}`).join('\n         '));
  rec(newRows.every((r) => r.subId === null),
    '2c ⚠️ 拒收留痕的 subId 全是 null（bridge.js:317 没填这个字段）',
    `三条的 subId = [${newRows.map((r) => JSON.stringify(r.subId)).join(', ')}]`);
  out.push('         各条回话：\n         ' + reasons.join('\n         '));

  const boardAfter = lines(path.join(PROD_DATA, 'board.jsonl')).length;
  rec(boardBefore === boardAfter, '2d 拒收不落账本（board.jsonl 行数没变）',
    `跑前 ${boardBefore} 行 ⇒ 跑后 ${boardAfter} 行`);
});

// ============ E 段：跟账本分开（用跑前快照）============
group('E 段', () => {
  const board = BOARD_SNAPSHOT;
  const sysEvents = board.filter((r) => ['reject', 'cancel', 'kick', 'dispatcher-dead', 'over', 'state', 'retry'].includes(r.type)
    || r.event !== undefined || r.ts !== undefined);
  rec(sysEvents.length === 0,
    '5. 跟账本分开：board.jsonl 里没有这些系统事件',
    `跑前账本 ${board.length} 条，其中带 type=固定词/event/ts 的 = ${sysEvents.length} 条`);
  const boardKeys = board.length ? [...new Set(board.flatMap((r) => Object.keys(r)))].sort() : [];
  out.push(`         账本实际字段 = [${boardKeys.join(', ')}]`);
});

// ============ C 段：超时收尾（2026-10-04 新口径：不分型；先插话、随即断开连接）============
group('C 段', () => {
  resetData();
  const collected = [];
  const interrupted = [];
  const kicked = [];
  const { st, to } = fresh((e) => collected.push(e));
  st.setPresence('b', 'online');   // ⚠️ 新口径：要显式上线（在线时才走"先插一句停"那条）
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');
  to.setInterrupt((memberId, text) => interrupted.push({ memberId, text }));
  to.setKick((memberId, why) => kicked.push({ memberId, why }));
  to.startTimers();

  const r = to.handleTimeout(SUB);   // ⭐ 不再传 type（"分三型"已作废）

  const canTell = collected.some((e) => e.event === 'timeout') || kicked.some((k) => k.why && /超时/.test(k.why));
  const detail = `handleTimeout ⇒ ${JSON.stringify(r)}\n         留痕=[${collected.map((e) => e.event).join(' + ')}]\n         插话=[${interrupted.map((i) => i.text).join(' | ')}]\n         收尾=[${kicked.map((k) => k.why).join(' | ')}]`;
  rec(canTell && r.ok === true, '3 · 超时 ⇒ 留痕能看出是"时限超过"（不再分 ①②③ 三型）', detail);
  rec(interrupted.length === 1 && /请停/.test(interrupted[0].text),
    '3b ⭐ 在线时先插一句"停"（送过去就算，不等回话）', `插话=[${interrupted.map((i) => i.text).join(' | ')}]`);
  rec(kicked.length === 1 && /超时/.test(kicked[0].why),
    '3c ⭐ 随即断开连接（走 kick 那条口，接的是 status.disconnect）', `收尾=[${kicked.map((k) => k.why).join(' | ')}]`);
  const stAfter = DL.getTask(MAIN).subtasks[0].state;
  rec(stAfter === 'cancelled', '3d 那件标 cancelled', `state=${stAfter}`);
});

// ============ D 段：轮次（真链路：timeout 事件 ⇒ 固定词 ⇒ .jsonl）============
group('D 段', () => {
  const lg = LOG.createLogger({ logDir: SBOX_LOG, dateProvider: () => new Date('2026-10-03T10:00:00+08:00') });
  const before = lines(path.join(SBOX_LOG, '20261003.jsonl')).length;

  // 打回满 3 轮 ⇒ 换人重派：走真 timeout 逻辑，日志经 toLogEvent 折成固定词落 .jsonl
  resetData();
  const st = ST.createStatus(DL);
  st.setMembers(['a', 'b', 'c']);
  ['a', 'b', 'c'].forEach((id) => st.setPresence(id, 'online')); // 造场景：三人都得在线，否则重派目标被"门一"拒
  const to = TO.createTimeout(DL, { status: st, log: (e) => lg.logEvent(TO.toLogEvent(e)) });
  makeTask('b', 5);
  DL.setSubtaskState(MAIN, SUB, 'working');

  const rMax = to.handleMaxRounds(SUB);
  const rRetry = to.assignRetry(SUB, 'c');

  const rows = lg.readLog('20261003').slice(before);
  const retryRows = rows.filter((r) => r.type === 'retry');
  const cancelRows = rows.filter((r) => r.type === 'cancel' && r.extra && r.extra.event === 'max-rounds');
  const detail0 = `handleMaxRounds ⇒ ${JSON.stringify(rMax)}；assignRetry(SUB,'c') ⇒ ${JSON.stringify(rRetry)}\n         新增留痕 = [${rows.map((r) => r.type + ':' + (r.extra && r.extra.event)).join(', ')}]`;

  // 口径（2026-10-03）：这里数的是**换过几个人**（tried＝"这份活试过谁"），不是"轮次"——
  // 轮次＝被交上来几次＝打回次数 + 1，按 inreplyto 链数（03 §3.1／交付包 待改事项-20261003.md 第三条）
  const triedOf = (retryRows[0] && retryRows[0].extra && Array.isArray(retryRows[0].extra.tried))
    ? retryRows[0].extra.tried : null;
  const triedCount = triedOf ? triedOf.length + 1 : null;

  rec(retryRows.length === 1 && retryRows[0].subId === SUB && retryRows[0].extra && retryRows[0].extra.newSubId === MAIN + '-2',
    '4. 重派 ⇒ 日志里留 type=retry（带 subId/oldSubId/newSubId/tried）',
    `${detail0}\n         retry 行 = ${JSON.stringify(retryRows[0] || null)}`);

  rec(triedCount === 2 && triedOf.join(',') === 'b',
    '4b 用 M7 的接口（readLog）数得出**换过几个人**：该件 tried 名单长度 ＋ 1（⚠️ 不是"轮次"）',
    `retry 行的 extra.tried = [${triedOf ? triedOf.join(',') : 'null'}] ⇒ 换过 ${triedCount} 人`);

  rec(cancelRows.length === 1,
    '4c 打回超轮也留痕（折成 cancel ＋ extra.event=max-rounds）',
    `cancel(max-rounds) = ${cancelRows.length} 条；样例 = ${JSON.stringify(cancelRows[0] || null)}`);

  // F 段（并入）：timeout.js 里每个 log 事件名都能折进 7 词表
  const src = read(path.join(BACKEND, 'timeout.js'));
  const names = [...new Set([...src.matchAll(/event:\s*'([^']+)'/g)].map((m) => m[1]))];
  const folded = names.map((n) => ({ n, t: TO.toLogEvent({ event: n }).type }));
  const bad = folded.filter((x) => !LOG.EVENT_TYPES.includes(x.t));
  rec(names.length >= 14 && bad.length === 0,
    `4f 交叉核对：timeout.js 的 ${names.length} 个事件名全部折进 7 词表`,
    `映射 = ${folded.map((x) => x.n + '→' + x.t).join('、')}${bad.length ? '\n         ⚠️ 折不进去 = ' + JSON.stringify(bad) : ''}`);

  // 生产默认路径：不注入 log ⇒ 真写 程序\日志\<今天>.jsonl（统一成一本账）
  const d0 = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const today = `${d0.getFullYear()}${p2(d0.getMonth() + 1)}${p2(d0.getDate())}`;
  const prodFile = path.join(PROD_LOG, today + '.jsonl');
  const b1 = lines(prodFile).length;
  const toProd = TO.createTimeout(DL, { status: st });
  toProd.onDeliver(SUB, 'deliver-验收');
  const b2 = lines(prodFile).length;
  const last = parseAll(prodFile).pop() || null;
  rec(b2 === b1 + 1 && !!last && last.type === 'state' && !!last.extra && last.extra.event === 'deliver-watch',
    '4d 统一成一本账：生产默认日志只写 .jsonl',
    `${today}.jsonl ${b1} 行 ⇒ ${b2} 行；末行 = ${JSON.stringify(last)}`);
  const logFiles = fs.existsSync(PROD_LOG) ? fs.readdirSync(PROD_LOG).sort() : [];
  out.push(`         生产日志目录现有 = [${logFiles.join(', ')}]（历史 .log 是分裂期遗留，不再新增）`);
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

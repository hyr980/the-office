'use strict';
/**
 * 办公室 · M1 数据层 验收脚本（hyr980 写，2026-10-03）
 *
 * 依据：验收清单-20261003.md 二·M1（五条）+ 一·通用检查
 * 用法：node M1-数据层.cjs
 * ⚠️ 本脚本会写 <程序>\数据\ —— 跑之前先备份、跑完恢复（见同目录 README）
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const DATA = path.join(ROOT, '运行', '数据');
const DL = require(path.join(BACKEND, 'data-layer.js'));
const { appendMessage, readMessages, nextTaskSeq, makeTaskId, createTask, getTask, listTasks, setSubtaskState, closeTask } = DL;

const out = [];
let pass = 0, fail = 0, skip = 0;

function rec(level, name, ok, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}

/** 期望抛错且消息里含关键词 */
function expectThrow(name, fn, keywords) {
  try {
    const r = fn();
    rec('', name, false, `没有拒！返回了 ${JSON.stringify(r)}`);
  } catch (e) {
    const msg = String(e && e.message || e);
    const miss = keywords.filter((k) => !msg.includes(k));
    if (miss.length === 0) rec('', name, true, `拒了，理由对得上：「${msg}」`);
    else rec('', name, false, `拒了但理由缺关键词 ${JSON.stringify(miss)}，实际：「${msg}」`);
  }
}

function resetData() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'board.jsonl'), '', 'utf8');
  fs.writeFileSync(path.join(DATA, 'tasks.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
}

// ─────────────────────────────────────────
console.log('=== 清空数据目录，开始验 ===');
resetData();

// ===== 第 1 条：写一条读一条，字段一字不差 =====
{
  const msg = {
    id: 'test-0001', source: 'tester', specversion: '1.0', type: 'chat.message',
    to: ['boss'], time: '2026-10-03T09:00:00+08:00', conversationid: 'conv-1',
    data: { text: '写一条读一条', n: 42 },
  };
  const boardPath = path.join(DATA, 'board.jsonl');
  const before = fs.readFileSync(boardPath, 'utf8').split('\n').filter(Boolean).length;
  const { seq } = appendMessage(msg);
  const after = fs.readFileSync(boardPath, 'utf8').split('\n').filter(Boolean).length;
  rec('', '1a 写一条 ⇒ 文件多一行', after === before + 1, `写前 ${before} 行 ⇒ 写后 ${after} 行（seq=${seq}）`);

  const got = readMessages({ sinceSeq: 0 });
  const one = got[got.length - 1];
  const diffs = [];
  for (const [k, v] of Object.entries(msg)) {
    if (JSON.stringify(one[k]) !== JSON.stringify(v)) diffs.push(`${k}: 期望 ${JSON.stringify(v)} 实得 ${JSON.stringify(one[k])}`);
  }
  rec('', '1b 读回来字段一字不差', diffs.length === 0, diffs.length ? diffs.join('；') : `回来 ${Object.keys(one).length} 个字段全等（含 seq=${one.seq}）`);

  // sinceSeq 过滤
  appendMessage({ ...msg, id: 'test-0002' });
  const only2 = readMessages({ sinceSeq: 2 });
  rec('', '1c readMessages 的 sinceSeq 过滤', only2.length === 1 && only2[0].id === 'test-0002', `sinceSeq=2 回来 ${only2.length} 条，第一条 id=${only2[0] && only2[0].id}`);

  // 升序
  const all = readMessages({});
  const asc = all.every((m, i) => i === 0 || all[i - 1].seq <= m.seq);
  rec('', '1d 读回来按 seq 升序', asc, `${all.length} 条，seq = ${all.map((m) => m.seq).join(',')}`);

  // 缺必填字段
  expectThrow('1e 缺必填字段（缺 to）⇒ 拒', () => appendMessage({ id: 'x', source: 's', specversion: '1.0', type: 'chat.message', data: {} }), ['信封缺必填字段', 'to']);
}

// ===== 第 2 条：发号不重复、递增、格式 =====
{
  const seqs = [nextTaskSeq(), nextTaskSeq(), nextTaskSeq()];
  const uniq = new Set(seqs).size === 3;
  const inc = seqs[1] === seqs[0] + 1 && seqs[2] === seqs[1] + 1;
  rec('', '2a 连要 3 个号：互不相同', uniq, `拿到 ${seqs.join(', ')}`);
  rec('', '2b 连要 3 个号：顺序递增（+1）', inc, `${seqs[0]} → ${seqs[1]} → ${seqs[2]}`);

  const id1 = makeTaskId();
  const id2 = makeTaskId();
  const fmt = /^\d{5}-\d{14}$/;
  rec('', '2c 任务 id 格式 = 顺序号-时间（5 位 + 14 位）', fmt.test(id1) && fmt.test(id2), `拿到「${id1}」「${id2}」（期望形如 00003-20261003022015）`);
  rec('', '2d 两次 makeTaskId 不撞号', id1 !== id2, `「${id1}」≠「${id2}」`);
}

// ===== 第 3 条：前缀校验必须拒 =====
{
  resetData();
  // 先造一个主任务 00002-<时间>
  const t2 = createTask({
    id: '00002-20261003100000', title: '主任务二号', subtasks: [{ id: '00002-20261003100000-1', to: 'b', timeout: 60 }],
  });
  rec('', '3a 造主任务 00002-…（正常建）', !!t2 && !!getTask('00002-20261003100000'), `建出 ${t2 && t2.id}`);

  expectThrow('3b 拿 00001-…-1 去配主任务 00002-… ⇒ 必须拒',
    () => setSubtaskState('00002-20261003100000', '00001-20261003100000-1', 'working'),
    ['前缀']);

  // ⚠️ 3c 得在干净局里测：上面 3a 建的主任务还开着，会先撞"已有主任务在跑"（2026-10-03 第一版脚本踩过）
  resetData();
  expectThrow('3c createTask 里子任务前缀不对 ⇒ 拒（干净局）',
    () => createTask({ id: '00003-20261003100000', subtasks: [{ id: '00099-xxx-1', to: 'b', timeout: 60 }] }),
    ['前缀']);

  // 3d/3e 需要那个 00002 主任务，重新建回来
  createTask({
    id: '00002-20261003100000', title: '主任务二号', subtasks: [{ id: '00002-20261003100000-1', to: 'b', timeout: 60 }],
  });

  expectThrow('3d 未知状态（不在五档）⇒ 拒',
    () => setSubtaskState('00002-20261003100000', '00002-20261003100000-1', 'zombie'),
    ['未知状态', 'working/delivered/done/blocked/cancelled']);

  // 正常改状态
  const st = setSubtaskState('00002-20261003100000', '00002-20261003100000-1', 'working');
  rec('', '3e 正常改状态能过（对照组）', st && st.state === 'working', `state=${st && st.state}，stateUpdatedAt=${st && st.stateUpdatedAt}`);
}

// ===== 第 4 条：清单不齐（1 件活 2 个人）必须拒 =====
{
  resetData();
  expectThrow('4a 1 个子任务但 to 里 2 个人 ⇒ 必须拒',
    () => createTask({
      id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 60 }], to: ['b', 'c'],
    }),
    ['清单不齐', '2 人', '1 件']);

  expectThrow('4b 两件事派给同一个人 ⇒ 拒',
    () => createTask({
      id: '00001-20261003100000',
      subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 60 }, { id: '00001-20261003100000-2', to: 'b', timeout: 60 }],
    }),
    ['同一个人']);

  expectThrow('4c 子任务清单空 ⇒ 拒',
    () => createTask({ id: '00001-20261003100000', subtasks: [] }),
    ['清单不齐']);

  expectThrow('4d 子任务缺 timeout ⇒ 拒',
    () => createTask({ id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-1', to: 'b' }] }),
    ['timeout']);

  const ok = createTask({
    id: '00001-20261003100000', title: '正好一件活一个人',
    subtasks: [{ id: '00001-20261003100000-1', to: 'b', timeout: 60 }], to: ['b'],
  });
  rec('', '4e 1 件活 1 个人、to 对齐 ⇒ 放行（对照组）', !!ok, `建出 ${ok && ok.id}，closed=${ok && ok.closed}`);

  expectThrow('4f 已有主任务在跑时再建 ⇒ 拒',
    () => createTask({ id: '00002-20261003100000', subtasks: [{ id: '00002-20261003100000-1', to: 'b', timeout: 60 }] }),
    ['已有主任务在跑', '同一时间只允许一个主任务']);

  expectThrow('4g 任务 id 重复用 ⇒ 拒',
    () => createTask({ id: '00001-20261003100000', subtasks: [{ id: '00001-20261003100000-9', to: 'b', timeout: 60 }] }),
    ['id 已存在', '不能重复用']);
}

// ===== 第 5 条：单写者 =====
{
  const src = fs.readFileSync(path.join(BACKEND, 'data-layer.js'), 'utf8');
  const hasNote = /单写者/.test(src);
  const hasLock = /flock|lockfile|proper-lockfile|lockSync|O_EXCL/i.test(src);
  rec('', '5a 源码里说得清"单写者、不做文件锁"', hasNote && !hasLock,
    `注释里有「单写者」=${hasNote}；出现第三方锁/文件锁关键字 = ${hasLock}（期望 false）`);
  // ⚠️ 只算"第三方"，内置模块不算（2026-10-03 第一版正则把 fs/path 也抓了，误判）
  const BUILTIN = new Set(['fs', 'path', 'http', 'https', 'net', 'os', 'child_process', 'crypto', 'url',
    'events', 'stream', 'util', 'zlib', 'assert', 'querystring', 'readline', 'tty', 'v8', 'vm',
    'worker_threads', 'string_decoder', 'timers', 'perf_hooks', 'dns', 'tls', 'dgram', 'cluster',
    'inspector', 'module', 'buffer', 'constants', 'domain', 'punycode', 'repl', 'sys', 'process']);
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  const thirdParty = reqs.filter((r) => !r.startsWith('.') && !BUILTIN.has(r.replace(/^node:/, '')));
  rec('', '5b 零第三方依赖（通用检查第 4 条·别做）', thirdParty.length === 0,
    `require：${reqs.join(' , ')}；非内置 = ${thirdParty.length ? thirdParty.join(',') : '无'}`);
}

// ===== 顺带：closeTask / listTasks / getTask =====
{
  resetData();
  createTask({
    id: '00001-20261003100000', title: '收口测试',
    subtasks: [
      { id: '00001-20261003100000-1', to: 'b', timeout: 60 },
      { id: '00001-20261003100000-2', to: 'c', timeout: 60 },
    ],
  });
  expectThrow('S1 子任务没全 done 就报 over ⇒ 拒',
    () => closeTask('00001-20261003100000'), ['还有子任务没完']);

  setSubtaskState('00001-20261003100000', '00001-20261003100000-1', 'done');
  expectThrow('S2 只 done 一件仍拒（要看全部）',
    () => closeTask('00001-20261003100000'), ['00001-20261003100000-2']);

  setSubtaskState('00001-20261003100000', '00001-20261003100000-2', 'done');
  const closed = closeTask('00001-20261003100000');
  rec('', 'S3 全 done 后报 over ⇒ 放行', closed && closed.closed === true, `closed=${closed && closed.closed}，closedAt=${closed && closed.closedAt}`);

  const nullT = getTask('不存在的主任务');
  rec('', 'S4 getTask 查不存在的 ⇒ 返回 null 而不是抛错', nullT === null, `返回 ${JSON.stringify(nullT)}`);

  // ⚠️ 2026-10-04 修：这里原来拿写死的 '20261003' 去对 —— 任务的 createdAt 是**跑脚本那天**，
  //    跨天必挂（8-3 写的脚本 10-4 跑就必然"没过"）。改成用当天日期。
  const today8 = (() => { const n = new Date(); const p = (x) => String(x).padStart(2, '0'); return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}`; })();
  const byDate = listTasks({ date: today8 });
  const byOther = listTasks({ date: '20260901' });
  rec('', 'S5 listTasks 按天过滤（按 createdAt）', byDate.length === 1 && byOther.length === 0,
    `date=${today8} 得 ${byDate.length} 条；date=20260901 得 ${byOther.length} 条`);

  // 停掉一个进程后再开，看号会不会撞（seq.txt 丢失兜底）
  fs.writeFileSync(path.join(DATA, 'seq.txt'), '0', 'utf8');
  const recovered = makeTaskId();
  rec('', 'S6 seq.txt 丢了也不会撞号（从任务表兜底）', recovered.startsWith('00002-'),
    `任务表里最大是 00001 ⇒ seq.txt 归零后仍发出「${recovered}」（期望 00002-…）`);
}

// ─────────────────────────────────────────
console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
process.exit(0);

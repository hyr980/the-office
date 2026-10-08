'use strict';
const cardKit = require('../程序/接入/_取卡.cjs');
/**
 * 办公室 · M10 轮次口径 验收脚本（hyr980 写，2026-10-03）
 *
 * 依据：
 *   - 规范 04-功能清单.md:97/99：任务板要显示"跑了多少轮"
 *   - log.js 顶部注释：① 换过几个人 ＝ tried 名单长度 + 1；② 轮次 ＝ 打回次数 + 1 —— 两个量别混
 *   - 交付包 待改事项-20261003.md 第三条：轮次 ＝ inreplyto 链上「指回某条 task.deliver 的
 *     task.assign」条数 + 1
 *   - envelope.js 第 8 条（同一件子任务最多 3 轮）本来就用同一套数法 ⇒ 已抽成 countRework 共用
 *
 * ⭐ 判据设计（关键：要让新旧两套算法**算得出不同结果**，否则等于没验）：
 *   A 件：打回 1 次、没换过人 ⇒ 期望轮次 2（旧的"换人"算法会算成 1）
 *   B 件：打回 0 次、换过 3 个人 ⇒ 期望轮次 1（旧的会算成 4）
 *   C 件：打回 2 次、换过 1 个人 ⇒ 期望轮次 3（旧的会算成 2）
 *   主任务：取各子任务最大值 ⇒ 3
 *
 * ⚠️ 会写 <程序>\数据\ —— 跑前备份、跑完恢复（由调用方负责）
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const PROD_DATA = path.join(ROOT, '运行', '数据');

const DL = require(path.join(BACKEND, 'data-layer.js'));
const BR = require(path.join(BACKEND, 'bridge.js'));
const ENV = require(path.join(BACKEND, 'envelope.js'));

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

const MAIN = '90001-20261003120000';
const SUB1 = MAIN + '-1';
const SUB2 = MAIN + '-2';
const SUB3 = MAIN + '-3';

// ⭐ 2026-10-05 加：**跑完自动还原生产数据** —— 本脚本会**清空并写入** `运行\数据\`
//    （就是下面这个 resetData），原来跑完就留着、要靠人手工恢复。
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

let n = 0;
function put(msg) {
  n++;
  const m = Object.assign(
    { id: 'm10-' + n, source: 'a', specversion: '1.0', time: '2026-10-03T12:00:00+08:00' },
    msg
  );
  DL.appendMessage(m);
  return m;
}

/** 造场景：三件子任务，"打回次数"和"换人次数"故意错开 */
function build() {
  resetData();
  put({
    type: 'task.assign', to: ['a'],
    data: {
      task: MAIN, title: 'M10 轮次验收',
      subtasks: [
        { id: SUB1, to: 'b', timeout: 600, note: '打回 1 次' },
        { id: SUB2, to: 'c', timeout: 600, note: '只换人没打回' },
        { id: SUB3, to: 'd', timeout: 600, note: '打回 2 次' },
      ],
    },
  });
  DL.createTask({
    id: MAIN, title: 'M10 轮次验收', note: '轮次口径',
    subtasks: [
      { id: SUB1, to: 'b', timeout: 600, note: '打回 1 次', state: 'working' },
      { id: SUB2, to: 'c', timeout: 600, note: '只换人没打回', state: 'working' },
      { id: SUB3, to: 'd', timeout: 600, note: '打回 2 次', state: 'working' },
    ],
  });

  // A 件：交 1 次 ⇒ 打回 1 次
  const d1 = put({ type: 'task.deliver', to: ['a'], data: { task: SUB1, text: 'A 第 1 版' } });
  put({ type: 'task.assign', to: ['b'], inreplyto: d1.id, data: { task: SUB1 } });

  // C 件：交 2 次 ⇒ 打回 2 次
  const d2 = put({ type: 'task.deliver', to: ['a'], data: { task: SUB3, text: 'C 第 1 版' } });
  put({ type: 'task.assign', to: ['d'], inreplyto: d2.id, data: { task: SUB3 } });
  const d3 = put({ type: 'task.deliver', to: ['a'], data: { task: SUB3, text: 'C 第 2 版' } });
  put({ type: 'task.assign', to: ['d'], inreplyto: d3.id, data: { task: SUB3 } });

  // B 件：没打回，但"换过 3 个人"（tried 长 3）—— 用来分辨两套算法
  // ⚠️ data-layer 的导出里没有 loadTasks/saveTasks（是内部函数）⇒ 直接读写 tasks.json。
  //    无妨：getTask/listTasks 每次都读文件、不缓存。
  const tf = path.join(PROD_DATA, 'tasks.json');
  const tasks = JSON.parse(fs.readFileSync(tf, 'utf8'));
  tasks[MAIN].subtasks.find((s) => s.id === SUB2).tried = ['c', 'd', 'e'];
  fs.writeFileSync(tf, JSON.stringify(tasks, null, 2), 'utf8');
}

function pad(s, w) { s = String(s); return s + ' '.repeat(Math.max(0, w - s.length)); }

(async function main() {
  console.log('=== 办公室 M10 轮次口径 验收 ===');
  console.log('数据目录：' + PROD_DATA);
  console.log('判据：轮次 ＝ 打回次数 + 1（不是"换过几个人"）');
  console.log('');

  build();

  // ── 一、envelope.countRework 这个共用函数本身 ──
  group('一 · countRework 直接调', () => {
    const board = DL.readMessages();
    const c1 = ENV.countRework(board, SUB1);
    const c2 = ENV.countRework(board, SUB2);
    const c3 = ENV.countRework(board, SUB3);
    rec(c1 === 1, 'A 件打回次数 = 1', '实际 ' + c1 + '（账本里指回 A 件的打回 assign 条数）');
    rec(c2 === 0, 'B 件打回次数 = 0', '实际 ' + c2 + '（B 件只有 tried 名单、没有打回链）');
    rec(c3 === 2, 'C 件打回次数 = 2', '实际 ' + c3);
    rec(typeof ENV.countRework === 'function', 'countRework 已从 envelope 导出', '类型 ' + typeof ENV.countRework);
  });

  // ── 二、list_tasks 报出来的 rounds ──
  const b = BR.createBridge();
  // ⭐ 2026-10-04 加：**先挂连接**（那道门落地后，直调 invokeTool 也要过门）——
  //   本脚本走进程内直调（`b.invokeTool`），所以得让**同一个实例**的 aliveConns 里
  //   真有一条连接。⚠️ 不能拿 `b.attachAlive('a', null)` 糊过去：`sweepAlive()`
  //   每 10 秒检查 `res`，没有 res 的当场被摘掉（`bridge.js` 的 `sweepAlive`）。
  const http = b.startHttp(0);
  // ⭐ 2026-10-05 修（原 A11）：随机端口要等 `listening` 之后 `url` 才是真地址
  //   —— 不 await 会拿到 `:0`，那条挂连接的 fetch 打空 ⇒ 门认为"没连着" ⇒ 后面全被拒。
  await http.ready;
  const base = http.url;
  const aliveCtrls = [];
  const keepAlive = (id) => {
    const ctrl = new AbortController();
    aliveCtrls.push(ctrl);
    fetch(`${base}/api/alive?memberId=${id}`, { signal: ctrl.signal, headers: cardKit.aliveHeaders(id) })
      .then((res) => {
        // SSE：不把流读干会被判空闲关掉 ⇒ 泵着读、内容丢掉
        const rd = res.body.getReader();
        const pump = () => rd.read().then(({ done }) => { if (!done) pump(); }).catch(() => {});
        pump();
      })
      .catch(() => {});
  };
  keepAlive('a');
  await new Promise((wait) => setTimeout(wait, 400));
  let r = null;
  try {
    r = await Promise.resolve(b.invokeTool('a', 'list_tasks', {}));
  } catch (e) {
    rec(false, 'list_tasks 调得动', e.message);
  }
  group('二 · list_tasks 的 rounds', () => {
    if (!r || !r.ok) { rec(false, 'list_tasks 返回 ok', JSON.stringify(r)); return; }
    const t = (r.data.tasks || [])[0];
    if (!t) { rec(false, '任务表里有这条主任务', JSON.stringify(r.data)); return; }
    const byId = {};
    (t.subtasks || []).forEach((s) => { byId[s.id] = s; });
    rec(byId[SUB1] && byId[SUB1].rounds === 2, 'A 件：打回 1 次 ⇒ 跑 2 轮',
      '实际 rounds=' + (byId[SUB1] && byId[SUB1].rounds) + '（旧的"换人"算法会给 1）');
    rec(byId[SUB2] && byId[SUB2].rounds === 1, 'B 件：换过 3 个人但没打回 ⇒ 跑 1 轮',
      '实际 rounds=' + (byId[SUB2] && byId[SUB2].rounds) + '（旧的"换人"算法会给 4）');
    rec(byId[SUB3] && byId[SUB3].rounds === 3, 'C 件：打回 2 次 ⇒ 跑 3 轮',
      '实际 rounds=' + (byId[SUB3] && byId[SUB3].rounds) + '（旧的"换人"算法会给 2）');
    rec(t.rounds === 3, '主任务 rounds = 各子任务最大值 = 3', '实际 ' + t.rounds);
  });

  // ── 三、边界：不存在的子任务号 ──
  group('三 · 边界', () => {
    const board = DL.readMessages();
    rec(ENV.countRework(board, '不存在的号') === 0, '查不存在的子任务号 ⇒ 0', '实际 ' + ENV.countRework(board, '不存在的号'));
    rec(ENV.countRework(board, null) === 0, '传 null ⇒ 0（不抛）', '实际 ' + ENV.countRework(board, null));
    rec(ENV.countRework([], SUB1) === 0, '空账本 ⇒ 0', '实际 ' + ENV.countRework([], SUB1));
  });

  // ── 四、和 envelope 第 8 条同一套（拒收阈值 2 与 countRework 对上）──
  group('四 · 与第 8 条口径一致', () => {
    const board = DL.readMessages();
    const c3 = ENV.countRework(board, SUB3);
    rec(c3 >= 2, 'C 件（打回 2 次）正好踩到第 8 条的拒收线', 'countRework=' + c3 + '，第 8 条判据是 >= 2 ⇒ 第 3 次打回拒收');
  });

  console.log(out.join('\n'));
  console.log('');
  console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);

  // 收尾（2026-10-04 加）：起了 HTTP ＋ 挂着 SSE，不关的话进程退不出去
  //   ⚠️ 实测踩过：只 `b.stop()`（它只停 ticker）**不够** —— HTTP 服务器还开着 ⇒ 进程一直不退。
  //   `startHttp()` 返回的 `{ name, server, port, url }` 里有 server，得把它 close 掉；
  //   末尾再加一个兜底退出，免得哪天又冒出新的长活把进程吊住。
  aliveCtrls.forEach((c) => c.abort());
  try { b.stop(); } catch (_) { /* 关不掉也别挡着出结果 */ }
  try { http.server.close(); } catch (_) { /* 同上 */ }

  if (fail > 0) process.exitCode = 1;
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 200);
})();

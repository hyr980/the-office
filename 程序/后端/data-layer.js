'use strict';

/**
 * M1 · 数据层 —— 账本 + 任务表 + 任务 id 发号
 *
 * 依据：
 *   - 模块\ M1-数据层.md
 *   - 规范\ 08-落地结构-20261002.md §一 / §一之二 / §三之二
 *   - 规范\ 01-信封-草案v1-20261002.md §2 / §3
 *   - 规范\ 03-状态机制-草案v1-20261002.md §4
 *
 * 分工：账本记"发生了什么"（消息流水）；任务表记"任务是什么"（内容 + 当前状态）。
 * 约束：零第三方依赖；单写者（只有服务端写，不做文件锁）；人可读、可 grep、可 diff。
 */

const fs = require('fs');
const path = require('path');

// 2026-10-04 新布局：本文件在 <办公室根>\程序\后端\ ⇒ 数据目录 = <办公室根>\运行\数据\
const DATA_DIR = path.join(__dirname, '..', '..', '运行', '数据');
const BOARD_FILE = path.join(DATA_DIR, 'board.jsonl');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const SEQ_FILE = path.join(DATA_DIR, 'seq.txt');

/** 子任务状态五档（03 §4）：working / delivered / done / blocked / cancelled */
const TASK_STATES = {
  WORKING: 'working',      // 接了就是干着（系统在 task.ack 时记）
  DELIVERED: 'delivered',  // 交了待验（系统在 task.deliver 时记）
  DONE: 'done',            // 验收过（派发者发）
  BLOCKED: 'blocked',      // 卡住了（执行者发）
  CANCELLED: 'cancelled',  // 已取消（系统发：超时/人死掉）
};

/** 信封六个必填字段（01 §2） */
const REQUIRED_FIELDS = ['id', 'source', 'specversion', 'type', 'to', 'data'];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BOARD_FILE)) fs.writeFileSync(BOARD_FILE, '', 'utf8');
  if (!fs.existsSync(TASKS_FILE)) fs.writeFileSync(TASKS_FILE, '{}', 'utf8');
}

/** 本地时间戳：YYYYMMDDHHMMSS（与任务 id 时间串同格式，供按天筛选） */
function localStamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

// ─────────────── 账本 ───────────────
// ⭐ 账本缓存（2026-10-04 加）：账本只追加、单写者 ⇒ 解析结果可以留着复用。
//    改前每写一条都要把整个文件读一遍、再数一遍最大 seq（O(n²)），消息一多就卡。
//    失效判据 ＝ 文件字节数变了（外部改写／截断／别的进程写都会变）⇒ 自动重扫，不会读旧账。
let boardCache = null;   // 解析后的消息数组（文件里什么样就什么样）
let boardSize = -1;      // 上次扫描时文件的字节数
let boardMaxSeq = 0;

/** 载入账本（走缓存；文件字节数变了才重读） */
function loadBoard() {
  ensureDataDir();
  const size = fs.existsSync(BOARD_FILE) ? fs.statSync(BOARD_FILE).size : 0;
  if (boardCache && size === boardSize) return boardCache;
  const raw = size > 0 ? fs.readFileSync(BOARD_FILE, 'utf8') : '';
  const out = [];
  let max = 0;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      out.push(obj);
      if (typeof obj.seq === 'number' && obj.seq > max) max = obj.seq;
    } catch (_) { /* 坏行不阻塞；账本只追加，出现坏行应人工查 */ }
  }
  boardCache = out;
  boardSize = size;
  boardMaxSeq = max;
  return out;
}

/** 账本当前最大 seq（只追加，续号不会撞） */
function currentMaxSeq() {
  loadBoard();
  return boardMaxSeq;
}

/**
 * 追加一条消息进 board.jsonl（单写者：只有服务端写，无文件锁）
 * @param {object} msg 01 §2 字段表里的一条消息（id/source/specversion/type/to/time/inreplyto/conversationid/data）
 * @returns {{seq:number}}
 */
function appendMessage(msg) {
  ensureDataDir();
  for (const k of REQUIRED_FIELDS) {
    if (msg[k] === undefined || msg[k] === null) {
      throw new Error(`信封缺必填字段: ${k}`);
    }
  }
  const seq = currentMaxSeq() + 1;
  const record = { seq, ...msg };
  const line = JSON.stringify(record) + '\n';
  fs.appendFileSync(BOARD_FILE, line, 'utf8');
  // 顺手把缓存推到最新（省掉一次全文件重读）
  if (boardCache) {
    boardCache.push(record);
    boardSize += Buffer.byteLength(line, 'utf8');
    boardMaxSeq = seq;
  }
  return { seq };
}

/**
 * 读回账本消息
 * @param {{sinceSeq?:number}} [opts]
 * @returns {object[]} seq >= sinceSeq 的消息，按 seq 升序
 * ⚠️ 2026-10-05 修注释：这是**浅拷贝**（`slice()` 只复制数组）—— **元素还是缓存里那批对象**
 *    ⇒ 调用方**只读没问题，别去改元素**（改了缓存就跟着脏，下次读到的就是被改过的）。
 */
function readMessages({ sinceSeq = 0 } = {}) {
  const all = loadBoard();
  return (sinceSeq > 0 ? all.filter((m) => m.seq >= sinceSeq) : all).slice();
}

// ─────────────── 任务表 ───────────────

function loadTasks() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8') || '{}');
  } catch (_) {
    throw new Error(`任务表文件损坏: ${TASKS_FILE}`);
  }
}

function saveTasks(tasks) {
  ensureDataDir();
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

/**
 * 要下一个任务顺序号（系统发号，AI 不自己数）
 * @returns {number} 下一个顺序号
 */
function nextTaskSeq() {
  ensureDataDir();
  let cur = 0;
  if (fs.existsSync(SEQ_FILE)) {
    cur = parseInt(fs.readFileSync(SEQ_FILE, 'utf8').trim(), 10) || 0;
  }
  // 顺带从任务表里已用的主任务 id 取最大值兜底（seq.txt 丢失时不重复发号）
  // ⚠️ 主任务 id ＝「顺序号-时间」，老大派的还多一段 `boss-` 前缀 ⇒ 顺序号恒在**倒数第二段**；
  //    不能取第一段（带前缀时第一段是 "boss"，parseInt 得 NaN，兜底静默失效）。
  const tasks = loadTasks();
  for (const id of Object.keys(tasks)) {
    const parts = String(id).split('-');
    const n = parseInt(parts[parts.length - 2], 10);
    if (!isNaN(n) && n > cur) cur = n;
  }
  const next = cur + 1;
  fs.writeFileSync(SEQ_FILE, String(next), 'utf8');
  return next;
}

/**
 * 生成主任务 id：顺序号 + 时间（精确到秒），例 00003-20261003022015
 * ⭐ **老大派的任务 ⇒ 前面多一段 `boss-`**（例 `boss-00003-…`）；AI 派的没有那一段
 *    —— 一眼认得出这是人派的任务（任务板上也照这个标）。依据：`08` §一之二 / `01` §6。
 * @param {{boss?:boolean}} [opts] boss=true ⇒ 发 boss 号（老大在界面上填的那张派发表）
 * @returns {string}
 */
function makeTaskId(opts) {
  const seq = nextTaskSeq();
  const prefix = (opts && opts.boss) ? 'boss-' : '';
  return `${prefix}${String(seq).padStart(5, '0')}-${localStamp()}`;
}

/**
 * 建主任务（必须同时登记完整子任务清单；清单不齐 ⇒ 拒）
 * @param {{id:string, title?:string, note?:string, subtasks:Array, to?:Array}} param
 *        subtasks 每项：{id, to, timeout, heavy?, note?}；to 为派发者消息的收件人（可选，用于核对清单）
 * @returns {object} task
 */
function createTask({ id, title, note, subtasks, to }) {
  ensureDataDir();
  const tasks = loadTasks();

  // 一个 id 不能重复用（08 §一之二）
  if (tasks[id]) {
    throw new Error(`任务 id 已存在，一个 id 不能重复用: ${id}，已拒收`);
  }

  // 同一时间只有一个主任务（08 §一之二）：有未收口的主任务 ⇒ 拒
  const active = Object.values(tasks).find((t) => !t.closed);
  if (active) {
    throw new Error(`已有主任务在跑（${active.id}），同一时间只允许一个主任务，已拒收`);
  }

  // 清单不齐 ⇒ 拒：建主任务时必须同时登记完整子任务清单
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    throw new Error('主任务必须带完整子任务清单，清单不齐，已拒收');
  }

  const seenTo = new Set();
  for (const st of subtasks) {
    if (!st.id) throw new Error('子任务缺 id，已拒收');
    if (!st.to) throw new Error(`子任务 ${st.id} 缺 to（派给谁），已拒收`);
    if (st.timeout === undefined || st.timeout === null || st.timeout === '') {
      throw new Error(`子任务 ${st.id} 缺 timeout（时限，分钟，必填），已拒收`);
    }
    // 子任务 id 前缀必须等于主任务 id（08 §一之二）
    if (!st.id.startsWith(id + '-')) {
      throw new Error(`子任务 id ${st.id} 前缀不等于主任务 id ${id}，已拒收`);
    }
    // 一批任务里把两件事派给同一个人 ⇒ 拒（01 §5 第 9 条）
    if (seenTo.has(st.to)) {
      throw new Error(`一批任务里把两件事派给同一个人（${st.to}），已拒收`);
    }
    seenTo.add(st.to);
  }

  // 顶层 to 若给出，人数必须等于子任务件数（清单不齐 ⇒ 拒，M1 验收第 4 条）
  if (to !== undefined) {
    const uniqueTo = [...new Set(to)];
    if (uniqueTo.length !== subtasks.length) {
      throw new Error(`清单不齐：to 里有 ${uniqueTo.length} 人，子任务只有 ${subtasks.length} 件，已拒收`);
    }
  }

  const task = {
    id,
    title: title || '',
    note: note || '',
    createdAt: localStamp(),
    closed: false,
    subtasks: subtasks.map((s) => ({
      id: s.id,
      to: s.to,
      timeout: s.timeout,   // 时限（分钟），挂在每件子任务上，派发者必填
      heavy: !!s.heavy,     // 重任务标记，纯标注、不带特权
      note: s.note || '',
      state: null,          // 初始未接；由 task.ack / task.deliver / task.status 等后续模块置档
      stateUpdatedAt: null,
      // ⭐ 2026-10-05 加：**派发时刻**（时限从这里起算 —— 规范 `时限\01` §一："自派发者把表提交上去那一刻"）。
      //    原来代码拿 `stateUpdatedAt` 当计时起点（那是"状态最后变动"、接任务才写）⇒ 起算点错了，
      //    而且"派出去了但还没接"那段根本进不了计时表。
      assignedAt: localStamp(),
    })),
  };
  tasks[id] = task;
  saveTasks(tasks);
  return task;
}

/** 按 id 读一张任务卡 */
function getTask(taskId) {
  const tasks = loadTasks();
  return tasks[taskId] || null;
}

/**
 * 任务板按天列
 * @param {{date?:string}} [opts] date 形如 20261003（本地日）
 * @returns {object[]}
 */
function listTasks({ date } = {}) {
  const tasks = loadTasks();
  let arr = Object.values(tasks);
  if (date) {
    arr = arr.filter((t) => t.createdAt && t.createdAt.startsWith(date));
  }
  return arr.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 改一件子任务的状态（03 §4 五档：working/delivered/done/blocked/cancelled）
 * @param {string} taskId
 * @param {string} subId
 * @param {string} state
 * @returns {object} 改后的子任务
 */
function setSubtaskState(taskId, subId, state) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  if (!subId.startsWith(taskId + '-')) {
    throw new Error(`子任务 id ${subId} 前缀不等于任务 ${taskId}，已拒收`);
  }
  const st = task.subtasks.find((s) => s.id === subId);
  if (!st) throw new Error(`子任务不存在: ${subId}`);
  // ⭐ 2026-10-05 加：允许**退回「从未表态」**（`null`）—— 打回时把那件退回去用（规范 `流程\01` §4：
  //    "退回 ＝ 再派一次 ⇒ 回 working"）。原来只收五档 ⇒ 打回根本退不回去，状态卡在 delivered。
  if (state !== null && !Object.values(TASK_STATES).includes(state)) {
    throw new Error(`未知状态: ${state}（null＝从未表态，或五档：working/delivered/done/blocked/cancelled）`);
  }
  st.state = state;
  st.stateUpdatedAt = localStamp();
  // ⭐ 2026-10-05 加：**退回「从未表态」＝ 重新派了一次** ⇒ **时限重新起算**（正本 `时限\01` §一）。
  //    打回后那件要重做，理应拿到一整段新时限；不然一件被打回的任务可能刚接回来就超时。
  if (state === null) st.assignedAt = localStamp();
  saveTasks(tasks);
  return st;
}

/**
 * 记 over（派发者报的收口）：前提是这一包的子任务**全部到终态** —— done 或 cancelled（01 §5 第 8 条）
 * @param {string} taskId
 * @returns {object} task
 */
function closeTask(taskId) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  const undone = task.subtasks.filter((s) => s.state !== TASK_STATES.DONE && s.state !== TASK_STATES.CANCELLED);   // ⭐ cancelled 也是终态（2026-10-04 修：超时换人后旧件是 cancelled，原来会永久挡住收口，同 envelope.js）
  if (undone.length > 0) {
    throw new Error(`报 over 时还有子任务没完（${undone.map((s) => s.id).join(', ')}），已拒收`);
  }
  task.closed = true;
  task.closedAt = localStamp();
  saveTasks(tasks);
  return task;
}

// ─────────── 重派 / 系统收尾要用的写回（2026-10-04 收回来，唯一写者仍是数据层） ───────────
// ⭐ 原来 M4（timeout.js）为了写 tried／追加子任务／系统代报 over，自己 readFileSync ＋
//    writeFileSync 直接改 tasks.json —— 同一份表两处写＝屎山（08 §五：不留双份实现）。
//    收回来做成 M1 的语义接口，M4 只调这里。

/** 记"这件任务试过谁"（换人重派时用来拒原人；同一件不重复记） */
function addTried(subId, memberId) {
  if (!subId || !memberId) return null;
  const tasks = loadTasks();
  for (const t of Object.values(tasks)) {
    const st = t.subtasks.find((s) => s.id === subId);
    if (!st) continue;
    const arr = Array.isArray(st.tried) ? st.tried : [];
    if (!arr.includes(memberId)) arr.push(memberId);
    st.tried = arr;
    saveTasks(tasks);
    return st;
  }
  return null;
}

/** 往主任务追加一件子任务（换人重派用；同一个 id 不复用、前缀必须对） */
function appendSubtask(taskId, subtask) {
  const tasks = loadTasks();
  const t = tasks[taskId];
  if (!t) throw new Error(`任务不存在: ${taskId}`);
  const st = subtask || {};
  if (!st.id) throw new Error('新子任务缺 id，已拒收');
  // ⭐ 2026-10-05 加（与 `createTask` 同一口径）：**`to` / `timeout` 也是必填** ——
  //    原来只校验 id 与前缀 ⇒ 补派（`envelope.receive` 那条新路）能塞进一件"没派给谁、也没时限"的
  //    子任务；`timeout` 非法 ⇒ `rebuildTimers` 不登记 ⇒ **那件永远不判超时**（连带整包被它锁住）。
  if (!st.to) throw new Error(`新子任务 ${st.id} 缺 to（派给谁），已拒收`);
  if (typeof st.timeout !== 'number' || !(st.timeout > 0)) {
    throw new Error(`新子任务 ${st.id} 的 timeout 必须是正数（分钟），实收 ${typeof st.timeout}: ${JSON.stringify(st.timeout)}，已拒收`);
  }
  if (!String(st.id).startsWith(taskId + '-')) {
    throw new Error(`新子任务 id ${st.id} 前缀必须等于主任务 id ${taskId}，已拒收`);
  }
  if (t.subtasks.some((s) => s.id === st.id)) {
    throw new Error(`新子任务 id 已存在，同一个 id 不复用: ${st.id}`);
  }
  const row = {
    id: st.id,
    to: st.to,
    timeout: st.timeout,
    heavy: !!st.heavy,
    note: st.note || '',
    state: null,
    stateUpdatedAt: null,
    // ⭐ 2026-10-05 补：**新件也要记「派发时刻」**（计时起点靠它，见 `timeout.rebuildTimers`）。
    //    ⚠️ 漏了它的后果（代码审查抓出来的）：起点退成"现在"，而 `rebuildTimers` **每秒跑一次**
    //    ⇒ deadline 永远追不上现在 ⇒ **那件永远不到点、没有任何计时器管它** ⇒ 整批任务被它锁死。
    assignedAt: localStamp(),
  };
  if (Array.isArray(st.tried)) row.tried = st.tried;
  t.subtasks.push(row);
  saveTasks(tasks);
  return t;
}

/**
 * 系统代派发者收口（派发者挂了那条路）：**不要求子任务全 done**
 * ⚠️ 正常收口走 closeTask（硬要求全 done）；这里是系统兜底，判据由调用方保证。
 */
function closeTaskBySystem(taskId, closedBy) {
  const tasks = loadTasks();
  const task = tasks[taskId];
  if (!task) throw new Error(`任务不存在: ${taskId}`);
  if (task.closed) return task;
  task.closed = true;
  task.closedAt = localStamp();
  task.closedBy = closedBy || 'system';
  saveTasks(tasks);
  return task;
}

// 数据目录由程序首次启动自己建（08 §三之二）——本模块加载即确保就绪
ensureDataDir();

module.exports = {
  TASK_STATES,
  DATA_DIR,
  BOARD_FILE,
  TASKS_FILE,
  appendMessage,
  readMessages,
  nextTaskSeq,
  makeTaskId,
  createTask,
  getTask,
  listTasks,
  setSubtaskState,
  closeTask,
  addTried,
  appendSubtask,
  closeTaskBySystem,
};

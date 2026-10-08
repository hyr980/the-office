'use strict';

/**
 * M6 · 目录与产出 —— 四个目录 + 按天分类 + 谁能写哪 + 交付路径
 *
 * 依据：
 *   - 模块\M6-目录与产出.md
 *   - 规范\08-落地结构-20261002.md §三之二（目录结构）
 *   - 规范\04-功能清单-草案v1-20261002.md §7.4 / §7.5
 *   - 规范\01-信封-草案v1-20261002.md §3（task.deliver 只带 where）
 *
 * 分工（跨块约定接口，别改名）：
 *   ensureDirs()                       首次启动建四个目录（幂等）
 *   workDir(memberId, date)            → 产出\<id>\<date>   并确保存在
 *   inboxDir(taskId)                   → 收件\<taskId>      并确保存在
 *   isWritableBy(memberId, path)       → 成员只能写自己的产出目录 → true/false
 *
 * 关键设计：
 *   - 四个目录名字用中文（老大一眼认得）：收件\ / 产出\ / 日志\ / 数据\；
 *   - 数据\ 与 M1 DATA_DIR 同位置（M1 管内容：board.jsonl + tasks.json）；
 *   - 收件只放"兜底"（M4 判 over 那条才进）；正常交付只报自己产出目录的路径；
 *   - 交付走 task.deliver，data 只有 {task, where}——路径由本模块产出、内容不进消息；
 *   - 成员只能写自己的产出目录（产出\<自己id>\ 之下），收件/日志/数据/别人产出一律拒。
 *
 * 约束：零第三方依赖；不改 M1~M5 的代码与接口。
 */

const fs = require('fs');
const path = require('path');

// 2026-10-04 新布局：本文件在 <办公室根>\程序\后端\
//   ⇒ 办公室根 = 上两级；四个运行目录统一挪到 <办公室根>\运行\ 下
//     （「不动的代码」放 程序\、「一跑就变的东西」放 运行\，跟正常软件一个路子）
const OFFICE_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_ROOT = path.join(OFFICE_ROOT, '运行');

/** 本地日期：YYYYMMDD（与任务 id 时间串同格式，供按天分类） */
function dateStamp(d) {
  const n = d || new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}`;
}

/** 成员 id 安全校验：禁路径分隔符/危险字符/隐藏跳级（产出\<id>\ 的 id 段） */
function validMemberId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= 64
    && !id.startsWith('.') && /^[^\\\/:*?"<>|]+$/.test(id);
}

/** 主任务 id 安全校验：规范 id 为 数字-数字（如 00001-20261002094125）；宽松收安全字符 */
function validTaskId(taskId) {
  return typeof taskId === 'string' && taskId.length >= 1 && taskId.length <= 64
    && !taskId.includes('..') && /^[0-9A-Za-z_\-]+$/.test(taskId);
}

/** 日期段安全校验：YYYYMMDD 八位数字 */
function validDate(date) {
  return typeof date === 'string' && /^\d{8}$/.test(date);
}

/**
 * 造一个目录模块实例（根目录可注入：默认用程序根目录；自验/测试可注入隔离副本）
 * @param {string} rootDir 办公室程序根目录
 */
function createDirs(rootDir) {
  const root = path.resolve(rootDir);
  const INBOX_DIR = path.join(root, '收件');
  const OUTPUT_DIR = path.join(root, '产出');
  const LOG_DIR = path.join(root, '日志');
  const DATA_DIR = path.join(root, '数据');

  /** 首次启动建四个目录（幂等；数据\ 与 M1 DATA_DIR 同位置） */
  function ensureDirs() {
    for (const d of [INBOX_DIR, OUTPUT_DIR, LOG_DIR, DATA_DIR]) {
      fs.mkdirSync(d, { recursive: true });
    }
  }

  /**
   * 某成员某天的产出目录：产出\<成员 id>\<日期>\ 并确保存在
   * @param {string} memberId 成员 id
   * @param {string} date 日期 YYYYMMDD（按天严格分类）
   * @returns {string} 绝对路径
   */
  function workDir(memberId, date) {
    if (!validMemberId(memberId)) throw new Error(`非法的成员 id: ${memberId}`);
    if (!validDate(date)) throw new Error(`日期必须是 YYYYMMDD 八位数字: ${date}`);
    const dir = path.join(OUTPUT_DIR, memberId, date);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * 收件（老大收"兜底"）目录：收件\<主任务 id>\ 并确保存在
   * ⚠️ **调用即建目录**（`mkdirSync` 在里面）⇒ 只在**真要往里放东西**时调；
   *    只想"取路径"、或**还没确认源存在**时，先 `fs.statSync(源)` 判一下再调它
   *    （否则复制失败会在收件夹留一个空壳目录 —— 2026-10-05 修，见 `bridge.handleBossDeliver`）。
   * @param {string} taskId 主任务 id（收件按主任务分子目录）
   * @returns {string} 绝对路径
   */
  function inboxDir(taskId) {
    if (!validTaskId(taskId)) throw new Error(`非法的任务 id: ${taskId}`);
    const dir = path.join(INBOX_DIR, taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // 「我的文件夹」设置文件（2026-10-03 加：老大要能自己定这个目录）
  const SETTINGS_FILE = path.join(DATA_DIR, '设置.json');

  /** 读设置文件（没有 / 坏了都当空 —— 设置坏掉不该让办公室起不来） */
  function readSettings() {
    try {
      const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return s && typeof s === 'object' ? s : {};
    } catch (_) { return {}; }
  }

  /**
   * 「我的文件夹」：老大自己定的那个目录（界面「我的文件夹」按钮指向它）
   * 没设过 ⇒ 默认 收件\（办公室自己的收件根目录）
   * @returns {string} 绝对路径
   */
  function myFolder() {
    const s = readSettings();
    const p = typeof s.myFolder === 'string' ? s.myFolder.trim() : '';
    if (!p) return INBOX_DIR;
    try { fs.mkdirSync(p, { recursive: true }); } catch (_) { /* 建不了就先照原样给，点开会报错 */ }
    return p;
  }

  /**
   * 设置「我的文件夹」（老大在界面上改）：写 设置.json 并确保目录存在
   * @param {string} p 绝对路径
   * @returns {string} 落定后的绝对路径
   */
  function setMyFolder(p) {
    const raw = typeof p === 'string' ? p.trim().replace(/^"|"$/g, '') : '';
    if (!raw) {                       // 空 ⇒ 清掉自定义，回到默认（界面「恢复默认」用）
      const s0 = readSettings();
      delete s0.myFolder;
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s0, null, 2), 'utf8');
      return INBOX_DIR;
    }
    if (!path.isAbsolute(raw)) throw new Error('要填绝对路径，比如 D:\\我的文件');
    if (/^\\\\/.test(raw)) throw new Error('不支持网络路径（\\\\ 开头的）');
    if (raw.includes('..')) throw new Error('路径里不能有 ..');
    const dir = path.resolve(raw);
    fs.mkdirSync(dir, { recursive: true });
    const s = readSettings();
    s.myFolder = dir;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
    return dir;
  }

  /**
   * 界面要打开的路径 → 给 explorer 的实参（2026-10-03 加：修「我的文件夹」打不开）
   * 目录 ⇒ 打开它；文件 ⇒ 打开它所在目录并选中它（⚠️ 只选中、不执行 —— 打开文件等于运行程序）
   * @param {string} p 路径
   * @returns {{ok:boolean, arg?:string, reason?:string}}
   */
  function openArg(p) {
    const raw = typeof p === 'string' ? p.trim().replace(/^"|"$/g, '') : '';
    if (!raw) return { ok: false, reason: '路径空' };
    if (!path.isAbsolute(raw)) return { ok: false, reason: '要绝对路径' };
    if (/^\\\\/.test(raw)) return { ok: false, reason: '不支持网络路径（\\\\ 开头的）' };
    const target = path.resolve(raw);
    let st;
    try { st = fs.statSync(target); } catch (_) { return { ok: false, reason: '路径不存在' }; }
    if (st.isDirectory()) return { ok: true, arg: target };
    if (st.isFile()) return { ok: true, arg: '/select,' + target };
    return { ok: false, reason: '既不是文件夹也不是文件' };
  }

  /**
   * 成员对某路径有没有写权限：只能写自己的产出目录（产出\<自己 id>\ 之内）
   * Windows 路径大小写不敏感，统一小写比较前缀。
   * ⚠️ 2026-10-05 记：**本函数目前全项目零调用点**（只有定义与导出）。
   *    原因是成员写文件走**它自己直接写盘**、不经过办公室 ⇒ 办公室这一侧拦不到它。
   *    留着它的理由：它是规范 `08` §三之二 那句「成员只能写自己的产出目录」的**判据实现** ——
   *    将来若有"由办公室代写文件"的路径，直接拿它当闸；**别以为它现在在生效**。
   * @param {string} memberId 成员 id
   * @param {string} p 要写的目标路径（绝对或相对）
   * @returns {boolean}
   */
  function isWritableBy(memberId, p) {
    if (!validMemberId(memberId)) return false;
    const target = path.resolve(p).toLowerCase();
    const own = path.resolve(path.join(OUTPUT_DIR, memberId)).toLowerCase();
    const sep = path.sep.toLowerCase();
    return target === own || target.startsWith(own + sep);
  }

  return { ensureDirs, workDir, inboxDir, isWritableBy, myFolder, setMyFolder, openArg, ROOT_DIR: root, INBOX_DIR, OUTPUT_DIR, LOG_DIR, DATA_DIR };
}

// 默认实例：办公室程序根目录（供其它块直接 require 使用）
const dirs = createDirs(DEFAULT_ROOT);

module.exports = {
  createDirs,
  dateStamp,
  ensureDirs: dirs.ensureDirs,
  workDir: dirs.workDir,
  inboxDir: dirs.inboxDir,
  isWritableBy: dirs.isWritableBy,
  myFolder: dirs.myFolder,
  setMyFolder: dirs.setMyFolder,
  openArg: dirs.openArg,
  ROOT_DIR: dirs.ROOT_DIR,
  INBOX_DIR: dirs.INBOX_DIR,
  OUTPUT_DIR: dirs.OUTPUT_DIR,
  LOG_DIR: dirs.LOG_DIR,
  DATA_DIR: dirs.DATA_DIR,
};

'use strict';

/**
 * M7 · 日志 —— 系统自己干了什么的那本账（与消息流水账本分开）
 *
 * 依据：
 *   - 模块\M7-日志.md
 *   - 规范\08-落地结构-20261002.md §一之二「⭐ 日志一定做好」那一段
 *   - 规范\03-状态机制-草案v1-20261002.md §3.1 / §3.2 / §4
 *   - 规范\04-功能清单-草案v1-20261002.md §7.3
 *
 * 分工（跨块约定接口，别改名）：
 *   logEvent({type, at, taskId, subId, who, why, extra})  // 追加一行
 *   readLog(date)                                         // → [event]  界面按天翻
 *
 * 关键设计：
 *   - 按天一个文件、只追加：日志\<YYYYMMDD>.jsonl（M6 日志\ 目录）；
 *   - 与账本分开：本模块只写 日志\，绝不碰 board.jsonl / tasks.json；
 *   - 事件 type 用固定词（reject/cancel/kick/dispatcher-dead/over/state/retry），
 *     拒绝自由文本（M10 要按类型显示）；
 *   - 每条都带时间戳 + 主/子任务 id（能定位）；"为什么"存 why（含哪一型），
 *     ⚠️ 对当事人只说"你触发了哪一条"（由调用方转述，本模块不直接对成员说话）；
 *   - ⚠️ 两个量别混（2026-10-03 校；⭐ **2026-10-04 复校：代码这处已经对齐了，别再照旧话改**）：
 *     ① **换过几个人**＝tried 名单长度 + 1（tried＝"这份任务试过谁"；日志里读 retry 行的 extra.tried）；
 *     ② **轮次**（"这件任务跑了几轮"）＝被交上来几次＝打回次数 + 1，按
 *     `inreplyto` 链数（口径见 `03` §3.1 ／交付包 `待改事项-20261003.md` 第三条）。
 *     ⚠️ ① ≠ ②（打回是同一人重做，换人是换人）。⇒ **现状**：`bridge.js` 的 `list_tasks` 走的是
 *     `envelope.countRework(board, s.id) + 1`（＝②轮次，**对的**）；`log.js` 原来那句"list_tasks
 *     拿 tried 当 rounds"是**过期说法**，2026-10-04 实测核对后删掉。
 *     （原写"每件子任务跑了几轮＝该 subId 的 retry 条数 + 1"，链条 ≥3 轮时对不上。）
 *
 * 约束：零第三方依赖；不改 M1~M6 的代码与接口。
 */

const fs = require('fs');
const path = require('path');
const dirs = require('./dirs');

/** 事件类型固定词（M10 按类型显示，别用自由文本） */
const EVENT_TYPES = ['reject', 'cancel', 'kick', 'dispatcher-dead', 'over', 'state', 'retry'];

/** 本地时间串：YYYY-MM-DD HH:MM:SS（人能读） */
function localTimeString(d) {
  const n = d || new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())}`;
}

/** 日期段安全校验：YYYYMMDD 八位数字（文件名即日期，防路径注入） */
function validDate(date) {
  return typeof date === 'string' && /^\d{8}$/.test(date);
}

/**
 * 造一个日志模块实例（目录与时钟可注入：默认用 M6 日志目录＋真实时钟；自验可注入隔离目录/假时钟）
 * @param {{logDir?: string, dateProvider?: () => Date}} [opts]
 *   logDir        日志目录（默认 = dirs.LOG_DIR = <程序根>\日志\）
 *   dateProvider  取"今天"的时钟，默认 () => new Date()（自验可注入"明天"）
 */
function createLogger(opts) {
  const logDir = (opts && opts.logDir) || dirs.LOG_DIR;
  const dateProvider = (opts && opts.dateProvider) || (() => new Date());

  function todayStamp() {
    const d = dateProvider();
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
  }

  /**
   * 追加一条系统事件到当天的日志文件（只追加；按天一个文件）
   * @param {{type:string, at?:Date|string, taskId?:string, subId?:string, who?:string, why?:string, extra?:any}} ev
   * @returns {object} 实际写入的一行（含 ts）
   */
  function logEvent(ev) {
    if (!ev || typeof ev !== 'object') throw new Error('logEvent 需要事件对象');
    if (!EVENT_TYPES.includes(ev.type)) {
      throw new Error(`日志事件 type 必须是固定词(${EVENT_TYPES.join('/')})，收到: ${ev.type}`);
    }
    const atDate = ev.at ? (ev.at instanceof Date ? ev.at : new Date(ev.at)) : dateProvider();
    const line = {
      ts: localTimeString(atDate),
      type: ev.type,
      taskId: ev.taskId != null ? String(ev.taskId) : null,
      subId: ev.subId != null ? String(ev.subId) : null,
      who: ev.who != null ? String(ev.who) : null,
      why: ev.why != null ? String(ev.why) : null,
      extra: ev.extra !== undefined ? ev.extra : null,
    };
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, todayStamp() + '.jsonl'), JSON.stringify(line) + '\n', 'utf8');
    return line;
  }

  /**
   * 读某天的日志 → 事件数组（界面按天翻；date 缺省 = 今天）
   * @param {string} [date] YYYYMMDD，缺省今天
   * @returns {object[]}
   */
  function readLog(date) {
    const d = date || todayStamp();
    if (!validDate(d)) throw new Error(`日期必须是 YYYYMMDD 八位数字: ${d}`);
    const file = path.join(logDir, d + '.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  }

  return { logEvent, readLog, LOG_DIR: logDir, EVENT_TYPES };
}

// 默认实例：M6 日志目录（供其它块直接 require 使用）
const logger = createLogger();

module.exports = {
  createLogger,
  logEvent: logger.logEvent,
  readLog: logger.readLog,
  LOG_DIR: logger.LOG_DIR,
  EVENT_TYPES,
};

'use strict';

/**
 * M4 · 时限与兜底 —— 子任务时限、超时收尾、换人重派、refuse 收场、判派发者挂、over 代报
 *
 * 依据（2026-10-04 口径）：
 *   - 规范\时限\01-异常与重新派发.md（★ 正本：一、执行者到点没交；二、派发者交付后不回"收到"）
 *   - 规范\接入\01-接入与连接.md §3／§4（两个计时器；插话由办公室通知插件发）
 *   - 规范\04-功能清单.md §7.6（老大派的任务：验收由系统自动判）
 *
 * 跨块约定接口（别改名）：
 *   startTimers()                       起计时：按 subtasks[].timeout 排（**单位＝分钟**）
 *   onDeliver(subId, deliverMsgId)      交付那一刻起 5 分钟判挂表
 *   checkTimeouts(now)                  → 到点的子任务列表（主程序逐件调 handleTimeout）
 *   handleTimeout(subId)                ⭐ 超时收尾（**不再收 type** —— "分三型"2026-10-04 作废）
 *   onRefuse(subId)                     转告派发者 + 起 5 分钟窗口（看派发者死活）
 *   triedList(subId)                    → 试过谁（重派时用来拒原人）
 *   assignRetry(subId, to, opts)        重派（换人；没人换 ⇒ 派发者自己干）
 *   handleRefuseAndDead(subId)          干不了 + 派发者死：弹老大、等"我知道了"
 *
 * 辅助接口（主程序/M8 对接用）：
 *   onMessage(msg)                      统一钩子：ack 撤判挂 / blocked·done 落状态 / refuse 窗口解除
 *   checkAssignerDeaths(now)            判挂表到期 ⇒ 判派发者挂（产出转老大 ＋ 系统自动判验收通过）
 *   sweepRefuseDead(now)                refuse 后 5 分钟没见派发者 ⇒ 弹老大（进 handleRefuseAndDead）
 *   resolveRefuse(subId)                派发者 5 分钟内回应 ⇒ 正常 refuse 收场
 *   ackRefuseDead(subId)                老大点"我知道了" ⇒ 那件取消 ＋ 执行者空闲
 *   systemOver(mainTaskId, opts)        系统代报 over（判据由调用方保证）
 *   nudgeAssignerToOver(taskId)         任务全齐（每件都有结果）⇒ 叫派发者回来报 over（2026-10-05 加）
 *   onOnline(memberId)                  成员上线 ⇒ 5 分钟内补投"任务已经提交，请验收" / 解 refuse 窗口
 *   setConfig(partial)                  判挂时长 assignerDeadMs 可改（宽限期已删）
 *   setKick(fn) / isKicked(id) / getKicked() / setInterrupt(fn) / setSender(fn)
 *
 * 2026-10-04 改掉的旧口径（别照旧代码写）：
 *   - ⚠️ **"按怎么死的分三型"作废**：状态只有正常／异常，判据只有"到点没交"；
 *     收尾动作按"当时能不能动"分两种：壳/程序都没了 ⇒ 直接断开连接；壳还活着 ⇒
 *     先插一句"时间到了，请停"（**不等回话、不判死活**）⇒ 随即断开连接；
 *   - ⚠️ **宽限期作废**（`probes`／`sweepProbes`／`config.graceMs` 全删）；
 *   - ⭐ **"断开连接"≠"踢下线"**：系统判异常走的是**断开连接**（走注入的 kickFn，由桥接成 status.disconnect）；
 *   - ⭐ **派发者挂了 ⇒ 系统自己判"验收通过"**（那件转 done）＋ 产出丢老大那边 ＋ 代报 over；
 *     而**老大自己派的任务不走这一套**（交付即自动验收，见 bridge.handleBossDeliver）；
 *   - ⭐ **写任务表不再自己改文件**：`tried`／追加子任务／系统收口走 M1 的新接口（2026-10-04 补）。
 *
 * 约束：零第三方依赖；不改 M1/M2/M3 代码与接口；同一时间只服务一个主任务。
 */

const fs = require('fs');
const path = require('path');
const dataLayer = require('./data-layer');
const statusModule = require('./status');
const logModule = require('./log');
const dirs = require('./dirs');

const { TASK_STATES } = dataLayer;
const WORKING = TASK_STATES.WORKING;
const DELIVERED = TASK_STATES.DELIVERED;
const DONE = TASK_STATES.DONE;
const BLOCKED = TASK_STATES.BLOCKED;
const CANCELLED = TASK_STATES.CANCELLED;

/** 本地秒串 YYYYMMDDHHMMSS（与 M1 localStamp 同格式） */
function stampNow(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 解析 M1 秒串 / ISO 时间；失败回退 Date.now() */
function parseStamp(s) {
  if (typeof s === 'string' && /^\d{14}$/.test(s)) {
    return new Date(
      +s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8),
      +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14)
    ).getTime();
  }
  if (typeof s === 'number' && !isNaN(s)) return s;
  const t = Date.parse(s);
  return isNaN(t) ? Date.now() : t;
}

/** 从消息 time 字段解析毫秒（01 里 time 可选；解析失败用现在） */
function parseMsgTime(msg) {
  if (msg && msg.time !== undefined) return parseStamp(msg.time);
  return Date.now();
}

/** 子任务 id → 主任务 id（去掉最后一个 - 段；主任务 id 自身含 -） */
function mainIdOf(subId) {
  return String(subId).slice(0, String(subId).lastIndexOf('-'));
}

/**
 * 时限日志 → M7 事件日志（log.js）的固定词（2026-10-03 统一一本账）：
 * 08 §一只认 6 类系统动作＋轮次，正好对上 log.js 的 7 个固定词；
 * M4 内部的事件名一律折进这 7 个词，细节放 why / extra（原始事件名存 extra.event）。
 * @param {object} e 内部条目 {event, ...}
 * @returns {object} logEvent 入参 {type, taskId, subId, who, why, extra}
 */
function toLogEvent(e) {
  const ev = e || {};
  const extra = { event: ev.event };
  let type = 'state';
  let who = ev.to || null;
  let why = null;

  switch (ev.event) {
    case 'kick':
      type = 'kick'; who = ev.memberId || null; why = ev.reason || null;
      break;
    case 'timeout':
      // ⚠️ 2026-10-04 修：原来写作「时限超过（型${ev.type}）」，可**不带 type** 的那条路（派发后没表态
      //    那段，调用点在本文件下方）拼出来就是「**型undefined**」（老大打开办公室看到的怪字就是它）。
      //    "分三型"早作废了 ⇒ 有 type 就带上、没有就不写。
      type = 'cancel'; why = ev.type ? `时限超过（${ev.type}）` : '时限超过'; if (ev.type) extra.kind = ev.type;
      break;
    /* ⭐ 2026-10-06 文案统一（老大：「系统通知这一类改成通俗正式一点、不要有你我他」）——
       从这一档往下，`why` 一律写成**无主语的书面句**：去掉 `⇒` 箭头、去掉口语和称呼（"老大""你"）。
       ⚠️ **`extra.kind`／`type` 这类机器字段一个字都不能动**（后端判据和验收读的是它们，不是这句话）。 */
    case 'max-rounds':
      // ⚠️ 2026-10-05 改文案：原写「打回满 3 轮」，而 `envelope.js` 的判据是 **`reworkCount >= 2`**
      //    （＝已经被打回 2 次、这是第 3 次）⇒ 那句字面读起来像"已经打回了 3 次"，跟判据差一次。
      type = 'cancel'; why = '已打回 2 次（这件进入第 3 轮）';
      break;
    case 'self-do':
      who = ev.assigner || null; why = '候选名单外无人可换，由派发者自行处理';
      break;
    case 'assign-retry':
      type = 'retry'; why = '换人重派';
      extra.oldSubId = ev.oldSubId; extra.newSubId = ev.newSubId;
      extra.tried = ev.tried; extra.timeout = ev.timeout;
      break;
    case 'refuse':
      type = 'reject'; why = '执行者无法完成，已转告派发者重新派发';
      break;
    case 'refuse-resolved':
      why = '派发者已回应，正常收尾（该子任务取消，执行者转为空闲）';
      break;
    case 'refuse-dead-notify':
      type = 'dispatcher-dead'; why = '派发者在 5 分钟内未回应，任务已停止，等待确认';
      break;
    case 'refuse-dead-cancelled':
      type = 'cancel'; why = '已确认，该子任务取消';
      break;
    case 'deliver-watch':
      who = ev.assigner || null; why = '交付后开启 5 分钟等待窗口';
      extra.deliverMsgId = ev.deliverMsgId;
      break;
    case 'assigner-dead':
      type = 'dispatcher-dead'; who = ev.assigner || null; why = '交付后 5 分钟未收到回应，判定派发者离线';
      extra.deliverMsgId = ev.deliverMsgId;
      break;
    case 'outputs-to-boss':
      type = 'over'; why = '产出物已转入派发者文件夹';
      break;
    case 'over-system':
      type = 'over'; who = 'system'; why = ev.reason || '系统代派发者收口';
      break;
    // ⭐ 2026-10-05 加：**系统通知发不出去**那一档（`systemNotify` 没接线时的降级）也要落盘 ——
    //    原来这一档只在内存事件流里留一条、**日志里一个字都没有** ⇒ 接线真断了没人会发现。
    //    ⚠️ `state` 是 M7 的固定词（`log.js` 的 `EVENT_TYPES`）⇒ 落盘不会被词表校验拒掉。
    case 'system-notify-unsent':
      type = 'state';
      who = Array.isArray(ev.to) ? ev.to.join(',') : (ev.to || null);
      why = `系统通知未能发出（${ev.reason || 'sender 未接线'}）`;
      extra.to = ev.to; extra.note = ev.note;
      break;
    // ⭐ 2026-10-05 加：**任务全齐了 ⇒ 叫派发者回来报 over**（老大定；它得动手收口，所以这条要叫）
    case 'please-over':
      type = 'state';
      who = ev.assigner || null;
      why = `这批任务全部完成，已通知派发者收口（${ev.sent ? '已发送' : '未发出'}）`;
      break;
    // ⭐ 2026-10-05 加（`时限\01` §二）：交付后派发者一直不验收的两档
    case 'accept-nudge':
      type = 'state';
      who = ev.assigner || null;
      why = `交付后 15 分钟仍未验收，已通知派发者验收（${ev.sent ? '已发送' : '未发出'}）`;
      break;
    case 'accept-fallback':
      type = 'over';
      who = 'system';
      why = `交付后 30 分钟仍未验收，产出已转交派发者，由系统代为收口（${ev.sent ? '已告知' : '通知未发出'}）`;
      break;
    case 'over-blocked':
      type = 'state';
      who = 'system';
      why = `收口被挡：${ev.reason || '还有子任务未收尾'}`;
      break;
    case 'assigner-ack':
      who = ev.assigner || null; why = '派发者已回应，判定撤销';
      break;
    case 'subtask-blocked':
      why = '子任务受阻（计时继续）';
      break;
    case 'subtask-done':
      why = '子任务 done';
      break;
    default:
      // 兜底：type 必须是固定词，没映射到的事件名也照样留痕（原始名在 extra.event）
      why = `未映射的时限事件：${ev.event}`;
      break;
  }
  return { type, taskId: ev.taskId, subId: ev.subId, who, why, extra };
}

/** 生产默认日志：走 M7 的 log.js（统一一本账：日志\<YYYYMMDD>.jsonl） */
function logEventAdapter(entry) {
  logModule.logEvent(toLogEvent(entry));
}

/**
 * 造一个时限/兜底实例（数据层与状态机可注入：默认用 M1/M3；自验注入隔离副本）
 * @param {object} dl M1 兼容数据层（listTasks/getTask/readMessages/appendMessage/setSubtaskState/TASK_STATES/TASKS_FILE）
 * @param {object} [deps] { status?, kick?, interrupt?, log? }
 */
function createTimeout(dl, deps = {}) {
  const statusInst = deps.status || null;

  let config = {
    // ⚠️ 宽限期 graceMs 2026-10-04 删掉（老大令「宽限期可以不要」）：插完话就断开，不等回话、不判死活
    assignerDeadMs: 5 * 60 * 1000, // 交付后 5 分钟没回"收到" ⇒ 判派发者挂（`时限\01` §二）
    orphanGraceMs: 5 * 60 * 1000,  // ⭐ 2026-10-04 加：代收"没人管的任务"的冷静期（跟上面两个同量级）
    assignAckMs: 5 * 60 * 1000,    // ⭐ 派发后 5 分钟没表态 ⇒ 判异常（从派发消息发出去那一刻起算，`01` §3）
    // ⭐ 2026-10-05 加（老大定，正本 `时限\01` §二「交付后派发者一直不验收」）—— 两档：
    acceptNudgeMs: 15 * 60 * 1000,    // ① 满 15 分钟：系统叫它一次「任务已经提交，请验收」（真消息，同一件只叫一次）
    acceptFallbackMs: 30 * 60 * 1000, // ② 满 30 分钟仍没动静：那批任务每一件的产出全部转给 boss ＋ 系统代它收口
  };

  const timers = new Map();         // subId -> {taskId, subId, to, assigner, deadline}
  const pendingAck = new Map();     // subId -> {taskId, subId, to, assigner, assignMsgId, deadline}（等"接／不接"表态）
  const watch = new Map();          // subId -> {taskId, subId, deliverMsgId, assigner, deadline, state:'pending'|'resolved'|'dead'}
  // ⭐ 2026-10-05 加：已经"叫过派发者回来报 over"的主任务 —— 同一包**只叫一次**；
  //    状态又退回未终态（打回／补派）时放行，下次全齐了再叫（见 nudgeAssignerToOver）。
  const overNudged = new Set();
  // ⭐ 2026-10-05 加（`时限\01` §二「交付后派发者一直不验收」）：**等验收表** ——
  //    subId -> {taskId, subId, assigner, deliveredAt, nudged}
  //    起点＝交付那一刻（与判挂表同一起点）；判挂那条 5 分钟就退场或"派发者回了收到"，
  //    这条接着往下数：15 分钟叫它一次、30 分钟产出全转 boss ＋ 代收口。
  const acceptWatch = new Map();
  // ⚠️ 宽限期那张探询表（probes）2026-10-04 删掉：插话改口径 —— 插完就断开，不等回话。
  const refuseWatch = new Map();    // subId -> {taskId, subId, to, assigner, deadline}
  const refuseDeadConfirm = new Map(); // subId -> {taskId, subId, to}（等老大点"我知道了"）
  const kicked = new Set();         // 被判异常处理过的人（M4 侧留痕；真正离线由注入的 kickFn 同步进状态层）

  const events = [];
  let customNotifier = null;
  let customSender = null;     // 系统消息真出口：bridge 注入 receiveAndDeliver（入账＋投递）
  // ⭐ 2026-10-05 加：系统消息 id 的**同秒序号**（见 `systemNotify`）—— 与 `bridge.systemSend` 的 `++sysSeq` 对齐。
  let sysSeq = 0;
  let logFn = deps.log || logEventAdapter;
  let interruptFn = deps.interrupt || null;

  function emit(ev) {
    events.push(ev);
    if (customNotifier) { try { customNotifier(ev); } catch (_) {} }
  }
  function log(entry) {
    if (logFn) { try { logFn(entry); } catch (_) {} }
  }

  // ⚠️ 原来这里有一份 `mutateTasks()`：自己 readFileSync ＋ writeFileSync 改 `tasks.json`。
  //    2026-10-04 删掉 —— 同一份任务表两处写＝屎山（`08` §五）⇒ 改用 M1 的接口：
  //    `dl.addTried()` / `dl.appendSubtask()` / `dl.closeTaskBySystem()`。

  /** 在账本里找发那一包（data.task === mainId 的 task.assign）的人（与 M2 口径一致） */
  function findAssigner(mainTaskId) {
    const assignMsg = dl.readMessages().find(
      (m) => m.type === 'task.assign' && m.data && m.data.task === mainTaskId
    );
    return assignMsg ? assignMsg.source : null;
  }

  /** 按子任务 id 找（任务表全扫） */
  function findSubtask(subId) {
    for (const t of dl.listTasks()) {
      const st = t.subtasks.find((s) => s.id === subId);
      if (st) return { task: t, subtask: st };
    }
    return null;
  }

  function setSubtaskState(taskId, subId, state) {
    dl.setSubtaskState(taskId, subId, state);
  }

  /**
   * ⭐ 2026-10-05 加（老大定：「派发者验收完最后一件得回来报 over，让系统去唤醒他来叫」）：
   *   **这批任务每一件都有结果了（验收过 `done` ／ 已取消 `cancelled`）而主任务还没收口 ⇒ 叫派发者回来报 `over`**。
   *
   * 为什么必须叫：`over` 只有派发者能报，而**报 `over` 的前提是"每一件都有结果"**
   *   ⇒ 派发者在"验收完最后一件"之后就**再没有任何信号**（2026-10-04 定"验收通过不叫"）
   *   ⇒ 它不会想起来收口 ⇒ 主任务永不结束 ⇒ 门口的"已有主任务在跑"永远成立
   *   ⇒ **下一包谁都派不进来（包括 `boss` 自己派）**。这条补的就是"任务全齐"那把叫醒铃。
   *
   * ⚠️ **为什么挂在 `sweepOrphanTasks()`（每秒的扫描）里、而不是挂在 `setSubtaskState()` 上**：
   *   状态变更**不止**走 M4 那个包装 —— `envelope.js` 的交付／接任务两处是**直接调 `dl.setSubtaskState()` 的**
   *   （实测 `:471`／`:474`）⇒ 挂在包装上会**漏**（打回之后又重新全齐，就再也不会叫了）。
   *   秒级扫描 ＋ 下面那句"不齐就清标记"，把这条路一次盖全。
   *
   * **不设冷静期**：任务全齐了就该马上叫（跟"代收"那条的 5 分钟冷静期不是一回事 —— 那条是**替人做主**，要稳；
   *   这条只是**叫一声**，人不动手也误不了事）。
   *
   * 形态：`systemNotify` ⇒ 消息类型 `task.status`、来源 `system`、`kind` 为 `please-over`、**不带 `state`**
   *   （⚠️ 不带 `state` 是判据的一部分 —— `bridge.isConfirmOnly()` 只挡"收条"和"`state==='done'` 的验收通过"，
   *   带了 `done` 就落进那档、**叫不动人**）。唤醒正本见 `接入\01` §5.1 表里那一行。
   * @param {object|string} taskOrId 主任务对象或 id
   * @returns {object|null} 发了就回 systemNotify 的结果，没发就 null
   */
  function nudgeAssignerToOver(taskOrId) {
    const task = (taskOrId && typeof taskOrId === 'object') ? taskOrId : dl.getTask(taskOrId);
    const taskId = (task && task.id) || (typeof taskOrId === 'string' ? taskOrId : null);
    if (!task || task.closed) { if (taskId) overNudged.delete(taskId); return null; }
    const subs = task.subtasks || [];
    const settled = subs.length > 0 && subs.every((s) => s.state === DONE || s.state === CANCELLED);
    if (!settled) { overNudged.delete(taskId); return null; }   // 又打回／补派 ⇒ 下次全齐了再叫
    if (overNudged.has(taskId)) return null;                   // 同一包只叫一次
    const assigner = (typeof dl.readMessages === 'function') ? findAssigner(taskId) : null;
    // ⚠️ `boss` 派的任务不走这套：验收由系统自动判、`handleBossDeliver()` 里系统直接代报 over（见 `时限\01` §二开头）
    if (!assigner || assigner === 'boss') { overNudged.add(taskId); return null; }
    overNudged.add(taskId);
    const note = `「${task.title || taskId}」这批任务已全部完成，请回来收口（不收口，下一批任务无法派出）`;
    const r = systemNotify({ to: [assigner], taskId, note, kind: 'please-over' });
    emit({ kind: 'please-over', taskId, assigner, sent: !!(r && r.ok) });
    log({ event: 'please-over', taskId, assigner, note: (r && r.ok) ? '已发送' : ((r && r.reason) || '') });
    return r;
  }

  // ─────────────── 计时 ───────────────

  /**
   * 重建子任务计时表（服务端启动、以及每次扫表都走它）。
   * ⭐ 2026-10-05 改（老大定）：**起点＝派发者把表提交上去那一刻**（`st.assignedAt`）—— 正本 `时限\01` §一；
   *    原来拿 `stateUpdatedAt`（"状态最后变动"、接任务才写）当起点 ⇒ **起算点错了**。
   * ⭐ 同一天还改了**登记范围**：`null`（已派、还没接）**也要计** —— 原来只计 working/blocked
   *    ⇒ "派出去没人接"那一段根本算不进来。交付（delivered）／终态（done／cancelled）仍不计。
   */
  function rebuildTimers() {
    timers.clear();
    const now = Date.now();
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      const assigner = findAssigner(t.id);
      for (const st of t.subtasks) {
        if (st.state === null || st.state === WORKING || st.state === BLOCKED) {
          // ⭐ 时限单位＝**分钟**（2026-10-04 统一；旧代码按秒算 ⇒ 差 60 倍）
          // ⚠️ 2026-10-04 补：存量数据里可能是**字符串**（入账校验是后加的）⇒ 能转成数就用，
          //    免得老件"静默不登记"（新数据已在 `envelope.js` 第 10 条被拒）。
          const mins = Number(st.timeout);
          const timeoutMs = Number.isFinite(mins) && mins > 0 ? mins * 60 * 1000 : 0;
          if (timeoutMs > 0) {
            // 起点：派发时刻优先；老数据没有这个字段 ⇒ 退旧口径（状态变动时刻），再没有才用现在
            const t0 = st.assignedAt ? parseStamp(st.assignedAt)
                     : (st.stateUpdatedAt ? parseStamp(st.stateUpdatedAt) : now);
            timers.set(st.id, { taskId: t.id, subId: st.id, to: st.to, assigner, deadline: t0 + timeoutMs });
          }
        } else {
          timers.delete(st.id);
        }
      }
    }
  }

  /** 重建判挂表：扫描账本 task.deliver，未被派发者 ack（inreplyto 指回）的重新登记（重启恢复） */
  function rebuildWatch() {
    watch.clear();
    const board = dl.readMessages();
    for (const d of board) {
      if (d.type !== 'task.deliver' || !d.data || !d.data.task) continue;
      const subId = d.data.task;
      const assigner = findAssigner(mainIdOf(subId));
      const acked = board.some(
        (m) => m.type === 'task.ack' && m.inreplyto === d.id && m.source === assigner
      );
      if (acked) continue;
      // ⭐ 2026-10-04 修：**已收口的任务别重建进判挂表** —— 原来每次重启都从账本把老交付
      //    翻出来重判一遍（实测 08:10 判过一批、08:19 重启后又判一遍同一批）。
      const t = dl.getTask(mainIdOf(subId));
      if (t && t.closed) continue;
      const start = parseMsgTime(d);
      watch.set(subId, {
        taskId: mainIdOf(subId), subId, deliverMsgId: d.id, assigner,
        deadline: start + config.assignerDeadMs, state: 'pending',
      });
    }
  }

  /**
   * ⭐ 2026-10-05 加：重启后恢复**等验收表**（`acceptWatch`）—— 已交付、还没验收的件重新登记，
   *    起点用子任务上记的 `stateUpdatedAt`（那正是"交付那一刻"）。
   *    ⚠️ 重启后 `nudged` 会重置 ⇒ 那一件**可能被再叫一次**（可接受；"同一件只叫一次"是单次运行内的保证）。
   */
  function rebuildAcceptWatch() {
    acceptWatch.clear();
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      const assigner = findAssigner(t.id);
      for (const st of t.subtasks) {
        if (st.state !== DELIVERED) continue;
        acceptWatch.set(st.id, {
          taskId: t.id, subId: st.id, assigner,
          deliveredAt: st.stateUpdatedAt || stampNow(),
          nudged: false,
        });
      }
    }
  }

  /**
   * 起计时（服务端启动时调一次；重启后从任务表/账本恢复）
   */
  function startTimers() {
    rebuildTimers();
    rebuildWatch();
    rebuildPendingAck();
    rebuildAcceptWatch();   // ⭐ 2026-10-05 加：等验收那条也要能跨重启活下来
  }

  /**
   * 到点的子任务列表（主程序每秒调；对每个结果调 handleTimeout(subId, type)）
   * @param {number} [now]
   * @returns {{taskId, subId, to, assigner, deadline, state}[]}
   */
  function checkTimeouts(now = Date.now()) {
    const due = [];
    for (const [subId, rec] of timers) {
      if (rec.deadline > now) continue;
      const found = findSubtask(subId);
      if (!found) { timers.delete(subId); continue; }
      const st = found.subtask;
      if (st.state === CANCELLED || st.state === DONE) { timers.delete(subId); continue; }
      due.push({ taskId: rec.taskId, subId, to: st.to, assigner: rec.assigner, deadline: rec.deadline, state: st.state });
    }
    return due;
  }

  // ─────────────── 踢下线 / 插话 ───────────────

  let kickFn = (memberId, reason) => {
    kicked.add(memberId);
    emit({ kind: 'kicked', memberId, reason });
    log({ event: 'kick', memberId, reason });
  };
  function kick(memberId, reason) { kickFn(memberId, reason); }
  function setKick(fn) { if (typeof fn === 'function') kickFn = fn; }
  function setInterrupt(fn) { interruptFn = fn; }
  function isKicked(id) { return kicked.has(id); }
  function getKicked() { return [...kicked]; }

  // ─────────────── 超时三型收尾 ───────────────

  /**
   * 判超时（到点没交）⇒ 那件标 `cancelled` ＋ 通知派发者"<子任务 id> 时限超过" ＋ 弹个小提示，
   * 然后照"当时能不能动"收尾（`时限\01` §一）：
   *   - 壳／程序都没了 ⇒ **直接断开连接**；
   *   - 壳还活着 ⇒ 先插一句"时间到了，请停"（**不等回话、不判死活**）⇒ 随即**断开连接**。
   * ⚠️ 2026-10-04：**不再收 type** —— "按怎么死的分三型"作废（状态只有正常／异常，判据只有"到点没交"）。
   * @param {string} subId
   */
  function handleTimeout(subId) {
    const found = findSubtask(subId);
    if (!found) return { ok: false, reason: `子任务不存在: ${subId}` };
    const { task, subtask: st } = found;
    if (st.state === CANCELLED || st.state === DONE) return { ok: true, skipped: true };

    setSubtaskState(task.id, subId, CANCELLED);
    timers.delete(subId);
    triedAdd(subId, st.to);
    const assigner = findAssigner(task.id);

    // 系统主动叫派发者：带上子任务 id，说"时限超过"（不依赖任何一方回执）
    // ⭐ 2026-10-04 修：这里原来**只 `emit`** —— 而 `emit` 是"只塞进内存事件流"（只喂给前端那个
    //    不拦人的小提示），**派发者根本收不到消息**。但本函数上面的注释、以及 `时限\01` §112
    //    都要求「**系统主动叫派发者**」。⇒ 实测撞到（我造超时那次，账本和日志里都没有那条通知，
    //    是我自己盯出来的）。补上 `notifyAssigner`：它发的才是真消息，文案自带
    //    「**谁异常 ＋ 主任务 id ＋ 子任务 id ＋ 请重派**」四样。
    notifyAssigner({ taskId: task.id, subId, assigner, who: st.to, state: 'cancelled', why: '时限超过' });
    emit({ kind: 'assigner-notify', taskId: task.id, subId, assigner, text: `${subId} 时限超过` });
    // 超时弹个小提示（不拦人、不用点确认）
    emit({ kind: 'timeout-notice', taskId: task.id, subId, to: st.to });
    log({ event: 'timeout', taskId: task.id, subId, to: st.to, assigner });

    // 壳还活着（它还连着）⇒ 先插一句"停"；送过去就算，**不等它回话**
    const m = statusInst ? (statusInst.listMembers() || []).find((x) => x.id === st.to) : null;
    const shellAlive = !!(m && m.presence === 'online');
    if (shellAlive && interruptFn) {
      interruptFn(st.to, `时间到了，请停：子任务 ${subId} 的时限已到，请立即停下手上这轮工作`);
    }
    // ⭐ 判异常 ⇒ **断开连接**（⚠️ 不是"踢下线"：踢下线线还挂着、它能自己上线回来）
    kick(st.to, `超时（${subId} 时限超过）`);
    return { ok: true };
  }

  /**
   * 打回满 2 次（＝这件任务总共跑到第 3 轮）⇒ 与超时同款收尾（老大 2026-10-03 定）：标 cancelled ＋ 通知派发者
   * ⚠️ 判据正本在 `envelope.js` 第 8 条：`countRework(board, subId) >= 2` ⇒ **第 3 次打回拒收**。
   *    （"轮次 ＝ 打回次数 ＋ 1"：满 2 次打回 ＝ 干满 3 轮。本条与 `toLogEvent` 的文案指的是同一件事。）
   * "换人重派"（必须换人；没人可换 ⇒ 派发者自己干，走 assignRetry）
   * @param {string} subId 被打回的那件（子任务 id，打回不新起号）
   */
  function handleMaxRounds(subId) {
    const found = findSubtask(subId);
    if (!found) return { ok: false, reason: `子任务不存在: ${subId}` };
    const { task, subtask: st } = found;
    if (st.state === CANCELLED || st.state === DONE) return { ok: true, skipped: true };

    setSubtaskState(task.id, subId, CANCELLED);
    timers.delete(subId);
    triedAdd(subId, st.to);
    const assigner = findAssigner(task.id);
    // ⭐ 2026-10-04 修：同 `handleTimeout` —— 这里原来也**只 `emit`**（派发者收不到消息），
    //    而规范 `时限\01` §116 明写「满了之后**与超时同款收尾** … **系统主动通知派发者**」。
    // ⚠️ 文案里的「换人重派」四个字**必须保留** —— 验收 M17 的正则 `/换人重派|干满 3 轮/` 指着它。
    notifyAssigner({ taskId: task.id, subId, assigner, who: st.to, state: 'cancelled', why: '已进入第 3 轮，换人重派（必须换人；无人可换时由派发者自行处理）' });
    emit({ kind: 'assigner-notify', taskId: task.id, subId, assigner, text: `${subId} 已进入第 3 轮，换人重派（必须换人；无人可换时由派发者自行处理）` });
    emit({ kind: 'max-rounds', taskId: task.id, subId, to: st.to });
    log({ event: 'max-rounds', taskId: task.id, subId, to: st.to, assigner });
    return { ok: true };
  }

  // ⚠️ 宽限期那一步 2026-10-04 删掉（老大令「宽限期可以不要」）：
  //    原来是"插话问一声 ⇒ 等回话 ⇒ 不回才踢"；现在**插完就断开，不等回话、不判死活**
  //    —— 判异常的判据自始至终只有一个：**到点没交**（见 handleTimeout）。

  /**
   * 重建"派发后等表态"表（重启恢复）：扫任务表每一件未收尾子任务，
   * 找账本里最后一条含它的 task.assign，之后若没有执行者的 task.ack（data.task ＝ 它的 id）
   * ⇒ 登记；deadline ＝ 那条 assign 的 time ＋ config.assignAckMs。
   * 老大 2026-10-03 定：从派发消息发出去那一刻起算，不管有没有收到；打回那条 assign 同样算。
   */
  function rebuildPendingAck() {
    // ⚠️ 2026-10-04 改：**不再 `clear()` 重来** —— 已有的那条要**留住它最早算出来的那个 deadline**。
    //    为什么（老大 2026-10-04 拍的）：deadline ＝ 派发那条消息的 `time` ＋ 5 分钟；
    //    而 `parseMsgTime` 对**没有 `time` 的消息**返回 **`Date.now()`** ⇒ **每重建一次就往后漂一次**
    //    ⇒ 一旦"每轮重建"，这个判**永远到不了点**（实测：加了每轮重建之后那件一直不判）。
    //    ⭐ 规矩：**第一次记下的时刻就是派发时刻**；之后重建**只补新的、不动旧的**。
    const seen = new Set();
    const board = dl.readMessages();
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      const assigner = findAssigner(t.id);
      for (const st of t.subtasks) {
        if (st.state === CANCELLED || st.state === DONE) { pendingAck.delete(st.id); continue; }
        let lastAssign = null;
        for (const m of board) {
          if (m.type !== 'task.assign' || !m.data || !Array.isArray(m.data.subtasks)) continue;
          if (m.data.subtasks.some((s) => s && s.id === st.id) && (!lastAssign || m.seq > lastAssign.seq)) lastAssign = m;
        }
        if (!lastAssign) { pendingAck.delete(st.id); continue; }
        const acked = board.some(
          (m) => m.type === 'task.ack' && m.data && m.data.task === st.id && m.source === st.to && m.seq > lastAssign.seq
        );
        if (acked) { pendingAck.delete(st.id); continue; }
        seen.add(st.id);
        const old = pendingAck.get(st.id);
        // ⭐ 还是**同一条派发** ⇒ 保留原 deadline（＝留住"第一次记下的那个时刻"）；
        //    换了新的一条（打回会新发一条 assign）⇒ 那是**新的计时起点**，重算。
        const sameAssign = !!(old && (old.assignMsgId === lastAssign.id || old.assignSeq === lastAssign.seq));
        pendingAck.set(st.id, {
          taskId: t.id, subId: st.id, to: st.to, assigner,
          assignMsgId: lastAssign.id, assignSeq: lastAssign.seq,
          deadline: sameAssign ? old.deadline : (parseMsgTime(lastAssign) + config.assignAckMs),
        });
      }
    }
    // 收拾掉已经不在这张表里的（已终态／已 ack／主任务关了的）
    for (const k of [...pendingAck.keys()]) if (!seen.has(k)) pendingAck.delete(k);
  }

  /**
   * 到点还没表态 ⇒ 判异常（老大 2026-10-03 定：没唤醒到、唤醒了没选接／不接，均判异常）：
   * 标 cancelled ＋ 通知派发者（四样齐：谁异常／主任务 id／子任务 id／请重派）＋ 断开连接（踢下线）。
   * @param {number} [now]
   * @returns {{taskId:string,subId:string,to:string,assigner:string}[]}
   */
  function sweepPendingAck(now = Date.now()) {
    const out = [];
    for (const [subId, p] of pendingAck) {
      if (p.deadline > now) continue;
      const found = findSubtask(subId);
      if (!found) { pendingAck.delete(subId); continue; }
      const { task, subtask: st } = found;
      if (st.state === CANCELLED || st.state === DONE) { pendingAck.delete(subId); continue; }
      // 到点最后一刻再看一眼：期间表过态就不判
      const board = dl.readMessages();
      const acked = board.some(
        (m) => m.type === 'task.ack' && m.data && m.data.task === subId && m.source === st.to && m.seq > (p.assignSeq || 0)
      );
      if (acked) { pendingAck.delete(subId); continue; }

      pendingAck.delete(subId);
      setSubtaskState(task.id, subId, CANCELLED);
      timers.delete(subId);
      triedAdd(subId, st.to);

      const why = '派发后 5 分钟没表态（没唤醒到、或唤醒了没选接／不接，均判异常）';
      notifyAssigner({ taskId: task.id, subId, assigner: p.assigner, who: st.to, state: 'cancelled', why, kind: 'assign-ack-timeout' });
      emit({ kind: 'assign-ack-timeout', taskId: task.id, subId, to: st.to, assigner: p.assigner });
      log({ event: 'timeout', taskId: task.id, subId, to: st.to, type: 'assign-ack' });
      kick(st.to, `派发后 5 分钟没表态（${subId}）`);
      out.push({ taskId: task.id, subId, to: st.to, assigner: p.assigner });
    }
    return out;
  }

  // ─────────────── 试过谁 / 重派 ───────────────

  /** 这件任务试过谁（重派时用来拒原人；链条会随重派累积） */
  function triedList(subId) {
    const found = findSubtask(subId);
    if (!found) return [];
    const st = found.subtask;
    return (Array.isArray(st.tried) && st.tried.length) ? [...st.tried] : [st.to];
  }

  /** 记"试过谁"（走 M1 的接口；M4 不再自己改文件） */
  function triedAdd(subId, memberId) {
    if (!memberId) return;
    try { dl.addTried(subId, memberId); } catch (_) { /* 记不上不阻塞收尾 */ }
  }

  /**
   * 重派（换人重派；超时/refuse 后由派发者安排，自动走，不用等老大）
   * @param {string} subId         被取消的那件（旧 id，不复用）
   * @param {string} to            新执行者
   * @param {object} [opts]        { newSubId?, timeout?, note?, heavy? }，默认继承旧件；
   *                               newSubId 不给就按"现存最大序号 + 1"自己算（前缀必然是主任务 id）
   * @returns {{ok:true, taskId?, subId?, selfDo?:true, reason?} | {ok:false, reason}}
   */
  function assignRetry(subId, to, opts = {}) {
    let newSubId = opts.newSubId;
    const found = findSubtask(subId);
    if (!found) return { ok: false, reason: `子任务不存在: ${subId}` };
    const { task, subtask: st } = found;

    if (st.state === DONE) return { ok: false, reason: `done 的子任务不重发（重派只补没完成的那份）: ${subId}` };

    const tried = triedList(subId);
    if (tried.includes(to)) {
      return { ok: false, reason: `重派必须换人：${to} 已经试过（${tried.join(',')}），已拒收` };
    }

    const assigner = findAssigner(task.id);
    // 换人只能由派发者本人发起（工具口传 opts.by 时校验；内部调用不传则跳过）
    if (opts.by && opts.by !== assigner) {
      return { ok: false, reason: `换人重派只能由派发者发起（${task.id} 是 ${assigner || '未知'} 派的，不是 ${opts.by}），已拒收` };
    }
    if (to === assigner) {
      // 名单外没人可挑 ⇒ 系统判"派发者自己干"，整个在服务端之外：不进任务表、不计时、不报 cancelled、不弹老大
      log({ event: 'self-do', taskId: task.id, subId, assigner, tried });
      return { ok: true, selfDo: true, reason: '无人可换，派发者自己干（服务端之外）', assigner };
    }

    // 目标可派校验（注入 status 时）：重派目标是新人 ⇒ 须在线且不忙；正在等验收的人也不能派新任务
    if (statusInst) {
      const can = statusInst.canAssign(to, assigner);
      if (!can.ok) return { ok: false, reason: `重派目标不可派: ${can.reason}` };
      // ⭐ 2026-10-05 修：原来这里判 `m.busy === 'awaiting'` —— **这个值从来不存在**
      //    （忙闲只有 busy／idle／null 三种，见 `status.js`）⇒ 那句**永远不成立**、白写。
      //    换成真判据：目标手上**有没有"已交付、等验收"的任务**（有就不能再塞新任务）。
      const waiting = dl.listTasks().some((t) => !t.closed
        && (t.subtasks || []).some((s) => s.to === to && s.state === DELIVERED));
      if (waiting) {
        return { ok: false, reason: `重派目标 ${to} 手上有「已交付、等验收」的任务，不能派新任务，已拒收` };
      }
    }

    const t = dl.getTask(task.id);
    if (!t) return { ok: false, reason: `主任务不存在: ${task.id}` };

    // 新子任务 id：没给就自己算 —— 主任务 id + '-' + 序号，序号取现存最大 + 1（旧 id 一律不复用）
    if (!newSubId) {
      let maxNo = 0;
      for (const s of t.subtasks) {
        if (!s.id || !s.id.startsWith(task.id + '-')) continue;
        const n = Number(s.id.slice(task.id.length + 1));
        if (Number.isInteger(n) && n > maxNo) maxNo = n;
      }
      newSubId = `${task.id}-${maxNo + 1}`;
    }
    if (typeof newSubId !== 'string' || !newSubId.startsWith(task.id + '-')) {
      return { ok: false, reason: `新子任务 id 前缀必须等于主任务 id（${task.id}），已拒收` };
    }
    if (t.subtasks.some((s) => s.id === newSubId)) {
      return { ok: false, reason: `新子任务 id 已存在，同一个 id 不复用: ${newSubId}` };
    }

    const newTimeout = opts.timeout !== undefined ? opts.timeout : st.timeout;
    const newHeavy = opts.heavy !== undefined ? !!opts.heavy : !!st.heavy;
    const newNote = opts.note !== undefined ? opts.note : (st.note || '');

    // 试过名单只记"试过谁"、不记次数（规范 03 §3.1）：原人已在 tried 里就别重复塞
    const triedNext = tried.includes(st.to) ? tried : [...tried, st.to];

    dl.appendSubtask(task.id, {
      id: newSubId, to, timeout: newTimeout, heavy: newHeavy, note: newNote, tried: triedNext,
    });

    log({ event: 'assign-retry', taskId: task.id, subId, oldSubId: subId, newSubId, to, tried: triedNext, timeout: newTimeout });
    emit({ kind: 'assign-retry', taskId: task.id, oldSubId: subId, newSubId, to });
    return { ok: true, taskId: task.id, subId: newSubId, assigner };
  }

  // ─────────────── refuse（干不了） ───────────────

  /**
   * 执行者干不了：给系统发固定词 ⇒ 系统转告派发者"执行者干不了，重新派发"，
   * 并起 5 分钟窗口看派发者死活：5 分钟内派发者回应 ⇒ 正常收场（那件 cancelled、执行者当场变空闲）；
   * 5 分钟没回应 ⇒ 弹老大 + 等"我知道了"（handleRefuseAndDead / ackRefuseDead）。
   */
  function onRefuse(subId, opts = {}) {
    const found = findSubtask(subId);
    if (!found) return { ok: false, reason: `子任务不存在: ${subId}` };
    const { task, subtask: st } = found;
    // ⭐ 2026-10-05 加：**只能是这件的执行者说"干不了"**（正本＝规范 `时限\01`「干不了如何收场」那节）。
    //    ⚠️ 与 `assignRetry` 的 `opts.by` 同一套做法：**工具口传 `by` ⇒ 校验；内部调用不传 ⇒ 跳过**
    //    （验收脚本直接调 `to.onRefuse(subId)`，不传就不受影响）。
    if (opts.by && opts.by !== st.to) {
      return { ok: false, reason: `只有这件的执行者（${st.to}）能说"干不了"，${opts.by} 不行，已拒收` };
    }
    if (st.state === DONE || st.state === CANCELLED) return { ok: true, skipped: true };

    const assigner = findAssigner(task.id);
    // ⭐ 2026-10-04 修：同 `handleTimeout`／`handleMaxRounds` —— 这里原来也只 `emit`（**派发者收不到消息**），
    //    而本函数注释与 `01` §3 都写着「系统**转告派发者**"执行者干不了，重新派发"」。
    //    ⚠️ 但**不填 `state`**：`refuse` 这一刻那件**还没被标 cancelled**（要等派发者回应才收场），
    //       填了就跟事实不符（`systemNotify` 里 `state` 是"有就带上、没有就省略"）。
    notifyAssigner({ taskId: task.id, subId, assigner, who: st.to, why: '执行者无法完成，请重新派发' });
    emit({ kind: 'assigner-notify', taskId: task.id, subId, assigner, text: '执行者无法完成，请重新派发' });
    refuseWatch.set(subId, {
      taskId: task.id, subId, to: st.to, assigner,
      deadline: Date.now() + config.assignerDeadMs,
    });
    log({ event: 'refuse', taskId: task.id, subId, to: st.to, assigner });
    return { ok: true };
  }

  /** 派发者 5 分钟内回应（onMessage/onOnline 自动调，或主程序显式调）：正常 refuse 收场 */
  function resolveRefuse(subId) {
    const rw = refuseWatch.get(subId);
    if (!rw) return { ok: false, reason: `没有未决 refuse 窗口: ${subId}` };
    refuseWatch.delete(subId);
    const found = findSubtask(subId);
    const st = found ? found.subtask : null;
    if (st && st.state !== CANCELLED && st.state !== DONE) {
      setSubtaskState(rw.taskId, subId, CANCELLED);
    }
    triedAdd(subId, st ? st.to : rw.to);
    // 执行者当场变空闲 —— ⚠️ 不用手动改：那件已被标 cancelled，忙闲由系统按账本判（`状态\02`）
    log({ event: 'refuse-resolved', taskId: rw.taskId, subId, to: rw.to });
    emit({ kind: 'refuse-resolved', taskId: rw.taskId, subId, to: rw.to });
    return { ok: true };
  }

  /** refuse 后 5 分钟没见派发者 ⇒ 直接停 + 弹老大（任务 id 和内容贴出来 + 等"我知道了"） */
  function handleRefuseAndDead(subId) {
    const rw = refuseWatch.get(subId);
    if (!rw) return { ok: false, reason: `没有未决 refuse 判挂记录: ${subId}` };
    refuseWatch.delete(subId);
    const task = dl.getTask(rw.taskId);
    emit({
      kind: 'refuse-and-dead', taskId: rw.taskId, subId, to: rw.to, assigner: rw.assigner,
      taskTitle: task ? task.title : '', taskNote: task ? task.note : '',
      text: '执行者无法完成、派发者未回应，任务已停止', waitAck: true,
    });
    refuseDeadConfirm.set(subId, { taskId: rw.taskId, subId, to: rw.to });
    log({ event: 'refuse-dead-notify', taskId: rw.taskId, subId, to: rw.to, assigner: rw.assigner });
    return { ok: true };
  }

  /** 老大点"我知道了" ⇒ 那件标 cancelled、板上留一行、执行者变空闲；往后全等老大发话 */
  function ackRefuseDead(subId) {
    const c = refuseDeadConfirm.get(subId);
    if (!c) return { ok: false, reason: `没有等确认的 refuse+死派发者记录: ${subId}` };
    refuseDeadConfirm.delete(subId);
    const found = findSubtask(subId);
    const st = found ? found.subtask : null;
    if (st && st.state !== CANCELLED && st.state !== DONE) {
      setSubtaskState(c.taskId, subId, CANCELLED);
    }
    triedAdd(subId, st ? st.to : c.to);
    // 执行者变空闲 ⇒ 由系统按账本判（那件已 cancelled），不用手动改
    log({ event: 'refuse-dead-cancelled', taskId: c.taskId, subId, to: c.to });
    return { ok: true };
  }

  /** 等老大点"我知道了"的判挂清单（界面待处理弹窗用；只读，M10 前端接真数据用） */
  function listRefuseDeadConfirm() {
    const out = [];
    for (const [subId, c] of refuseDeadConfirm) {
      const task = dl.getTask(c.taskId);
      const found = findSubtask(subId);
      const st = found ? found.subtask : null;
      out.push({
        subId,
        taskId: c.taskId,
        to: c.to,
        taskTitle: task ? task.title : null,
        taskNote: task ? task.note : null,
        subNote: st ? (st.note || null) : null,
      });
    }
    return out;
  }

  /** refuse 判挂表到期（主程序每秒调）：5 分钟到且派发者没回应 ⇒ 进 handleRefuseAndDead */
  function sweepRefuseDead(now = Date.now()) {
    const due = [];
    for (const [subId, rw] of refuseWatch) {
      if (rw.deadline > now) continue;
      handleRefuseAndDead(subId);
      due.push({ taskId: rw.taskId, subId, to: rw.to, assigner: rw.assigner });
    }
    return due;
  }

  // ─────────────── 派发者挂了（03 §3.2） ───────────────

  /**
   * 交付那一刻起 5 分钟判挂表（触发点 = task.deliver；5 分钟从交付发出那一刻起算）
   * @param {string} subId         交付的子任务 id
   * @param {string} deliverMsgId  那条 task.deliver 的消息 id（task.ack 用 inreplyto 指回它来认）
   */
  function onDeliver(subId, deliverMsgId) {
    const found = findSubtask(subId);
    if (!found) return { ok: false, reason: `子任务不存在: ${subId}` };
    const task = found.task;
    const assigner = findAssigner(task.id);
    watch.set(subId, {
      taskId: task.id, subId, deliverMsgId, assigner,
      deadline: Date.now() + config.assignerDeadMs, state: 'pending',
    });
    log({ event: 'deliver-watch', taskId: task.id, subId, deliverMsgId, assigner });
    // ⭐ 2026-10-05 加（正本 `时限\01` §二）：**等验收那条也在这里登记** —— 起点同样是"交付那一刻"，
    //    判挂那条 5 分钟就退场（或派发者回了「收到」），这条接着往下数：15 分钟叫一次、30 分钟兜底。
    acceptWatch.set(subId, {
      taskId: task.id, subId, assigner,
      deliveredAt: stampNow(),
      nudged: false,
    });
    return { ok: true };
  }

  /** 把某件交付时报的产出目录搬进 `收件\<主任务 id>\`（"产出物转老大"） */
  function collectOutputs(mainTaskId, subId) {
    const board = dl.readMessages();
    let last = null;
    for (const m of board) {
      if (m.type === 'task.deliver' && m.data && m.data.task === subId) last = m;
    }
    if (!last || !last.data || !last.data.where) return;
    try {
      // ⭐ 2026-10-05 修（收件目录留空壳）：先看源在不在，再建收件目录
      //    （同 `bridge.handleBossDeliver`；`dirs.inboxDir()` 调用即建目录）
      fs.statSync(last.data.where);
      copyInto(last.data.where, dirs.inboxDir(mainTaskId));
      // ⭐ 2026-10-05 修（日志写反）：这一行**原来写在 `catch` 里** —— 而 `outputs-to-boss` 的含义是
      //    「**产出物到老大文件夹**」（见 `toLogEvent` 的映射）⇒ 等于"复制失败才记成功"，
      //    真成功的那些反而**一个字都没留**。现在挪到成功分支。
      try { log({ event: 'outputs-to-boss', taskId: mainTaskId, subId }); } catch (_) {}
    } catch (e) {
      // 失败**如实留痕**（新事件名；它落到 `state` 那一档，见 `toLogEvent` 的 default 分支）
      try {
        log({ event: 'outputs-to-boss-failed', taskId: mainTaskId, subId, reason: (e && e.message) || String(e) });
      } catch (_) {}
    }
  }

  /** 递归复制目录/文件（产出归置用；只复制、不删原件） */
  function copyInto(src, dest) {
    const st = fs.statSync(src); // 不存在会抛 ⇒ 调用方兜
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) copyInto(path.join(src, name), path.join(dest, name));
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  /**
   * 判挂表到期（主程序每秒调）：交付后 5 分钟没回"收到" ⇒ **判派发者挂**（`时限\01` §二）
   * 收尾：① 产出物转老大 ② 弹窗提醒老大 ③ ⭐ **系统自己判"验收通过"**（那件转 `done`）④ 代报 `over`
   * ⚠️ **老大自己派的任务不走这一套**（那条线交付即自动验收，见 bridge 的 handleBossDeliver）——
   *    这里先把它跳出去，免得把已经验收过的任务又判一次。
   */
  function checkAssignerDeaths(now = Date.now()) {
    const dead = [];
    for (const [subId, w] of watch) {
      if (w.state !== 'pending' || w.deadline > now) continue;
      // ⭐ 2026-10-04 加：**已经收口（over）的任务不再判挂** —— 原来会反复判（实测 08:10、08:19 同一批被
      //    判了两遍：多跑流程、多写日志、还把产出往老大收件夹转的机会又留了一次）。判完就从表里摘掉。
      // ⭐ 2026-10-04 二次修：**任务查不到也摘掉**（`!wtask`）—— 原来只认"在表里且已收口"，
      //    任务表被清空／任务被删时这句为假 ⇒ 兜底失效 ⇒ 判出一条幽灵告警
      //    （实测：15:28 已收口验收的任务，15:31 清库跑下一场，15:33 到点被判"派发者挂"）。
      const wtask = dl.getTask(w.taskId);
      if (!wtask || wtask.closed) { watch.delete(subId); continue; }
      w.state = 'dead';
      const found = findSubtask(subId);
      const st = found ? found.subtask : null;
      const to = st ? st.to : null;

      // 老大派的任务：验收由系统自动判（bridge 那条线），这里不管
      if (findAssigner(w.taskId) === 'boss') { watch.delete(subId); continue; }

      emit({ kind: 'assigner-dead', taskId: w.taskId, subId, assigner: w.assigner, deliverMsgId: w.deliverMsgId });
      emit({ kind: 'output-to-boss', taskId: w.taskId, subId, to, text: '产出物已转交老大' });
      emit({ kind: 'executor-told', taskId: w.taskId, subId, to, text: '派发者已离线，产出已转交老大，当前转为空闲，等待后续安排' });
      log({ event: 'assigner-dead', taskId: w.taskId, subId, assigner: w.assigner, deliverMsgId: w.deliverMsgId });

      // ⭐ 2026-10-04 定：救不活 ⇒ **系统自己判"验收通过"**（那件转 done）＋ 产出丢老大那边
      if (st && st.state !== DONE && st.state !== CANCELLED) {
        collectOutputs(w.taskId, subId);            // 产出物转到老大的收件目录
        // ⭐ 2026-10-05 接线（代码审查第 11 条）：归置之后走一次 `onOutputsToBoss` —— 它负责
        //    "那件正式收尾 ＋ 系统代派发者报 over"（`systemOver` 幂等，下面再调一次也无害），
        //    并顺带在日志里留下 `outputs-to-boss` 这一行。原来这个函数**全项目无调用者**，
        //    这条兜底从上线起就没生效过。
        try { onOutputsToBoss(w.taskId, { subIds: [subId] }); } catch (_) {}
        systemNotify({
          to: to ? [to] : [], taskId: w.taskId, subId, state: 'done',
          note: `派发者已离线、时限已到，系统自动判定「验收通过」（${subId}）`,
          kind: 'assigner-dead-done',
        });
        setSubtaskState(w.taskId, subId, DONE);
      }
      // ⚠️ 2026-10-05 删：这里原来还有一条 `else if (st && st.state !== CANCELLED && st.state !== DONE)`，
      //    条件与上面那个 `if` **完全相同** ⇒ 恒假、**8 行永远不会执行**（代码审查第 7 条）。删掉，
      //    别再让读代码的人以为存在一条"判挂后把件标 cancelled"的路径。
      triedAdd(subId, to);
      // 这一包全收尾了 ⇒ 系统代派发者报 over
      try { systemOver(w.taskId, { reason: 'assigner-dead' }); } catch (_) {}
      dead.push({ taskId: w.taskId, subId, assigner: w.assigner, deliverMsgId: w.deliverMsgId, to });
    }
    return dead;
  }

  /**
   * ⭐ 2026-10-04 加（老大点头）：**代收"没人管的任务"** —— 治"任务出了事没人收口 ⇒ 主任务永远不结束
   * ⇒ 门口一直挡着"这个老毛病（超时／干不了／没表态三条路都长这个样）。
   *
   * **判据（三条同时成立才收，缺一不收）**：
   *   ① 主任务没 `closed`；
   *   ② 名下**没有任何活跃子任务** —— 活跃 ＝ 从没表态(null)／干着(working)／卡住(blocked)；
   *      `delivered`（交了待验）不算活跃，那条交给"判挂"管；
   *   ③ **最后一次动静距今 > `config.orphanGraceMs`**（默认 5 分钟，跟表态/判挂窗口同量级）。
   * ⇒ 只有"**所有任务都已经有结果、只是没人喊收工**"才收 —— **绝不会掐掉正在干的任务**。
   *
   * 动作：`systemOver`（标结束）＋ 日志（`over-system`，界面"待处理"里按"告知"显示、不拦人）。
   * @param {number} [now]
   * @returns {string[]} 被代收的主任务 id
   */
  function sweepOrphanTasks(now = Date.now()) {
    const collected = [];
    // ⚠️ 2026-10-05 改（代码审查第 2 条）：**加上 `DELIVERED`**（原来不在）。
    //    交付了但没验收的件**也算"还挂着的任务"** —— 不能由"无人收口 ⇒ 服务端自行收口"这条来收：
    //    `systemOver` 本来就因它而拒，那条路于是成了**每秒白试一次、连日志都不写**（静默失败）。
    //    这一档现在改由 **15/30 分钟兜底**管（`sweepAcceptDeadline`）：15 分钟叫派发者一次、
    //    30 分钟把产出全部转给 boss ＋ 代它收口。⇒ 三处对 `delivered` 的口径到此一致。
    const ACTIVE = new Set([null, undefined, WORKING, DELIVERED, BLOCKED]);   // 悬在半空的任务
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      // ⭐ 2026-10-05 加：任务全齐了 ⇒ **先叫派发者回来收口**（`over` 只有它能报；这条**不替它收**，
      //    跟下面那段"代收"是两回事：代收管"派发者已经不在了"，这条管"它还在、只是没被叫醒"）。
      try { nudgeAssignerToOver(t); } catch (_) {}
      const subs = t.subtasks || [];
      if (!subs.length) continue;
      if (subs.some((s) => ACTIVE.has(s.state))) continue;           // 还有任务悬着 ⇒ 不动它
      const stamps = subs.map((s) => (s.stateUpdatedAt ? parseStamp(s.stateUpdatedAt) : 0)).filter((x) => x > 0);
      if (!stamps.length) continue;                                  // 拿不到时间 ⇒ 保守跳过（不出手）
      if (now - Math.max(...stamps) < config.orphanGraceMs) continue; // 冷静期没过 ⇒ 再等等
      let r;
      try { r = systemOver(t.id, { reason: 'no-active-work' }); } catch (_) { continue; }
      // ⚠️ 日志由 `systemOver` 自己写（实测它会写一条 `over / 系统代派发者报 over`）⇒ **这里别再写第二条**，
      //    不然同一件事在日志里出现两遍（2026-10-04 实测撞到）。
      // ⭐ 2026-10-05 加（老大定）：代收 **要真发一条消息给老大**（界面上这类统一叫「系统信息」）——
      //    原来只 `emit`（那条没有任何消费方，是死枝）＋ 写日志 ⇒ 老大那边**一点动静都没有**
      //    （消息流空着，只能自己去翻日志）。出口走 `systemNotify`，与判挂那条同款路：
      //    经 bridge 注入的 `receiveAndDeliver`，**真入账、真投递**。
      //    ⚠️ 只有**真收成了**才发：`systemOver` 会因"还有 `delivered` 的子任务"返回 `ok:false`
      //       （与上面第 ② 条判据对 `delivered` 的口径不一致）⇒ 那种情况发出去就是**假话**。
      if (r && r.ok && !r.skipped) {
        systemNotify({
          to: ['boss'], taskId: t.id,
          note: `「${t.title || t.id}」已无进行中的任务且无人收口，系统已代为收口（无需确认）`,
          kind: 'over-system',
        });
        collected.push(t.id);
      }
    }
    return collected;
  }

  /**
   * 产出物进了老大收东西的文件夹 ⇒ 执行者正式改 idle ＋ 系统代派发者报 over（判据 = 产出物到老大文件夹）
   * @param {string} mainTaskId
   * @param {object} [opts] { subIds?: string[] } 不传则处理该主任务下全部已判挂的子任务
   */
  function onOutputsToBoss(mainTaskId, opts = {}) {
    const task = dl.getTask(mainTaskId);
    if (!task) return { ok: false, reason: `任务不存在: ${mainTaskId}` };
    const subIds = (opts.subIds && opts.subIds.length)
      ? opts.subIds
      : Array.from(watch.values()).filter((w) => w.taskId === mainTaskId && w.state === 'dead').map((w) => w.subId);
    for (const subId of subIds) {
      // 执行者正式改 idle —— 由系统按账本判（产出已进老大目录、那件也收尾了）
      log({ event: 'outputs-to-boss', taskId: mainTaskId, subId });
    }
    return systemOver(mainTaskId, { reason: 'outputs-to-boss' });
  }

  /**
   * ⭐ 2026-10-05 加（老大定，正本 `时限\01` §二「交付后派发者一直不验收」）—— 两档兜底：
   *   ① 满 15 分钟 ⇒ 系统**叫派发者一次**「任务已经提交，请验收」（真消息；同一件只叫一次）；
   *   ② 满 30 分钟仍没动静 ⇒ **那批任务每一件的产出全部转给 `boss`** ＋ 系统**代它收口**。
   * ⚠️ 管的是哪一格：那件**已交付**、判挂那条**已经退场**（派发者回过「收到」）。
   *    这一格原来**没有任何机制推进它** —— 判挂只看"有没有回收到"（回了就退场）、
   *    "无人收口 ⇒ 服务端自行收口"那条又因名下还有 `delivered` 而不出手
   *    ⇒ **主任务永久卡死、入口永远挡着下一包**（代码审查第 2 条）。
   * @param {number} [now]
   * @returns {{subId:string, stage:'nudge'|'fallback'}[]}
   */
  function sweepAcceptDeadline(now = Date.now()) {
    const did = [];
    for (const [subId, rec] of acceptWatch) {
      const found = findSubtask(subId);
      if (!found) { acceptWatch.delete(subId); continue; }
      const { task, subtask: st } = found;
      if (task.closed || st.state !== DELIVERED) { acceptWatch.delete(subId); continue; }
      // 派发者还没回「收到」⇒ 那一格归判挂管（5 分钟内），这条先不动它
      const w = watch.get(subId);
      if (w && w.state === 'pending') continue;
      const t0 = rec.deliveredAt ? parseStamp(rec.deliveredAt) : now;
      const elapsed = now - t0;

      if (!rec.nudged && elapsed >= config.acceptNudgeMs) {
        rec.nudged = true;
        const r = systemNotify({
          to: rec.assigner ? [rec.assigner] : [], taskId: task.id, subId,
          note: `任务已经提交（${subId}），请验收`, kind: 'accept-nudge',
        });
        log({ event: 'accept-nudge', taskId: task.id, subId, assigner: rec.assigner, sent: !!(r && r.ok) });
        did.push({ subId, stage: 'nudge' });
      }

      if (elapsed >= config.acceptFallbackMs) {
        // ② 兜底：这批任务**每一件**的产出都转给 boss（不是只有这一件），再把整包收口
        for (const s of (task.subtasks || [])) {
          if (s.state === DELIVERED) collectOutputs(task.id, s.id);
        }
        const r = systemNotify({
          to: ['boss'], taskId: task.id, subId,
          note: `「${task.title || task.id}」交付后 30 分钟未验收，产出已全部转交老大，系统代为收口`,
          kind: 'accept-fallback',
        });
        log({ event: 'accept-fallback', taskId: task.id, subId, assigner: rec.assigner, sent: !!(r && r.ok) });
        // 那些"交了没验"的件由系统代判「验收通过」（与"判派发者失联"那条同款收尾），整包才收得掉
        for (const s of (task.subtasks || [])) {
          if (s.state === DELIVERED) setSubtaskState(task.id, s.id, DONE);
        }
        triedAdd(subId, st.to);
        try { systemOver(task.id, { reason: 'accept-timeout' }); } catch (_) {}
        acceptWatch.delete(subId);
        did.push({ subId, stage: 'fallback' });
      }
    }
    return did;
  }

  /**
   * 系统代派发者报 over（M4 说明书 §五-9）：判据由调用方保证（产出物到齐 / 无活跃子任务）
   * ⚠️ 不走 M1 closeTask（closeTask 要求全部 done；A 挂场景子任务是 cancelled 档，M1 会拒）
   */
  function systemOver(mainTaskId, opts = {}) {
    const task = dl.getTask(mainTaskId);
    if (!task) return { ok: false, reason: `任务不存在: ${mainTaskId}` };
    if (task.closed) return { ok: true, skipped: true };
    // ⭐ 2026-10-05 修：**`null`（已派、还没接）也算"还悬着的任务"** —— 与 `sweepOrphanTasks` 里那张
    //    `ACTIVE` 表（`null/undefined/WORKING/DELIVERED/BLOCKED`）**对齐**。原来这里漏了 `null`
    //    ⇒ 同一份代码里"活跃"有两种定义；现有四个调用点恰好都不会在 `null` 状态下走到这儿，
    //    但那是巧合 —— 留着就是颗雷（多一个调用点就可能把"还没人接的任务"直接收口）。
    const active = task.subtasks.filter(
      (s) => s.state === null || s.state === undefined || [WORKING, DELIVERED, BLOCKED].includes(s.state)
    );
    if (active.length > 0) {
      // ⚠️ 2026-10-05 加（代码审查第 2 条）：**收不动也要留痕** —— 原来这里是裸 `return`，
      //    而调用方只在 `r.ok` 时才写日志 ⇒ 那件永远收不掉时**日志里一个字都没有**
      //    （"兜底失败 = 什么都没发生"）。现在落一条，事后查得到是谁挡住了收口。
      //    （不会被写爆：ACTIVE 现在含 `DELIVERED` ⇒ 有"交了没验"的包不会再走到这儿，改由 15/30 兜底管。）
      const why = `还有子任务未收尾（${active.map((s) => s.id).join(', ')}）`;
      try { log({ event: 'over-blocked', taskId: mainTaskId, subId: active.map((s) => s.id).join(','), reason: why }); } catch (_) {}
      return { ok: false, reason: why };
    }
    dl.closeTaskBySystem(mainTaskId, 'system-over' + (opts.reason ? ':' + opts.reason : ''));
    emit({ kind: 'over', taskId: mainTaskId, by: 'system', reason: opts.reason || null });
    log({ event: 'over-system', taskId: mainTaskId, reason: opts.reason || null });
    return { ok: true };
  }

  // ─────────────── 统一消息钩子 ───────────────

  /**
   * 主程序在每条消息入账（M2 receive 之后）调一次；M4 从这里识别：
   *   - task.ack（inreplyto 指回那条交付且 source=派发者）⇒ 5 分钟内 A 活了，撤销判挂
   *   - task.status blocked/done ⇒ 落任务表状态（M2 已校验身份，M2 不落状态，M4 补）
   *   - "已停止"回话 ⇒ 解除 ② 探针；型③ 探询目标回任何话 ⇒ 算活着
   *   - 派发者发任何消息 ⇒ refuse 窗口正常收场
   */
  function onMessage(msg) {
    if (!msg || !msg.type) return;

    // ⭐ 2026-10-04 加（**老大拍的那一半**）：**派发消息一进来，就把「时刻 ＋5 分钟」记下**。
    //    老大原话：「**派发者发任务一提交上去时间就开始算，直接读取系统时间……然后 +5**」。
    //    ⚠️ 为什么必须在这儿记、不能拖到"重建表"那一刻：
    //      `parseMsgTime` 对**没有 `time` 的消息**返回 **`Date.now()`** ⇒ 拖到重建时就算成了
    //      "重建时刻"，而且**每轮重建还往后漂** ⇒ 那个判永远到不了点（实测撞过）。
    //      ⭐ **入账这一刻 ＝ 计时起点**（消息刚提交上来，最贴近"派发那一刻"）。
    if (msg.type === 'task.assign' && msg.data && Array.isArray(msg.data.subtasks)) {
      for (const s of msg.data.subtasks) {
        if (!s || !s.id) continue;
        const old = pendingAck.get(s.id);
        // ⚠️ **同一条派发重复进来 ⇒ 跳过**（保住原来记下的那个时刻）；
        //    **换了新的一条 ⇒ 重记**（那是新的计时起点，打回就是这样）。
        //    ⚠️ 这里**不能拿 `msg.seq` 判新旧** —— `onMessage` 收到的是**原始信封**，
        //       `seq` 是入账那一刻才加的（实测：桩子里那条没有 `seq`）⇒ 用 id 判才可靠。
        if (old && old.assignMsgId === msg.id) continue;
        pendingAck.set(s.id, {
          taskId: msg.data.task || s.id, subId: s.id, to: s.to, assigner: msg.source,
          assignMsgId: msg.id, assignSeq: msg.seq || 0,
          deadline: Date.now() + config.assignAckMs,   // ⭐ 现在 ＋ 5 分钟 —— 提交这一刻
        });
      }
    }

    if (msg.type === 'task.ack' && msg.inreplyto) {
      for (const w of watch.values()) {
        if (w.state === 'pending' && w.deliverMsgId === msg.inreplyto && w.assigner === msg.source) {
          w.state = 'resolved';
          log({ event: 'assigner-ack', taskId: w.taskId, subId: w.subId, assigner: w.assigner });
        }
      }
    }

    if (msg.type === 'task.status' && msg.data && msg.data.task && msg.data.state) {
      const subId = msg.data.task;
      const found = findSubtask(subId);
      if (found) {
        const { task, subtask: st } = found;
        if (msg.data.state === 'blocked' && msg.source === st.to) {
          if (st.state !== CANCELLED && st.state !== DONE && st.state !== DELIVERED) {
            setSubtaskState(task.id, subId, BLOCKED); // 计时保持（blocked 照样超时，无解套）
            log({ event: 'subtask-blocked', taskId: task.id, subId, to: st.to });
          }
        } else if (msg.data.state === 'done') {
          if (st.state !== CANCELLED) {
            setSubtaskState(task.id, subId, DONE);
            timers.delete(subId);
            log({ event: 'subtask-done', taskId: task.id, subId, to: st.to });
          }
        }
      }
    }

    // ⚠️ "已停止"回话 ／ 探询"在不在"这两块 2026-10-04 删掉（宽限期作废）：
    //    插话只是"让它别跑了"，它回不回都不影响收尾（`时限\01` §一）。

    // refuse 窗口：派发者发任何消息 ⇒ 算"回来了"，正常收场
    for (const rw of refuseWatch.values()) {
      if (rw.assigner === msg.source) resolveRefuse(rw.subId);
    }
  }

  /**
   * 成员上线：① 把 5 分钟内的未决交付**补投**给它（「任务已经提交，请验收」）② 解 refuse 窗口。
   * ⭐ 2026-10-05 改（代码审查第 8 条）：这条原来是**双重死路** —— `onOnline` 全项目零调用点；
   *    而且它内部只 `emit` 一个事件，`emit` 的消费者 `customNotifier` 靠 `setNotifier` 注入、
   *    **同样零调用点** ⇒ 就算触发了也**没人收**。现在两处都补上：调用点接在 `bridge` 的
   *    `presence` 工具里（上线成功时调），动作改成**真发消息**（`systemNotify`，真入账真投递）。
   */
  function onOnline(memberId) {
    const now = Date.now();
    for (const w of watch.values()) {
      if (w.state === 'pending' && w.assigner === memberId && w.deadline > now) {
        systemNotify({
          to: [memberId], taskId: w.taskId, subId: w.subId,
          note: `任务已经提交（${w.subId}），请验收`, kind: 'assigner-please-accept',
        });
      }
    }
    for (const rw of refuseWatch.values()) {
      if (rw.assigner === memberId) resolveRefuse(rw.subId);
    }
  }

  // ─────────────── 配置 / 通知 ───────────────

  /**
   * 系统主动发一条消息（真发：入账 ＋ 投递），不依赖任何一方回执。
   * ⭐ 老大 2026-10-03 定：给派发者的通知必须带齐四样 —— 谁异常了 ＋ 主任务 id ＋ 子任务 id ＋「请重派」。
   * 出口由 bridge 注入（setSender）；没接线时退回 emit（只记事件，验收脚本可读）。
   * 消息形态：type = task.status、source = 'system'（01 §5.1 C：cancelled 只有系统能标）；
   * task.* 前缀 ⇒ 收件人天然被叫醒（规范 08 §四）。
   * @param {{to:string[], type?:string, taskId?:string, subId?:string, state?:string, note:string, kind?:string}} o
   * @returns {{ok:boolean, seq?:number, reason?:string}}
   */
  function systemNotify(o) {
    const to = Array.isArray(o.to) ? o.to.filter(Boolean) : [];
    const note = String(o.note || '');
    if (!to.length) return { ok: false, reason: '没有收件人，系统通知发不出去' };
    const env = {
      // ⭐ 2026-10-05 修：**id 末尾补一个同秒序号** —— 原来只有到秒的时间戳，同一秒里对同一件发两条
      //    同类通知（`kind`／`subId` 都一样）会**生成完全相同的 id** ⇒ 第二条被 M2 的幂等判重、
      //    静默丢弃。`bridge.systemSend` 一直是带序号的（`++sysSeq`），这里漏了。
      id: `sys-${o.kind || 'notice'}-${o.subId || o.taskId || 'x'}-${stampNow()}-${++sysSeq}`,
      source: 'system',
      specversion: '1.0',
      type: o.type || 'task.status',
      to,
      time: stampNow(),
      data: { task: o.subId || '', note },
    };
    if (o.state) env.data.state = o.state;
    if (!customSender) {
      // ⭐ 2026-10-05 加（堵隐患：**别静默降级**）：原来这一档**只 `emit`** —— `getEvents()` 里看得见，
      //    **日志里一个字没有** ⇒ 接线真断了（bridge 忘了 `setSender`）没人会发现；而系统通知正是
      //    「代收／判挂／超时」那几条的收尾动作：悄悄不发 ⇒ 老大那边一点动静都没有。
      //    ⇒ 补一条**落盘日志**（`日志\<日期>.jsonl`，事件名 `system-notify-unsent`，映射见 `toLogEvent`）。
      //    ⚠️ **行为保持兼容**：不抛错、返回值一字不变（还是 `ok:false` ＋ 同一句 reason）。
      const reason = 'sender 未接线（bridge 未注入），只记了事件';
      emit({ kind: 'system-notify-unsent', to, taskId: o.taskId, subId: o.subId, text: note, reason });
      log({ event: 'system-notify-unsent', to, taskId: o.taskId, subId: o.subId, note, reason });
      return { ok: false, reason };
    }
    let r;
    try {
      r = customSender(env);
    } catch (e) {
      return { ok: false, reason: `系统通知发送异常：${e && e.message}` };
    }
    if (r && r.ok) return { ok: true, seq: r.seq };
    return { ok: false, reason: (r && r.reason) || '系统通知被拒收' };
  }

  /**
   * 通知派发者「执行者异常，请重派」（老大 2026-10-03 定：四样必须齐）。
   * @param {{taskId:string, subId:string, assigner:string, who:string, state?:string, why:string, kind?:string}} o
   */
  function notifyAssigner(o) {
    if (!o || !o.assigner) return { ok: false, reason: '没有派发者，通知发不出去' };
    const line = `${o.who} 异常：任务 ${o.taskId} 子任务 ${o.subId}，请重派。（${o.why}）`;
    const r = systemNotify({
      to: [o.assigner], taskId: o.taskId, subId: o.subId,
      state: o.state, note: line, kind: o.kind || 'assigner-notify',
    });
    emit({ kind: 'assigner-notify', taskId: o.taskId, subId: o.subId, assigner: o.assigner, text: line, sent: r.ok });
    return r;
  }

  function setSender(fn) { customSender = typeof fn === 'function' ? fn : null; }

  function setConfig(partial = {}) {
    // ⚠️ graceMs 2026-10-04 删（宽限期作废）——别再往 config 里塞这个键
    if (partial.assignerDeadMs !== undefined) config.assignerDeadMs = partial.assignerDeadMs;
    // ⭐ 2026-10-05 加：等验收那两档窗口也要能改（验收脚本要把它调小来演 15/30 分钟）
    if (partial.acceptNudgeMs !== undefined) config.acceptNudgeMs = partial.acceptNudgeMs;
    if (partial.acceptFallbackMs !== undefined) config.acceptFallbackMs = partial.acceptFallbackMs;
    if (partial.assignAckMs !== undefined) config.assignAckMs = partial.assignAckMs;
    if (partial.orphanGraceMs !== undefined) config.orphanGraceMs = partial.orphanGraceMs;
    return { ...config };
  }
  function setNotifier(fn) { customNotifier = typeof fn === 'function' ? fn : null; }
  function getEvents() { return [...events]; }
  function clearEvents() { events.length = 0; }

  return {
    // 跨块约定接口（别改名）
    startTimers, rebuildTimers, onDeliver, checkTimeouts, handleTimeout, handleMaxRounds,
    onRefuse, triedList, assignRetry, handleRefuseAndDead,
    // 辅助接口
    onMessage, checkAssignerDeaths, sweepPendingAck, rebuildPendingAck, sweepRefuseDead, sweepOrphanTasks,
    nudgeAssignerToOver, sweepAcceptDeadline, rebuildAcceptWatch,
    resolveRefuse, ackRefuseDead, onOutputsToBoss, systemOver, onOnline,
    listRefuseDeadConfirm,
    setConfig, setNotifier, setSender, systemNotify, notifyAssigner, getEvents, clearEvents,
    setKick, isKicked, getKicked, setInterrupt,
  };
}

// 默认实例：用 M1 数据层 + M3 状态机（生产路径）
const timeout = createTimeout(dataLayer, { status: statusModule });

module.exports = {
  createTimeout,
  toLogEvent,
  startTimers: timeout.startTimers,
  rebuildTimers: timeout.rebuildTimers,
  onDeliver: timeout.onDeliver,
  checkTimeouts: timeout.checkTimeouts,
  handleTimeout: timeout.handleTimeout,
  handleMaxRounds: timeout.handleMaxRounds,
  onRefuse: timeout.onRefuse,
  triedList: timeout.triedList,
  assignRetry: timeout.assignRetry,
  handleRefuseAndDead: timeout.handleRefuseAndDead,
  onMessage: timeout.onMessage,
  checkAssignerDeaths: timeout.checkAssignerDeaths,
  sweepOrphanTasks: timeout.sweepOrphanTasks,
  nudgeAssignerToOver: timeout.nudgeAssignerToOver,
  sweepAcceptDeadline: timeout.sweepAcceptDeadline,
  rebuildAcceptWatch: timeout.rebuildAcceptWatch,
  sweepPendingAck: timeout.sweepPendingAck,
  rebuildPendingAck: timeout.rebuildPendingAck,
  sweepRefuseDead: timeout.sweepRefuseDead,
  resolveRefuse: timeout.resolveRefuse,
  ackRefuseDead: timeout.ackRefuseDead,
  onOutputsToBoss: timeout.onOutputsToBoss,
  systemOver: timeout.systemOver,
  onOnline: timeout.onOnline,
  listRefuseDeadConfirm: timeout.listRefuseDeadConfirm,
  setConfig: timeout.setConfig,
  setNotifier: timeout.setNotifier,
  setSender: timeout.setSender,
  systemNotify: timeout.systemNotify,
  notifyAssigner: timeout.notifyAssigner,
  getEvents: timeout.getEvents,
  clearEvents: timeout.clearEvents,
  setKick: timeout.setKick,
  isKicked: timeout.isKicked,
  getKicked: timeout.getKicked,
  setInterrupt: timeout.setInterrupt,
};

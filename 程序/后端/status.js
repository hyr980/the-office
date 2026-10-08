'use strict';

/**
 * M3 · 状态机制 —— 连接、在线判定、忙闲（系统判）
 *
 * 依据（2026-10-04 口径）：
 *   - 规范\状态\02-忙闲.md            ★ 忙闲正本（两态、系统判、给老大留一个口）
 *   - 规范\接入\01-接入与连接.md §2.2  ★ 被处理过的人怎么回来（正本表）
 *   - 规范\状态\01-连接与在岗.md       （"在岗"那一根轴：两格）
 *
 * 分工（跨块约定接口，别改名）：
 *   receiveHeartbeat(memberId)          连接表每 1 秒刷一次：只更新时间戳
 *   sweepOffline()                      定时扫：连续 2 次没报到 ⇒ 判离线
 *   setPresence(memberId, 'online')     上线（⚠️ "隐身"整档砍掉；被"断开连接"的拒、被"踢下线"的放行）
 *   setBusyByBoss(memberId, busy)       ⭐ 老大在成员卡上改忙闲（**只给人的口，AI 拿不到**）
 *   canAssign(targetId, byMemberId)     派发那一刻现查两道门（在线 → 忙闲）
 *   listMembers()                       成员卡 ＋ 在线 ＋ 忙闲（离线 ⇒ 忙闲不显示）
 *   disconnect(memberId, why)           ⭐ 断开连接：真断（状态标掉 ＋ 回调让桥把那条 SSE 断掉）
 *   kickMember(id)                      老大手动踢下线（⚠️ 线还挂着 ⇒ 它能自己上线回来）
 *   callOnline(id)                      ⚠️ **旧口（保留不删，但不该再调）**：它**直接改在线状态**，
 *                                       等于"办公室代 AI 上线" —— 与现行口径相反（现在"叫它上线"
 *                                       **只叫醒**、上线由 AI 自己完成，见 `接入\01` §2.2）。
 *
 * 关键口径（别照旧代码写）：
 *   - **在线只有两格** `online` / `offline` —— "隐身"2026-10-04 整档砍掉；
 *   - **忙闲只有两态** `busy` / `idle`，**由系统按消息流判** —— 成员不自己填；
 *   - ⚠️ **不许自动回在线**：心跳只更新时间戳（「心跳回来自动回在线」2026-10-04 作废）；
 *   - ⭐ **上下线分界**（正本 `接入\01` §2.2）：**踢下线 ⇒ 线还挂着、它能自己上线**；
 *     **断开连接 ⇒ 真断、它自己上不来**（要人重新点「连接」再点「上线」）；
 *   - boss 不进状态机：开程序＝在、关＝不在。
 *
 * 约束：零第三方依赖；不改 M1/M2 的代码与接口。
 */

const dataLayer = require('./data-layer');

const BOSS = 'boss';
const { TASK_STATES } = dataLayer;

/** 心跳定值：**1 秒**扫一次、连续 2 次没报到判离线（≈**2 秒**发现）—— 2026-10-04 老大令「**去把两秒改成一秒**」 */
const DEFAULT_HEARTBEAT_PERIOD_MS = 1 * 1000;
const DEFAULT_OFFLINE_AFTER_MS = DEFAULT_HEARTBEAT_PERIOD_MS * 2;

/** 在线只有两格（"隐身"已砍） */
const PRESENCE = { ONLINE: 'online', OFFLINE: 'offline' };

/** 忙闲只有两态（"等验收"不是状态档，是那件事的阶段） */
const BUSY = { BUSY: 'busy', IDLE: 'idle' };

/** 离线是怎么来的 —— 决定"它能不能自己上线回来"（正本 `接入\01` §2.2） */
const OFFLINE_REASON = {
  HEARTBEAT: 'heartbeat',    // 心跳/连接断了 ⇒ 不是"断开连接"那个动作 ⇒ 它自己能上线
  KICK: 'kick',              // 老大手动踢下线：线还挂着 ⇒ 能自己上线
  SELF: 'self',              // ⭐ 成员自己下线（2026-10-04 定）：线还挂着 ⇒ 它自己能上线回来
  DISCONNECT: 'disconnect',  // 系统判异常 ⇒ 断开连接：真断 ⇒ 它自己上不来
};

/**
 * 造一个状态机实例（数据层可注入：默认用 M1 数据层；自验/测试可注入隔离副本）
 */
function createStatus(dl) {
  // 已知成员集合：boss 算成员但进不了状态机；由成员模块注入（members.syncMembers）
  let members = [BOSS];

  // memberId -> 状态记录（纯内存；重启后靠人重新点「连接」＋「上线」回来）
  const states = new Map();

  let config = {
    heartbeatPeriodMs: DEFAULT_HEARTBEAT_PERIOD_MS,
    offlineAfterMs: DEFAULT_OFFLINE_AFTER_MS,
  };

  // 断开连接时要通知桥（把那条 SSE 真断掉）——由 bridge 注入
  let disconnectNotify = null;

  function setDisconnectNotify(fn) { disconnectNotify = typeof fn === 'function' ? fn : null; }

  /** 注入成员集合（接受 id 字符串数组或 {id,name,icon} 对象数组） */
  function setMembers(ids) {
    const list = Array.isArray(ids) ? ids : [];
    members = list.map((x) => (typeof x === 'string' ? x : x.id));
    for (const x of list) {
      if (typeof x === 'object' && x.id) {
        const st = ensureState(x.id);
        if (x.name) st.name = x.name;
        if (x.icon) st.icon = x.icon;
      }
    }
  }
  function getMembers() { return [...members]; }
  function setConfig(partial) {
    if (partial && partial.heartbeatPeriodMs !== undefined) config.heartbeatPeriodMs = partial.heartbeatPeriodMs;
    if (partial && partial.offlineAfterMs !== undefined) config.offlineAfterMs = partial.offlineAfterMs;
    return { ...config };
  }

  /** boss 不进状态机（他开程序＝在、关＝不在） */
  function isStateable(id) {
    return id !== BOSS && members.includes(id);
  }

  /**
   * 这件子任务算不算"手上还没结束的事"（规范 状态\02 判据表）
   * ⭐ `null`＝**已派、还没接** —— 也算忙（「在任务发出来的那一刻，执行者就是忙」）；
   *    只有 `cancelled` / `done` 才算这件事结束了。
   */
  function isOpenSubtask(state) {
    return state !== TASK_STATES.CANCELLED && state !== TASK_STATES.DONE;
  }

  /** 账本推导：手上有没结束的事 ⇒ 忙 */
  function deriveBusyFromLedger(memberId) {
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      for (const st of t.subtasks) {
        if (st.to === memberId && isOpenSubtask(st.state)) return BUSY.BUSY;
      }
    }
    return BUSY.IDLE;
  }

  /**
   * 账本指纹：该成员那些任务的状态串。
   * 老大手动改过忙闲之后，**账本一变这个指纹就变** ⇒ 手动值作废、回到系统判。
   */
  function ledgerKey(memberId) {
    const parts = [];
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      for (const st of t.subtasks) {
        if (st.to !== memberId) continue;
        parts.push(`${st.id}:${st.state || ''}:${st.stateUpdatedAt || ''}`);
      }
    }
    return parts.sort().join('|');
  }

  /** 取（或建）成员状态记录；第一次见到时是离线 */
  function ensureState(memberId) {
    if (!states.has(memberId)) {
      states.set(memberId, {
        presence: PRESENCE.OFFLINE,
        offlineReason: null,
        busyByBoss: false,  // 老大手动改过的值（账本一变就作废）
        busyKey: '',
        busy: BUSY.IDLE,
        name: memberId,
        icon: memberId.slice(0, 1).toUpperCase(),
        lastHeartbeat: null,
        heartbeatCount: 0,
      });
    }
    return states.get(memberId);
  }

  /** 当前忙闲：老大手动改过的优先（账本没变的前提下），否则按账本现算 */
  function currentBusy(memberId) {
    const st = ensureState(memberId);
    if (st.busyByBoss && st.busyKey === ledgerKey(memberId)) return st.busy;
    return deriveBusyFromLedger(memberId);
  }

  /**
   * 心跳报到：只更新时间戳，不叫模型（规范：心跳唯一的作用＝判在不在线）
   * ⚠️ **不改状态** —— 「心跳回来自动回在线」2026-10-04 已作废（不许自动连接）。
   * @returns {boolean} 是否受理（boss / 未知成员 ⇒ false）
   */
  function receiveHeartbeat(memberId) {
    if (!isStateable(memberId)) return false;
    const st = ensureState(memberId);
    st.lastHeartbeat = Date.now();
    st.heartbeatCount += 1;
    return true;
  }

  /**
   * 服务端定时扫：连续 2 次没报到 ⇒ 判离线
   * @param {number} [now] 注入当前时间（自验用；生产不传）
   * @returns {{id:string, hadActiveWork:boolean}[]} 本次被判离线的人
   */
  function sweepOffline(now = Date.now()) {
    const kicked = [];
    for (const id of members) {
      if (!isStateable(id)) continue;
      if (!states.has(id)) continue;               // 从未报到过：默认离线，不用判
      const st = states.get(id);
      if (st.presence === PRESENCE.OFFLINE) continue;
      if (st.lastHeartbeat == null) continue;      // 声明过上线但从未报到：等它报到
      if (now - st.lastHeartbeat > config.offlineAfterMs) {
        st.presence = PRESENCE.OFFLINE;
        // ⚠️ 已经被"断开连接"处理过的人，记号不降级成 heartbeat（否则它就又能自己上线了）
        if (st.offlineReason !== OFFLINE_REASON.DISCONNECT) st.offlineReason = OFFLINE_REASON.HEARTBEAT;
        kicked.push({ id, hadActiveWork: currentBusy(id) === BUSY.BUSY });
      }
    }
    return kicked;
  }

  /**
   * 老大手动踢下线（界面成员卡上的红色按钮）
   * ⭐ 判离线，但**那条连接不动**（线还挂着）⇒ **它自己能上线回来**（正本 `接入\01` §2.2）。
   * @returns {{ok:boolean, reason?:string, id?:string, hadActiveWork?:boolean}}
   */
  function kickMember(id) {
    if (!isStateable(id)) return { ok: false, reason: `boss 或未知成员不进状态机: ${id}` };
    if (!states.has(id)) return { ok: false, reason: `${id} 从未报到过，本来就是离线` };
    const st = states.get(id);
    if (st.presence === PRESENCE.OFFLINE) return { ok: false, reason: `${id} 已经离线了` };
    st.presence = PRESENCE.OFFLINE;
    st.offlineReason = OFFLINE_REASON.KICK; // 线还挂着 ⇒ 它能自己上线
    return { ok: true, id, hadActiveWork: currentBusy(id) === BUSY.BUSY };
  }

  /**
   * ⭐ **断开连接**（系统判异常时的收尾，规范 `时限\01` §一）
   * 与"踢下线"的区别：这是**真断** —— 状态标掉 ＋ 通知桥把那条 SSE 连接断掉
   * ⇒ **它自己上不来**（要人重新点「连接」再点「上线」）。
   */
  function disconnect(memberId, why) {
    if (!isStateable(memberId)) return { ok: false, reason: `boss 或未知成员不进状态机: ${memberId}` };
    const st = ensureState(memberId);
    st.presence = PRESENCE.OFFLINE;
    st.offlineReason = OFFLINE_REASON.DISCONNECT;
    if (disconnectNotify) { try { disconnectNotify(memberId); } catch (_) { /* 断不开也别把状态回滚 */ } }
    return { ok: true, id: memberId, why: why || '' };
  }

  /**
   * 上线（规范 §2.2：人和 AI 走的是同一条路）
   * ⚠️ 被"断开连接"处理的 ⇒ 拒（它自己上不了）；被"踢下线"处理的 ⇒ 放行。
   * @returns {{ok:boolean, reason?:string}}
   */
  function setPresence(memberId, presence, reason) {
    if (!isStateable(memberId)) {
      return { ok: false, reason: `boss 或未知成员不进状态机: ${memberId}` };
    }
    // ⭐ **自己下线**（2026-10-04 老大定：「点了下线得先跟办公室说我下线了，才解绑，这样子办公室才知道你下线了」）：
    //    跟"老大踢下线"同一档 —— **那条线还挂着** ⇒ 它自己 `online` 就能回来。
    //    幂等：本来就离线也回 ok（免得插件那边白报一次错）。
    if (presence === PRESENCE.OFFLINE) {
      const st0 = ensureState(memberId);
      if (st0.presence === PRESENCE.OFFLINE) return { ok: true, presence: PRESENCE.OFFLINE, already: true };
      st0.presence = PRESENCE.OFFLINE;
      // ⚠️ `reason` 可选：缺省 `self`（成员自己下线）；**那条线断了**那种传 `heartbeat`
      //    （这两档**都能自己上线回来**，只有 `disconnect` 那档不行）。
      st0.offlineReason = reason || OFFLINE_REASON.SELF;
      return { ok: true, presence: PRESENCE.OFFLINE };
    }
    if (presence !== PRESENCE.ONLINE) {
      return { ok: false, reason: `presence 只有 online（上线）／offline（自己下线）两个值: ${presence}` };
    }
    const st = ensureState(memberId);
    if (st.presence === PRESENCE.OFFLINE && st.offlineReason === OFFLINE_REASON.DISCONNECT) {
      return {
        ok: false,
        /* ⭐ 2026-10-06 文案统一（老大：「系统通知这一类改成通俗正式一点、不要有你我他」）：
           原来写「…已被断开 ⇒ 它自己上不了，得人重新点…」—— 去箭头、去"它"、去口语。 */
        reason: `${memberId} 的连接已被断开，该成员无法自行上线，需重新点「连接」再点「上线」`,
      };
    }
    st.presence = PRESENCE.ONLINE;
    st.offlineReason = null;
    st.busyByBoss = false; // 回来 ⇒ 忙闲按账本重判（手上那件早被标 cancelled ⇒ 空闲）
    // ⭐ 上线那一刻就开始计时：否则 lastHeartbeat 一直是 null，sweepOffline 会把它当
    //    "从未报到过"跳过 ⇒ 这人永远判不了离线。（连接表每 1 秒刷一次会把它续上）
    st.lastHeartbeat = Date.now();
    return { ok: true, presence: PRESENCE.ONLINE };
  }

  /**
   * ⚠️ **已作废的旧口**（2026-10-05 注；**保留不删，只加警示**）：它**直接改在线状态**，等于
   * "办公室代 AI 上线" —— 这正是 2026-10-04 砍掉的行为（老大：「**插件是来唤醒的，这个得让 ai 自己去上线**」）。
   * 现在**全项目没有调用点**；"叫它上线"走 `bridge.js` 的 `call_online`（只叫醒、不碰状态）。
   * ⚠️ 谁照着这个函数名或旧注释去用，就会把砍掉的行为装回来 —— 留着这段就是为了拦这一手。
   */
  function callOnline(id) {
    if (!isStateable(id)) return { ok: false, reason: `boss 或未知成员不进状态机: ${id}` };
    if (!states.has(id)) return { ok: false, reason: `${id} 从未报到过，叫不上去` };
    const wasOffline = states.get(id).presence === PRESENCE.OFFLINE;
    const r = setPresence(id, PRESENCE.ONLINE);
    if (!r.ok) return r;
    return { ok: true, id, wasOffline };
  }

  /**
   * ⭐ 老大在成员卡上改忙闲（规范 `状态\02`：「空闲平时系统通过信息判断，然后给我留个口让我能自己改」）
   * ⚠️ **只给人的口**：AI 那一侧没有这个工具（`busy` 工具已撤）。
   */
  function setBusyByBoss(memberId, busy) {
    if (!isStateable(memberId)) return { ok: false, reason: `boss 或未知成员不进状态机: ${memberId}` };
    if (busy !== BUSY.BUSY && busy !== BUSY.IDLE) {
      return { ok: false, reason: `忙闲只有 busy|idle 两态，收到: ${busy}` };
    }
    const st = ensureState(memberId);
    st.busy = busy;
    st.busyByBoss = true;
    st.busyKey = ledgerKey(memberId); // 记住改的那一刻账本什么样（账本一变就回到系统判）
    return { ok: true, id: memberId, busy };
  }

  /** 找 memberId 名下「已交付、未验收」那件任务的派发者（awaiting 那道门用） */
  function findAssignerOfAwaiting(memberId) {
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      const hasDelivered = t.subtasks.some(
        (st) => st.to === memberId && st.state === TASK_STATES.DELIVERED
      );
      if (!hasDelivered) continue;
      const assignMsg = dl.readMessages().find(
        (m) => m.type === 'task.assign' && m.data && m.data.task === t.id
      );
      return assignMsg ? assignMsg.source : null;
    }
    return null;
  }

  /**
   * 派发那一刻现查状态（规范 `流程\02`）：门一在线 → 门二忙闲
   * ⚠️ 「等验收」**不是状态档**（规范 `状态\02`）⇒ 用账本判：有"已交付、未验收"的任务时，
   *    只有它的派发者能派（且只能打回），别人一律拒。
   * @returns {{ok:true, reason?:string} | {ok:false, reason:string}}
   */
  function canAssign(targetId, byMemberId) {
    if (!isStateable(targetId)) {
      return { ok: false, reason: `boss 或未知成员不能被派发: ${targetId}` };
    }
    const st = ensureState(targetId);

    // 门一：在线（离线的人根本进不了名单；这里再拦一道）
    if (st.presence !== PRESENCE.ONLINE) {
      return { ok: false, reason: `${targetId} 不在线，不能派发` };
    }

    // 「等验收」：那件事的阶段（不是状态档）
    const assigner = findAssignerOfAwaiting(targetId);
    if (assigner) {
      if (byMemberId === assigner) {
        return { ok: true, reason: '只能打回（同一件任务的下一轮）；新任务由信封校验拦' };
      }
      return { ok: false, reason: `${targetId} 收的任务已交、在等验收，只有派发者能派（且只能打回）` };
    }

    // 门二：忙闲（系统判）
    if (currentBusy(targetId) === BUSY.BUSY) {
      return { ok: false, reason: `${targetId} 现在忙，不能派发` };
    }
    return { ok: true };
  }

  /**
   * 查成员（静态卡 ＋ 在线 ＋ 忙闲）；boss 不上列表
   * ⚠️ 离线/断开的：**忙闲那一栏空着**（规范 `状态\02`：「状态不显示」＝那一栏空着）
   * ⭐ **离线的还要带"因为什么离的"**（`offlineReason`，2026-10-04 加；规范 `状态\01` §2.3）
   * @returns {{id:string, name:string, presence:string, offlineReason:string|null, busy:string|null, icon:string}[]}
   */
  function listMembers() {
    const out = [];
    for (const id of members) {
      if (!isStateable(id)) continue;
      const st = ensureState(id);
      out.push({
        id,
        name: st.name,
        presence: st.presence,
        // ⭐ 2026-10-04 加：**离了线要能看出"因为什么离的"**（老大原话：「**离线不知道什么情况那就把原因也写进去不就好了**」）
        //    四个值见 `OFFLINE_REASON`：`self`（自己下线）／`heartbeat`（心跳超时被系统判掉）／
        //    `kick`（老大踢下线 —— 线还挂着 ⇒ **它能自己上线**）／`disconnect`（被断开连接 ⇒ **只能人重新点连接**）。
        //    ⚠️ ⭐ `kick` 和 `disconnect` 必须分得开 —— 它决定"它还能不能自己回来"（正本 `接入\01` §2.2 那张分界线表）。
        //    在线时一律 null（不在"离线"这一档，没有原因好说）。
        offlineReason: st.presence === PRESENCE.OFFLINE ? (st.offlineReason || null) : null,
        busy: st.presence === PRESENCE.ONLINE ? currentBusy(id) : null,
        icon: st.icon,
      });
    }
    return out;
  }

  /** ⭐ 取某一个成员"因为什么离线"（在线回 null）—— 界面显示原因用（规范 `状态\01` §2.3，2026-10-04 加）。 */
  function offlineReasonOf(id) {
    if (!isStateable(id)) return null;
    const st = states.get(id);
    if (!st || st.presence !== PRESENCE.OFFLINE) return null;
    return st.offlineReason || null;
  }

  /**
   * ⭐ 2026-10-05 加（老大令「来修第二点」）：**清掉"断开连接"那个记号**。
   *
   * 为什么要有它：规范 `接入\01` §2.2 的分界线表写着「**断开连接 ⇒ 真断 ⇒ 要恢复得人重新点「连接」**」
   * —— 那句话隐含"线回来了就该能再上线"；而在这之前**全项目没有任何地方清这个记号**
   * ⇒ 被「断开连接」的成员（超时收尾的连带）**不重启后端就永远回不来**
   * （2026-10-05 实测：三个假人死活上不去，唯一的解是重启后端让状态重建）。
   *
   * 调用时机：接入端**重新挂上连接**时（`bridge.js` 的 `attachAlive`）。
   * ⚠️ 凭什么叫这算"人点的连接"：同份规范 line 216 ——「接入端**不得"断了自己连回来"**，
   *    **插件侧已改到位**（2026-10-04 起不再自动重连、也没有重挂）」⇒ 新挂上来的连接只可能是人点的。
   *
   * ⚠️ **只清记号、不动 `presence`**：它仍然是**离线**，要再点一次「上线」才算在线 ——
   *    那正是规范说的两步（先「连接」、再「上线」）。
   * @returns {boolean} 真的清掉了才回 true（没这个记号就不动，免得把别的档位搅了）
   */
  function clearDisconnectMark(memberId) {
    if (!isStateable(memberId)) return false;
    const st = states.get(memberId);
    if (!st) return false;
    if (st.offlineReason !== OFFLINE_REASON.DISCONNECT) return false;
    st.offlineReason = null;
    return true;
  }

  return {
    receiveHeartbeat,
    sweepOffline,
    clearDisconnectMark,
    kickMember,
    disconnect,
    setDisconnectNotify,
    setPresence,
    callOnline,
    setBusyByBoss,
    currentBusy,
    canAssign,
    listMembers,
    offlineReasonOf,
    setMembers,
    getMembers,
    setConfig,
  };
}

// 默认实例：用 M1 数据层（生产路径）
const status = createStatus(dataLayer);

module.exports = {
  createStatus,
  PRESENCE,
  BUSY,
  OFFLINE_REASON,
  receiveHeartbeat: status.receiveHeartbeat,
  sweepOffline: status.sweepOffline,
  kickMember: status.kickMember,
  disconnect: status.disconnect,
  setDisconnectNotify: status.setDisconnectNotify,
  setPresence: status.setPresence,
  callOnline: status.callOnline,
  setBusyByBoss: status.setBusyByBoss,
  currentBusy: status.currentBusy,
  canAssign: status.canAssign,
  listMembers: status.listMembers,
  offlineReasonOf: status.offlineReasonOf,
  clearDisconnectMark: status.clearDisconnectMark,
  setMembers: status.setMembers,
  getMembers: status.getMembers,
  setConfig: status.setConfig,
};

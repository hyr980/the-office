'use strict';

/**
 * M2 · 信封与校验 —— 消息合法性总闸（服务端唯一大门）
 *
 * 依据：
 *   - 模块\M2-信封与校验.md
 *   - 规范\01-信封-草案v1-20261002.md §2 / §3 / §4 / §5 / §5.1
 *
 * 分工：validate 判断"一条消息合不合法"（九条拒收 + 收发授权 §5.1 C）；
 *       receive = validate + 幂等静默丢弃 + 记账 + 顺带记状态（§5.1 C）；
 *       checkOver = 报 over 的前置校验（§5 第 8 条）。
 * 约束：零第三方依赖；不改 M1 的代码与数据结构，只复用 data-layer 导出接口。
 */

const dataLayer = require('./data-layer');

const { readMessages, listTasks, getTask, appendMessage, setSubtaskState } = dataLayer;

/** type 五档（01 §3） */
const KNOWN_TYPES = ['chat.message', 'task.assign', 'task.ack', 'task.status', 'task.deliver'];

/** 六个必填（01 §2） */
const REQUIRED_FIELDS = ['id', 'source', 'specversion', 'type', 'to', 'data'];

/** 未知 type 的"路由含义"前缀：task.* 影响路由/权限/状态机（01 §5 第 4 条） */
const ROUTING_TYPE_PREFIX = 'task.';

/** 全体收件人（01 §2：@all ＝ 全体） */
const ALL = '@all';

/** 老大（01 §5.1 E：老大算成员）—— @all 只有他能发（§5 第 11 条） */
const BOSS = 'boss';

/**
 * 造一个信封校验器实例（数据层可注入：默认用 M1 数据层；自验/测试可注入隔离副本）
 */
function createEnvelope(dl, deps = {}) {
  // ⭐ 2026-10-05 加：**派发准入**要查「在线 ＋ 忙闲」（正本 `流程\02` §5.2）⇒ 需要状态模块。
  //    ⚠️ 由**默认实例**注入（见文件末尾）；自验／测试用 `createEnvelope(隔离副本)` 时**不带**
  //    ⇒ 那一路不查（全隔离脚本照旧 —— 它们本来就是绕开生产校验、单测内部逻辑的）。
  const statusInst = deps.status || null;
  // 已知成员集合：boss 算成员（01 §5.1 E）；M5 完成后由成员模块注入
  let members = ['boss'];

  function setMembers(ids) {
    members = Array.isArray(ids) ? [...new Set(ids)] : [];
  }
  function getMembers() {
    return [...members];
  }

  /** 信封内容是否完全相同（幂等判据用；seq 是服务端追加的，不比） */
  function envelopeEquals(a, b) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'seq');
    for (const k of keys) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
    }
    return true;
  }

  function arraysEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((x, i) => x === sb[i]);
  }

  /** 账本里同 source+id 的记录（幂等判据，01 §4） */
  function findByIdentity(msg) {
    const board = dl.readMessages();
    return board.find((m) => m.source === msg.source && m.id === msg.id) || null;
  }

  /** 打回判据：task.assign 的 inreplyto 指向一条 task.deliver（01 §5 第 5 条） */
  function findReworkRef(msg, board) {
    if (msg.type !== 'task.assign' || !msg.inreplyto) return null;
    return board.find((m) => m.id === msg.inreplyto && m.type === 'task.deliver') || null;
  }

  /** 按子任务 id 找"派那一包的人"（账本里最后一条含该子任务的 task.assign 的 source） */
  function findAssignerOfSub(subId, board) {
    if (!subId) return null;
    let last = null;
    for (const m of board) {
      if (m.type !== 'task.assign' || !m.data || !Array.isArray(m.data.subtasks)) continue;
      if (m.data.subtasks.some((s) => s && s.id === subId)) last = m;
    }
    return last ? last.source : null;
  }

  /** 按子任务 id 找"那一件是谁交的"（最后一条 task.deliver 的 source） */
  function findDelivererOfSub(subId, board) {
    if (!subId) return null;
    let last = null;
    for (const m of board) {
      if (m.type !== 'task.deliver' || !m.data || m.data.task !== subId) continue;
      last = m;
    }
    return last ? last.source : null;
  }

  /**
   * §5 第 12 条：**这几条的收件人由系统推**（老大 2026-10-04：「这个要靠系统去判定不能靠执行者自己填」）
   * ⇒ AI 填的 `to` 只当核对，填错当场拒。
   *   接（`task.ack`）                ⇒ 那条派发 `task.assign` 的 source
   *   收到交付的收条（`task.ack`）     ⇒ 那条交付 `task.deliver` 的 source（靠 `inreplyto` 认）
   *   收到验收结果的收条（`task.ack`） ⇒ 那条验收 `task.status` 的 source（靠 `inreplyto` 认）
   *   验收通过（`task.status: done`）  ⇒ 那条交付 `task.deliver` 的 source
   *   交付（`task.deliver`）           ⇒ 那条派发 `task.assign` 的 source
   *   打回（`task.assign` + `inreplyto`）⇒ 第 5 条已单列，这里不管
   * @returns {string[]|null} 推得出的合法收件人；推不出（账本不全）⇒ null ＝ 本条不拦
   */
  function legalRecipients(msg, board) {
    const subId = msg.data && msg.data.task;
    if (msg.type === 'task.deliver') {
      const a = findAssignerOfSub(subId, board);
      return a ? [a] : null;
    }
    if (msg.type === 'task.status' && msg.data && msg.data.state === 'done') {
      const d = findDelivererOfSub(subId, board);
      return d ? [d] : null;
    }
    if (msg.type === 'task.ack') {
      if (msg.inreplyto) {
        const ref = board.find(
          (m) => m.id === msg.inreplyto && (m.type === 'task.deliver' || m.type === 'task.status')
        );
        if (ref) return [ref.source];
      }
      const a = findAssignerOfSub(subId, board);
      return a ? [a] : null;
    }
    return null;
  }

  /**
   * 打回次数 = 账本里「inreplyto 指向这一件子任务某次交付」的 task.assign 条数。
   * ⚠️ **轮次**（"这件任务跑了几轮"）＝ 本数 + 1；**不是**"换过几个人"（那个＝ tried 名单长度 + 1）。
   *    ① 换人（tried.length + 1）与 ② 轮次（打回次数 + 1）是两个量，别混 —— 口径见
   *    `log.js` 顶部注释、`03-状态机制.md` §3.1、交付包 `待改事项-20261003.md` 第三条。
   */
  function countRework(board, subId) {
    if (!subId) return 0;
    let n = 0;
    for (const m of board) {
      if (m.type !== 'task.assign' || !m.inreplyto) continue;
      const ref = board.find((x) => x.id === m.inreplyto && x.type === 'task.deliver');
      if (ref && ref.data && ref.data.task === subId) n++;
    }
    return n;
  }

  /** 目标成员是否处于 awaiting（交了、等验收：任务表里有 delivered 且未收口的子任务派给他） */
  function isAwaiting(memberId) {
    return dl.listTasks().some(
      (t) => !t.closed && t.subtasks.some((st) => st.to === memberId && st.state === 'delivered')
    );
  }

  /** 按子任务 id 找（任务表） */
  function findSubtask(subId) {
    for (const t of dl.listTasks()) {
      const st = t.subtasks.find((s) => s.id === subId);
      if (st) return { task: t, subtask: st };
    }
    return null;
  }

  /** 派发者 = 账本里发那一包（data.task = 主任务 id 的 task.assign）的人（01 §5.1 C） */
  function findAssigner(mainTaskId) {
    const assignMsg = dl.readMessages().find(
      (m) => m.type === 'task.assign' && m.data && m.data.task === mainTaskId
    );
    return assignMsg ? assignMsg.source : null;
  }

  /**
   * 一条消息合不合法（跨块约定接口，别改名）
   * @param {object} msg 01 §2 字段表的一条消息
   * @returns {{ok:true, duplicate?:boolean} | {ok:false, reason:string, notify:string}}
   */
  function validate(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return { ok: false, reason: '信封必须是对象', notify: '消息必须是对象' };
    }

    // 1) 六个必填缺任何一个（01 §5 第 1 条）
    for (const f of REQUIRED_FIELDS) {
      if (msg[f] === undefined || msg[f] === null || msg[f] === '') {
        return { ok: false, reason: `信封缺必填字段: ${f}`, notify: `消息缺必填字段 ${f}` };
      }
    }

    // 2) to 里出现不存在的成员（01 §5 第 2 条；boss 算成员 §5.1 E；@all ＝ 全体 §2）
    if (!Array.isArray(msg.to)) {
      return { ok: false, reason: 'to 必须是数组', notify: 'to 必须是数组' };
    }
    for (const m of msg.to) {
      if (m !== ALL && !members.includes(m)) {
        return { ok: false, reason: `收件人不存在: ${m}`, notify: `收件人不存在: ${m}` };
      }
    }

    // 2b) ⭐ @all 只有老大能发（01 §5 第 11 条；老大 2026-10-04：「首先是我才能@all」）
    if (msg.to.includes(ALL) && msg.source !== BOSS) {
      return {
        ok: false,
        reason: `@all 只有老大（${BOSS}）能发，${msg.source} 不行，已拒收`,
        notify: '仅派发者可 @全体',
      };
    }

    // 3) 幂等：source+id 一起唯一（01 §4 / §5 第 3 条）
    const dup = findByIdentity(msg);
    if (dup) {
      if (envelopeEquals(dup, msg)) {
        return { ok: true, duplicate: true, reason: '完全重复，当成同一条，不重复记账' };
      }
      return {
        ok: false,
        reason: `source+id 撞已有记录且内容不同（${msg.source}/${msg.id}），已拒收`,
        notify: `source+id 已存在但内容不同（${msg.source}/${msg.id}），疑似冒充他人 id，拒收`,
      };
    }

    // 4) 不认识 type：影响路由/权限/状态机 ⇒ 拒；纯附带 ⇒ 放行（01 §5 第 4 条）
    if (!KNOWN_TYPES.includes(msg.type)) {
      if (typeof msg.type === 'string' && msg.type.startsWith(ROUTING_TYPE_PREFIX)) {
        return {
          ok: false,
          reason: `不认识 type ${msg.type}，且影响路由/权限/状态机，已拒收`,
          notify: `不认识的消息类型 ${msg.type}`,
        };
      }
      // 其它不认识 type：放行（纯附带）
    }

    const board = dl.readMessages();

    // 4b) ⭐ §5 第 12 条：这几条的收件人由系统推，AI 填的只当核对（填错 ⇒ 拒）
    const legalTo = legalRecipients(msg, board);
    if (legalTo && !arraysEqual(msg.to, legalTo)) {
      return {
        ok: false,
        reason: `收件人由系统推：这条应发给 ${legalTo.join('、')}（填的是 ${msg.to.join('、') || '空'}），已拒收`,
        notify: `这条应发给 ${legalTo.join('、')}`,
      };
    }

    // 5) 打回的目标不许 AI 挑（01 §5 第 5 条）：合法收件人由系统从那条交付的 source 取
    const reworkRef = findReworkRef(msg, board);
    if (msg.type === 'task.assign' && reworkRef) {
      const legalTo = [reworkRef.source];
      if (!arraysEqual(msg.to, legalTo)) {
        return {
          ok: false,
          reason: `打回只能发给原执行者 ${reworkRef.source}`,
          notify: `打回只能发给原执行者 ${reworkRef.source}`,
        };
      }
      // 5b) 打回不新起号（规范 01-信封.md:166，2026-10-03 补）：子任务 id 必须沿用上次交付报的那个。
      // 依据：第 8 条（最多 3 轮）拿这个 id 当计数基准；换号能过的话，计数链就断 ⇒ 可无限打回。
      const keepId = reworkRef.data && reworkRef.data.task;
      const ids = (msg.data && Array.isArray(msg.data.subtasks)) ? msg.data.subtasks.map((s) => s && s.id) : [];
      if (keepId && !(ids.length === 1 && ids[0] === keepId)) {
        return {
          ok: false,
          reason: `打回不新起号：子任务 id 要沿用原号 ${keepId}（这条里写的是 ${ids.map((x) => x || '空').join('、') || '空'}）`,
          notify: `打回的是同一件任务，子任务 id 要沿用原号 ${keepId}`,
        };
      }
    }

    // 6) awaiting（交了、等验收）的人谁都不能派新任务（01 §5 第 6 条）
    if (msg.type === 'task.assign') {
      for (const m of msg.to) {
        if (!isAwaiting(m)) continue;
        const okRework = reworkRef && reworkRef.source === m;
        if (!okRework) {
          return {
            ok: false,
            reason: `${m} 正在等验收（awaiting），不能派新任务，已拒收`,
            notify: `${m} 正在等验收，不能给该成员派新任务`,
          };
        }
      }
    }

    // 6b) ⭐ 2026-10-05 加：**派发准入 —— 当场查「在线 ＋ 忙闲」**（正本 `流程\02` §5.2）
    //     规范原话：「派发｜校验一 在线｜校验二 忙闲｜未通过 ⇒ 服务端**拒绝**，回「不在线」／「忙」
    //     —— **当场可知，不排队、不悬空**」，且「**两道校验同等严格**，不存在『离线也能收任务、
    //     等它上线再说』的情形」。
    //     ⚠️ 原来**主派发路径这两道一道都没查**（只有重派那条路调 `canAssign`）⇒ 派给不在线的人
    //     ⇒ 系统照收 ⇒ 要等满 5 分钟表态窗口才判异常 ⇒ **白烧一轮**。
    //     ⚠️ **打回不走这道**（§5.3：打回是同一件任务的下一轮）；新建主任务与补派都走。
    //     ⚠️ 缺 `to` 的项交给下面第 7／9 条与建任务那步兜（这里不抢它们的任务）。
    if (
      msg.type === 'task.assign' &&
      !reworkRef &&
      msg.data && Array.isArray(msg.data.subtasks) &&
      statusInst && typeof statusInst.canAssign === 'function'
    ) {
      // ⚠️ 只查**状态机认得**的成员：「这个人存不存在」归上面第 2 条管（两条各管各的，
      //    别越界 —— 各脚本／调用方可以只给 envelope 灌成员表、不给状态机灌，
      //    那种情形下这里必须让路，否则会把"信封认得、状态机还没见过"的人误判成不可派）。
      const known = typeof statusInst.getMembers === 'function' ? statusInst.getMembers() : null;
      // ⚠️ **通知回声不算新决策**：重派那条路是**先写任务表、后补发派发消息**（`bridge.reassign`）
      //    ⇒ 走到这里时那件**已经挂在目标名下**、目标**已经是"忙"** —— 再查一遍忙闲只会把
      //    那条通知当场拒掉（2026-10-05 实测撞到：M8 第 7a 条，`reassign` 回了
      //    "换人已生效，但派发消息没发出去"）。重派本身早已在 `timeout.assignRetry` 里
      //    查过 `canAssign` ⇒ 这里只认"**这件还没落在这个人身上**"的派发。
      const cur = msg.data.task ? dl.getTask(msg.data.task) : null;
      for (const sub of msg.data.subtasks) {
        if (!sub || !sub.to) continue;
        if (known && !known.includes(sub.to)) continue;
        if (cur && Array.isArray(cur.subtasks)) {
          const already = cur.subtasks.find((s) => s.id === sub.id);
          if (already && already.to === sub.to) continue;
        }
        const can = statusInst.canAssign(sub.to, msg.source);
        if (!can.ok) {
          return {
            ok: false,
            reason: `派发被拒：${can.reason}`,
            notify: can.reason,
          };
        }
      }
    }

    // 7) 已有主任务在跑 ⇒ 新建主任务的请求直接拒（01 §5 第 7 条）
    if (
      msg.type === 'task.assign' &&
      msg.data && msg.data.task &&
      Array.isArray(msg.data.subtasks) && msg.data.subtasks.length > 0
    ) {
      const mainId = msg.data.task;
      if (!dl.getTask(mainId)) {
        // 这是"建任务那条"：任务表里已有未收口主任务 ⇒ 直接拒，不等 over
        const active = dl.listTasks().find((t) => !t.closed);
        if (active) {
          return {
            ok: false,
            reason: `已有主任务在跑（${active.id}），已拒收`,
            notify: '当前已有任务',
          };
        }
      }
      // mainId 已存在 ⇒ 打回/补派，不是新建主任务，本条不拦
    }

    // 8) 同一件子任务最多 3 轮（01 §5 第 10 条；老大 2026-10-03 定）：已打回 2 次的，第 3 次打回拒收
    if (msg.type === 'task.assign' && reworkRef) {
      const subId = reworkRef.data && reworkRef.data.task;
      if (subId) {
        const reworkCount = countRework(board, subId);
        if (reworkCount >= 2) {
          return {
            ok: false,
            reason: `max-rounds:${subId}:子任务 ${subId} 已打回 ${reworkCount} 次，第 3 次打回，已拒收（最多 3 轮）`,
            notify: '这件已进入第 3 轮，换人重派',
          };
        }
      }
    }

    // 10) ⭐ 时限必须是**正数**（分钟）—— 2026-10-04 加（老大令：判断都我来）：
    //     后端登记计时器是 `typeof st.timeout === 'number' && st.timeout > 0`（`timeout.js:245`），
    //     填成字符串 ⇒【静默不登记】⇒ 那件**永远不判超时**：不换人重派、不兜底、**也不插话**（实测踩到）。
    //     规范 §0 第 3 条「填错当场拒」⇒ 就在这儿拒，并把"该填什么"说清楚。
    if (msg.type === 'task.assign' && msg.data && Array.isArray(msg.data.subtasks)) {
      for (const st of msg.data.subtasks) {
        if (!st) continue;
        if (typeof st.timeout !== 'number' || !(st.timeout > 0)) {
          return {
            ok: false,
            reason: `子任务 ${st.id || '?'} 的 timeout 必须是正数（单位＝分钟），实收 ${typeof st.timeout}: ${JSON.stringify(st.timeout)}，已拒收`,
            notify: '「限时」须填数字（分钟），如 30；文字或空值都不接受',
          };
        }
      }
    }

    // 9) 一批任务里同一个 to 出现两次（01 §5 第 9 条）
    if (msg.type === 'task.assign' && msg.data && Array.isArray(msg.data.subtasks)) {
      const seen = new Set();
      for (const st of msg.data.subtasks) {
        if (!st || !st.to) continue;
        if (seen.has(st.to)) {
          return {
            ok: false,
            reason: `一批任务里同一个 to 出现两次（${st.to}），已拒收`,
            notify: '一个人一次只能接一件',
          };
        }
        seen.add(st.to);
      }
    }

    // §5.1 C 谁有权发哪个 state
    if (msg.type === 'task.status' && msg.data && msg.data.state) {
      const state = msg.data.state;
      const found = findSubtask(msg.data.task);
      if (!found) {
        return {
          ok: false,
          reason: `子任务不存在: ${msg.data.task}`,
          notify: `子任务不存在: ${msg.data.task}`,
        };
      }
      const { task, subtask } = found;
      if (state === 'blocked') {
        // blocked ⇒ 执行者发
        if (msg.source !== subtask.to) {
          return {
            ok: false,
            reason: `blocked 只有执行者（${subtask.to}）能发`,
            notify: `blocked 只有执行者（${subtask.to}）能发`,
          };
        }
      } else if (state === 'done') {
        // done ⇒ 派发者发。⭐ 例外：**老大派的任务**，交付后没人验收、时间到 ⇒ 系统**代他**发"验收通过"
        // （2026-10-04 定；见 `时限\01` §二 / `04` §7.6）—— 系统用固定 id `system`，不冒充成员（`01` §2）。
        const assigner = findAssigner(task.id);
        // ⭐ 系统代派发者发"验收通过"：两条线都要（① 老大派的任务：交付即自动验收；
        //    ② 派发者挂了：5 分钟到、系统自动判通过）⇒ 允许 `source=system` 发这一档。
        //    ⚠️ 成员冒充不了：`send_message` 工具要求 `msg.source` ≡ 调用者。
        const systemDone = msg.source === 'system';
        if (msg.source !== assigner && !systemDone) {
          return {
            ok: false,
            reason: `done 只有派发者（${assigner}）能发`,
            notify: `done 只有派发者（${assigner}）能发`,
          };
        }
      } else if (state === 'cancelled') {
        // cancelled ⇒ 只有系统能标，成员发不出这一档
        if (msg.source !== 'system') {
          return {
            ok: false,
            reason: 'cancelled 只有系统能标，成员发不出这一档',
            notify: 'cancelled 只有系统能标',
          };
        }
      } else {
        // working / delivered ⇒ 系统自己记（随 task.ack / task.deliver 自动记），成员发不出
        if (msg.source !== 'system') {
          return {
            ok: false,
            reason: `state ${state} 由系统自动记，成员发不出`,
            notify: `state ${state} 由系统自动记，成员发不出`,
          };
        }
      }
    }

    return { ok: true, duplicate: false };
  }

  /**
   * 收消息（服务端入口）：校验 + 幂等 + 记账 + 顺带记状态（§5.1 C）
   * @returns {{ok:true, seq?:number, duplicate?:boolean} | {ok:false, reason:string, notify:string}}
   */
  function receive(msg) {
    const v = validate(msg);
    if (!v.ok) return v;
    if (v.duplicate) {
      // 完全重复：当成同一条，静默丢弃、不报错、不重复记账
      return { ok: true, duplicate: true, reason: '重复消息（source+id），静默丢弃，不重复记账' };
    }
    // ⭐ 派发消息由系统挂上「接／不接」选项（老大 2026-10-03 定；01 §3）——
    //   不指望派发者自己写（01 §5 第 7 条"甲方的自律不替代系统的校验"）；
    //   入账前挂上 ⇒ 收件人（唤醒时收到的）和事后读收件箱看到的是同一份。
    if (msg.type === 'task.assign') {
      if (!msg.data || typeof msg.data !== 'object') msg.data = {};
      if (!msg.data.ask) {
        msg.data.ask = {
          by: 'system',
          choices: ['接', '不接'],
          hint: '必须选一个：接，则回一条 task.ack（忙闲由办公室按账本自动判定，不用你改、你也改不了）；不接，则用工具调用 refuse。五分钟内不作回应将判为异常。',
        };
      }
    }

    // ⭐ 2026-10-05 改（代码审查第 3 条）：**建任务挪到入账之前，建不出来就当场拒收**。
    //    原来建任务排在入账**之后**，而且失败被空 `catch` 吞掉 ⇒ 能造出"账本里有这条派发、
    //    任务表里却没有这张卡"的幽灵主任务：① 门口的"一次只跑一包"是按任务表判的 ⇒ **形同虚设**；
    //    ② 执行者接着回「收到」／交付时 `findSubtask` 永远找不到 ⇒ 状态落不下、`over` 报不了、白干一轮。
    //    `validate` 拦不到的那几条（子任务缺 `to`、id 前缀不对、清单为空）由这里兜住 —— **拒收要说得出理由**。
    if (msg.type === 'task.assign' && msg.data && msg.data.task && !msg.inreplyto) {
      const exist = dl.getTask(msg.data.task);
      if (!exist) {
        try {
          dl.createTask({
            id: msg.data.task,
            title: msg.data.title,
            note: msg.data.note,
            subtasks: msg.data.subtasks,
          });
        } catch (e) {
          const why = (e && e.message) || String(e);
          return { ok: false, reason: `建任务失败，已拒收收这条派发：${why}`, notify: '任务清单不齐或不合规' };
        }
      } else {
        // ⭐⭐ 2026-10-05 加：**补派** —— 往**已有**主任务追加子任务（正本＝规范 `流程\02` §5.7）。
        //    原来这里**什么都不做** ⇒ 消息进了账本、任务表里却没有那件 ⇒ 执行者一回「收到」就被
        //    "子任务不存在"拒掉（白烧一轮）；顺带还**绕过了**「换人重派必须派发者本人发起」那道校验。
        //    ⚠️ **换人重派的"通知回声"也走这一支**：那条通知是"先写任务表、后补发消息"
        //       （`bridge.reassign` → `timeout.assignRetry` 里已经 `appendSubtask` 过）
        //       ⇒ 走到这里时那件**已经在表里** ⇒ 下面按 id 跳过（幂等），一个字都不改。
        const assigner = findAssigner(msg.data.task);
        if (assigner && msg.source !== assigner) {
          return {
            ok: false,
            reason: `补派只有这包的派发者（${assigner}）能发，${msg.source} 不行，已拒收`,
            notify: '只有派发者能往这件主任务里补任务',
          };
        }
        const rows = Array.isArray(msg.data.subtasks) ? msg.data.subtasks : [];
        const seen = new Set();
        for (const st of rows) {
          if (!st || !st.id || seen.has(st.id)) continue;
          seen.add(st.id);
          if (exist.subtasks.some((s) => s.id === st.id)) continue;   // 幂等：表里已有 ⇒ 跳过
          if (!st.to) {
            return { ok: false, reason: `补派的那件 ${st.id} 缺 to（派给谁），已拒收`, notify: '补派的那件得写上派给谁' };
          }
          try {
            dl.appendSubtask(msg.data.task, {
              id: st.id, to: st.to, timeout: st.timeout, heavy: st.heavy, note: st.note,
            });
          } catch (e) {
            return {
              ok: false,
              reason: `补派失败，已拒收收：${(e && e.message) || String(e)}`,
              notify: '补派的那件不合规（id 前缀／重复／字段）',
            };
          }
        }
      }
    }

    const { seq } = dl.appendMessage(msg);

    // ⭐ 2026-10-05 加：**打回 ⇒ 那件当场退回「从未表态」**（规范 `流程\01` §4："退回 ＝ 再派一次"）
    //    原来代码做不到：`task.ack` 只在 `state === null` 时才记 `working`，而打回时那件是 `delivered`
    //    （甚至 `done`）⇒ **回不到 `working`** ⇒ 任务表一直在说假话（显示"已交付待验收"，实际在重做）。
    //    ⇒ 在这里退回初始：执行者再回「收到」就自然变 `working`，链子一次顺到底。
    if (msg.type === 'task.assign' && msg.inreplyto) {
      const rw = findReworkRef(msg, dl.readMessages());
      if (rw) {
        const rwSub = rw.data && rw.data.task;
        const rwMain = (msg.data && msg.data.task) || (rwSub ? rwSub.slice(0, rwSub.lastIndexOf('-')) : null);
        if (rwSub && rwMain) {
          try { dl.setSubtaskState(rwMain, rwSub, null); } catch (_) { /* 退不回不阻塞入账 */ }
        }
      }
    }

    // ⚠️ 2026-10-05 挪走了：原来这里（入账**之后**）还有一段"顺带建任务"，失败被空 `catch` 吞掉
    //    ⇒ 幽灵主任务。现在整段**提前到入账之前**、且建不出来就直接拒收（见上面那段注释）。

    // 顺带记状态：task.ack ⇒ working（仅未定档时，不能覆盖 delivered/done）；task.deliver ⇒ delivered
    if ((msg.type === 'task.ack' || msg.type === 'task.deliver') && msg.data && msg.data.task) {
      const found = findSubtask(msg.data.task);
      if (found) {
        try {
          if (msg.type === 'task.deliver') {
            // ⚠️ 2026-10-04 修：**不许覆盖终态**（`done` ／ `cancelled`）。
            //    实测撞到（M10 第 5 条那次）：一件 `12:28:51` 已被**超时判 `cancelled`** 的任务，
            //    执行者**后来才交**（它压根不知道已经换人重派了）⇒ 这里把它又翻回 `delivered`
            //    ⇒ ① 终态被翻回来 ② 那份产出其实是**废的** ③ 收口要求"子任务全部到终态"
            //    ⇒ **这包永远收不了口**。
            //    （`task.ack` 那边本来就有防护 —— 见下面那个分支：只在 `state === null` 时记。）
            const cur = found.subtask.state;
            if (cur !== 'done' && cur !== 'cancelled') {
              dl.setSubtaskState(found.task.id, msg.data.task, 'delivered');
            }
          } else if (found.subtask.state === null) {
            dl.setSubtaskState(found.task.id, msg.data.task, 'working');
          }
        } catch (_) { /* 状态记不上不阻塞消息入账 */ }
      }
    }
    return { ok: true, seq };
  }

  /**
   * 报 over 的前置校验（01 §5 第 8 条）
   * @param {string} taskId 主任务 id
   * @returns {{ok:true} | {ok:false, reason:string, notify:string}}
   */
  function checkOver(taskId) {
    const task = dl.getTask(taskId);
    if (!task) {
      return { ok: false, reason: `任务不存在: ${taskId}`, notify: `任务不存在: ${taskId}` };
    }
    const undone = task.subtasks.filter((s) => s.state !== 'done' && s.state !== 'cancelled');   // ⭐ cancelled 也是终态（2026-10-04 修：超时换人后旧件是 cancelled，原来会永久挡住 over）
    if (undone.length > 0) {
      return {
        ok: false,
        reason: `报 over 时还有子任务没完（${undone.map((s) => s.id).join(', ')}），已拒收`,
        notify: '还有子任务没完',
      };
    }
    return { ok: true };
  }

  return { validate, receive, checkOver, setMembers, getMembers, countRework };
}

// 默认实例：用 M1 数据层（生产路径）＋ 状态模块（派发准入要查在线／忙闲，`流程\02` §5.2）
const envelope = createEnvelope(dataLayer, { status: require('./status') });

module.exports = {
  createEnvelope,
  KNOWN_TYPES,
  ALL,
  validate: envelope.validate,
  receive: envelope.receive,
  checkOver: envelope.checkOver,
  setMembers: envelope.setMembers,
  getMembers: envelope.getMembers,
  countRework: envelope.countRework,
};

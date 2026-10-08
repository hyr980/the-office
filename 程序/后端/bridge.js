'use strict';

/**
 * M8 · 对外接口 —— 桥主模块（成员↔会话映射 + "该叫谁" + 统一工具分发）
 *
 * 依据：
 *   - 规范\接入\01-接入与连接.md §5.1（★ 唤醒正本：**只看 `to`**）
 *   - 规范\接入\02-插件职责.md（★ 推过去的是「唤醒 ＋ 让它进来看」这条命令，**不是正文**）
 *   - 规范\08-落地结构.md §四（多口接入：口只是通道，不是第二间办公室）
 *
 * 分工（跨块约定接口，别改名）：
 *   registerSession(memberId, sessionId)  成员报到时登记/更新会话 id（成员↔会话映射）
 *   deliver(msg)                          算出"该叫谁"（⚠️ 只看 `to`，**不看消息类型**）
 *   startMcpStdio()                       stdio MCP 那一口（阻塞到 stdin EOF）
 *   startHttp(port)                       HTTP 那一口（默认 8787）
 *
 * 关键口径（2026-10-04 改，别照旧代码写）：
 *   - ⭐ **唤醒只看 `to`**：`to` 里写了谁就叫谁（派发／交付／验收／聊天一律一样）；
 *     `@all` ⇒ 叫全体（只有老大能发，由信封那道校验拦）；`[]` ⇒ 谁也不叫（消息照旧进账本）；
 *   - ⭐ **推给插件的是「唤醒 ＋ 让它进来看」这条命令，不是消息正文** ⇒ 插件把人叫起来，
 *     内容它自己进来看（读任务表／账本）、看完再填表；
 *   - ⚠️ **"收件箱"整个模型已删**（2026-10-04）⇒ 没有"未读消息"这一层、也没有游标；
 *     消息一律实时送。⚠️ `deliver()` 回话里的 `delivered`/`silent` 是"该叫谁"的账，
 *     **不是"叫没叫"的事实** —— 实际叫醒一律以插件为准（规范 `接入\01` §5.2）；
 *   - 叫醒／插话由**办公室按插件报的"门牌号"主动推**给插件（HTTP），插件再送到它绑定的那个会话。
 *
 * 约束：零第三方依赖（推送用 node 内置 fetch）；不改 M1~M7 的代码与接口。
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
// ⭐ 2026-10-05 加：探活要算 sha256（接入校验·第 2 刀；正本＝规范 `接入\01` §2.4「探活」）
const crypto = require('crypto');

const dataLayer = require('./data-layer');
const envelopeModule = require('./envelope');
const statusModule = require('./status');
const membersModule = require('./members');
const dirsModule = require('./dirs');
const logModule = require('./log');
const timeoutModule = require('./timeout');

const { TASK_STATES } = dataLayer;

/** 默认 HTTP 端口（规范 08 §四：8787；说明书：地址和端口写进 README 让对接方自己填） */
const DEFAULT_HTTP_PORT = 8787;

/** 防重 Set 上限：只留最近 N 条已叫过的记录（防无限增长） */
const DELIVERED_RECENT_LIMIT = 2000;

/** 全体收件人（01 §2：@all ＝ 全体）；常量从 envelope 取（一条只写一处，别在桥里重抄字面量） */
const ALL_RECIPIENT = envelopeModule.ALL;

/** ⭐ 2026-10-04：「浏览…」那个"选择文件夹"窗口**同时只许开一个**（连点两下别叠出两个框来） */
let pickingFolder = false;

/**
 * 推给插件的两条命令（办公室 → 插件；**插件侧要实现的端点**）。
 * ⚠️ 契约（2026-10-04 由代码侧定，插件实现要同步）：插件在宿主 webServer 上监听这两个端点，
 *    办公室按成员卡里的"门牌号"（`host:port`）POST 过去。
 *   - 唤醒 `/dsh-office/wake`：`{"memberId":"…","reason":"message"}` ⇒ 插件把那个会话叫起来、**让它进来看**；
 *   - 插话 `/dsh-office/interrupt`：`{"memberId":"…","text":"时间到了，请停"}` ⇒ 插件往那个会话插一句。
 * 依据：`接入\01` §4／§5.1、`接入\02` §1 第 3／4 件。
 */
const PLUGIN_WAKE_PATH = '/dsh-office/wake';
const PLUGIN_INTERRUPT_PATH = '/dsh-office/interrupt';
// ⭐ 人在**办公室成员卡**上点「叫它上线」⇒ 办公室要敲插件这个口让它认岗（正本 `接入\01` §2.4）
const PLUGIN_ONLINE_PATH = '/dsh-office/online';
// ⭐ 人在**办公室成员卡**上点「连接／断开」⇒ 办公室敲插件这个口，让它去挂流／掐流（第一层，`接入\01` §2.4）
const PLUGIN_CONNECT_PATH = '/dsh-office/connect';
/** ⭐ 2026-10-05 加：**探活**（办公室往门牌号推随机数、接入端算应答；正本＝规范 `接入\01` §2.4「探活」）。 */
const PLUGIN_CHALLENGE_PATH = '/dsh-office/challenge';

/** 本地秒串 YYYYMMDDHHMMSS（与 M1 同格式） */
function stampNow(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 造一个桥实例（依赖可注入：默认用 M1~M7 生产实例；自验/测试可注入隔离副本）
 * @param {object} [opts]
 *   dl          M1 数据层（默认 data-layer）
 *   envelope    M2 信封（默认 envelope 默认实例）
 *   status      M3 状态机（默认 status 默认实例）
 *   members     M5 成员卡（默认 members 默认实例）
 *   timeout     M4 时限（默认 timeout 默认实例；未启用时 refuse/ack_refuse_dead 返回未启用）
 *   log         M7 日志（默认 log 默认实例）
 *   dirs        M6 目录（默认 dirs 默认实例）
 *   stateFile   桥状态文件（游标/防重落盘；默认 <数据>\bridge-state.json）
 *   sessionSender  投递器 async (sessionId, item) => void；默认不实发（由宿主/壳注入），仅记录
 *   config      { wakeBudget?:number }
 */
function createBridge(opts) {
  const o = opts || {};
  const dl = o.dl || dataLayer;
  const envelope = o.envelope || envelopeModule;
  const status = o.status || statusModule;
  const members = o.members || membersModule;
  const timeout = o.timeout || timeoutModule;
  const log = o.log || logModule;
  const dirs = o.dirs || dirsModule;

  const stateFile = o.stateFile || path.join(dl.DATA_DIR, 'bridge-state.json');
  const config = {
    pushTimeoutMs: (o.config && o.config.pushTimeoutMs != null) ? o.config.pushTimeoutMs : 3000,
  };

  // ── 会话映射：memberId → sessionId（内存态；重启后成员重新报到即重建） ──
  const sessions = new Map();

  // ── 防重（内存态）：最近叫过的固定 message id → 账本 seq（防同一条被叫两遍） ──
  const deliveredRecent = new Map();

  // ── 叫醒记录（自验/监控用）：最近 N 条"该叫谁" ──
  const deliveryLog = [];

  // ── 心跳定时器（startMcpStdio / startHttp 共享） ──
  let ticker = null;

  /** 落盘桥状态（只留最近防重记录；裁剪防无限增长） */
  function saveState() {
    const trimmed = new Map();
    const keys = [...deliveredRecent.keys()];
    const from = Math.max(0, keys.length - DELIVERED_RECENT_LIMIT);
    for (let i = from; i < keys.length; i++) {
      const k = keys[i];
      trimmed.set(k, deliveredRecent.get(k));
    }
    deliveredRecent.clear();
    for (const [k, v] of trimmed) deliveredRecent.set(k, v);
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        savedAt: stampNow(),
        delivered: Object.fromEntries(deliveredRecent),
      }, null, 2), 'utf8');
    } catch (_) { /* 状态落盘失败不阻塞消息（下次再试） */ }
  }

  /** 加载桥状态（只剩防重记录；游标随"收件箱"一起删掉了） */
  function loadState() {
    deliveredRecent.clear();
    if (!fs.existsSync(stateFile)) return;
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (s && s.delivered) {
        for (const [k, v] of Object.entries(s.delivered)) deliveredRecent.set(k, v);
      }
    } catch (_) { return; }
  }

  loadState();

  /**
   * 成员报到时登记/更新会话 id（成员↔会话映射；会话变了要能更新）
   * @param {string} memberId 成员 id（= 消息里的 source；没卡自动建最小卡）
   * @param {string} sessionId 宿主会话 id（换会话/重连 = 更新）
   * @returns {{ok:true, memberId:string, sessionId:string, updated:boolean}}
   */
  function registerSession(memberId, sessionId) {
    if (typeof memberId !== 'string' || memberId.trim() === '') {
      throw new Error('成员 id 必须是非空字符串');
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('会话 id 必须是非空字符串');
    }
    members.ensureMember(memberId);
    const updated = sessions.has(memberId) && sessions.get(memberId) !== sessionId;
    sessions.set(memberId, sessionId);
    return { ok: true, memberId, sessionId, updated };
  }

  /**
   * 这条消息该叫谁（⭐ 规范 `接入\01` §5.1 **正本**：只看 `to`）
   *   - `@all` ⇒ **展开成全体成员**（叫全体）；
   *   - 空 `[]` ⇒ 谁也不叫（消息照旧进账本）；
   *   - 其它 ⇒ 照 `to` 抄。
   * ⚠️ 去重：同一条里重复 @ 同一个人，只叫一次。
   * @returns {string[]}
   */
  function targetsOf(msg) {
    const to = Array.isArray(msg.to) ? msg.to : [];
    const out = [];
    for (const t of to) {
      if (t === ALL_RECIPIENT) {
        for (const m of members.listAll()) {
          if (m && m.id && !out.includes(m.id)) out.push(m.id);
        }
        continue;
      }
      if (!out.includes(t)) out.push(t);
    }
    return out;
  }

  /** 回声保护：自己发的不叫自己 */
  function isEcho(targetId, msg) {
    return msg && msg.source === targetId;
  }

  /**
   * 把"该干什么"推给插件（办公室 → 插件，HTTP；`接入\02` §1 第 3／4 件）。
   * 按成员卡里的**门牌号**（`host`，形如 `127.0.0.1:19387`）POST 过去；没有门牌号 ⇒ 跳过（不算错）。
   * ⚠️ 推的是**命令**、不是正文：唤醒只说"有人找你、进来读"，内容它自己来看（`接入\02` §1.1）。
   * ⚠️ 不 await：叫醒是"发出去就算数"，不阻塞消息入账；失败写日志留痕。
   * @returns {boolean} 有没有推出去（不等于插件收到了）
   */
  function pushToPlugin(memberId, path, payload) {
    const card = members.getMember(memberId);
    const host = card && card.host;
    if (!host) return false;
    const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(config.pushTimeoutMs) : undefined,
    }).then((r) => {
      // ⭐ 2026-10-04 加：**推成功也留一行**（原来只有失败才记 ⇒ 事后出现"凭空来的叫醒"根本对不上账，
      //    老大 2026-10-04 拍板加）。带上状态码 ＋ 投递用的那几个字段（msgId/seq，好跟账本对）。
      // ⭐ 2026-10-05 改：**事件名按状态码分档** —— 原来不管状态码一律写 `push-ok`，插件回 500／404
      //    （端点压根没实现）也显示成"推成功"，翻日志会误判。`why` 里一直带着真状态码，这里把
      //    `event` 也对齐：2xx ⇒ `push-ok`；其余 ⇒ `push-http-<状态码>`。
      try {
        const code = (r && r.status) || 0;
        const okHttp = code >= 200 && code < 300;
        log.logEvent({
          type: 'state', who: memberId,
          why: `推给插件（${path}）：HTTP ${code}`,
          extra: { event: okHttp ? 'push-ok' : `push-http-${code}`, path, payload },
        });
      } catch (_) { /* 日志失败别把消息链带崩 */ }
    }).catch((e) => {
      // ⭐ 2026-10-05 加：失败这一档也**给个可筛的事件名**（原来只有一句 why，想筛"哪些推失败了"
      //    只能靠文本匹配）。
      try {
        log.logEvent({
          type: 'state', who: memberId,
          why: `推给插件失败（${path}）：${(e && e.message) || e}`,
          extra: { event: 'push-error', path },
        });
      } catch (_) { /* 日志失败也别把消息链带崩 */ }
    });
    return true;
  }

  /**
   * ⭐ 跟 `pushToPlugin` 不同：这个**要等插件回话**（用在"必须知道成没成"的场合）——
   *    例：人在**办公室成员卡**上点「叫它上线」，插件要是**绑不上**，办公室得把「上线异常」
   *    显示给老大（正本 `接入\01` §2.4）。
   * @returns {Promise<object|null>} 插件的响应 JSON；没门牌号／推不到／超时 ⇒ null
   */
  async function askPlugin(memberId, path, payload, timeoutMs) {
    const card = members.getMember(memberId);
    const host = card && card.host;
    if (!host) return null;
    const base = /^https?:\/\//.test(host) ? host.replace(/\/+$/, '') : `http://${host}`;
    try {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(Number(timeoutMs) || 5000) : undefined,
      });
      return await res.json();
    } catch (e) {
      try {
        log.logEvent({ type: 'state', who: memberId, why: `问插件失败（${path}）：${(e && e.message) || e}` });
      } catch (_) { /* 日志失败别把主流程带崩 */ }
      return null;
    }
  }

  /**
   * ⭐ 某个成员**那条连接还挂着吗** —— 规范 `查询\01` §7 要求卡上给"**连接**（连着／已断开）"，
   *    跟"在线（在线／未上线）"是**两格**（2026-10-04 老大：「连接和在线是两个状态」）。
   *    判据＝`aliveConns` 里有没有它（函数声明在前、`aliveConns` 在后面初始化，调用时已就绪）。
   */
  function isConnected(memberId) {
    for (const conn of aliveConns) { if (conn && conn.memberId === memberId) return true; }
    return false;
  }

  /** ⭐ 叫醒保护窗：**同一个人 10 秒内不许重复叫**（除非它已经上线了）——
   *  防重复点（老大 2026-10-04：「**点完叫他上线点了一次就要灰掉，代码里面也要这样，防止重复点，
   *  不然插件这边收到命令了就会一直叫**」）。
   *  ⚠️ **取值由老大实测拍定**：先定"五秒"，**实测「叫了它之后等了六秒它才有反应」⇒ 改成十秒**
   *  （五秒不够 AI 跑完一轮）。
   *  ⚠️ 只放内存：办公室重启就清空，无妨（重启后人本来也要重新走一遍流程）。 */
  const CALL_COOLDOWN_MS = 10 * 1000;
  const lastCalledAt = new Map();   // memberId -> 时间戳

  /** 它现在"**正在被叫**"吗（刚叫过 ＋ 还没上线）—— 界面拿这个灰掉按钮（`get_member(s)` 里带回 `calling`） */
  function isCalling(memberId) {
    const t = lastCalledAt.get(memberId);
    if (!t) return false;
    if (Date.now() - t > CALL_COOLDOWN_MS) return false;   // 过了保护窗 ⇒ 不算"正在叫"
    const m = members.getMember(memberId);
    return !(m && m.presence === 'online');                // 它已经在线 ⇒ 不算
  }

  /**
   * 一条已入账的消息 ⇒ 算出"该叫谁"，并把"进来看看"这条命令推给插件（⭐ **只看 `to`**）
   * @param {object} msg 已入账的信封（含 seq）
   * @returns {{delivered:Array, silent:Array, skipped:Array}}
   *   delivered ＝ 真推给插件的；silent ＝ 该叫但没推成（没报门牌号）；skipped ＝ 本来就不该叫的
   */

  /**
   * ⭐ "确认类"消息：只进账本、**不叫醒**（2026-10-04 老大：「**打回了才叫**」）。
   * 正本＝规范 `接入\01-接入与连接.md` §5.1 那张例外表。
   *   ① `task.ack`（收条）—— 谁发的都一样，含系统代回的收条；单向句号，对方不用动手
   *   ② `task.status` 且 `state === 'done'`（验收通过）—— 系统自己会把执行者改回空闲
   * ⚠️ `task.status` 的 **`blocked`（卡住）照旧叫**（派发者得知道、走重派那套）；
   *    `task.assign`（派发／打回）与 `task.deliver`（交付）也照旧叫。
   * @param {object} msg
   * @returns {boolean}
   */
  function isConfirmOnly(msg) {
    const t = String((msg && msg.type) || '');
    if (t === 'task.ack') return true;
    if (t === 'task.status' && msg && msg.data && msg.data.state === 'done') return true;
    return false;
  }

  function deliver(msg) {
    const delivered = [];
    const silent = [];
    const skipped = [];

    const targets = targetsOf(msg);

    // ⭐ 确认类（收条／验收通过）：**只进账本、不推 wake**（2026-10-04 老大：「打回了才叫」）
    //    —— 叫了它当场也做不了事，白烧一轮模型请求。消息照旧入账、任务板／聊天区照旧看得见。
    if (isConfirmOnly(msg)) {
      for (const targetId of targets) {
        skipped.push({ targetId, reason: '确认类不叫醒（收条／验收通过）—— 只进账本' });
      }
      return { delivered, silent, skipped };
    }

    // 防重：同一条最近已经叫过 ⇒ 不重复叫
    // ⭐ 2026-10-05 改（代码审查第 12 条）：键从 `msg.id` 改成 **`source + ':' + id`** ——
    //    与 M2 的幂等判据（`source + id`，见 `envelope.js` 的 `findByIdentity`）对齐。
    //    原来只认 id：两个成员各自用了同一个 id（比如都叫 `msg-1`）时，A 那条叫过之后，
    //    B 那条会被当成"最近已经叫过"⇒ **漏叫**（消息在账本里，得等它自己来读）。
    const key = `${msg.source}:${msg.id}`;
    if (deliveredRecent.has(key)) {
      for (const targetId of targets) skipped.push({ targetId, reason: '这条最近已经叫过（防重）' });
      return { delivered, silent, skipped };
    }
    // `to` 是空的 ⇒ 谁也不叫（消息照旧进账本）
    if (targets.length === 0) return { delivered, silent, skipped };

    let anyTarget = false;
    for (const targetId of targets) {
      // 回声保护：自己发的不叫自己
      if (isEcho(targetId, msg)) {
        skipped.push({ targetId, reason: '回声保护（自己发的不叫自己）' });
        continue;
      }
      // ⚠️ 没有会话／没报门牌号 ⇒ 叫不到。消息已经在账本里，它下次被叫起来时自己会读到。
      const sessionId = sessions.get(targetId) || null;
      // ⭐⭐ 2026-10-05 加：**没连着就不推** —— 规范 `01` §2.1「灰 ＝ 那条路真的走不通，**插件和后端都要拦**」，
      //    界面成员卡那张「叫它上线」按钮就是这么灰的（`noCallWhy` 第一档 ＝ `m.connected !== true`）。
      //    ⇒ 后端这一侧原来**独独漏了**：没连接也照推 ⇒ 日志记成 `push-ok`（看着像"推成功"），
      //      可插件那边 `linkOn:false` 时压根不叫醒（`插件源\dsh-office\lib\index.js:73-78`）⇒ **白推一场，还骗日志**。
      //    ⚠️ **口径不变**：还是"该叫谁只看 `to`"（§5.1）—— 这里只是把它挪进 `silent`
      //      （＝**该叫、但推不进去**），**不是 `skipped`**；验收脚本判"叫了谁"用的正是 `delivered ∪ silent`（M8／M12／M13）。
      //    ⚠️ **消息照旧入账**（入账在 `deliver` 之前），它连上之后自己来读，什么都不丢。
      //    ⚠️ 故意**不 `continue`**：跳过循环尾的 `anyTarget = true` 会连带切掉"防重登记 ＋ `saveState()`"，
      //      那条副作用链得原样留着 —— 所以这里只是把"推"这一步短路。
      const connOk = isConnected(targetId);
      const pushed = connOk && pushToPlugin(targetId, PLUGIN_WAKE_PATH, {
        memberId: targetId, reason: 'message', msgId: msg.id, seq: msg.seq,
      });
      if (pushed) {
        deliveryLog.push({ at: stampNow(), targetId, sessionId, wake: true, msgId: msg.id, seq: msg.seq });
        delivered.push({ targetId, sessionId, wake: true });
      } else {
        silent.push({
          targetId,
          reason: connOk
            ? '没报门牌号，推不到插件（消息在账本里，等它自己来读）'
            : '它没连着，推也送不进去（消息在账本里，等它连上自己来读）',
        });
      }
      anyTarget = true;
    }
    if (anyTarget) {
      deliveredRecent.set(key, msg.seq);
      saveState();
    }
    return { delivered, silent, skipped };
  }

  // ⚠️ **"收件箱"整个模型 2026-10-04 删掉**（`接入\01` §2.4／`接入\03` §4-1，老大令「不要留，不要这个功能」）：
  //    没有"未读消息"这一层、也没有游标 —— 消息一律实时推给插件叫醒；
  //    谁要翻历史就查账本（工具 `read_messages` / 端点走 `/api/call`）。

  /** 系统代发一条消息（走唯一大门：入账 ＋ 投递）；系统用固定 id `system`，不冒充成员（`01` §2） */
  let sysSeq = 0;
  function systemSend(partial) {
    const env = {
      id: `sys-${partial.type}-${(partial.data && partial.data.task) || 'x'}-${stampNow()}-${++sysSeq}`,
      source: 'system',
      specversion: '1.0',
      time: stampNow(),
      ...partial,
    };
    return receiveAndDeliver(env);
  }

  /** 把一个目录/文件复制进目标目录（产出归置用；只复制、不删原件） */
  function copyInto(src, dest) {
    const st = fs.statSync(src); // 不存在会抛 ⇒ 调用方兜
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        copyInto(path.join(src, name), path.join(dest, name));
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  /**
   * ⭐ **老大派的任务**走的那条特殊线（`08` §三之二 / `04` §7.6）：
   *   执行者交付到 boss ⇒ ① 产出归置到 `收件\<主任务 id>\` ② 系统代回"收到"
   *   ③ 系统自动判"验收通过"（那件转 `done`）④ 这一包全完了就代报 `over`。
   * 为什么特殊：老大不常驻这个窗口 ⇒ 这条线**没有"派发者挂了"那回事**，验收由系统自动判。
   */
  function handleBossDeliver(msg) {
    const subId = msg.data && msg.data.task;
    if (!subId) return;
    const mainId = subId.slice(0, subId.lastIndexOf('-'));
    const task = dl.getTask(mainId);
    if (!task) return;
    const exec = msg.source;

    // ① 产出归置：成员产出目录 → 收件\<主任务 id>\
    const where = msg.data.where;
    let placed = false, placeErr = null;
    if (where) {
      try {
        // ⭐ 2026-10-05 修（收件目录留空壳）：**先看源在不在，再建收件目录** ——
        //    `dirs.inboxDir()` 是「调用即建目录」（`mkdirSync` 写在它里面），
        //    原来它直接写在参数位置 ⇒ 源不存在时**目标目录已经先建好了**，
        //    复制失败就在收件夹留一个空壳目录（老大看到个空文件夹、里面什么都没有）。
        fs.statSync(where);
        copyInto(where, dirs.inboxDir(mainId));
        placed = true;
      } catch (e) {
        placeErr = (e && e.message) || String(e);
        try {
          log.logEvent({ type: 'state', who: exec, taskId: mainId, subId, why: `产出归置失败：${placeErr}` });
        } catch (_) {}
      }
    }
    // ② 代回"收到"（收条：to ＝ 执行者，inreplyto ＝ 那条交付）
    systemSend({ type: 'task.ack', to: [exec], inreplyto: msg.id, data: { task: subId, note: '收到了' } });
    // ③ 自动验收通过（`04` §7.6：判据 ＝ 产出**有去处**，不是"文件必须躺在他文件夹里"）
    //    ⭐ 2026-10-05 改（代码审查第 5 条）：原来**无条件**发「产出已进老大收件目录」——
    //    复制失败时那是**假话**（收件夹空着、任务板却显示"已进"）。现在如实说：复制不过去就把
    //    产出目录路径给他，让他自己去拿（老大 2026-10-05：「放不过去那把目录给我也可以」）。
    const note = placed
      ? '系统自动判：产出已进老大收件目录'
      : `系统自动判：验收通过（⚠️ 产出没能复制进老大收件目录 —— 东西在：${where || '(交付时没填产出目录)'}，老大自己去拿；原因：${placeErr || '交付时没填 where'}）`;
    systemSend({
      type: 'task.status', to: [exec],
      data: { task: subId, state: 'done', note },
    });
    // ④ 这一包全 done ⇒ 代老大报 over
    const t2 = dl.getTask(mainId);
    // ⭐ 2026-10-05 修：**判据对齐"全部到终态"（`done` 或 `cancelled`）**。
    //    本文件上面的 `over` 工具，以及 `envelope.checkOver`／`data-layer.closeTask`／
    //    `timeout.systemOver`／`timeout.nudgeAssignerToOver` 五处用的都是这个口径，**原来这里只认 `done`**
    //    ⇒ 老大派的那批任务里只要有一件被取消（超时／干不了／打回满轮都会标 `cancelled`），系统就**不自动
    //    代报 over**，得白等 5 分钟冷静期由 `sweepOrphanTasks` 代收（期间老大还会多收到一条"系统替你收口了"）。
    const settled = (s) => s.state === 'done' || s.state === 'cancelled';
    if (t2 && !t2.closed && t2.subtasks.every(settled)) {
      try { if (typeof timeout.systemOver === 'function') timeout.systemOver(mainId, { reason: 'boss-task-done' }); } catch (_) {}
    }
  }

  /**
   * 收消息（服务端唯一大门）：M2 校验 ＋ 幂等 ＋ 记账 → 投递（算出该叫谁）
   * @param {object} msg 01 §2 字段表的一条消息
   * @returns {{ok:true, seq?:number, duplicate?:boolean, delivered?:Array, silent?:Array, skipped?:Array}
   *          | {ok:false, reason:string, notify:string}}
   */
  function receiveAndDeliver(msg) {
    const r = envelope.receive(msg);
    if (!r.ok) {
      // 拒收留痕（M7 固定词 reject；对当事人只说"你触发了哪一条"）
      try {
        log.logEvent({ type: 'reject', who: msg && msg.source, taskId: msg && msg.data && msg.data.task, why: r.reason });
      } catch (_) { /* 日志失败不阻塞拒收 */ }
      // 第 10 条：打回满 2 次被拒 ⇒ 与超时/refuse 同款收尾（标 cancelled ＋ 通知派发者换人重派）
      if (typeof r.reason === 'string' && r.reason.startsWith('max-rounds:')) {
        const subId = r.reason.split(':')[1];
        if (subId && timeout && typeof timeout.handleMaxRounds === 'function') {
          try { timeout.handleMaxRounds(subId); } catch (_) { /* 收尾失败不阻塞拒收回话 */ }
        }
      }
      return r;
    }

    if (!r.duplicate) {
      // ⭐ M4 的消息钩子：验收通过（done）／blocked 落状态、探询解除、refuse 窗口。
      //    ⚠️ 不接这一条 ⇒ `done` 永远落不进任务表 ⇒ `over` 的前置校验过不去（主流程断在验收那一步）。
      try { if (timeout && typeof timeout.onMessage === 'function') timeout.onMessage(msg); } catch (_) {}
      // ⭐ 交付那一刻起 5 分钟判挂窗口（触发点 ＝ task.deliver）
      if (msg.type === 'task.deliver' && msg.data && msg.data.task) {
        try { if (typeof timeout.onDeliver === 'function') timeout.onDeliver(msg.data.task, msg.id); } catch (_) {}
      }
      // ⭐ 老大派的任务：交付 ⇒ 归置产出 ＋ 系统自动验收
      if (msg.type === 'task.deliver' && Array.isArray(msg.to) && msg.to.includes('boss')) {
        try { handleBossDeliver(msg); } catch (_) { /* 归置失败不阻塞消息入账 */ }
      }
    }

    const delivered = deliver(msg);
    return { ok: true, seq: r.seq, duplicate: !!r.duplicate, ...delivered };
  }

  // ─────────────── 统一工具分发（MCP 与 HTTP 共用；工具名不带点号） ───────────────

  /**
   * ⭐ 2026-10-05 加：**从某天的日志里挑出"告警"事件** —— 「待处理」（`pending_alerts`）与
   *    「已处理」（`read_alerts`）**共用这一套**（一处改、两处同步，正本＝本函数）。
   *    ⚠️ 判据一律用**结构化字段**（`type`／`extra.event`／`extra.kind`／`why`），别去抠中文文案 ——
   *    文案以后改了，判据也不塌（原来那段在 `pending_alerts` 里内联着，改成共用是为了新增「已处理」时
   *    不出现"两处各写一份、迟早漂"）。
   * @param {string} day YYYYMMDD
   * @param {{includeRefuseDead?: boolean}} [opts] `includeRefuseDead` ＝ 是否把日志里的
   *        `refuse-dead-notify`（"派发者连不上、执行者干不了"那一声）也算进来。
   *        ⚠️ `pending_alerts` 传 **false**：它那条另有来源（内存里"等确认"的表），
   *        从日志再挑一遍会**重复**；`read_alerts` 传 **true**（历史里要能翻到它）。
   * @returns {{kind:string, subId:string|null, taskId:string|null, to:string, time:string, text:string}[]}
   */
  /**
   * ⭐ 2026-10-05 加（第 2 刀）：**今天有几条"接入没成"** —— 界面顶上那两个标记用。
   * ⚠️ 2026-10-05 改口径（老大：「没走插件这个说法也该改了叫非法接入，提示再加一个拒绝接入，分开来」）：
   *    原来三类合成一个数、还叫"没走插件" —— 可 `refused` 那一堆**往往恰恰是插件自己**（连着但手续不对、
   *    在反复重试被拒）⇒ 说成"没走插件"跟事实正好相反。界面已拆成两个标记：
   *    **非法接入**（`unverified`）／**拒绝接入**（`refused`）。
   *    ⚠️ 本函数的**返回值不改**（三个数本来就分着给，界面各取各的）。
   * 判据一律用**结构化字段**（`extra.event`），不抠中文文案（照 `alertFeed` 同一套规矩）。
   * ⚠️ 它**不是告警**（不进「待处理」）：接不进来、探不通，都是"有人在试"的痕迹，
   *    人回来**一眼看到**就够了（老大原话：留痕要"人回来一眼能看到"）。
   * @param {string} day YYYYMMDD
   */
  function accessFeed(day) {
    const out = { day, count: 0, unverified: 0, refused: 0, probeFail: 0 };
    for (const e of (log.readLog(day) || [])) {
      const ev = (e.extra && e.extra.event) || '';
      // ⚠️ 2026-10-05 修：`state === 'fresh'`（新人第一次领卡）**不算"没走插件"** —— 那是正规流程。
      //    留这道排除是为了**把已经记进日志的那些也算对**（判据落在结构化字段上，不抠文案）。
      if (ev === 'access-unverified') {
        if ((e.extra && e.extra.state) === 'fresh') continue;
        out.unverified += 1;
      }
      else if (ev === 'access-refused') out.refused += 1;
      else if (ev === 'probe-fail') out.probeFail += 1;
      else continue;
      out.count += 1;
    }
    return out;
  }

  function alertFeed(day, opts) {
    const wantRefuseDead = !!(opts && opts.includeRefuseDead);
    const alerts = [];
    for (const e of (log.readLog(day) || [])) {
      const ev = (e.extra && e.extra.event) || '';
      const isTimeout = ev === 'timeout';
      const isAckTimeout = isTimeout && (e.extra && e.extra.kind) === 'assign-ack';
      const isRefuseDead = ev === 'refuse-dead-notify';
      // ⚠️ 2026-10-05 修：「干不了＋派发者死」那行日志的 `type` **也是** `dispatcher-dead`
      //    （见 `timeout.js` 的 `handleRefuseAndDead`）⇒ 不排除它就会被"判挂"这道判据**误命中**：
      //    `pending_alerts` 里凭空多出一条，界面还给它渲染出「我知道了」按钮 —— 一点就报
      //    「没有等确认的 … 记录」（实测撞到：老大点了一下、界面报错）。
      //    ⇒ 排除掉：那条只在 `read_alerts`（历史）里出现。
      const isDispatcherDead = e.type === 'dispatcher-dead' && !isRefuseDead;
      const isOrphanCollected = e.type === 'over' && ev === 'over-system' && e.why === 'no-active-work';
      if (!isTimeout && !isDispatcherDead && !isOrphanCollected && !(wantRefuseDead && isRefuseDead)) continue;
      const kind = isRefuseDead
        ? 'refuse-dead'
        : (isTimeout ? 'timeout' : (isDispatcherDead ? 'dispatcher-dead' : 'orphan-collected'));
      /* ⭐ 2026-10-06 文案统一（老大：「系统通知这一类改成通俗正式一点、不要有你我他」）：
         这四条是**直接显示在「待处理」里的系统消息**，一律写成无主语书面句 ——
         去 `⇒`、去"你"、去口语（"连不上"→"未回应"、"判挂"→"判定离线"）。
         ⚠️ 上面那段 `kind` 判据一个字都没动（那是机器读的）。 */
      const text = isRefuseDead
        ? `${e.subId} 执行者无法完成、派发者未回应，任务已停止（等待确认）`
        : (isTimeout
          ? (isAckTimeout
            ? `${e.subId} 派发后 5 分钟无回应，已停止并改派`
            : `${e.subId} 时限超过，已停止并改派`)
          : (isDispatcherDead
            ? `${e.subId} 派发者未回应，判定离线；系统已自动收尾（无需确认）`
            : `${e.taskId} 已无进行中的任务且无人收口，系统已代为收口（无需确认）`));
      alerts.push({
        kind, subId: e.subId || null, taskId: e.taskId || null,
        to: e.who || '', time: e.ts || '', text,
      });
    }
    return alerts;
  }

  const tools = {
    /** 报到心跳（连接表每 **1 秒**刷一次；2026-10-04 周期从 10 秒一路改到 1 秒） */
    heartbeat: {
      description: '报到心跳：连接表每 1 秒刷一次，只更新时间戳不叫模型',
      inputSchema: {
        type: 'object',
        properties: { memberId: { type: 'string', description: '成员 id（= 消息 source）' } },
        required: ['memberId'],
      },
      run: (memberId, args) => {
        // ⭐ 2026-10-05 加：**心跳只能报自己**（同 `register` 那一刀）—— 不然一个成员能替别人续心跳。
        if (args.memberId !== memberId) {
          return { ok: false, error: `心跳只能报自己：调用者 ${memberId}，实报 ${args.memberId}`, notify: '心跳只能报自己' };
        }
        const ok = status.receiveHeartbeat(args.memberId);
        return ok
          ? { ok: true, data: { memberId: args.memberId, online: true } }
          : { ok: false, error: `报到被拒：${args.memberId}（boss 或未知成员不进状态机）`, notify: '当前不在线（未接入）' };
      },
    },

    /** 接入报到：建卡 ＋ 报身份（宿主进程名/昵称/模型/门牌号/**头像**）＋ 登记成员↔会话映射 */
    register: {
      description: '接入报到：自动建最小卡，报宿主进程名/昵称/模型/门牌号（宿主端点）/头像，登记成员↔会话映射',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '成员 id' },
          sessionId: { type: 'string', description: '宿主会话 id（换会话/重连 = 更新）' },
          // ⭐ 2026-10-04 名字分两个（老大：「名字我们统一用宿主的进程名字，然后加个昵称让 ai 自己填」）：
          //    · name（宿主进程名）＝ 它所在宿主的进程名，**由插件代报**（不是 AI 起的、AI 也改不了）；
          //    · nick（昵称）＝ **AI 自己填、自己改**，可以没有（传空串＝改回"没有"）。规范 `02` §3。
          name: { type: 'string', description: '⭐ 宿主进程名：它所在宿主的进程名，如 "DeepSeek Harness"（由插件代报，AI 改不了）' },
          nick: { type: 'string', description: '⭐ 昵称：AI 自己填、自己改，可以没有；传空串＝去掉昵称' },
          model: { type: 'string', description: '报模型（可选）' },
          host: { type: 'string', description: '⭐ 门牌号：宿主端点 host:port（第一次报到要带；办公室靠它主动推）' },
          // ⭐ 2026-10-04 加（老大令：「**第一次上线自己把自己宿主的进程的图标导进去，加一个必须**」）：
          //    ⚠️ **交的是图片本身**（base64 字符串），**不是路径**（规范 `02` §3）。
          icon: { type: 'string', description: '⭐ 头像：图片本身的 base64（第一次上线必须交；取自自己宿主进程的图标）' },
        },
        required: ['memberId', 'sessionId'],
      },
      run: (memberId, args) => {
        // ⭐ 2026-10-05 加：**只能给自己报到**（正本＝规范 `接入\02` §2.2 的 `register` 那行）。
        //    原来这里**不校验** ⇒ 一个连着的成员能替**别人**建卡／改卡：① 改门牌号（之后办公室把给那个人的
        //    叫醒**全推到这个人的宿主上**）② 改宿主进程名／昵称／头像。判据与 `send_message` 的 `source` 同款。
        if (args.memberId !== memberId) {
          return {
            ok: false,
            error: `只能给自己报到：调用者 ${memberId}，报的却是 ${args.memberId}，已拒收`,
            notify: '只能给自己报到（不许替别人改卡）',
          };
        }
        // ⭐ 2026-10-05 加：**成员 id 要有格式**（正本＝规范 `02-成员卡.md` §3 字段表那行的「格式」）——
        //    原来"报什么就是什么" ⇒ 中文、带空格、超长、大小写混用都能建卡，早晚撞车；
        //    而且 id 要进消息的 `source`／`to`，纯 ASCII 才省心。
        //    ⚠️ 只管**建卡/改卡这个入口**：已有卡的人不必再报 id；`boss` 是界面身份、不走这条路；
        //       实测存量（`boss`/`fish`/`a`/`b`/`c`）与全部验收脚本用的 id 都合格式，不受影响。
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(String(args.memberId || ''))) {
          return {
            ok: false,
            error: `成员 id 不合格式：${args.memberId}（要求 ^[a-z][a-z0-9_-]{0,31}$ —— 小写字母开头，之后小写字母/数字/短横/下划线，总长 ≤ 32）`,
            notify: '成员 id 不合格式（小写字母开头，只含小写字母/数字/短横/下划线，≤ 32 位）',
          };
        }
        members.ensureMember(args.memberId);
        if (args.name !== undefined || args.nick !== undefined || args.model !== undefined) {
          members.reportIdentity(args.memberId, { name: args.name, nick: args.nick, model: args.model });
        }
        if (args.host) members.setHost(args.memberId, args.host);
        // ⭐ 头像：调用方交了才写（`members.setIcon()` 一直存在、此前全项目没人调 —— 这就是那个缺口）
        if (args.icon) members.setIcon(args.memberId, args.icon);
        const rs = registerSession(args.memberId, args.sessionId);
        status.receiveHeartbeat(args.memberId);
        // ⭐ 2026-10-05 加：**报到之后补探一次** —— 门牌号是这会儿才报上来的
        //    （挂连接那一刻去探必然是 `n/a`，规范里写了"新人第一次必然 n/a"）。
        //    ⚠️ 不 await：探活是"顺手问一句"，不能把报到拖住。
        try { probeMemberConns(args.memberId); } catch (_) { /* 探活不影响报到 */ }
        const card = members.getMember(args.memberId);
        return {
          ok: true,
          data: {
            ...rs,
            // ⭐ 2026-10-05：回传的这张卡**就是接入手续要的那四格**（`id`/`joined`/`name`/`icon`）——
            //    接入端存下来，以后每次挂连接都带上来核对（正本：规范 `接入\01` §2.4）。
            //    ⚠️ `model`／`host` 照旧带着（面板那边在看），但它们**不参与**核对（会变）。
            card: card && {
              id: card.id, joined: card.joined, name: card.name, icon: card.icon || '',
              model: card.model, host: card.host || null,
            },
          },
        };
      },
    },

    /** 上线 ／ 自己下线（⛔ "隐身" 2026-10-04 整档砍掉；"离线"是另一回事，见 `状态\01`） */
    presence: {
      description: '上线（online）／自己下线（offline）。⚠️ 被"断开连接"处理过的上不了，得人重新点「连接」',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string' },
          presence: { type: 'string', enum: ['online', 'offline'], description: 'online＝上线；offline＝自己下线（＝先跟办公室说一声，办公室才知道）' },
        },
        required: ['memberId', 'presence'],
      },
      run: (memberId, args) => {
        const r = status.setPresence(args.memberId, args.presence);
        if (!r.ok) return { ok: false, error: r.reason, notify: r.reason };
        // ⭐ 2026-10-05 接线（代码审查第 8 条）：**成员一上线，就把它离线期间积压的那条补投做掉**
        //    ——「任务已经提交，请验收」（5 分钟内的未决交付）＋ 解 refuse 窗口，见 `timeout.onOnline`。
        //    原来那个函数**全项目零调用点**，这条规矩从上线起就没生效过。
        if (args.presence === 'online') {
          try { timeout.onOnline(args.memberId); } catch (_) { /* 补投失败不影响上线本身 */ }
        }
        return { ok: true, data: { memberId: args.memberId, presence: r.presence || args.presence } };
      },
    },

    // ⛔ `busy` 工具 2026-10-04 撤掉（`接入\03` §4-4）：忙闲由**系统按消息流判**，AI 不得自己改。
    //    ⭐ 给老大留的那个口在下面的 `set_busy`（只认 boss）。

    /** 查成员卡（规范 02 §3 / 03 §7） */
    get_member: {
      description: '查一张成员卡：id/name/joined/model/icon + 在线/忙闲',
      inputSchema: {
        type: 'object',
        properties: { memberId: { type: 'string' } },
        required: ['memberId'],
      },
      run: (memberId, args) => {
        const m = members.getMember(args.memberId);
        if (!m) return { ok: false, error: `成员不存在: ${args.memberId}`, notify: `成员不存在: ${args.memberId}` };
        // ⭐ 补"**连接**"那一格（规范 `查询\01` §7：**连接和在线是两个状态、都要给**）——
        //   判据＝它那条 SSE 流还挂着没有（`aliveConns`）。boss 不挂流 ⇒ 开程序＝在，给 true。
        return {
          ok: true,
          data: {
            ...m,
            connected: m.id === 'boss' ? true : isConnected(m.id),
            // ⭐ 2026-10-04 补：**离了线要能看出"因为什么离的"**（规范 `状态\01` §2.3；老大原话
            //    「离线不知道什么情况那就把原因也写进去不就好了」）——
            //    值见 `status.OFFLINE_REASON`：self／heartbeat／kick／disconnect；在线或 boss 回 null。
            offlineReason: m.id === 'boss' ? null : status.offlineReasonOf(m.id),
            // ⭐ "**正在叫**"（刚叫过、还没上线）—— 界面拿它灰掉「叫它上线」按钮，防重复点
            calling: m.id === 'boss' ? false : isCalling(m.id),
          },
        };
      },
    },

    /** 可派发名单（规范 03 §5：现算，不落卡） */
    list_members: {
      description: '可派发名单：在线且空闲/可打回的成员（派发者视角）',
      inputSchema: {
        type: 'object',
        properties: { byMemberId: { type: 'string', description: '谁在查（派发者视角）' } },
        required: ['byMemberId'],
      },
      run: (memberId, args) => {
        const list = members.listAssignable(args.byMemberId || memberId);
        return { ok: true, data: list };
      },
    },

    /** 要号：下一个主任务 id（系统发号，AI 不自己数；⭐ 老大要号 ⇒ 带 `boss-` 前缀） */
    next_task_id: {
      description: '要号：取下一个主任务 id（顺序号+时间）。⭐ 老大要号自动带 boss- 前缀（任务板上标"老大"）',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: (memberId) => {
        const id = dl.makeTaskId({ boss: memberId === 'boss' });
        return { ok: true, data: { taskId: id } };
      },
    },

    /** 发消息（内容进账本；动作不从这里走） */
    send_message: {
      description: '发一条内容消息（task.assign / task.ack / task.status / task.deliver / chat.message）；msg.source 必须等于调用者',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（= 消息 source）' },
          envelope: { type: 'object', description: '01 §2 完整信封（id/source/specversion/type/to/data）' },
        },
        required: ['memberId', 'envelope'],
      },
      run: (memberId, args) => {
        const msg = args.envelope;
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          return { ok: false, error: 'envelope 必须是对象', notify: '信封必须是对象' };
        }
        if (msg.source !== memberId) {
          return { ok: false, error: `消息 source（${msg.source}）必须等于调用者（${memberId}）`, notify: '消息 source 必须等于你自己' };
        }
        const r = receiveAndDeliver(msg);
        if (!r.ok) return { ok: false, error: r.reason, notify: r.notify || r.reason };
        return { ok: true, data: { seq: r.seq, duplicate: !!r.duplicate, delivered: r.delivered, silent: r.silent, skipped: r.skipped } };
      },
    },

    /**
     * 换人重派（规范 03 §3：超时/refuse/打回满轮后，派发者把没完成的那件换个人）
     * 动作走工具；新执行者要知道自己有新任务 ⇒ 系统顺手代派发者发一条 task.assign（内容进账本）
     */
    reassign: {
      description: '换人重派：把被取消的那件换个没试过的人（必须由派发者本人发起；系统自动发一条 task.assign 通知新执行者）',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（必须是这批任务的派发者）' },
          subId: { type: 'string', description: '被取消的那件子任务 id（旧 id，不复用）' },
          to: { type: 'string', description: '新执行者（必须没试过）' },
          timeout: { type: 'integer', description: '新件的时限（可选；默认继承旧件）' },
          note: { type: 'string', description: '备注（可选；默认继承旧件）' },
        },
        required: ['memberId', 'subId', 'to'],
      },
      run: (memberId, args) => {
        if (!timeout || typeof timeout.assignRetry !== 'function') {
          return { ok: false, error: '时限模块未启用', notify: '换人重派不可用' };
        }
        const r = timeout.assignRetry(args.subId, args.to, {
          by: memberId,
          timeout: args.timeout,
          note: args.note,
        });
        if (!r.ok) return { ok: false, error: r.reason, notify: r.reason };
        if (r.selfDo) {
          return { ok: true, data: { selfDo: true, taskId: r.taskId, reason: r.reason } };
        }

        // 顺手把派发消息发出去（source = 派发者本人）：新执行者才知道自己有新任务；
        // 信封里带上任务表里那件的真实时限，保证与账本一致。
        const t = dl.getTask(r.taskId);
        const st = t && Array.isArray(t.subtasks) ? t.subtasks.find((s) => s.id === r.subId) : null;
        const sub = { id: r.subId, to: args.to };
        if (st && st.timeout != null) sub.timeout = st.timeout;
        if (st && st.note) sub.note = st.note;
        const env = {
          id: `reassign-${r.subId}`,
          source: memberId,
          specversion: '1.0',
          type: 'task.assign',
          to: [args.to],
          time: stampNow(),
          data: { task: r.taskId, subtasks: [sub] },
        };
        if (t && t.title) env.data.title = t.title;

        const sent = receiveAndDeliver(env);
        if (!sent.ok) {
          // ⭐ 2026-10-05 改（代码审查第 4/6 条的**真问题**这一半）：消息没发出去 ⇒ **回 ok:false**，
          //    不要像原来那样回 `ok:true` ＋ 一句 warn —— 那会让调用者以为"重派成了"。
          //    ⚠️ 此刻那件新子任务**已经写进任务表**（`assignRetry` 先写后发），而账本里没有它的派发消息
          //    ⇒ 它的"5 分钟表态窗口"不会登记；但它**有 `assignedAt`**，时限到点照样判超时 ⇒ 不会永久卡死。
          //    ⇒ 所以这里只如实报错、不强行回滚（回滚要动数据层，风险大于收益）。
          return {
            ok: false,
            error: `换人已写进任务表，但派发消息没发出去（${sent.reason}）。本次重派未成功：新件 ${r.subId} 已挂在 ${args.to} 名下，请在时限内重新发起或手工处理`,
            notify: '换人重派未能发出',
            data: { taskId: r.taskId, subId: r.subId, warn: `换人已生效，但派发消息没发出去：${sent.reason}` },
          };
        }
        return {
          ok: true,
          data: { taskId: r.taskId, subId: r.subId, seq: sent.seq, delivered: sent.delivered, silent: sent.silent, skipped: sent.skipped },
        };
      },
    },

    // ⛔ `inbox` 工具 2026-10-04 删掉（`接入\03` §4-1，老大令「不要留，不要这个功能」）：
    //    没有"收件箱"这一层 —— 消息一律实时送（见 `deliver()`）；要翻历史用 `read_messages`。

    /** 干不了（规范 05 §7.2：refuse 走工具调用，不进账本） */
    refuse: {
      description: '干不了：转告派发者 + 起 5 分钟窗口看派发者死活',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string' },
          subId: { type: 'string', description: '干不了的那件子任务 id' },
        },
        required: ['memberId', 'subId'],
      },
      run: (memberId, args) => {
        if (!timeout || typeof timeout.onRefuse !== 'function') {
          return { ok: false, error: 'refuse 未启用（M4 未注入）', notify: 'refuse 暂不可用' };
        }
        // ⭐ 2026-10-05 加：**必须是这件的执行者**（正本＝规范 `时限\01`「干不了如何收场」那节）。
        //    原来**不校验调用者** ⇒ 任何连着的成员都能拿**别人的**子任务走这条流程
        //    （系统转告派发者、起 5 分钟窗口，到点还弹老大）—— 等于给了个搅局开关。
        const r = timeout.onRefuse(args.subId, { by: memberId });
        if (r && r.ok === false) return { ok: false, error: r.reason, notify: r.reason };
        return { ok: true, data: { subId: args.subId, refused: true } };
      },
    },

    /** 报 over（规范 01 §5 第 8 条：前提是所有子任务**到终态** —— `done` 或 `cancelled`；动作走工具调用） */
    over: {
      description: '收口：报 over（前提：这一包子任务全部到终态，done 或 cancelled）',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string' },
          taskId: { type: 'string', description: '主任务 id' },
        },
        required: ['memberId', 'taskId'],
      },
      run: (memberId, args) => {
        const chk = envelope.checkOver(args.taskId);
        if (!chk.ok) return { ok: false, error: chk.reason, notify: chk.notify || chk.reason };
        // ⭐ 2026-10-05 加：**只有派发者（或 boss）能报 over**。
        //    原来这里只查"每件都有结果"、**不查调用者是谁** ⇒ 任何一个连着的成员都能把别人派的那批任务收口
        //    （而同一件事在 `timeout.nudgeAssignerToOver` 的注释里写着"只有派发者能报" —— 两处口径相反）。
        const assigner = (dl.readMessages() || [])
          .find((m) => m.type === 'task.assign' && m.data && m.data.task === args.taskId);
        const byWho = assigner ? assigner.source : null;
        if (byWho && memberId !== byWho && memberId !== 'boss') {
          return { ok: false, error: `over 只有派发者（${byWho}）能报，${memberId} 无权限`, notify: '只有派发者能报 over' };
        }
        const task = dl.closeTask(args.taskId);
        try { log.logEvent({ type: 'over', taskId: args.taskId, who: memberId, why: '派发者报 over' }); } catch (_) {}
        return { ok: true, data: { taskId: task.id, closed: true } };
      },
    },

    /** 老大点"我知道了"（干不了+派发者死的那件取消） */
    ack_refuse_dead: {
      description: '老大点"我知道了"：那件取消 + 执行者空闲',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（boss）' },
          subId: { type: 'string', description: '干不了+派发者死的那件子任务 id' },
        },
        required: ['memberId', 'subId'],
      },
      run: (memberId, args) => {
        // ⭐ 2026-10-05 加：**只认 boss** —— 规范 `接入\02` §2.2 把它列进「**只认 boss 的六个**」，
        //    ⚠️ 而此前**唯独它漏了这道校验**（另五个都有）⇒ 任何"连着且手续 ok"的成员都能
        //    取消那件「干不了＋派发者死」的子任务。写法与 `kick_member`／`call_online` 保持一致。
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可确认（我知道了）', notify: '该操作仅限派发者' };
        }
        if (!timeout || typeof timeout.ackRefuseDead !== 'function') {
          return { ok: false, error: 'ack_refuse_dead 未启用（M4 未注入）', notify: '该动作暂不可用' };
        }
        // ⚠️ 2026-10-04 修：**内层的失败别再吞掉** —— `ackRefuseDead` 在"还没到 5 分钟窗口"
        //    时会回 `{ok:false, reason:'没有等确认的记录…'}`，包装层原来无条件报 `resolved:true`，
        //    害得老大点了「我知道了」以为成了、其实什么都没做（实测踩到）。
        const r = timeout.ackRefuseDead(args.subId);
        if (r && r.ok === false) {
          return { ok: false, error: r.reason || '没成', notify: r.reason || '这条现在收不了口' };
        }
        return { ok: true, data: { subId: args.subId, resolved: true } };
      },
    },

    /** 老大手动踢人（界面成员卡上的红色按钮，2026-10-03 加） */
    kick_member: {
      description: '老大手动把某个成员踢下线（界面成员卡用）：判离线 + 日志留痕；要它回来得老大叫它上线（call_online）',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（boss）' },
          id: { type: 'string', description: '要踢下线的成员 id' },
        },
        required: ['memberId', 'id'],
      },
      run: (memberId, args) => {
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可执行「踢下线」', notify: '该操作仅限派发者' };
        }
        if (!args.id) return { ok: false, error: '缺参数 id（目标成员）', notify: '未指定要踢下线的成员' };
        const r = status.kickMember(args.id);
        if (!r.ok) return { ok: false, error: r.reason, notify: r.reason };
        try {
          // 踢完必须留痕（规范 §2.2/§8：为什么被踢要能查）
          log.logEvent({
            type: 'kick',
            who: r.id,
            why: '劳大手动踢下线',
            extra: { hadActiveWork: r.hadActiveWork, by: 'boss' },
          });
        } catch (_) {}
        return { ok: true, data: { id: r.id, presence: 'offline', hadActiveWork: r.hadActiveWork }, notify: `${r.id} 已踢下线` };
      },
    },

    /** 老大叫它上线（界面成员卡上的对应按钮，2026-10-03 加） */
    /** ⭐ 老大在**办公室成员卡**上叫某个成员上线（2026-10-03 加；2026-10-04 改成"只叫醒"） */
    call_online: {
      description: '老大在成员卡上叫某个成员上线：**办公室只把它叫醒**（叫醒送到它上一次绑过的会话），上线由它自己完成。⚠️ 叫不到 ⇒ 报「上线异常」',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（boss）' },
          id: { type: 'string', description: '要叫上线的成员 id' },
        },
        required: ['memberId', 'id'],
      },
      run: async (memberId, args) => {
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可执行「叫它上线」', notify: '该操作仅限派发者' };
        }
        if (!args.id) return { ok: false, error: '缺参数 id（目标成员）', notify: '未指定要叫上线的成员' };
        // ⭐⭐ 第一层断了 ⇒ 第二层失效（正本 `接入\01` §2.1；而且"**灰 ＝ 那条路真的走不通，两边都要拦**"）：
        //    线没连着的时候**根本叫不了** —— 就算叫醒它，它自己上线也会被拒（插件那头拦得更早：
        //    "办公室那边是已断开 ⇒ 线断了就上不了线"）。⇒ **直接拒，别白叫它一轮**（2026-10-04 实撞：
        //    老大点了「断开连接」之后又点「叫它上线」⇒ 白叫了一轮）。
        if (!isConnected(args.id)) {
          return {
            ok: false,
            error: `${args.id} 那条线没连着（办公室这边显示"已断开"），该成员无法上线，需先点「连接」`,
            notify: '该成员未连接，请先点「连接」',
          };
        }
        // ⭐ 防重复点（2026-10-04 老大：「**点完叫他上线点了一次就要灰掉，代码里面也要这样**」）：
        //    刚叫过、而它还没上线 ⇒ **直接拒**。⚠️ 光靠界面灰按钮不算 —— **绕过界面直调也得拦住**。
        if (isCalling(args.id)) {
          return {
            ok: false,
            error: `刚叫过 ${args.id} 了（${Math.round(CALL_COOLDOWN_MS / 1000)} 秒保护窗内不重复叫），等待其自行上线`,
            notify: '刚刚已叫过，等待其自行上线',
          };
        }
        // ⭐⭐ 2026-10-04 改口径（老大：「**插件是来唤醒的，这个得让 ai 自己去上线**」）：
        //    办公室**不替它上线了** —— 只**把它叫醒**（叫醒会送到"插件上一次绑过的会话"，见 `01` §2.1 第三种情况），
        //    ⭐ **"上线"这个动作由 AI 自己做**：它醒了会自己调 `presence online`（那时才是真的在线）。
        //    ⚠️ 要**等插件回话**才知道送没送进去 ⇒ **送不进去就报「上线异常」**让老大去处理
        //    （正本 `接入\01` §2.1／§2.2；⛔ 旧的"办公室改状态 ＋ 敲插件认岗"已作废）。
        const reply = await askPlugin(args.id, PLUGIN_ONLINE_PATH, { memberId: args.id });
        if (reply && reply.ok === true) {
          lastCalledAt.set(args.id, Date.now());   // ⭐ 记下"刚叫过"（10 秒保护窗；它上线后自动失效）
          try {
            log.logEvent({
              type: 'state',
              who: args.id,
              why: '派发者叫其上线（已叫醒，等待自行上线）',
              extra: { event: 'call-online', by: 'boss' },
            });
          } catch (_) { /* 日志失败不阻塞 */ }
          return {
            ok: true,
            data: { id: args.id, called: true, boundSessionId: reply.boundSessionId || null },
            notify: `已叫醒（${args.id}），其自行上线后卡上才会变「在线」`,
          };
        }
        const why = reply ? String(reply.error || '插件送不进去') : '推不到插件（它没开、或还没报过门牌号）';
        try {
          log.logEvent({ type: 'state', who: args.id, why: `上线异常：${why}`, extra: { event: 'online-abnormal' } });
        } catch (_) { /* 日志失败不阻塞 */ }
        return { ok: false, error: `上线异常：${why}`, notify: `上线异常（${args.id}）` };
      },
    },

    /**
     * ⭐ 老大在成员卡上改忙闲（`状态\02`：「空闲平时系统通过信息判断，然后给我留个口让我能自己改」）
     * ⚠️ **只给人的口**：只有 boss 调得动 —— AI 拿不到（`busy` 工具已撤）。
     * ⚠️ 改完只在"账本没变化"期间有效；账本一变，忙闲回到系统判（见 status.setBusyByBoss）。
     */
    set_busy: {
      description: '老大改某个成员的忙闲（界面成员卡用）：busy / idle。⚠️ 只认 boss；AI 不能改自己状态',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（必须 boss）' },
          id: { type: 'string', description: '要改谁的忙闲' },
          busy: { type: 'string', enum: ['busy', 'idle'], description: 'busy=忙 / idle=空闲' },
        },
        required: ['memberId', 'id', 'busy'],
      },
      run: (memberId, args) => {
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可改成员忙闲', notify: '该操作仅限派发者' };
        }
        const r = status.setBusyByBoss(args.id, args.busy);
        if (!r.ok) return { ok: false, error: r.reason, notify: r.reason };
        try {
          log.logEvent({
            type: 'state',
            who: r.id,
            why: `派发者手动改忙闲：${r.busy}`,
            extra: { event: 'set-busy', busy: r.busy, by: 'boss' },
          });
        } catch (_) {}
        return {
          ok: true,
          data: { id: r.id, busy: r.busy },
          notify: `${r.id} 改成：${r.busy === 'busy' ? '忙' : '空闲'}`,
        };
      },
    },

    /**
     * ⭐ 调试模式开关（2026-10-04 老大定）—— **只认 boss**。
     * 开着 ⇒ 跳过 `invokeTool` 里那道「**没连着就不许调工具**」的门（做测试时要能绕过去）。
     * ⚠️ 规矩见 `规范\04-功能清单.md` §7.7：**开关留痕**、**每次"走后门"的调用也留痕**、
     *    **界面挂醒目标记**（防"开着忘了关"）。⚠️ 只放内存 ⇒ 办公室重启即回到"关"。
     */
    set_debug: {
      description: '开关调试模式（设置面板用）：开着 ＝ 跳过"没连着不许调工具"那道门。⚠️ 只认 boss；默认关',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（必须 boss）' },
          on: { type: 'boolean', description: 'true＝开（跳校验）／false＝关（默认）' },
        },
        required: ['memberId', 'on'],
      },
      run: (memberId, args) => {
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可开关调试模式', notify: '该操作仅限派发者' };
        }
        const on = args.on === true;
        debugBypass = on;
        // ⭐ 2026-10-05 加：**自动过期的计时起点**（`04-功能清单` §7.7 第 5 条）——
        //    开的那一刻算起；之后每次"经它放行"再刷新（见 `invokeTool` 里那段留痕）。
        debugTouchedAt = Date.now();
        try {
          log.logEvent({
            type: 'state',
            who: 'boss',
            why: on ? '调试模式：开（那道门暂时跳过）' : '调试模式：关（那道门恢复）',
            extra: { event: 'set-debug', on, by: 'boss' },
          });
        } catch (_) { /* 日志失败别把开关带崩 */ }
        return {
          ok: true,
          data: { debug: on },
          notify: on ? '调试模式：开 —— 校验暂时关了（用完记得关）' : '调试模式：关',
        };
      },
    },

    // ───────── M10 · 界面只读查询（不动业务；写仍走上面的工具） ─────────

    /** 全部成员卡（界面左栏/中栏/任务板用） */
    get_members: {
      description: '全部成员卡：id/name/joined/model/icon + 在线/忙闲（含 boss）',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: () => {
        // ⭐ 每张卡都补"**连接**"那一格（跟 `get_member` 同一个判据，规范 `查询\01` §7 要求的）
        const list = members.listAll().map((m) => ({
          ...m,
          connected: m.id === 'boss' ? true : isConnected(m.id),
          // ⭐ 2026-10-04 补：**离线原因**（规范 `状态\01` §2.3）—— 跟 `get_member` 用同一个判据
          offlineReason: m.id === 'boss' ? null : status.offlineReasonOf(m.id),
          calling: m.id === 'boss' ? false : isCalling(m.id),   // ⭐ 正在叫（界面拿它灰按钮）
        }));
        return { ok: true, data: { members: list } };
      },
    },

    /**
     * ⭐ 人在**办公室成员卡**上点「连接／断开」（`接入\01` §2.1 的**第一层**，2026-10-04 加）
     * ⚠️ **第一层只有人能控**（老大 2026-10-04 重申）⇒ 这个工具**只认 boss**。
     * 做法照 §2.4：**在办公室点连接 ⇒ 办公室去连插件** —— 敲插件那个口，让它去挂流／掐流；
     *   要**等它回话**才知道成没成（所以用 `askPlugin`）。
     */
    connect_member: {
      description: '老大在成员卡上让某个成员连上／断开办公室那条线（第一层）。⚠️ 只认 boss',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '调用者（必须 boss）' },
          id: { type: 'string', description: '要连／断谁' },
          on: { type: 'boolean', description: 'true＝连接；false＝断开' },
        },
        required: ['memberId', 'id', 'on'],
      },
      run: async (memberId, args) => {
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可控制连接（第一层只有人能控）', notify: '该操作仅限派发者' };
        }
        if (!args.id) return { ok: false, error: '缺参数 id（目标成员）', notify: '未指定要连接的成员' };
        const on = args.on !== false;
        const reply = await askPlugin(args.id, PLUGIN_CONNECT_PATH, { memberId: args.id, on });
        if (!reply) {
          return {
            ok: false,
            error: `推不到插件（${args.id}）：插件未启动，或尚未上报门牌号`,
            notify: '无法连接插件（插件未启动？）',
          };
        }
        const connected = reply.connected === true;
        try {
          log.logEvent({
            type: 'state',
            who: args.id,
            why: on ? `老大叫它连上（${connected ? '已连' : '没连上'}）` : '老大让它断开连接',
            extra: { event: on ? 'connect' : 'disconnect', by: 'boss', connected },
          });
        } catch (_) { /* 日志失败不阻塞 */ }
        if (reply.ok === false) {
          const why = String(reply.error || '插件那边没连上');
          return { ok: false, error: why, notify: why };
        }
        return {
          ok: true,
          data: { id: args.id, connected },
          notify: connected ? `${args.id} 已连上` : `${args.id} 已断开`,
        };
      },
    },

    /** 账本消息（界面中栏用；可按天/按成员过滤） */
    read_messages: {
      description: '读账本消息（只读）：按天 YYYYMMDD 和/或成员过滤',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYYMMDD，缺省全部' },
          member: { type: 'string', description: '只看该成员相关（source 或 to 含它）' },
          limit: { type: 'integer', description: '最多返回条数（缺省 200）' },
        },
        required: [],
      },
      run: (memberId, args) => {
        const lim = (typeof args.limit === 'number' && args.limit > 0) ? args.limit : 200;
        let msgs = dl.readMessages();
        if (args.date) {
          const d = String(args.date);
          if (!/^\d{8}$/.test(d)) return { ok: false, error: `date 必须是 YYYYMMDD: ${d}`, notify: '日期格式不对' };
          msgs = msgs.filter((m) => m.time && String(m.time).startsWith(d));
        }
        if (args.member) {
          msgs = msgs.filter((m) => m.source === args.member || (Array.isArray(m.to) && (m.to.includes(args.member) || m.to.includes(ALL_RECIPIENT))));
        }
        return { ok: true, data: { count: msgs.length, messages: msgs.slice(-lim) } };
      },
    },

    /** 任务表（界面任务板用）：含派发者/轮次/日期 */
    list_tasks: {
      description: '读任务表（只读）：全部主任务，含派发者、每件子任务轮次、日期',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: () => {
        const board = dl.readMessages();
        // ⭐ 2026-10-05 优化（性能，**结果与原来逐字相同**）：原来**每件子任务**都要调一次
        //    `envelope.countRework(board, s.id)` —— 那是"对每件都从头扫一遍账本、再在账本里
        //    `find` 一次"，子任务一多就是 O(子任务数 × 账本长度²)。界面**每 5 秒**调一次这个工具。
        //    这里改成**先扫一遍账本**，把"每个子任务的打回次数"一次算完（O(账本长度)）。
        //    ⚠️ 与 `countRework` 同口径的两个细节，别改坏：
        //      ① `byId` 只收**第一条**同 id 的（`countRework` 用的是 `board.find` ＝ 第一条）；
        //      ② 只认 `inreplyto` 指向**交付**（`task.deliver`）的那些 `task.assign`。
        const byId = new Map();
        for (const m of board) if (!byId.has(m.id)) byId.set(m.id, m);
        const reworkOf = new Map();
        for (const m of board) {
          if (m.type !== 'task.assign' || !m.inreplyto) continue;
          const ref = byId.get(m.inreplyto);
          if (!ref || ref.type !== 'task.deliver') continue;
          const sid = ref.data && ref.data.task;
          if (sid) reworkOf.set(sid, (reworkOf.get(sid) || 0) + 1);
        }
        const tasks = dl.listTasks().map((t) => {
          const assignMsg = board.find((m) => m.type === 'task.assign' && m.data && m.data.task === t.id);
          const subs = (t.subtasks || []).map((s) => ({
            id: s.id,
            to: s.to,
            timeout: s.timeout,
            heavy: s.heavy,
            note: s.note,
            state: s.state,
            stateUpdatedAt: s.stateUpdatedAt,
            // 轮次 = 打回次数 + 1（同一件任务、id 沿用原号，按 inreplyto 链数）；⚠️ 不是"换过几个人"
            rounds: (reworkOf.get(s.id) || 0) + 1,
          }));
          return {
            id: t.id,
            // ⭐ 日期取 createdAt —— 不能切 id 前 8 位：老大派的 id 带 `boss-` 前缀，前 8 位不是日期
            date: String(t.createdAt || '').slice(0, 8),
            byBoss: String(t.id).startsWith('boss-'), // 任务板上标"老大"（`04` §4）
            title: t.title,
            note: t.note,
            from: assignMsg ? assignMsg.source : null,
            closed: !!t.closed,
            closedAt: t.closedAt || null,
            closedBy: t.closedBy || null,
            subtasks: subs,
            rounds: subs.reduce((mx, s) => Math.max(mx, s.rounds), 0),
          };
        });
        return { ok: true, data: { count: tasks.length, tasks } };
      },
    },

    /** 系统日志（界面日志视图用）：M7 事件日志 .jsonl，按天一个文件（2026-10-03 统一） */
    read_log: {
      description: '读系统日志（只读）：按天 YYYYMMDD，缺省今天；日志 = 日志\\<日期>.jsonl',
      inputSchema: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYYMMDD，缺省今天' } },
        required: [],
      },
      run: (memberId, args) => {
        let d = args.date ? String(args.date) : stampNow().slice(0, 8);
        if (!/^\d{8}$/.test(d)) return { ok: false, error: `date 必须是 YYYYMMDD: ${d}`, notify: '日期格式不对' };
        let entries = [];
        try {
          entries = entries.concat((log.readLog(d) || []).map((e) => ({
            time: e.ts || '',
            event: e.type || '',
            taskId: e.taskId,
            subId: e.subId,
            who: e.who,
            why: e.why || '',
            extra: e.extra || null,
          })));
        } catch (_) {}
        entries.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
        return { ok: true, data: { date: d, count: entries.length, entries } };
      },
    },

    /** 我的文件夹（界面「我的文件夹」按钮用）：老大自己定的那个目录，没设过就是 收件\ */
    inbox_path: {
      description: '我的文件夹绝对路径（界面「我的文件夹」按钮用；老大自己定过就用他定的）',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: () => {
        const p = dirs.myFolder();
        return { ok: true, data: { path: p, isCustom: p !== dirs.INBOX_DIR } };
      },
    },

    /** 设置我的文件夹（界面里改路径；2026-10-03 加：老大要能自定义） */
    set_my_folder: {
      description: '设置「我的文件夹」指向哪（要绝对路径；目录不存在会自动建）',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '新的绝对路径，比如 D:\\我的文件' } },
        required: ['path'],
      },
      run: (memberId, args) => {
        // ⭐ 2026-10-05 加：**只认 boss**（同 `open_folder`）—— 这是**全局设置**（老大自己定的那个目录），
        //    不能让任何一个连着的成员把它改走。
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可修改「我的文件夹」（设置面板）', notify: '该设置仅限派发者修改' };
        }
        try {
          const p = dirs.setMyFolder(args && args.path);
          return { ok: true, data: { path: p }, notify: '我的文件夹改成：' + p };
        } catch (e) {
          const m = String((e && e.message) || e);
          return { ok: false, error: m, notify: m };
        }
      },
    },

    /** 打开文件夹（界面点「我的文件夹」、点消息里的路径都走这里）
     *  ⚠️ 2026-10-03：原来界面是把路径写进网页标题、壳轮询窗体标题 —— 那条通道根本不通
     *  （网页改 document.title 不会改 WinForms 窗体标题），所以改由后端直接调 explorer。 */
    open_folder: {
      description: '打开一个文件夹（界面用）；给文件路径则打开它所在目录并选中它',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: '要打开的绝对路径' } },
        required: ['path'],
      },
      run: async (memberId, args) => {
        // ⭐ 2026-10-05 加：**只认 boss**（正本＝规范 `接入\02` §2.2 那张"只认 `boss` 的九个"表）——
        //    这个口会在**老大的机器上弹出资源管理器**，不能谁都能调。
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可打开文件夹（界面按钮）', notify: '该操作仅限派发者' };
        }
        const r = dirs.openArg(args && args.path);
        if (!r.ok) return { ok: false, error: '打不开：' + r.reason };
        // ⚠️⚠️ 2026-10-08 二次改（老大拍板"让壳去开"）：
        //    **后端不再自己起 `explorer.exe`** —— 在这条进程链里起它会被 `0xC0000142`
        //    （STATUS_DLL_INIT_FAILED，进程初始化就失败）挡掉：实测退出码 **3221225794**，
        //    而**同一时刻、同一目标、壳自己起 explorer 是成功的**（`-SelfTest` 实测 `exitCode=1`）。
        //    ⇒ 分工改成：**这里只写一个请求文件**（`运行\数据\开文件夹请求.json`），
        //      **壳每 500ms 看一次，看到就开**（见 `程序\壳\OfficeShell.ps1` 的 `Start-OpenFolderWatcher`）。
        //    ⚠️ 交接判据：**壳开之前先把请求文件收掉** ⇒ 这边靠"文件还在不在"判断壳有没有接走。
        //      （壳没在跑 ⇒ 文件一直在 ⇒ 如实报失败，不再出现"弹已打开但没开"。）
        try {
          const reqFile = path.join(dl.DATA_DIR, '开文件夹请求.json');
          fs.writeFileSync(reqFile, JSON.stringify({ path: r.arg, at: Date.now() }), 'utf8');
          let taken = false;
          for (let i = 0; i < 12; i++) {           // 最多等 3 秒（壳 500ms 一轮）
            await new Promise((res) => setTimeout(res, 250));
            if (!fs.existsSync(reqFile)) { taken = true; break; }
          }
          try {
            log.logEvent({
              type: 'state',
              who: 'boss',
              why: taken ? '打开文件夹：壳已接走' : '打开文件夹：壳没来接（请求文件还在）',
              extra: { path: r.arg, reqFile, taken },
            });
          } catch (_) {}
          if (!taken) {
            try { fs.unlinkSync(reqFile); } catch (_) {}   // 别留垃圾
            return { ok: false, error: '壳没来接（办公室壳没在跑？）', notify: '打开失败：壳没接走请求（详情见系统日志）' };
          }
          return { ok: true, data: { opened: r.arg } };
        } catch (e) {
          const m = String((e && e.message) || e);
          return { ok: false, error: '请壳开文件夹失败：' + m };
        }
      },
    },

    /**
     * ⭐ 2026-10-04 加（规范 `04` §7.4「路径能手填、也能挑」；老大：「**给个按钮让我选路径，
     * 总不能让我自己填吧**，不过自己填这个可以留着，就是旁边多加一个按钮」）：
     * 弹**系统自带的"选择文件夹"窗口**，给界面那个「浏览…」按钮用。
     * ⚠️ 弹系统窗口这件事**界面自己做不到** ⇒ 由后端起一个 PowerShell 去弹、把选中的路径回给界面
     * （跟 `open_folder` 同一条路子：界面 → HTTP → 后端 → 系统）。
     */
    pick_folder: {
      description: '弹系统的"选择文件夹"窗口让人挑一个目录（界面「浏览…」按钮用）；取消 ⇒ 回 { canceled: true }',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', description: '窗口上的提示语（可选）' } },
        required: [],
      },
      run: async (memberId, args) => {
        // ⭐ 2026-10-05 加：**只认 boss**（同 `open_folder`）—— 这个口会在老大机器上**弹一个系统窗口**，
        //    而且**框上的提示语是调用方给的**（现成的钓鱼面）。
        if (memberId !== 'boss') {
          return { ok: false, error: '仅派发者可弹出选择窗口（界面「浏览…」按钮）', notify: '该操作仅限派发者' };
        }
        if (pickingFolder) return { ok: false, error: '已有一个选择窗口开着' };
        pickingFolder = true;
        // ⭐⭐ 2026-10-05 修（**老大实测撞出来的真 bug**：选了个中文文件夹，回填成 `D:\bilibili????`）：
        //    原来靠 `[Console]::Out.Write($d.SelectedPath)` 输出、Node 按 utf8 解 —— 而**PowerShell 5.1 的
        //    stdout 一旦被重定向到管道，它用的就不再是"控制台代码页"（本机是 UTF-8／65001）了** ⇒
        //    中文**编不出去**，直接变成 `?`（0x3F，一个都没剩）。⚠️ 教训：我当时是"拿控制台代码页推的"，
        //    判据选错了 —— 这里起作用的是**重定向后 stdout 的编码**，跟控制台那个不是一回事。
        //    ⇒ 改成**彻底不经过控制台**：让 PowerShell 把结果**写进一个临时文件**（显式 UTF-8），Node 读文件。
        //    ⭐⚠️ 2026-10-05 二次修（老大实测"选不了、变没选"）：临时文件**从 `os.tmpdir()` 挪到
        //      办公室自己的数据目录**（`运行\数据\`）—— 那目录**后端一直在写**（board.jsonl 等）⇒
        //      肯定可写；而且**我事后能直接去看那个文件**、不必猜。
        const tmpFile = path.join(dl.DATA_DIR, `取文件夹-${process.pid}-${Date.now()}.txt`);
        try {
          // ⚠️ 提示语与临时文件路径都是拼进 **PowerShell 字符串**的 ⇒ 单引号要双写（PowerShell 的转义规则）
          const title = String((args && args.title) || '选一个文件夹').replace(/'/g, "''");
          const tmpPs = tmpFile.replace(/'/g, "''");
          const script = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
            `$d.Description = '${title}'`,
            '$d.ShowNewFolderButton = $true',
            `if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [System.IO.File]::WriteAllText('${tmpPs}', $d.SelectedPath, (New-Object System.Text.UTF8Encoding($false))) }`,
          ].join('; ');
          // `-STA`：FolderBrowserDialog 要求单线程套间（powershell.exe 5.1 本来默认就是，显式写更稳）
          const kid = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true });
          // ⚠️ stdout／stderr **还是要消费掉**（不读的话管道缓冲区满会把子进程堵住）；同时**留着内容**——
          //    出问题时它是唯一的现场（2026-10-05 上一版把 stderr 直接丢了，结果"选不了"查无可查）。
          let out = '';
          let err = '';
          kid.stdout.on('data', (b) => { out += b.toString('utf8'); });
          kid.stderr.on('data', (b) => { err += b.toString('utf8'); });
          // ⚠️ 兜底：人一直不选，不能把这次请求挂死在那里
          const timer = setTimeout(() => { try { kid.kill(); } catch (_) { /* 已经退了 */ } }, 5 * 60 * 1000);
          const code = await new Promise((resolve) => {
            kid.on('close', (c) => resolve(c));
            kid.on('error', () => resolve(-1));
          });
          clearTimeout(timer);
          // ⭐ 2026-10-05 加：**把这一步的实况记进系统日志** —— 上一版"选不了、变没选"就是因为这一路
          //    全静默（PS 的 stderr 被丢、结果文件没写出来也看不出来）⇒ 落一行，事后能查。
          try {
            const hasFile = fs.existsSync(tmpFile);
            log.logEvent({
              type: 'state', who: 'boss',
              why: `弹选择窗口：退出码=${code}，结果文件=${hasFile ? '有' : '没有'}`,
              extra: {
                event: 'pick-folder', code, file: tmpFile, hasFile,
                out: String(out || '').slice(0, 300),
                err: String(err || '').slice(0, 500),
              },
            });
          } catch (_) { /* 记账失败别拦这次选取 */ }
          // ⭐ 结果**从临时文件读**（显式 UTF-8，与控制台编码无关）；读不到就是"没选／取消了"。
          let picked = '';
          try {
            if (fs.existsSync(tmpFile)) picked = String(fs.readFileSync(tmpFile, 'utf8') || '').trim();
          } catch (_) { picked = ''; }
          if (!picked) return { ok: true, data: { canceled: true } };
          return { ok: true, data: { path: picked } };
        } catch (e) {
          return { ok: false, error: '弹选择窗口失败：' + String((e && e.message) || e) };
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (_) { /* 删不掉就算了（下次同名也不会撞：名字带 pid＋时间戳） */ }
          pickingFolder = false;
        }
      },
    },

    /** 我的产出目录（成员问"我该把东西写哪"）：按天建好、返回绝对路径 */
    my_dirs: {
      description: '我的产出目录：返回我今天的产出目录绝对路径（目录自动建好，直接拿去写文件）',
      inputSchema: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: '我（成员 id）' },
        },
        required: ['memberId'],
      },
      run: (memberId, args) => {
        const id = args.memberId || memberId;
        if (!id) return { ok: false, error: '缺参数 memberId（调用者）', notify: '缺少成员身份（memberId）' };
        try {
          const date = dirs.dateStamp();
          return { ok: true, data: { path: dirs.workDir(id, date), date } };
        } catch (e) {
          const m = String((e && e.message) || e);
          return { ok: false, error: m, notify: m };
        }
      },
    },

    /** 待处理提示（界面待处理弹窗/角标用）：判挂待确认 + 超时告知 */
    pending_alerts: {
      description: '待处理提示：判挂（等老大点"我知道了"）＋ 今天超时告知',
      inputSchema: { type: 'object', properties: {}, required: [] },
      run: () => {
        const alerts = [];
        const dead = (timeout && typeof timeout.listRefuseDeadConfirm === 'function')
          ? timeout.listRefuseDeadConfirm()
          : [];
        for (const c of dead) {
          alerts.push({
            kind: 'refuse-dead',
            subId: c.subId,
            taskId: c.taskId,
            to: c.to,
            taskTitle: c.taskTitle || '',
            taskNote: c.taskNote || '',
            subNote: c.subNote || '',
            text: '执行者无法完成、派发者未回应，任务已停止',
            action: 'ack_refuse_dead',
          });
        }
        // ⚠️ 2026-10-04 修：这里原来读 `日志\<今天>.log`，而日志从 2026-10-03 起统一只写 `.jsonl`
        //    ⇒ 那个 `.log` 文件一直是 0 字节，界面上的"超时告知"压根没显示过。改成读正式日志。
        // ⭐ 2026-10-05 改：**挑法与文案挪进 `alertFeed()`**（本文件上方）—— 原来那段筛选在这儿内联着，
        //    新增「已处理」（`read_alerts`）时若照抄一份 ⇒ 两处迟早漂（判据、文案各说各话）。
        //    现在两边共用同一套，**改一处就够**（判据里的来龙去脉见 `alertFeed` 上方注释）。
        //    ⚠️ 这里**不**要 `refuse-dead-notify`（`includeRefuseDead` 缺省 false）：那条另有来源
        //    —— 就是上面内存里"等确认"那张表；从日志里再挑一遍会**重复一条**。
        const today = stampNow().slice(0, 8);
        try { alerts.push(...alertFeed(today)); } catch (_) { /* 日志读不到不算致命 */ }
        return { ok: true, data: { count: alerts.length, alerts } };
      },
    },

    /**
     * 已处理（告警历史）：按天读日志里那几类告知 —— 界面「🗂 已处理」按钮用（规范 `04-功能清单` §7.8）。
     * ⚠️ 与「待处理」**同一口径**（都走 `alertFeed`），只有两点不同：
     *   ① 它能翻**任意一天**（缺省今天）；② 它把 `refuse-dead-notify` 也列进来（历史里要能翻到那一条）。
     * ⚠️ **只读**：不提供确认／重派等动作 —— 要动作回「待处理」。
     */
    read_alerts: {
      description: '读告警历史（按天；缺省今天）：判挂／超时／「派发后不表态」／「干不了＋派发者死」／系统代收',
      inputSchema: {
        type: 'object',
        properties: { date: { type: 'string', description: 'YYYYMMDD，缺省今天' } },
        required: [],
      },
      run: (memberId, args) => {
        const day = (args && args.date) ? String(args.date).trim() : stampNow().slice(0, 8);
        const alerts = alertFeed(day, { includeRefuseDead: true });
        alerts.sort((a, b) => String(b.time).localeCompare(String(a.time)));   // 倒序：新的在上
        return { ok: true, data: { date: day, count: alerts.length, alerts } };
      },
    },
  };

  /* ⭐⭐ 调试模式（2026-10-04 老大定）—— 设置面板里那个开关，**只认 `boss`**。
     开着 ⇒ **跳过下面那道「没连着就不许调工具」的门**（做测试时要能绕过去）。
     ⚠️ 规矩见 `规范\04-功能清单.md` §7.7：**开/关都要留痕**、**每次"走后门"的调用也要留痕**、
        **开着时主界面要挂醒目标记**（防的是"开着忘了关"）。
     ⚠️ 只放内存：办公室重启即回到"关"（**默认关**，这正合"临时口子"的定位）。 */
  let debugBypass = false;
  /** ⭐ 2026-10-05 加：最后一次"经它放行"的时刻（自动过期用，见下面 `isDebugBypass`）。 */
  let debugTouchedAt = 0;
  /** 调试模式闲置多久自动关 —— **写死 30 分钟**（`04-功能清单` §7.7 第 5 条：不做成可配置）。 */
  const DEBUG_IDLE_MS = 30 * 60 * 1000;
  /**
   * ⭐ 2026-10-05 加：**自动过期**（`04-功能清单` §7.7 第 5 条）——
   * 它最危险的情形是「**人不在场时开着忘了关**」，而界面上那个醒目标记**只在人正看着时才有用**。
   * ⇒ 自最后一次放行起**满 30 分钟没有新的** ⇒ 自动关回（关的那一刻照样留痕）。
   */
  function isDebugBypass() {
    if (debugBypass !== true) return false;
    if (Date.now() - debugTouchedAt > DEBUG_IDLE_MS) {
      debugBypass = false;
      try {
        log.logEvent({
          type: 'state',
          who: 'boss',
          why: '调试模式：超时自动关（30 分钟没有经它放行的调用）',
          extra: { event: 'debug-auto-off' },
        });
      } catch (_) { /* 记账失败别把开关带崩 */ }
      return false;
    }
    return true;
  }

  /* ⭐⭐ 界面口令（2026-10-05 老大定）—— `boss` 这个身份**只有界面在用**，
     而"报一行 boss"谁都会 ⇒ boss 的调用须**附上口令**（请求头 `X-Office-UI`）。
     ⚠️ 口令由**壳每次启动随机生成**，只经内存走两条路（环境变量给后端、拼界面 URL 给页面），**不落盘**。
     ⚠️ 没设环境变量（不经壳、手工 `node server.js` 起的）⇒ **放行但逐条留痕** —— 否则界面当场全废、也没逃生口。
     正本：`文档\规范\接入\01-接入与连接.md` §2.4、`文档\规范\04-功能清单.md` §7.7 第 1 条。 */
  const uiToken = String(process.env.OFFICE_UI_TOKEN || '');
  /** 口令对不对。⚠️ 后端手里没有口令 ⇒ 一律 true（退化口径，调用处另外留痕）。 */
  function isUiTokenOk(token) {
    if (!uiToken) return true;
    return String(token || '') === uiToken;
  }

  /**
   * 统一工具分发（MCP tools/call 与 HTTP /api/call 共用，不是两套逻辑）
   * ⚠️ 2026-10-04 改成 **async**：个别工具要**等插件回话**才知道成没成（`call_online` 要报
   *    「上线异常」，见 `接入\01` §2.4）⇒ **调用方必须 `await` 它**。两个口都跟上了：
   *    stdio 那边本来就是 `await Promise.resolve(...)`、http 那三处补了 `await`。
   */
  async function invokeTool(memberId, tool, args, opts) {
    const t = tools[tool];
    if (!t) return { ok: false, error: `不认识工具: ${tool}`, notify: `不认识的操作: ${tool}` };
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      return { ok: false, error: 'args 必须是对象', notify: '参数必须是对象' };
    }
    // ⭐⭐ `boss` 须自证是界面（2026-10-05 老大定）—— **光报 boss 不算数**。
    //    判据 ＝ 请求头 `X-Office-UI` 带的界面口令对不对（口令由**壳每次启动随机生成、不落盘**）。
    //    正本：`规范\接入\01-接入与连接.md` §2.4、`规范\04-功能清单.md` §7.7 第 1 条。
    //    ⚠️ **退化**：后端手里没有口令（不经壳、手工 `node server.js` 起的）⇒ 放行，但下面逐条留痕。
    if (memberId === 'boss' && !isUiTokenOk(opts && opts.uiToken)) {
      return {
        ok: false,
        error: '这个身份只认界面：boss 的调用要带界面口令（X-Office-UI），这次没带或不对',
        notify: '该操作仅限界面，请从办公室界面上操作',
      };
    }
    if (memberId === 'boss' && !uiToken) {
      try {
        log.logEvent({
          type: 'state',
          who: 'boss',
          why: `界面口令未启用（后端不是壳起的），放行：${tool}`,
          extra: { event: 'ui-token-absent', tool },
        });
      } catch (_) { /* 记账失败不拦调用 */ }
    }
    // ⭐⭐ 一道门：**没连着就不许调工具**
    //    （2026-10-04 老大定：「**裸连进来的不行，只有通过插件的可以**」
    //      ＋「**mcp 那个口不是嘴上说只能插件才能连，代码也要落实下去**」）
    //    判据 ＝ 它在接入连接表（`aliveConns`）里有没有那条连接 —— 跟"在线／离线"是**两格**。
    //    ⚠️ 门设在这一处就够了：四个入口（`/api/call`、`/api/message`、`/api/members`、
    //       stdio 代理）最后**都汇到这个函数** ⇒ **stdio 那个口一样跑不掉**。
    //    ⚠️ **例外只有 `boss`**：他没有接入端，界面调工具用的就是这个身份 ⇒ 不给他开例外，
    //       整个界面（成员列表／任务板／日志／派发…）会当场全废。
    //    ⚠️ **报到/上线不单独开例外**（老大 2026-10-04：「**4 不要例外**」）⇒ 接入端必须
    //       **先挂连接、再报到**（顺序是 `接入\01` §2.4 写死的）。
    // ⭐ 2026-10-05 加：挂了连接还不够 —— **已成卡的成员必须带对"接入手续"**（正本＝规范 `接入\01` §2.4）。
    //    判据：`none`／`bad` ⇒ **拒**；`fresh`（办公室还没它的卡）⇒ **放行** —— 不给这一档，
    //    新人永远领不到卡（领卡要调 `register`，`register` 也走这道门 ⇒ 死锁）；
    //    `changed`（换过面孔）⇒ 也**先放行＋留一笔** —— 界面上那个"认一次"还没做，收紧会把宿主升级的人锁死。
    const accState = (memberId === 'boss') ? 'ok' : accessStateOf(memberId);
    if (memberId !== 'boss' && !isDebugBypass() && (accState === 'none' || accState === 'bad')) {
      try {
        log.logEvent({
          type: 'reject',
          who: memberId,
          why: '接入手续没对上（' + accState + '），拒：' + tool,
          extra: { event: 'access-refused', memberId, state: accState, tool },
        });
      } catch (_) { /* 记账失败不拦判断 */ }
      return {
        ok: false,
        error: '接入手续没对上：' + memberId + ' 挂着连接，但未携带或携带了错误的成员卡（规范 接入\\01 §2.4）',
        notify: '该成员已有卡，接入时需携带这张卡（id／加入时间／宿主进程名／头像）',
      };
    }
    if (memberId !== 'boss' && !isDebugBypass() && !isConnected(memberId)) {
      return {
        ok: false,
        error: `没连着就不能调工具：${memberId} 现在没有接入连接（先按规范挂上连接、再报到）`,
        notify: '该成员尚未连接办公室，请先挂上连接',
      };
    }
    // ⚠️ 这条是走「调试模式」后门进来的 ⇒ **留痕**（`04-功能清单` §7.7 第 3 条：
    //    事后要查得出来是谁、什么时候、调了什么）。只记"本来会被拦下的"那些。
    if (memberId !== 'boss' && isDebugBypass() && !isConnected(memberId)) {
      // ⭐ 2026-10-05 加：**经它放行 ⇒ 刷新自动过期的计时**（`04-功能清单` §7.7 第 5 条）
      //    —— 不刷的话，正用着它也会在 30 分钟那一刻被关掉。
      debugTouchedAt = Date.now();
      try {
        log.logEvent({
          type: 'state',
          who: memberId,
          why: `调试模式放行：${tool}`,
          extra: { event: 'debug-bypass', tool, memberId },
        });
      } catch (_) { /* 记账失败不拦调用 */ }
    }
    try {
      const r = await t.run(memberId, args);
      return r || { ok: false, error: '工具无返回', notify: '操作无返回' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), notify: String((e && e.message) || e) };
    }
  }

  /** 工具清单（MCP tools/list 用） */
  function listTools() {
    return Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  // ─────────────── 启动两口 ───────────────

  // ─────────────── 接入连接表（2026-10-03：心跳＝"它还连着"） ───────────────
  // 依据：老大 2026-10-03 令「不要让 mcp 自己报，变成系统去看 mcp 有没有连着，十秒同时看一次」
  // 口径：接入端挂一条 GET /api/alive（SSE 流）＝"连着"；后端每 1 秒往每条连接写一下，
  //       写得进去＝它还在（顺手刷新心跳），写不进去／连接已断＝它掉了。判定只在后端这一处。
  // ⚠️ 刷新走的仍是 status.receiveHeartbeat ⇒ 被老大踢下线的人（offlineReason:'kick'）状态不动。
  // ⚠️ 是 **`Set`**（元素＝每条形如 `{ memberId, res, lastPing, card, probe }` 的连接对象），不是数组
  //    —— 2026-10-05 修注释：原文写成 `[{ … }]`，读的人会以为能按下标取。
  const aliveConns = new Set();

  /** 接入端挂上一条连接（＝它连着）；带了 memberId 就顺手刷一次心跳 */
  function attachAlive(memberId, res, rawCard) {
    const conn = { memberId: memberId || '', res, lastPing: Date.now() };
    // ⭐⭐ 接入手续（2026-10-05）：挂连接时报上来的那四格，跟办公室里那份逐格比。
    //    ⚠️ **比出来的结果门是看的**（2026-10-05 同日升级，见 `invokeTool` 里那段）：
    //    `none`／`bad` ⇒ **拒**；`fresh`／`changed` ⇒ 放行（各有理由，正本＝规范 `接入\01` §2.4 那张表）。
    //    （旧注释写的"现阶段只比对、只记录"**已过期** —— 那是升级前的状态。）
    conn.card = compareCard(conn.memberId, rawCard);
    aliveConns.add(conn);
    // ⭐⭐ 探活（第 2 刀，2026-10-05）：挂上就顺手探一次。⚠️ **不 await** ——
    //    不能让一次推送把"连接建立"拖住（探活慢／对端没开，都不该影响它挂上）。
    //    结果异步写到 `conn.probe`；正本＝规范 `接入\01` §2.4「探活」。
    try { probeConn(conn); } catch (_) { /* 探活自己会兜，别影响挂连接 */ }
    // ⚠️ 只有"没认过／不对"才留痕 —— 认过的**不记**，免得把日志刷满（挂连接／断连接都是常事）。
    // ⚠️ 2026-10-05 修：**「新人第一次领卡」（`fresh`）不算"没走插件"** —— 它是**正规流程**
    //    （库清过之后，谁第一次连都得先领卡）；记进去会让界面上凭空冒出一句"有人没走插件"（老大撞到）。
    //    真该记的是两种：**认过的人带了对不上的卡**、**压根没带的**。
    if (conn.card.state !== 'ok' && conn.card.state !== 'fresh') {
      try {
        log.logEvent({
          type: 'state',
          who: conn.memberId || '(未报)',
          why: '接入手续：' + (CARD_STATE_TEXT[conn.card.state] || conn.card.state) +
               (conn.card.detail ? ('（' + conn.card.detail + '）') : ''),
          extra: { event: 'access-unverified', memberId: conn.memberId, state: conn.card.state, detail: conn.card.detail || '' },
        });
      } catch (_) { /* 记账失败不拦连接 */ }
    }
    if (memberId) {
      // ⭐ 2026-10-05 加（老大令「来修第二点」）：**人重新点「连接」⇒ 把"断开连接"的记号清掉**。
      //    规范 `接入\01` §2.2 的分界线表：「断开连接 ⇒ 真断 ⇒ **要恢复得人重新点「连接」**」
      //    ⇒ 那句话隐含"线回来了就该能再上线"；而代码里**以前没有任何地方清这个记号**
      //    ⇒ 「被断开连接」的成员不重启后端就**永远回不来**（当天实测撞到：假人死活上不去）。
      //    ⚠️ 凭什么叫"人点的"：同份规范 line 216 ——「接入端**不得"断了自己连回来"**，
      //       **插件侧已改到位**（不再自动重连）」⇒ **新挂上来的连接只可能是人点的**。
      //    ⚠️ 只清记号、**不动 presence**：它仍是离线，等再点一次「上线」才算在线 ——
      //       那正是规范说的两步（先「连接」、再「上线」）。
      if (typeof status.clearDisconnectMark === 'function' && status.clearDisconnectMark(memberId)) {
        try {
          log.logEvent({
            type: 'state',
            who: memberId,
            why: '重新挂上连接，已清除「断开连接」标记（现在可以再点上线）',
            extra: { event: 'disconnect-mark-cleared', memberId },
          });
        } catch (_) { /* 记账失败不拦连接 */ }
      }
      status.receiveHeartbeat(memberId);
    }
    return conn;
  }

  /**
   * ⭐ **那条线一没，立刻判它离线** —— 规范 `接入\01` §2.1：「**已断开 ⇒ 一定未上线**」。
   * ⚠️ 2026-10-04 加：原来这三处只管把连接从表里摘掉，判离线全靠 `sweepOffline`（约 20 秒才跑）⇒
   *    那 20 秒里卡上会显示"**在线 ＋ 未连接**"（自相矛盾）；更糟的是**断开后 20 秒内重连**，
   *    看上去就是"**重连一下自己就回在线了**" —— 那正是老大明令不要的"自动上线"。
   * 走 `heartbeat` 那档 ⇒ 它**自己能上线回来**（只有 `disconnect` 那档上不来）。
   */
  function offlineIfNoConn(memberId) {
    if (!memberId) return;
    try {
      const still = [...aliveConns].some((c) => c && c.memberId === memberId);
      if (still) return;                                  // 还有别的连接挂着 ⇒ 不算断
      status.setPresence(memberId, 'offline', 'heartbeat');
    } catch (_) { /* 判离线失败不阻塞连接回收 */ }
  }

  /** 接入端断开：从表里摘掉 **＋ 顺手判它离线** */
  function detachAlive(conn) {
    aliveConns.delete(conn);
    if (conn) offlineIfNoConn(conn.memberId);
  }

  /**
   * ⭐ 把某个成员的接入连接**真断掉**（"断开连接"那条路要用，`接入\01` §2.2）
   * ⚠️ 只标状态不算 —— 线还挂着的话，它下次心跳就又活了，那样"断开"就没意义。
   */
  function closeAliveConns(memberId) {
    for (const conn of [...aliveConns]) {
      if (conn.memberId !== memberId) continue;
      aliveConns.delete(conn);
      try { conn.res.end(); } catch (_) { /* 已经关了就算了 */ }
    }
    offlineIfNoConn(memberId);
  }

  /**
   * 扫一遍所有接入连接（每 1 秒一轮）
   * @returns {number} 当前连着几条
   */
  /* ⭐⭐ 接入手续：那四格怎么比（2026-10-05 定；正本＝规范 `接入\01` §2.4 ＋ `02` §4）
     四种结果：ok（四格全对）／changed（`name`／`icon` 变了，`id`＋`joined` 还对）／none（没带）／bad（id／joined 对不上、解不开）。
     ⚠️ 现阶段**只比对、只记录** —— "没认过就不算连着"要等接入端会带这个头之后再落地（顺序不能反）。 */
  const CARD_STATE_TEXT = {
    ok: '认过',
    changed: '换过面孔',
    none: '没认过（没带手续）',
    bad: '不对',
    fresh: '新人（办公室还没有它的卡）',
  };
  /** 参与核对的四格（`02` §4：只有它们**不随运行变**；`nick`／`model`／门牌号会变，不参与）。 */
  const CARD_FIELDS = ['id', 'joined', 'name', 'icon'];

  /**
   * 把接入端报上来的那四格跟办公室里那份逐格比。
   * @param {string} memberId 它报的 id（连接上的 memberId）
   * @param {object|null} rawCard 它报的四格（`X-Office-Card` 解出来的）
   * @returns {{state:string, detail?:string}} ok／changed／none／bad／fresh
   */
  function compareCard(memberId, rawCard) {
    if (!memberId) return { state: 'bad', detail: '连接上没报 memberId' };
    // ⭐⭐ 2026-10-05 修（**真事故**：清库之后插件空手来，本该走"新人"放行、却被判成 `none` 拒掉 ⇒ 上不了线）：
    //    **"办公室有没有它这张卡"必须先判** —— 新人本来就没卡，当然也没东西可带；
    //    把"带没带"判在它前面，等于**新人永远走不到放行那一档**（领卡要调 `register`，而 `register` 也走这道门 ⇒ 死锁）。
    //    规范 `接入\01` §2.4 那张表本来就是这个顺序，是这里的实现没跟上。
    const m = members.getMember(memberId);
    if (!m) return { state: 'fresh', detail: '办公室还没有这张卡（`02` §5 领账号零门槛，第一次允许裸挂）' };
    if (!rawCard || typeof rawCard !== 'object') return { state: 'none' };
    // ⚠️ "没带"和"带坏了"要分得开：没带 ＝ 它还没实现这套手续；带坏了 ＝ 带了但格式不对 —— 排查时是两回事。
    if (rawCard.__bad) return { state: 'bad', detail: String(rawCard.__reason || '手续解不开') };
    const mine = {};
    for (const k of CARD_FIELDS) {
      const v = rawCard[k];
      mine[k] = String(v === undefined || v === null ? '' : v);
    }
    if (mine.id !== String(m.id || '')) return { state: 'bad', detail: 'id 对不上' };
    if (mine.joined !== String(m.joined || '')) return { state: 'bad', detail: '加入时间对不上' };
    const nameOk = mine.name === String(m.name || '');
    const iconOk = mine.icon === String(m.icon || '');
    if (nameOk && iconOk) return { state: 'ok' };
    const diff = [(!nameOk ? '宿主进程名' : ''), (!iconOk ? '头像' : '')].filter(Boolean).join('、');
    return { state: 'changed', detail: diff + '变了（按规范要人在界面上认一次）' };
  }

  /**
   * ⭐ 2026-10-05：某个成员**现在这条接入连接的手续**是什么（没连接 ⇒ `null`）。
   * 一个成员可能同时挂着多条（重连时新旧并存）⇒ **取最宽的那个**：有一条"认过"就算认过。
   * ⚠️ 这不会降低安全性 —— 要凑出一条 `ok`，它得先真是本人。
   * 正本＝规范 `接入\01` §2.4 那张"门怎么处置"表。
   */
  function accessStateOf(memberId) {
    const order = ['ok', 'fresh', 'changed', 'bad', 'none'];   // 越靠前越宽
    let best = null;
    let bestIdx = 99;
    for (const conn of aliveConns) {
      if (!conn || conn.memberId !== memberId) continue;
      const st = (conn.card && conn.card.state) || 'none';
      let i = order.indexOf(st);
      if (i < 0) i = 99;                                       // 没见过的状态 ⇒ 当最严处理
      if (i < bestIdx) { bestIdx = i; best = st; }
    }
    return best;
  }

  /* ⭐⭐ 探活（2026-10-05 加；正本＝规范 `接入\01` §2.4「探活」）——
     往成员卡里的**门牌号**推一个随机数，接入端得算出 `sha256(id + "/" + nonce)` 的小写 hex 回来。
     答得出来 ⇒ 它真的在那个宿主里跑着、真的在监听那个端点（补的是"去成员卡里把那四格照抄一遍"那一档）。
     ⚠️ 现阶段**只记不拦** —— 宿主没开／端口变了／推超时都会 fail，先看几天真实数据再谈收紧。
     ⚠️ 没有门牌号的（新人第一次、脚本型接入端）⇒ `n/a`（不适用），**不硬套**。 */

  /** 应答算式 —— 办公室和接入端**必须算得一模一样**（规范里写死了这个式子）。 */
  function challengeAnswer(id, nonce) {
    return crypto.createHash('sha256').update(String(id) + '/' + String(nonce), 'utf8').digest('hex');
  }

  /**
   * 探一条连接（异步，**不阻塞挂连接**）。结果直接写在 `conn.probe` 上。
   * @param {object} conn `aliveConns` 里那个对象
   */
  function probeConn(conn) {
    const memberId = conn && conn.memberId;
    if (!memberId) return;
    const card = members.getMember(memberId);
    if (!card || !card.host) {
      conn.probe = { state: 'n/a', detail: '还没有门牌号（报到之后才有）' };
      return;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    const want = challengeAnswer(memberId, nonce);
    askPlugin(memberId, PLUGIN_CHALLENGE_PATH, { memberId, nonce }, 4000).then((reply) => {
      const got = (reply && typeof reply.answer === 'string') ? reply.answer.toLowerCase() : '';
      if (reply && reply.ok !== false && got === want) {
        conn.probe = { state: 'ok' };   // ⭐ 探通的**不记**（跟"认得过的卡"一个道理：别把日志刷满）
        return;
      }
      conn.probe = { state: 'fail', detail: got ? '应答对不上' : '没答上来' };
      try {
        log.logEvent({
          type: 'state', who: memberId,
          why: '探任务没通过：' + conn.probe.detail + '（现阶段只记不拦）',
          extra: { event: 'probe-fail', memberId, detail: conn.probe.detail },
        });
      } catch (_) { /* 记账失败不影响连接 */ }
    }).catch(() => { /* `askPlugin` 自己会记一条"问插件失败"，这里不再记一遍 */ });
  }

  /**
   * ⭐ 2026-10-05 加：把某个成员**现在挂着的所有连接**重探一遍。
   * 为什么要有它：门牌号是**报到时**才报上来的，而探活在**挂连接那一刻**跑 ——
   * 那会儿它还是"没有门牌号 ⇒ `n/a`"（规范里写了"新人第一次必然 n/a"）。
   * ⇒ 报到成功后再补探一次，就不必白等一次重连。
   */
  function probeMemberConns(memberId) {
    for (const conn of aliveConns) {
      if (conn && conn.memberId === memberId) {
        try { probeConn(conn); } catch (_) { /* 探活自己会兜 */ }
      }
    }
  }

  function sweepAlive() {
    for (const conn of [...aliveConns]) {
      const { res, memberId } = conn;
      if (!res || res.destroyed || res.writableEnded) {
        aliveConns.delete(conn);
        offlineIfNoConn(memberId);
        continue;
      }
      try {
        res.write(': alive\n\n'); // SSE 注释行：不产生报文，只用来探连接
        conn.lastPing = Date.now();
        if (memberId) status.receiveHeartbeat(memberId);
      } catch (_) {
        aliveConns.delete(conn);
        offlineIfNoConn(memberId);
      }
    }
    return aliveConns.size;
  }

  /**
   * 任务侧每轮要扫的几件事：超时／等表态／判挂／refuse 窗口。
   * ⚠️ 2026-10-04：**"按怎么死的分三型"作废**（`时限\01` §一：状态只有正常／异常）——
   *    收尾动作由 `timeout.handleTimeout()` 自己按"壳还在不在"走，这里不再传 type；
   *    原 `judgeTimeoutType()` 判型函数随之删掉（分型没有判据支撑，规范已废）。
   */
  function sweepTaskTimeouts() {
    // ⭐ 2026-10-04 修（最关键的一条）：**每轮先重建计时表**。
    //    原来计时表只在服务端启动时建一次（`startTimers()` 只在 `startTicker()` 里调），
    //    清数据后启动 ⇒ 表是空的 ⇒ **之后新派／新接的任务永远不登记** ⇒「时限超时」整条路是死的：
    //    不判超时、不换人重派、不兜底转老大、**也不触发插话**（插话就是这一步发的）。
    //    任务表规模很小，每轮重建可以忽略；比"挂在状态变化上"少很多边角要顾。
    try { timeout.rebuildTimers(); } catch (_) { /* 重建失败也别把扫停掉 */ }
    for (const d of timeout.checkTimeouts()) {
      try { timeout.handleTimeout(d.subId); } catch (_) { /* 单件失败不阻塞 */ }
    }
    // ⭐ 派发后 5 分钟没表态 ⇒ 判异常（标 cancelled ＋ 通知派发者四样齐 ＋ 断开连接）
    // ⚠️ 2026-10-04 修（**跟上面 `rebuildTimers` 同一个病，当时只修了一半**）：
    //    `rebuildPendingAck()` 原来只在 `startTimers()` 里调一次（＝服务端启动那一下）⇒
    //    **新派／新接的任务永远不进这张表** ⇒「派发后 5 分钟不表态 ⇒ 判异常」**对新派的任务是死的**。
    //    （2026-10-04 验 M11 时实测撞到：故意不表态的那件一直没被判、`state` 空着。）
    //    ⇒ 每轮也重建一次。⚠️ 它是**幂等**的（跳过已终态／没派发的／已 ack 的），任务表又小，可忽略。
    try { timeout.rebuildPendingAck(); } catch (_) { /* 重建失败也别把扫停掉 */ }
    try { timeout.sweepPendingAck(); } catch (_) {}
    try { timeout.sweepRefuseDead(); } catch (_) {}
    try { timeout.checkAssignerDeaths(); } catch (_) {}
    // ⭐ 2026-10-04 加（老大点头）：**代收"没人管的任务"** —— 所有子任务都到终态、又过了冷静期还没人收口
    //    ⇒ 系统替它收（治"任务出了事没人管" ⇒ 主任务永远不结束 ⇒ 门口一直挡着"那个老毛病）。
    try { if (typeof timeout.sweepOrphanTasks === 'function') timeout.sweepOrphanTasks(); } catch (_) {}
    // ⭐ 2026-10-05 加（正本 `时限\01` §二）：**交付后派发者一直不验收** —— 15 分钟叫它一次、30 分钟兜底。
    try { if (typeof timeout.sweepAcceptDeadline === 'function') timeout.sweepAcceptDeadline(); } catch (_) {}
  }

  /** 服务端定时扫（M3 规则：连续 2 次没报到 ⇒ 判离线；M7 踢人留痕） */
  function startTicker() {
    if (ticker) return;

    // 先把表建起来（重启恢复）：计时表／判挂表／等表态表
    try { timeout.startTimers(); } catch (_) { /* 建表失败不阻塞服务 */ }
    // ⭐ 系统真出口：系统主动发的消息走唯一大门（入账 ＋ 投递），不再只记事件（老大 2026-10-03 令）
    try { if (typeof timeout.setSender === 'function') timeout.setSender(receiveAndDeliver); } catch (_) {}
    // ⭐ 三条接线（2026-10-04 补上）：原来一条都没接 ⇒ 超时/判异常的收尾动作根本走不到
    //   ① 判异常 ⇒ **断开连接**（⚠️ 不是"踢下线"：踢下线线还挂着、它能自己上线回来）
    try {
      if (typeof timeout.setKick === 'function') timeout.setKick((id, reason) => status.disconnect(id, reason));
    } catch (_) {}
    //   ② 插话：办公室判超时 ⇒ 通知插件往那个会话插一句"时间到了，请停"
    //   ⚠️ 2026-10-05 补：**连着才推** —— 与 `deliver()` 同一口径（规范 `接入\01` §2.1
    //      「灰 ＝ 那条路真的走不通，**插件和后端都要拦**」）。调用侧（`timeout.handleTimeout`）
    //      其实已经拿 `presence === 'online'` 兜了一道，而「已断开 ⇒ 一定未上线」是规范里的
    //      不变量 —— 所以这是**间接**保证；这里补成**显式**判据，免得日后两层万一不同步、
    //      又回到"推了白推、日志还记成功"那套（`deliver()` 就是这么栽过的）。
    try {
      if (typeof timeout.setInterrupt === 'function') {
        timeout.setInterrupt((id, text) => {
          if (!isConnected(id)) return false;
          return pushToPlugin(id, PLUGIN_INTERRUPT_PATH, { memberId: id, text: String(text || '时间到了，请停') });
        });
      }
    } catch (_) {}
    //   ③ "断开连接"要**真断**那条 SSE（只标状态不叫真断 —— 那样它还能自己爬回来）
    try {
      if (typeof status.setDisconnectNotify === 'function') status.setDisconnectNotify((id) => closeAliveConns(id));
    } catch (_) {}
    ticker = setInterval(() => {
      try {
        for (const k of status.sweepOffline()) {
          try {
            log.logEvent({
              type: 'kick',
              who: k.id,
              why: '连壳死（心跳超时）',
              extra: { hadActiveWork: k.hadActiveWork },
            });
          } catch (_) {}
        }
      } catch (_) { /* 单次扫失败不阻塞 */ }
      // ⭐ 2026-10-03 补：原先这里只跑"判离线"，M4 那套超时表建了却没人查（验收脚本自己调）——
      //   生产路径连同"系统真出口"一起接上（老大令：要改的通通改掉，不留屎山）
      try { sweepTaskTimeouts(); } catch (_) { /* 单次扫失败不阻塞 */ }
      // ⭐ 每 **1 秒**扫一遍接入连接（下面的 ticker 就是 1 秒一拍 ⇒ 每拍都扫）——
      //    2026-10-04 老大令「**去把两秒改成一秒**」（原来 10 秒 ⇒ 2 秒 ⇒ 现在 1 秒）。
      //    判离线 ＝ 连着 2 拍没报到 ⇒ **≈2 秒**（`status.js` 的 `offlineAfterMs`）。
      // ⭐ 2026-10-05 清理：原来这里是 `if (++aliveTick >= 1) { aliveTick = 0; ... }` —— 那个计数器
      //    从"每 2 秒扫"改成"每 1 秒扫"之后就**恒真**了（等于每拍都扫）⇒ 计数器是废的，删掉直调。
      //    行为一字不变：ticker 是 1 秒一拍 ⇒ 每拍扫一遍接入连接。
      try { sweepAlive(); } catch (_) { /* 单次扫失败不阻塞 */ }
    }, 1000);
    if (ticker.unref) ticker.unref(); // 不因 ticker 挡进程退出
  }

  /**
   * 起 stdio MCP 那一口（阻塞到 stdin EOF；与 HTTP 可同时开）
   * @returns {object} { name:'mcp-stdio', started:true }
   */
  function startMcpStdio() {
    const mcp = require('./mcp-stdio');
    startTicker();
    const server = mcp.createMcpStdioServer({
      bridge: { invokeTool, listTools, getState },
      logger: log,
    });
    server.start();
    return { name: 'mcp-stdio', started: true };
  }

  /**
   * 起 HTTP 那一口（默认 8787；地址和端口写进 README 让对接方自己填）
   * @param {number} [port]
   * @returns {object} { name:'http', server, port, url }
   */
  function startHttp(port) {
    const httpApi = require('./http-api');
    startTicker();
    return httpApi.createHttpServer({ bridge: { invokeTool, getState, listTools, attachAlive, detachAlive }, logger: log }, port);
  }

  /** 状态快照（自验/监控用） */
  function getState() {
    return {
      sessions: Object.fromEntries(sessions),
      aliveConns: aliveConns.size,
      // ⭐ 2026-10-05 加：每条连接上的**接入手续**结果（自验／界面用；正本＝规范 `接入\01` §2.4）。
      //    ⚠️ **门是看它的**（2026-10-05 同日升级）：`none`／`bad` 会被 `invokeTool` 拒
      //    （旧注释"门不看它、现阶段只记录"**已过期**）。
      aliveCards: [...aliveConns].map((c) => ({
        memberId: c.memberId || '',
        card: (c.card && c.card.state) || null,
        detail: (c.card && c.card.detail) || '',
        // ⭐ 2026-10-05 加（第 2 刀）：这条连接的**探活**结果 ok／fail／n/a（还没探到 ⇒ null）
        probe: (c.probe && c.probe.state) || null,
        probeDetail: (c.probe && c.probe.detail) || '',
      })),
      // ⭐ 2026-10-05 加（第 2 刀）：**今天有几条"没走插件的接入"**（界面顶上那个标记用；数据源＝日志）
      access: accessFeed(stampNow().slice(0, 8)),
      recentDeliveries: deliveryLog.slice(-20),
      // ⭐ 调试模式现在是开是关（2026-10-04 加）—— 界面要拿它显示「开着时的醒目标记」
      //    （`04-功能清单` §7.7 第 4 条）。走 `GET /api/state` 这条只读路，**不经那道门**。
      debug: isDebugBypass(),
    };
  }

  /** 停掉 ticker（自验收尾用） */
  function stop() {
    if (ticker) { clearInterval(ticker); ticker = null; }
    saveState();
  }

  return {
    registerSession,
    deliver,
    receiveAndDeliver,
    systemSend,
    invokeTool,
    listTools,
    startMcpStdio,
    startHttp,
    attachAlive,
    detachAlive,
    closeAliveConns,
    sweepAlive,
    getState,
    stop,
    pushToPlugin,
    DEFAULT_HTTP_PORT,
  };
}

// 默认实例：用 M1~M7 生产实例（供其它块/壳直接 require 使用）
const bridge = createBridge();

module.exports = {
  createBridge,
  registerSession: bridge.registerSession,
  deliver: bridge.deliver,
  receiveAndDeliver: bridge.receiveAndDeliver,
  systemSend: bridge.systemSend,
  invokeTool: bridge.invokeTool,
  listTools: bridge.listTools,
  startMcpStdio: bridge.startMcpStdio,
  startHttp: bridge.startHttp,
  attachAlive: bridge.attachAlive,
  detachAlive: bridge.detachAlive,
  closeAliveConns: bridge.closeAliveConns,
  sweepAlive: bridge.sweepAlive,
  getState: bridge.getState,
  stop: bridge.stop,
  pushToPlugin: bridge.pushToPlugin,
  DEFAULT_HTTP_PORT: bridge.DEFAULT_HTTP_PORT,
};

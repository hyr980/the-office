'use strict';

/**
 * M5 · 成员与卡 —— 成员卡五格 + 接入自动建卡 + 可派发名单现算
 *
 * 依据：
 *   - 模块\M5-成员与卡.md
 *   - 规范\02-成员卡-草案v1-20261002.md（整份）
 *   - 规范\03-状态机制-草案v1-20261002.md §5 / §7
 *   - 规范\04-功能清单-草案v1-20261002.md §7.1
 *
 * 分工（跨块约定接口，别改名）：
 *   ensureMember(id)                   首次接入 ⇒ 自动建最小卡（只有 id＋joined）
 *   reportIdentity(id, {name, model})  成员自己报名字/模型（换模型后上线也走这条）
 *   setIcon(id, imageBytes)            传图片本身（不是路径）
 *   getMember(id)                      → {id,name,joined,model,icon,presence,busy}
 *   listAssignable(byMemberId)         → [{id,name,nick,busy,assignable:true|false,why:"等验收"}]
 *
 * 关键设计：
 *   - 卡是静态目录（权威在服务端），只存一份于 <数据>\members.json；
 *   - 卡就五格：id/name/joined/model/icon；不放 role/skills/忙闲/密钥（规范 02 §3/§6）；
 *   - 成员集合（有卡）与可派发候选是两个集合：boss 在成员集、永不在候选（规范 02 §7）；
 *   - 可派发名单现算（派发者 × 目标 的关系），不落卡、不写死（规范 03 §5）；
 *   - 卡集合变化时同步注入 M2 envelope / M3 status 的 setMembers 注入点。
 *
 * 约束：零第三方依赖；不改 M1/M2/M3/M4 的代码与接口。
 */

const fs = require('fs');
const path = require('path');
const dataLayer = require('./data-layer');
const statusModule = require('./status');
const envelopeModule = require('./envelope');

const BOSS = 'boss';

/** 本地时间戳：YYYYMMDDHHMMSS（与 M1 任务 id 时间串同格式，供按天筛选） */
function localStamp() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}

/** 把"图片本身"（Buffer/Uint8Array/数组/base64 字符串）转 base64 存卡；不是路径（规范 02 §3） */
function toBase64(imageBytes) {
  if (typeof imageBytes === 'string') return imageBytes;
  if (imageBytes instanceof Buffer) return imageBytes.toString('base64');
  if (imageBytes instanceof Uint8Array) return Buffer.from(imageBytes).toString('base64');
  if (Array.isArray(imageBytes)) return Buffer.from(imageBytes).toString('base64');
  throw new Error('icon 必须是图片本身（字节），不是路径');
}

/**
 * 造一个成员卡模块实例（数据层可注入：默认用 M1 数据层；自验/测试可注入隔离副本）
 * @param {object} dl 数据层（至少 DATA_DIR/TASK_STATES；提供 listTasks/readMessages 供现算用）
 * @param {{status?:object, envelope?:object}} [deps] 注入 M3 状态机 / M2 信封（须含 setMembers/getMembers）
 */
function createMembers(dl, deps) {
  const status = (deps && deps.status) || statusModule;
  const envelope = (deps && deps.envelope) || envelopeModule;
  const MEMBERS_FILE = path.join(dl.DATA_DIR, 'members.json');

  /** 卡集合：id -> {id, name?, joined, model?, icon?(base64)} */
  let cards = {};

  function loadCards() {
    if (fs.existsSync(MEMBERS_FILE)) {
      try {
        cards = JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8')) || {};
      } catch (_) {
        throw new Error(`成员卡文件损坏: ${MEMBERS_FILE}`);
      }
    }
    // boss 在成员集合里（他要能收回报，规范 02 §7）——卡文件没有就建最小卡
    if (!cards[BOSS]) {
      cards[BOSS] = { id: BOSS, joined: localStamp() };
      saveCards();
    }
  }

  function saveCards() {
    fs.mkdirSync(dl.DATA_DIR, { recursive: true });
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(cards, null, 2), 'utf8');
  }

  /** 卡集合变化 ⇒ 同步注入 M2/M3 成员集合（boss 在内；可派发候选由 listAssignable 现算，不走这里） */
  function syncMembers() {
    const ids = Object.keys(cards);
    // M3 setMembers 接受 {id,name,icon} 对象数组：把静态卡名字顺带给状态机；
    // boss 传字符串（boss 不进状态机，避免建状态记录）
    status.setMembers(
      ids.map((id) => (id === BOSS ? BOSS : { id, name: cards[id].name }))
    );
    envelope.setMembers(ids);
  }

  /** 首次接入 ⇒ 自动建最小卡（只有 id＋joined，规范 02 §5）；已有卡 ⇒ 原样返回 */
  function ensureMember(id) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('成员 id 必须是非空字符串（＝消息里的 source）');
    }
    if (!cards[id]) {
      cards[id] = { id, joined: localStamp() };
      saveCards();
      syncMembers();
    }
    return cards[id];
  }

  /**
   * 成员自己报身份（换模型／换昵称后上线也走这条，规范 02 §5）；账号它填了也不作数。
   * ⭐ 2026-10-04 名字分两个（老大：「名字我们统一用宿主的进程名字，然后加个昵称让 ai 自己填」）：
   *   · `name`（**宿主进程名**）＝ **它所在宿主的进程名**，由**插件**代报（不是 AI 起的、AI 也改不了）；
   *   · `nick`（**昵称**）＝ **AI 自己填、自己改**，可以没有 —— ⚠️ 传空串 ＝ 改回"没有"（删掉那一格）。
   */
  function reportIdentity(id, info) {
    if (!cards[id]) ensureMember(id); // 没卡先自动建（接入）
    const { name, nick, model } = info || {};
    if (name !== undefined && name !== null && name !== '') cards[id].name = String(name);
    if (nick !== undefined && nick !== null) {
      const v = String(nick).trim();
      if (v === '') delete cards[id].nick; else cards[id].nick = v;
    }
    if (model !== undefined && model !== null && model !== '') cards[id].model = String(model);
    saveCards();
    syncMembers();
    return cards[id];
  }

  /**
   * ⭐ 记"门牌号"（`接入\01` §2.4）：插件从宿主请求头里学到的自己的端点（`host:port`）。
   * 办公室靠它**主动推**（叫醒／插话）—— 规范要求"这些信息都记进成员卡"；只第一次报到要报。
   */
  function setHost(id, host) {
    if (!cards[id]) ensureMember(id);
    const h = typeof host === 'string' ? host.trim() : '';
    if (!h) return cards[id];
    cards[id].host = h;
    saveCards();
    return cards[id];
  }

  /** 头像上限（base64 字符数，512KB）：正常宿主图标几十 KB 封顶 —— 这道闸防的是
   *  "往成员卡里塞大块数据"（`loadCards()` 每次全量读它，`attachAlive` 的 `compareCard` 每条连接还要逐格比）。 */
  const ICON_MAX_CHARS = 512 * 1024;

  /** 传图片本身（不是路径）：base64 存卡；之后可以改（规范 02 §3） */
  function setIcon(id, imageBytes) {
    if (!cards[id]) ensureMember(id);
    const b64 = toBase64(imageBytes);
    // ⭐ 2026-10-05 加：**长度上限**（原来不限 ⇒ 一个成员能把任意大的字符串塞进成员卡，
    //    而这张卡每次加载全量读、每条连接还要整串比一遍）。
    if (typeof b64 === 'string' && b64.length > ICON_MAX_CHARS) {
      throw new Error(`头像太大：${b64.length} 字符，超过上限 ${ICON_MAX_CHARS}，已拒收`);
    }
    cards[id].icon = b64;
    saveCards();
    return cards[id];
  }

  /** 一查全给：静态卡 ＋ 在线 ＋ 忙闲（规范 03 §7；忙闲不在卡里）
   *  ⚠️ taskCount（原"手上有几件事"）2026-10-03 按老大口径删掉：一个人同一时间只有一件任务，那数能从 busy 推出来 */
  function getMember(id) {
    const card = cards[id];
    if (!card) return null;
    if (id === BOSS) {
      // boss 不进状态机：开程序＝在、关＝不在（规范 03 §2.3/§5）
      return {
        id,
        name: card.name ?? null,
        nick: card.nick ?? null,
        joined: card.joined,
        model: card.model ?? null,
        icon: card.icon ?? null,
        host: card.host ?? null,
        presence: 'online',
        busy: 'idle',
      };
    }
    const m = (status.listMembers() || []).find((x) => x.id === id) || null;
    return {
      id,
      name: card.name ?? null,
      nick: card.nick ?? null,   // 昵称（AI 自己填的；没填就是 null）
      joined: card.joined,
      model: card.model ?? null,
      icon: card.icon ?? null,
      host: card.host ?? null,   // 门牌号（办公室主动推给它用）
      presence: m ? m.presence : 'offline',
      // ⚠️ 离线／断开的：忙闲那一栏空着（"状态不显示"＝那一栏空着，`状态\02`）
      busy: m ? m.busy : null,
    };
  }

  /** 全部成员卡一查全给（界面用；含 boss；只读，M10 前端接真数据用） */
  function listAll() {
    return Object.keys(cards).map((id) => getMember(id));
  }

  /** awaiting 的人是谁在等验收（＝派发者；打回目标由系统认定，规范 03 §3） */
  function findAssignerOfAwaiting(memberId) {
    for (const t of dl.listTasks()) {
      if (t.closed) continue;
      const hasDelivered = t.subtasks.some(
        (st) => st.to === memberId && st.state === dl.TASK_STATES.DELIVERED
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
   * 可派发名单：现算，不是存下来的（规范 03 §5）
   * 名单 ＝ 有卡的成员 − boss − 隐身/离线的 − 忙的（busy）− 别人手里的 awaiting
   * @param {string} byMemberId 谁在查（派发者视角）
   * @returns {{id:string, name:string|null, nick:string|null, busy:string, assignable:boolean, why:string}[]}
   */
  function listAssignable(byMemberId) {
    const statusList = status.listMembers(); // 服务端现算 presence/busy
    const byId = new Map(statusList.map((m) => [m.id, m]));
    const out = [];
    for (const id of Object.keys(cards)) {
      if (id === BOSS) continue; // boss 永不在候选（规范 03 §5）
      const m = byId.get(id);
      // ⚠️ 2026-10-05 注：`status.listMembers()` 内部会给每张卡建状态记录（`ensureState`）
      //    ⇒ 这句实际**不会命中**，留作防御。原来那句注释（"无状态记录＝从未报到"）与实现不符。
      if (!m) continue;
      if (m.presence !== 'online') continue; // 离线/断开的不进名单（"隐身"整档 2026-10-04 砍掉）
      // ⭐ 「等验收」不是状态档（`状态\02` 2026-10-04）⇒ 用**账本**判：名下有"已交付、未验收"的任务。
      //    规范 `流程\02`：这种人**显示、不隐藏** —— 派发者看"只能打回"，别人看"不可派（等验收）"。
      const assigner = findAssignerOfAwaiting(id);
      if (assigner) {
        if (assigner === byMemberId) {
          out.push({ id, name: cards[id].name ?? null, nick: cards[id].nick ?? null, busy: 'busy', assignable: true, why: '等验收（只能打回）' });
        } else {
          out.push({ id, name: cards[id].name ?? null, nick: cards[id].nick ?? null, busy: 'busy', assignable: false, why: '等验收' });
        }
        continue;
      }
      if (m.busy === 'busy') continue; // 忙的不进名单
      out.push({ id, name: cards[id].name ?? null, nick: cards[id].nick ?? null, busy: 'idle', assignable: true, why: '' });
    }
    return out;
  }

  loadCards();
  syncMembers();

  return {
    ensureMember,
    reportIdentity,
    setHost,
    setIcon,
    getMember,
    listAll,
    listAssignable,
  };
}

// 默认实例：用 M1 数据层 + M3 状态机 + M2 信封（生产路径）
const members = createMembers(dataLayer, { status: statusModule, envelope: envelopeModule });

module.exports = {
  createMembers,
  ensureMember: members.ensureMember,
  reportIdentity: members.reportIdentity,
  setHost: members.setHost,
  setIcon: members.setIcon,
  getMember: members.getMember,
  listAll: members.listAll,
  listAssignable: members.listAssignable,
};

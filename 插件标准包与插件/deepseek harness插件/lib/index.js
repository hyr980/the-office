/**
 * @hyr980/dsh-office —— 办公室接入插件（Host 侧，DSH 桌面端）
 * ⭐ 2026-10-05 按插件标准包的内核重写：能搬进内核的都搬进去了（`lib\office-bridge.mjs`），
 *    本文件只留「宿主 ↔ 插件」这一段 ＋ 界面那半。
 *
 * 依据：插件标准包《说明书》（`项目\办公室-新布局\插件标准包与插件\`）＋ 内核 `office-bridge.mjs`。
 *
 * 谁管什么（分工正本就是这一节）：
 *   · 内核 ＝「插件 ↔ 办公室」：挂那条常驻连接、取卡存卡、报到、转发调用，
 *     外加五个反向端点（wake／interrupt／online／connect／challenge）。
 *   · 本文件 ＝「宿主 ↔ 插件」＋ 界面：
 *       ① 把办公室的工具表注册成宿主工具（`office_*`）—— AI 直接调
 *       ② 给内核接上 wake／steer 两钩子（调宿主的 `sessionController.prompt`）
 *       ③ 面板端点（客户端半身 `lib\client.js` 靠它们说话；**client.js 照旧不动**）
 *       ④ 抽宿主图标（第一次报到用）＋ 取宿主进程名
 *       ⑤ 查在线状态、记账（面板显示用）
 *
 * ⭐ 两条硬规矩（正本：办公室规范 `接入\01` §2.1／§2.2）：
 *   · **绑哪个会话跟着「上线」走，不跟着「连接」走**（「连接」只管那条线）
 *   · **「上一次绑过的会话」跨重启也要在**，且**下线不清它** —— 它是叫醒要用的地址
 *     （内核 `offline()` 2026-10-05 已按这一条修过）
 *
 * 零依赖：只用 node 内置（fs／path／child_process）＋ 内核。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// ⭐ 抽宿主图标要借一次 PowerShell（node 自己读不了 exe 的 PE 资源；2026-10-04 加头像时引入）
import { spawnSync } from 'node:child_process';
import { createOfficeBridge } from './office-bridge.mjs';

export const name = 'dsh-office';

/** 硬依赖：工具注册表。`sessionController` 用可选方式取（拿不到就只挂连接、不叫醒）。 */
export const inject = ['tools'];

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8787',
  memberId: 'fish',
  /** 取不到宿主进程名时的回落（一般不走到）。 */
  displayName: '未知宿主',
  model: 'deepseek-flash',
  /** 办公室没起来时，隔多久重试拉工具表（毫秒）。 */
  toolsRetryMs: 5000,
  /** 工具名前缀：避让宿主里其它插件的同名工具（重名会直接注册失败）。 */
  prefix: 'office_',
  /** 兜底：万一宿主给的执行上下文里没有会话 id，就在这儿手写一个（一般不用填）。 */
  sessionId: '',
  /** 卡与状态放哪个目录（内核的 `dataDir`）。留空 ＝ DSH 家目录。 */
  stateDir: '',
  /**
   * ⭐ 反向端点（办公室往这儿推）用哪个端口 —— **固定端口 ⇒ 门牌号跨重启不变**。
   * 为什么重要：办公室记着"上次报的门牌号"，重启后端口要是变了，它点「叫它上线」就推不到
   * （旧版用的是宿主端口 19387，一直是固定的，所以没这个毛病）。
   * ⚠️ 端口被占就自动退回"随便挑一个"（那一次门牌号会变，控制台会写一行说明）。
   */
  port: 19388,
  /** 打开后往宿主控制台打详细日志。 */
  verbose: false,
};

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const cfg = { ...DEFAULTS, ...(rawConfig || {}) };
  const base = String(cfg.baseUrl).replace(/\/+$/, '');
  const prefix = String(cfg.prefix || '');

  const say = (...a) => { if (cfg.verbose) console.log('[office]', ...a); };
  const warn = (...a) => console.warn('[office]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  console.log('[office] 插件 apply 跑于', new Date().toISOString());

  /** 插件侧的状态。⚠️ 「卡」与「绑过的会话」不在这儿 —— 它们在**内核**里（内核负责落盘）。 */
  const st = {
    /** 最近一次工具调用看到的会话 id（兜底用；权威的绑定在内核）。 */
    agentId: '',
    /** 人点过「连接」没有 —— **意图**，只给界面决定按钮用（"实际连上没有"一律问内核）。 */
    linkOn: false,
    /** AI 自己填的昵称（填过就写进内核的 opts，报到时带上；不填＝不带，办公室不改它）。 */
    nick: undefined,
    /** 抽到的宿主图标（纯 base64）—— 只当次内存；正式那份存在内核的卡里（两边各存一份）。 */
    iconB64: '',
    /** 已注册的工具名 → 注销函数。 */
    regs: new Map(),
    /** 已注册的工具名集合。 */
    names: new Set(),
    /** 拉工具表的定时器。 */
    toolsTimer: null,
    /** 办公室那边**真实**的我在不在线（问办公室要来的，不是自己记的）。 */
    presence: '',
    /** 离线原因（`self`／`heartbeat`／`kick`／`disconnect`）—— 界面靠它写"因为什么离的"。 */
    offlineReason: '',
    /** 上次查在线状态的时刻（带 4 秒缓存，免得客户端每 2 秒一拉就打一次办公室）。 */
    presenceAt: 0,
    /** 查在线状态时的错因（诊断用）。 */
    presenceErr: '',
    /** 上一个瞬间的连线状态 —— 用来察觉"线断了"（内核不通知插件，借面板轮询顺手比一下）。 */
    wasConnected: false,
    /** 置真后所有循环退出（插件卸载时）。 */
    stopped: false,
    /** 面板上那点诊断数。 */
    stats: {
      connects: 0, wakes: 0, steers: 0, onlines: 0, calls: 0,
      errors: 0, lastError: null, drops: 0, lastDrop: null,
    },
  };

  // ═══════════════ 一、建内核（它管"插件 ↔ 办公室"那一段） ═══════════════

  /** 抽自己宿主进程的图标（纯 base64，不带 `data:` 前缀）。抽不到回 null。 */
  async function grabHostIcon() {
    if (st.iconB64) return st.iconB64;
    try {
      const exe = process.execPath;   // 宿主主程序（Electron 里 process.execPath 就是那个 exe）
      if (!exe || !fs.existsSync(exe)) { say('拿不到宿主 exe 路径，跳过抽图标'); return null; }
      const ps = 'Add-Type -AssemblyName System.Drawing; '
        + `$i=[System.Drawing.Icon]::ExtractAssociatedIcon('${String(exe).replace(/'/g, "''")}'); `
        + '$b=$i.ToBitmap(); $ms=New-Object System.IO.MemoryStream; '
        + '$b.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); '
        + '[Convert]::ToBase64String($ms.ToArray())';
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8', timeout: 20000,
      });
      const b64 = String((r && r.stdout) || '').trim();
      if (!b64 || b64.length < 100) {
        // ⚠️ `r.error` 必须打出来：spawnSync **连子进程都没起成**时（例如受限环境下的 EPERM），
        //    stdout／stderr 全是空的 —— 不打它，这个失败就查不动（2026-10-05 自检实撞：
        //    `spawnSync powershell.exe EPERM`，而旧版只打空的两个流，看着像"啥也没发生"）。
        warn('抽宿主图标没抽到：status=', r && r.status,
          '｜error=', (r && r.error) ? (r.error.code + ' / ' + r.error.message) : '（无）',
          '｜stdout=', String((r && r.stdout) || '').slice(0, 120),
          '｜stderr=', String((r && r.stderr) || '').slice(0, 120));
        return null;
      }
      st.iconB64 = b64;
      say('抽到宿主图标了（base64', b64.length, '字符）');
      return b64;
    } catch (e) {
      warn('抽宿主图标失败：', String((e && e.message) || e));
      return null;
    }
  }

  /**
   * 宿主进程名 ＝ **它所在宿主的进程名**（2026-10-04 老大：「名字我们统一用宿主的进程名字」）。
   * 出处：Electron 里 `process.execPath` 就是宿主主程序本身。取不到就回落到 `displayName`。
   */
  function hostAppName() {
    try {
      // ⚠️ 本文件是 ESM —— 这个函数里**不许** `require('path')`（2026-10-04 实撞：会被 catch 吞掉、
      //    静默回落到 displayName，卡上宿主进程名就报成那个回落值了）。`path` 在文件顶部就 import 了。
      const exe = process.execPath;
      if (!exe) return cfg.displayName;
      return path.basename(String(exe)).replace(/\.exe$/i, '') || cfg.displayName;
    } catch (_) {
      return cfg.displayName;
    }
  }

  /** 卡与状态放哪：配置优先；缺省放 DSH 家目录（家目录固定，插件重装也不丢）。 */
  function stateDir() {
    if (cfg.stateDir) return String(cfg.stateDir);
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  }

  /**
   * ⭐ 给内核的参数对象 —— **故意持有它的引用**：内核是在**每次报到时**才去读
   * `opts.nick`／`opts.icon`／`opts.model`（出处：内核 `register()` 里那四处读法），
   * 所以后面抽到图标、AI 改了昵称，**改这个对象就等于改了内核下次报到要报的东西**。
   * （`base`／`memberId`／`dataDir`／`port` 是建的时候读一次，改这里没用 —— 那些也不该变。）
   */
  const bridgeOpts = {
    base,
    memberId: cfg.memberId,
    name: hostAppName(),
    nick: undefined,
    model: cfg.model,
    icon: undefined,
    dataDir: stateDir(),
    port: Number.isInteger(cfg.port) ? cfg.port : 0,
    wake: (why) => wake(why),
    steer: (text) => steer(text),
    log: (...a) => console.log('[office]', ...a),
    warn: (...a) => console.warn('[office]', ...a),
  };

  let bridge = createOfficeBridge(bridgeOpts);

  /**
   * 起内核的反向端点（**不连办公室**）。
   * ⚠️ 两个坑都在这儿处理：
   *   ① `apply` 是不是异步、宿主等不等它 —— 没有先例（本机已装插件的 apply 全是同步的）
   *      ⇒ 不赌它：**起服务丢给一个 Promise**，用到内核的地方 `await ready`。
   *   ② 配置的固定端口被占（比如上一个实例还没退干净）⇒ 退回"随便挑一个"，
   *      并**明说这一次门牌号变了**（办公室那边得等下一次报到才会更新）。
   */
  const ready = (async () => {
    try {
      await bridge.start();
    } catch (e) {
      const msg = String((e && e.message) || e);
      warn(`反向端点用 ${bridgeOpts.port} 起不来（${msg}）⇒ 退回自动挑一个端口。`
        + '⚠️ 这一次门牌号变了：要等 Kernel 重新报到，办公室才叫得到人。');
      bridgeOpts.port = 0;
      bridge = createOfficeBridge(bridgeOpts);
      await bridge.start();
    }
  })().catch((e) => { warn('反向端点没起来：', String((e && e.message) || e)); });

  /**
   * 报到要用的"身份"（图标）准备好没有。
   * ⚠️ 顺序要紧：**抽图标必须在第一次报到之前** —— 内核是"连上就报到"，
   *    晚一步那次报到就没头像了（要等下次报到才补上）。
   * 做法：先看**本地那张卡**上有没有图标（内核读回来的，四格之一）；
   *    有 ⇒ 直接用（省掉抽的那一秒）；没有 ⇒ 抽一次宿主图标。
   * ⚠️ 抽到的图标不写盘：报到交给办公室，办公室回传的卡里带着它，内核存盘 ⇒ **两边各存一份**，闭环。
   */
  const identityReady = (async () => {
    try {
      await ready;
      const c = bridge.card();
      if (c && c.icon) { bridgeOpts.icon = String(c.icon); say('本地卡上已有图标，跳过抽取'); return; }
      const b64 = await grabHostIcon();
      if (b64) bridgeOpts.icon = b64;
    } catch (e) {
      warn('准备身份（图标）失败，不阻塞：', String((e && e.message) || e));
    }
  })();

  // ═══════════════ 二、给内核接两个钩子（"宿主 ↔ 插件"这一段） ═══════════════

  /**
   * 叫醒要用的那句话。内核会拿两种话来找它：
   *   · 内核自己的整段提示（起昵称那条，以 `【办公室】` 开头）⇒ **原样送**，别再套模板；
   *   · 一句"为什么叫"（`有消息指向本接入端`／`办公室请求本接入端上线`／`办公室在成员卡上点「叫它上线」`）⇒ 套上模板。
   * ⚠️ 推的**只有这条命令、没有正文**（正文它自己进来读）—— 正本：规范 `02` §1.1。
   */
  function wakeText(why) {
    const w = String(why || '');
    if (w.startsWith('【办公室】')) return w;
    if (/叫它上线|叫你上线/.test(w)) {
      // 人在**办公室成员卡**上点的（内核 `/dsh-office/online` 推来的）——
      // ⚠️ 这一步**只把它叫醒**，"上线"要它自己来做（2026-10-04 老大：「插件是来唤醒的，这个得让 ai 自己去上线」）
      return '【办公室】老大在办公室叫你上线，进来自己上线。'
        + `\n· 上线：${prefix}presence 带上 { presence: "online" }（绑的就是你现在这个会话）`;
    }
    return '【办公室】有人找你，进来看看。' + (w ? `（${w}）` : '') + '\n'
      + `· 读账本：${prefix}read_messages　· 看任务：${prefix}list_tasks　· 看自己在不在线：${prefix}get_member\n`
      + `· 回话／交付／表态都在办公室里填表（${prefix}send_message 等）；`
      + `派发要当场表态：接 ⇒ ${prefix}send_message 发 task.ack，不接 ⇒ ${prefix}refuse。`;
  }

  /**
   * 叫醒：把"有人找你、进来看"送进**绑定的那个会话**。
   * ⚠️ 第二个参数 `signal` **必须传** —— 契约里它是位置参数：`prompt(request, signal)`；
   *    不传 ⇒ 宿主内部 `signal.throwIfAborted()` 抛错 ⇒ **叫醒整个失败**（2026-10-04 实测踩到）。
   * @returns {Promise<boolean>} 送出去了没有
   */
  async function wake(why) {
    const sc = ctx.get('sessionController');
    if (!sc || typeof sc.prompt !== 'function') {
      warn('拿不到 sessionController（宿主没给），叫不醒');
      return false;
    }
    const sid = bridge.status().boundSessionId || st.agentId;
    if (!sid) {
      warn('还没绑会话（没人点过「上线」）⇒ 没人可叫；消息在账本里，等它自己来读');
      return false;
    }
    try {
      await sc.prompt({
        requestId: `office-wake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        sessionId: sid,
        mode: 'queue',   // 排队：等它手上这轮干完再送（插话才用 steer）
        content: [{ type: 'text', text: wakeText(why) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, AbortSignal.timeout(15000));
      st.stats.wakes += 1;
      say('已叫醒 →', sid);
      return true;
    } catch (e) {
      st.stats.errors += 1;
      st.stats.lastError = String((e && e.message) || e);
      warn('叫醒失败：', st.stats.lastError);
      return false;
    }
  }

  /** 插话：立刻接手，让那个会话先停下来看这条。⚠️ 插完**不等它回话**（正本：规范 `01` §4）。 */
  async function steer(text) {
    const sc = ctx.get('sessionController');
    const sid = bridge.status().boundSessionId || st.agentId;
    if (!sc || typeof sc.prompt !== 'function' || !sid) return false;
    try {
      await sc.prompt({
        requestId: `office-steer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        sessionId: sid,
        mode: 'steer',
        content: [{ type: 'text', text: String(text) }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }, AbortSignal.timeout(15000));
      st.stats.steers += 1;
      return true;
    } catch (e) {
      st.stats.errors += 1;
      st.stats.lastError = String((e && e.message) || e);
      return false;
    }
  }

  // ═══════════════ 三、查在线状态（界面要"实际"，不要"我以为"） ═══════════════

  /**
   * 问办公室："我到底还在不在线？"
   * ⚠️ 为什么必须问：面板要是显示插件自己记的意图，那么被踢下线之后它还写着"已上线"（2026-10-03 实撞）。
   * 只读调用不写办公室日志 ⇒ 可以定期问；带 4 秒缓存，免得客户端每 2 秒一拉就打一次。
   */
  async function queryPresence() {
    if (!bridge.status().connected) {
      st.presence = ''; st.offlineReason = ''; return '';
    }
    const now = Date.now();
    if (st.presenceAt && now - st.presenceAt < 4000) return st.presence;
    try {
      const r = await bridge.callTool('get_members', {});
      const list = (r && r.data && r.data.members) || [];
      const me = list.find((x) => x && x.id === cfg.memberId);
      st.presence = String((me && me.presence) || '');
      // ⭐ 离线原因是给界面写的（"因为什么离的"）—— 出自成员卡那个字段（客户端 `client.js` 早就在等它）。
      st.offlineReason = String((me && me.offlineReason) || '');
      // 诊断用：把"查到了但没我"和"原始返回长什么样"留下来 —— 不然外面只看得到"presence 是空"，查不动。
      st.presenceErr = me ? '' : ('名单里没有「' + cfg.memberId + '」；拿到：'
        + JSON.stringify(list.map((x) => x && x.id)) + '；原始返回：' + JSON.stringify(r).slice(0, 300));
      st.presenceAt = now;
    } catch (e) {
      st.presenceErr = '查询抛错：' + String((e && e.message) || e);
    }
    return st.presence;
  }

  function snapshot() {
    const bs = bridge.status();
    return {
      memberId: cfg.memberId,
      sessionId: st.agentId || bs.boundSessionId || null,
      /** 那条连接还挂着吗（问内核要的，不是自己记的）。 */
      connected: bs.connected,
      registered: bs.registered,
      /** 门牌号（内核反向端点，办公室往这儿推）。 */
      hostPort: bs.hostPort,
      toolCount: st.names.size,
      ...st.stats,
    };
  }

  function toText(value) {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  // ═══════════════ 四、递话：把办公室的工具注册成宿主工具 ═══════════════

  /** 从办公室拉工具表（`GET /api/tools`），把每个注册成宿主工具。 */
  async function syncTools() {
    const res = await fetch(`${base}/api/tools`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} /api/tools`);
    const r = await res.json();
    const list = Array.isArray(r && r.tools) ? r.tools : Array.isArray(r) ? r : [];
    if (!list.length) throw new Error('工具表是空的');

    let added = 0;
    for (const t of list) {
      const rawName = String((t && t.name) || '').trim();
      if (!rawName) continue;
      const hostName = prefix + rawName;
      if (st.names.has(hostName)) continue;
      try {
        st.regs.set(hostName, registerOne(hostName, rawName, t));
        st.names.add(hostName);
        added += 1;
      } catch (e) {
        warn(`注册工具 ${hostName} 失败：`, String((e && e.message) || e));
      }
    }
    say('工具表同步完成：新增', added, '个，共', st.names.size, '个');
    return added;
  }

  /**
   * 注册一个"转发型"工具：AI 调它 ⇒ 转发给办公室（顺手补两处插件才知道的值）。
   * ⚠️ `output` 是必填字段（少了注册直接失败）；`render` 负责把返回值变成给模型看的文本。
   */
  function registerOne(hostName, rawName, def) {
    return ctx.tools.register({
      name: hostName,
      description: `${String((def && def.description) || rawName)}（办公室工具，经接入插件转发）`,
      parameters: (def && def.inputSchema) || { type: 'object', properties: {} },
      output: {
        schema: { type: 'object' },
        render(_args, value) { return [{ type: 'text', text: toText(value) }]; },
      },
      async execute(args, exec) {
        await ready;
        // 会话 id：宿主给的执行上下文里带着（换会话 ⇒ 这里跟着变）
        const here = String((exec && exec.agent && exec.agent.id) || (exec && exec.sessionId) || cfg.sessionId || '');
        if (here) st.agentId = here;
        try {
          // ⭐ 「AI 自己上线／下线」这条路（规范 `01` §2.2）：
          //    ① 线断着 ⇒ **不许发出去，当场告诉它不行**（"界面灰着就得真走不通"，前后不能两套）；
          //    ② 上线 ⇒ 走内核的 `online()`：**绑"这次上线发生的那个会话"** ＋ 报到 ＋ 上线；
          //       ⚠️ 取会话**不许走"绑过的那个"**（那样等于白写），要用 `exec` 里这个"当前会话"；
          //    ③ 下线 ⇒ 走内核的 `offline()`：**只报下线、不碰那个地址**（地址留着，办公室才叫得到人）。
          if (rawName === 'presence') {
            if (!bridge.status().connected) {
              return {
                ok: false,
                error: '办公室那边是"已断开"：线断了就上不了线 —— 要连得人在会话页面上点「连接」。',
              };
            }
            const goingOnline = !(args && args.presence === 'offline');
            if (goingOnline) {
              if (!here) return { ok: false, error: '拿不到当前会话 id，上不了线' };
              const r = await bridge.online(here);
              if (r && r.ok !== false) st.stats.onlines += 1;
              return r;
            }
            return await bridge.offline();
          }
          // ⭐ 报到顺带把"门牌号"带上（AI 自己填不出这个值，只有插件知道）——
          //    没带的话办公室就没法主动推给它（规范 `01` §2.4）。
          if (rawName === 'register') {
            const a = { ...(args || {}) };
            const hp = bridge.status().hostPort;
            if (!a.host && hp) a.host = hp;
            st.stats.calls += 1;
            return await bridge.callTool(rawName, a);
          }
          st.stats.calls += 1;
          return await bridge.callTool(rawName, args || {});
        } catch (e) {
          // 连不上办公室 ＝ 对端没了，归 `drops`，不算插件出错。
          const msg = String((e && e.message) || e);
          st.stats.drops += 1;
          st.stats.lastDrop = msg;
          return { ok: false, error: `连不上办公室：${msg}` };
        }
      },
    });
  }

  /**
   * 一个不依赖办公室的起步工具：办公室还没起来时，靠它把会话 id 交出去。
   * ⚠️ 与旧版的差别（有意）：这里走内核的 `online()`，会**顺手把绑定设成本会话** ——
   *    也就是规范里那条"AI 自己上线就绑它自己"；好处是卡与昵称都跟着内核的正规流程走。
   */
  function registerBootstrap() {
    const hostName = `${prefix}register_bootstrap`;
    if (st.names.has(hostName)) return;
    st.regs.set(hostName, ctx.tools.register({
      name: hostName,
      description: '把"我现在这个会话"告诉办公室（报到 ＋ 上线）。⭐ 也可以用它给自己起／改【昵称】（`nick`）；'
        + '⚠️ 宿主进程名不用你报（＝你所在宿主的进程名，插件替你报）。办公室没起来时会失败，重连后自动补。',
      parameters: {
        type: 'object',
        properties: {
          nick: { type: 'string', description: '⭐ 昵称：你自己填、自己改，可以没有；传空串＝去掉昵称' },
          model: { type: 'string', description: '报模型（可选）' },
        },
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) { return [{ type: 'text', text: toText(value) }]; },
      },
      async execute(args, exec) {
        await ready;
        const here = String((exec && exec.agent && exec.agent.id) || (exec && exec.sessionId) || cfg.sessionId || '');
        if (!here) return { ok: false, error: '拿不到当前会话 id，报到不了' };
        st.agentId = here;
        // ⭐ 昵称：写进内核那个 opts 对象 ⇒ **下一次报到就带上**（改引用即改内核要报的东西，见 bridgeOpts 注释）。
        //    ⚠️ 卡上的昵称**权威在办公室**（不传＝不改），所以这里丢了也无害。
        if (args && args.nick !== undefined) { st.nick = String(args.nick); bridgeOpts.nick = st.nick; }
        if (args && args.model) { cfg.model = String(args.model); bridgeOpts.model = cfg.model; }
        const r = await bridge.online(here);
        return {
          ok: !!(r && r.ok !== false),
          memberId: cfg.memberId, sessionId: here, nick: st.nick ?? null,
          office: r, state: snapshot(),
        };
      },
    }));
    st.names.add(hostName);
  }

  // ═══════════════ 五、面板端点（客户端半身 `lib\client.js` 靠它们说话） ═══════════════
  // ⚠️ 收发字段**照旧版逐字对齐**（client.js 不动）—— 唯一的例外在 `panel-state` 里注明了。

  ctx.inject(['webServer'], (wc) => {
    const srv = wc && wc.webServer;
    if (!srv || typeof srv.register !== 'function') {
      warn('拿不到 webServer 服务，面板端点没挂上');
      return;
    }
    try {
      const disposers = [];

      /** ⭐ 2026-10-06 加（老大令「修」）：**这一批面板口只认界面**。
       *
       *  为什么：这批 handler 原来**一句鉴权都没有** ⇒ 本机任何能发 HTTP 的程序
       *  （**包括 AI 的 shell**）都能打 ——2026-10-06 实测：不带 Origin／Cookie 裸 GET
       *  `panel-state` 得 **200**，同批的 `layer1`／`link`／`unlink` 同理 ⇒ 配上「连接一挂上
       *  就清掉『断开连接』记号」的现有逻辑，AI 能自己连上／上线／自行解除惩罚。
       *
       *  判据与做法：宿主的 `connection.requestRejection`（先 **Host/Origin 围墙**、再
       *  **浏览器签名 cookie** 认证），回 `401`／`403` ⇒ **原样拒掉**；`undefined` ＝ 放行。
       *  页面（会话里那个半身 `client.js`）本来就带同源 cookie ⇒ 照常能用；
       *  ⚠️ **拿不到闸门 ⇒ 拒绝**（fail closed）：宁可不给用，也不留裸口。
       */
      const passGate = (req, res) => {
        const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        if (!conn || typeof conn.requestRejection !== 'function') {
          warn('拿不到宿主的 connection 服务 ⇒ 面板端点按「拒绝」处理（fail closed）');
          json(res, 403, { ok: false, error: '这个动作只认界面：插件拿不到宿主的连接鉴权，已拒' });
          return false;
        }
        const rejection = conn.requestRejection(req);
        if (rejection) {
          json(res, rejection, {
            ok: false,
            error: rejection === 401
              ? '这个动作只认界面（没带、或没带对界面凭据）'
              : '这个来源不被信任（Host／Origin 不对）',
          });
          return false;
        }
        return true;
      };

      /** 读请求体（JSON）。 */
      const readBody = (req) => new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
      });
      /** 统一回 JSON。 */
      const json = (res, code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(obj));
      };

      // ① 探针：客户端一加载就报一声（让"客户端那半加载没加载"查得到，不靠人眼看界面）
      disposers.push(srv.register({
        kind: 'exact',
        path: '/dsh-office/client-ready',
        handler: (req, res) => {
          if (!passGate(req, res)) return;
          let body = '';
          req.on('data', (c) => { body += c; });
          req.on('end', () => {
            console.log('[office] 客户端半身上报：', body.slice(0, 300));
            json(res, 200, { ok: true });
          });
        },
      }));

      // ② 面板状态：客户端每 2 秒拉它来画那一行 + 决定按钮灰不灰
      disposers.push(srv.register({
        kind: 'exact',
        path: '/dsh-office/panel-state',
        handler: async (req, res) => {
          if (!passGate(req, res)) return;
          await ready;
          const u = new URL(req.url, 'http://x');
          const pageSession = String(u.searchParams.get('pageSession') || u.searchParams.get('sessionId') || '');
          const bs = bridge.status();
          // 顺手察觉"线断了"：内核不通知插件，面板每 2 秒拉一次是最省的办法
          // （所以这里记的断开次数**只在有页面开着时**才准，够诊断用了）。
          if (st.wasConnected === true && bs.connected === false) {
            st.stats.drops += 1;
            st.stats.lastDrop = '那条连接断了（办公室关了、或网断了）';
          }
          st.wasConnected = bs.connected;
          json(res, 200, {
            ok: true,
            pageSessionId: pageSession,
            boundSessionId: bs.boundSessionId,
            // ⭐ 第一层有**两个**状态，别混：linkOn＝人点过「连接」没有（意图，只决定按钮文字）；
            //    connected＝那条连接**真的**挂着没有（实际，界面照它显示）。
            linkOn: !!st.linkOn,
            connected: !!bs.connected,
            // 灰不灰的判据：没绑 ⇒ 哪个页面都能点；绑了 ⇒ 只有在那个页面能操作
            canOperate: !bs.boundSessionId || bs.boundSessionId === pageSession,
            isBoundPage: !!bs.boundSessionId && bs.boundSessionId === pageSession,
            registered: !!bs.registered,
            presence: await queryPresence(),
            // ⭐ 新补（旧版从没给过、client.js 却早就在等它）：离线是**因为什么**离的。
            offlineReason: st.offlineReason || '',
            presenceErr: st.presenceErr || '',
            // ⚠️ 字段改名说明：旧版这个位置叫 `hostSeen`，装的是"从请求头学来的**宿主**端口"；
            //    新版门牌号由内核自己起（办公室往内核推），所以这里给的是**内核端口**。客户端不读它。
            hostPort: bs.hostPort,
            stats: { ...st.stats },
          });
        },
      }));

      // ③ 上线：**绑住当前这个会话**（＋报到 ＋上线）—— 绑定跟着「上线」走，不跟着「连接」走
      disposers.push(srv.register({
        kind: 'exact',
        path: '/dsh-office/link',
        handler: async (req, res) => {
          if (!passGate(req, res)) return;
          await ready;
          if (!bridge.status().connected) {
            json(res, 200, { ok: false, error: '还没连上办公室（得先点「连接」）' });
            return;
          }
          const b = await readBody(req);
          const sid = String(b.sessionId || '');
          if (!sid) { json(res, 400, { ok: false, error: '没给 sessionId' }); return; }
          st.agentId = sid;
          const on = await bridge.online(sid);
          const ok = !!(on && on.ok !== false);
          if (ok) st.stats.onlines += 1;
          console.log('[office] 面板点【上线】：绑到', sid, '｜ 办公室回话=', JSON.stringify(on).slice(0, 160));
          json(res, 200, {
            ok, boundSessionId: sid, presence: on,
            error: ok ? undefined : '上线没成（办公室那边没认）',
          });
        },
      }));

      // ④ 下线：⭐ **先跟办公室说"我下线了"** —— 顺序不能反
      //    ⚠️ **不碰"上一次绑过的会话"**：下线只是"不在岗"，那条地址是叫醒要用的，留着才对
      //    （内核 `offline()` 也是这个口径；清了的话办公室点「叫它上线」只会报「上线异常」）。
      disposers.push(srv.register({
        kind: 'exact',
        path: '/dsh-office/unlink',
        handler: async (req, res) => {
          if (!passGate(req, res)) return;
          await ready;
          const was = bridge.status().boundSessionId;
          let told = null;
          if (bridge.status().connected) told = await bridge.offline();
          console.log('[office] 面板点【下线】：已跟办公室说下线=', JSON.stringify(told).slice(0, 140),
            '｜ 记得的会话仍是', was || '（没有）');
          json(res, 200, {
            ok: true, wasBound: was, presence: told,
            stillBound: bridge.status().boundSessionId || '',
          });
        },
      }));

      // ⑤ 第一层：连接／断开（办公室 ↔ 插件）—— 面板上「连接／断开」那个按钮调它
      disposers.push(srv.register({
        kind: 'exact',
        path: '/dsh-office/layer1',
        handler: async (req, res) => {
          if (!passGate(req, res)) return;
          await ready;
          const b = await readBody(req);
          const on = b.on !== false;
          st.linkOn = !!on;
          if (!on) {
            // 点「断开」⇒ 把那条连接掐掉。⚠️ 现在**没有"自动重挂"**（规范 `01` §2.2「一切自动连接都不要」）
            //    ⇒ 掐掉就是真断；要连得人重新点「连接」。
            bridge.disconnect();
            console.log('[office] 面板点【断开】（第一层）⇒ 那条流已经掐了');
            json(res, 200, { ok: true, linkOn: false, connected: false });
            return;
          }
          // ⭐ 点「连接」⇒ **真去等一次结果**再回报（"没开办公室点了连接，就该显示连接失败"）。
          // ⚠️ 抽图标要赶在**第一次报到之前**（内核连上就报到），所以先等身份准备好 —— 首次约 1 秒。
          await identityReady;
          console.log('[office] 面板点【连接】（第一层）⇒ 等它真挂上…');
          const t0 = Date.now();
          bridge.connect();   // ⚠️ 别 await —— 它要挂到断为止
          while (Date.now() - t0 < 3000) {
            const s = bridge.status();
            if (s.connected) break;
            if (!s.connecting) break;   // 试连结束、但没连上 ⇒ 这就是结论
            await sleep(100);
          }
          const connected = bridge.status().connected;
          if (connected) st.stats.connects += 1;
          // ⚠️ 界面只给人话（老大 2026-10-03：「一定要中文不然我看不懂」）；
          //    底层错因（`fetch failed` 之类）只进控制台。
          console.log('[office] 连接尝试结束 ⇒ connected=' + connected);
          json(res, 200, {
            ok: connected, linkOn: true, connected,
            error: connected ? undefined : '连不上办公室（它没开？）',
          });
        },
      }));

      st.panelDisposers = disposers;
      console.log('[office] 面板端点已挂：panel-state／link（上线）／unlink（下线）／layer1（连接）／client-ready（探针）');
    } catch (e) {
      warn('注册面板端点失败：', String((e && e.message) || e));
    }
  });

  // ═══════════════ 六、串起来 ═══════════════

  registerBootstrap();

  // 工具表：办公室没起来就隔一会儿再试（表是稳定的，拉一次就够）
  const trySyncTools = async () => {
    if (st.stopped) return;
    try {
      await syncTools();
      if (st.toolsTimer) { clearInterval(st.toolsTimer); st.toolsTimer = null; }
    } catch (e) {
      say('拉工具表失败（办公室还没起来？）：', String((e && e.message) || e));
    }
  };
  void trySyncTools();
  st.toolsTimer = setInterval(() => { void trySyncTools(); }, Number(cfg.toolsRetryMs) || 5000);

  // ⛔ 插件加载之后**什么都不做**：不自动连、不自动上线（规范 `01` §2.2「一切自动连接都不要」）——
  //    等人点「连接」才去挂那条流。内核 `start()` 只是把反向端点支起来，它不连办公室。

  // 卸载时全部收干净
  ctx.on('dispose', () => {
    st.stopped = true;
    if (st.toolsTimer) clearInterval(st.toolsTimer);
    if (Array.isArray(st.panelDisposers)) {
      for (const d of st.panelDisposers) { try { if (typeof d === 'function') d(); } catch { /* 面板路由撤了 */ } }
    }
    for (const dispose of st.regs.values()) {
      try { dispose(); } catch { /* 已经撤了 */ }
    }
    st.regs.clear();
    st.names.clear();
    Promise.resolve(bridge.stop()).catch(() => { /* 端点已经关了 */ });
    say('插件已卸载，连接和定时器都停了');
  });

  say('插件已加载：', JSON.stringify(snapshot()));
}

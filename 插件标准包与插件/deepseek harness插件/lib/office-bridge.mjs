/**
 * office-bridge —— 「办公室」接入端内核（零依赖 · 宿主无关）
 *
 * 依据：本目录的《说明书》（§1 七件事 / §2 第一次接入五步 / §5 五个反向端点）。
 *
 * 它负责「插件 ↔ 办公室」这一段的全部 HTTP 交互：
 *   ① 挂那条常驻连接（SSE）
 *   ② 取卡、存卡、此后每次挂连接带上（`X-Office-Card`）
 *   ③ 报到（`register`：宿主进程名／昵称／模型／会话／门牌号／头像）
 *   ④ 转发工具调用（`POST /api/call`）
 *   ⑤ 起反向端点，收办公室推来的五件事（wake／interrupt／online／connect／challenge）
 *
 * 它**不负责**「宿主 ↔ 插件」那一段 —— 那一段各家不同，由使用者通过 `wake`／`steer`
 * 两个钩子接上（例如 DSH 宿主里调 `sessionController.prompt`）。内核不猜、也不规定。
 *
 * 零依赖：只用 Node 内置模块（node:http／node:fs／node:path／node:crypto）与全局 `fetch`。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   import { createOfficeBridge } from './office-bridge.mjs';
 *
 *   const bridge = createOfficeBridge({
 *     base: 'http://127.0.0.1:8787',  // 办公室地址
 *     memberId: 'myagent',            // 成员 id
 *     name: 'DeepSeek Harness',       // 宿主进程名（由宿主自己取，内核不猜）
 *     nick: '小蓝',                   // 昵称（可省；AI 想起来再改也行）
 *     model: '<你宿主自己的模型名>',           // 报模型用（由宿主自己取，内核不猜）
 *     icon: '<base64>',               // 头像（可省：图片本身的 base64，取自宿主进程图标）
 *     dataDir: '/path/to/writable',   // 必须：卡与状态放这里（宿主给的可写目录）
 *     port: 0,                        // 反向端点端口；0 ＝ 自动挑一个
 *     wake:  async (why) => {},       // 必须：把 AI 叫起来（让它"进来看"，不发正文）
 *     steer: async (text) => {},      // 必须：往会话里插一句话
 *   });
 *
 *   await bridge.start();            // 起反向端点（**不连办公室**）
 *   await bridge.connect();          // 人点「连接」时调
 *   await bridge.online(sessionId);  // 人点「上线」时调
 *   await bridge.callTool('read_messages', { limit: 50 });
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATE_FILE = 'office-bridge-state.json';
const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8' };

/** 读一个 HTTP 请求的 body（JSON）；读不动或不是 JSON 就回 null。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

export function createOfficeBridge(opts = {}) {
  const base = String(opts.base || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const memberId = String(opts.memberId || '');
  const dataDir = String(opts.dataDir || '');
  if (!memberId) throw new Error('office-bridge：需要 memberId（成员 id）');
  if (!dataDir) throw new Error('office-bridge：需要 dataDir（放卡与状态的目录）');

  const hookWake = typeof opts.wake === 'function' ? opts.wake : null;
  const hookSteer = typeof opts.steer === 'function' ? opts.steer : null;
  const log = typeof opts.log === 'function' ? opts.log : (...a) => console.log('[office]', ...a);
  const warn = typeof opts.warn === 'function' ? opts.warn : (...a) => console.warn('[office]', ...a);

  const stateFile = path.join(dataDir, STATE_FILE);
  let nickHinted = false;   // "给 AI 提示过起昵称没" —— 落盘：叫醒一次就是烧一轮，不能每次重启都来一遍

  /** 内核自己的状态。与「办公室那边的状态」是两回事 —— 自己记的一律只当线索，以办公室回话为准。 */
  const st = {
    card: null,           // 接入手续那张卡：{ id, joined, name, icon }
    boundSessionId: '',   // 上一次绑过的会话（跨重启保住 —— 办公室点「叫它上线」要用）
    boundAt: '',
    hostPort: '',         // 本接入端的门牌号（127.0.0.1:port），start() 之后才有
    registered: false,
    connecting: false,
    connected: false,
    ctl: null,            // AbortController：掐断那条 SSE 流用
    server: null,
    port: 0,
    stopped: false,
  };

  // ─────────────── 状态与卡：落盘、读回 ───────────────

  function readState() {
    try {
      const o = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (o && typeof o.boundSessionId === 'string') st.boundSessionId = o.boundSessionId;
      if (o && typeof o.boundAt === 'string') st.boundAt = o.boundAt;
      if (o && o.card && typeof o.card === 'object') st.card = o.card;
      if ((o && o.nickHinted) === true) nickHinted = true;
    } catch { /* 第一次用没有这份文件，正常 */ }
  }

  function writeState() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        boundSessionId: st.boundSessionId || '',
        boundAt: st.boundAt || '',
        card: st.card || null,
        nickHinted: nickHinted === true,
        at: new Date().toISOString(),
      }, null, 2), 'utf8');
    } catch (e) {
      warn('状态没能落盘（不影响运行）：', String((e && e.message) || e));
    }
  }

  // ─────────────── 与办公室通话的底层口 ───────────────

  /** 调一个办公室工具。**注意**：办公室仍然会回 `{ok:false, error}` —— 那是业务回话，不是"内核坏了"。 */
  async function callTool(tool, args = {}) {
    const res = await fetch(`${base}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId, tool, args }),
    });
    return await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  }

  /** 组装 `X-Office-Card`：手上有卡就带、没有就空手（第一次按"新人"放行）。 */
  function cardHeader() {
    if (!st.card) return '';
    const four = { id: st.card.id || '', joined: st.card.joined || '', name: st.card.name || '', icon: st.card.icon || '' };
    return Buffer.from(JSON.stringify(four), 'utf8').toString('base64');
  }

  // ─────────────── ① + ③：挂连接、报到 ───────────────

  /**
   * 报到。`withHost` ＝ 是否连门牌号一起报（第一次挂连接时报一次就够）。
   * 必须**已经挂着连接**才能调 —— 报到也过那道准入校验。
   */
  async function register(sessionId, withHost) {
    const sid = String(sessionId || st.boundSessionId || '');
    if (!sid) return { ok: false, error: '没有会话 id（先调 online(sessionId) 或把 sid 传进来）' };
    const r = await callTool('register', {
      memberId,
      sessionId: sid,
      name: opts.name,
      nick: opts.nick,
      model: opts.model,
      host: withHost ? (st.hostPort || undefined) : undefined,
      icon: opts.icon || undefined,
    });
    if (r && r.ok !== false) {
      st.registered = true;
      // 办公室**回传那张卡** —— 存下来，此后每次挂连接都要带上（接入手续）。
      const back = r.data && r.data.card;
      if (back && typeof back === 'object') {
        const got = { id: back.id || '', joined: back.joined || '', name: back.name || '', icon: back.icon || '' };
        st.card = got;
        writeState();
      }
      // 首次建卡：提示 AI 可以给自己起个昵称。只提示一次，且真送出去了才记（叫醒一次就是烧一轮）。
      if (!nickHinted && hookWake) {
        hookWake('【办公室】尚未设置昵称：可以自行填一个，也可以不填。本条无需立刻处理。')
          .then((sent) => { if (sent) { nickHinted = true; writeState(); } })
          .catch(() => {});
      }
    }
    return r;
  }

  /**
   * 连一次：挂 `GET /api/alive` 那条 SSE 流，一直读到断为止。
   * **只在人点「连接」时调用**；断了**不自己重挂**（说明书 §1 第 1 件）。
   * 调用方不得 await 它 —— 它挂到断为止（`connect()` 已代为完成）。
   */
  async function connectOnce() {
    if (st.stopped || st.connected || st.connecting) return;
    const ctl = new AbortController();
    st.connecting = true;
    const head = cardHeader();
    try {
      const url = `${base}/api/alive?memberId=${encodeURIComponent(memberId)}`;
      const res = await fetch(url, {
        headers: head ? { accept: 'text/event-stream', 'x-office-card': head } : { accept: 'text/event-stream' },
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`挂连接被拒：HTTP ${res.status}`);
      st.ctl = ctl;
      st.connected = true;
      st.connecting = false;
      log('连接挂上了');
      // 连上就报到一次（顺序不能反：报到也走那道门）
      // ⚠️ 2026-10-06 加一道判断：**没绑过会话就别去报** —— 报到必须带会话 id，而"第一次接入"
      //    这种情形（人刚点「连接」、还没点过「上线」）内核自己就会把它挡下
      //    （`register()` 开头那句"没有会话 id"）⇒ 报也报不成，只在控制台留一句「报到没成」吓人。
      //    报到的正经时机是「上线」：`online()` 会带着会话 id 好好报一次。
      //    ⚠️ **行为零变化**：原来那次调用连网络请求都不会发、必然返回 `{ok:false}`（纯降噪）。
      if (st.boundSessionId) {
        const r = await register(st.boundSessionId, true);
        if (r && r.ok === false) warn('报到没成：', r.error || r.notify || r);
      }
      // 一直读，读到流结束（＝办公室关了或网络断了）
      const reader = res.body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
      if (!st.stopped) log('连接被对端关掉了 —— 按规矩不自己重挂，要连得人重新点「连接」');
    } catch (e) {
      if (!st.stopped) log('连接断了：', String((e && e.message) || e));
    } finally {
      st.ctl = null;
      st.connected = false;
      st.connecting = false;
      st.registered = false;   // 线断了 ⇒ 下次连上要重新报到
    }
  }

  // ─────────────── ⑤：反向端点（办公室 → 插件，只有这五个） ───────────────

  function sendJson(res, code, obj) {
    res.writeHead(code, JSON_HEAD);
    res.end(JSON.stringify(obj));
  }

  /** 把五个端点装到内核自己起的 http 服务上（不借宿主的 webServer —— 那样换宿主就用不了）。 */
  function buildServer() {
    return http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只收 POST' });
      const body = (await readJsonBody(req)) || {};
      const who = String(body.memberId || '');
      if (who && who !== memberId) return sendJson(res, 200, { ok: false, error: `推来的成员与本接入端不符（${who}）` });

      switch (url.pathname) {
        // 叫醒：推的是"命令"，不是正文 —— 内核只负责把它叫起来
        case '/dsh-office/wake': {
          if (!hookWake) return sendJson(res, 200, { ok: false, error: '没接 wake 钩子' });
          const why = body.reason === 'called-online' ? '办公室请求本接入端上线' : '有消息指向本接入端';
          try { return sendJson(res, 200, { ok: !!(await hookWake(why)) }); }
          catch (e) { return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }); }
        }
        // 插话：原样插进去，插完即止、不等回话
        case '/dsh-office/interrupt': {
          const text = String(body.text || '时间到了，请停');
          if (!hookSteer) return sendJson(res, 200, { ok: false, error: '没接 steer 钩子' });
          try { return sendJson(res, 200, { ok: !!(await hookSteer(text)) }); }
          catch (e) { return sendJson(res, 200, { ok: false, error: String((e && e.message) || e) }); }
        }
        // 请它上线：只把它叫醒（投到"上一次绑过的会话"），上线由 AI 自己完成
        case '/dsh-office/online': {
          if (!st.boundSessionId) return sendJson(res, 200, { ok: false, error: '上线异常：没有绑过任何会话' });
          if (!hookWake) return sendJson(res, 200, { ok: false, error: '上线异常：没接 wake 钩子' });
          try { return sendJson(res, 200, { ok: !!(await hookWake('办公室在成员卡上点「叫它上线」')) }); }
          catch (e) { return sendJson(res, 200, { ok: false, error: `上线异常：${String((e && e.message) || e)}` }); }
        }
        // 探活：答 sha256(id + "/" + nonce) 的小写十六进制
        case '/dsh-office/challenge': {
          const nonce = String(body.nonce || '');
          const answer = crypto.createHash('sha256').update(`${memberId}/${nonce}`, 'utf8').digest('hex');
          return sendJson(res, 200, { ok: true, answer });
        }
        // 请它连／断：跟"在插件上点连接"是同一个动作
        case '/dsh-office/connect': {
          const on = body.on === true;
          if (on) { connectOnce(); return sendJson(res, 200, { ok: true, connected: true }); }
          try { if (st.ctl) st.ctl.abort(); } catch { /* 已经断了 */ }
          return sendJson(res, 200, { ok: true, connected: false });
        }
        default:
          return sendJson(res, 404, { ok: false, error: '没有这个端点' });
      }
    });
  }

  // ─────────────── 对外的那几个动作 ───────────────

  return {
    /** 起反向端点（**不连办公室**）。port: 0 ⇒ 自动挑一个空闲端口。 */
    async start() {
      readState();
      const port = Number.isInteger(opts.port) ? opts.port : 0;
      await new Promise((resolve, reject) => {
        const srv = buildServer();
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => {
          st.server = srv;
          st.port = srv.address().port;
          st.hostPort = `127.0.0.1:${st.port}`;   // 这就是"门牌号"
          log('反向端点已起，门牌号 =', st.hostPort);
          resolve();
        });
      });
      return st.hostPort;
    },

    /** 人点「连接」：挂那条常驻连接（不 await 那条流本身）。 */
    connect() { connectOnce(); return true; },

    /** 人点「断开」：掐掉那条流。掐了就掐了，不会自己连回来。 */
    disconnect() { try { if (st.ctl) st.ctl.abort(); } catch { /* 已经断了 */ } return true; },

    /** 人点「上线」：绑住这个会话 ＋ 报到 ＋ 上线（顺序：先绑、再报到、再上线）。 */
    async online(sessionId) {
      const sid = String(sessionId || '');
      if (!sid) return { ok: false, error: '上线需要一个会话 id' };
      st.boundSessionId = sid;
      st.boundAt = new Date().toISOString();
      writeState();
      const r1 = await register(sid, true);
      if (r1 && r1.ok === false) return r1;
      return await callTool('presence', { memberId, presence: 'online' });
    },

    /**
     * 人点「下线」：**先向办公室报下线**（顺序不能反）。
     * **不碰"上一次绑过的会话"** —— 下线只是撤掉"在岗"，不是把那个地址删掉：
     *    地址留着，办公室点「叫它上线」才叫得到人（说明书 §1）。
     * 2026-10-05 修：原来这里把 `boundSessionId`／`boundAt` 清空了 —— 清了之后办公室
     *    点「叫它上线」就没地方叫、只能报「上线异常」（2026-10-04 在旧插件上实测撞过同一个坑）。
     */
    async offline() {
      return await callTool('presence', { memberId, presence: 'offline' });
    },

    /** 转发一个工具调用（AI 的动作都走这里）。 */
    callTool,

    /** 查当前状态（给宿主做界面用；自己记的只当线索，以办公室回话为准）。 */
    status() {
      return {
        memberId,
        hostPort: st.hostPort,
        connected: st.connected,
        connecting: st.connecting,
        registered: st.registered,
        boundSessionId: st.boundSessionId,
        hasCard: !!st.card,
      };
    },

    /** 看当前那张卡（四格）。 */
    card() { return st.card ? { ...st.card } : null; },

    /** 收摊：掐连接、关端点。 */
    async stop() {
      st.stopped = true;
      try { if (st.ctl) st.ctl.abort(); } catch { /* 已经断了 */ }
      if (st.server) await new Promise((r) => st.server.close(r));
    },
  };
}

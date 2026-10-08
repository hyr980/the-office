#!/usr/bin/env node
/**
 * office-host —— 「办公室接入插件」的**宿主侧常驻进程**（Claude Desktop 这一半的落脚点）
 *
 * 分工（正本：《插件标准包与插件》README「两段分开，各管各的」）：
 *   · 「插件 ↔ 办公室」＝ **本进程里的内核**（`../kernel/office-bridge.mjs`，逐字节照搬标准包，
 *     一个字没改）。挂那条常驻连接、取卡存卡、报到、转发工具、五个反向端点，全归它。
 *   · 「宿主 ↔ 插件」＝ **本文件**（各家不同、本包不规定）。它做两件事：
 *       ① 把内核的两个钩子（`wake`／`steer`）接到**插件那一半**去 ——
 *          往 stdout 写一行 JSON，等插件回来在控制口上回话，再把成败交还给内核；
 *       ② 开一个**只监听 127.0.0.1** 的控制口，让插件那半能按人点的按钮调内核的动作。
 *
 * 为什么非得是个常驻的独立进程（不能塞进插件模块里）：
 *   · 那条常驻连接是 **SSE**（一直读、不结束）—— 钩子模块拿到的取网口是"读完整个 body 才回"，
 *     握不住一条不结束的流；
 *   · 五个反向端点要**有人监听一个端口** —— 钩子模块里没有服务器。
 *   ⇒ 于是：插件模块负责界面与"唤醒会话"，这个进程负责协议。两半之间走两条线：
 *     · 内核 → 插件：stdout 的 JSON 行（`{"t":"wake"...}` 等）
 *     · 插件 → 内核：控制口上的 POST（下面那六个路由）
 *
 * 用法：node office-host.mjs
 * 配置**走环境变量**递进来（`OFFICE_HOST_CONFIG`，一个 JSON），见下面 readConfig。
 * 为什么不落配置文件：插件那半的目录是**热重载盯着**的 —— 往里头写文件会被当成"改了插件"
 *    而触发一次重载（自己把自己重启，循环）。环境变量没这个毛病，也省得管临时文件的清理。
 *
 * 输出纪律：**stdout 只写 JSON 行**（协议），人看的日志一律走 **stderr**。
 *     这样插件那半解析 stdout 时不用猜哪行是日志。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createOfficeBridge } from '../kernel/office-bridge.mjs';

/** 叫醒/插话等插件回话的时限（毫秒）。到点没回话 ⇒ 如实告诉内核"没送到"。 */
const WAKE_TIMEOUT_MS = 10000;
const STEER_TIMEOUT_MS = 10000;

const say = (...a) => { try { process.stderr.write('[office-host] ' + a.join(' ') + '\n'); } catch { /* 管道没了 */ } };
const emit = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* 管道没了 */ } };

// ─────────────────────────────── 配置

function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 头像：只收**图片文件的路径**，base64 在这儿自己读（《说明书》§2 第二步：图片本身的 base64）。 */
function readIcon(iconFile) {
  const p = expandHome(iconFile || '');
  if (!p) return undefined;
  try { return fs.readFileSync(p).toString('base64'); }
  catch (e) { say('头像读不出来（不影响接入）：' + p + '｜' + String((e && e.message) || e)); return undefined; }
}

function readConfig() {
  const rawText = process.env.OFFICE_HOST_CONFIG || '';
  if (!rawText) { say('没给配置：环境变量 OFFICE_HOST_CONFIG 是空的'); process.exit(2); }
  let raw;
  try { raw = JSON.parse(rawText); }
  catch (e) { say('配置不是合法 JSON：' + String((e && e.message) || e)); process.exit(2); }
  if (!raw || !raw.memberId) { say('配置里缺 memberId'); process.exit(2); }
  const dataDir = expandHome(raw.dataDir || '~/.claude/office-desktop');
  return {
    base: String(raw.base || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    memberId: String(raw.memberId),
    name: String(raw.name || 'Claude Desktop'),
    nick: raw.nick ? String(raw.nick) : undefined,
    model: raw.model ? String(raw.model) : undefined,
    icon: readIcon(raw.iconFile),
    dataDir,
    /** 反向端点端口：固定 ⇒ 门牌号跨重启不变（办公室记着上次报的那个）。0 ＝ 随便挑一个。 */
    port: Number.isInteger(raw.port) ? raw.port : 0,
    /** 控制口端口：0 ＝ 随便挑一个（挑到的号在 ready 那行告诉插件）。 */
    ctlPort: Number.isInteger(raw.ctlPort) ? raw.ctlPort : 0,
    verbose: raw.verbose === true,
  };
}

const cfg = readConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

// ─────────────────────────────── 内核 → 插件：一行 JSON 去，一条回话回来

let seq = 0;
/** 等插件回话的那些请求：id ⇒ { settle }。 */
const pending = new Map();

/**
 * 往插件那半发一条"要它做事"，并**等它回话**。
 * 为什么必须等：办公室要的是 `{ok}`。不等就答 `{ok:true}`，等于把"送到了没有"蒙一个 ——
 *    尤其 `/dsh-office/online` 那条，办公室要靠 `{ok:false}` 在界面上显示「上线异常」。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
function ask(type, payload, timeoutMs) {
  const id = ++seq;
  emit({ t: type, id, ...payload });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: '接入插件没在时限内回话（' + Math.round(timeoutMs / 1000) + ' 秒）' });
    }, timeoutMs);
    pending.set(id, (v) => { clearTimeout(timer); pending.delete(id); resolve(v); });
  });
}

// ─────────────────────────────── 建内核（协议全归它）

/**
 * 内核参数**故意留个引用**：内核是在 `start()` 里**现读** `opts.port` 的
 *   （见 `office-bridge.mjs` 的 `start()`：`Number.isInteger(opts.port) ? opts.port : 0`），
 *   所以端口被占时改这个对象再 `start()` 一次就是"换一个端口重来"。
 */
const bridgeOpts = {
  base: cfg.base,
  memberId: cfg.memberId,
  name: cfg.name,
  nick: cfg.nick,
  model: cfg.model,
  icon: cfg.icon,
  dataDir: cfg.dataDir,
  port: cfg.port,
  // 叫醒：推的是"进来看"这条命令，不是正文 —— 内核已经把话写好了，这里只负责递过去
  // 送不到时**抛错，不是返回 false** —— 这一步是特意的，别改回去：
  //    内核的 `wake` 钩子返回假 ⇒ 它只答 `{ok:false}`，**不带 error 文本**；
  //    而《说明书》§5 要求「叫它上线」投不进去时答 `{ok:false, error:"上线异常…"}` ——
  //    办公室正是靠那句话在界面上写「上线异常」的。抛错走进内核自己的 catch，
  //    `/dsh-office/online` 那条就会答成 `上线异常：<原因>`，`/dsh-office/wake` 也带上原因。
  //    （内核一个字没改：这是它自己留的那条路，见 `office-bridge.mjs` 两个 case 里的 try/catch。）
  wake: async (why) => {
    const r = await ask('wake', { why: String(why || '') }, WAKE_TIMEOUT_MS);
    if (!r.ok) {
      say('叫醒没送到：' + (r.error || ''));
      throw new Error(r.error || '叫不醒');
    }
    return true;
  },
  // 插话：原样插进去，插完即止、不等回话（送不到同样抛错，理由同上）
  steer: async (text) => {
    const r = await ask('interrupt', { text: String(text || '') }, STEER_TIMEOUT_MS);
    if (!r.ok) {
      say('插话没送到：' + (r.error || ''));
      throw new Error(r.error || '插不进去');
    }
    return true;
  },
  log: (...a) => { if (cfg.verbose) say(...a); },
  warn: (...a) => say('警告', ...a),
};

const bridge = createOfficeBridge(bridgeOpts);

/**
 * 问办公室：本接入端此刻是否在线（离线原因是给界面写的）。
 * 只读调用，不写办公室日志 ⇒ 可以定期问；带 4 秒缓存，免得插件每 2 秒一拉就打一次。
 * 权威在办公室 —— 插件自己记的那个只当线索（被踢下线时它不会知道）。
 */
const presenceCache = { at: 0, presence: '', offlineReason: '', err: '' };
async function queryPresence() {
  if (!bridge.status().connected) { presenceCache.presence = ''; presenceCache.offlineReason = ''; return presenceCache; }
  const now = Date.now();
  if (presenceCache.at && now - presenceCache.at < 4000) return presenceCache;
  try {
    const r = await bridge.callTool('get_members', {});
    const list = (r && r.data && r.data.members) || [];
    const me = list.find((x) => x && x.id === cfg.memberId);
    presenceCache.presence = String((me && me.presence) || '');
    presenceCache.offlineReason = String((me && me.offlineReason) || '');
    presenceCache.err = me ? '' : ('名单里没有「' + cfg.memberId + '」；拿到：' + JSON.stringify(list.map((x) => x && x.id)));
    presenceCache.at = now;
  } catch (e) {
    presenceCache.err = '查询抛错：' + String((e && e.message) || e);
  }
  return presenceCache;
}

// ─────────────────────────────── 控制口（插件 → 内核）；只认本机

const JSON_HEAD = { 'Content-Type': 'application/json; charset=utf-8' };

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctl = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, JSON_HEAD);
    res.end(JSON.stringify(obj));
  };
  // 只认本机：这个口能连办公室、能改绑定，不该让局域网里别的东西够着
  const remote = String(req.socket.remoteAddress || '');
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    return send(403, { ok: false, error: '控制口只认本机' });
  }
  if (req.method !== 'POST') return send(405, { ok: false, error: '只收 POST' });

  const url = new URL(req.url, 'http://127.0.0.1');
  const body = await readJsonBody(req);

  try {
    switch (url.pathname) {
      // 面板拉状态（每 2 秒一次）
      case '/ctl/state': {
        const bs = bridge.status();
        const p = await queryPresence();
        return send(200, {
          ok: true,
          status: bs,
          presence: p.presence,
          offlineReason: p.offlineReason,
          presenceErr: p.err,
        });
      }
      // 人点「连接／断开」——第一层，**不碰绑定**
      case '/ctl/layer1': {
        const on = body.on === true;
        if (!on) {
          bridge.disconnect();
          return send(200, { ok: true, connected: false });
        }
        // 点「连接」⇒ 等一次真结果再回报（"办公室没开，点了就该显示连不上"）
        // 别 await 那条连接本身 —— 它挂到断为止；这里只等"连上没连上"这个结论
        bridge.connect();
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          const s = bridge.status();
          if (s.connected) break;
          if (!s.connecting) break;   // 试连结束、但没连上 ⇒ 这就是结论
          await sleep(100);
        }
        const connected = bridge.status().connected;
        return send(200, { ok: connected, connected, error: connected ? undefined : '连不上办公室（它没开？）' });
      }
      // 人点「上线」——第二层：绑住这个会话 ＋ 报到 ＋ 上线（内核 online 就是这三步）
      case '/ctl/link': {
        const sid = String(body.sessionId || '');
        if (!sid) return send(200, { ok: false, error: '没给 sessionId' });
        // 插件那半知道"本会话当前的模型" ⇒ 顺手刷新要报的那个
        // （内核是在**报到时**现读 `opts.model` 的，见 `office-bridge.mjs` 的 register）
        if (body.model) bridgeOpts.model = String(body.model);
        const r = await bridge.online(sid);
        return send(200, { ok: !!(r && r.ok !== false), office: r, boundSessionId: bridge.status().boundSessionId });
      }
      // 人点「下线」——只撤"在岗"，**不解除绑定**（那条地址留着，办公室才叫得到人）
      case '/ctl/unlink': {
        const was = bridge.status().boundSessionId;
        const told = bridge.status().connected ? await bridge.offline() : null;
        return send(200, { ok: true, wasBound: was, stillBound: bridge.status().boundSessionId || '', office: told });
      }
      // AI 调办公室工具 —— 转发一条
      case '/ctl/call': {
        const tool = String(body.tool || '');
        if (!tool) return send(200, { ok: false, error: '没给 tool' });
        const r = await bridge.callTool(tool, body.args || {});
        return send(200, { ok: true, result: r });
      }
      // 插件回话：那两件事（叫醒／插话）办成了没有
      case '/ctl/reply': {
        const id = Number(body.id);
        const settle = pending.get(id);
        if (!settle) return send(200, { ok: false, error: '这条已经超时了，没人等它' });
        settle({ ok: body.ok === true, error: body.error ? String(body.error) : undefined });
        return send(200, { ok: true });
      }
      default:
        return send(404, { ok: false, error: '没有这个控制路由' });
    }
  } catch (e) {
    return send(200, { ok: false, error: String((e && e.message) || e) });
  }
});

// ─────────────────────────────── 起来

ctl.on('error', (e) => say('控制口起不来：' + String((e && e.message) || e)));

process.on('unhandledRejection', (e) => say('未处理的 rejection（不影响运行）：' + String((e && e && e.message) || e)));

let shuttingDown = false;
async function shutdown(why) {
  if (shuttingDown) return;
  shuttingDown = true;
  say('收摊：' + why);
  try { await bridge.stop(); } catch { /* 端点已经关了 */ }
  try { ctl.close(); } catch { /* 已经关了 */ }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

try {
  // ① 内核的反向端点（**不连办公室** —— 挂连接要等人点「连接」）
  // 配置里那个固定端口被占（最常见的：上一个实例还没退干净）⇒ **退回随便挑一个**，
  //    并明说这一次门牌号变了。宁可门牌号变一次，也别让整个接入端起不来。
  try {
    await bridge.start();
  } catch (e) {
    let msg = String((e && e.message) || e);
    const want = bridgeOpts.port;
    if (want === 0) throw e;
    // **先占两次原端口再退让**：重载时上一个实例往往**还没退干净**，端口那一瞬间还在它手里 ——
    //    等一拍它就放了。门牌号因此不漂。
    //    为什么要紧：办公室记着上次报的门牌号，漂一次虽能靠下次报到自愈，但没必要。
    let ok = false;
    for (let i = 1; i <= 2 && !ok; i += 1) {
      say(`反向端点用 ${want} 起不来（${msg}）⇒ 等一拍再占一次（第 ${i}/2 次）`);
      await sleep(800);
      try { await bridge.start(); ok = true; } catch (e2) { msg = String((e2 && e2.message) || e2); }
    }
    if (!ok) {
      say(`两次都没占上 ${want}（${msg}）⇒ 退回自动挑一个端口。`);
      say('这一次门牌号变了：要等下一次报到，办公室才叫得到人（它记着上次报的那个）。');
      bridgeOpts.port = 0;
      await bridge.start();
    }
  }
  // ② 控制口（0 ＝ 随便挑一个空闲端口）
  await new Promise((resolve, reject) => {
    ctl.once('error', reject);
    ctl.listen(cfg.ctlPort, '127.0.0.1', resolve);
  });
} catch (e) {
  say('起不来：' + String((e && e.message) || e));
  emit({ t: 'fatal', error: String((e && e.message) || e) });
  process.exit(1);
}

const status = bridge.status();
emit({
  t: 'ready',
  pid: process.pid,
  ctlPort: ctl.address().port,
  hostPort: status.hostPort,        // ← 门牌号（要报到给办公室的那个）
  dataDir: cfg.dataDir,
  hasCard: status.hasCard,
  boundSessionId: status.boundSessionId,
});
say('起来了：门牌号=' + status.hostPort + '｜控制口=127.0.0.1:' + ctl.address().port
  + '｜状态目录=' + cfg.dataDir + '｜本地有卡=' + status.hasCard);

// 起来之后**什么都不做**：不自动连、不自动上线（《说明书》§1 第 1 件／§8 第 6 条）。
//    等人点「连接」才去挂那条流；断了也不自己重挂。

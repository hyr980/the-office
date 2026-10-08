#!/usr/bin/env node
/**
 * office-host —— 「办公室接入插件」的宿主侧**常驻进程**（ZCode 这一半的落脚点）
 *
 * 分工（正本：《插件标准包》README「两段分开，各管各的」）：
 *   · 「插件 ↔ 办公室」＝ **本进程里的内核**（`../kernel/office-bridge.mjs`，逐字节照搬标准包，
 *     一个字没改）。挂那条常驻连接、取卡存卡、报到、转发工具、五个反向端点，全归它。
 *   · 「宿主 ↔ 插件」＝ **本文件**（各家不同、标准包不规定）。它做三件事：
 *       ① 把内核的两个钩子（`wake`／`steer`）接到 **ZCode CLI** 上 ——
 *          叫醒 ＝ `node <zcode.cjs> -p "进来看" --resume <绑定的会话id> --json`（推的是命令，不带正文）；
 *          插话在 ZCode 上**没有**"插进正在跑的那一轮"的口 ⇒ **降级为排队投递**（同一条 CLI 路），
 *          README 里如实写明"这不是插话"。
 *       ② 开一个**只监听 127.0.0.1** 的控制口，让 hook／MCP 服务器能替人按按钮、替 AI 转发工具。
 *       ③ 把 `{pid, ctlPort, hostPort}` 写进数据目录的 `office-runtime.json` ——
 *          ZCode 这边没有"插件模块"替它读 stdout，hook／MCP 靠这份指针找到它。
 *
 * 谁拉起本进程：`hooks/session-start.mjs`（SessionStart 事件，detached）。
 * 自测时由 test/host-self-check.mjs 直接 spawn（走 OFFICE_HOST_CONFIG 环境变量，不沾用户配置）。
 *
 * ⚠️ 输出纪律：**stdout 只写 JSON 行**（协议，留给自测读），人看的日志一律走 **stderr**。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createOfficeBridge } from '../kernel/office-bridge.mjs';
import { loadConfig, runtimeFile } from './office-config.mjs';

const say = (...a) => { try { process.stderr.write('[office-host] ' + a.join(' ') + '\n'); } catch { /* 管道没了 */ } };
const emit = (obj) => { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* 管道没了 */ } };

// ─────────────────────────────── 配置与单实例

const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

// ─────────────────────────────── 报到要交的「身份」：头像 ＋ 模型

/**
 * 读一个头像文件转 base64（《说明书》§2 第二步：交**图片本身**，不是路径）。
 * 读不动回空串（上层还有兜底）。
 */
function readIconFile(p) {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length < 100) throw new Error(`文件只有 ${buf.length} 字节，不像图标`);
    return buf.toString('base64');
  } catch (e) {
    say('头像文件读不出来（换下一个来源）：' + p + '｜' + String((e && e.message) || e));
    return '';
  }
}

/** 从 `zcodePath`（…\resources\glm\zcode.cjs）反推宿主（ZCode）安装目录里的候选文件。 */
function iconCandidates() {
  const out = [];
  const cli = String(cfg.zcodePath || '');
  if (cli) {
    const resDir = path.dirname(path.dirname(cli));   // …\resources
    const rootDir = path.dirname(resDir);             // 安装根（ZCode.exe 在这儿）
    out.push(path.join(resDir, 'icon.png'), path.join(resDir, 'icon_windows.png'));
    out.push(path.join(rootDir, 'ZCode.exe'), path.join(rootDir, 'zcode.exe'));
  }
  return out;
}

/** PNG 魔数：界面写死 `data:image/png;base64,` ⇒ 自动挑的文件必须真是 PNG（手动 iconFile 仍全信，见 §五 README）。 */
function isPng(buf) {
  return !!buf && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

/**
 * 自动找宿主自带的应用图标（PNG）：《说明书》§2 第二步"第一次上线必须交头像（取自宿主进程的图标）"——
 * 0.1.1 只认手工配的 `iconFile`，没配就交不了 ⇒ 2026-10-07 补上这条路。
 */
function findAutoIconPng() {
  for (const p of iconCandidates()) {
    if (!/\.png$/i.test(p)) continue;
    try {
      const buf = fs.readFileSync(p);
      if (!isPng(buf)) { say('自动头像候选不是 PNG，跳过：' + p); continue; }
      say('头像：用宿主自带的应用图标 ' + p + '（base64 ' + Math.floor((buf.length * 4) / 3) + ' 字符）');
      return buf.toString('base64');
    } catch { /* 读不动换下一个 */ }
  }
  return '';
}

/** 兜底：PowerShell 抽宿主 exe 的关联图标转 PNG（DSH 参照插件同款）。异步，抽不到回空串。 */
async function grabHostIconByPs(exe) {
  if (!exe) return '';
  const ps = 'Add-Type -AssemblyName System.Drawing; '
    + `$i=[System.Drawing.Icon]::ExtractAssociatedIcon('${String(exe).replace(/'/g, "''")}'); `
    + '$b=$i.ToBitmap(); $ms=New-Object System.IO.MemoryStream; '
    + '$b.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); '
    + '[Convert]::ToBase64String($ms.ToArray())';
  try {
    const b64 = await new Promise((resolve) => {
      let out = '';
      const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      const t = setTimeout(() => { try { c.kill(); } catch { /* 已经退了 */ } resolve(''); }, 20000);
      c.stdout.on('data', (d) => { out += String(d); });
      c.on('error', () => { clearTimeout(t); resolve(''); });
      c.on('close', () => { clearTimeout(t); resolve(String(out).trim()); });
    });
    if (b64 && b64.length > 100) {
      say('头像：PowerShell 从宿主 exe 抽到图标（base64 ' + b64.length + ' 字符）');
      return b64;
    }
    say('头像：PowerShell 没抽到宿主图标（' + exe + '）⇒ 这次报到不带头像');
  } catch (e) {
    say('头像：抽宿主图标失败（不影响接入）：' + String((e && e.message) || e));
  }
  return '';
}

/** 这次报到要交的头像：显式 `iconFile` 优先；没配自动找宿主图标。都空 ⇒ undefined（不报这一格）。 */
function resolveIcon() {
  const b64 = cfg.iconFile ? readIconFile(cfg.iconFile) : '';
  return b64 || findAutoIconPng() || undefined;
}

/**
 * 单实例：数据目录里已有**活着且新鲜**的指针 ＝ 已经有一个常驻进程在跑 ⇒ 安静退出。
 * （hook 只在 ping 不通时才拉起本进程；这里再兜一道，防并发拉起两个。）
 */
function alreadyRunning() {
  try {
    const o = JSON.parse(fs.readFileSync(runtimeFile(cfg), 'utf8'));
    const fresh = o && o.at && (Date.now() - Date.parse(o.at)) < 90000;
    if (fresh && Number.isInteger(o.pid) && o.pid > 0 && o.pid !== process.pid) {
      try { process.kill(o.pid, 0); return true; } catch { /* 那个 pid 没了 ＝ 指针是旧的，接管 */ }
    }
  } catch { /* 没有指针，正常 */ }
  return false;
}
if (alreadyRunning()) {
  say('已经有一个常驻进程在跑（数据目录相同），本份退出。');
  process.exit(0);
}

// ─────────────────────────────── 投递：叫醒 / 插话 ＝ 调 ZCode CLI

/**
 * 投递队列：一次只跑一条（同一个会话同时被推两条，硬挤进去会互相踩）。
 * 每条投递**现取**绑定的会话 —— 排队期间人可能重新上线到别的会话，投给最新的那个。
 */
let deliverChain = Promise.resolve();
function enqueueDeliver(text) {
  const run = deliverChain.then(() => deliverOnce(text));
  deliverChain = run.then(() => {}, () => {});
  return run;
}

async function deliverOnce(text) {
  const sid = bridge.status().boundSessionId;
  if (!sid) throw new Error('没有可投的会话：还没人点过「上线」（在会话里执行 /office-online）');

  // 自测模式：不碰真 CLI，把投递内容落成一行 JSON 供断言（deliverFile 写不进 ＝ 投递失败）。
  if (cfg.wakeMode === 'file') {
    if (!cfg.deliverFile) throw new Error('自测投递没给 deliverFile');
    const line = JSON.stringify({ at: new Date().toISOString(), sessionId: sid, text: String(text) });
    fs.appendFileSync(cfg.deliverFile, line + '\n', 'utf8');
    return;
  }

  // 真用法：调 ZCode CLI，往绑定的那个会话投一段话。
  // ⭐ 推下去的只有"进来看"这条命令／那句插话，**不带消息正文**（正文在账本里，AI 自己会读）。
  const argv = [cfg.zcodePath, '-p', String(text), '--resume', sid, '--json'];
  if (cfg.mode) argv.push('--mode', cfg.mode);
  await runCliWithGrace(argv, cfg.wakeGraceMs);
}

/**
 * 跑一条 CLI 投递，按"宽限"判定成败：
 *   · 宽限内退出：退出码 0 ＝ 成；非 0 ＝ 败（把 stderr 尾巴带给办公室，界面才显示得出原因）。
 *   · 宽限到点还在跑 ＝ 会话已接下这段话、那一轮正在跑 ⇒ 当"送到了"。
 * ⚠️ 跟参照插件 1.5 秒宽限是同一个局限：那一轮**后来**才失败的话，这里已经答过 ok 了 —— 如实写进 README。
 */
function runCliWithGrace(argv, graceMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderrTail = '';
    const child = spawn(cfg.nodePath, argv, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve();   // 还在跑 ＝ 已被接受；不去杀它 —— 那一轮要跑完
    }, Math.max(1000, Number(graceMs) || 15000));
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + String(c)).slice(-800); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('起不了 ZCode CLI（node/zcodePath 配置对吗）：' + String((e && e.message) || e)));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ZCode CLI 退出码 ${code}：${stderrTail.trim() || '（无错误输出）'}`));
    });
  });
}

/**
 * 插件贡献的 MCP 工具在本宿主里的真名：`mcp__plugin_<插件id>_<服务器名>__<工具名>`。
 * ⚠️ 2026-10-07 真机实测更正：不是 `mcp__office__<工具名>` —— 那是 Claude Code 的命名规矩；
 *    ZCode 在中间多垫了 `plugin_<插件id>_` 一段（本插件 id＝office-zcode、服务器名＝office）。
 */
const MCP_TOOL = (t) => `mcp__plugin_office-zcode_office__${t}`;

/** 叫醒的那句话（不是正文）。只有两种例外，其余都套"进来看"模板。 */
function wakeText(why) {
  const w = String(why || '');
  if (w.startsWith('【办公室】')) return w;   // 内核自己的整段提示（起昵称那条）⇒ 原样送
  if (/叫它上线|叫你上线/.test(w)) {
    // 人在办公室的成员卡上点的「叫它上线」—— 只负责叫醒，"上线"要它自己来做（《说明书》§5）
    return '【办公室】老大在办公室叫你上线，进来自己上线。\n'
      + `· 上线：调 ${MCP_TOOL('office_online')}（它会把当前会话绑上去并报到）。`;
  }
  return `【办公室】有人找你，进来看看。${w ? `（${w}）` : ''}\n`
    + `· 读账本：${MCP_TOOL('read_messages')}　· 看任务：${MCP_TOOL('list_tasks')}　· 看自己在不在线：${MCP_TOOL('get_member')}\n`
    + `· 回话／交付／表态都用办公室的工具（${MCP_TOOL('send_message')} / ${MCP_TOOL('refuse')} / ${MCP_TOOL('over')}）；`
    + `派发要当场表态：接 ⇒ 发 task.ack，不接 ⇒ ${MCP_TOOL('refuse')}。`;
}

// ─────────────────────────────── 建内核（协议全归它）

const bridgeOpts = {
  base: cfg.base,
  memberId: cfg.memberId,
  name: cfg.name,
  nick: cfg.nick || undefined,
  // 模型：**配置项照报**（0.2.0 定案 —— 2026-10-07 试过在宿主里扫 model-io 流水自动探测，
  // 为一张显示标签给宿主添一份脆弱依赖，不值得，撤了）。填了照报；留空＝不报这一格。
  // ⚠️ 仍是**可变槽位**：内核每次报到都会重读 `opts.model`／`opts.icon`（内核 `register()` 里的读法）。
  model: cfg.model || undefined,
  icon: resolveIcon(),
  dataDir: cfg.dataDir,
  port: cfg.port,
  // 叫醒：推的是"进来看"这条命令，不是正文 —— 内核已经把话写好了，这里负责递出去。
  // ⚠️ 送不到时**抛错，不是返回 false** —— 《说明书》§5 要求「叫它上线」投不进去时答
  //    `{ok:false, error:"上线异常…"}`，办公室靠这句在界面上显示「上线异常」。
  //    抛错走进内核自己的 catch（内核一个字没改，这是它留的那条路）。
  wake: async (why) => {
    try { await enqueueDeliver(wakeText(why)); return true; }
    catch (e) { say('叫醒没送到：' + String((e && e.message) || e)); throw e; }
  },
  // 插话：原样投进去。⚠️ ZCode 没有"插进正在跑的那一轮"的口，这条路实际是**排队投递** ——
  //    排在它当前那一轮后面，README 里如实写明"这不是插话"。
  steer: async (text) => {
    try { await enqueueDeliver(String(text || '时间到了，请停')); return true; }
    catch (e) { say('插话没送到：' + String((e && e.message) || e)); throw e; }
  },
  log: (...a) => { if (cfg.verbose) say(...a); },
  warn: (...a) => say('⚠', ...a),
};

const bridge = createOfficeBridge(bridgeOpts);

/**
 * 问办公室"我到底还在不在线"（只读调用；带 4 秒缓存）。
 * 权威在办公室 —— 自己记的那个只当线索（被踢下线时自己不会知道）。
 */
const presenceCache = { at: 0, presence: '', offlineReason: '', err: '' };
async function queryPresence() {
  if (!bridge.status().connected) { presenceCache.presence = ''; presenceCache.offlineReason = ''; presenceCache.at = 0; return presenceCache; }
  const now = Date.now();
  if (presenceCache.at && now - presenceCache.at < 4000) return presenceCache;
  try {
    const r = await bridge.callTool('get_members', {});
    const list = (r && r.data && r.data.members) || [];
    const me = list.find((x) => x && x.id === cfg.memberId);
    presenceCache.presence = String((me && me.presence) || '');
    presenceCache.offlineReason = String((me && me.offlineReason) || '');
    presenceCache.err = me ? '' : (`名单里没有「${cfg.memberId}」；拿到：` + JSON.stringify(list.map((x) => x && x.id)));
    presenceCache.at = now;
  } catch (e) {
    presenceCache.err = '查询抛错：' + String((e && e.message) || e);
  }
  return presenceCache;
}

// ─────────────────────────────── 运行时指针（hook／MCP 靠它找到本进程）

function writeRuntime() {
  try {
    fs.writeFileSync(runtimeFile(cfg), JSON.stringify({
      pid: process.pid,
      ctlPort: ctl.address().port,
      hostPort: bridge.status().hostPort,
      at: new Date().toISOString(),
    }, null, 2), 'utf8');
  } catch (e) {
    say('运行时指针没写进去（hook／MCP 会找不到控制口）：' + String((e && e.message) || e));
  }
}

// ─────────────────────────────── 控制口（hook／MCP → 本进程）；只认本机

/** 本进程的运行态（区别于内核的状态：这里是"ZCode 侧"才知道的事）。 */
const st = { currentSessionId: '', currentSessionAt: '' };

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
      // 存活探针（hook／MCP 判断本进程在不在）
      case '/ctl/ping':
        return send(200, { ok: true, pong: true });

      // hook 报"当前会话"（SessionStart／UserPromptSubmit 都会报 —— 取最近的那一个当"当前"）。
      // ⚠️ 这只是"知道"，**不是绑定**：绑定仍然归人（/office-online）。
      case '/ctl/session': {
        const sid = String(body.sessionId || '');
        if (!sid) return send(200, { ok: false, error: '没给 sessionId' });
        st.currentSessionId = sid;
        st.currentSessionAt = new Date().toISOString();
        return send(200, { ok: true, currentSessionId: st.currentSessionId });
      }

      // 拉状态（office_status 工具、自测都走它）
      case '/ctl/state': {
        const bs = bridge.status();
        const p = await queryPresence();
        return send(200, {
          ok: true,
          status: bs,
          presence: p.presence,
          offlineReason: p.offlineReason,
          presenceErr: p.err,
          currentSessionId: st.currentSessionId,
          memberId: cfg.memberId,
          dataDir: cfg.dataDir,
          // 这次报到打算交的「身份」（0.2.0 起头像有自动兜底，这里亮出来让人看得见）
          report: { model: String(cfg.model || ''), iconChars: String(bridgeOpts.icon || '').length },
        });
      }

      // 人点「连接／断开」——第一层，**不碰绑定**
      case '/ctl/layer1': {
        const want = body.on === true;
        if (!want) {
          bridge.disconnect();
          return send(200, { ok: true, connected: false });
        }
        // ⭐ 点「连接」⇒ 等一次真结果再回报（"办公室没开，点了就该显示连不上"）
        // ⚠️ 别 await 那条连接本身 —— 它挂到断为止；这里只等"连上没连上"这个结论
        bridge.connect();
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          const s = bridge.status();
          if (s.connected || !s.connecting) break;
          await sleep(100);
        }
        const connected = bridge.status().connected;
        return send(200, { ok: connected, connected, error: connected ? undefined : '连不上办公室（它没开？）' });
      }

      // 人点「上线」——第二层：绑住会话 ＋ 报到 ＋ 上线（内核 online 就是这三步）
      // 会话 id：body 给了用 body 的；没给用 hook 报的"当前会话"。
      case '/ctl/link': {
        if (!bridge.status().connected) {
          return send(200, { ok: false, error: '还没连上办公室：得先「连接」（/office-connect）' });
        }
        const sid = String(body.sessionId || st.currentSessionId || '');
        if (!sid) return send(200, { ok: false, error: '拿不到会话 id（hook 没报到过 —— 见 README「边界」）' });
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
  try {
    // 指针是自己的才清（防误删接管者的）
    const o = JSON.parse(fs.readFileSync(runtimeFile(cfg), 'utf8'));
    if (o && o.pid === process.pid) fs.rmSync(runtimeFile(cfg), { force: true });
  } catch { /* 没有就算了 */ }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

try {
  // ① 内核的反向端点（**不连办公室** —— 挂连接要等人点「连接」）
  // ⚠️ 配置里那个固定端口被占（最常见的：上一个实例还没退干净）⇒ **先占两次原端口再退让**；
  //    实在占不上才退回随便挑一个，并明说这一次门牌号变了。
  try {
    await bridge.start();
  } catch (e) {
    let msg = String((e && e.message) || e);
    const want = bridgeOpts.port;
    if (want === 0) throw e;
    let ok = false;
    for (let i = 1; i <= 2 && !ok; i += 1) {
      say(`反向端点用 ${want} 起不来（${msg}）⇒ 等一拍再占一次（第 ${i}/2 次）`);
      await sleep(800);
      try { await bridge.start(); ok = true; } catch (e2) { msg = String((e2 && e2.message) || e2); }
    }
    if (!ok) {
      say(`两次都没占上 ${want}（${msg}）⇒ 退回自动挑一个端口。`);
      say('⚠️ 这一次门牌号变了：要等下一次报到，办公室才叫得到人（它记着上次报的那个）。');
      bridgeOpts.port = 0;
      await bridge.start();
    }
  }
  // ② 控制口（0 ＝ 随便挑一个空闲端口 —— 端口写在运行时指针里，别人不用猜）
  await new Promise((resolve, reject) => {
    ctl.once('error', reject);
    ctl.listen(0, '127.0.0.1', resolve);
  });
} catch (e) {
  say('起不来：' + String((e && e.message) || e));
  emit({ t: 'fatal', error: String((e && e.message) || e) });
  process.exit(1);
}

const status = bridge.status();
// 头像两步都没拿到 ⇒ 兜最后一层：PowerShell 抽宿主 exe 的图标（异步，报到一般发生在人点按钮之后，来得及）。
if (!bridgeOpts.icon) {
  const exe = iconCandidates().find((p) => /\.exe$/i.test(p) && fs.existsSync(p)) || '';
  grabHostIconByPs(exe)
    .then((b64) => { if (b64 && !bridgeOpts.icon) bridgeOpts.icon = b64; })
    .catch(() => { /* 不阻塞：这次报到没头像，下次连接／上线再试 */ });
}
writeRuntime();
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
  + '｜状态目录=' + cfg.dataDir + '｜本地有卡=' + status.hasCard
  + '｜投递方式=' + cfg.wakeMode);

// ⛔ 起来之后**什么都不做**：不自动连、不自动上线（说明书 §1 第 1 件／§8 第 6 条）。
//    等人点「连接」（/office-connect）才去挂那条流；断了也不自己重挂。

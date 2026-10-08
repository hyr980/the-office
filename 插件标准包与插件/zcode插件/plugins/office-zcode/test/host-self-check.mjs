/**
 * 宿主侧那半的自测 —— 用一个「假办公室」把 `host/office-host.mjs` 整个驱动一遍。
 *
 * 为什么用假的（照标准包 `自测.mjs` 的理由）：**完全不碰真办公室的运行数据**
 * （不建成员卡、不动账本），而且能演真办公室演不了的那一半 ——
 * **办公室往宿主推进来**（wake／interrupt／online／connect／challenge）。
 *
 * 它一个人演三个角色：
 *   · 假办公室（HTTP）：收 `/api/alive`、`/api/call`、`/api/tools`，并往宿主的反向端点推
 *   · hook／MCP 那半：读运行时指针、打控制口 —— 就是 `hooks/session-start.mjs` 与
 *     `host/office-mcp.mjs` 干的那些事（hook 用**真脚本**跑；MCP 服务器用**真进程**跑）
 *   · 「被叫醒的会话」由投递记录文件代替：常驻进程配置 `wakeMode:'file'`，
 *     每次叫醒／插话**落一行 JSON**，用例读它断言 —— 真用法（调 ZCode CLI --resume）不在自测里烧模型，
 *     那条路是手工验过的（见 README「验证到哪一步」）。
 *
 * 跑法：node test/host-self-check.mjs
 * 退出码 0 ＝ 全过；非 0 ＝ 有不过的（逐条打印）。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HOST_JS = path.join(ROOT, 'host', 'office-host.mjs');
const HOOK_JS = path.join(ROOT, 'hooks', 'session-start.mjs');
const MCP_JS = path.join(ROOT, 'host', 'office-mcp.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-check-'));

// ─────────────── 0.2.0 自动头像的夹具：假 ZCode 安装树（不沾真安装）
// 头像：从 zcodePath 反推安装目录，自动取 resources\icon.png（缺了退 icon_windows.png）。
const PNG1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
function fakeZcodeTree(root, { iconPng = true, iconWindowsPng = false } = {}) {
  fs.mkdirSync(path.join(root, 'resources', 'glm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'resources', 'glm', 'zcode.cjs'), '// 假 CLI（自测用）\n');
  if (iconPng) fs.writeFileSync(path.join(root, 'resources', 'icon.png'), PNG1x1);
  if (iconWindowsPng) fs.writeFileSync(path.join(root, 'resources', 'icon_windows.png'), PNG1x1);
  return path.join(root, 'resources', 'glm', 'zcode.cjs');
}
const FAKE_CLI = fakeZcodeTree(path.join(DATA, 'fake-zcode'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? '过' : '不过'}  ${name}${detail !== undefined && (detail !== '' || !pass) ? `  —— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────── 假办公室 ───────────────

const seen = { calls: [], aliveCount: 0, lastAliveHeaders: null };
/** 还开着的 SSE 连接（⑰ 断连断言用 —— 常驻进程一死必须全部收掉）。 */
const aliveConns = new Set();

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const office = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // 那条常驻连接（SSE）：挂上不关，办公室每 1 秒写一个探活注释行
  if (req.method === 'GET' && url.pathname === '/api/alive') {
    seen.aliveCount += 1;
    seen.lastAliveHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': alive\n');
    aliveConns.add(res);
    req.on('close', () => { aliveConns.delete(res); });
    return;
  }
  // 工具清单（这个口不经准入校验，MCP 服务器 tools/list 用它）
  if (req.method === 'GET' && url.pathname === '/api/tools') {
    return json(res, { tools: [{ name: 'list_tasks', description: '看任务表', inputSchema: { type: 'object', properties: {} } }] });
  }

  if (req.method === 'POST' && url.pathname === '/api/call') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    seen.calls.push(body);
    if (body.tool === 'register') {
      // 办公室把那张卡**回传**（内核要存下来，以后每次挂连接都要带上）
      return json(res, {
        ok: true,
        data: {
          card: {
            id: body.args.memberId,
            joined: '2026-10-07T12:00:00+08:00',
            name: body.args.name || '',
            icon: body.args.icon || '',
          },
        },
      });
    }
    if (body.tool === 'get_members') {
      return json(res, { ok: true, data: { members: [{ id: body.memberId, presence: 'online', offlineReason: '' }] } });
    }
    if (body.tool === 'boom') return json(res, { ok: false, error: '办公室说：这个我不干' });
    return json(res, { ok: true, data: { echo: body.tool } });
  }

  return json(res, { ok: false, error: '没有这个端点' }, 404);
});

/** 扮演办公室：往宿主的反向端点推一个请求。 */
async function push(hostPort, p, body) {
  const res = await fetch(`http://${hostPort}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => null);
}

// ─────────────── 起宿主进程（投递走文件：不烧模型），读它的 stdout 协议行 ───────────────

const MEMBER = 'host-check';
const DELIVER = path.join(DATA, 'deliver.jsonl');

function hostConfig(over = {}) {
  return {
    base: BASE,
    memberId: MEMBER,
    name: 'ZCode',
    nick: '小测',
    model: 'TestModel-配置直报',
    dataDir: DATA,
    port: 0,          // ⚠️ 自动挑：别跟真插件那个 19400 抢
    wakeMode: 'file',
    deliverFile: DELIVER,
    verbose: false,
    // 自动头像指向夹具（不沾真机器上的 ZCode 安装）
    zcodePath: FAKE_CLI,
    ...over,
  };
}

function spawnHost(cfgObj, outEnv = DATA) {
  const child = spawn(process.execPath, [HOST_JS], {
    env: { ...process.env, OFFICE_HOST_CONFIG: JSON.stringify(cfgObj) },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rec = { child, ready: null, protocol: [] };
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += String(c);
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try { const m = JSON.parse(line); rec.protocol.push(m); if (m.t === 'ready') rec.ready = m; } catch { /* 不是协议行 */ }
      }
      i = buf.indexOf('\n');
    }
  });
  child.stderr.on('data', (c) => { if (process.env.SHOW_LOG) process.stderr.write('[宿主] ' + String(c)); });
  rec.dataDir = outEnv;
  return rec;
}

/** 投递记录（wakeMode:'file' 的落点）里读出全部行。 */
function deliveries() {
  try {
    return fs.readFileSync(DELIVER, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

async function ctlFor(rec, p, body) {
  const r = await fetch(`http://127.0.0.1:${rec.ready.ctlPort}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return await r.json().catch(() => null);
}

// ─────────────── 开跑 ───────────────

await new Promise((r) => office.listen(0, '127.0.0.1', r));
const officePort = office.address().port;
const BASE = `http://127.0.0.1:${officePort}`;
console.log(`假办公室起了：${BASE}\n状态目录：${DATA}\n`);

const A = spawnHost(hostConfig());
{
  const t0 = Date.now();
  while (!A.ready && Date.now() - t0 < 15000) await sleep(50);
}
check('① 常驻进程起来了，报了控制口与门牌号', !!A.ready && /^127\.0\.0\.1:\d+$/.test(A.ready.hostPort || ''),
  `控制口=${A.ready && A.ready.ctlPort}｜门牌号=${A.ready && A.ready.hostPort}`);
const hostPort = A.ready.hostPort;

await sleep(300);
check('① 起来**没有**自动连办公室（不自动连）', seen.aliveCount === 0, `挂连接次数 ${seen.aliveCount}`);
check('① 起来**没有**自动上线（办公室那边没报到过）',
  !seen.calls.some((c) => c.tool === 'presence'), JSON.stringify(seen.calls.map((c) => c.tool)));
{
  const r = await ctlFor(A, '/ctl/state', {});
  check('① 读状态：未连接、未绑定、没卡、没有"当前会话"',
    r?.status?.connected === false && !r?.status?.boundSessionId && r?.status?.hasCard === false && !r?.currentSessionId,
    JSON.stringify(r?.status));
}
{
  const rt = JSON.parse(fs.readFileSync(path.join(DATA, 'office-runtime.json'), 'utf8'));
  check('① 运行时指针落了盘（pid／控制口／门牌号都在，hook／MCP 靠它找到）',
    rt.pid === A.child.pid && rt.ctlPort === A.ready.ctlPort && rt.hostPort === hostPort, JSON.stringify(rt));
}

// ② 人点「连接」——只挂线，**不绑会话**
{
  const r = await ctlFor(A, '/ctl/layer1', { on: true });
  check('② 点「连接」⇒ 真连上了', r?.ok === true && r.connected === true, JSON.stringify(r));
  await sleep(200);
  check('② 挂连接**没带卡**（第一次＝裸挂，走"新人"档）', !seen.lastAliveHeaders?.['x-office-card']);
  const st = await ctlFor(A, '/ctl/state', {});
  check('② ⭐「连接」**没有**绑定任何会话（绑定归「上线」）', !st?.status?.boundSessionId,
    JSON.stringify(st?.status?.boundSessionId));
  check('② 连上 ≠ 上线（还没报到）', !seen.calls.some((c) => c.tool === 'register'));
}

// ③ 人点「上线」——绑会话 ＋ 报到 ＋ 上线
const SID = 'sess-host-check-1';
{
  const r = await ctlFor(A, '/ctl/link', { sessionId: SID });
  check('③ 点「上线」⇒ 办公室认了', r?.ok === true, JSON.stringify(r).slice(0, 200));
  const reg = seen.calls.find((c) => c.tool === 'register');
  check('③ 报到了', !!reg);
  check('③ ⭐ 报到带了门牌号（AI 填不出的那个值，由插件代报）', reg?.args?.host === hostPort, reg?.args?.host);
  check('③ ⭐ 报到带了宿主进程名（产品名写法，不是可执行文件名）', reg?.args?.name === 'ZCode', reg?.args?.name);
  check('③ 报到带了会话 id 与昵称', reg?.args?.sessionId === SID && reg?.args?.nick === '小测',
    JSON.stringify({ sid: reg?.args?.sessionId, nick: reg?.args?.nick }));
  check('③ ⭐ 报到带了头像（iconFile 没配 ⇒ 自动取宿主自带的 resources\\icon.png）',
    reg?.args?.icon === PNG1x1.toString('base64'),
    typeof reg?.args?.icon === 'string' ? `base64 ${reg.args.icon.length} 字符` : String(reg?.args?.icon));
  check('③ ⭐ 报到带了模型（配置项照报，填什么报什么）',
    reg?.args?.model === 'TestModel-配置直报', String(reg?.args?.model));
  check('③ 上线了', seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'online'));
  const st = await ctlFor(A, '/ctl/state', {});
  check('③ 状态里亮出"报到身份"（model／icon 字符数，0.2.0 起）',
    st?.report?.model === 'TestModel-配置直报' && st?.report?.iconChars === PNG1x1.toString('base64').length,
    JSON.stringify(st?.report));
  check('③ 绑住了这个会话', st?.status?.boundSessionId === SID, JSON.stringify(st?.status?.boundSessionId));
  check('③ 在线状态以**办公室**为准（读回来是 online）', st?.presence === 'online', JSON.stringify(st?.presence));

  const stateFile = path.join(DATA, 'office-bridge-state.json');
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('③ 卡落了盘（跨重启还在 —— 那是接入手续）', !!onDisk.card && onDisk.card.id === MEMBER);
  check('③ "上一次绑过的会话"落了盘', onDisk.boundSessionId === SID);
}

// ③b 首次建卡：内核会叫醒一次，提示 AI 可以起个昵称（《说明书》§2 第二步）
{
  await sleep(150);
  const nick = deliveries().find((d) => /昵称/.test(String(d.text || '')));
  check('③ 首次建卡 ⇒ 投了一条"可以起个昵称"（ wakeMode=file ⇒ 落在投递记录里）', !!nick,
    JSON.stringify(nick && nick.text));
}

// ④ 叫醒：推 wake ⇒ 只投"进来看"的命令，不带正文
{
  const before = deliveries().length;
  const p = push(hostPort, '/dsh-office/wake', { memberId: MEMBER, reason: 'message', msgId: 'msg-1', seq: 3 });
  const t0 = Date.now();
  while (deliveries().length <= before && Date.now() - t0 < 8000) await sleep(50);
  const r = await p;
  const line = deliveries()[before];
  check('④ 推 wake ⇒ 办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
  check('④ 投下去的是"进来看"的命令（不是正文 —— msgId／seq 没进去）',
    !!line && /进来看看/.test(String(line.text)) && !JSON.stringify(line).includes('msg-1'),
    JSON.stringify(line));
  check('④ 投给了绑定的那个会话', !!line && line.sessionId === SID, line && line.sessionId);
}

// ④b 插话：推 interrupt ⇒ 那句**原样**投进去（ZCode 上这是排队投递，见 README）
{
  const before = deliveries().length;
  const p = push(hostPort, '/dsh-office/interrupt', { memberId: MEMBER, text: '时间到了，请停' });
  const t0 = Date.now();
  while (deliveries().length <= before && Date.now() - t0 < 8000) await sleep(50);
  const r = await p;
  const line = deliveries()[before];
  check('④ 推 interrupt ⇒ 办公室收到 {ok:true}，话**原样**（一字不改）',
    r?.ok === true && line?.text === '时间到了，请停', JSON.stringify({ push: r, line }));
}

// ⑤ 探活：算式答对
{
  const nonce = 'abc123';
  const r = await push(hostPort, '/dsh-office/challenge', { memberId: MEMBER, nonce });
  const want = crypto.createHash('sha256').update(`${MEMBER}/${nonce}`, 'utf8').digest('hex');
  check('⑤ challenge ⇒ sha256(成员 id + "/" + nonce) 小写十六进制，答对', r?.answer === want, String(r?.answer));
}

// ⑥ 推来的人不是它 ⇒ 拒（防串台）
{
  const r = await push(hostPort, '/dsh-office/wake', { memberId: 'someone-else' });
  check('⑥ 推来的成员对不上 ⇒ 拒（防串台）', r?.ok === false, JSON.stringify(r));
}

// ⑦ 转发：AI 调办公室工具
{
  const r = await ctlFor(A, '/ctl/call', { tool: 'list_tasks', args: { limit: 5 } });
  check('⑦ 转发一条工具调用 ⇒ 办公室收到原样参数',
    r?.result?.ok === true && seen.calls.some((c) => c.tool === 'list_tasks' && c.args.limit === 5),
    JSON.stringify(r).slice(0, 160));
  const bad = await ctlFor(A, '/ctl/call', { tool: 'boom', args: {} });
  check('⑦ 办公室回"不干" ⇒ 原样带回来（不是当成功）', bad?.result?.ok === false, JSON.stringify(bad).slice(0, 160));
}

// ⑧ 人在办公室成员卡上点「叫它上线」⇒ 投到绑定的会话，叫它自己上线
{
  const before = deliveries().length;
  const p = push(hostPort, '/dsh-office/online', { memberId: MEMBER });
  const t0 = Date.now();
  while (deliveries().length <= before && Date.now() - t0 < 8000) await sleep(50);
  const r = await p;
  const line = deliveries()[before];
  check('⑧ 点「叫它上线」⇒ 投了"进来自己上线"的命令', !!line && /叫你上线|叫它上线/.test(String(line.text)),
    JSON.stringify(line && line.text));
  check('⑧ 办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
}

// ⑨ 下线：先报下线、**不解除绑定**
{
  const r = await ctlFor(A, '/ctl/unlink', {});
  check('⑨ 下线成功', r?.ok === true, JSON.stringify(r).slice(0, 160));
  check('⑨ ⭐ 下线**不解除绑定**（地址留着，办公室才叫得到人）', r?.stillBound === SID, r?.stillBound);
  check('⑨ 向办公室报了 offline', seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'offline'));
}

// ⑨b 下线之后，「叫它上线」还得叫得到
{
  const before = deliveries().length;
  const p = push(hostPort, '/dsh-office/online', { memberId: MEMBER });
  const t0 = Date.now();
  while (deliveries().length <= before && Date.now() - t0 < 8000) await sleep(50);
  const r = await p;
  check('⑨ 下线之后仍叫得到（地址还在）⇒ 办公室收到 {ok:true}',
    r?.ok === true && deliveries().length > before, JSON.stringify(r));
}

// ⑩ 办公室请它断 ⇒ 断；且**不得自己重挂**
{
  const before = seen.aliveCount;
  const r = await push(hostPort, '/dsh-office/connect', { memberId: MEMBER, on: false });
  await sleep(700);
  const st = await ctlFor(A, '/ctl/state', {});
  check('⑩ 办公室请它断 ⇒ 断了', r?.ok === true && st?.status?.connected === false,
    JSON.stringify({ push: r, connected: st?.status?.connected }));
  check('⑩ ⭐ 断了**没有**自己重挂（挂连接次数没涨）', seen.aliveCount === before, `${before} → ${seen.aliveCount}`);
  check('⑩ 断开后"报过到"也清了（下次连上要重报）', st?.status?.registered === false, JSON.stringify(st?.status?.registered));
}

// ⑪ 办公室请它连 ⇒ 连回来（这条路是"人点连接"的等价物，办公室侧也能发起）
{
  const r = await push(hostPort, '/dsh-office/connect', { memberId: MEMBER, on: true });
  await sleep(400);
  const st = await ctlFor(A, '/ctl/state', {});
  check('⑪ 办公室请它连 ⇒ 又挂上了', r?.ok === true && st?.status?.connected === true,
    JSON.stringify({ push: r, connected: st?.status?.connected }));
  check('⑪ 这一次挂连接**带上了那张卡**（已有卡 ⇒ 必须带手续）',
    typeof seen.lastAliveHeaders?.['x-office-card'] === 'string' && seen.lastAliveHeaders['x-office-card'].length > 10);
}

// ⑫ 控制口只认本机、只收 POST
{
  const r = await fetch(`http://127.0.0.1:${A.ready.ctlPort}/ctl/nonsense`, { method: 'POST' });
  check('⑫ 没这个控制路由 ⇒ 404', r.status === 404, String(r.status));
  const g = await fetch(`http://127.0.0.1:${A.ready.ctlPort}/ctl/state`, { method: 'GET' });
  check('⑫ 非 POST ⇒ 405', g.status === 405, String(g.status));
}

// ⑬ hook（真脚本）：报"当前会话"；stdout 必须是空的（ZCode 按严格 schema 解析 hook 输出）
{
  const h = spawn(process.execPath, [HOOK_JS], {
    env: { ...process.env, OFFICE_HOST_CONFIG: JSON.stringify(hostConfig()) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let hookStdout = '';
  h.stdout.on('data', (c) => { hookStdout += String(c); });
  h.stderr.on('data', () => { /* 日志随便写 stderr */ });
  h.stdin.write(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-hook-9', source: 'startup' }));
  h.stdin.end();
  const exitCode = await new Promise((r) => h.on('close', r));
  await sleep(100);
  const st = await ctlFor(A, '/ctl/state', {});
  check('⑬ hook 跑完（退出码 0、**stdout 全空** —— 严格 schema 不许多余输出）', exitCode === 0 && hookStdout === '',
    `exit=${exitCode}｜stdout=${JSON.stringify(hookStdout.slice(0, 60))}`);
  check('⑬ ⭐ hook 把 session_id 报给了常驻进程（state 里能看到"当前会话"）',
    st?.currentSessionId === 'sess-hook-9', JSON.stringify(st?.currentSessionId));
}

// ⑭ MCP 服务器（真进程）：initialize / tools/list / tools/call 一趟
{
  const m = spawn(process.execPath, [MCP_JS], {
    env: { ...process.env, OFFICE_HOST_CONFIG: JSON.stringify(hostConfig()) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const replies = new Map();
  let mbuf = '';
  m.stdout.on('data', (c) => {
    mbuf += String(c);
    let i = mbuf.indexOf('\n');
    while (i >= 0) {
      const line = mbuf.slice(0, i).trim();
      mbuf = mbuf.slice(i + 1);
      if (line) { try { const o = JSON.parse(line); if (o.id !== undefined) replies.set(o.id, o); } catch { /* 忽略 */ } }
      i = mbuf.indexOf('\n');
    }
  });
  const rpc = (obj) => new Promise((r) => { m.stdin.write(JSON.stringify(obj) + '\n'); const t0 = Date.now(); const w = setInterval(() => { if (replies.has(obj.id) || Date.now() - t0 > 15000) { clearInterval(w); r(replies.get(obj.id)); } }, 50); });
  const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'self-check', version: '0' } } });
  check('⑭ MCP initialize ⇒ 回了协议版本与 serverInfo',
    !!init?.result && typeof init.result.protocolVersion === 'string' && init.result.serverInfo?.name === 'office',
    JSON.stringify(init?.result?.serverInfo));
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names = (list?.result?.tools || []).map((t) => t.name);
  check('⑭ tools/list ⇒ 五个控制工具都在', ['office_status', 'office_connect', 'office_disconnect', 'office_online', 'office_offline'].every((n) => names.includes(n)),
    JSON.stringify(names));
  check('⑭ tools/list ⇒ 办公室的工具从 GET /api/tools 现拉上来了', names.includes('list_tasks'), JSON.stringify(names));
  const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'office_status', arguments: {} } });
  const text = call?.result?.content?.[0]?.text || '';
  check('⑭ tools/call office_status ⇒ 文本里带着连接／绑定／门牌号',
    /未连接|已连接/.test(text) && text.includes(hostPort), JSON.stringify(text.slice(0, 120)));
  const fwd = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_tasks', arguments: { limit: 2 } } });
  const ftext = fwd?.result?.content?.[0]?.text || '';
  check('⑭ tools/call 办公室工具 ⇒ 经控制口转发成功（isError 不带）',
    fwd?.result?.isError !== true && /echo/.test(ftext), JSON.stringify(ftext.slice(0, 120)));
  const bad = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } });
  check('⑭ 办公室拒了 ⇒ isError:true，错误原文带回',
    bad?.result?.isError === true && /这个我不干/.test(String(bad?.result?.content?.[0]?.text || '')),
    JSON.stringify(bad?.result?.content?.[0]?.text || '').slice(0, 120));
  m.kill();
}

// ─────────────── 换一个实例：投递写不进去 ⇒ 办公室必须收到"没送到" ───────────────

{
  // 投递记录写不进去（父目录不存在，appendFileSync 必然抛）⇒ 办公室必须收到"没送到"
  const dataDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-checkB-'));
  const B = spawnHost(hostConfig({
    dataDir: dataDirB,
    deliverFile: path.join(dataDirB, 'no-such-dir', 'deliver.jsonl'),
  }));
  const t0 = Date.now();
  while (!B.ready && Date.now() - t0 < 15000) await sleep(50);
  if (B.ready) {
    await ctlFor(B, '/ctl/layer1', { on: true });
    await ctlFor(B, '/ctl/link', { sessionId: 'sess-B-1' });
    const r = await push(B.ready.hostPort, '/dsh-office/wake', { memberId: MEMBER, reason: 'message', msgId: 'm-b' });
    check('⑮ 投递写不进去 ⇒ 办公室收到 {ok:false}（不蒙一个"成了"）',
      r?.ok === false && String(r?.error || '').length > 0, JSON.stringify(r));
    const r2 = await push(B.ready.hostPort, '/dsh-office/online', { memberId: MEMBER });
    check('⑮ ⭐ 叫它上线投不进去 ⇒ 收到 {ok:false, error:"上线异常…"}（界面据此显示）',
      r2?.ok === false && /上线异常/.test(String(r2?.error || '')), JSON.stringify(r2));
  } else {
    check('⑮ 投递失败分支（实例 B 没起来 —— 这本身就是问题）', false);
  }
  B.child.kill();
  await sleep(300);
}

// ⑯ 固定端口被占 ⇒ 先重试再退让（接入端照样起得来，只是门牌号变了）
{
  const blocker = net.createServer(() => { /* 占着端口不放 */ });
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const C = spawnHost(hostConfig({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-checkC-')),
    port: taken,      // ← 故意要一个**已经被占**的端口
  }));
  const t0 = Date.now();
  while (!C.ready && Date.now() - t0 < 20000) await sleep(50);
  check('⑯ 固定端口被占 ⇒ 退回自动挑一个，接入端照样起得来（只是门牌号变了）',
    !!C.ready && C.ready.hostPort !== `127.0.0.1:${taken}`, `要的是 ${taken}，实得 ${C.ready && C.ready.hostPort}`);
  C.child.kill();
  await sleep(300);
  blocker.close();
}

// ⑱ 0.2.0 自动头像的兜底：icon.png 缺了 ⇒ 退到 icon_windows.png（仍是宿主自带的）
{
  const rootD = path.join(DATA, 'fake-zcode-D');
  const cliD = fakeZcodeTree(rootD, { iconPng: false, iconWindowsPng: true });
  const D = spawnHost(hostConfig({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-checkD-')),
    zcodePath: cliD,
  }));
  const t0 = Date.now();
  while (!D.ready && Date.now() - t0 < 15000) await sleep(50);
  if (D.ready) {
    await ctlFor(D, '/ctl/layer1', { on: true });
    await ctlFor(D, '/ctl/link', { sessionId: 'sess-d-no-rollout' });
    await sleep(100);
    const reg = seen.calls.filter((c) => c.tool === 'register').pop();
    check('⑱ icon.png 缺了 ⇒ 自动退到 icon_windows.png（仍是宿主自带的）',
      reg?.args?.icon === PNG1x1.toString('base64'), String(reg?.args?.icon || '').slice(0, 40));
  } else {
    check('⑱ 自动头像兜底分支（实例 D 没起来 —— 这本身就是问题）', false);
  }
  D.child.kill();
  await sleep(300);
}

// ─────────────── 收摊 ───────────────

{
  // 收尾：常驻进程被杀掉之后，那条常驻连接也该跟着断（此刻还开着的应该只有 A 那一条）
  const openBefore = aliveConns.size;
  A.child.kill();
  await sleep(500);
  check('⑰ 常驻进程一没，那条常驻连接也就断了（没留个孤儿挂着）',
    openBefore === 1 && aliveConns.size === 0, `杀前开着 ${openBefore} 条，杀后剩 ${aliveConns.size} 条`);
}

try { office.close(); } catch { /* 已经关了 */ }
fs.rmSync(DATA, { recursive: true, force: true });

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n合计：过 ${pass} ／ 不过 ${fail}`);
if (fail) {
  console.log('没过的条目：');
  for (const r of results.filter((x) => !x.pass)) console.log('  ·', r.name);
}
process.exit(fail === 0 ? 0 : 1);

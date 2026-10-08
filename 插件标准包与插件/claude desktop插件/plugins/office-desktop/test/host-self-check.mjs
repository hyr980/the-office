/**
 * 宿主侧那半的自测 —— 用一个「假办公室」把 `host/office-host.mjs` 整个驱动一遍。
 *
 * 为什么用假的（照标准包 `自测.mjs` 的理由）：**完全不碰真办公室的运行数据**
 * （不建成员卡、不动账本），而且能演真办公室演不了的那一半 ——
 * **办公室往宿主推进来**（wake／interrupt／online／connect／challenge）。
 *
 * 它一个人演两个角色：
 *   · 假办公室（HTTP）：收 `/api/alive`、`/api/call`，并往宿主的反向端点推
 *   · **插件那半**（读 stdout ＋ 打控制口）：就是 `hooks/register.tsx` 干的那些事 ——
 *     收到 wake／interrupt 就办，办完在 `/ctl/reply` 上回话。
 *     这一层必须**照着真实那一半的行为**演：它要是漏回一条，办公室那边就该收到 `{ok:false}`，
 *        而不是让用例自己在那儿干等。
 *
 * 注意：它**只验得到宿主侧那半**（常驻进程 ＋ 控制口 ＋ 全部协议动作）。
 *    插件模块那一半（那条带画得出来没有、`$.prompt.submit` 起不起得来）跑在宿主的钩子环境里，
 *    要真机才验得到；本机的验证状态见交付包《验收到哪一步.md》。
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
const HOST_JS = path.join(HERE, '..', 'host', 'office-host.mjs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-check-'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? '过' : '不过'}  ${name}${detail !== undefined && (detail !== '' || !pass) ? `  —— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────── 假办公室 ───────────────

const seen = { calls: [], aliveCount: 0, lastAliveHeaders: null };
let aliveRes = null;

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
    aliveRes = res;
    req.on('close', () => { /* 对端断了 */ });
    return;
  }
  // 工具清单（这个口不经准入校验，卡片里也用它）
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
    if (body.tool === 'boom') return json(res, { ok: false, error: '办公室说：这个不干' });
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

// ─────────────── 起宿主进程，并当一个"插件那半"读它的 stdout ───────────────

await new Promise((r) => office.listen(0, '127.0.0.1', r));
const officePort = office.address().port;
const BASE = `http://127.0.0.1:${officePort}`;
console.log(`假办公室起了：${BASE}\n状态目录：${DATA}\n`);

const MEMBER = 'host-check';
let ctlPort = 0;
let hostPort = '';
/** 收到、还没被用例取走的 wake／interrupt 行（**先进先出** —— 用例按顺序取）。 */
const inbox = [];
/** 默认：来得就办、办完回 ok:true（真实那半就是这个行为）。 */
let autoReply = true;

const child = spawn(process.execPath, [HOST_JS], {
  env: {
    ...process.env,
    OFFICE_HOST_CONFIG: JSON.stringify({
      base: BASE,
      memberId: MEMBER,
      name: 'Claude Desktop',
      nick: '小桌',
      model: 'claude-fable-5',
      dataDir: DATA,
      port: 0,          // 自动挑：别跟真插件那个 19391 抢
      ctlPort: 0,
      verbose: false,
    }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let buf = '';
child.stdout.on('data', (c) => {
  buf += String(c);
  let i = buf.indexOf('\n');
  while (i >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      let m = null;
      try { m = JSON.parse(line); } catch { /* 不是协议行 */ }
      if (m && m.t === 'ready') { ctlPort = m.ctlPort; hostPort = m.hostPort; }
      if (m && (m.t === 'wake' || m.t === 'interrupt')) {
        inbox.push(m);
        if (autoReply) void reply(m.id, true);
      }
    }
    i = buf.indexOf('\n');
  }
});
child.stderr.on('data', (c) => { if (process.env.SHOW_LOG) process.stderr.write('[宿主] ' + String(c)); });

/** 扮演插件那半：打控制口。回话就是控制口那份 JSON（**没有多套一层**）。 */
async function ctl(p, body) {
  const r = await fetch(`http://127.0.0.1:${ctlPort}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return await r.json().catch(() => null);
}
const reply = (id, ok, error) => ctl('/ctl/reply', { id, ok, error });

/** 取一条要办的事（先进先出），最多等 `ms`。 */
async function take(t, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return inbox.splice(i, 1)[0];
    if (Date.now() - t0 > ms) return null;
    await sleep(50);
  }
}

// ─────────────── 开跑 ───────────────

{
  const t0 = Date.now();
  while (!ctlPort && Date.now() - t0 < 15000) await sleep(50);
}
check('① 宿主进程起来了，报了控制口与门牌号', ctlPort > 0 && /^127\.0\.0\.1:\d+$/.test(hostPort),
  `控制口=${ctlPort}｜门牌号=${hostPort}`);

await sleep(300);
check('① 起来**没有**自动连办公室（不自动连）', seen.aliveCount === 0, `挂连接次数 ${seen.aliveCount}`);
check('① 起来**没有**自动上线（办公室那边没报到过）',
  !seen.calls.some((c) => c.tool === 'presence'), JSON.stringify(seen.calls.map((c) => c.tool)));
{
  const r = await ctl('/ctl/state', {});
  check('① 读状态：未连接、未绑定、没卡', r?.status?.connected === false && !r?.status?.boundSessionId && r?.status?.hasCard === false,
    JSON.stringify(r?.status));
}

// ② 人点「连接」——只挂线，**不绑会话**
{
  const r = await ctl('/ctl/layer1', { on: true });
  check('② 点「连接」⇒ 真连上了', r?.ok === true && r.connected === true, JSON.stringify(r));
  await sleep(200);
  check('② 挂连接**没带卡**（第一次＝裸挂，走"新人"档）', !seen.lastAliveHeaders?.['x-office-card']);
  const st = await ctl('/ctl/state', {});
  check('② 「连接」**没有**绑定任何会话（绑定归「上线」）', !st?.status?.boundSessionId,
    JSON.stringify(st?.status?.boundSessionId));
  check('② 连上 ≠ 上线（还没报到）', !seen.calls.some((c) => c.tool === 'register'));
}

// ③ 人点「上线」——绑当前会话 ＋ 报到 ＋ 上线
const SID = 'sess-host-check-1';
{
  const r = await ctl('/ctl/link', { sessionId: SID });
  check('③ 点「上线」⇒ 办公室认了', r?.ok === true, JSON.stringify(r).slice(0, 200));
  const reg = seen.calls.find((c) => c.tool === 'register');
  check('③ 报到了', !!reg);
  check('③ 报到带了门牌号（AI 填不出的那个值，由插件代报）', reg?.args?.host === hostPort, reg?.args?.host);
  check('③ 报到带了宿主进程名（产品名写法，不是可执行文件名）', reg?.args?.name === 'Claude Desktop', reg?.args?.name);
  check('③ 报到带了会话 id 与昵称', reg?.args?.sessionId === SID && reg?.args?.nick === '小桌',
    JSON.stringify({ sid: reg?.args?.sessionId, nick: reg?.args?.nick }));
  check('③ 上线了', seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'online'));
  const st = await ctl('/ctl/state', {});
  check('③ 绑住了这个会话', st?.status?.boundSessionId === SID, JSON.stringify(st?.status?.boundSessionId));
  check('③ 在线状态以**办公室**为准（读回来是 online）', st?.presence === 'online', JSON.stringify(st?.presence));

  const stateFile = path.join(DATA, 'office-bridge-state.json');
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('③ 卡落了盘（跨重启还在 —— 那是接入手续）', !!onDisk.card && onDisk.card.id === MEMBER);
  check('③ "上一次绑过的会话"落了盘', onDisk.boundSessionId === SID);
}

// ③b 首次建卡：内核会**叫醒一次**，提示 AI 可以起个昵称（《说明书》§2 第二步）
{
  const m = await take('wake', 8000);
  check('③ 首次建卡 ⇒ 叫醒一次提示"可以起个昵称"', !!m && /昵称/.test(String(m.why || '')), JSON.stringify(m?.why));
  await reply(m.id, true);
  check('③ 提示办完回话后，队列是空的（后面几条能按顺序取）', inbox.length === 0, JSON.stringify(inbox.map((x) => x.t)));
}

// ④ 叫醒：推 wake ⇒ 宿主把它递出来（等插件回话）
{
  const p = push(hostPort, '/dsh-office/wake', { memberId: MEMBER, reason: 'message', msgId: 'msg-1', seq: 3 });
  const m = await take('wake');
  check('④ 推 wake ⇒ 宿主把"叫醒"递出来了', !!m, JSON.stringify(m));
  check('④ 递出来的只有"为什么叫"，**不带消息正文**（msgId 没进去）',
    !!m && !JSON.stringify(m).includes('msg-1'), JSON.stringify(m));
  await reply(m.id, true);
  const r = await p;
  check('④ 插件回"送到了" ⇒ 办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
}

// ④b 插件叫不醒时，办公室要收到 ok:false（不蒙一个"成了"）
{
  autoReply = false;                 // 这条用例自己回话
  const p = push(hostPort, '/dsh-office/wake', { memberId: MEMBER, reason: 'message', msgId: 'msg-2' });
  const m = await take('wake');
  autoReply = true;
  await reply(m.id, false, '叫不醒：会话没了');
  const r = await p;
  check('④ 插件回"没送到" ⇒ 办公室收到 {ok:false}（不蒙）',
    r?.ok === false && /叫不醒/.test(String(r.error)), JSON.stringify(r));
}

// ⑤ 插话：推 interrupt ⇒ 递出来 ⇒ 回话
{
  const p = push(hostPort, '/dsh-office/interrupt', { memberId: MEMBER, text: '时间到了，请停' });
  const m = await take('interrupt');
  check('⑤ 推 interrupt ⇒ 递出来了，话**原样**', m?.text === '时间到了，请停', JSON.stringify(m));
  await reply(m.id, true);
  const r = await p;
  check('⑤ 回话后办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
}

// ⑥ 探活：算式答对
{
  const nonce = 'abc123';
  const r = await push(hostPort, '/dsh-office/challenge', { memberId: MEMBER, nonce });
  const want = crypto.createHash('sha256').update(`${MEMBER}/${nonce}`, 'utf8').digest('hex');
  check('⑥ challenge ⇒ sha256(成员 id + "/" + nonce) 小写十六进制，答对', r?.answer === want, String(r?.answer));
}

// ⑦ 推来的人不是它 ⇒ 拒（防串台）
{
  const r = await push(hostPort, '/dsh-office/wake', { memberId: 'someone-else' });
  check('⑦ 推来的成员对不上 ⇒ 拒（防串台）', r?.ok === false, JSON.stringify(r));
}

// ⑧ 转发：AI 调办公室工具
{
  const r = await ctl('/ctl/call', { tool: 'list_tasks', args: { limit: 5 } });
  check('⑧ 转发一条工具调用 ⇒ 办公室收到原样参数',
    r?.result?.ok === true && seen.calls.some((c) => c.tool === 'list_tasks' && c.args.limit === 5),
    JSON.stringify(r).slice(0, 160));
  const bad = await ctl('/ctl/call', { tool: 'boom', args: {} });
  check('⑧ 办公室回"不干" ⇒ 原样带回来（不是当成功）', bad?.result?.ok === false, JSON.stringify(bad).slice(0, 160));
}

// ⑨ 人在办公室成员卡上点「叫它上线」⇒ 投到**上一次绑过的会话**
{
  const p = push(hostPort, '/dsh-office/online', { memberId: MEMBER });
  const m = await take('wake');
  check('⑨ 点「叫它上线」⇒ 把它叫醒（进来自己上线）', !!m && /叫它上线/.test(String(m.why)), JSON.stringify(m?.why));
  await reply(m.id, true);
  const r = await p;
  check('⑨ 办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
}

// ⑨b 叫它上线**投不进去**时，办公室要收到「上线异常…」（《说明书》§5：界面靠它显示）
{
  autoReply = false;
  const p = push(hostPort, '/dsh-office/online', { memberId: MEMBER });
  const m = await take('wake');
  autoReply = true;
  await reply(m.id, false, '没有可投的会话');
  const r = await p;
  check('⑨ 投不进去 ⇒ 办公室收到 {ok:false, error:"上线异常…"}（界面据此写「上线异常」）',
    r?.ok === false && /上线异常/.test(String(r.error)), JSON.stringify(r));
}

// ⑩ 下线：先报下线、**不解除绑定**
{
  const r = await ctl('/ctl/unlink', {});
  check('⑩ 下线成功', r?.ok === true, JSON.stringify(r).slice(0, 160));
  check('⑩ 下线**不解除绑定**（地址留着，办公室才叫得到人）', r?.stillBound === SID, r?.stillBound);
  check('⑩ 向办公室报了 offline', seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'offline'));
}

// ⑩b 下线之后，「叫它上线」还得叫得到
{
  const p = push(hostPort, '/dsh-office/online', { memberId: MEMBER });
  const m = await take('wake');
  check('⑩ 下线之后仍叫得到（地址还在）', !!m, JSON.stringify(m));
  await reply(m.id, true);
  const r = await p;
  check('⑩ 叫得到 ⇒ 办公室收到 {ok:true}', r?.ok === true, JSON.stringify(r));
}

// ⑪ 办公室请它断 ⇒ 断；且**不得自己重挂**
{
  const before = seen.aliveCount;
  const r = await push(hostPort, '/dsh-office/connect', { memberId: MEMBER, on: false });
  await sleep(700);
  const st = await ctl('/ctl/state', {});
  check('⑪ 办公室请它断 ⇒ 断了', r?.ok === true && st?.status?.connected === false,
    JSON.stringify({ push: r, connected: st?.status?.connected }));
  check('⑪ 断了**没有**自己重挂（挂连接次数没涨）', seen.aliveCount === before, `${before} → ${seen.aliveCount}`);
  check('⑪ 断开后"报过到"也清了（下次连上要重报）', st?.status?.registered === false, JSON.stringify(st?.status?.registered));
}

// ⑫ 办公室请它连 ⇒ 连回来（这条路是"人点连接"的等价物，办公室侧也能发起）
{
  const r = await push(hostPort, '/dsh-office/connect', { memberId: MEMBER, on: true });
  await sleep(400);
  const st = await ctl('/ctl/state', {});
  check('⑫ 办公室请它连 ⇒ 又挂上了', r?.ok === true && st?.status?.connected === true,
    JSON.stringify({ push: r, connected: st?.status?.connected }));
  check('⑫ 这一次挂连接**带上了那张卡**（已有卡 ⇒ 必须带手续）',
    typeof seen.lastAliveHeaders?.['x-office-card'] === 'string' && seen.lastAliveHeaders['x-office-card'].length > 10);
}

// ⑬ 控制口只认本机、只收 POST
{
  const r = await fetch(`http://127.0.0.1:${ctlPort}/ctl/nonsense`, { method: 'POST' });
  check('⑬ 没这个控制路由 ⇒ 404', r.status === 404, String(r.status));
  const g = await fetch(`http://127.0.0.1:${ctlPort}/ctl/state`, { method: 'GET' });
  check('⑬ 非 POST ⇒ 405', g.status === 405, String(g.status));
}

// ─────────────── 收摊 ───────────────

{
  // 收尾：宿主进程被杀掉之后，那条连接也该跟着断（对端看得见）
  child.kill();
  await sleep(500);
  const closed = aliveRes ? aliveRes.closed === true : true;
  check('⑭ 宿主进程一没，那条常驻连接也就断了（没留个孤儿挂着）', closed, `res.closed=${aliveRes?.closed}`);
}

// ⑮ 固定端口被占 ⇒ 退回自动挑一个（不因为端口冲突整个起不来）
{
  const blocker = net.createServer(() => { /* 占着端口不放 */ });
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const taken = blocker.address().port;
  const DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), 'office-host-check2-'));
  const c2 = spawn(process.execPath, [HOST_JS], {
    env: {
      ...process.env,
      OFFICE_HOST_CONFIG: JSON.stringify({
        base: BASE, memberId: 'host-check-2', name: 'Claude Desktop', dataDir: DATA2,
        port: taken,        // 故意要一个**已经被占**的端口
        ctlPort: 0, verbose: false,
      }),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  let ready2 = null;
  let b2 = '';
  c2.stdout.on('data', (x) => {
    b2 += String(x);
    let i = b2.indexOf('\n');
    while (i >= 0) {
      const l = b2.slice(0, i).trim();
      b2 = b2.slice(i + 1);
      try { const m = JSON.parse(l); if (m.t === 'ready') ready2 = m; } catch { /* 不是协议行 */ }
      i = b2.indexOf('\n');
    }
  });
  const t0 = Date.now();
  while (!ready2 && Date.now() - t0 < 10000) await sleep(50);
  check('⑮ 固定端口被占 ⇒ 退回自动挑一个，接入端照样起得来（只是门牌号变了）',
    !!ready2 && ready2.hostPort !== `127.0.0.1:${taken}`, `要的是 ${taken}，实得 ${ready2?.hostPort}`);
  c2.kill();
  await sleep(300);
  blocker.close();
  fs.rmSync(DATA2, { recursive: true, force: true });
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

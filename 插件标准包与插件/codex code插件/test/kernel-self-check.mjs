/**
 * 内核自测 —— 用一个「假办公室」把 `office-bridge.mjs` 跑通一遍。
 *
 * 为什么用假的：**完全不碰真办公室的运行数据**（不建成员卡、不动账本），
 * 而且能演真办公室演不了的那一半 —— **办公室往内核推请求**（wake／interrupt／online／connect／challenge）。
 *
 * 跑法：node 自测.mjs
 * 退出码 0 ＝ 全过；非 0 ＝ 有不过的（逐条打印）。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOfficeBridge } from '../lib/office-bridge.mjs';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'office-kernel-'));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '过' : '不过'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────── 假办公室 ───────────────

const seen = { calls: [], aliveCount: 0 };
let aliveRes = null;                 // 攥住那条 SSE 的 res，用来验"断开了没"
let aliveClosed = false;

const mcp = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  // 那条常驻连接（SSE）
  if (req.method === 'GET' && url.pathname === '/api/alive') {
    seen.aliveCount += 1;
    seen.lastAliveHeaders = req.headers;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': alive\n');
    aliveRes = res;
    req.on('close', () => { aliveClosed = true; });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/call') {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    seen.calls.push(body);
    const tool = body.tool;
    if (tool === 'register') {
      // 办公室把那张卡**回传**（内核要存下来，以后每次挂连接带上）
      return json(res, {
        ok: true,
        data: {
          card: {
            id: body.args.memberId,
            joined: '2026-10-05T14:40:00+08:00',
            name: body.args.name || '',
            icon: body.args.icon || '',
          },
        },
      });
    }
    return json(res, { ok: true, data: {} });
  }

  return json(res, { ok: false, error: '没有这个端点' }, 404);
});

function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

/** 扮演办公室：往内核的反向端点推一个请求。 */
async function push(hostPort, p, body) {
  const res = await fetch(`http://${hostPort}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => null);
}

// ─────────────── 开跑 ───────────────

const woke = [];
const steered = [];

await new Promise((r) => mcp.listen(0, '127.0.0.1', r));
const officePort = mcp.address().port;
console.log(`假办公室起了：127.0.0.1:${officePort}`);

const bridge = createOfficeBridge({
  base: `http://127.0.0.1:${officePort}`,
  memberId: 'test-kernel',
  name: 'TestHost',
  nick: '小测',
  model: 'test-model',
  dataDir: DATA,
  wake: async (why) => { woke.push(why); return true; },
  steer: async (text) => { steered.push(text); return true; },
  log: () => {}, warn: () => {},
});

// ① 起反向端点（不连办公室）
const hostPort = await bridge.start();
check('① 反向端点起来了、门牌号有了', /^127\.0\.0\.1:\d+$/.test(hostPort), hostPort);
check('① 起端点时**没有**自动连办公室', seen.aliveCount === 0, `挂连接次数 ${seen.aliveCount}`);

// ② 人点「连接」⇒ 挂连接 + 报到（顺序：先挂、后报）
bridge.connect();
await sleep(400);
check('② 连接挂上了', bridge.status().connected === true);
check('② 挂连接**没有**带卡（第一次＝裸挂，走"新人"档）', !seen.lastAliveHeaders['x-office-card']);
await bridge.online('sess-1');
await sleep(150);

const reg = seen.calls.find((c) => c.tool === 'register');
check('③ 报到了', !!reg);
check('③ 报到带了门牌号', !!(reg && reg.args.host), reg && reg.args.host);
check('③ 报到带了宿主进程名与昵称', !!reg && reg.args.name === 'TestHost' && reg.args.nick === '小测');
check('④ 上线了', seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'online'));
check('⑤ 办公室回传的卡被存下来了', !!bridge.card() && bridge.card().joined === '2026-10-05T14:40:00+08:00');
const stateOnDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'office-bridge-state.json'), 'utf8'));
check('⑤ 卡落了盘（跨重启还在）', !!stateOnDisk.card && stateOnDisk.card.id === 'test-kernel');
check('⑤ 记下了"上一次绑过的会话"', stateOnDisk.boundSessionId === 'sess-1');
check('⑤ 昵称提示只发一次（叫醒一次＝烧一轮，不能每次报到都来）',
  woke.filter((w) => /昵称/.test(w)).length === 1, `本次共叫醒 ${woke.length} 次`);

// ⑥ 五端点：办公室推过来
const wokeBefore = woke.length;
const w1 = await push(hostPort, '/dsh-office/wake', { memberId: 'test-kernel', reason: 'message', msgId: 'm1', seq: 7 });
check('⑥ wake ⇒ 叫醒了', !!(w1 && w1.ok) && woke.length === wokeBefore + 1 && /指向本接入端/.test(woke[woke.length - 1] || ''), JSON.stringify(w1));

const i1 = await push(hostPort, '/dsh-office/interrupt', { memberId: 'test-kernel', text: '时间到了，请停' });
check('⑥ interrupt ⇒ 插进去了', !!(i1 && i1.ok) && steered[0] === '时间到了，请停', JSON.stringify(i1));

const nonce = 'abc123';
const c1 = await push(hostPort, '/dsh-office/challenge', { memberId: 'test-kernel', nonce });
const want = crypto.createHash('sha256').update(`test-kernel/${nonce}`, 'utf8').digest('hex');
check('⑥ challenge ⇒ 算式答对', !!(c1 && c1.ok) && c1.answer === want, c1 && c1.answer);

const wokeBefore2 = woke.length;
const o1 = await push(hostPort, '/dsh-office/online', { memberId: 'test-kernel' });
check('⑥ online ⇒ 又把它叫醒了', !!(o1 && o1.ok) && woke.length === wokeBefore2 + 1 && /叫它上线/.test(woke[woke.length - 1] || ''), JSON.stringify(o1));

const bad = await push(hostPort, '/dsh-office/wake', { memberId: 'someone-else' });
check('⑥ 推来的人不是它 ⇒ 拒（防串台）', !!(bad && bad.ok === false), JSON.stringify(bad));

// ⑦ 办公室请它断 ⇒ 断；且**不得自己重挂**
const aliveBefore = seen.aliveCount;
const cn = await push(hostPort, '/dsh-office/connect', { memberId: 'test-kernel', on: false });
await sleep(500);
check('⑦ 断开成功', !!(cn && cn.ok) && bridge.status().connected === false, JSON.stringify(cn));
check('⑦ 断了**没有**自己重挂（挂连接次数没涨）', seen.aliveCount === aliveBefore, `${aliveBefore} → ${seen.aliveCount}`);
check('⑦ 断开后"报过到"也清了（下次连上要重报）', bridge.status().registered === false);

// ⑧ 人点「下线」：报了下线，但**"上一次绑过的会话"留着**
//    （下线只是撤掉"在岗"；地址是叫醒要用的，留着办公室才叫得到人 —— 说明书 §1。）
//    这里接在断开之后跑没关系：下线是插件侧动作，走 `callTool`，不依赖那条连接。
const offlineR = await bridge.offline();
await sleep(150);
check('⑧ 下线：向办公室报了「离线」',
  seen.calls.some((c) => c.tool === 'presence' && c.args.presence === 'offline'), JSON.stringify(offlineR));
const stateAfterOffline = JSON.parse(fs.readFileSync(path.join(DATA, 'office-bridge-state.json'), 'utf8'));
check('⑧ 下线**不清**"上一次绑过的会话"（办公室「叫它上线」才叫得到人）',
  stateAfterOffline.boundSessionId === 'sess-1' && bridge.status().boundSessionId === 'sess-1',
  `盘上=${stateAfterOffline.boundSessionId}｜内存=${bridge.status().boundSessionId}`);

// 收摊
await bridge.stop();
mcp.close();
fs.rmSync(DATA, { recursive: true, force: true });

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n合计：过 ${pass} ／ 不过 ${fail}`);
process.exit(fail === 0 ? 0 : 1);

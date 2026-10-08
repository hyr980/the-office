#!/usr/bin/env node
/**
 * 叫醒演习 —— 让**真办公室**真推一条 `wake`，走**本插件自己的接入端**，看它落不落得到地方。
 *
 * 为什么要有它：`host-self-check.mjs` 用的是**假办公室**（验的是宿主侧那半的内部逻辑，不碰真办公室）。
 * 这一支反过来 —— 连的是**真办公室**，走的是真的那一道"该叫谁 ⇒ 往门牌号推"的路。
 *
 * 它一个人演三个角色：
 *   · **接入端本体**：把本插件的 `host/office-host.mjs` 当子进程起起来（内核跑在里面，协议全归它）
 *   · **插件那一半**：读它的 stdout、在控制口上回话 —— 就是 `hooks/register.tsx` 干的那些事
 *   · **办公室里的另一个人**：自建一个临时成员，挂 SSE、报到、上线，然后发一条消息给接入端
 *
 * 于是整条链子除"最后投进会话那一下"外，全是真的：
 *   真办公室 → 真内核的门牌号 → 内核的 wake 钩子 → 插件那一半
 *
 * 用法：node test/wake-drill.mjs
 * 选项：
 *   --from=<id>      发送者成员 id（默认 drill-sender）
 *   --member=<id>    接入端的成员 id（默认 drill-kernel）
 *   --base=<url>     办公室地址（默认 http://127.0.0.1:8787）
 *   --wait=<秒>      等推送的秒数（默认 10）
 *   --keep           跑完不拆，留着给人看（Ctrl+C 收摊）
 *
 * 卡（接入手续）：临时成员与接入端的卡都在系统临时目录 `office-wake-drill/` 下 ——
 *   办公室对**已经建过卡**的 id 要求接入时带上它，空手会被当场回绝；第二次跑同一组 id 时靠它。
 *
 * 退出码：0 ＝ 办公室真推到了门牌号，且接入端把它递到了插件那一半。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_JS = path.join(HERE, '..', 'host', 'office-host.mjs');

const arg = (k) => {
  const p = process.argv.find((a) => a.startsWith(`--${k}=`));
  return p ? p.slice(k.length + 3) : '';
};
const has = (k) => process.argv.includes(`--${k}`);

const BASE = String(arg('base') || process.env.OFFICE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const FROM = arg('from') || 'drill-sender';
/**
 * 接入端的成员 id。默认**每次换一个**（`drill-<随机>`）——
 * 因为办公室对**已经建过卡**的 id 要求接入时带上那张卡，而演习每次都是新起的进程、
 * 手上那张卡得由第一次报到换回来；换新 id 就永远走"新人"这一档，不必清场。
 * 要拿同一个 id 反复演（例：看门牌号变了之后办公室往哪儿推），就 `--member=` 点明它。
 * 这些 `drill-*` 临时成员会留在办公室的成员表里，可以自行清理。
 */
const MEMBER = arg('member') || `drill-${Math.random().toString(36).slice(2, 7)}`;
const WAIT_MS = Math.max(1, Number(arg('wait') || 10)) * 1000;
const KEEP = has('keep');
const CARD_DIR = path.join(os.tmpdir(), 'office-wake-drill');
const DATA_DIR = path.join(os.tmpdir(), 'office-wake-drill-data');

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────── 卡：自己存、自己带（接入手续）

const cardFile = (id) => path.join(CARD_DIR, `${id}.json`);
function readCard(id) {
  try {
    const o = JSON.parse(fs.readFileSync(cardFile(id), 'utf8'));
    return o && o.id ? o : null;
  } catch { return null; }
}
function writeCard(id, card) {
  try {
    fs.mkdirSync(CARD_DIR, { recursive: true });
    fs.writeFileSync(cardFile(id), JSON.stringify(card, null, 2), 'utf8');
  } catch { /* 存不下就下次裸挂（第一次建卡那次是放行的） */ }
}
const cardHeader = (card) => Buffer.from(JSON.stringify(card), 'utf8').toString('base64');

// ─────────────── 办公室里的"另一个人"：挂 SSE、报到、上线、发消息

const senderCtrl = new AbortController();

async function senderAttach(id) {
  const card = readCard(id);
  const headers = { accept: 'text/event-stream' };
  if (card) headers['x-office-card'] = cardHeader(card);
  const res = await fetch(`${BASE}/api/alive?memberId=${encodeURIComponent(id)}`, {
    headers,
    signal: senderCtrl.signal,
  });
  if (!res.ok) throw new Error(`挂连接被拒：HTTP ${res.status}`);
  void (async () => { try { for await (const _c of res.body) { /* 一直读 */ } } catch { /* 断了 */ } })();
}

async function senderCall(id, tool, args) {
  const r = await fetch(`${BASE}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ memberId: id, tool, args: { memberId: id, ...args } }),
  });
  return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

/** 发一条内容消息；`to` 决定唤醒谁 —— 唤醒只看 `to`。 */
async function senderSend(id, to, text) {
  const envelope = {
    id: `${id}-${Date.now()}`,
    source: id,
    specversion: '1.0',
    type: 'chat.message',
    to: [to],
    data: { text },
  };
  const r = await fetch(`${BASE}/api/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ memberId: id, envelope }),
  });
  return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
}

// ─────────────── 主流程

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass });
  log(`  ${pass ? '过' : '不过'}  ${name}${detail !== undefined ? `  —— ${detail}` : ''}`);
};

let child = null;
let ctlPort = 0;
let hostPort = '';
/** 接入端递过来的事（wake／interrupt），按到达顺序。 */
const handed = [];
let readyAt = 0;

function attachHost() {
  child = spawn(process.execPath, [HOST_JS], {
    env: {
      ...process.env,
      OFFICE_HOST_CONFIG: JSON.stringify({
        base: BASE,
        memberId: MEMBER,
        name: 'Claude Desktop',
        nick: '演习接入端',
        model: 'wake-drill',
        dataDir: DATA_DIR,
        port: 0,          // 演习用：随便挑一个端口，别跟真插件那个 19391 抢
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
        if (m && m.t === 'ready') { ctlPort = m.ctlPort; hostPort = m.hostPort; readyAt = Date.now(); }
        if (m && (m.t === 'wake' || m.t === 'interrupt')) {
          handed.push(m);
          log(`  ← 接入端把事递出来了：${JSON.stringify(m)}`);
          void hostReply(m.id, true);            // 扮演插件那一半：办完回话
        }
      }
      i = buf.indexOf('\n');
    }
  });
  if (process.env.SHOW_LOG) child.stderr.on('data', (c) => process.stderr.write('[接入端] ' + String(c)));
}

async function hostCtl(p, body) {
  const r = await fetch(`http://127.0.0.1:${ctlPort}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return await r.json().catch(() => null);
}
const hostReply = (id, ok, error) => hostCtl('/ctl/reply', { id, ok, error });

async function main() {
  log(`办公室：${BASE}`);
  log(`发送者：${FROM}｜接入端成员：${MEMBER}\n`);

  let health = null;
  try { health = await (await fetch(`${BASE}/health`)).json(); } catch { /* 下面判 */ }
  check('① 办公室在跑（/health 答了）', !!(health && health.ok === true),
    health ? JSON.stringify(health).slice(0, 110) : '连不上');
  if (!health || health.ok !== true) {
    log('\n办公室没开就先把它开起来（本项目的「启动办公室」），再跑这一支。');
    process.exit(1);
  }

  // ① 把本插件的接入端起起来（内核跑在里面；这一步**不连办公室**）
  fs.mkdirSync(DATA_DIR, { recursive: true });
  attachHost();
  {
    const t0 = Date.now();
    while (!ctlPort && Date.now() - t0 < 15000) await sleep(50);
  }
  check('② 接入端起来了，报了控制口与门牌号', ctlPort > 0 && /^127\.0\.0\.1:\d+$/.test(hostPort),
    `控制口=${ctlPort}｜门牌号=${hostPort}`);
  if (!ctlPort) { log('接入端起不来，演习到此为止。'); process.exit(1); }
  await sleep(300);
  const st0 = await hostCtl('/ctl/state', {});
  check('② 起来**没有**自动连办公室（不自动连）', st0?.status?.connected === false, JSON.stringify(st0?.status));

  // ② 扮演插件那一半：读它的 stdout、在控制口上回话（上面 attachHost 里已接好）

  // ③ 扮演"人点了「连接」"：挂上那条常驻连接（**不碰绑定**）
  // 判据是"绑定**没被这一下改动**"，不是"没有绑定"：接人端的状态文件是跨重启保住"上一次绑过的会话"的
  //    （《说明书》§1：下线不解除绑定），所以同一个成员跑第二遍时，连接前就已经绑着了 —— 那是**对的**。
  const boundBefore = (await hostCtl('/ctl/state', {}))?.status?.boundSessionId || '';
  const l1 = await hostCtl('/ctl/layer1', { on: true });
  check('③ 点「连接」⇒ 真连上了（第一层，不碰绑定）', l1?.ok === true && l1.connected === true, JSON.stringify(l1));
  const st1 = await hostCtl('/ctl/state', {});
  check('③ 「连接」**没有**改动绑定（绑定归「上线」）',
    String(st1?.status?.boundSessionId || '') === String(boundBefore),
    `连接前=${JSON.stringify(boundBefore)}｜连接后=${JSON.stringify(st1?.status?.boundSessionId)}`);

  // ④ 扮演"人点了「上线」"：绑会话 ＋ 报到 ＋ 上线（顺序是内核定的）
  const sid = `drill-session-${MEMBER}`;
  const l2 = await hostCtl('/ctl/link', { sessionId: sid });
  check('④ 点「上线」⇒ 绑住这个会话 ＋ 报到 ＋ 线上', l2?.ok === true, JSON.stringify(l2).slice(0, 160));
  const st2 = await hostCtl('/ctl/state', {});
  check('④ 绑住了这个会话', st2?.status?.boundSessionId === sid, JSON.stringify(st2?.status?.boundSessionId));
  check('④ 报过到了', st2?.status?.registered === true, JSON.stringify(st2?.status?.registered));

  // ⑤ 发送者：办公室里的另一个人
  await senderAttach(FROM);
  await sleep(200);
  const reg = await senderCall(FROM, 'register', {
    sessionId: `drill-session-${FROM}`, name: 'Wake Drill Sender', nick: '演习员', model: 'wake-drill',
  });
  const card = reg && reg.data && reg.data.card;
  if (card) writeCard(FROM, { id: card.id, joined: card.joined, name: card.name, icon: card.icon });
  check('⑤ 发送者报到了', reg && reg.ok !== false, JSON.stringify(reg).slice(0, 140));
  const on = await senderCall(FROM, 'presence', { presence: 'online' });
  check('⑤ 发送者上线了', on && on.ok !== false, JSON.stringify(on).slice(0, 140));

  // ⑥ 发一条消息 ⇒ 办公室按 `to` 决定叫谁、往接入端的门牌号推
  await sleep(300);
  // 记一笔"发之前已经递出来几条" —— 只有**发消息之后**才来的那条才算数
  // （首次建卡时内核自己会叫醒一次提示起昵称，那一条不是办公室推的）
  const seqBefore = handed.length;
  const msg = await senderSend(FROM, MEMBER, '【演习】有消息指向本接入端，请进来查看。');
  log(`\n办公室对这条消息的回话：${JSON.stringify(msg)}\n`);
  check('⑥ 办公室把这条消息派给了接入端（该叫谁 ⇒ 它）',
    JSON.stringify(msg?.data || msg).includes(MEMBER), JSON.stringify(msg?.data || msg).slice(0, 220));

  // ⑦ 等接入端把"叫醒"递到插件那一半
  {
    const t0 = Date.now();
    while (!handed.slice(seqBefore).some((m) => m.t === 'wake') && Date.now() - t0 < WAIT_MS) await sleep(100);
  }
  const woke = handed.slice(seqBefore).find((m) => m.t === 'wake');
  check('⑦ 叫醒真的送到了：办公室 → 门牌号 → 内核 → 插件那一半', !!woke, woke ? JSON.stringify(woke) : `等了 ${WAIT_MS}ms 没等到`);
  check('⑦ 递下来的只有"为什么叫"，**不带消息正文**（正文在账本里）',
    !!woke && !JSON.stringify(woke).includes('进来看') && !JSON.stringify(woke).includes('演习'), JSON.stringify(woke));

  // ⑧ 探活那一路：照办公室的算法打一次，答案要一模一样
  {
    const nonce = Math.random().toString(16).slice(2, 18);
    const r = await fetch(`http://${hostPort}/dsh-office/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId: MEMBER, nonce }),
    }).then((x) => x.json()).catch((e) => ({ ok: false, error: String(e && e.message) }));
    const want = crypto.createHash('sha256').update(`${MEMBER}/${nonce}`, 'utf8').digest('hex');
    check('⑧ 探活（challenge）⇒ 照 sha256(成员 id + "/" + nonce) 答，答案对得上',
      r && r.ok === true && String(r.answer) === want, JSON.stringify(r).slice(0, 160));
  }

  // ⑨ 办公室请它连／断那一路：断了不许自己爬回来，请它连才连回来
  {
    const before = (await hostCtl('/ctl/state', {}))?.status?.connected;
    const off = await fetch(`http://${hostPort}/dsh-office/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId: MEMBER, on: false }),
    }).then((x) => x.json()).catch(() => null);
    await sleep(700);
    const st1 = await hostCtl('/ctl/state', {});
    check('⑨ 办公室请它断 ⇒ 断了，且**没有**自己重挂',
      off?.ok === true && before === true && st1?.status?.connected === false,
      JSON.stringify({ off, connected: st1?.status?.connected }));
    const on1 = await fetch(`http://${hostPort}/dsh-office/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId: MEMBER, on: true }),
    }).then((x) => x.json()).catch(() => null);
    await sleep(500);
    const st2 = await hostCtl('/ctl/state', {});
    check('⑨ 办公室请它连 ⇒ 又挂上了', on1?.ok === true && st2?.status?.connected === true,
      JSON.stringify({ on: on1, connected: st2?.status?.connected }));
  }

  // ⑩ 顺手核一下办公室那张卡（门牌号与宿主进程名都是插件代报的）
  {
    const r = await fetch(`${BASE}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId: FROM, tool: 'get_member', args: { memberId: MEMBER } }),
    }).then((x) => x.json()).catch(() => null);
    check('⑩ 卡上报的是"产品名写法"的宿主进程名', !!r && r.ok !== false && /Claude Desktop/.test(JSON.stringify(r)),
      JSON.stringify(r).slice(0, 200));
    check('⑩ 卡上的门牌号就是这个接入端实际监听的地址', !!r && JSON.stringify(r).includes(hostPort), hostPort);
  }

  // 收摊
  senderCtrl.abort();
  if (child) child.kill();
  await sleep(300);
  if (!KEEP) {
    // **不删 `DATA_DIR`**：里面那张卡是**接入手续**，办公室对已建过卡的成员要求每次接入都带上它
    //    （删了 ⇒ 下一次跑这条演习会被当场回绝）。要清就自己手动清。
    const pass = results.filter((r) => r.pass).length;
    const fail = results.length - pass;
    log(`\n合计：过 ${pass} ／ 不过 ${fail}`);
    if (fail) { log('没过的条目：'); for (const r of results.filter((x) => !x.pass)) log('  ·', r.name); }
    process.exit(fail === 0 ? 0 : 1);
  }
  log('\n--keep：接人端与发送者都留着（Ctrl+C 收摊）。');
}

main().catch((e) => { log('演习自己出错了：' + String((e && e.stack) || e)); try { child?.kill(); } catch { /* 已经没了 */ } process.exit(2); });

#!/usr/bin/env node
/**
 * dsh-office 自检（新）—— 2026-10-06 重写，取代旧 `offline-check.mjs`
 * （旧那份 `offline-check.mjs` 已归档、不再跑 —— 它验的读数与新版不可比）
 *
 * 它验五组（每条判据的出处都写在用例旁边，都能回代码里核）：
 *   甲 · 工具链路    —— `GET /api/tools` ⇒ 注册成 `office_*` 宿主工具；无裸名；没连上时被那道门拒
 *   乙 · 面板端点    —— 五个端点都在 ＋ **0.6.1 那道「只认界面」的闸门（三态）**
 *   丙 · 反向端点    —— 五个口**真的能打**（⚠️ 真 HTTP 打内核实际端口）
 *   丁 · 两层语义    —— 连接不绑／上线才绑／**下线不解绑**／断开不重连
 *   戊 · 落盘与规矩  —— 状态文件落对地方、字段齐；加载后什么都不做；缺参抛错
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node <插件目录>\test\self-check.mjs
 *   node …\self-check.mjs --use-existing     # 8787 上已有后端时沿用它（⚠️ 读数可能被污染，见下）
 *
 * ── 环境与隔离（**这几条都是 2026-10-05/06 实撞出来的，别改**）───────────
 *   1. ⭐ **必须真后端**（8787）。脚本**自己起**（`stdio` 用文件 fd，⚠️ **不能用 `'pipe'`**：
 *      pwsh 沙箱下 node 起带管道的子进程会 EPERM），跑完杀掉。
 *      ⚠️ 为什么不能对着现成的跑：8787 上那个若是**办公室壳**起的，壳会注入**界面口令**
 *      （`OFFICE_UI_TOKEN`，见 `程序\后端\bridge.js` L1591-1601），于是 `boss` 身份的
 *      查卡调用被拒（`bridge.js` L1619-1625）⇒ 所有"查办公室的卡"的判据都读出假象。
 *      **上一轮自检就是这么栽的**（查卡 null）。脚本自己起 ⇒ 后端手里没口令 ⇒ 放行。
 *      端口已被占 ⇒ 默认**报错退出**（不抢别人的后端）；要沿用请显式 `--use-existing`。
 *   2. ⭐ **身份隔离**：用专用 memberId `selfcheck`，**绝不用 `fish`**
 *      —— 谁报到谁改写卡上的门牌号，会把办公室点「连接」搞挂。
 *   3. ⭐ **状态隔离 ＋ 卡必须留住**：`stateDir` 指临时目录（不碰真插件的家目录）；
 *      ⚠️ **但那个目录不能删** —— 里面的 `card` 是"**接入手续**"：办公室对**已经建过卡的
 *      id** 要求接入时必须带上它，空手会被当场回绝（`bridge.js` L1650-1662「接入手续没对上」）。
 *      **2026-10-06 实撞**：上一版脚本跑完清目录 ⇒ 第二次跑就再也接不进去。
 *      ⇒ 正确处理：每次开跑**只把 `boundSessionId` 清空**（否则会骗过"连接不绑会话"那条判据），
 *      **卡留着**；本地真没卡时，用 `get_member` 从办公室**取回四格**补上（见 `ensureCard`）。
 *   4. ⭐ **反向端点的端口**：真插件占着 `19388` ⇒ 自检实例用 `19389`；万一被占，内核
 *      （`lib\index.js` L201-212）会退回"随便挑一个"⇒ **实际端口一律以 `panel-state`
 *      回报的 `hostPort` 为准**，别写死。
 *
 * ── 它对办公室的实际副作用（说在明面上）─────────────────────────────────
 *   · 会以 `selfcheck` 身份建／更新一张成员卡（**改不掉**：办公室没有"删成员"的口）
 *   · 跑完会把它置为 offline（收尾里 best-effort 兜底一次）
 *   · 除这张卡外不写办公室任何数据：不发消息、不建任务
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createOfficeBridge } from '../lib/office-bridge.mjs';

// ─────────────────────────────── 配置

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 默认＝从本脚本往上三级（test → 插件包 → 插件标准包与插件 → 项目根）；不在项目里时用 OFFICE_ROOT 环境变量指定
const OFFICE_ROOT = process.env.OFFICE_ROOT || path.resolve(HERE, '..', '..', '..');
const BACKEND_JS = path.join(OFFICE_ROOT, '程序', '后端', 'server.js');
const BASE = 'http://127.0.0.1:8787';
const MEMBER = 'selfcheck';                                           // ⚠️ 专用身份
const STATE_DIR = process.env.OFFICE_SELFCHECK_STATE || path.join(os.tmpdir(), 'office-selfcheck');   // ⚠️ 临时状态（卡要留着）
const STATE_FILE = path.join(STATE_DIR, 'office-bridge-state.json');
const WANT_PORT = 19389;                                              // 真插件占 19388
const FAKE_SESSION = 'session-selfcheck-20261006';
const USE_EXISTING = process.argv.includes('--use-existing');

// ─────────────────────────────── 判定与输出

let pass = 0;
let fail = 0;
const failed = [];

function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log('  [过]  ', label);
  } else {
    fail += 1;
    failed.push(label);
    console.log('  [没过]', label, extra === undefined ? '' : `—— ${extra}`);
  }
}
const section = (t) => console.log(`\n=== ${t}`);
const note = (t) => console.log('  ·', t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readStateFile() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeStateFile(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

// ─────────────────────────────── 假宿主（只实现插件真正用到的那几个接口）
// 出处：`lib\index.js` 里对 ctx 的全部用法 —— tools.register／ctx.get('sessionController')／
//       ctx.get('connection')／ctx.inject(['webServer'])／ctx.on('dispose')

const tools = new Map();      // 注册进来的宿主工具
const prompts = [];           // sessionController.prompt 收到的请求
const lifecycles = [];        // ctx.on(...) 记下的生命周期回调
const routes = [];            // 挂到宿主 webServer 上的面板端点

/** 假闸门：模拟宿主的 `connection.requestRejection`。
 *  `available=false` ⇒ 模拟"拿不到 connection 服务"（插件必须 fail closed ⇒ 403）。
 *  `verdict` 为 `undefined`＝放行；`401`／`403`＝拒（原样返回）。 */
const gate = { available: true, verdict: undefined };
const fakeConnection = { requestRejection() { return gate.verdict; } };

const ctx = {
  tools: {
    register(def) {
      if (tools.has(def.name)) throw new Error(`工具重名：${def.name}`);
      tools.set(def.name, def);
      return () => tools.delete(def.name);
    },
  },
  get(name) {
    if (name === 'sessionController') {
      return {
        async prompt(request, signal) {
          // ⭐ 契约里 `signal` 是**位置参数、非可选**：`prompt(request, signal)`。
          //   真机上漏传它 ⇒ 宿主内部 `signal.throwIfAborted()` 抛 TypeError ⇒ **叫醒整个失败**
          //   （2026-10-04 实撞：插件 `wakes` 一直是 0）⇒ 自检这层照契约拦，别让这个坑溜过去。
          if (!signal || typeof signal.throwIfAborted !== 'function') {
            throw new Error('prompt 少传了第二个参数 signal（契约：prompt(request, signal)）');
          }
          prompts.push(request);
          return { accepted: true };
        },
      };
    }
    if (name === 'connection') return gate.available ? fakeConnection : undefined;
    return undefined;
  },
  inject(names, cb) {
    if (Array.isArray(names) && names.includes('webServer')) {
      cb({
        webServer: {
          register(route) {
            routes.push(route);
            return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
          },
        },
      });
    }
  },
  on(event, fn) { lifecycles.push({ event, fn }); },
};

/**
 * 像宿主那样打一个**面板端点**（走路由表，不是真 HTTP —— 真 HTTP 那条路在下面的 reverse）。
 * ⚠️ 假 req 的 `on(ev, fn)` 是**注册即重放**：handler 里先 `await` 再注册监听也照样收得到。
 */
function hit(pathname, body = {}, opts = {}) {
  const route = routes.find((r) => r.path === pathname);
  if (!route) return Promise.resolve({ status: 404, json: null, note: '这个路由没挂上' });
  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  return new Promise((resolve) => {
    const req = {
      method: opts.method || 'POST',
      url: pathname + qs,
      headers: { host: '127.0.0.1:19387' },
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(body)));
        if (ev === 'end') fn();
      },
    };
    const res = {
      writeHead(code) { this._code = code; },
      end(txt) {
        let json = null;
        try { json = JSON.parse(txt || 'null'); } catch { /* 不是 JSON 就算了 */ }
        resolve({ status: this._code || 200, json });
      },
    };
    Promise.resolve(route.handler(req, res))
      .catch((e) => resolve({ status: 500, json: { ok: false, error: String(e && e.message || e) } }));
  });
}

/** 拉一次面板状态。`hostPort` 就是内核反向端点的**实际**门牌号（从这儿取，别写死）。 */
async function panelState(pageSession = '') {
  const r = await hit('/dsh-office/panel-state', {}, {
    method: 'GET',
    query: pageSession ? { sessionId: pageSession } : {},
  });
  return r.json;
}

let kernelPort = 0;

/** ⭐ 真 HTTP 打**内核的反向端点**（旧脚本用 hit() 打宿主路由表 ⇒ 两条永远打不到）。 */
async function reverse(pathname, body, opts = {}) {
  const method = opts.method || 'POST';
  try {
    const r = await fetch(`http://127.0.0.1:${opts.port || kernelPort}${pathname}`, {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(5000),
    });
    let json = null;
    try { json = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: null, error: String(e && e.message || e) };
  }
}

/** 以 `boss` 身份查办公室（查卡专用）。
 *  ⚠️ 后端是**壳起的**时这条会被拒（界面口令）⇒ 把错因翻成人话，别让人盯着 `null` 发呆。 */
async function officeCall(tool, args = {}, byMemberId = 'boss') {
  try {
    const r = await fetch(`${BASE}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ memberId: byMemberId, tool, args }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => null);
    if (j && j.ok === false && /界面口令/.test(String(j.error || ''))) {
      note('⚠️ 查卡被拒：「这个身份只认界面」——说明 8787 上这个后端是**办公室壳**起的（带界面口令）。'
        + '请关掉壳，让自检自己起后端。');
    }
    return j;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/** 查 `selfcheck` 那张卡（presence／host 都以办公室为准 —— 那是权威）。 */
async function officeCard() {
  const j = await officeCall('get_member', { memberId: MEMBER });
  return (j && j.data) || null;
}

/**
 * ⭐ **身份手续（那张卡）就位没** —— 本地没卡时，从办公室把四格**取回来**。
 *   · 卡的四格（`id`/`joined`/`name`/`icon`）都在 `get_member` 的返回里（`members.js` L164-190）；
 *   · 为什么必须做：空手接入对"已经建过卡的 id"会被当场回绝（见文件头第 3 条）；
 *   · 本地有卡 ⇒ 原样用（真机上的常态；也只有这条路没丢过东西）。
 * @returns {Promise<{ok:boolean, how:string, error?:string}>}
 */
async function ensureCard() {
  try {
    const s = readStateFile();
    if (s.card && s.card.id && s.card.joined) return { ok: true, how: '本地已有卡' };
    const d = await officeCard();
    if (!d || !d.id || !d.joined) return { ok: true, how: '办公室也没这张卡（第一次接入，空手放行）' };
    s.card = { id: d.id, joined: d.joined, name: d.name || '', icon: d.icon || '' };
    writeStateFile(s);
    return { ok: true, how: '本地卡丢了 ⇒ 已从办公室取回四格补上' };
  } catch (e) {
    return { ok: false, how: '取回失败', error: String(e && e.message || e) };
  }
}

// ─────────────────────────────── 起后端的两种路径

async function backendAlive() {
  try {
    const r = await fetch(`${BASE}/api/tools`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

let backendProc = null;

function startBackend() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // ⚠️ stdio 用**文件 fd**（不是 'pipe'）：pwsh 沙箱下 node 起带管道的子进程会 EPERM；
  //    用 fd 还能把后端日志留下（`backend.log`），比 'ignore' 好查。
  const logFd = fs.openSync(path.join(STATE_DIR, 'backend.log'), 'a');
  const p = spawn(process.execPath, [BACKEND_JS], {
    cwd: OFFICE_ROOT,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  try { fs.closeSync(logFd); } catch { /* 子进程已继承，父进程这份关掉 */ }
  p.on('error', (e) => console.log('  ⚠️ 后端起不来：', String(e && e.message || e)));
  return p;
}

function killBackend() {
  if (!backendProc) return;
  try { backendProc.kill(); } catch { /* 已经退了 */ }
  backendProc = null;
}

/** 等后端能应答（最多 15 秒）。⚠️ 起完必须确认"监听者就是它" —— 端口被占时是别人在答。 */
async function waitBackend(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await backendAlive()) return true;
    await sleep(250);
  }
  return false;
}

// ═══════════════════════════════ 开跑

console.log('════════ dsh-office 自检（新）════════');
console.log('  后端：', BASE, '｜身份：', MEMBER, '｜状态目录：', STATE_DIR);

// ── 戊·零：内核的硬性契约（不需要后端、不需要宿主）

section('戊·零 内核硬性契约（零依赖，先跑）');
{
  const throwsOf = (fn) => { try { fn(); return null; } catch (e) { return String((e && e.message) || e); } };

  // 出处：`office-bridge.mjs` L65-66 —— 缺 memberId／dataDir 直接抛，不给你一个"半成品内核"
  const e1 = throwsOf(() => createOfficeBridge({}));
  ok(!!e1 && /memberId/.test(e1), '缺 memberId ⇒ 抛错（不给你半成品内核）', e1);
  const e2 = throwsOf(() => createOfficeBridge({ memberId: 'x' }));
  ok(!!e2 && /dataDir/.test(e2), '缺 dataDir ⇒ 抛错', e2);
  const e3 = throwsOf(() => createOfficeBridge({ memberId: 'x', dataDir: STATE_DIR }));
  ok(e3 === null, '两个都给了 ⇒ 能建出来', e3);
}

// ── 起后端

section('起后端（8787）');
// ⚠️ 开跑前：**只清"绑过的会话"，那张卡必须留着** —
//    · 残留的 `boundSessionId` 会被内核 `readState()` 读回来（`office-bridge.mjs` L93-101）
//      ⇒ 会把"连接不绑会话"那条判据骗过去；
//    · 卡是"接入手续"，清了就再也接不进去（文件头第 3 条，2026-10-06 实撞）。
fs.mkdirSync(STATE_DIR, { recursive: true });
{
  const s = readStateFile();
  s.boundSessionId = '';
  s.boundAt = '';
  writeStateFile(s);
}

const already = await backendAlive();
if (already && !USE_EXISTING) {
  console.log('  ✗ 8787 上已经有后端在跑。');
  console.log('    自检默认**自己起**（对着现成的跑，读数会被界面口令污染）。');
  console.log('    确认要沿用 ⇒ 加 `--use-existing` 重跑。');
  process.exit(2);
}

if (already) {
  note('⚠️ --use-existing：沿用 8787 上现成的后端 —— 读数可能被"界面口令"污染，自己判断。');
} else {
  backendProc = startBackend();
  const up = await waitBackend();
  ok(up, '后端起来了（能应答 /api/tools）');
  if (!up) { killBackend(); console.log('\n✗ 后端没起来，看', path.join(STATE_DIR, 'backend.log')); process.exit(2); }
}

// 前置探针：查卡这条路通不通（不通的话下面几条判据的 extra 会难看，但别的判据照旧有效）
{
  const probe = await officeCall('get_members', {});
  ok(probe && probe.ok !== false, '前置探针：boss 身份能查成员表（查卡那条路通）', JSON.stringify(probe).slice(0, 200));
}

// ⭐ 身份手续就位（本地卡丢了就从办公室取回 —— 不然后面空手接入会被当场回绝）
{
  const c = await ensureCard();
  ok(c.ok, `身份手续就位：${c.how}`, c.error);
}

// ── 起插件

section('起插件（假宿主）');
const { apply } = await import('../lib/index.js');
apply(ctx, {
  baseUrl: BASE,
  memberId: MEMBER,
  displayName: '自检探针',
  model: 'deepseek-flash',
  toolsRetryMs: 1500,
  stateDir: STATE_DIR,
  port: (await portFree(WANT_PORT)) ? WANT_PORT : 0,
  verbose: true,
});
await sleep(2000);   // 等工具表同步（apply 里是 `void trySyncTools()`，不阻塞）

// ── 甲 · 工具链路

section('甲 · 工具链路（GET /api/tools ⇒ office_* 宿主工具）');
{
  const raw = await fetch(`${BASE}/api/tools`).then((r) => r.json()).catch(() => null);
  const rawNames = ((raw && raw.tools) || []).map((t) => String(t && t.name || '')).filter(Boolean);
  ok(rawNames.length > 0, `后端工具表拿到 ${rawNames.length} 个原始工具`);

  const hostNames = [...tools.keys()];
  const expect = new Set([...rawNames.map((n) => 'office_' + n), 'office_register_bootstrap']);
  const missing = [...expect].filter((n) => !hostNames.includes(n));
  const extra = hostNames.filter((n) => !expect.has(n));
  ok(missing.length === 0, `工具表逐个对上了（${expect.size} 个：原始名 + office_ 前缀 ＋ 起步工具）`,
    `缺：${missing.join(',')}`);
  ok(extra.length === 0, '没有多余的／没加前缀的裸名工具', `多出：${extra.join(',')}`);
  ok(!hostNames.includes('register') && !hostNames.includes('send_message'),
    '裸名 register／send_message 不在（避让别的插件的重名）');
  ok(hostNames.includes('office_register_bootstrap'), '起步工具 office_register_bootstrap 在');

  // ⭐ 那道门（`bridge.js` L1636+ 「没连着就不许调工具」）：**还没连上之前，调用要被当场拒**，
  //    而且是"把人话原样带回来"，不是抛异常。（"连上之后能调通"那条判据在丁·一。）
  const gm = tools.get('office_get_member');
  if (gm) {
    const r = await gm.execute({ memberId: MEMBER }, { agent: { id: FAKE_SESSION } });
    ok(r && r.ok === false && /没连着/.test(String(r.error)),
      '⭐ 还没连上 ⇒ 调用被那道门当场拒（带人话，不是抛异常）', JSON.stringify(r).slice(0, 200));
  } else {
    ok(false, 'office_get_member 没注册，转发链测不了');
  }
}

// ── 乙 · 面板端点 ＋ 闸门

section('乙 · 面板端点（挂上没）');
{
  const paths = routes.map((r) => r.path);
  for (const p of ['/dsh-office/client-ready', '/dsh-office/panel-state',
    '/dsh-office/link', '/dsh-office/unlink', '/dsh-office/layer1']) {
    ok(paths.includes(p), `端点 ${p} 在`);
  }
  ok(!paths.includes('/dsh-office/wake') && !paths.includes('/dsh-office/interrupt'),
    '⭐ wake／interrupt **不**在宿主路由表上（它们在**内核**的反向端点上，丙组去真打）',
    paths.join(','));
}

section('乙·五 ⭐ 面板端点只认界面（0.6.1 那道闸门，三态）');
{
  const five = ['/dsh-office/client-ready', '/dsh-office/panel-state',
    '/dsh-office/link', '/dsh-office/unlink', '/dsh-office/layer1'];

  gate.available = true; gate.verdict = 401;
  let all401 = true;
  for (const p of five) {
    const r = await hit(p, {}, { method: 'GET' });
    if (r.status !== 401) { all401 = false; note(`${p} 回了 ${r.status}（期望 401）`); }
  }
  ok(all401, '裸请求（闸门判 401）⇒ 五个端点**全** 401，一个都不放行');

  gate.verdict = 403;
  const r403 = await hit('/dsh-office/panel-state', {}, { method: 'GET' });
  ok(r403.status === 403, '来源不被信任（闸门判 403）⇒ 原样 403', JSON.stringify(r403.json));

  gate.available = false; gate.verdict = undefined;
  const rNoSvc = await hit('/dsh-office/panel-state', {}, { method: 'GET' });
  ok(rNoSvc.status === 403, '⭐ **拿不到 connection 服务 ⇒ 403（fail closed）**——宁可不用也不留裸口',
    JSON.stringify(rNoSvc.json));

  gate.available = true; gate.verdict = undefined;
  const rAllow = await hit('/dsh-office/panel-state', {}, { method: 'GET' });
  ok(rAllow.status === 200 && rAllow.json && rAllow.json.ok === true,
    '界面放行 ⇒ 照常干活（200 ＋ ok:true）', JSON.stringify(rAllow.json).slice(0, 120));
}

// ── 丙·甲 反向端点：无状态四条

section('丙·甲 反向端点（真 HTTP 打内核端口）—— 无状态四条');
{
  const ps = await panelState();
  kernelPort = Number(String((ps && ps.hostPort) || '').split(':')[1] || 0);
  ok(kernelPort > 0, `拿到内核实际端口 ${kernelPort}（来源：panel-state 的 hostPort）`,
    JSON.stringify(ps && ps.hostPort));
  if (kernelPort <= 0) { console.log('\n✗ 拿不到内核端口，丙组没法跑'); }

  const g = await reverse('/dsh-office/challenge', {}, { method: 'GET', port: kernelPort });
  ok(g.status === 405, '非 POST ⇒ 405（内核只收 POST）', JSON.stringify(g));

  const bad = await reverse('/dsh-office/wake', { memberId: 'somebody-else' }, { port: kernelPort });
  ok(bad.status === 200 && bad.json && bad.json.ok === false && /不符/.test(String(bad.json.error)),
    'body 里的成员与本接入端不符 ⇒ 拒（200 ＋ ok:false，不是 4xx）', JSON.stringify(bad.json));

  const nonce = 'selfcheck-nonce-' + Date.now();
  const ch = await reverse('/dsh-office/challenge', { memberId: MEMBER, nonce }, { port: kernelPort });
  const want = crypto.createHash('sha256').update(`${MEMBER}/${nonce}`, 'utf8').digest('hex');
  ok(ch.json && ch.json.answer === want,
    'challenge 答的 = sha256(memberId + "/" + nonce) 小写 hex（自己算一遍对）',
    `${JSON.stringify(ch.json)} ≠ ${want}`);

  const nf = await reverse('/dsh-office/nonsense', { memberId: MEMBER }, { port: kernelPort });
  ok(nf.status === 404, '没这个端点 ⇒ 404', JSON.stringify(nf.json));
}

// ── 戊·甲 加载后什么都不做

section('戊·甲 ⭐ 加载后什么都不做（不自动连、不自动上线）');
{
  const st = await panelState(FAKE_SESSION);
  ok(st && st.connected === false, 'connected = false（没自己连）', JSON.stringify(st && st.connected));
  ok(st && st.linkOn === false, 'linkOn = false（等人点「连接」）');
  const card = await officeCard();
  ok(!card || card.presence !== 'online', '办公室那边：我不在线（没自动上线）', JSON.stringify(card && card.presence));
}

// ── 丁 · 连接（第一层）

section('丁·一 人点「连接」＝只挂线，**不绑会话**');
const conn = await hit('/dsh-office/layer1', { on: true });
ok(conn.json && conn.json.ok === true && conn.json.connected === true,
  '点「连接」⇒ 真连上了（ok:true／connected:true）', JSON.stringify(conn.json));
{
  const st = await panelState(FAKE_SESSION);
  ok(st && st.connected === true, '面板状态：connected = true');
  ok(st && !st.boundSessionId, '⭐ 「连接」**没有**绑定任何会话（绑定归「上线」）',
    JSON.stringify(st && st.boundSessionId));

  // ⭐ 已连接 ⇒ 转发链真在工作（甲组那条验的是"没连上时被拒"，这条验"连上后能通"）
  const gm = tools.get('office_get_member');
  if (gm) {
    const r = await gm.execute({ memberId: MEMBER }, { agent: { id: FAKE_SESSION } });
    // ⭐ 判据 = "**不是被那道门挡下**"，不是"ok 必须为真"：
    //    这一刻还没上线 —— 上面那条 note 已写明：第一次接入时此刻本来就没卡
    //    ⇒ 办公室回 ok:false「成员不存在」是**正确行为**，不该判成"转发链没工作"。
    //    真没转发出去时，返回的是那道门的话术（error 含「没连着」）—— 甲组那条验的正是它。
    const blocked = !!(r && r.ok === false && /没连着/.test(String(r.error || '')));
    ok(r && typeof r.ok === 'boolean' && !blocked,
      '已连接 ⇒ 调用真转发出去了（不是被那道门挡下；这张卡在不在是另一回事）',
      JSON.stringify(r).slice(0, 160));
  }

  const card = await officeCard();
  ok(!card || card.presence !== 'online', '连上 ≠ 上线（办公室那边还不在线）', JSON.stringify(card && card.presence));
  // ⭐ 第一次接入的成员，**这时候还没有卡** —— 报到要带会话 id，而「连接」不绑会话
  //    ⇒ 内核自己就把这次报到挡下了（`connectOnce()` 里那句 warn「没有会话 id」）。
  //    卡与门牌号都归下一节（上线）—— 这是设计如此，不是丢东西。
  note(card ? '（这个身份以前接过，所以卡已存在）' : '（第一次接入：此刻还没有卡，正常 —— 报到要等「上线」）');
}

section('丙·乙 ⭐ 反向端点：没绑过会话时，「叫它上线」要报异常');
{
  const on = await reverse('/dsh-office/online', { memberId: MEMBER }, { port: kernelPort });
  ok(on.json && on.json.ok === false && /没有绑过任何会话/.test(String(on.json.error)),
    '没绑过会话 ⇒ ok:false「上线异常：没有绑过任何会话」', JSON.stringify(on.json));
}

// ── 丁 · 上线（第二层）

section('丁·二 人点「上线」＝绑当前会话 ＋ 报到 ＋ 上线');
const link = await hit('/dsh-office/link', { sessionId: FAKE_SESSION });
ok(link.json && link.json.ok === true, '上线成功（办公室认了）', JSON.stringify(link.json).slice(0, 200));
ok(link.json && link.json.boundSessionId === FAKE_SESSION, '绑到了当前这个会话', link.json && link.json.boundSessionId);
{
  const card = await officeCard();
  ok(card && card.presence === 'online', '办公室那边：我在线', JSON.stringify(card && card.presence));
  ok(card && card.host === `127.0.0.1:${kernelPort}`,
    `⭐ 卡上的门牌号 = 内核实际端口（127.0.0.1:${kernelPort}）—— 不是"从请求头学来的宿主端口"`,
    JSON.stringify(card && card.host));
  const st = await panelState(FAKE_SESSION);
  ok(st && st.isBoundPage === true && st.canOperate === true, '面板认这是"绑定的那个页面"（可以操作）');
}

// ── 丙·丙 反向端点：有状态三条（叫醒／插话／叫上线）

section('丙·丙 ⭐ 反向端点：叫醒（wake）');
{
  const p0 = prompts.length;
  const r = await reverse('/dsh-office/wake', { memberId: MEMBER, reason: 'message', msgId: 'msg-selfcheck-1' },
    { port: kernelPort });
  ok(r.json && r.json.ok === true, '推口回话 ok:true', JSON.stringify(r.json));
  await sleep(200);
  ok(prompts.length === p0 + 1, '叫了一次 sessionController.prompt', `prompts=${prompts.length}`);
  const p = prompts[prompts.length - 1];
  if (p) {
    ok(p.sessionId === FAKE_SESSION, '送到**绑定的那个会话**', p.sessionId);
    ok(p.mode === 'queue', 'mode = queue（叫醒是排队，不是插话）', p.mode);
    const text = p.content && p.content[0] && p.content[0].text;
    ok(typeof text === 'string' && text.includes('【办公室】'), '内容带【办公室】抬头', JSON.stringify(text).slice(0, 120));
    ok(typeof text === 'string' && !String(text).includes('msg-selfcheck-1'),
      '⭐ 内容里**不带消息正文**（只把它叫进来、不看内容）', JSON.stringify(text).slice(0, 160));
  }
}

section('丙·丙 ⭐ 反向端点：插话（interrupt）');
{
  const p0 = prompts.length;
  const r = await reverse('/dsh-office/interrupt', { memberId: MEMBER, text: '时间到了，请停' }, { port: kernelPort });
  ok(r.json && r.json.ok === true, '推口回话 ok:true', JSON.stringify(r.json));
  await sleep(200);
  ok(prompts.length === p0 + 1, '插了一次', `prompts=${prompts.length}`);
  const p = prompts[prompts.length - 1];
  if (p) {
    ok(p.mode === 'steer', 'mode = steer（插话立刻接手）', p.mode);
    ok(p.sessionId === FAKE_SESSION, '插到绑定的那个会话');
  }
}

section('丙·丙 ⭐ 反向端点：叫它上线（online）');
{
  const p0 = prompts.length;
  const r = await reverse('/dsh-office/online', { memberId: MEMBER }, { port: kernelPort });
  ok(r.json && r.json.ok === true, '绑过会话之后 ⇒ ok:true（叫得到人）', JSON.stringify(r.json));
  await sleep(200);
  ok(prompts.length === p0 + 1, '叫醒了一次');
  const p = prompts[prompts.length - 1];
  if (p) {
    const text = p.content && p.content[0] && p.content[0].text;
    ok(typeof text === 'string' && /上线/.test(text), '叫醒的话里带"上线"（人从成员卡点的这条路）',
      JSON.stringify(text).slice(0, 120));
  }
}

// ── 丁 · 下线（第三层）

section('丁·三 ⭐ 点「下线」＝只撤"在岗"，**不解除绑定**（2026-10-05 修的那条）');
{
  const un = await hit('/dsh-office/unlink', {});
  ok(un.json && un.json.ok === true, '下线成功', JSON.stringify(un.json).slice(0, 160));
  ok(un.json && un.json.wasBound === FAKE_SESSION, '它记得刚才是绑着谁的', un.json && un.json.wasBound);
  ok(un.json && un.json.stillBound === FAKE_SESSION,
    '⭐ 下线**不解除绑定**（stillBound 还是那个会话）—— 清了的话办公室就点不到"叫它上线"了',
    un.json && un.json.stillBound);
  const card = await officeCard();
  ok(card && card.presence === 'offline', '办公室那边：已下线', JSON.stringify(card && card.presence));
}

section('丙·丁 ⭐ 下线之后，「叫它上线」还得叫得到（上面那条的实际效果）');
{
  const p0 = prompts.length;
  const r = await reverse('/dsh-office/online', { memberId: MEMBER }, { port: kernelPort });
  ok(r.json && r.json.ok === true, '下线后仍能叫到（地址留着）', JSON.stringify(r.json));
  await sleep(200);
  ok(prompts.length === p0 + 1, '真叫醒了一次');
}

// ── 戊 · 落盘

section('戊·乙 ⭐ 状态落盘（卡与"绑过的会话"跨重启要在）');
{
  ok(fs.existsSync(STATE_FILE), `状态文件落在 stateDir 下：${STATE_FILE}`);
  const s = readStateFile();
  ok(!!s && Object.keys(s).length > 0, '内容是合法 JSON');
  if (s) {
    ok(s.boundSessionId === FAKE_SESSION, 'boundSessionId 记着刚才绑的那个会话', JSON.stringify(s.boundSessionId));
    ok(!!s.boundAt, 'boundAt 有值');
    ok(s.card && typeof s.card === 'object' && !!s.card.id, 'card 存下来了（报到时办公室回传的那张）',
      JSON.stringify(s.card && s.card.id));
    ok(typeof s.nickHinted === 'boolean', 'nickHinted 是布尔（"给 AI 提示过起昵称没"）', String(s.nickHinted));
    ok(typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)), 'at 是时间戳', JSON.stringify(s.at));
    ok(s.boundSessionId === (await panelState()).boundSessionId, '盘上记的与内存里的一致');
  }
}

// ── 丁 · 断开

section('丁·四 ⭐ 点「断开」＝真断，而且**不许自己爬回来**');
{
  const off = await hit('/dsh-office/layer1', { on: false });
  ok(off.json && off.json.connected === false, '断开了', JSON.stringify(off.json));
  await sleep(1200);
  const st = await panelState(FAKE_SESSION);
  ok(st && st.connected === false, '⚠️ 等了一会儿也没自己连回来（一切自动重连都不要）',
    JSON.stringify(st && st.connected));
}

// ── 收尾

section('收尾：卸载要收干净');
{
  for (const l of lifecycles.filter((x) => x.event === 'dispose')) {
    try { await Promise.resolve(l.fn()); ok(true, 'dispose 回调执行没抛错'); }
    catch (e) { ok(false, 'dispose 抛错了', String(e)); }
  }
  await sleep(600);
  ok(tools.size === 0, `工具都注销了（剩 ${tools.size} 个）`);
  ok(routes.length === 0, `面板端点都撤了（剩 ${routes.length} 条）`);
  const dead = await reverse('/dsh-office/challenge', { memberId: MEMBER, nonce: 'x' }, { port: kernelPort });
  ok(dead.status === 0, '⭐ 内核的反向端点也关了（真 HTTP 打不通了，不是"还开着但没人用"）',
    JSON.stringify(dead));
}

// 兜底：跑完把我置回 offline（中途失败时可能还挂着 online）
await officeCall('presence', { memberId: MEMBER, presence: 'offline' }, MEMBER).catch(() => {});

// ── 汇总

console.log('\n════════ 结果：' + pass + ' 过 / ' + fail + ' 没过 ════════');
if (fail) {
  console.log('没过的条目：');
  for (const f of failed) console.log('  ·', f);
}
if (backendProc) { killBackend(); console.log('后端已收掉（自检自己起的那个）'); }
// ⚠️ **状态目录一律留着**：里面那张卡是"接入手续"，删了下次就空手接入 ⇒ 被办公室回绝（2026-10-06 实撞）。
console.log('状态目录（**留着**，那张卡是下次接入要用的手续）：', STATE_DIR);
process.exit(fail === 0 ? 0 : 1);

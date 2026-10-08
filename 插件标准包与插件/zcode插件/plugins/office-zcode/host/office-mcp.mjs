#!/usr/bin/env node
/**
 * office-mcp —— MCP stdio 服务器：把「办公室」的工具递到 ZCode 的 AI 面前
 *
 * ZCode 没有 Claude Code 那种 `$.tool.register`（动态注册宿主工具）的口 ⇒ 按《任务说明》
 * 第四节的落点，用 **`.mcp.json`** 声明本服务器，工具暴露成 `mcp__office__<名字>`。
 *
 * 它管两类工具：
 *   ① 办公室的原生工具（send_message／list_tasks／…）：tools/list 时现拉 `GET /api/tools`
 *     （这个读口不经准入校验，《说明书》§3）；tools/call 时经控制口 `/ctl/call` 转发进内核。
 *     填表发生在办公室侧 —— 本服务器只把通路接到 AI 面前（《说明书》§1 第 5 件）。
 *   ② 接入控制工具（office_connect／office_disconnect／office_online／office_offline／office_status）：
 *     「两个按钮」在 ZCode 上的落点 —— 人敲斜杠命令 ⇒ AI 调这里的工具 ⇒ 打控制口。
 *
 * 协议：MCP over stdio，**零依赖**（每行一个 JSON-RPC 2.0 消息）。人看的日志一律走 stderr。
 */

import readline from 'node:readline';
import { loadConfig } from './office-config.mjs';
import { callCtl, ensureHost, readRuntime } from './office-runtime.mjs';

const cfg = loadConfig();
const say = (...a) => { try { process.stderr.write('[office-mcp] ' + a.join(' ') + '\n'); } catch { /* 管道没了 */ } };

/** 命令行里带进来的会话 id（.mcp.json 的 args 用 ${ZCODE_SESSION_ID} 展开；展开不了就是字面量，弃用）。 */
function argvSessionId() {
  const i = process.argv.indexOf('--session');
  const v = i >= 0 ? String(process.argv[i + 1] || '') : '';
  return /^sess_/.test(v) ? v : '';
}
function envSessionId() {
  const v = String(process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || '');
  return /^sess_/.test(v) ? v : '';
}

// ─────────────────────────────── 控制工具（「两个按钮」的落点）

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false };

const CONTROL_TOOLS = [
  {
    name: 'office_status',
    description: '办公室接入状态一览：连着没／绑的是哪个会话／当前会话／门牌号／卡在哪。出问题时先调它。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'office_connect',
    description: '办公室的「连接」按钮：挂上与办公室之间的那条常驻线（第一层，不碰会话绑定）。断了不会自己重挂，恢复也靠它。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'office_disconnect',
    description: '办公室的「断开」按钮：掐断那条常驻线（第一层）。断了不会自己重连。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'office_online',
    description: '办公室的「上线」按钮：把当前会话绑上办公室 ＋ 报到 ＋ 上线（第二层）。要先「连接」。',
    inputSchema: EMPTY_SCHEMA,
  },
  {
    name: 'office_offline',
    description: '办公室的「下线」按钮：只撤掉"在岗"，不解除绑定（地址留着，办公室才叫得到人）。',
    inputSchema: EMPTY_SCHEMA,
  },
];

/** 控制工具 ⇒ 控制口路由。返回 {text, isError}。 */
async function callControl(name) {
  const up = await ensureHost(cfg, { spawnWaitMs: 8000 });
  if (!up.ok) return { text: `办公室接入端没在跑，也拉不起来（${up.reason}）。`, isError: true };

  if (name === 'office_status') {
    const r = await callCtl(cfg, '/ctl/state');
    if (!r.ok) return { text: `拉状态失败：${r.error || r.status}`, isError: true };
    const s = r.data.status || {};
    const rep = r.data.report || {};
    return { text: JSON.stringify({
      memberId: r.data.memberId,
      常驻进程: '在跑',
      第一层连接: s.connected ? '已连接' : '未连接',
      报过到: s.registered === true,
      办公室说: r.data.presence || '未知',
      离线原因: r.data.offlineReason || '',
      名单异常: r.data.presenceErr || '',
      报到身份: `model=${rep.model || '（没探测到，报到不带这格）'}｜icon=${rep.iconChars ? `${rep.iconChars} 字符` : '（没交）'}`,
      绑定的会话: s.boundSessionId || '（还没有）',
      当前会话: r.data.currentSessionId || '（hook 没报到过）',
      门牌号: s.hostPort || '（还没有）',
      卡与状态: r.data.dataDir || cfg.dataDir,
    }, null, 2) };
  }
  if (name === 'office_connect') {
    const r = await callCtl(cfg, '/ctl/layer1', { on: true }, 5000);
    const d = r.data || {};
    if (!d.ok) return { text: `连接没成：${d.error || r.error || '连不上办公室'}`, isError: true };
    return { text: '已连接（第一层）。没有绑定会话 —— 上线是另一层（office_online）。' };
  }
  if (name === 'office_disconnect') {
    const r = await callCtl(cfg, '/ctl/layer1', { on: false });
    if (!r.ok) return { text: `断开失败：${r.error}`, isError: true };
    return { text: '已断开。按规矩不会自己重挂；要恢复，再执行 /office-connect。' };
  }
  if (name === 'office_online') {
    const r = await callCtl(cfg, '/ctl/link', {}, 10000);
    const d = r.data || {};
    if (!d.ok) {
      const why = String((d.office && d.office.error) || d.error || r.error || '办公室没认');
      return { text: `上线失败：${why}`, isError: true };
    }
    return { text: JSON.stringify({ ok: true, 绑定的会话: d.boundSessionId, office: d.office ?? null }, null, 2) };
  }
  if (name === 'office_offline') {
    const r = await callCtl(cfg, '/ctl/unlink');
    if (!r.ok) return { text: `下线失败：${r.error}`, isError: true };
    const d = r.data || {};
    return { text: JSON.stringify({ ok: true, 刚才绑定: d.wasBound || '（没有）', 仍然绑定: d.stillBound || '（没有）', office: d.office ?? null }, null, 2) };
  }
  return { text: `没有这个控制工具：${name}`, isError: true };
}

// ─────────────────────────────── 办公室原生工具的转发

const TOOL_CACHE = { at: 0, list: [] };

/** 拉 `GET /api/tools`（不经准入校验的读口）；5 秒缓存。拉不到 ＝ 办公室没开，只回控制工具。 */
async function officeTools() {
  const now = Date.now();
  if (TOOL_CACHE.at && now - TOOL_CACHE.at < 5000) return TOOL_CACHE.list;
  try {
    const res = await fetch(`${cfg.base}/api/tools`, { signal: AbortSignal.timeout(2500) });
    const data = await res.json().catch(() => null);
    const list = Array.isArray(data && data.tools) ? data.tools : Array.isArray(data) ? data : [];
    TOOL_CACHE.list = list
      .map((t) => ({
        name: String((t && t.name) || '').trim(),
        description: `${String((t && t.description) || '')}（办公室工具，经接入插件转发；填表发生在办公室侧）`.trim(),
        inputSchema: (t && t.inputSchema) || EMPTY_SCHEMA,
      }))
      .filter((t) => t.name);
    TOOL_CACHE.at = now;
  } catch {
    TOOL_CACHE.list = [];
    TOOL_CACHE.at = now;
  }
  return TOOL_CACHE.list;
}

/** 控制口当前认的"当前会话"（hook 报的；hook 没跑过就退回本服务器自己带的那份）。 */
async function pickSessionId() {
  const r = await callCtl(cfg, '/ctl/state', {}, 2000);
  const cur = String((r.data && r.data.currentSessionId) || '');
  return cur || argvSessionId() || envSessionId() || '';
}

/** 办公室工具 ⇒ 经控制口转发。register／presence 两处特判（同参照插件）。 */
async function callOffice(raw, args) {
  const up = await ensureHost(cfg, { spawnWaitMs: 8000 });
  if (!up.ok) return { text: `办公室接入端没在跑，也拉不起来（${up.reason}）。那一行要由人「连接」拉起 —— 见 README。`, isError: true };

  if (raw === 'presence') {
    const stR = await callCtl(cfg, '/ctl/state');
    const connected = !!(stR.data && stR.data.status && stR.data.status.connected);
    if (String((args && args.presence) || '') === 'offline') {
      const r = await callCtl(cfg, '/ctl/unlink');
      if (!r.ok) return { text: `下线失败：${r.error}`, isError: true };
      return { text: JSON.stringify({ ok: true, office: (r.data && r.data.office) ?? null }, null, 2) };
    }
    if (!connected) {
      return { text: '办公室那边是「已断开」：线断了就上不了线 —— 要连得人执行 /office-connect。', isError: true };
    }
    const sid = await pickSessionId();
    if (!sid) return { text: '拿不到当前会话 id，上不了线。', isError: true };
    const r = await callCtl(cfg, '/ctl/link', { sessionId: sid }, 10000);
    const d = r.data || {};
    if (!d.ok) return { text: `上线失败：${String((d.office && d.office.error) || d.error || r.error || '办公室没认')}`, isError: true };
    return { text: JSON.stringify({ ok: true, boundSessionId: d.boundSessionId, office: d.office ?? null }, null, 2) };
  }

  if (raw === 'register') {
    // 门牌号与宿主进程名由插件代报 —— AI 填不出这两个值（《说明书》§2 第二步）
    const stR = await callCtl(cfg, '/ctl/state');
    const s = (stR.data && stR.data.status) || {};
    args = { ...(args || {}) };
    args.host = s.hostPort || args.host || undefined;
    args.name = cfg.name;
    args.memberId = cfg.memberId;
    args.sessionId = (stR.data && stR.data.currentSessionId) || args.sessionId || argvSessionId() || envSessionId() || undefined;
  }

  const r = await callCtl(cfg, '/ctl/call', { tool: raw, args: args || {} }, 15000);
  const out = r.data && r.data.result;
  if (!r.ok || !out) return { text: `转发失败：${String(r.error || '控制口没回话')}`, isError: true };
  if (out.ok === false) return { text: String(out.error || out.notify || '办公室拒了'), isError: true };
  return { text: JSON.stringify(out.data ?? out, null, 2) };
}

// ─────────────────────────────── MCP over stdio（JSON-RPC 2.0，每行一条）

const SERVER_INFO = { name: 'office', version: '0.1.0' };

function write(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch { /* 管道没了 */ }
}

async function handle(id, method, params) {
  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') {
    const office = await officeTools();
    const controlNames = new Set(CONTROL_TOOLS.map((t) => t.name));
    return { tools: [...CONTROL_TOOLS, ...office.filter((t) => !controlNames.has(t.name))] };
  }
  if (method === 'tools/call') {
    const name = String((params && params.name) || '');
    const args = (params && params.arguments) || {};
    try {
      if (CONTROL_TOOLS.some((t) => t.name === name)) {
        const r = await callControl(name);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
      }
      const raw = name.startsWith('mcp__office__') ? name.slice('mcp__office__'.length) : name;
      const r = await callOffice(raw, args);
      return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
    } catch (e) {
      return { content: [{ type: 'text', text: `转发时出错：${String((e && e.message) || e)}` }], isError: true };
    }
  }
  if (id !== null && id !== undefined) {
    return { error: { code: -32601, message: `没有这个方法：${method}` } };
  }
  return null; // 通知，不用回
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let m = null;
  try { m = JSON.parse(s); } catch { return; }
  if (!m || typeof m !== 'object') return;
  void (async () => {
    const isRequest = m.id !== null && m.id !== undefined;
    let result = null;
    try { result = await handle(m.id, String(m.method || ''), m.params); }
    catch (e) {
      if (isRequest) write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String((e && e.message) || e) } });
      return;
    }
    if (result === null) return;
    if (isRequest) {
      if (result && result.error && result.error.code) write({ jsonrpc: '2.0', id: m.id, error: result.error });
      else write({ jsonrpc: '2.0', id: m.id, result });
    }
  })();
});
rl.on('close', () => process.exit(0));

say(`起来了：办公室=${cfg.base}｜成员=${cfg.memberId}｜控制口靠运行时指针找（${cfg.dataDir}）`);

/**
 * codex-office —— 把 Codex 接进「办公室」。
 *
 * 分工按标准包：
 *   · lib/office-bridge.mjs ＝「插件 ↔ 办公室」：原样使用标准包内核，不改协议。
 *   · 本文件 ＋ lib/codex-host.mjs ＝「Codex ↔ 插件」：MCP 工具、宿主叫醒/插话、
 *     控制工具、最近一次会话 id。
 *
 * Codex 宿主这一层的事实来源（2026-10-06，Codex CLI 0.160.0 本机核实）：
 *   · 插件是 Codex 的 MCP 服务器（.mcp.json / .codex-plugin/plugin.json）。
 *   · 每次 tools/call 都带 `_meta.threadId` ⇒ 当前会话 id 以它为准。
 *   · `codex queue --thread <id> --message <text>` 是稳定投递入口；是否立即接手
 *     由 `[desktop] followUpQueueMode` 决定。办公室要求插话时配 steer。
 *   · app-server 协议有 `turn/steer`，本机 schema 已核实；但因为要直连运行中的
 *     daemon，实现上先走稳定的 queue 入口，不另开 app-server 去抢线程。
 *
 * 两个「按钮」的 Codex 落点：
 *   Codex 0.160.0 没有输入框上方的 UI 扩展点（标准包《插件怎么写.md》§2.2 已写明）。
 *   因此这里提供两个明确的 MCP 控制工具，作为两个按钮在 Codex 里的等价入口：
 *     office_ui_connection  → 连接 / 断开（第一层）
 *     office_ui_presence    → 上线 / 下线（第二层）
 *   AI 日常用的办公室工具仍按标准包从 GET /api/tools 动态取，统一加 office_ 前缀。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createOfficeBridge } from './office-bridge.mjs';
import { createCodexHost } from './codex-host.mjs';

const PREFIX = 'office_';
const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MEMBER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const isWindows = process.platform === 'win32';

function toText(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function asInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function validMemberId(value, fallback = 'codex') {
  const s = String(value || '');
  return MEMBER_ID_RE.test(s) ? s : fallback;
}

function defaultStateDir(env) {
  const home = env && env.CODEX_HOME ? String(env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  return path.join(home, 'office-bridge');
}

/** 从宿主 exe 抽图标（纯 base64，不带 data: 前缀）。抽不到不是错误。 */
function grabHostIcon(exePath, log, warn) {
  if (!isWindows || !exePath || !fs.existsSync(exePath)) return null;
  try {
    const ps = 'Add-Type -AssemblyName System.Drawing; '
      + `$i=[System.Drawing.Icon]::ExtractAssociatedIcon('${String(exePath).replace(/'/g, "''")}'); `
      + '$b=$i.ToBitmap(); $ms=New-Object System.IO.MemoryStream; '
      + '$b.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png); '
      + '[Convert]::ToBase64String($ms.ToArray())';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    const b64 = String((r && r.stdout) || '').trim();
    if (!b64 || b64.length < 100) {
      warn('抽宿主图标没抽到：status=', r && r.status,
        '｜error=', r && r.error ? (r.error.code + ' / ' + r.error.message) : '（无）',
        '｜stderr=', String((r && r.stderr) || '').slice(0, 120));
      return null;
    }
    log('已抽取 Codex 图标（base64', b64.length, '字符）');
    return b64;
  } catch (e) {
    warn('抽宿主图标失败：', String((e && e.message) || e));
    return null;
  }
}

function wakeText(why) {
  const w = String(why || '');
  if (w.startsWith('【办公室】')) return w;
  if (/叫它上线|叫你上线/.test(w)) {
    return '【办公室】有人在办公室叫你上线，进来自己上线。\n'
      + '· 上线：调用 office_ui_presence，参数 { action: "online", sessionId: "<当前会话 id>" }（也可以不传 sessionId，插件会用本次工具调用所在的会话）。';
  }
  return '【办公室】有人找你，进来看看。' + (w ? `（${w}）` : '') + '\n'
    + '· 读账本：office_read_messages　· 看任务：office_list_tasks　· 看自己在不在线：office_get_member\n'
    + '· 回话／交付／表态都在办公室里填表（office_send_message 等）；'
    + '派发要当场表态：接 ⇒ office_send_message 发 task.ack，不接 ⇒ office_refuse。';
}

const CONTROL_TOOLS = [
  {
    name: 'office_status',
    description: '查看接入状态：连接、上线、绑定的会话、当前 Codex 会话是否就是绑定会话。对应办公室界面上的状态显示。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'office_ui_connection',
    description: '办公室按钮等价入口·第一层：连接或断开「办公室 ↔ 插件」那条常驻连接。连接只连第一层，不绑定会话；断开后不得自行重连，恢复要人再次点连接。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['connect', 'disconnect'], description: 'connect = 连接；disconnect = 断开' },
      },
      required: ['action'],
    },
  },
  {
    name: 'office_ui_presence',
    description: '办公室按钮等价入口·第二层：上线或下线。上线 = 绑定本次工具调用所在的 Codex 会话 ＋ 报到 ＋ 上线；下线只报离线，不清掉上一次绑定的会话。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['online', 'offline'], description: 'online = 上线；offline = 下线' },
        sessionId: { type: 'string', description: '可选；不传则使用本次 tools/call 的 _meta.threadId' },
        nick: { type: 'string', description: '可选；给办公室报的昵称' },
        model: { type: 'string', description: '可选；给办公室报的模型名' },
      },
      required: ['action'],
    },
  },
  {
    name: 'office_register_bootstrap',
    description: 'AI 自己上线：绑定本次工具调用所在的会话、报到并 presence online。可顺带写昵称和模型。办公室在成员卡上点「叫它上线」时，被叫醒后也用它。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '可选；不传则使用本次 tools/call 的 _meta.threadId' },
        nick: { type: 'string', description: '可选；昵称，可以没有' },
        model: { type: 'string', description: '可选；模型名' },
      },
    },
  },
  {
    name: 'office_refresh_tools',
    description: '重新从办公室 GET /api/tools 拉工具表，刷新本插件暴露的 office_* 工具。',
    inputSchema: { type: 'object', properties: {} },
  },
];

const CONTROL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.name));

export function createOfficePlugin(options = {}) {
  const env = options.env || process.env;
  const log = typeof options.log === 'function' ? options.log : (...a) => console.error('[office]', ...a);
  const warn = typeof options.warn === 'function' ? options.warn : (...a) => console.error('[office]', ...a);
  const fetchImpl = options.fetchImpl || fetch;

  const cfg = {
    base: String(env.OFFICE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    memberId: validMemberId(env.OFFICE_MEMBER_ID, 'codex'),
    hostName: String(env.OFFICE_HOST_NAME || 'Codex'),
    nick: env.OFFICE_NICK === undefined ? undefined : String(env.OFFICE_NICK),
    model: String(env.OFFICE_MODEL || env.CODEX_MODEL || 'codex'),
    icon: env.OFFICE_ICON_BASE64 ? String(env.OFFICE_ICON_BASE64) : undefined,
    dataDir: String(env.OFFICE_STATE_DIR || defaultStateDir(env)),
    port: asInt(env.OFFICE_PORT, 19391),
    keepMsg: false,
  };

  const host = options.host || createCodexHost({
    env,
    log,
    warn,
    timeoutMs: asInt(env.OFFICE_CODEX_TIMEOUT_MS, 20000),
  });

  let bridge = null;
  let bridgeOpts = null;
  let startPromise = null;
  let iconPromise = null;
  let toolCacheAt = 0;
  let toolCache = [];

  function makeBridge(port) {
    bridgeOpts = {
      base: cfg.base,
      memberId: cfg.memberId,
      name: cfg.hostName,
      nick: cfg.nick,
      model: cfg.model,
      icon: cfg.icon,
      dataDir: cfg.dataDir,
      port,
      wake: async (why) => {
        const sid = bridge && bridge.status().boundSessionId;
        if (!sid) {
          warn('还没绑会话（没人点过上线）⇒ 没人可叫；消息在办公室账本里，等它自己来读');
          return false;
        }
        await ensureIcon();
        const text = wakeText(why);
        const r = await host.queue(sid, text);
        return !!(r && r.ok);
      },
      steer: async (text) => {
        const sid = bridge && bridge.status().boundSessionId;
        if (!sid) {
          warn('还没绑会话，插不进去');
          return false;
        }
        const r = await host.steer(sid, String(text || '时间到了，请停'));
        return !!(r && r.ok);
      },
      log,
      warn,
    };
    return createOfficeBridge(bridgeOpts);
  }

  bridge = makeBridge(cfg.port);

  async function ensureIcon() {
    if (cfg.icon) { if (bridgeOpts) bridgeOpts.icon = cfg.icon; return cfg.icon; }
    if (!iconPromise) {
      iconPromise = (async () => {
        const b64 = await Promise.resolve(grabHostIcon(host.codexBin, log, warn));
        if (b64) {
          cfg.icon = b64;
          if (bridgeOpts) bridgeOpts.icon = b64;
        }
        return cfg.icon || null;
      })();
    }
    return iconPromise;
  }

  function start() {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        await bridge.start();
      } catch (e) {
        const msg = String((e && e.message) || e);
        warn(`反向端点用端口 ${cfg.port} 起不来（${msg}）⇒ 退回自动挑一个端口。这一次门牌号会变。`);
        bridge = makeBridge(0);
        await bridge.start();
      }
      return bridge.status();
    })();
    return startPromise;
  }

  async function stop() {
    try { host.stop(); } catch { /* 子进程已经退出 */ }
    try { if (bridge) await bridge.stop(); } catch { /* 端点已经关了 */ }
  }

  async function refreshTools(force = false) {
    if (!force && Date.now() - toolCacheAt < 3000) return toolCache;
    try {
      const res = await fetchImpl(`${cfg.base}/api/tools`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const list = Array.isArray(json && json.tools) ? json.tools : Array.isArray(json) ? json : [];
      toolCache = list
        .map((t) => ({
          rawName: String((t && t.name) || '').trim(),
          description: String((t && t.description) || (t && t.name) || '').trim(),
          inputSchema: (t && (t.inputSchema || t.parameters)) || { type: 'object', properties: {} },
        }))
        .filter((t) => t.rawName);
      toolCacheAt = Date.now();
      return toolCache;
    } catch (e) {
      if (force) throw e;
      return toolCache;
    }
  }

  function toolName(rawName) { return PREFIX + rawName; }

  async function listTools() {
    const dynamic = await refreshTools(false);
    const tools = CONTROL_TOOLS.map((t) => ({ ...t, inputSchema: t.inputSchema }));
    for (const t of dynamic) {
      const name = toolName(t.rawName);
      if (CONTROL_NAMES.has(name)) continue;
      tools.push({
        name,
        description: `${t.description || t.rawName}（办公室工具，经 codex-office 转发）`,
        inputSchema: t.inputSchema,
      });
    }
    return tools;
  }

  function currentThreadId(meta) {
    return String((meta && meta.threadId) || env.CODEX_THREAD_ID || '');
  }

  function status(meta) {
    const st = bridge.status();
    const current = currentThreadId(meta);
    const bound = String(st.boundSessionId || '');
    let binding = 'unknown';
    if (!bound) binding = 'unbound';
    else if (current && current === bound) binding = 'bound-here';
    else if (current) binding = 'bound-elsewhere';
    else binding = 'bound-no-current';
    return {
      memberId: cfg.memberId,
      hostName: cfg.hostName,
      base: cfg.base,
      hostPort: st.hostPort,
      connected: st.connected,
      connecting: st.connecting,
      registered: st.registered,
      boundSessionId: bound,
      currentThreadId: current,
      binding,
      toolCount: toolCache.length,
      stateDir: cfg.dataDir,
      codexBin: host.codexBin,
      codexHome: host.codexHome,
    };
  }

  async function waitConnected(ms = 3200) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = bridge.status();
      if (s.connected) return true;
      if (!s.connecting) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return bridge.status().connected;
  }

  function connectedError() {
    return { ok: false, error: '办公室那边是「已断开」：先调用 office_ui_connection（action="connect"）连接。' };
  }

  async function uiConnection(args = {}) {
    const action = String(args.action || 'connect');
    await start();
    if (action !== 'connect') {
      bridge.disconnect();
      return { ok: true, connected: false, action: 'disconnect' };
    }
    if (bridge.status().connected) return { ok: true, connected: true, action: 'connect' };
    await ensureIcon();
    bridge.connect();
    const connected = await waitConnected();
    return connected
      ? { ok: true, connected: true, action: 'connect' }
      : { ok: false, connected: false, action: 'connect', error: '连不上办公室（它没开？）' };
  }

  async function goPresence(args = {}, meta = {}) {
    const action = String(args.action || args.presence || 'online');
    if (action === 'offline') {
      if (!bridge.status().connected) return connectedError();
      return await bridge.offline();
    }
    if (!bridge.status().connected) return connectedError();
    const sid = String(args.sessionId || currentThreadId(meta) || '');
    if (!sid) return { ok: false, error: '拿不到当前 Codex 会话 id，不能上线' };
    if (args.nick !== undefined) { cfg.nick = String(args.nick); bridgeOpts.nick = cfg.nick; }
    if (args.model !== undefined && args.model !== null && args.model !== '') { cfg.model = String(args.model); bridgeOpts.model = cfg.model; }
    await ensureIcon();
    const r = await bridge.online(sid);
    if (r && r.ok === false) return { ...r, ok: false, sessionId: sid };
    return { ok: true, sessionId: sid, binding: 'bound-here', nick: cfg.nick ?? null, model: cfg.model, office: r, state: status(meta) };
  }

  function fillRegisterArgs(args = {}, meta = {}) {
    const a = { ...(args || {}) };
    const sid = String(a.sessionId || currentThreadId(meta) || bridge.status().boundSessionId || '');
    a.memberId = cfg.memberId;
    a.sessionId = sid;
    a.name = cfg.hostName;
    if (a.nick === undefined) a.nick = cfg.nick;
    if (!a.model) a.model = cfg.model;
    a.host = bridge.status().hostPort;
    if (cfg.icon) a.icon = cfg.icon;
    return a;
  }

  async function forward(rawName, args = {}, meta = {}) {
    if (!bridge.status().connected) return connectedError();
    if (rawName === 'presence') return await goPresence(args, meta);
    if (rawName === 'register') {
      const a = fillRegisterArgs(args, meta);
      if (!a.sessionId) return { ok: false, error: '报到需要当前会话 id' };
      await ensureIcon();
      if (cfg.icon) a.icon = cfg.icon;
      return await bridge.callTool('register', a);
    }
    return await bridge.callTool(rawName, args || {});
  }

  async function callTool(name, args = {}, meta = {}) {
    const tool = String(name || '');
    if (tool === 'office_status') return { ok: true, ...status(meta) };
    if (tool === 'office_refresh_tools') {
      try {
        const list = await refreshTools(true);
        return { ok: true, tools: list.map((t) => toolName(t.rawName)) };
      } catch (e) {
        return { ok: false, error: `拉工具表失败：${String((e && e.message) || e)}` };
      }
    }
    if (tool === 'office_ui_connection') return await uiConnection(args);
    if (tool === 'office_ui_presence' || tool === 'office_register_bootstrap') return await goPresence(args, meta);

    if (tool.startsWith(PREFIX)) {
      const rawName = tool.slice(PREFIX.length);
      let list = await refreshTools(false);
      if (!list.some((t) => t.rawName === rawName)) list = await refreshTools(true);
      if (!list.some((t) => t.rawName === rawName)) return { ok: false, error: `当前工具表里没有 ${tool}（办公室没开或工具名不在这里）` };
      return await forward(rawName, args, meta);
    }
    return { ok: false, error: `未知工具：${tool}` };
  }

  return {
    config: cfg,
    bridge,
    host,
    start,
    stop,
    listTools,
    callTool,
    status,
    refreshTools,
    get bridgeRef() { return bridge; },
  };
}

const SERVER_INFO = { name: 'codex-office', title: 'Codex Office Bridge', version: '0.1.0' };

/** 处理一条 MCP JSON-RPC 消息；返回要写回的 response，notification 返回 null。 */
export async function handleMcpMessage(msg, plugin) {
  if (!msg || typeof msg !== 'object') return null;
  const id = msg.id;
  const method = String(msg.method || '');
  const isNotification = id === undefined || id === null;

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'initialize') {
    const requested = String((msg.params && msg.params.protocolVersion) || '');
    const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18';
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: SERVER_INFO,
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    try {
      return { jsonrpc: '2.0', id, result: { tools: await plugin.listTools() } };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: String((e && e.message) || e) } };
    }
  }
  if (method === 'tools/call') {
    const name = String((msg.params && msg.params.name) || '');
    const args = (msg.params && msg.params.arguments) || {};
    const meta = (msg.params && msg.params._meta) || {};
    try {
      const result = await plugin.callTool(name, args, meta);
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: toText(result) }],
          isError: !!(result && result.ok === false),
        },
      };
    } catch (e) {
      const text = `工具执行失败：${String((e && e.message) || e)}`;
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
    }
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'logging/setLevel') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'completion/complete') return { jsonrpc: '2.0', id, result: { completion: { values: [] } } };

  if (isNotification) return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未实现的方法：${method}` } };
}

/** 跑 MCP stdio 服务器。stdout 只写协议；日志一律走 stderr。 */
export async function runMcpServer(plugin, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const exitOnClose = options.exitOnClose !== false;
  await plugin.start();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    void (async () => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const res = await handleMcpMessage(msg, plugin);
      if (res) output.write(JSON.stringify(res) + '\n');
    })().catch((e) => warnSafe(e));
  });
  rl.on('close', () => {
    void Promise.resolve(plugin.stop()).finally(() => {
      if (exitOnClose) process.exit(0);
    });
  });
}

function warnSafe(e) {
  try { console.error('[office] MCP 处理出错：', String((e && e.message) || e)); } catch { /* 没有 stderr 也要活 */ }
}

const thisFile = fileURLToPath(import.meta.url);
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = entry && path.resolve(thisFile).toLowerCase() === entry.toLowerCase();

if (isMain) {
  const plugin = createOfficePlugin();
  runMcpServer(plugin).catch((e) => {
    console.error('[office] MCP 启动失败：', String((e && e.message) || e));
    process.exit(1);
  });
  const bail = async () => { try { await plugin.stop(); } finally { process.exit(0); } };
  process.on('SIGINT', () => { void bail(); });
  process.on('SIGTERM', () => { void bail(); });
}
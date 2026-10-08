'use strict';

/**
 * M8 · 对外接口 —— stdio MCP 那一口（零依赖手写 MCP/JSON-RPC 协议）
 *
 * 依据：
 *   - 模块\M8-对外接口.md
 *   - 规范\08-落地结构-20261002.md §四（stdio MCP 口；工具名不带点号）
 *
 * 设计：
 *   - 传输 = stdio + newline-delimited JSON-RPC 2.0（MCP 2024-11-05 最小协议子集）；
 *   - 只实现宿主会用的四个方法：initialize / notifications/initialized / tools/list / tools/call / ping；
 *   - 工具分发统一走 bridge.invokeTool（与 HTTP 口同一份逻辑，不是两套）；
 *   - 动作（接入/报到/改状态/查成员/refuse/over 等）走工具调用，不进账本；
 *   - 内容消息（send_message）经 M2 校验入账本并按类型叫醒/静默投递。
 *
 * 约束：零第三方依赖（不绑 MCP SDK）；不改 M1~M7 的代码与接口。
 */

const readline = require('readline');

/** MCP 协议版本（2024-11-05；宿主按此协商） */
const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'office-bridge', version: '1.0.0' };

/**
 * 造一个 stdio MCP server
 * @param {object} deps
 *   bridge: { invokeTool(memberId, tool, args), listTools(), getState() }
 *   logger: M7 日志（可选，record 用）
 * @returns {{start():void}}
 */
function createMcpStdioServer(deps) {
  const bridge = deps && deps.bridge;
  const logger = (deps && deps.logger) || null;

  if (!bridge || typeof bridge.invokeTool !== 'function' || typeof bridge.listTools !== 'function') {
    throw new Error('mcp-stdio 需要 bridge（含 invokeTool / listTools）');
  }

  // ⚠️ 「接入端起来就自己挂那条连接」2026-10-04 **作废**（`接入\01` §2.2：老大令「砍掉自动重连」+「刚开的也不要」）——
  //    原来这里在第一次替谁调用工具时替它挂一条 `GET /api/alive`（SSE）；现在**只有人点「连接」才挂**，
  //    而那条连接归**接入插件**管（`接入\02` §2.1），不归这个 stdio 代理。这里既不自动挂、也不发心跳。

  /** 回一条 JSON-RPC 响应（stdout + 换行） */
  function respond(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
  }

  /** 回一条请求的结果（id 必须原样带回） */
  function result(id, result) {
    respond({ jsonrpc: '2.0', id, result });
  }

  /** 回一条错误（id 必须原样带回；MCP 错误码：-32700 解析错误 / -32600 无效请求 / -32601 方法不存在 / -32602 无效参数） */
  function error(id, code, message, data) {
    const out = { jsonrpc: '2.0', id, error: { code, message } };
    if (data !== undefined) out.error.data = data;
    respond(out);
  }

  /**
   * 处理 tools/call：工具参数里 memberId 即调用者；结果统一包成 MCP content
   * 动作工具成功 → isError:false；失败 → isError:true + 对当事人可读的 notify
   */
  async function handleToolsCall(id, params) {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (!name || typeof name !== 'string') {
      return error(id, -32602, 'tools/call 需要 name');
    }
    // 取调用者：参数 memberId 或调用的宿主上下文（MCP 无显式 caller，统一以参数 memberId 为准）
    const memberId = args.memberId;
    if (!memberId) {
      return error(id, -32602, '工具参数缺 memberId（谁在调）', { tool: name });
    }
    // bridge 可以是本地桥（同步返回）或 HTTP 客户端（返回 Promise）—— 两种都吃
    let r;
    try {
      r = await Promise.resolve(bridge.invokeTool(memberId, name, args));
    } catch (e) {
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: '工具调用失败：' + String((e && e.message) || e) }],
          isError: true,
        },
      });
    }
    if (!r.ok) {
      return respond({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: r.notify || r.error || '操作失败' }],
          isError: true,
        },
      });
    }
    respond({
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(r.data) }],
        isError: false,
      },
    });
  }

  /** 取工具清单：本地桥返回数组、HTTP 客户端返回 Promise；连不上时回 MCP 错误（口径：办公室没开） */
  async function handleToolsList(id) {
    try {
      const tools = await Promise.resolve(bridge.listTools());
      return result(id, { tools });
    } catch (e) {
      return error(id, -32603, String((e && e.message) || e));
    }
  }

  /** 请求分派（JSON-RPC 2.0） */
  async function handleMessage(line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch (_) {
      return error(null, -32700, '解析错误：不是合法 JSON');
    }
    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0') {
      return error(null, -32600, '无效请求：jsonrpc 必须是 2.0');
    }

    const isNotification = req.id === undefined || req.id === null;
    const method = req.method;
    const id = isNotification ? null : req.id;

    // 通知（无 id）：只处理 initialized（表示宿主已就绪），其它通知静默
    if (isNotification) {
      if (method === 'notifications/initialized' || method === 'initialized') {
        // 宿主初始化完成：无响应（通知）
      }
      return;
    }

    switch (method) {
      case 'initialize': {
        const p = req.params || {};
        const clientVersion = p.protocolVersion || 'unknown';
        if (clientVersion !== PROTOCOL_VERSION) {
          // 版本不匹配：仍回 server 支持的版本让宿主降级/协商
        }
        return result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      }
      case 'ping':
        return result(id, {});
      case 'tools/list':
        return await handleToolsList(id);
      case 'tools/call':
        return handleToolsCall(id, req.params);
      default:
        return error(id, -32601, `方法不存在: ${method}`);
    }
  }

  /**
   * 启动：读 stdin 直到 EOF（宿主拉起本进程后逐行发 JSON-RPC）
   * 阻塞调用；进程在 EOF 后自然退出。
   */
  function start() {
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    // 串行处理：工具调用会改账本，不能并发交错（JSON-RPC 允许多条响应乱序回，但这里保守串行）
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      if (!line || !line.trim()) return;
      chain = chain.then(() => handleMessage(line)).catch((e) => {
        try { process.stderr.write('stdio 口处理失败: ' + String((e && e.message) || e) + '\n'); } catch (_) {}
      });
    });
    rl.on('close', () => {
      // EOF：宿主收走进程
      if (logger && typeof logger.logEvent === 'function') {
        try { logger.logEvent({ type: 'state', who: 'system', why: 'stdio 口关闭（stdin EOF）' }); } catch (_) {}
      }
      // ⚠️ 2026-10-03 实测：直接 process.exit(0) 会把还没排空的 stdout 冲掉（喂一行就关 stdin 时一行都收不到）。
      // 改成等 stdout 排空后再退；200ms 兜底（沙箱/管道下 write 回调可能不来）。
      const bye = setTimeout(() => process.exit(0), 200);
      process.stdout.write('', () => { clearTimeout(bye); process.exit(0); });
    });
  }

  return { start };
}

// ── 作为主入口直接运行（生产路径）：只连本机已经在跑的后端，不自己建一套 ──
// ⚠️ 2026-10-03 改（§四 多口接入）：原来这里是 `require('./bridge')` —— 每起一个 stdio 进程就自己建一套桥，
//    于是会话映射是各进程内存态（跨口叫醒不通）、办公室关着也能报到、与壳起的后端同写一份 数据\。
//    现在只当代理：工具调用转发给后端 HTTP 口（见 http-client.js）。日志由后端写（唯一写者），这里不写。
if (require.main === module) {
  const { createHttpClient } = require('./http-client');
  createMcpStdioServer({ bridge: createHttpClient() }).start();
}

module.exports = { createMcpStdioServer, PROTOCOL_VERSION };

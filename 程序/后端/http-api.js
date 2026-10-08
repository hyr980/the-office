'use strict';

/**
 * M8 · 对外接口 —— HTTP 那一口（零依赖，node:http 内置）
 *
 * 依据：
 *   - 模块\M8-对外接口.md
 *   - 规范\08-落地结构-20261002.md §四（HTTP 口；默认 8787；地址和端口写进 README 让对接方自己填）
 *
 * 设计：
 *   - 与 stdio MCP 口读写同一个服务端：工具调用统一走 bridge.invokeTool（不是两套逻辑）；
 *   - 端点（⭐ 与规范 `接入\01` §2.4 那张表一致）：
 *       GET  /            → 服务说明（给对接方看的）
 *       GET  /health      → 健康检查
 *       GET  /api/tools   → 工具清单（stdio 口当代理时取它；与 bridge.listTools 同一份）
 *       POST /api/call    → 统一工具调用 { memberId, tool, args }（动作/发消息都走这）
 *       POST /api/message → 快捷发消息 { memberId, envelope }（等价 send_message）
 *       GET  /api/alive?memberId= → 那条一直挂着的连接（SSE）＝"它连着"的凭据
 *       GET  /api/members?byMemberId= → 可派发名单
 *   - ⛔ `GET /api/inbox` 2026-10-04 删掉（老大令「不要留，不要这个功能」）：没有"收件箱"这一层。
 *   - 请求体 JSON（UTF-8）；响应 JSON；错误带 HTTP 状态码 + {ok:false, error, notify}。
 *
 * 约束：零第三方依赖；不改 M1~M7 的代码与接口。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULT_PORT = 8787;

/**
 * ⭐ 2026-10-05 加：三个**不经准入校验**的读口（`/health`、`/api/tools`、`/api/state`）各带这一句。
 * ⚠️ 为什么是"固定文案"：这三个口**认不出**"这次是不是直连"（没有身份可查）⇒ 它相当于把禁令
 *    **贴在门上**，不是"抓到谁训一句"。真"抓"在门那边（拒绝时回的 `notify`）。
 * 正本＝规范 `接入\01-接入与连接.md` §2.4。
 */
const PLAIN_NOTICE = '成员一律通过「接入插件」连进来，不要直连。还没连上就先在插件面板点「连接」；'
  + '详见项目根 README 第一屏。';

/** 读取请求体（JSON） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    // ⭐ 2026-10-05 修（代码审查低风险那条）：超限之后**不再累加** —— 原来 `reject` 了还在 `raw += c`，
    //    要等 `req.destroy()` 生效才停 ⇒ 内存峰值会超过那个 2MB 界限；顺带也不让 `end` 再 resolve 一次。
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      raw += c;
      if (raw.length > 2 * 1024 * 1024) {
        tooBig = true;
        raw = '';
        try { req.destroy(); } catch (_) {}
        reject(new Error('请求体过大（>2MB）'));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * 造一个 HTTP server
 * @param {object} deps
 *   bridge: { invokeTool(memberId, tool, args), getInbox(memberId, opts), listTools() }
 *   logger: M7 日志（可选）
 * @param {number} [port] 默认 8787（0 = 随机端口，自验用）
 * @returns {{name:'http', server, port, url}}
 */
function createHttpServer(deps, port) {
  const bridge = deps && deps.bridge;
  const logger = (deps && deps.logger) || null;

  if (!bridge || typeof bridge.invokeTool !== 'function') {
    throw new Error('http-api 需要 bridge（含 invokeTool）');
  }

  function json(res, status, obj) {
    const body = JSON.stringify(obj);
    const head = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    };
    // ⭐ 2026-10-05 改（CORS 收紧）：**不再无条件 `*`** —— 只对"本机 file:// 界面"回 CORS 头
    //    （它的 Origin 是字面量 `null`）；带真实 Origin 的网页在请求入口就被 403 了。
    //    依据：CodeBuddy HTTP API 那条实测教训 —— "回环来源不再被无条件放行"，否则**用户浏览器里
    //    任何一个占用本地端口的页面**都能跨源调本服务（Cookie 的 SameSite 也防不住：端口不属于 site）。
    //    ⚠️ 界面是 `file://` 加载 ⇒ **不能换成白名单**（那会让界面当场全挂）。
    if (res.__cors) {
      head['Access-Control-Allow-Origin'] = res.__cors;
      head['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
      head['Access-Control-Allow-Headers'] = 'Content-Type, X-Office-UI';
    }
    res.writeHead(status, head);
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = u.pathname;
    const method = req.method || 'GET';

    // ⭐ 2026-10-05 加（CORS 收紧）：**只有两种来源进得来** ——
    //    ① **不带 `Origin`** 的：接入端（node／curl／脚本）与一切非浏览器调用；
    //    ② **`Origin: null`** 的：本机 `file://` 加载的界面（WebView2）。
    //    ⚠️ 带**真实 Origin** 的（任何网页，含占着别的本地端口的页面）**一律 403** ——
    //      这正是 CodeBuddy 那条实测教训要挡的："用户浏览器里任何占用本地端口的页面"跨源调本机服务。
    // ⭐ 2026-10-06 加**第三种**：`http://127.0.0.1:<本服务端口>` —— 即"**本服务自己发出去的那个页面**"
    //    （`GET /ui`）。为什么必须放它进来：页面由后端自己发 ⇒ 页面调接口时浏览器会带
    //    `Origin: http://127.0.0.1:<端口>`（**同源请求也带 Origin**，2026-10-06 实测：
    //    连这条源都被 403 挡住，④ 那条读数就是它）。
    //    ⚠️ 放开这条**不降低安全性**：`Origin` 由浏览器设置、网页**伪造不了** —— 只有真从那个地址
    //      加载的页面才有它；别的页面（哪怕是本机另一个端口上的页面）仍是"别的源"，照旧被拒。
    //      "非浏览器"则本来就归 ① 那一档，等于没多开口子。
    const origin = req.headers.origin;
    const selfAddr = server.address();
    const selfOrigin = `http://127.0.0.1:${(selfAddr && selfAddr.port) || DEFAULT_PORT}`;
    if (origin !== undefined && origin !== 'null' && origin !== selfOrigin) {
      return json(res, 403, {
        ok: false,
        error: '跨源请求被拒：只接受本机界面（file:// 或本服务自己发的页面）与不带 Origin 的接入端',
      });
    }
    if (origin === 'null' || origin === selfOrigin) res.__cors = origin;   // ⭐ 本机界面拿得到 CORS 头

    // CORS 预检（浏览器 file:// 页面 fetch 前会发 OPTIONS）—— 能走到这里说明来源已合法
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': res.__cors || 'null',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Office-UI',
        'Content-Length': '0',
      });
      return res.end();
    }

    try {
      // GET / → 服务说明（README 同款，给对接方一眼看明白）
      if (method === 'GET' && pathname === '/') {
        return json(res, 200, {
          service: 'office-bridge HTTP 口（M8 对外接口）',
          endpoints: [
            'GET  /health',
            'GET  /api/tools',
            'GET  /api/alive?memberId=    ← 接入端挂这条连接＝「它连着」（SSE，一直挂着不关）',
            'POST /api/call        { memberId, tool, args }',
            'POST /api/message     { memberId, envelope }',
            'GET  /api/members?byMemberId=',
          ],
          tools: bridge.listTools ? bridge.listTools().map((t) => t.name) : undefined,
          note: '工具名不带点号；动作（报到/上线/查成员/refuse/over 等）走工具调用，内容消息走 send_message。⛔ 没有 /api/inbox（收件箱 2026-10-04 删）',
        });
      }

      // ⭐ 2026-10-06 加：**界面由后端自己发**（GET /ui）—— 老大令「别用脚本、就用后端…写进代码里面」。
      //    好处：① 界面**只有一份**（不用再"改副本 → 搬回正本"）；② 口令**直接注入页面**
      //    （`window.__OFFICE_UI_TOKEN__`）⇒ 不进地址栏、不进浏览器历史；③ 壳的窗口与浏览器
      //    打开的是**同一个地址**，两边永远一致。
      //    ⚠️ 不动 `GET /`（那是给对接方看的服务说明，约定别破）。
      if (method === 'GET' && (pathname === '/ui' || pathname === '/ui/')) {
        const uiFile = path.join(__dirname, '..', '界面', '办公室界面-20261003.html');
        let html;
        try {
          html = fs.readFileSync(uiFile, 'utf8');
        } catch (e) {
          return json(res, 500, { ok: false, error: '界面文件读不到：' + String((e && e.message) || e) });
        }
        // 注入口令。⚠️ 后端手里没口令（不经壳、手工起的）⇒ 注入空串 ⇒ 页面不带 `X-Office-UI`
        //    ⇒ 后端那边"没口令就放行"（同一套退化口径，两边自洽）。
        const uiTok = String(process.env.OFFICE_UI_TOKEN || '');
        html = html.replace('</head>',
          '<script>window.__OFFICE_UI_TOKEN__=' + JSON.stringify(uiTok) + ';</script>\n</head>');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      // GET /health → 健康检查
      if (method === 'GET' && pathname === '/health') {
        return json(res, 200, { ok: true, service: 'office-bridge', time: new Date().toISOString(), notice: PLAIN_NOTICE });
      }

      // GET /api/tools → 工具清单（给 stdio 口当代理用；与 bridge.listTools 同一份，不是两套）
      if (method === 'GET' && pathname === '/api/tools') {
        const tools = bridge.listTools ? bridge.listTools() : [];
        return json(res, 200, { ok: true, count: tools.length, tools, notice: PLAIN_NOTICE });
      }

      // GET /api/state → 后端运行态（只读）。2026-10-04 加：`/health` 只回"活不活"，状态另给一条。
      // ⚠️ ⭐ **这条端点不经「没连着就不许调工具」那道门** —— 它只是**读**，而且界面要靠它
      //    显示「调试模式开着没」（`04-功能清单` §7.7 第 4 条那条醒目标记）。
      if (method === 'GET' && pathname === '/api/state') {
        const st = bridge.getState ? bridge.getState() : null;
        return json(res, 200, { ok: true, state: st, notice: PLAIN_NOTICE });
      }

      // GET /api/alive → 接入端挂一条连接（SSE 流）＝「它连着」（2026-10-03：心跳＝看连接）
      // 依据：老大 2026-10-03 令「不要让 mcp 自己报，变成系统去看 mcp 有没有连着，十秒同时看一次」
      // 用法：接入端起来就 GET 这条并一直挂着；后端每 1 秒往每条连接写一下，写不进去＝它掉了。
      // ⚠️ 这里不 end()：连接要一直挂着，直到接入端自己断或后端发现写不进去。
      if (method === 'GET' && pathname === '/api/alive') {
        const memberId = u.searchParams.get('memberId') || '';
        if (!bridge.attachAlive || !bridge.detachAlive) {
          return json(res, 500, { ok: false, error: '这台后端没有接入连接表（attachAlive/detachAlive）' });
        }
        const aliveHead = {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        };
        // ⭐ 2026-10-05 同 CORS 收紧：这条 SSE 也只在 file:// 界面（Origin: null）时回 CORS 头
        if (res.__cors) aliveHead['Access-Control-Allow-Origin'] = res.__cors;
        res.writeHead(200, aliveHead);
        res.write(': connected\n\n');
        // ⭐⭐ 接入手续（2026-10-05）：接入端在 `X-Office-Card` 里报它那四格 —— base64(JSON)。
        //    ⚠️ 解不开**不让它断连接**，只标成"带坏了"（现阶段只记录、不拦，绝不能因为一个坏头挡住正常接入）。
        //    正本＝规范 `接入\01` §2.4。
        let card;
        const rawHead = req.headers['x-office-card'];
        if (rawHead) {
          try {
            card = JSON.parse(Buffer.from(String(rawHead), 'base64').toString('utf8'));
          } catch (e) {
            card = { __bad: true, __reason: '解不开：' + String((e && e.message) || e) };
          }
        }
        const conn = bridge.attachAlive(memberId, res, card);
        req.on('close', () => bridge.detachAlive(conn));
        return;
      }

      // POST /api/call → 统一工具调用
      if (method === 'POST' && pathname === '/api/call') {
        const body = await readBody(req);
        const memberId = body.memberId;
        const tool = body.tool;
        const args = body.args || {};
        if (!memberId) return json(res, 400, { ok: false, error: '缺 memberId（谁在调）' });
        if (!tool) return json(res, 400, { ok: false, error: '缺 tool（工具名，不带点号）' });
        // ⭐ 2026-10-05：把**界面口令**透下去 —— `boss` 的调用要靠它自证"我是界面"（`接入\01` §2.4）
        const r = await bridge.invokeTool(memberId, tool, args, { uiToken: req.headers['x-office-ui'] });
        return r.ok ? json(res, 200, r) : json(res, 400, r);
      }

      // POST /api/message → 快捷发消息（等价 send_message）
      if (method === 'POST' && pathname === '/api/message') {
        const body = await readBody(req);
        const memberId = body.memberId;
        const envelope = body.envelope;
        if (!memberId) return json(res, 400, { ok: false, error: '缺 memberId（谁在发）' });
        if (!envelope) return json(res, 400, { ok: false, error: '缺 envelope（01 §2 信封）' });
        // ⭐ 2026-10-05：同样透口令 —— 这条快捷口也以 `boss` 身份发（`接入\01` §2.4）
        const r = await bridge.invokeTool(memberId, 'send_message', { memberId, envelope }, { uiToken: req.headers['x-office-ui'] });
        return r.ok ? json(res, 200, r) : json(res, 400, r);
      }

      // ⛔ GET /api/inbox 2026-10-04 删掉（`接入\03` §4-1）：没有"收件箱"这一层 —— 消息一律实时送。

      // GET /api/members → 可派发名单
      if (method === 'GET' && pathname === '/api/members') {
        const byMemberId = u.searchParams.get('byMemberId') || '';
        // ⭐ 2026-10-05：同透口令 —— 没带 `byMemberId` 时这里默认就是 `boss`（`接入\01` §2.4）
        const r = await bridge.invokeTool(byMemberId || 'boss', 'list_members', { byMemberId }, { uiToken: req.headers['x-office-ui'] });
        return r.ok ? json(res, 200, r) : json(res, 400, r);
      }

      return json(res, 404, { ok: false, error: `无此端点: ${method} ${pathname}` });
    } catch (e) {
      if (logger && typeof logger.logEvent === 'function') {
        try { logger.logEvent({ type: 'reject', who: 'http', why: `HTTP 请求处理失败: ${String((e && e.message) || e)}` }); } catch (_) {}
      }
      return json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  });

  const p = port === undefined ? DEFAULT_PORT : port;
  // ⭐ 2026-10-05 改：**显式绑回环 127.0.0.1**。
  //    原来只写 `server.listen(p)`（不指定地址）⇒ Node 监听**所有网络接口**
  //    （2026-10-05 本地实测：`netstat` 显示 `0.0.0.0:8787` ＋ `[::]:8787` ⇒ **局域网可达**）。
  //    依据：规范 `状态\01-连接与在岗.md` 的设计前提就写着「**都在本机**（`127.0.0.1`），
  //    中间**没有 NAT／防火墙**」⇒ 这行是把**实现对齐规范**。
  //    ⚠️ 将来若要从别的机器接入成员，得**同时**改这里与规范那条前提，别只改一处。
  server.listen(p, '127.0.0.1');

  // ⭐⭐ 2026-10-05 修（原 A11 那条）：**`listen(p, host)` 之后这一刻还读不到端口**。
  //   实测（`临时\port0-复现.cjs`）：`listen(p)` **不带 host** 时**同步**就绑好了、`address()` 立刻有值；
  //   一旦**指定 host**（就是上面这行）绑定转成**异步** ⇒ 这里立刻读是 `null` ⇒ 只能落回 `p`。
  //   ⇒ 传固定端口时 `p` 恰好＝真端口，**碰巧对**（生产路径一直没事）；
  //     传 `0`（随机端口）时 `p`＝`0` ⇒ `url` 变成 `http://127.0.0.1:0` ⇒ 调用方全部空打
  //     （2026-10-05 实测：咬掉 M8／M10 两份验收）。
  //   ⇒ 修法：**同步、异步两条路都给** ——
  //     · `port`／`url`：立刻可用，**传固定端口时是对的**（老调用方一行都不用改）；
  //     · `ready`：Promise，`listening` 之后把 `port`／`url` **就地补正**成真值；
  //       传 `0` 的调用方 `await http.ready` 之后再读 `url` 即可。
  //   ⚠️ 故意不监听 `error`：listen 失败时让未捕获异常照旧抛出（别被这个 Promise 吞掉）。
  const info = { name: 'http', server, port: p, url: `http://127.0.0.1:${p}` };
  const fixUp = () => {
    const a = server.address();
    if (a && a.port) { info.port = a.port; info.url = `http://127.0.0.1:${a.port}`; }
  };
  info.ready = new Promise((resolve) => {
    if (server.address()) { fixUp(); resolve(info); return; }
    server.once('listening', () => { fixUp(); resolve(info); });
  });

  return info;
}

module.exports = { createHttpServer, DEFAULT_PORT };

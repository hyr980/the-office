/**
 * codex-office 自测：用「假办公室 ＋ 假 Codex 宿主」跑通插件层。
 *
 * 不碰真办公室、不碰真 Codex 会话。退出码 0 ＝ 全部过。
 * 内核自己的完整自测在 kernel-self-check.mjs。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createOfficePlugin, handleMcpMessage } from '../lib/index.mjs';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? '过' : '不过'}  ${name}${detail !== undefined ? `  —— ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-office-selfcheck-'));

const office = {
  aliveCount: 0,
  aliveClosed: 0,
  calls: [],
  members: [
    { id: 'codex', presence: 'online', offlineReason: '' },
    { id: 'other', presence: 'online', offlineReason: '' },
  ],
};
let aliveRes = null;

const fakeOffice = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/api/alive') {
    office.aliveCount += 1;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(': alive\n');
    aliveRes = res;
    req.on('close', () => { office.aliveClosed += 1; });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/tools') {
    return json(res, {
      tools: [
        { name: 'get_member', description: '查一张卡', inputSchema: { type: 'object', properties: { memberId: { type: 'string' } } } },
        { name: 'read_messages', description: '读账本', inputSchema: { type: 'object', properties: {} } },
        { name: 'presence', description: '上线/下线', inputSchema: { type: 'object', properties: { presence: { type: 'string' } } } },
      ],
    });
  }
  if (req.method === 'POST' && (url.pathname === '/api/call' || url.pathname === '/api/message')) {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* 保持空对象 */ }
    if (url.pathname === '/api/message') office.calls.push({ tool: 'send_message', args: body.envelope });
    else office.calls.push(body);
    if (body.tool === 'register') {
      return json(res, {
        ok: true,
        data: {
          card: {
            id: body.args.memberId,
            joined: '2026-10-06T16:00:00+08:00',
            name: body.args.name || '',
            icon: body.args.icon || '',
          },
        },
      });
    }
    if (body.tool === 'get_members') return json(res, { ok: true, data: { members: office.members } });
    return json(res, { ok: true, data: {} });
  }
  return json(res, { ok: false, error: '没有这个端点' }, 404);
});
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function push(hostPort, p, body) {
  const res = await fetch(`http://${hostPort}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  return await res.json().catch(() => null);
}

await new Promise((r) => fakeOffice.listen(0, '127.0.0.1', r));
const officePort = fakeOffice.address().port;

const queueCalls = [];
const steerCalls = [];
const fakeHost = {
  codexBin: '<fake-codex>',
  codexHome: DATA,
  async queue(threadId, text) { queueCalls.push({ threadId, text }); return { ok: true }; },
  async steer(threadId, text) { steerCalls.push({ threadId, text }); return { ok: true }; },
  stop() {},
};

const plugin = createOfficePlugin({
  env: {
    ...process.env,
    OFFICE_BASE_URL: `http://127.0.0.1:${officePort}`,
    OFFICE_MEMBER_ID: 'codex',
    OFFICE_HOST_NAME: 'Codex',
    OFFICE_MODEL: 'codex-test',
    OFFICE_STATE_DIR: DATA,
    OFFICE_PORT: '0',
    CODEX_HOME: DATA,
  },
  host: fakeHost,
  log: () => {},
  warn: () => {},
});

let msgId = 0;
async function mcp(method, params = {}) {
  const id = ++msgId;
  const res = await handleMcpMessage({ jsonrpc: '2.0', id, method, params }, plugin);
  if (res && res.error) throw new Error(JSON.stringify(res.error));
  return res && res.result;
}
async function tool(name, args = {}, threadId = 'thread-1') {
  const r = await mcp('tools/call', { name, arguments: args, _meta: { threadId, progressToken: 1 } });
  const text = r && r.content && r.content[0] && r.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}

// ① 起内核反向端点，不自动连
await plugin.start();
const hostPort = plugin.bridgeRef.status().hostPort;
check('① 起反向端点，不自动连办公室', office.aliveCount === 0, `alive=${office.aliveCount}`);
check('① 门牌号形状正确', /^127\.0\.0\.1:\d+$/.test(hostPort), hostPort);

// ② MCP 初始化与工具表
const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selfcheck', version: '1' } });
check('② MCP 协议版本按请求回 2025-06-18', init && init.protocolVersion === '2025-06-18', init && init.protocolVersion);
const tools = await mcp('tools/list', {});
const names = (tools && tools.tools || []).map((t) => t.name);
check('② 有第一层控制工具 office_ui_connection', names.includes('office_ui_connection'));
check('② 有第二层控制工具 office_ui_presence', names.includes('office_ui_presence'));
check('② 办公室工具已动态暴露（office_get_member）', names.includes('office_get_member'), names.join(','));

let st = await tool('office_status');
check('② 初始状态：未连接、未绑定', st.connected === false && st.binding === 'unbound', JSON.stringify({ connected: st.connected, binding: st.binding }));

// ③ 第一层：连接
let c = await tool('office_ui_connection', { action: 'connect' });
await sleep(150);
check('③ 连接挂上了', c.ok === true && c.connected === true, JSON.stringify(c));
check('③ 假办公室看到 SSE 连接', office.aliveCount === 1, `alive=${office.aliveCount}`);
check('③ 连接不自动上线', !office.calls.some((x) => x.tool === 'presence' && x.args && x.args.presence === 'online'));

// ④ 第二层：上线，绑定 _meta.threadId
const on = await tool('office_ui_presence', { action: 'online', nick: '小码' }, 'thread-1');
await sleep(100);
check('④ 上线成功并绑 thread-1', on.ok === true && on.sessionId === 'thread-1', JSON.stringify(on));
check('④ 办公室收到 register，带宿主名/门牌号', office.calls.some((x) => x.tool === 'register' && x.args.name === 'Codex' && x.args.host), JSON.stringify(office.calls.find((x) => x.tool === 'register')));
check('④ 办公室收到 presence online', office.calls.some((x) => x.tool === 'presence' && x.args.presence === 'online'));
st = await tool('office_status', {}, 'thread-1');
check('④ 当前页就是绑定会话 => bound-here', st.binding === 'bound-here', st.binding);
st = await tool('office_status', {}, 'thread-2');
check('④ 当前页不是绑定会话 => bound-elsewhere', st.binding === 'bound-elsewhere', st.binding);

// ⑤ 办公室反向推 wake：只送命令，不送正文
const q0 = queueCalls.length;
const w = await push(hostPort, '/dsh-office/wake', { memberId: 'codex', reason: 'message', msgId: 'm1', seq: 1 });
await sleep(100);
const wakeCall = queueCalls.slice(q0).find((x) => /有人找你/.test(x.text));
check('⑤ wake 回 ok', !!(w && w.ok), JSON.stringify(w));
check('⑤ wake 送到绑定的 thread-1，且不提正文', !!wakeCall && wakeCall.threadId === 'thread-1' && !/正文/.test(wakeCall.text), wakeCall && wakeCall.text.split('\n')[0]);

// ⑥ interrupt：原样插「时间到了，请停」
const i = await push(hostPort, '/dsh-office/interrupt', { memberId: 'codex', text: '时间到了，请停' });
await sleep(50);
check('⑥ interrupt 回 ok', !!(i && i.ok), JSON.stringify(i));
check('⑥ 插话原文送到绑定会话', steerCalls.some((x) => x.threadId === 'thread-1' && x.text === '时间到了，请停'));

// ⑦ challenge 算式
const nonce = 'nonce-' + Date.now();
const ch = await push(hostPort, '/dsh-office/challenge', { memberId: 'codex', nonce });
const want = crypto.createHash('sha256').update(`codex/${nonce}`, 'utf8').digest('hex');
check('⑦ challenge 算式答对', !!(ch && ch.ok) && ch.answer === want);

// ⑧ 下线：报离线，但不清绑定
const off = await tool('office_ui_presence', { action: 'offline' }, 'thread-1');
await sleep(50);
check('⑧ 下线调用成功', off && off.ok !== false, JSON.stringify(off));
check('⑧ 办公室收到 presence offline', office.calls.some((x) => x.tool === 'presence' && x.args.presence === 'offline'));
st = await tool('office_status', {}, 'thread-1');
check('⑧ 下线不清绑定，叫它上线还叫得到', st.boundSessionId === 'thread-1', st.boundSessionId);

// ⑨ 断开：不自动重连
const aliveBefore = office.aliveCount;
const d = await tool('office_ui_connection', { action: 'disconnect' });
await sleep(500);
check('⑨ 断开成功', d && d.ok === true && d.connected === false, JSON.stringify(d));
check('⑨ 断了不自行重挂', office.aliveCount === aliveBefore, `${aliveBefore} → ${office.aliveCount}`);

await plugin.stop();
if (aliveRes) { try { aliveRes.end(); } catch { /* 已经断了 */ } }
await new Promise((r) => fakeOffice.close(r));
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录清不掉也不影响判据 */ }

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n合计：过 ${pass} ／ 不过 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
'use strict';

/**
 * M8 · stdio 口用的 HTTP 客户端 —— 「只连不建」
 *
 * 依据：
 *   - 规范\08-落地结构.md §四 多口接入（⭐ 开灯只有一个动作；口只是通道，不是第二间办公室）
 *   - 规范\08-落地结构.md §二 第 46 行（办公室没开 ⇒ 报「办公室没开」）
 *
 * 为什么要有这个文件（2026-10-03 验收 M8 记的实测缺口）：
 *   原来 mcp-stdio.js 的主入口是 `require('./bridge')` —— 每起一个 stdio 进程就自己建一套桥，于是：
 *     ① 会话映射是各进程的内存态 ⇒ 跨口叫醒不通（delivered:[] + silent:[{reason:"无会话…"}]）
 *     ② 办公室关着（/health 不通）也能"报到"、能发消息
 *     ③ 与壳起的后端同写一份 `数据\`
 *   改法：stdio 口只当代理，工具调用一律转发给本机已经在跑的后端（HTTP 口，默认 8787）。
 *
 * 约束：零第三方依赖（用 node 内置 fetch）；连不上时不往上抛，回「办公室没开」。
 */

const DEFAULT_BASE = 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 10000;
/** 关闭口径（规范 08-落地结构.md:46 原文） */
const OFFICE_CLOSED = '办公室没开';

/**
 * 造一个 HTTP 客户端
 * @param {object} [opts]
 *   baseUrl: 后端地址（默认 env OFFICE_URL，再默认 http://127.0.0.1:8787）
 *   timeoutMs: 单请求超时（默认 10 秒）
 * @returns {{baseUrl:string, invokeTool(memberId,tool,args):Promise, listTools():Promise}}
 */
function createHttpClient(opts) {
  const base = String((opts && opts.baseUrl) || process.env.OFFICE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;

  /** 发一条请求，返回解析后的 JSON；连不上/超时/非 JSON 一律抛 */
  async function request(method, path, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(base + path, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    baseUrl: base,

    /**
     * 调一个工具 —— 转发给后端（全系统唯一的入口）。
     * 连不上/超时 ⇒ 回 {ok:false, error:'办公室没开', notify:'办公室没开（…）'}，不抛。
     */
    async invokeTool(memberId, tool, args) {
      try {
        const r = await request('POST', '/api/call', { memberId, tool, args });
        if (r && typeof r.ok === 'boolean') return r;
        return {
          ok: false,
          error: '后端回了看不懂的应答',
          notify: '后端回的应答里没有 ok 字段（不是 {ok:…}）',
        };
      } catch (e) {
        const why = String((e && e.message) || e);
        return { ok: false, error: OFFICE_CLOSED, notify: `${OFFICE_CLOSED}（连不上 ${base}：${why}）` };
      }
    },

    /** 取工具清单 —— 连不上 ⇒ 抛（tools/list 本来就有错误通道） */
    async listTools() {
      try {
        const r = await request('GET', '/api/tools');
        if (r && r.ok && Array.isArray(r.tools)) return r.tools;
        throw new Error('后端没回工具清单（应答里没有 tools 数组）');
      } catch (e) {
        throw new Error(`${OFFICE_CLOSED}：${String((e && e.message) || e)}`);
      }
    },
  };
}

module.exports = { createHttpClient, OFFICE_CLOSED, DEFAULT_BASE };

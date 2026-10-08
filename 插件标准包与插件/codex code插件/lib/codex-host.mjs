/**
 * codex-host —— 「Codex 宿主 ↔ 插件」适配层（办公室协议不在这里）。
 *
 * 依据：插件标准包《插件怎么写.md》§0、§4：
 *   · wake 必须让 Codex 当轮看得见；
 *   · interrupt 必须把「时间到了，请停」插进那个会话；
 *   · 怎么调由宿主自己实现，本层只暴露 queue/steer 两个动作。
 *
 * 本机 Codex 0.160.0 的实测落点：
 *   · `codex queue --thread <id> --message <text>`：把一条输入交给运行中的会话。
 *     它走 app-server 的 `thread/queue/add`；是排队还是立即接手，由该线程的
 *     `[desktop] followUpQueueMode` 决定。办公室要满足「插话」时，把 Codex
 *     配成 `followUpQueueMode = "steer"`。
 *   · app-server 协议另有 `turn/steer`（本机 schema 已核实），但需要直连运行中
 *     的 daemon。当前稳定 CLI 入口是 `codex queue`，本插件用它，避免另开一个
 *     app-server 去抢同一个线程。
 *
 * 这个文件**不碰办公室 HTTP**，只负责找到 codex、把话递进会话、把错误说清楚。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const CODEX_EXE = isWindows ? 'codex.exe' : 'codex';

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** 在插件允许的目录里找一个可执行文件；只用于 CODEX_MANAGED_PACKAGE_ROOT 下的包。 */
function searchFile(root, fileName, maxDepth = 8) {
  if (!root || !fs.existsSync(root)) return null;
  const queue = [{ dir: root, depth: 0 }];
  let inspected = 0;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      inspected += 1;
      if (inspected > 20000) return null;
      const full = path.join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase() === fileName.toLowerCase()) return full;
      if (!ent.isDirectory()) continue;
      // 这些目录要么太大，要么与 Codex 可执行文件无关。
      if (ent.name === '.git' || ent.name === 'sessions' || ent.name === 'cache' || ent.name === 'tmp') continue;
      queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

/** 找 codex 可执行文件：环境变量 → managed package → PATH → cwd 回退。 */
export function findCodexBin(env = process.env) {
  const candidates = [];
  for (const key of ['OFFICE_CODEX_BIN', 'CODEX_CLI_PATH', 'CODEX_BIN']) {
    const v = env && env[key];
    if (v && isFile(v)) candidates.push(path.resolve(v));
  }
  const root = env && env.CODEX_MANAGED_PACKAGE_ROOT;
  if (root && fs.existsSync(root)) {
    const found = searchFile(root, CODEX_EXE, 8);
    if (found) candidates.push(found);
  }
  const codexHome = (env && env.CODEX_HOME) || path.join(os.homedir(), '.codex');
  const homeBin = path.join(codexHome, 'bin', CODEX_EXE);
  if (isFile(homeBin)) candidates.push(homeBin);

  const where = isWindows ? 'where.exe' : 'which';
  try {
    const r = spawnSync(where, ['codex'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r && r.status === 0) {
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const p = line.trim();
        if (p && isFile(p)) candidates.push(p);
      }
    }
  } catch { /* 找不到就走回退名 */ }

  const seen = new Set();
  for (const c of candidates) {
    const key = isWindows ? c.toLowerCase() : c;
    if (!seen.has(key)) return c;
  }
  return CODEX_EXE;
}

/**
 * 建一个 Codex 宿主通道。
 * @param {object} [options]
 * @param {string} [options.codexBin] 明确指定 codex 可执行文件。
 * @param {string} [options.codexHome] 指定 CODEX_HOME。
 * @param {Function} [options.spawnImpl] 测试注入；默认 child_process.spawn。
 */
export function createCodexHost(options = {}) {
  const env = options.env || process.env;
  const spawnImpl = options.spawnImpl || spawn;
  const codexHome = options.codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexBin = options.codexBin || findCodexBin(env);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 20000;
  const log = typeof options.log === 'function' ? options.log : (...a) => console.error('[office]', ...a);
  const warn = typeof options.warn === 'function' ? options.warn : (...a) => console.error('[office]', ...a);

  const childEnv = { ...process.env, ...env, CODEX_HOME: codexHome };
  const children = new Set();

  function runCli(args) {
    return new Promise((resolve) => {
      let child;
      let done = false;
      let stdout = '';
      let stderr = '';
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (child) children.delete(child);
        resolve(value);
      };
      try {
        child = spawnImpl(codexBin, args, {
          env: childEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return finish({ ok: false, error: String((e && e.message) || e), codexBin, args });
      }
      if (!child || typeof child.on !== 'function') {
        return finish({ ok: false, error: 'spawn 没有返回子进程', codexBin, args });
      }
      children.add(child);
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (c) => { stdout += String(c); });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (c) => { stderr += String(c); });
      }
      child.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e), codexBin, args, stdout, stderr }));
      child.on('close', (code, signal) => finish({ ok: code === 0, code, signal, codexBin, args, stdout, stderr }));
      timer = setTimeout(() => {
        try { if (child && typeof child.kill === 'function') child.kill(); } catch { /* 已经退出 */ }
        finish({ ok: false, error: `codex 命令超时（${timeoutMs}ms）`, codexBin, args, stdout, stderr });
      }, timeoutMs);
    });
  }

  /** 叫醒：把「进来看」这条命令排/插进绑定的那个会话。只送命令，不送正文。 */
  async function queue(threadId, text) {
    const sid = String(threadId || '');
    if (!sid) return { ok: false, error: '没有绑定的会话 id，叫不醒' };
    const args = ['queue'];
    if (env.OFFICE_CODEX_REMOTE) args.push('--remote', String(env.OFFICE_CODEX_REMOTE));
    args.push('--thread', sid, '--message', String(text));
    const r = await runCli(args);
    if (!r.ok) warn('叫醒失败：', r.error || r.stderr || `exit ${r.code}`);
    return r;
  }

  /** 插话：Codex 的 CLI 跟随会话的 followUpQueueMode；要「立即接手」就配 steer。 */
  async function steer(threadId, text) {
    const r = await queue(threadId, text);
    return { ...r, mode: 'host-follow-up' };
  }

  /** 收摊：杀掉本层开出去的 codex 子进程。 */
  function stop() {
    for (const child of children) {
      try { if (child && typeof child.kill === 'function') child.kill(); } catch { /* 已经退出 */ }
    }
    children.clear();
  }

  return {
    codexBin,
    codexHome,
    queue,
    steer,
    stop,
    version: () => runCli(['--version']),
  };
}
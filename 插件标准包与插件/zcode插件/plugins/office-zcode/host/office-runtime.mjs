/**
 * office-runtime —— 找到常驻进程、跟它的控制口说话（hook 与 MCP 服务器共用）
 *
 * 常驻进程起来后会把 `{pid, ctlPort, hostPort, at}` 写进数据目录的 `office-runtime.json`，
 * 这里负责：读它、ping 控制口、不在时把它拉起来（hook 的 SessionStart 用）。
 *
 * ⚠️ 拉起来的进程是 detached 的：hook 自己退了它也活着 —— 它就是要"常驻"的那一个。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeFile } from './office-config.mjs';

const HOST_JS = fileURLToPath(new URL('./office-host.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读运行时指针；形状不对就当没有。 */
export function readRuntime(cfg) {
  try {
    const o = JSON.parse(fs.readFileSync(runtimeFile(cfg), 'utf8'));
    if (o && Number.isInteger(o.ctlPort) && o.ctlPort > 0 && typeof o.hostPort === 'string') return o;
  } catch { /* 没有就当没有 */ }
  return null;
}

/** 那个 pid 还活着吗（pid 0 探测；Windows 下 Node 支持）。 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 打一次控制口。`path` 形如 '/ctl/state'；body 可省。 */
export async function callCtl(cfg, p, body = {}, timeoutMs = 2500) {
  const rt = readRuntime(cfg);
  if (!rt) return { ok: false, error: '数据目录里没有运行时指针（常驻进程从没起来过）' };
  try {
    const res = await fetch(`http://127.0.0.1:${rt.ctlPort}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok && !!data, data, status: res.status };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 控制口通不通（能通 ＝ 常驻进程活着）。 */
export async function pingCtl(cfg, timeoutMs = 1200) {
  const r = await callCtl(cfg, '/ctl/ping', {}, timeoutMs);
  return r.ok;
}

/**
 * 确保常驻进程在跑：先 ping；不通再看指针里的 pid（活着就再等一拍 —— 可能在忙），
 * 还不通就把它拉起来，然后等控制口应答为止。
 * @returns {Promise<{ok:boolean, ctlPort?:number, reason?:string}>}
 */
export async function ensureHost(cfg, { spawnWaitMs = 8000 } = {}) {
  if (await pingCtl(cfg)) return { ok: true };

  const rt = readRuntime(cfg);
  if (rt && rt.pid !== process.pid && pidAlive(rt.pid)) {
    // pid 还在但 ping 不通：给它一拍（可能正在起），再不行就认栽 —— 不去动别人的进程
    for (let i = 0; i < 5; i += 1) {
      await sleep(300);
      if (await pingCtl(cfg)) return { ok: true, ctlPort: readRuntime(cfg)?.ctlPort };
    }
    return { ok: false, reason: `常驻进程 (pid ${rt.pid}) 在但不应答` };
  }

  try {
    const child = spawn(cfg.nodePath, [HOST_JS], {
      cwd: path.dirname(HOST_JS),
      env: { ...process.env, OFFICE_HOST_CONFIG: JSON.stringify(cfg) },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.on('error', () => { /* 起不来就靠下面的超时判负 */ });
  } catch (e) {
    return { ok: false, reason: '拉起常驻进程失败：' + String((e && e.message) || e) };
  }

  const t0 = Date.now();
  while (Date.now() - t0 < spawnWaitMs) {
    await sleep(200);
    if (await pingCtl(cfg, 800)) return { ok: true, ctlPort: readRuntime(cfg)?.ctlPort };
  }
  return { ok: false, reason: `常驻进程 ${Math.round(spawnWaitMs / 1000)} 秒内没起来（node 在不在 PATH？见 README）` };
}

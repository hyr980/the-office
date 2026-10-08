/**
 * session-start —— ZCode hook（SessionStart ＋ UserPromptSubmit 共用这一个脚本）
 *
 * 干两件事（《任务说明》第三节第 5 条：hook 的输入里有 session_id ⇒ 用它把"当前会话"落给常驻进程）：
 *   ① SessionStart：确保常驻进程（host/office-host.mjs）在跑，不在就拉起（detached）；
 *   ② 把本次事件的 `session_id` 报给常驻进程的控制口（/ctl/session）——
 *      ⚠️ 这只是让它**知道**"最近的会话是哪个"，**不是绑定**；绑定归人（/office-online）。
 *
 * ⚠️ hook 的 stdout 会被 ZCode 按**严格 schema** 当 JSON 解析（多余字段就算错）⇒
 *    本脚本**一个字都不往 stdout 写**；成败也一律退出码 0 —— 办公室接不上不该连累会话启动。
 * ⚠️ UserPromptSubmit 是**内联**跑的：控制口 ping 不通就立刻退，不为它拉进程（别拖慢每条输入）。
 */

import { loadConfig } from '../host/office-config.mjs';
import { callCtl, ensureHost, pingCtl } from '../host/office-runtime.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读 stdin（ZCode 会在事件载荷写完后关掉它）；带 5 秒保险，读不到就当空。 */
async function readStdin() {
  const chunks = [];
  const t = setTimeout(() => process.exit(0), 5000);
  try {
    for await (const c of process.stdin) chunks.push(c);
  } catch { /* 读不动就算了 */ }
  clearTimeout(t);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

async function main() {
  const ev = await readStdin();
  const sessionId = String(ev.session_id || ev.sessionId || '');
  const event = String(ev.hook_event_name || ev.hookEventName || '');
  const cfg = loadConfig();

  // 只有 SessionStart 才负责把常驻进程拉起来（UserPromptSubmit 走快路，绝不拖慢输入）
  if (event === 'SessionStart') {
    const up = await ensureHost(cfg, { spawnWaitMs: 8000 });
    if (!up.ok) {
      // 起不来：这次会话就没有办公室 —— 但这是接入问题，不是会话问题 ⇒ 静默退出
      try { process.stderr.write(`[office-hook] 常驻进程没起来：${up.reason}\n`); } catch { /* 无所谓 */ }
      return;
    }
  } else {
    // UserPromptSubmit：只在控制口现成可达时更新"当前会话"（1 秒内解决战斗）
    if (!(await pingCtl(cfg, 1000))) return;
  }

  if (!sessionId) return;
  await callCtl(cfg, '/ctl/session', { sessionId, source: event || 'hook' }, 2000).catch(() => {});
}

main()
  .catch(() => { /* hook 永远不挡会话 */ })
  .finally(() => { void sleep(0).then(() => process.exit(0)); });

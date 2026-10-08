/**
 * office-config —— 配置解析（hook／常驻进程／MCP 服务器三方共用，只依赖 Node 内置模块）
 *
 * 解析顺序（后赢）：
 *   ① 内置默认值
 *   ② 用户配置文件：`<默认数据目录>/office-config.json`（手工编辑；改完要重启常驻进程才生效）
 *   ③ 环境变量 `OFFICE_HOST_CONFIG`（一个 JSON 串；自测与高级用法用它整体注入——
 *      ⚠️ 它存在时**完全盖掉**文件与默认值，保证自测不沾用户真实配置）
 *
 * 「数据目录」＝ `~/.office-zcode`（卡、运行时指针、用户配置文件都在这一个目录里，可预测好找；
 *                  配置文件里可用 `dataDir` 把**状态**挪去别处，但配置文件本身永远在 `~/.office-zcode`）。
 *
 * ⚠️ 任何一处都**不写死密钥**：本插件不需要凭据（办公室是本机 HTTP，无鉴权字段）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 展开 ~ 开头的路径。 */
export function expandHome(p) {
  const s = String(p || '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return s;
}

/** 默认数据目录（卡、运行时指针、用户配置文件都在这里）。 */
export function defaultDataDir() {
  return path.join(os.homedir(), '.office-zcode');
}

/** 内置默认值。⚠️ `zcodePath` **默认留空** —— 请按你的机器配置（或用环境变量 `ZCODE_CLI_PATH`）；没配时起 CLI 会明确报错（见 README）。 */
export function defaults(env = process.env) {
  return {
    /** 办公室后端地址（《说明书》§3：本机默认 8787，端口以实际部署为准）。 */
    base: 'http://127.0.0.1:8787',
    /** 成员 id。格式 ^[a-z][a-z0-9_-]{0,31}$，报到时定终身（《说明书》§2 第二步）。 */
    memberId: 'zcode',
    /** 宿主进程名 —— 产品名写法（《说明书》§2），由插件代报，AI 改不了。 */
    name: 'ZCode',
    /** 昵称。留空也行：首次建卡时内核会问 AI 一次，AI 自己也能改。 */
    nick: '',
    /** 报到时报的模型名（如 "GLM-5.3-Flash"）。填了就**照报**；留空 ＝ 不报这一格（卡上保留旧值）。
     *  ⚠️ 2026-10-07 定案：不搞"宿主里扫流水自动探测" —— 这只是一张成员卡上的显示标签，
     *  为它给宿主添一份对会话文件路径的脆弱依赖，不值得。 */
    model: '',
    /** 头像 PNG 路径。首次报到把它的 base64 交给办公室。留空 ＝ **自动找宿主自带的应用图标**
     *  （从 `zcodePath` 反推安装目录取 `resources\icon.png`）；找不到再兜 PowerShell 抽宿主 exe 图标。 */
    iconFile: '',
    /** 门牌号（反向端点）端口：固定住才跨重启不漂；被占时先重试两次再退让。 */
    port: 19400,
    /** 起常驻进程／投递用的 node 可执行文件。 */
    nodePath: 'node',
    /** ZCode CLI 入口（node 可直接跑的那个 cjs）。 */
    zcodePath: String(env.ZCODE_CLI_PATH || ''),
    /** 传给 CLI 的 --mode；空 ＝ 不传（CLI 对 -p 的默认是 yolo）。 */
    mode: '',
    /** 投递方式：'cli' ＝ 调 ZCode CLI -p --resume（真用法）；'file' ＝ 写文件（自测用）。 */
    wakeMode: 'cli',
    /** wakeMode='file' 时的投递记录文件（自测断言用）。 */
    deliverFile: '',
    /** CLI 投递的宽限毫秒：到点还在跑 ＝ 当"已被接受"；宽限内非 0 退出 ＝ 如实报失败。 */
    wakeGraceMs: 15000,
    /** 打开后常驻进程的日志进 stderr（人看的）。 */
    verbose: false,
  };
}

const KNOWN_KEYS = Object.keys(defaults());

/** 读用户配置文件（只认 `~/.office-zcode/office-config.json` 这一处；读不到就当没有）。 */
function readConfigFile(env = process.env) {
  const file = path.join(defaultDataDir(), 'office-config.json');
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch {
    return {};
  }
}

/**
 * 解析出最终配置。所有字段都是字符串／数字／布尔，可直接 JSON.stringify 递给常驻进程。
 * `cfg.dataDir` ＝ 卡与运行时指针的落盘处（配置文件里可用 `dataDir` 覆盖；默认就是数据目录本身）。
 */
export function loadConfig(env = process.env) {
  const envText = String(env.OFFICE_HOST_CONFIG || '').trim();
  if (envText) {
    let raw = null;
    try { raw = JSON.parse(envText); } catch { /* 坏 JSON 就当下没给，走文件＋默认 */ }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return finalize(raw, env);
  }
  return finalize(readConfigFile(env), env);
}

function finalize(raw, env) {
  const d = defaults(env);
  const cfg = { ...d };
  for (const k of KNOWN_KEYS) {
    if (raw[k] === undefined || raw[k] === null) continue;
    if (typeof d[k] === 'number') { const n = Number(raw[k]); if (Number.isFinite(n)) cfg[k] = n; }
    else if (typeof d[k] === 'boolean') cfg[k] = raw[k] === true;
    else cfg[k] = String(raw[k]);
  }
  cfg.base = cfg.base.replace(/\/+$/, '');
  cfg.dataDir = raw && raw.dataDir ? expandHome(raw.dataDir) : defaultDataDir();
  return cfg;
}

/** 一份配置对应的运行时指针文件（常驻进程写，hook／MCP 读 —— 用它找到控制口与门牌号）。 */
export function runtimeFile(cfg) {
  return path.join(cfg.dataDir, 'office-runtime.json');
}

'use strict';

/**
 * M9 · 后端总入口 —— 壳（Start-OfficeServer）拉起的就是这个文件
 *
 * 依据：
 *   - 模块\M9-壳与窗口.md 四（Start-OfficeServer 拉起 Node 后端）
 *   - 规范\08-落地结构-20261002.md 三之二（服务端独立进程）、四（HTTP 口默认 8787）
 *
 * 职责：起 HTTP 那一口（M8 已验收的 8787，含 /health 等），保持进程活着供老大窗口/AI 成员对接。
 * 说明：stdio MCP 口由 MCP 宿主（AI 成员侧）自己拉进程使用，不归壳管，故本入口只起 HTTP 口。
 * 约束：不改 M1~M8 任何文件与接口；零第三方依赖。
 */

const bridge = require('./bridge');

const http = bridge.startHttp(); // 默认 8787，http-api 内部 server.listen

if (http && http.url) {
  // 打印一行便于人工/自验确认（隐藏窗口模式下不可见，自验走 /health 轮询）
  process.stdout.write('office-http-up ' + http.url + '\n');
}

// 保持进程存活由 HTTP server 的事件循环维持；不写任何退出钩子。

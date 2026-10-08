'use strict';
/**
 * 取「接入手续」那张卡（四格）—— 给**测试用的接入脚本**共用。
 *
 * ⚠️ 定位：这是**取巧**做法（直接读办公室的运行数据文件）。
 *    真正的接入端该照规范走：**报到 → 办公室回传那张卡 → 存进自己的数据目录 → 以后每次挂连接带上**
 *    （`插件源\dsh-office\lib\index.js` 就是这么做的，它是那个"正规实现"的样板）。
 *    测试脚本每次都是新进程、没地方存卡 ⇒ 直接读文件最省；而且**数据被清空时会读到 null**
 *    ⇒ 空手挂连接 ⇒ 走"新人"档放行 ⇒ 自动适应，脚本不用改。
 *
 * 正本：规范 `接入\01-接入与连接.md` §2.4（接入手续）。
 */
const fs = require('fs');
const path = require('path');

/** `运行\数据\members.json` 的绝对路径（本文件在 `程序\接入\`，往上两层是项目根）。 */
const MEMBERS = path.join(__dirname, '..', '..', '运行', '数据', 'members.json');

/** 读某个成员那张卡的四格；读不到（没这文件／没这成员）回 `null`。 */
function readCard(memberId) {
  try {
    const all = JSON.parse(fs.readFileSync(MEMBERS, 'utf8'));
    const m = all && all[memberId];
    if (!m) return null;
    return { id: m.id || memberId, joined: m.joined || '', name: m.name || '', icon: m.icon || '' };
  } catch (_) { return null; }
}

/** 组装 `X-Office-Card` 头的值（`base64(JSON)`）；没有卡就回空串（＝空手挂）。 */
function cardHeader(memberId) {
  const c = readCard(memberId);
  if (!c) return '';
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64');
}

/** 挂那条 `GET /api/alive` 时直接能用的 headers 对象。 */
function aliveHeaders(memberId) {
  const h = cardHeader(memberId);
  return h ? { accept: 'text/event-stream', 'x-office-card': h } : { accept: 'text/event-stream' };
}

module.exports = { readCard, cardHeader, aliveHeaders, MEMBERS };

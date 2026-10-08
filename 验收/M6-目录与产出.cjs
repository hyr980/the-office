'use strict';
/**
 * 办公室 · M6 目录与产出 验收脚本（hyr980 写，2026-10-03）
 * 依据：验收清单-20261003.md 二·M6（五条）＋ 规范\08-落地结构.md §三之二
 * ⚠️ 不碰生产的 日志\ 和 数据\（里面有真东西）—— 用隔离根目录 验收\_沙盒（脚本自己建）
 */

const path = require('path');
const fs = require('fs');

// ⭐ 2026-10-05 改：路径不再写死（原来硬编码到 0.1 的 办公室\）—— 跟着本脚本自己走，0.2/以后都对。
const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, '程序', '后端');
const PROD_ROOT = path.join(ROOT, '运行');        // ⚠️ 0.2 起：数据/日志/产出/收件 四个目录在 运行\ 下
const SANDBOX = path.join(__dirname, '_沙盒');
const DIRS = require(path.join(BACKEND, 'dirs.js'));

const out = [];
let pass = 0, fail = 0, skip = 0;
function rec(ok, name, detail) {
  const tag = ok === true ? '过  ' : ok === false ? '没过' : '没法验';
  if (ok === true) pass++; else if (ok === false) fail++; else skip++;
  out.push(`[${tag}] ${name}\n         ${detail}`);
}
function group(name, fn) {
  try { fn(); } catch (e) { rec(false, name + '（抛异常）', e.message); }
}
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
const FOUR = ['收件', '产出', '日志', '数据'];

console.log('=== M6 验收（隔离根目录 ' + SANDBOX + '）===');

// ===== 1. 首次启动：删掉四目录 ⇒ 启动 ⇒ 四个自己出来 =====
group('1 段', () => {
  rmrf(SANDBOX);
  fs.mkdirSync(SANDBOX, { recursive: true });
  const d = DIRS.createDirs(SANDBOX);
  const before = FOUR.filter((n) => fs.existsSync(path.join(SANDBOX, n)));
  d.ensureDirs();
  const after = FOUR.filter((n) => fs.existsSync(path.join(SANDBOX, n)));
  rec(before.length === 0 && after.length === 4,
    '1. 四个目录全删掉 ⇒ 启动（ensureDirs）⇒ 四个自己出来',
    `启动前存在 [${before.join(',')}]（0 个）；启动后 [${after.join(',')}]（${after.length} 个）`);
  d.ensureDirs();  // 幂等
  const again = FOUR.filter((n) => fs.existsSync(path.join(SANDBOX, n)));
  rec(again.length === 4, '1b 再调一次不炸（幂等）', `第二次调用后 [${again.join(',')}]`);

  // 生产目录：只核"四个都在"，不删
  const pd = DIRS.createDirs(PROD_ROOT);
  const prodExist = FOUR.filter((n) => fs.existsSync(path.join(PROD_ROOT, n)));
  rec(prodExist.length === 4, '1c 生产目录四个也都在（没删，只核）',
    `程序根目录下 [${prodExist.join(',')}]`);
});

// ===== 2. 按天分类 =====
group('2 段', () => {
  const d = DIRS.createDirs(SANDBOX);
  const d1a = d.workDir('b', '20261003');
  const d1b = d.workDir('b', '20261003');
  const d2 = d.workDir('b', '20261004');
  const dOther = d.workDir('c', '20261003');
  const tail = (p) => p.slice(SANDBOX.length + 1).replace(/\\/g, '/');
  rec(d1a === d1b && fs.existsSync(d1a),
    '2a 同一天调两次 ⇒ 同一目录、都在 产出\\<id>\\<今天>\\',
    `第一次=${tail(d1a)}；第二次=${tail(d1b)}；同一个=${d1a === d1b}`);
  rec(d2 !== d1a && fs.existsSync(d2) && tail(d2).endsWith('20261004'),
    '2b 换一天 ⇒ 新日期目录自己出现', `新路径=${tail(d2)}`);
  rec(dOther !== d1a && tail(dOther) === '产出/c/20261003',
    '2c 按成员分开（别人的产出在别人的目录）', `c 的目录=${tail(dOther)}`);
});

// ===== 3. 写权限 =====
group('3 段', () => {
  const d = DIRS.createDirs(SANDBOX);
  const own = d.workDir('b', '20261003');
  const other = d.workDir('c', '20261003');
  const up = path.join(SANDBOX, '产出', 'b', '..', 'c', '20261003');
  const prefixTrap = path.join(SANDBOX, '产出', 'bb', '20261003');
  const cases = [
    ['写自己的产出目录', own, true],
    ['写别人的产出目录（c 的）', other, false],
    ['写产出根目录本身', path.join(SANDBOX, '产出'), false],
    ['写收件\\', path.join(SANDBOX, '收件'), false],
    ['写日志\\', path.join(SANDBOX, '日志'), false],
    ['写数据\\', path.join(SANDBOX, '数据'), false],
    ['用 .. 跳级到自己父目录', path.join(SANDBOX, '产出'), false],
    ['用 .. 跳级到别人的目录（产出\\b\\..\\c\\…）', up, false],
    ['前缀陷阱：产出\\bb\\（换名字后试图蹭前缀）', prefixTrap, false],
    ['自己产出目录的子目录', path.join(own, '子目录'), true],
  ];
  for (const [name, p, want] of cases) {
    const got = d.isWritableBy('b', p);
    rec(got === want, `3 · ${name} ⇒ ${want ? '允许' : '拒'}`,
      `isWritableBy("b", "${p.slice(SANDBOX.length + 1).replace(/\\/g, '/')}") = ${got}`);
  }
  const badId = d.isWritableBy('../坏id', own);
  rec(badId === false, '3 · 非法成员 id ⇒ 拒', `isWritableBy("../坏id", …) = ${badId}`);
});

// ===== 4. 收件只放兜底 =====
group('4 段', () => {
  const d = DIRS.createDirs(SANDBOX);
  const inboxPath = d.inboxDir('00001-20261003100000');
  const tail = inboxPath.slice(SANDBOX.length + 1).replace(/\\/g, '/');
  rec(tail === '收件/00001-20261003100000' && fs.existsSync(inboxPath),
    '4a 收件目录按主任务 id 分子目录：收件\\<主任务 id>\\',
    `返回=${tail}；存在=${fs.existsSync(inboxPath)}`);
  // 收件根目录下除这个子目录外不该多东西（隔离沙盒里只有这一处）
  const inboxRoot = path.join(SANDBOX, '收件');
  const kids = fs.readdirSync(inboxRoot);
  rec(kids.length === 1, '4b 收件根目录下只有按主任务分的子目录',
    `收件\\ 下内容=[${kids.join(',')}]`);
  rec(null, '4c 正常交付会不会经过收件\\（代码层查调用点）',
    'grep 全项目：inboxDir / workDir / isWritableBy 只在 dirs.js 自己里出现，其它块（含 M8 主程序 —— 还没验）暂未调用 ⇒ 待 M8 验收时核');
});

// ===== 5. 路径能点（这边只能核"是真实存在的文件夹"）=====
group('5 段', () => {
  const d = DIRS.createDirs(SANDBOX);
  const wd = d.workDir('b', '20261003');
  const stat = fs.statSync(wd);
  const abs = path.isAbsolute(wd);
  rec(stat.isDirectory() && abs,
    '5. 返回的是"绝对路径 ＋ 真文件夹"（界面上能不能双击打开归 M10）',
    `workDir ⇒ ${wd}；绝对路径=${abs}；isDirectory=${stat.isDirectory()}`);
  const id = d.inboxDir('00001-20261003100000');
  rec(path.isAbsolute(id) && fs.statSync(id).isDirectory(),
    '5b 收件目录同理', `${id} ⇒ 绝对=${path.isAbsolute(id)}，isDirectory=${fs.statSync(id).isDirectory()}`);
});

// ===== 附：非法入参 =====
group('附 段', () => {
  const d = DIRS.createDirs(SANDBOX);
  const tries = [
    ['workDir 传非法 id（带斜杠）', () => d.workDir('a/b', '20261003')],
    ['workDir 传非法日期（格式不对）', () => d.workDir('b', '2026-10-03')],
    ['workDir 传非法日期（7 位）', () => d.workDir('b', '2026100')],
    ['inboxDir 传非法任务 id（带 ..）', () => d.inboxDir('../坏')],
    ['inboxDir 传非法任务 id（带中文）', () => d.inboxDir('任务一')],
  ];
  for (const [name, fn] of tries) {
    let r;
    try { fn(); r = '没拒（居然过了）'; } catch (e) { r = '拒: ' + e.message; }
    rec(/^拒/.test(r), '附 · ' + name, r);
  }
});

console.log(out.join('\n'));
console.log('');
console.log(`=== 小计：过 ${pass} ／ 没过 ${fail} ／ 没法验 ${skip} ===`);
console.log('（沙盒留在 ' + SANDBOX + '，跑完不删，方便你翻）');
process.exit(0);

/* @hyr980/dsh-office —— 客户端半身（2026-10-04 按新契约改）
 *
 * 干的事：在**会话页面 · 输入框上面那一条**放一行「办公室」——
 *   · 显示：连接状态（已连接／未连接）＋ 在线状态（已上线／未上线／已离线）＋ 当前会话 id
 *   · ⭐ **两个按钮，各管一层**（规范 `01` §2.1 —— 老大 2026-10-03：「不应该是连接跟上线两个按钮吗」）：
 *       「连接 ／ 断开」＝ **第一层**（办公室 ↔ 插件）：**不碰绑定**，**哪个页面都能点**
 *       「上线 ／ 下线」＝ **第二层**（插件 ↔ AI）：上线 ＝ **绑住当前这个会话**＋报到＋上线；
 *                                              下线 ＝ **解绑**（老大原话「会话解锁可以是下线」）
 *   · ⚠️ 什么时候灰（规范 `01` §2.1 那张表）：
 *       第一层断着 ⇒ 「上线」灰（"断开 ⇒ 一定未上线"）；人不在绑定的那个会话页面 ⇒ 「上线」灰
 *       ⭐ **灰 ＝ 那条路真的走不通**，插件和后端都要拦（不许"灰着、绕个道还能干成"）
 *   · ⚠️ **切到别的会话不再下线**（2026-10-04 改口径）：绑定的那个会话照旧在线、照样收消息
 *
 * 挂载点：`conversation.input.dock` ＝「输入框上面那一条」（规范 `接入\00` §1 第 7 项的硬要求）
 *   实测该槽已有官方三个占用者（待办 0／目标 10／队列 20）⇒ 我们取 order 30 排在后头，不会叠。
 *
 * 宿主约定（出处：本机已装插件 @linxin666/dsh-client-ui-task-board 的 lib\client.js）：
 *   window.__ModuleLoader__.load({ id, factory }) ⇒ factory(require) ⇒ 导出 { apply, inject }
 *   apply(ctx) ⇒ ctx.get('slots') ⇒ slots.inject(槽位名, () => slots.register({name, id, order}, 组件))
 *   ⚠️ register 的 options 里**必须再写一次槽位名 name**，漏了报 `slot "undefined" is not declared`。
 */
window.__ModuleLoader__.load({
  id: '@hyr980/dsh-office',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');
    var h = react.createElement;

    var STATE_API = '/dsh-office/panel-state';
    var LINK_API = '/dsh-office/link';
    var UNLINK_API = '/dsh-office/unlink';
    var LAYER1_API = '/dsh-office/layer1';

    /** 探针（实验用，验完删）：让"加载没加载、挂没挂上"我这边查得到，不靠人眼看界面。 */
    function probe(step, extra) {
      try {
        fetch('/dsh-office/client-ready', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ step: step, extra: extra === undefined ? null : extra, at: new Date().toISOString() }),
        }).catch(function () { /* 报不出去不影响界面 */ });
      } catch (e) { /* 同上 */ }
    }

    function post(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(function (r) { return r.json(); }).catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
    }

    // 操作回话的计时器（放外层：组件重渲染不会丢；同一时刻只有一个面板实例）
    var noteTimer = null;

    /** 那一行的样子 */
    function OfficeDock(props) {
      var sessionId = String((props && props.sessionId) || '');
      var s = react.useState(null);   // 面板状态（从 Host 拉）
      var info = s[0];
      var setInfo = s[1];
      var b = react.useState('');     // 最近一次操作的回话（给老大看的）
      var note = b[0];
      var setNote = b[1];
      var w = react.useState(false);  // 操作中（防连点）
      var working = w[0];
      var setWorking = w[1];

      /**
       * 操作回话**只留 8 秒**（2026-10-03 老大实测抓到）：
       * 那句话原来赖着不走，跟后来的实时状态并排出现 ⇒ «操作失败：连不上办公室» 和 «断开»
       * 同屏，看着像自相矛盾。它其实只是"上一次操作发生了什么"，不该长期占着地方。
       */
      function flashNote(text) {
        if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
        setNote(text || '');
        if (text) noteTimer = setTimeout(function () { setNote(''); }, 8000);
      }

      react.useEffect(function () {
        var alive = true;
        function pull() {
          fetch(STATE_API + '?sessionId=' + encodeURIComponent(sessionId))
            .then(function (r) { return r.json(); })
            .then(function (d) { if (alive) setInfo(d); })
            .catch(function () { /* 拉不到就保持上一次的 */ });
        }
        pull();
        var t = setInterval(pull, 2000);
        return function () { alive = false; clearInterval(t); };
      }, [sessionId]);

      var bound = (info && info.boundSessionId) || '';
      var canOperate = info ? info.canOperate !== false : true;
      var isHere = !!bound && bound === sessionId;
      // ⭐ 第一层有**两个**状态，别混（2026-10-03 老大点破）：
      //    · linkOn    = 人点过「连接」没有（意图）
      //    · connected = 那条连接真的挂着没有（实际）—— **显示一律用它**
      //    （办公室没开时点连接 ⇒ 意图是连、但实际连不上 ⇒ 必须显示"未连接"）
      var linkOn = info ? info.linkOn === true : false;
      var connected = info ? info.connected === true : false;
      // ⭐ 第二层（在不在线）也得**看实际**，不能信插件自己记的（2026-10-03 老大实测抓到）：
      //    `presence` 是**问办公室**要来的（online／offline／ghost）——
      //    老大在办公室那张卡上点了「踢下线」之后，这里必须跟着变回"未上线"。
      var presence = info ? String(info.presence || '') : '';
      // ⚠️ 2026-10-04 改：**"在线"要连"绑没绑会话"一起看** ——
      //    点「下线」这一步**是插件去报的**（插件调办公室的 `presence: offline` ＝ 撤掉"在岗"，
      //    ⚠️ 它**不动那张叫醒地址**，跟 AI 没关系；正本规范 `接入\01` §2.1）——
      //    所以只认 `presence === 'online'` 的话，下线之后按钮会赖在「下线」上 ⇒ 这里必须带上 `bound`。
      var online = (presence === 'online') && !!bound;   // 办公室说在线 ＋ 本插件确实绑着会话
      // ⭐⭐ 2026-10-04 加：**离线要把"因为什么离的"显示出来**（规范 `状态\01` §2.3；老大原话
      //    「离线不知道什么情况那就把原因也写进去不就好了」）——
      //    值从成员卡来（后端 `offlineReason`）：`self` 自己下线／`heartbeat` 心跳超时被判掉／
      //    `kick` 被踢下线（线还挂着 ⇒ **它能自己回来**）／`disconnect` 被断开连接（⇒ **只能人重新点「连接」**）。
      //    ⚠️ **拿不到原因就只说「已离线」** —— 绝不写死"被踢下线"那一种（那句话原来就是不准确的）。
      var OFFLINE_TEXT = { self: '自己下线', heartbeat: '心跳超时', kick: '被踢下线', disconnect: '被断开连接' };
      var offlineReason = info ? String(info.offlineReason || '') : '';
      var killed = presence === 'offline';               // 办公室说：我不在线（具体哪一种，看上一条）
      // ⚠️ "隐身"（ghost）那档 2026-10-04 整档砍掉（规范 `02` §2.2）—— 这里的分支也删了。
      // 在线状态那句话 —— **只在这一处算**，别在别处再写一遍状态（免得两处对不上）
      var onlineLabel;
      if (!connected) onlineLabel = '· 未上线';                    // 线都没通 ⇒ 一定未上线（规范 01 §2.1）
      else if (killed) onlineLabel = '· 已离线' + (OFFLINE_TEXT[offlineReason] ? '（' + OFFLINE_TEXT[offlineReason] + '）' : '');
      else if (online) onlineLabel = isHere ? '· 已上线（本页面）' : '· 已上线（另一个会话）';
      else onlineLabel = '· 未上线';                               // 连上了，但还没绑会话／没上线

      function doLink() {
        setWorking(true);
        post(LINK_API, { sessionId: sessionId }).then(function (r) {
          setWorking(false);
          // ⚠️ 成功不吭声（老大 2026-10-03：「那个一上线意义何在，以上线未上线在右边不是能看状态吗」）
          //    —— 状态栏自己会变，重复念一遍是废话；只有**失败**才需要说话。
          flashNote(r && r.ok ? '' : ('上线失败：' + ((r && r.error) || '未知')));
          probe('panel-link', { ok: !!(r && r.ok) });
        });
      }
      function doUnlink() {
        setWorking(true);
        post(UNLINK_API, {}).then(function (r) {
          setWorking(false);
          flashNote(r && r.ok ? '' : ('下线失败：' + ((r && r.error) || '未知')));
          probe('panel-unlink', { ok: !!(r && r.ok) });
        });
      }
      /** ⭐ 第一层：连接／断开（办公室 ↔ 插件）—— 2026-10-03 晚加：两个按钮各管一层 */
      function doLayer1(on) {
        setWorking(true);
        var t0 = Date.now();
        // ⚠️ 这个 `sessionId` **服务端目前不看**：「连接」（`lib\index.js` 的 `layer1` 处理）只读 `b.on`，
        //    真正会读 `sessionId` 的是「上线」那条。
        //    ⭐ 2026-10-06 改（老大令）：旧注释写的"点「连接」时插件顺手报到、办公室靠那次建卡"
        //    **不成立，也不是规范的意思** —— 规范 `接入\00` §1／原文：**「由人点「上线」触发」：
        //    「上线」＝ 绑住当前这个会话 ＋ 报到 ＋ 上线**；`00` 第 7 项：「插件照着人点过
        //    「上线」的那个会话去报到」。而 `01` §2.4 那句「先挂连接、再报到」讲的是**顺序**
        //    （报到也得先连着），**不是"连接时就要报到"** —— 旧注释把它读成了动作要求。
        //    ✅ 现在的实际：**报到归「上线」**（`online()` 带着会话 id 报一次）；「连接」只挂线，
        //    **不报到、也不绑会话**。
        // ⚠️ 字段先留着别删：将来若要"连接时把会话带上"还用得着（现在它被忽略）。
        post(LAYER1_API, { on: !!on, sessionId: sessionId }).then(function (r) {
          setWorking(false);
          // ⚠️ 提示词一律写人话（老大 2026-10-03：「你插件写的是什么问题啊」）——
          //    别把"第一层""绑到当前会话"这类内部说法甩到界面上。
          flashNote(r && r.ok ? '' : ('操作失败：' + ((r && r.error) || '未知')));
          // ms＝这次操作花了多少毫秒（能分辨"真去试连了"还是"没试就回话"），error＝失败原因原文。
          probe('panel-layer1', { on: !!on, ok: !!(r && r.ok), ms: Date.now() - t0, error: (r && r.error) || null });
        });
      }

      function btn(label, onClick, primary, opts) {
        opts = opts || {};
        // opts.alwaysOn：不受"不在绑定的页面"影响（「连接」用 —— 它跟哪个会话无关）
        // opts.off     ：强制灰掉（「上线」在第一层没连时用 —— 都没连，上不了线）
        var off = working || opts.off === true || (!canOperate && !opts.alwaysOn);
        return h('button', {
          disabled: off,
          onClick: off ? undefined : onClick,
          style: {
            border: '1px solid ' + (off ? 'transparent' : 'currentColor'),
            background: primary && !off ? 'rgba(74,140,255,.14)' : 'transparent',
            color: 'inherit',
            borderRadius: '6px',
            padding: '2px 10px',
            fontSize: '12px',
            cursor: off ? 'not-allowed' : 'pointer',
            opacity: off ? 0.35 : (working ? 0.5 : 1),
          },
        }, label);
      }

      // ⭐ 2026-10-04 加（规范 `接入\02` §3 第 13 条）：一眼看清"**当前这一页是不是绑定的那一页**"
      //    （老大原话：「换会话没法一眼看出就加个高亮的'当前页面不是绑定会话'不就行了吗」）
      //    ⚠️ 为什么必须有它：**绑定指向别的会话时，界面一切都看着正常**，人不会知道"叫醒会叫到别处去"。
      //    ⚠️ 这条声明必须写在 `h(...)` 的参数列表**外面** —— 参数之间只能放表达式，放语句直接语法错
      //       （2026-10-04 我在这儿栽过一次：`SyntaxError: Unexpected token 'var'`）。
      var bindNote = !bound
        ? '还没有绑定会话'
        : (isHere ? '目前页面为绑定会话' : '目前页面不是绑定会话');
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px',
          padding: '6px 10px', margin: '0 auto 6px', maxWidth: '100%',
          border: '1px solid ' + (bound ? '#4a8cff' : 'var(--line, #ddd)'),
          borderRadius: '8px', fontSize: '12.5px',
          background: bound ? 'rgba(74,140,255,.08)' : 'transparent',
        },
      },
        h('span', null, '📡 办公室'),
        h('span', { style: { opacity: 0.8 } }, connected ? '已连接' : '未连接'),
        // ⚠️ 这一格一律照**办公室说的**显示（`onlineLabel` 里算好了），不照插件自己记的 ——
        //    2026-10-03 老大实测：他在办公室点了「踢下线」，插件却还写着"已上线（本页面）"。
        h('span', { style: { opacity: 0.8 } }, onlineLabel),
        // ⭐ 绑定关系提示（规范 `接入\02` §3 第 13 条）——「不是绑定页」那一档**高亮**（橙色加粗），
        //    因为那正是"叫醒会叫到别处去"的状态，人得一眼看见。
        h('span', {
          style: {
            opacity: isHere ? 0.8 : 1,
            color: isHere ? 'inherit' : '#d98a00',
            fontWeight: isHere ? 'normal' : 600,
          },
        }, bindNote),
        h('span', { style: { opacity: 0.45, fontSize: '11px' } }, sessionId ? sessionId.slice(0, 20) : '（拿不到会话 id）'),
        // ⭐ 两个按钮，各管一层（老大 2026-10-03：「不应该是连接跟上线两个按钮吗」「都要两个」）：
        //    「连接／断开」＝ 第一层 —— 跟"哪个会话"无关 ⇒ 不受"不在那个页面"影响；
        //    「上线／下线」＝ 第二层 —— **第一层没连 ⇒ 点不了**（都没连，上不了线）；不在绑定的页面 ⇒ 也点不了。
        h('span', { style: { marginLeft: 'auto', display: 'flex', gap: '6px' } },
          btn(connected ? '断开' : '连接', function () { doLayer1(!connected); }, !connected, { alwaysOn: true }),
          // ⭐ 只有**办公室确认真在线**才给「下线」；被踢下线之后必须变回「上线」（还能再叫人上线）
          // ⚠️ 2026-10-04：「上线／下线」**也不挑页面**（alwaysOn）—— 旧口径"不在绑定的页面就灰"
          //    会死锁：绑定一旦指向一个**打不开的会话**（上下文爆掉、一发消息就卡的那个），人就
          //    再也回不去那个页面 ⇒ 按钮永远灰着、绑定永远改不回来。老大实撞：
          //    「我绑不了当前这个会话，我得去上一个坏掉的会话才能上线，但是上线了就绑上一个会话了」。
          //    ⇒ 在任何页面点「上线」＝**把绑定改到本页面**（正本：规范 `接入\01` §2.1，2026-10-04 已改）。
          (connected && online)
            ? btn('下线', doUnlink, false, { alwaysOn: true })
            : btn('上线', doLink, false, { off: !connected, alwaysOn: true })
        ),
        // ⭐ 2026-10-04 加：把插件的诊断**摆到界面上**（老大原话：「**看不出来就让他显示出来不就完了**」）——
        //    ⚠️ **只在真出过错的时候才显示**，平时不占地方；想看细账（连了几次／叫醒几次／出错几次）
        //    鼠标停上去。这样以后出问题不用像今天这样读文件、一个个打端点。
        //    ⭐ 同日再改（老大：「我一关掉办公室，插件提示插件上次出错」）：**分两种** ——
        //    「办公室没了」（断开／连不上）是**中性灰**，只有**插件自己出错**才用 ⚠️。
        //    原来只看 `lastError` ⇒ 一关办公室就永久挂个 ⚠️，看多了麻木、真出事反而看不出。
        (info && info.stats && info.stats.errors)
          ? h('span', {
              style: { opacity: 0.85, fontSize: '11px', color: '#d98a00' },
              title: '插件累计：连接 ' + (info.stats.connects || 0) + ' 次｜叫醒 ' + (info.stats.wakes || 0)
                + ' 次｜插话 ' + (info.stats.steers || 0) + ' 次｜出错 ' + (info.stats.errors || 0)
                + ' 次｜最近一次出错：' + info.stats.lastError,
            }, '⚠️ 插件上次出错')
          : (info && info.stats && info.stats.drops)
            ? h('span', {
                style: { opacity: 0.6, fontSize: '11px', color: '#8a8a8a' },
                title: '办公室累计断开 ' + (info.stats.drops || 0) + ' 次｜最近一次：' + (info.stats.lastDrop || '')
                  + '（这是"办公室没开／线断了"，不是插件出错）',
              }, '办公室断过 ' + (info.stats.drops || 0) + ' 次')
            : null,
        note ? h('span', { style: { opacity: 0.6, fontSize: '11px' } }, note) : null
      );
    }

    /** 依赖的客户端服务（出处：同 task-board 的写法） */
    var inject = ['slots'];

    function apply(ctx) {
      probe('client-half-loaded');
      var slots = ctx.get('slots');
      if (slots === void 0) { probe('no-slots-service'); return; }
      try {
        var dispose = slots.inject('conversation.input.dock', function () {
          try {
            var d = slots.register(
              {
                // ⚠️ 槽位名必须在这儿再写一次 —— inject 那边写了不算。
                //    出处：@linxin666/dsh-client-ui-task-board 的 lib/client.js（`name: "sidebar.panellist"`）。
                //    漏了它的症状：`slot "undefined" is not declared`（2026-10-03 实测踩到）。
                name: 'conversation.input.dock',
                id: 'office-connect',
                order: 30,
                label: '办公室',
              },
              OfficeDock
            );
            probe('register-ok', { disposeType: typeof d });
            return d;
          } catch (e) {
            probe('register-threw', {
              message: String((e && e.message) || e),
              stack: String((e && e.stack) || '').slice(0, 600),
            });
            throw e;
          }
        });
        probe('inject-ok', { disposeType: typeof dispose });
      } catch (e) {
        probe('inject-threw', {
          message: String((e && e.message) || e),
          stack: String((e && e.stack) || '').slice(0, 600),
        });
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});

/**
 * 办公室 · 接入插件（Claude Code 这一半）—— 「宿主 ↔ 插件」那一段 ＋ 界面
 *
 * 依据：《插件标准包与插件》的《说明书》＋ 内核 `office-bridge.mjs`（本插件 `kernel/` 下逐字节照搬）。
 * 分工（照标准包 README「两段分开，各管各的」）：
 *   · 「插件 ↔ 办公室」＝ 内核，**一个字没改**，跑在宿主侧那个常驻进程里（`host/office-host.mjs`）。
 *   · 「宿主 ↔ 插件」＝ **本文件**（这一段各家不同，标准包不规定）。它干四件事：
 *       ① 把办公室的工具表递到 AI 面前（`$.tool.register` ⇒ `mcp__office__*`）—— ⭐ 填表发生在办公室侧
 *       ② 接上"叫醒"与"插话"两条口（`$.prompt.submit` ／ `$.session.append`）
 *       ③ 在**输入框上方那一条**画那一行：状态 ＋ **两个按钮**（《说明书》§1 第 7 件的硬要求）
 *       ④ 报到的两处插件才知道的值（门牌号、宿主进程名）替 AI 补上
 *
 * ⭐ 两个按钮**是两个、不合并**（《说明书》§1 第 7 件）：
 *   「连接／断开」＝ 第一层（办公室 ↔ 插件）：**不碰绑定**，跟"哪个会话"无关
 *   「上线／下线」＝ 第二层（插件 ↔ 该 AI）：上线 ＝ **绑住当前这个会话** ＋ 报到 ＋ 上线；
 *                                        下线 ＝ **先报下线、不解除绑定**（地址留着，办公室才叫得到人）
 *
 * ⚠️ 三条"不许"（《说明书》§1 第 1 件、§5 两条硬要求、§8 第 6／7 条）：
 *   · 起来**不自动连**、**不自动上线** —— 等人点
 *   · 断了**不自己重挂** —— 恢复须由人重新点「连接」
 *   · 推送的**只有"进来看"这条命令，不带正文** —— 正文在账本里，AI 自己读
 *
 * ⚠️ 本模块跑在一个**没有 DOM、没有 Node** 的环境里：进程、网络、文件、计时全都走 `$`。
 *
 * ⚠️⚠️ 三条写法上的硬规矩（写错 `claude plugin validate` 当场报错，改代码前先看这一节）：
 *   1. **`$` 一律在调用处写成 `$.noun.method(...)`**；
 *      要把 `$` 交给本文件自己的辅助函数时，那个函数**必须声明在本文件最外层**
 *      （函数声明，或者 const 绑到一个函数）—— 嵌在 `register()` 里的闭包不算。
 *      ⇒ 所以下面那些 `function xxx($, ...)` 全在最外层，别好心把它们挪回去。
 *   2. **`on` 一律写成 `on("<event>", hook)`** —— 不许拿 `on` 当形参/变量名（会遮蔽引擎的全局 `on`）。
 *   3. **`next.to` 一律写成 `next.to(e, "<tier>")`**（本文件没用到 `next.to`）。
 *
 * ⚠️ 还有一条开发时要知道的（不是写法，是行为）：**改这个文件 = 重载 = 掉线一次**。
 *   重载的时机是"这一回合结束时"，或者更早 —— 紧接着调一个本插件注册的工具时（引擎先重载再跑）。
 *   ⚠️ 只改 `README.md` 这类**非模块文件不触发**（2026-10-06 实测：改 README 后调工具照旧成功）。
 *   重载会把常驻进程收掉、那条 SSE 跟着断，而新的**默认不连** ⇒ 恢复只能由人按「1」（详见 README §六 ⑦）。
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpInit, Register } from 'claude-code'
import type { OfficeStatus } from '../types'

/** 办公室工具在本宿主的名字前缀：`mcp__<插件名>__<办公室那边的原名>`。 */
const TOOL_PREFIX = 'mcp__office__'

/** 界面还没拿到读数时的那份（"什么都没有"）。 */
const EMPTY_STATUS: OfficeStatus = {
  isUp: false,
  downReason: '',
  ctlPort: 0,
  hostPort: '',
  connected: false,
  connecting: false,
  registered: false,
  hasCard: false,
  boundSessionId: '',
  pageSession: '',
  presence: '',
  offlineReason: '',
  presenceErr: '',
  dataDir: '',
}

// ⭐ 这一行的读数**只有一份**（《说明书》§8 第 9 条：两侧读同一份状态，不得各存一份）：
//    每 2 秒向宿主侧那个常驻进程拉一次，写进这里；画的地方读它。
const status = atom({ plugin: 'office', key: 'status' } as const, EMPTY_STATUS)
const note = atom({ plugin: 'office', key: 'note' } as const, '')
const working = atom({ plugin: 'office', key: 'working' } as const, false)

const say = (e: unknown) => String((e && (e as Error).message) || e)

// ═══════════════ 这一世（一次加载一份）的运行态 ═══════════════
// ⚠️ 热重载 = 整个模块重新来一遍 ⇒ 这些会跟着重来（所以真正的读数一律走上面的 `$.state`）。

type Cfg = {
  officeUrl: string
  memberId: string
  nick: string
  /** 宿主进程名 —— **产品名写法，不是可执行文件名**（《说明书》§2 第二步）。由插件代报，AI 改不了。 */
  name: string
  model: string
  /** 门牌号（反向端点）端口：**固定 ⇒ 跨重启不变**（办公室记着上次那个，变了就推不到）。 */
  port: number
  /** 卡与状态放哪 —— ⚠️ 里面那张卡是**接入手续**，别删。 */
  dataDir: string
  nodePath: string
  /** 头像（图片文件路径，PNG；内核报到时要用它的 base64）。留空 ＝ 不报头像。 */
  iconFile: string
  verbose: boolean
}

let cfg: Cfg = {
  officeUrl: 'http://127.0.0.1:8787',
  memberId: 'claude',
  nick: '',
  name: 'Claude Code',
  model: '',
  port: 19390,
  dataDir: '~/.claude/office',
  nodePath: 'node',
  iconFile: '',
  verbose: false,
}

let childAlive = false
let starting = false
let ctlPort = 0
/** 门牌号（宿主进程起来时报上来的那个）；进程没了就清空。 */
let hostPort = ''
/** 等"宿主进程起来了"的人（`startHost` 的等待者 —— 可能不止一个）。 */
let readyWaiters: Array<() => void> = []
const fireReady = () => { const w = readyWaiters; readyWaiters = []; for (const f of w) f() }
let noteTimer: { cancel: () => void } | null = null
let toolsDone = false
let syncTimer: { cancel: () => void } | null = null
let syncTries = 0

// ═══════════════ 与宿主侧那个常驻进程说话 ═══════════════

async function fetchJson($: EngineInterface, url: string, init?: HttpInit) {
  try {
    const r = await $.http.fetch(url, init)
    let data: any = null
    try { data = JSON.parse(r.text) } catch { /* 不是 JSON 就当空 */ }
    return { ok: r.ok, status: r.status, data }
  } catch (e) {
    return { ok: false, status: 0, data: null, error: say(e) }
  }
}

/** 本会话当前的模型（报到要报的那个）。取不到就回空串 —— 报空比报错强。 */
async function sessionModel($: EngineInterface): Promise<string> {
  try { return await $.session.model() } catch { return '' }
}

/** 调一次控制口（只在本机 127.0.0.1；地址是宿主进程起来时告诉我们的）。 */
function ctl($: EngineInterface, path: string, body?: Record<string, unknown>) {
  if (!childAlive || !ctlPort) return Promise.resolve({ ok: false, data: null, error: '宿主进程没在跑' })
  return fetchJson($, `http://127.0.0.1:${ctlPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
}

/**
 * 起那个常驻进程，并**一直读它的 stdout**（读到它退出为止）。
 * ⚠️ 这个读循环故意丢给一个不被等的 async —— 它要跟会话一样长命。
 * ⚠️ 只从 `session.start` 或**人点按钮**时才起（绝不自动连办公室）。
 */
function startHost($: EngineInterface): Promise<void> {
  if (childAlive && ctlPort) return Promise.resolve()
  if (starting) {
    // 已经在起了：跟着一起等（⚠️ 等的人可能不止一个 —— 用队列，别只记最后一个）
    return new Promise((r) => { readyWaiters.push(() => r(undefined)) })
  }
  starting = true

  const ready = new Promise<void>((r) => { readyWaiters.push(() => r(undefined)) })

  void (async () => {
    let stream: any
    try {
      // ⭐ model 留空 ⇒ **取本会话当前的模型**（`plugin.json` 里对配置项的那句承诺；
      //    2026-10-06 认领的第 ③ 件：原来只写了承诺、代码里没实现，结果报了个 null）
      const model = cfg.model || (await sessionModel($))

      // 配置走环境变量递过去（不进 argv、不落文件）：字段都很小；
      // 头像只给**路径**，由那个进程自己去读（省得把 base64 塞进来撑爆变量长度）。
      const env = {
        OFFICE_HOST_CONFIG: JSON.stringify({
          base: cfg.officeUrl,
          memberId: cfg.memberId,
          name: cfg.name,
          nick: cfg.nick || undefined,
          model: model || undefined,
          dataDir: cfg.dataDir,
          port: cfg.port,
          ctlPort: 0,
          iconFile: cfg.iconFile || undefined,
          verbose: cfg.verbose,
        }),
      }
      stream = $.process.spawn({
        argv: [cfg.nodePath, `${$.plugin.root}/host/office-host.mjs`],
        env,
      })
    } catch (e) {
      starting = false
      childAlive = false
      await update($, status, (s) => ({ ...s, isUp: false, downReason: `宿主进程起不来：${say(e)}` }))
      fireReady()
      return
    }

    let buf = ''
    try {
      for await (const chunk of stream) {
        // stderr 是人看的日志；stdout 才是协议（一行一个 JSON）
        if (chunk.stream === 'stderr') {
          const t = String(chunk.text || '').trim()
          if (t) $.ui.log(`[office] ${t}`, { to: 'debug' })
          continue
        }
        buf += String(chunk.text || '')
        let i = buf.indexOf('\n')
        while (i >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) void handleLine($, line).catch(() => { /* 单行处理出错不该把整条读循环带走 */ })
          i = buf.indexOf('\n')
        }
      }
    } catch (e) {
      $.ui.log(`【办公室】读宿主进程的输出时断了：${say(e)}`, { to: 'debug' })
    }

    // 进程没了：**不自动重启**（重启等于自动重连 —— 恢复须由人重新点「连接」）
    childAlive = false
    starting = false
    ctlPort = 0
    hostPort = ''
    await update($, status, (s) => ({
      ...s, isUp: false, ctlPort: 0, hostPort: '', connected: false, connecting: false,
      registered: false, downReason: '宿主进程退出了 —— 点「连接」重新起来',
    }))
    $.ui.log('【办公室】宿主进程退出了。要恢复，点那一行上的「连接」。')
    // ⚠️ 也得把等"起来了"的人放走 —— 否则人点了「连接」、进程又起不来时，那一下会一直挂着
    fireReady()
  })()

  return ready
}

/** 处理宿主进程写来的**一行协议**（`{"t":"wake"...}` 等）。 */
async function handleLine($: EngineInterface, line: string) {
  let m: any
  try { m = JSON.parse(line) } catch { return }
  if (!m || typeof m.t !== 'string') return

  if (m.t === 'ready') {
    childAlive = true
    starting = false
    ctlPort = Number(m.ctlPort) || 0
    hostPort = String(m.hostPort || '')
    await update($, status, (s) => ({
      ...s, isUp: true, downReason: '', ctlPort, hostPort,
      hasCard: m.hasCard === true, dataDir: String(m.dataDir || cfg.dataDir),
    }))
    fireReady()
    $.ui.log(`【办公室】接入端起来了：门牌号 ${hostPort}`)
    return
  }

  if (m.t === 'fatal') {
    starting = false
    childAlive = false
    await update($, status, (s) => ({ ...s, isUp: false, downReason: `宿主进程起不来：${String(m.error || '')}` }))
    fireReady()
    return
  }

  // ⭐ 叫醒：推的是"进来看"这条命令，**不带正文**（《说明书》§5 硬要求 2）
  if (m.t === 'wake') {
    const r = await submitWithGrace($, wakeText(String(m.why || '')))
    await ctl($, '/ctl/reply', { id: m.id, ok: r.ok, error: r.error })
    return
  }

  // ⭐ 插话：原样插进去，**插完即止、不等回话**（《说明书》§1 第 4 件）
  if (m.t === 'interrupt') {
    const text = String(m.text || '时间到了，请停')
    let res: { ok: boolean; error?: string } = { ok: true }
    try {
      // 插进**会话**（用户角色那一行，模型当轮就读得到）—— 这不是"开一轮"，所以不等它回话
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      $.ui.log(`【办公室】${text}`)
    } catch (e) {
      res = { ok: false, error: say(e) }
    }
    await ctl($, '/ctl/reply', { id: m.id, ok: res.ok, error: res.error })
  }
}

/**
 * 叫醒的**那句话**（不是正文）。内核会拿两种话来找它：
 *   · 内核自己的整段提示（起昵称那条，以 `【办公室】` 开头）⇒ **原样送**，别再套模板；
 *   · 一句"为什么叫" ⇒ 套上模板，并告诉它拿哪几个工具读。
 */
function wakeText(why: string) {
  const w = String(why || '')
  if (w.startsWith('【办公室】')) return w
  if (/叫它上线|叫你上线/.test(w)) {
    // 人在**办公室的成员卡**上点的（内核 `/dsh-office/online` 推来的）——
    // ⚠️ 这一步**只把它叫醒**，"上线"要它自己来做（《说明书》§5 online 那行）
    return '【办公室】老大在办公室叫你上线，进来自己上线。\n'
      + `· 上线：调 ${TOOL_PREFIX}presence，参数 { "presence": "online" }（绑的就是你现在这个会话）`
  }
  return `【办公室】有人找你，进来看看。${w ? `（${w}）` : ''}\n`
    + `· 读账本：${TOOL_PREFIX}read_messages　· 看任务：${TOOL_PREFIX}list_tasks　· 看自己在不在线：${TOOL_PREFIX}get_member\n`
    + `· 回话／交付／表态都在办公室里填表（${TOOL_PREFIX}send_message 等）；`
    + `派发要当场表态：接 ⇒ 发 task.ack，不接 ⇒ ${TOOL_PREFIX}refuse。`
}

/**
 * 把"进来看"投进会话。
 * ⚠️ `$.prompt.submit` 是**排队**：会话忙着就先排着，等它手上这一轮干完再开一轮 ——
 *    跟 DSH 那边 `mode:'queue'` 同义（《插件怎么写》§1 那张表）。
 * ⚠️ 只给它一段"宽限"就回话，**不等那一轮真跑起来** —— 否则办公室那条推送会干等在这儿。
 *    过了宽限还挂着 ⇒ 当"已投进队列"算；当场就报错的 ⇒ 如实说没送到。
 */
async function submitWithGrace($: EngineInterface, text: string) {
  let err = ''
  const sent = $.prompt
    .submit({ text })
    .then(() => 'started', (e: unknown) => { err = say(e); return 'failed' })
  const raced = await Promise.race([
    sent,
    $.clock.sleep(1500).then(() => 'queued'),
  ])
  if (raced === 'failed') return { ok: false, error: `叫不醒：${err}` }
  return { ok: true }
}

// ═══════════════ 读数：每 2 秒问一次宿主进程（那一行照这份画） ═══════════════

async function refresh($: EngineInterface): Promise<OfficeStatus> {
  let pageSession = ''
  try { pageSession = await $.session.id() } catch { /* 拿不到就当空 */ }

  if (!childAlive || !ctlPort) {
    const s = await read($, status)
    /** ⚠️ 名字不许叫 `next`（那是钩子的第三个参数）—— 遮蔽了验证器要拦。 */
    const nextStatus: OfficeStatus = {
      ...EMPTY_STATUS, ...s, isUp: false, ctlPort: 0, connected: false, connecting: false,
      registered: false, presence: '', pageSession,
    }
    await update($, status, () => nextStatus)
    return nextStatus
  }

  const r = await ctl($, '/ctl/state', {})
  const st = (r.data && r.data.status) || {}
  const nextStatus: OfficeStatus = {
    isUp: true,
    downReason: '',
    ctlPort,
    hostPort: String(st.hostPort || hostPort || ''),
    connected: st.connected === true,
    connecting: st.connecting === true,
    registered: st.registered === true,
    hasCard: st.hasCard === true,
    boundSessionId: String(st.boundSessionId || ''),
    pageSession,
    presence: String((r.data && r.data.presence) || ''),
    offlineReason: String((r.data && r.data.offlineReason) || ''),
    presenceErr: String((r.data && r.data.presenceErr) || ''),
    dataDir: String((r.data && r.data.dataDir) || ''),
  }
  await update($, status, () => nextStatus)
  return nextStatus
}

/** 闪一句人话（**只留 8 秒** —— 它是"上一次操作发生了什么"，不该长期占着地方）。 */
async function flash($: EngineInterface, text: string) {
  if (noteTimer) { noteTimer.cancel(); noteTimer = null }
  await update($, note, () => text || '')
  if (!text) return
  noteTimer = $.clock.after(8000, () => { void update($, note, () => '') })
}

// ═══════════════ 两个按钮干的事 ═══════════════

/**
 * 第一层：连接／断开（办公室 ↔ 插件）。**不碰绑定**，跟哪个会话无关。
 * ⚠️ 第二个参数叫 `want`、**不许叫 `on`**：`on` 是引擎的全局（注册钩子那个），
 *    拿它当形参会遮蔽掉它 —— `claude plugin validate` 会当场报错。
 */
async function doLayer1($: EngineInterface, want: boolean) {
  const busy = await read($, working)
  if (busy) return
  await update($, working, () => true)
  try {
    // 人点的"连"，顺带把宿主进程拉起来（⚠️ 最多等 10 秒：起不来就往下走，让状态自己说没连上，
    //   别把这一下永远挂在按钮上）
    if (want && !childAlive) await Promise.race([startHost($), $.clock.sleep(10000)])
    const r = await ctl($, '/ctl/layer1', { on: want })
    if (!want) {
      $.ui.log('【办公室】已断开（要恢复，得人重新点「连接」）')
    } else if (!(r.data && r.data.ok)) {
      // ⚠️ 界面只给人话（底层的 `fetch failed` 之类只进调试日志）
      $.ui.log(`【办公室】连接没成：${String((r.data && r.data.error) || r.error || '连不上办公室')}`, { to: 'debug' })
      await flash($, `连不上办公室（它没开？）`)
    }
    await refresh($)
  } catch (e) {
    await flash($, `操作失败：${say(e)}`)
  } finally {
    await update($, working, () => false)
  }
}

/** 第二层：上线／下线（插件 ↔ 该 AI）。上线 ＝ 绑**当前这个会话** ＋ 报到 ＋ 上线。 */
async function doLayer2($: EngineInterface, want: boolean) {
  const busy = await read($, working)
  if (busy) return
  const s = await read($, status)
  if (want && !s.connected) {
    // "断开 ⇒ 一定未上线"：这条路真的走不通，就把话说清楚，别装作能上
    await flash($, '还没连上办公室：得先点「连接」')
    return
  }
  await update($, working, () => true)
  try {
    if (want) {
      const sid = s.pageSession || (await $.session.id().catch(() => ''))
      if (!sid) { await flash($, '拿不到当前会话 id，上不了线'); return }
      // 顺手把"本会话当前的模型"带上（换过模型的话，这次报到就报新的）
      const r = await ctl($, '/ctl/link', { sessionId: sid, model: cfg.model || (await sessionModel($)) })
      const ok = !!(r.data && r.data.ok)
      // 成功不吭声（那一行的状态自己会变，重复念一遍是废话）；只有失败才说话
      if (!ok) await flash($, `上线失败：${String((r.data && r.data.office && r.data.office.error) || r.error || '办公室没认')}`)
    } else {
      const r = await ctl($, '/ctl/unlink', {})
      if (!(r.data && r.data.ok)) await flash($, `下线失败：${String(r.error || '说不上话')}`)
    }
    await refresh($)
  } catch (e) {
    await flash($, `操作失败：${say(e)}`)
  } finally {
    await update($, working, () => false)
  }
}

// ═══════════════ 让 AI 够得着办公室的工具 ═══════════════

/**
 * 拉一次办公室的工具表（`GET /api/tools`，**不经准入校验**的那个读口），
 * 逐个注册成本宿主的工具 —— AI 直接就能调，**表由 AI 自己进办公室填**，插件不代填。
 * （《说明书》§1 第 5 件。这一手与 DSH 那个现成插件同法：`GET /api/tools` ⇒ 注册成宿主工具）
 */
async function syncTools($: EngineInterface): Promise<boolean> {
  const r = await fetchJson($, `${cfg.officeUrl}/api/tools`)
  const list: any[] = Array.isArray(r.data?.tools) ? r.data.tools : Array.isArray(r.data) ? r.data : []
  if (!r.ok || !list.length) return false
  let added = 0
  for (const t of list) {
    const raw = String((t && t.name) || '').trim()
    if (!raw) continue
    try {
      await $.tool.register({
        name: raw,
        description: `${String((t && t.description) || raw)}（办公室工具，经接入插件转发；填表发生在办公室侧）`,
        inputSchema: (t && t.inputSchema) || { type: 'object', properties: {} },
      })
      added += 1
    } catch (e) {
      $.ui.log(`[office] 工具 ${raw} 没注册成：${say(e)}`, { to: 'debug' })
    }
  }
  toolsDone = added > 0
  if (toolsDone) {
    $.ui.log(`【办公室】已把 ${added} 个工具递上来（${TOOL_PREFIX}*）`, { to: 'debug' })
    syncTimer?.cancel()
    syncTimer = null
  }
  return toolsDone
}

/** 办公室可能还没起来 ⇒ 隔 5 秒再试，最多试 120 次（起来之后就不再打扰它）。 */
function armToolSync($: EngineInterface) {
  if (toolsDone || syncTimer) return
  syncTimer = $.clock.every(5000, () => {
    void (async () => {
      syncTries += 1
      if (syncTries > 120) { syncTimer?.cancel(); syncTimer = null; return }
      try { await syncTools($) } catch { /* 下次再试 */ }
    })()
  })
}

// ═══════════════ 接口 ═══════════════

export const register: Register = (on, options) => {
  // ── 配置（`plugin.json` 的 userConfig；每一项都有默认值，缺了也活得下去）
  const opt = (k: string) => options[k]
  cfg = {
    officeUrl: String(opt('officeUrl') ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    memberId: String(opt('memberId') ?? 'claude'),
    nick: String(opt('nick') ?? ''),
    name: String(opt('name') ?? 'Claude Code'),
    model: String(opt('model') ?? ''),
    port: Number(opt('port') ?? 19390),
    dataDir: String(opt('dataDir') ?? '~/.claude/office'),
    nodePath: String(opt('nodePath') ?? 'node'),
    iconFile: String(opt('iconFile') ?? ''),
    verbose: opt('verbose') === true,
  }

  // ── 这一世从头开始（热重载后模块是新的一份，这里再明确一次，免得读串）
  childAlive = false
  starting = false
  ctlPort = 0
  hostPort = ''
  readyWaiters = []
  noteTimer = null
  toolsDone = false
  syncTimer = null
  syncTries = 0

  on('session.start', async ($, e, next) => {
    // ⭐ **加载即打一行**（只进调试日志，不上对话）：用来回答"这一次会话里插件到底加载没有"——
    //    `-p` 那种没有界面的会话里插件什么都不做（见下面那道 `if`），没这一行就查不出来。
    $.ui.log(`[office] 插件已加载：成员 ${cfg.memberId}｜交互式=${e.isInteractive}｜来源 ${$.plugin.root}`, { to: 'debug' })
    if (e.isInteractive) {
      // ⚠️ **只把端点支起来，不连办公室**（《说明书》§8 第 6 条：加载后什么都不做）
      void startHost($).catch(() => { /* 起不来时状态自己会说 */ })
      armToolSync($)
      $.clock.every(2000, () => { void refresh($).catch(() => { /* 拉不到就保持上一次的 */ }) })
      try {
        await $.command.register({
          name: 'office',
          description: '办公室：看一眼接入状态（连着没／绑的是哪个会话／门牌号）',
        })
      } catch (e2) {
        $.ui.log(`[office] /office 没注册成：${say(e2)}`, { to: 'debug' })
      }
    }
    return next(e)
  })

  on('command.run', { command: 'office' }, async ($) => {
    await refresh($)
    const s = await read($, status)
    return {
      text: [
        `办公室接入（成员 id：${cfg.memberId}）`,
        `· 宿主进程：${s.isUp ? '在跑' : `没在跑${s.downReason ? '（' + s.downReason + '）' : ''}`}`,
        `· 第一层（办公室 ↔ 插件）：${s.connected ? '已连接' : '未连接'}`,
        `· 第二层（插件 ↔ 本 AI）：办公室说「${s.presence || '未知'}」${s.offlineReason ? `（因为：${s.offlineReason}）` : ''}`,
        `· 绑定的会话：${s.boundSessionId || '（还没有）'}`,
        `· 当前这个会话：${s.pageSession || '（拿不到）'}`,
        `· 门牌号：${s.hostPort || '（还没有）'}`,
        `· 卡与状态：${s.dataDir || cfg.dataDir}（那张卡是接入手续，别删）`,
      ].join('\n'),
    }
  })

  /**
   * ⭐ AI 调办公室工具 ⇒ 转发到控制口 ⇒ 内核 ⇒ 办公室。
   * 一处特判都不许少：
   *   · `presence`：AI 自己上线／下线走内核的 `online()`／`offline()`（**上线就绑它自己这个会话**）
   *   · `register`：**门牌号与宿主进程名由插件代报**（AI 填不出这两个值 —— 《说明书》§2 第二步）
   */
  on('tool.call', async ($, e, next) => {
    const name = String(e.tool || '')
    if (!name.startsWith(TOOL_PREFIX)) return next(e)
    const raw = name.slice(TOOL_PREFIX.length)

    // ⚠️ MCP 那一支的参数是**摊在 `e` 上的**（`e.title` 就是一个名叫 title 的参数），
    //    只有 `tool`／`tool_use_id` 是保留字段。
    const { tool: _t, tool_use_id: _u, ...args } = e as unknown as Record<string, unknown>

    // ⚠️⚠️ `result` **只能回字符串或数组**（引擎按注册时那份形状校验）。
    //    2026-10-06 实测撞到：回 MCP 那种 `{ content:[{type:'text',...}], isError }` 对象
    //    ⇒ 引擎当场拒：「expected string / array / undefined, received object」，
    //    整条调用白跑。所以：**办成了回字符串；办公室说不行 ⇒ 用 `deny`**（模型那边算"出错的结果"，正合适）。
    const done = (s: string) => ({ result: s })
    const failed = (s: string) => ({ deny: s })

    try {
      // ⚠️ 别一进来就判"没在跑"：宿主进程可能**正在起**（插件刚重载、或人刚点「连接」）。
      //    这一手与 DSH 那份现成插件同法（它的 `execute()` 头一句就是 `await ready`）。
      //    ⚠️ 注意：这里等的是**把接入端拉起来**，不是去连办公室（连办公室仍归人点，没破规矩）。
      if (!childAlive || !ctlPort) {
        await Promise.race([startHost($), $.clock.sleep(8000)])
        if (!childAlive || !ctlPort) {
          return failed('办公室接入端没在跑 —— 那一行上点「连接」把它拉起来。')
        }
      }

      if (raw === 'presence') {
        const s = await read($, status)
        if (!s.connected) {
          return failed('办公室那边是「已断开」：线断了就上不了线 —— 要连得人在会话页面上点「连接」。')
        }
        if (args.presence === 'offline') {
          const r = await ctl($, '/ctl/unlink', {})
          return done(JSON.stringify({ ok: true, office: r.data?.office ?? null }))
        }
        const sid = s.pageSession || (await $.session.id().catch(() => ''))
        if (!sid) return failed('拿不到当前会话 id，上不了线。')
        const r = await ctl($, '/ctl/link', { sessionId: sid, model: cfg.model || (await sessionModel($)) })
        const ok = !!(r.data && r.data.ok)
        await refresh($)
        if (!ok) return failed(String((r.data && r.data.office && r.data.office.error) || r.error || '办公室没认'))
        return done(JSON.stringify({ ok, boundSessionId: sid, office: r.data?.office ?? null }))
      }

      if (raw === 'register') {
        const s = await read($, status)
        args.host = s.hostPort || args.host || undefined          // 门牌号
        args.name = cfg.name                                       // 宿主进程名（代报）
        args.memberId = cfg.memberId
        args.sessionId = s.pageSession || args.sessionId || undefined
      }

      const r = await ctl($, '/ctl/call', { tool: raw, args })
      const out = r.data && r.data.result
      if (!out) return failed(`转发失败：${String(r.error || '宿主进程没回话')}`)
      if (out.ok === false) {
        return failed(String(out.error || out.notify || '办公室拒了'))
      }
      return done(JSON.stringify(out.data ?? out))
    } catch (err) {
      return failed(`转发时出错：${say(err)}`)
    }
  }).catch(($, e, next) => {
    // 这个钩子自己坏了 ⇒ 如实拒掉这一调，别让它悄悄溜到"没有这个工具"上去
    return next.called ? next(e) : { deny: `办公室接入插件转发失败（${$.plugin.name}）` }
  })

  /**
   * ⭐ 那一行：**输入框上方那一条**（《说明书》§1 第 7 件要的位置）。
   * 画什么：第一层状态 ＋ 第二层状态 ＋ **绑定三档**（《说明书》§8 第 10 条：必须显示）
   *        ＋ 门牌号／会话 ＋ **两个按钮**（各管一层）。
   */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    try {
      if (e.props.hasSurvey) return next(e)   // 问卷占着这一条时让位
      const s = await read($, status)
      const n = await read($, note)
      const busy = await read($, working)
      const { Box, Text, Button } = $.ui.resolve(e)

      const online = s.connected && s.presence === 'online' && !!s.boundSessionId
      const isHere = !!s.boundSessionId && s.boundSessionId === s.pageSession
      const away = !!s.boundSessionId && !isHere

      // 第二层那句话 —— **只在这一处算**
      const OFFLINE_TEXT: Record<string, string> = {
        self: '自己下线', heartbeat: '心跳超时', kick: '被踢下线', disconnect: '被断开连接',
      }
      let layer2: string
      if (!s.isUp) layer2 = '宿主进程没在跑'
      else if (!s.connected) layer2 = '未上线'
      else if (s.presence === 'offline') layer2 = `已离线${s.offlineReason && OFFLINE_TEXT[s.offlineReason] ? `（${OFFLINE_TEXT[s.offlineReason]}）` : ''}`
      else if (online) layer2 = isHere ? '已上线（本页面）' : '已上线（另一个会话）'
      else layer2 = '未上线'

      // ⭐ 绑定三档（《说明书》§8 第 10 条）—— "不是绑定页"那一档要**显眼**：
      //    绑定指向别的会话时，表面一切正常，人不会知道"叫醒会叫到别处去"
      const bindNote = !s.boundSessionId ? '尚未绑定' : (isHere ? '目前页面为绑定会话' : '目前页面不是绑定会话')

      const stop = (fn: () => void) => (busy ? () => undefined : fn)

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text bold>办公室</Text>
            <Text dimColor>{s.isUp ? (s.connected ? '已连接' : '未连接') : '未连接'}</Text>
            <Text dimColor={!online}>{layer2}</Text>
            {/* ⚠️ 颜色一律给个**实值**，不给 `undefined` —— 参数位置宁可显式，别让画的树被挑刺 */}
            <Text color={away ? 'warning' : 'text'} bold={away}>{bindNote}</Text>
            <Text dimColor>{s.pageSession ? s.pageSession.slice(0, 8) : '（拿不到会话 id）'}</Text>
            <Text dimColor>{s.hostPort || ''}</Text>
            {/*
              ⚠️ 两个按钮都带 `hotkey` ＋ `plain`：**命令行里鼠标点不动**（人实测过一次）——
                 带 hotkey 的 plain 按钮在终端上画成 `1: 连接` 这样，**输入框空着时直接按那个键**就能按它
                 （引擎的规矩：空输入框里一个"光秃秃的数字"会交给这一条上的按钮；
                  字母型的 hotkey 不行，那个得先 ctrl+x tab 把键盘交给这条带）。
            */}
            <Button
              key="layer1"
              label={s.connected ? '断开' : '连接'}
              hotkey="1"
              plain
              dimColor={!s.connected}
              onPress={stop(() => { void doLayer1($, !s.connected) })}
            />
            {online
              ? <Button key="layer2" label="下线" hotkey="2" plain onPress={stop(() => { void doLayer2($, false) })} />
              : <Button key="layer2" label="上线" hotkey="2" plain dimColor={!s.connected}
                  onPress={stop(() => { void doLayer2($, true) })} />}
          </Box>
          {n ? <Text dimColor>{n}</Text> : null}
          {!s.isUp && s.downReason ? <Text color="warning">{s.downReason}</Text> : null}
          {s.presenceErr ? <Text dimColor>{s.presenceErr}</Text> : null}
        </Box>
      )
    } catch (err) {
      $.ui.log(`[office] 那一行没画出来：${say(err)}`, { to: 'debug' })
      return next(e)
    }
  })
}

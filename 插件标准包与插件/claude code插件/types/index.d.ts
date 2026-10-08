/**
 * 办公室接入插件（office）在 `$.state` 里存的那几个值 —— **契约**。
 *
 * 出处：《插件标准包与插件》的《说明书》§8 第 9、10 条 ——
 *   「一侧已点，另一侧同步变化（两侧读同一份状态，不得各存一份）」
 *   「界面可分辨【当前页是否为已绑定的会话】」
 * 于是这一行的读数**只有一份**：插件每 2 秒向宿主侧那个常驻进程拉一次，写进这里的 `status`，
 * 画的那些地方读它 —— 不允许在别处再算一遍状态。
 *
 * 命名规矩（官方契约的写法，见标准包 `插件怎么写.md` §2.1 提到的 mod）：
 * 每个值按插件名（`plugin.json` 的 `name` ＝ `office`）收在 `PluginState` 底下。
 */

/** 那一行要显示的全部读数（一次 `/ctl/state` 的回话 ＋ 本地几个判据）。 */
export type OfficeStatus = {
  /** 宿主侧那个常驻进程还在不在。不在 ⇒ 下面各项一律无意义（按"未连接"显示）。 */
  isUp: boolean
  /** 起不来的原因（人话，直接画在界面上）。 */
  downReason: string
  /** 控制口端口（宿主进程自己挑的空闲端口；0 ＝ 还没起来）。 */
  ctlPort: number
  /** 门牌号：内核反向端点的 `主机:端口`，报到时交给办公室的那个。 */
  hostPort: string
  /** 第一层：「那条常驻连接」**真的**挂着没有（不是"人点过没有"）。 */
  connected: boolean
  /** 正在试连（按钮该灰的窗口期）。 */
  connecting: boolean
  /** 报到过没有（线断了就得重报）。 */
  registered: boolean
  /** 本地那张**接入手续卡**在不在 —— 卡在，重连时才带得上（卡丢了会被办公室当场回绝）。 */
  hasCard: boolean
  /** 第二层：绑着哪个会话（内核记的"上一次绑过的"，下线**不清**它）。 */
  boundSessionId: string
  /** 当前这个会话的 id（人点「上线」就绑它）。 */
  pageSession: string
  /** 办公室说的在线状态（**权威在办公室**，不是插件自己记的）。 */
  presence: string
  /** 离线原因（`self`／`heartbeat`／`kick`／`disconnect`），给界面写"因为什么离的"。 */
  offlineReason: string
  /** 查在线状态时的错因（诊断用，平时是空串）。 */
  presenceErr: string
  /** 卡与状态落盘的目录（**里面有那张卡，别删**）。 */
  dataDir: string
}

declare module 'claude-code' {
  interface PluginState {
    office: {
      /** 那一行的读数（只有一份）。 */
      status: OfficeStatus
      /** 最近一次操作的回话（给人看的；只留 8 秒）。 */
      note: string
      /** 手上正有一次操作在跑（按钮防连点）。 */
      working: boolean
    }
  }
}

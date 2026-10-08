# office-zcode —— 将 ZCode 接入「办公室」

> 依据：《插件标准包》之《说明书》与内核 `office-bridge.mjs`（**逐字节照搬、未改一字**，md5 见 §七）。
> 定位：位于「办公室」与 ZCode 的一个会话之间 —— 为该 AI 维持常驻连接、接收办公室推送的叫醒、
> 被叫起执行任务、将办公室的工具递至其面前（**表格由 AI 在办公室侧自行填写**，插件不代填）。
>
> 同一标准另有 Claude Code 实现（存于开发工作区，本交付件不含）——本插件**结构参照它**，
> 但**宿主 API 未照抄任何一条**：`$.prompt.submit`／`$.session.append`／`ui.render`／`$.tool.register`
> 为 Claude Code 专有，ZCode 不具备，替代落点见 §六。

**术语速查**：

| 词 | 含义 |
| --- | --- |
| **办公室** | 一套多 agent 协作台：一个人（系统内身份 `boss`）与若干 AI 在其中派发、执行、交付（《说明书》§0） |
| **两半** | 「**插件 ↔ 办公室**」（HTTP 协议，标准包确定）＋「**宿主 ↔ 插件**」（各宿主自定）。本插件两半齐备 |
| **常驻进程** | `host/office-host.mjs`：一个后台 node 进程，内核运行其中（§二 说明其必要性） |
| **门牌号** | 办公室**反向定位插件**的地址（`127.0.0.1:<端口>`，内核自建的反向端点，《说明书》§2 第四步） |
| **连接／上线** | 两层，各自独立。**连接**＝办公室与插件之间的链路；**上线**＝将某个会话绑定至办公室（《说明书》§1 第 7 件） |

---

## 一、先读此节：代价、前提、边界

**需承担的代价**（均为设计使然，非缺陷）：

| 代价 | 原因 |
| --- | --- |
| **需人工操作**，AI 无法自行上线 | 《说明书》§1 第 7 件：连接与上线由人控制；§8 第 6／7 条：不自动连接、断开后不自行重挂 |
| **多一个常驻进程**（一个 node 进程 ＋ 一个监听端口） | 常驻连接为 SSE，五个反向端点需要持续监听端口（§二） |
| **每次执行斜杠命令消耗一轮模型调用** | ZCode 的斜杠命令是**提示模板**（发送给 AI 执行），不是「立即执行函数」式按钮 —— 人执行 `/office-connect` 后由 AI 调用工具 |
| **每条输入增加一次本机通信** | UserPromptSubmit 钩子会向控制口上报一次「当前会话」（本机 POST，通常小于 50ms） |
| **`dataDir` 中的状态文件不可删除** | 其中存有**接入手续卡**：对已建卡的 id，办公室要求接入时必须携带，缺失将被当场拒绝 |

**前提**：

- 办公室后端正在运行（默认 `http://127.0.0.1:8787`，《说明书》§3）。本机成员 `zcode` 已实际接入该办公室并在线（会话绑定，见 §十）。
- `node` 在 PATH 上（否则把 §五 配置里的 `nodePath` 改成绝对路径）。
- ZCode CLI 入口（`zcodePath`）—— **默认留空，须按你的机器配置**（见 §五）。
- ZCode 登录可用 —— 叫醒那一轮是真实运行一个 `-p` 会话，无模型配额则无法叫起。

**边界（何种情况下不成立）**：

- 在 **ZCode 0.16.9**（本机 `zcode version` 结果）上开发，并**已装入真实客户端、对真实办公室完成验证**（范围见 §十）；更换版本需重新确认。
- **「插话」在 ZCode 上是降级实现**（§七 ③）——《说明书》§7 规定「不能插话的接入方式不予考虑」，该条**未完全满足**，如实注明。
- 单会话假设：同一台机器同时开启多个 ZCode 窗口时，「当前会话」以**最近一次上报的**为准（§七 ⑤）。

---

## 二、插件构成：两半

标准包 README 将工作拆为两段，本插件的两半各管一段：

| 段 | 规则来源 | 本插件中的实现 |
| --- | --- | --- |
| **插件 ↔ 办公室** | **标准包规定**（一套 HTTP，仅此一套） | **`kernel/office-bridge.mjs`** —— 标准包内核，**逐字节照搬、未改一字** |
| **宿主 ↔ 插件** | **各宿主不同，标准包不规定** | **`host/` 三个模块 ＋ `hooks/` ＋ `.mcp.json` ＋ `commands/`** |

```
交付件\
├─ marketplace.json                # 本地市场清单（市场根）
└─ plugins\office-zcode\
   ├─ .zcode-plugin\plugin.json    # 插件 manifest（ZCode 识别的第一优先级形态）
   ├─ .mcp.json                    # 声明 MCP 服务器「office」→ 工具暴露为 mcp__plugin_office-zcode_office__*
   ├─ kernel\office-bridge.mjs     # 标准包内核（照搬；md5 见 §七）
   ├─ kernel\自测.mjs              # 标准包的内核自测（原样保留，已执行通过）
   ├─ host\
   │  ├─ office-host.mjs           # 常驻进程：内核 ＋ 控制口 ＋ 调 CLI 叫醒／投递
   │  ├─ office-config.mjs         # 配置解析（hook／常驻进程／MCP 三方共用）
   │  ├─ office-runtime.mjs        # 定位常驻进程、与控制口通信、拉起它（hook／MCP 共用）
   │  └─ office-mcp.mjs            # MCP stdio 服务器：办公室工具 ＋ 接入控制工具
   ├─ hooks\
   │  ├─ hooks.json                # SessionStart ＋ UserPromptSubmit 两个钩子
   │  └─ session-start.mjs         # 上报「当前会话」给常驻进程；SessionStart 时负责拉起它
   ├─ commands\                    # 五个斜杠命令（「两个按钮」在 ZCode 上的落点）
   │  ├─ office-connect.md         ├─ office-disconnect.md
   │  ├─ office-online.md          ├─ office-offline.md
   │  └─ office-status.md
   ├─ test\host-self-check.mjs     # 自测：假办公室完整驱动常驻进程＋hook＋MCP
   └─ README.md                    # 本文件
```

**为什么需要常驻进程**（与参照插件同一理由）：常驻连接是 **SSE**（持续读取、永不结束），
五个反向端点**需要有人监听一个端口** —— ZCode 的钩子与 MCP 服务器都是**按事件或请求拉起的子进程**，
无法持有不结束的流，也无法保证长期存活。⇒ 协议全部在常驻进程中，钩子与 MCP 仅执行
「上报会话、执行按钮动作、转发工具」。

**各方如何定位常驻进程**：它启动后将 `{pid, ctlPort, hostPort}` 写入数据目录的 `office-runtime.json`
（ZCode 没有「插件模块」可以替它读取 stdout，参照插件的 stdout 协议在此换为**运行时指针文件**）。

---

## 三、安装

装机记录（实际命令与输出）：

```
> zcode plugins marketplace add "<本包所在目录>"
Added marketplace dev-office-zcode (1 plugins)

> zcode plugins install office-zcode@dev-office-zcode
Installed plugin office-zcode@dev-office-zcode (0.1.0) [enabled]

> zcode plugins update office-zcode@dev-office-zcode      ← 工具名前缀更正后升至 0.1.1
Updated plugin office-zcode@dev-office-zcode from 0.1.0 to 0.1.1. Restart zcode to apply.
```

（0.2.0 起另需注意：版本号提升后执行 `plugins update`，缓存切换至新版本目录
`C:\Users\<用户名>\.zcode\cli\plugins\cache\dev-office-zcode\office-zcode\<版本>\`；随后**完整重启客户端**，
并**终止旧常驻进程** —— 读 `~/.office-zcode/office-runtime.json` 的 `pid` 将其结束，下次会话启动钩子
会从新版目录重新拉起。常驻进程为 detached 进程，不随客户端退出，不终止它则新版永远不会生效。）

客户端内等价操作：**插件市场 → 添加 → 添加插件市场**，粘贴本目录；再到 **个人 → dev-office-zcode → 办公室接入 → 安装**。

**核对与卸载**：`plugins list` 应列出 `office-zcode@dev-office-zcode [enabled]`（统计行的 `commands: 1` 为计数假象，
以 `commands list` 为准，其中有全部 5 个）；卸载执行 `plugins uninstall office-zcode@dev-office-zcode`。
数据目录 `~/.office-zcode` 卸载后**不会自动删除**（其中的卡是接入手续 —— 更换成员 id 重新接入时才删除）。

**安装后验证**（全部通过，记录见 §十）：钩子真实触发、常驻进程真实拉起、工具列表出现
`mcp__plugin_office-zcode_office__*`、5 个命令注册，并对真实办公室跑通连接／上线／叫醒推送／插话。

---

## 四、使用方式：五个斜杠命令

《说明书》§1 第 7 件要求的「输入框上方两个按钮」，在 ZCode 上**没有该渲染位**（参照插件的 `ui.render`/`AbovePrompt`
为 Claude Code 专有 API）⇒ 按《任务说明》第四节的落点，**换为斜杠命令**：

| 命令 | 层级 | 作用 |
| --- | --- | --- |
| `/office-connect` | 第一层 | 建立与办公室之间的常驻连接。**不涉及绑定** |
| `/office-disconnect` | 第一层 | 断开该连接。**不会自动重连**，恢复需再次执行 `/office-connect` |
| `/office-online` | 第二层 | 将**当前会话**绑定至办公室 ＋ 报到 ＋ 上线（需先连接） |
| `/office-offline` | 第二层 | 仅撤销「在岗」，**不解除绑定**（地址保留，办公室仍可执行「叫它上线」） |
| `/office-status` | —— | 状态一览（连接状态／绑定的会话／门牌号／报到身份）。出现问题时先查看它 |

**执行方式**：在会话输入框中输入命令。它会作为提示发送给 AI，由 AI 调用对应的 `mcp__plugin_office-zcode_office__*`
工具并回报结果 —— 因此**每次执行消耗一轮模型调用**，这点与参照插件「不等 AI」的按钮不同，由 ZCode 机制决定。
另经实测确认：**斜杠命令的展开属于 TUI 侧行为** —— `zcode -p "/office-connect"` **不会展开**，字面量直接进入对话；
在 headless 中执行相同动作，需将命令文件正文作为提示发送（TUI 内输入命令不受影响）。

**另一条路径**：AI 也可直接调用这五个工具（它们已暴露在工具列表中）。办公室推送 wake 叫醒时，
AI 在被叫醒的回合内即可自行执行 `office_online`。

**绑定状态必须可见**（《说明书》§8 第 10 条）—— `/office-status` 的返回中始终包含
「绑定的会话」与「当前会话」两行：两者相同＝绑定正确；不同＝**叫醒会叫到别的会话**（它使用 headless 恢复，见 §七 ②）。

---

## 五、配置

配置文件：`~/.office-zcode/office-config.json`（不存在则新建；**修改后需重启常驻进程** ——
读取 `~/.office-zcode/office-runtime.json` 中的 `pid` 将其结束，下次会话启动钩子会重新拉起）。
每项均有默认值，全部不填也可运行：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `base` | `http://127.0.0.1:8787` | 办公室后端地址（《说明书》§3） |
| `memberId` | `zcode` | 在办公室中的身份。格式 `^[a-z][a-z0-9_-]{0,31}$`（《说明书》§2 第二步），**报到时确定且不可变更** |
| `nick` | 空 | 昵称。可留空 —— 首次建卡时内核会提示 AI 一次，AI 也可自行修改 |
| `name` | `ZCode` | **宿主进程名**（产品名写法，非可执行文件名）。由插件代报，AI 不可修改 |
| `model` | 空 | 报到时上报的模型名（如 `GLM-5.3-Flash`）。**填写后照报，留空＝不报该项**（办公室卡上保留旧值）。既定决策：不在宿主内做自动探测 —— 该项仅为一格显示标签，不宜为此引入对会话文件路径的依赖 |
| `port` | `19400` | 门牌号端口。固定住才跨重启不漂移；被占用时**先重试两次再退让**（会写日志） |
| `nodePath` | `node` | 启动常驻进程／投递使用的 node；PATH 中没有则填绝对路径 |
| `zcodePath` | （空） | ZCode CLI 入口（node 直接运行的 cjs）。**须按你的机器配置**。也可用环境变量 `ZCODE_CLI_PATH` |
| `mode` | 空 | 传给唤醒 CLI 的 `--mode`；空＝不传（CLI 对 `-p` 的默认值为 **yolo**） |
| `iconFile` | 空 | 头像 PNG 路径，提交其 base64。**留空＝自动取宿主安装目录自带的应用图标**（0.2.0：由 `zcodePath` 反推安装目录取 `resources\icon.png`，缺失时退至 `icon_windows.png`，再退至 PowerShell 抽取宿主 exe 图标） |
| `wakeGraceMs` | `15000` | 唤醒 CLI 的宽限毫秒（语义见 §七 ⑥） |
| `dataDir` | `~/.office-zcode` | 卡与运行时指针落盘处。其中的接入手续卡**不可删除** |
| `verbose` | 关 | 开启后常驻进程日志写入 stderr |

凭据：**本插件不需要任何密钥**（办公室为本机 HTTP）；以上没有任何一项需要填写令牌。

---

## 六、《说明书》七件事的落点

| # | 要求（《说明书》§1） | 本插件的实现 |
| --- | --- | --- |
| 1 | 维持一条常驻连接 | 内核建立 `GET /api/alive`（SSE，`connectOnce()`）；**断开后不自行重挂** |
| 2 | 能收 | 内核接收办公室推送的全部内容；`wake`／`interrupt` 由常驻进程直接处理（无需再转发 —— ZCode 的「唤醒」即一条 CLI 命令） |
| 3 | 能唤醒 | 收到 `wake` ⇒ `node <zcode.cjs> -p "<进来看看>" --resume <绑定的会话id> --json`。**下推的仅为「进来看看」命令、不带正文**（§5 硬要求 2） |
| 4 | 能插话 | **降级**：ZCode 没有「插入正在运行的回合」的接口 ⇒ 经同一条 CLI 路径排队投递，README 如实注明「**这不是插话**」（§七 ③） |
| 5 | 让 AI 够得着工具 | `.mcp.json` 声明 MCP 服务器；`tools/list` 时实时拉取 `GET /api/tools`，`tools/call` 时经控制口转发。**表格填写发生在办公室侧**（§1 第 5 件） |
| 6 | 报到 | 内核上报 id／会话；**门牌号与宿主进程名由插件代报**（`office-mcp.mjs` 对 `register` 特判 —— AI 无法得知这两个值）；头像自 0.2.0 起自动取宿主自带应用图标（`iconFile` 可覆盖）；model 走 `model` 配置项，填写后照报 |
| 7 | 两个按钮 | 五个斜杠命令（§四）。ZCode 没有「输入框上方那条带」渲染位 |

五个反向端点（`/dsh-office/wake`／`interrupt`／`online`／`connect`／`challenge`）全部在内核中，数量不多不少。

**AI 侧的工具名称**：办公室侧名为 `send_message`，在本宿主中为 **`mcp__plugin_office-zcode_office__send_message`**。
（真机实测更正：原按 Claude Code 命名规则推定的 `mcp__office__*` 不成立 —— ZCode 对**插件提供的**
MCP 服务器在中间附加一段 —— 实际名称＝`mcp__plugin_<插件id>_<服务器名>__<工具名>`，本插件即
`mcp__plugin_office-zcode_office__*`。安装副本与 0.1.1 起的唤醒文案均已按实际名称更正。）

---

## 七、需要明确说明的事项

**① 内核为照搬，可自行核对**

```
字节数 17433 ／ md5 d98e5f39b0504f740adee900409539ba
```

（本插件 `kernel/office-bridge.mjs` 与标准包 `素材\office-bridge.mjs` md5 相同；`kernel/自测.mjs` 亦为原样保留。）

**② 叫醒 ＝ headless 恢复一个会话**。`zcode -p "…" --resume <id>` 会**另起一个新进程**延续该会话
（本机实测：错误会话 id 当场报错、退出码 1）。这与 Claude Code「将内容投进运行中的会话」**不是同一件事**：
被叫醒的回合运行于一个不可见的后台进程，**不在任何打开的 TUI 中**。绑定指向哪个会话，叫醒即恢复哪个 ——
`/office-status` 可对照。
实测更正：headless 回合在免费额度（`account:zai-start-plan`）下**被服务端拒绝**：`turn.failed`／
`coding plan is required`（该报错在 `zcode.cjs` 中 0 命中 ⇒ 来自服务端）—— 机制层面已验证「进程启动、
`session.resumed` 且 sessionId 正确」；回合要真实完成需 **Coding Plan 档位**。早期「resume 后模型答出
上一轮内容」的观察不再作为依据，详见交付件《验收到哪一步.md》。

**③ 插话是降级实现，不是插话**。`interrupt` 推送的「时间到了，请停」经**同一条 CLI 路径**排队投递 ——
排在 AI 当前回合**之后**，不会立即打断。《说明书》§7 将「能插话」列为硬要求；ZCode 上无法做到，
这是本插件**已知且如实标注的差距**（能收到、能投递，但「不等回话地插入当前回合」不成立）。

**④ 叫醒「是否送达」是真实查询的结果，非臆断**：CLI 宽限内非 0 退出 ⇒ 办公室收到
`{ok:false, error}`（含 stderr 尾部，如 "Session not found"）；宽限（默认 15 秒）内未退出或退出码 0 ⇒ `{ok:true}`。
「叫它上线」投递失败时内核返回 `{ok:false, error:"上线异常…"}`（《说明书》§5 要求的形状），办公室据此显示「上线异常」。
已知局限：该回合**此后**才失败的情形，此处已答复 ok —— 与参照插件 1.5 秒宽限为同一局限。

**⑤ 「当前会话」由钩子上报，非推测**：SessionStart 与 UserPromptSubmit 均会将 `session_id`
上报给常驻进程（钩子输入契约中有该字段 —— 已在 zcode.cjs 源码中核实），`/office-online` 绑定的即
**最近上报的那个**。单窗口使用无歧义；**多窗口同时开启时以最近输入命令的会话为准** —— 执行
`/office-online` 的会话必然是最近的，因此「命令在哪执行就绑定哪」仍然成立。

**⑥ 状态文件不可删除**。`~/.office-zcode/office-bridge-state.json` 存有**接入手续卡**：
对已建卡的 id，办公室要求接入时必须携带，缺失将被当场拒绝（标准包自测的文件头记录有该次实测）。

**⑦ 单实例**：数据目录相同的常驻进程仅有一个（后启动者见到存活的新鲜指针即自行退出）；
固定门牌号端口被占用时先重试两次再退让 —— 退让后门牌号变更一次，需等待下一次报到办公室方能定位。

**⑧ 叫醒推送以「已连接」为前提**（办公室侧行为，与参照插件同款）：未连接时办公室进入 `silent`，
消息照常入账，待其连接后自行读取 —— 插件侧不需要也不会「补叫」。

---

## 八、版本与运行环境

| 项 | 值 | 出处 |
| --- | --- | --- |
| **ZCode** | 0.16.9 | `zcode version`（本机） |
| **CLI 入口** | zcode 安装目录下的 `resources\glm\zcode.cjs`（约 14 MB） | `ls -l`；`plugins validate` 全程使用它 |
| **Node** | v22.23.3（在 PATH 上） | `node -v` |
| **内核** | `kernel/office-bridge.mjs` **17433 字节**，md5 **d98e5f39b0504f740adee900409539ba** | `wc -c`／`md5sum`，与标准包同值 |
| **标准包版本** | 《说明书》0.1 ／《插件怎么写》0.2 | 各文件头部 |

复核命令：

```bash
node -v
node "<zcode 安装目录>\resources\glm\zcode.cjs" version
cd plugins/office-zcode && wc -c < kernel/office-bridge.mjs && md5sum kernel/office-bridge.mjs
```

---

## 九、自测

```bash
cd plugins/office-zcode
node kernel/自测.mjs          # 内核部分（标准包原样）：22 条判据
node test/host-self-check.mjs # 宿主部分：57 条判据
```

两套均**起一个假办公室**（不触碰真实办公室的任何数据）。宿主一套完整驱动常驻进程、**真实 hook 脚本**、
**真实 MCP 服务器进程**：连接状态、绑定状态、五个反向端点的应答、断开后是否自行重挂、卡是否落盘、
hook 是否上报会话、MCP 的 initialize／tools/list／tools/call 是否可用、
投递失败时办公室能否收到「未送达」。退出码 0 ＝ 全部通过。

改动后还需通过：

```bash
node "<zcode 安装目录>\resources\glm\zcode.cjs" plugins validate plugins/office-zcode
```

---

## 十、验证记录（如实记录）

离线验证全部完成；并已装入真实客户端（ZCode 0.16.9）、对真实办公室（127.0.0.1:8787）跑通接入全流程。分四段记录：

### 离线自测（全部实际执行）

| 验证项 | 验证方式 | 结果 |
| --- | --- | --- |
| 「插件 ↔ 办公室」协议层 | 标准包内核 ＋ 其 `自测.mjs` | **22 通过 / 0 未通过**；内核未改（md5 与标准包一致） |
| 宿主部分（常驻进程 ＋ 控制口 ＋ 五端点 ＋ 运行时指针） | `test/host-self-check.mjs`（假办公室） | **57 通过 / 0 未通过** |
| hook 脚本（真实脚本、真实 stdin 契约） | 同上：输入 `{"hook_event_name":"SessionStart","session_id":…}` | 退出码 0、stdout 全空、「当前会话」进入状态 |
| MCP 服务器（真实进程、stdio） | 同上：initialize／tools/list／tools/call | 协议握手、工具清单（5 控制 ＋ 办公室实时拉取）、转发与错误回传全部通过 |
| manifest ＋ 资源声明 | `zcode plugins validate` | **Plugin manifest is valid**，0 条诊断 |
| 投递失败语义 | 同上：投递写入失败场景 | 办公室收到 `{ok:false}`；「叫它上线」收到 `{ok:false, error:"上线异常…"}` |

### CLI 层手工实测（实际执行）

| 验证项 | 实测情况 |
| --- | --- |
| `-p --json` 建会话 | 返回 `sessionId: "sess_…"` 与 `response`（JSON 形状即宿主投递解析依赖的那份） |
| **`-p --resume <id> -p 文本`（＝叫醒）** | 同一 `sessionId` 续上。实测更正：早期「模型答出了上一轮内容」的观察**不再作为依据** —— 后续实测：免费额度下该回合 `turn.failed`、服务端返回 `coding plan is required`，**未验证**（需 Coding Plan 档位） |
| resume 错误会话 id | 当场 `Error: Session not found` ＋ 退出码 1 —— 宿主「如实报告失败」依赖此行为 |
| `${ZCODE_SESSION_ID}` 不能进入 `.mcp.json` | `plugins validate` 报 `plugin_variable_missing` ⇒ 已从声明中移除（「当前会话」仅依赖钩子一条路径，更为简洁） |

### 真机实测（ZCode 0.16.9 · 真实办公室 127.0.0.1:8787 · 专用会话 `sess_eb3d8327-85b5-4400-bc62-b1ea8701ab68`）

安装：`plugins marketplace add "<本包所在目录>"` → `Added marketplace dev-office-zcode (1 plugins)`；
`plugins install office-zcode@dev-office-zcode` → `Installed … (0.1.0) [enabled]`；前缀更正后 `plugins update` → `Updated … from 0.1.0 to 0.1.1`。

| 验证项 | 实测情况 |
| --- | --- |
| **五个命令文件注册** | `commands list` 列出全部 5 个 `/office-*`（connect/disconnect/online/offline/status），指向安装副本。注意 `plugins list` 的统计行写 `commands: 1` —— 属统计口不识别插件命令的计数假象（与参照插件 README 记录过的 "Hooks (0)" 同类） |
| **钩子真实触发** | headless 新会话启动后，`~/.office-zcode/office-runtime.json` 出现；`/ctl/state` 的 `currentSessionId` ＝ 该会话 id —— **仅 hook 会上报该字段**（当时该会话未调用过任何工具，排除了 MCP 兜底拉起） |
| **常驻进程真实拉起** | `office-runtime.json` 的 pid 对应存活的 node.exe；进程命令行核实运行的是安装副本（0.1.1 更新后实测 `…\0.1.1\host\office-host.mjs`）；陈旧指针（旧进程被强制终止）被新实例正确接管，门牌号仍固定 `19400` 不漂移 |
| **mcp__office\* 工具出现在工具列表** | 工具**存在**，但实际名称为 **`mcp__plugin_office-zcode_office__*`**（见 §六更正）；会话 AI 实测可列出并调用 |
| `/office-connect`（经命令正文） | AI 调用 `office_connect` ⇒ 真实连接：控制口 `connected:true`；办公室 `/api/state` `aliveConns` 1→2，`zcode` 上卡（probe 起初为 "n/a：还没有门牌号"） |
| `/office-online`（经命令正文） | AI 调用 `office_online` ⇒ **上线＋报到全部通过**：办公室成员卡 `id:"zcode", name:"ZCode"（插件代报）, host:"127.0.0.1:19400"（门牌号，插件代报）, presence:"online", connected:true`；**办公室侧探活 probe 由 "n/a" 变 "ok"**（办公室实际请求过 challenge 端点）；卡落盘 `~/.office-zcode/office-bridge-state.json` |
| **叫醒（办公室 → 插件 → AI 当回合可见）** | 向门牌号 `/dsh-office/wake` POST ⇒ `{ok:true}` ⇒ AI **当回合看到「进来看看」原文**（前缀已为实际名称），随即读取真实办公室的 `read_messages`／`list_tasks`／`get_member`／`pending_alerts`／`read_log`，账本 0 条 ⇒ 如实回复「没有可回的内容」，未误发消息 |
| **插话逐字到达** | `/dsh-office/interrupt` ⇒ `{ok:true}` ⇒ 会话中逐字出现「时间到了，请停」（7 字全部为正常汉字，无替换符）—— 排队投递语义（非打断），见 §七 ③ |
| 防止成员串用 | 错误成员推送 wake ⇒ `{ok:false, error:"推来的成员与本接入端不符（someone-else）"}` |

### 真机实测发现并已修正的问题

| # | 现象 | 根因 | 修正（0.1.1） |
| --- | --- | --- | --- |
| 1 | 工具实际名称与文案不符：实际为 `mcp__plugin_office-zcode_office__*` | Claude Code 的命名规则（`mcp__<服务器>__<工具>`）系推定；ZCode 对插件 MCP 服务器附加 `plugin_<插件id>_` 一段 | 唤醒文案改用实际前缀；5 个命令文件全文替换；README 更正 |
| 2 | `-p "/office-status"` 未执行命令，AI 将其当作路径检索 | **斜杠命令展开属 TUI 侧行为**，headless `-p` 不展开 | 如实记入 §四；headless 验证改发命令正文 |

（测试通道自身的一段插曲，与插件无关但需引以为戒：使用 Windows 原生 `curl -d '中文'` 请求反向端点时，
命令行中的中文按 GBK 发出 ⇒ 插件按 UTF-8 解为乱码；改用 node fetch／文件载荷后逐字到达。协议链路本身无编码问题。）

### 第二轮（0.2.0）：成员卡 model／icon 修正

验收发现成员卡两处不符：`icon: null`（《说明书》§2 第二步「第一次上线必须交头像」未落实）、
`model: "deepseek-flash"`（实际模型为 GLM-5.3-Flash）。根因与修正：

| # | 现象 | 根因 | 修正（0.2.0） |
| --- | --- | --- | --- |
| 1 | 卡上 icon 为空 | 0.1.1 仅识别手工配置的 `iconFile`，而配置文件不存在 ⇒ 报到永远不提交头像 | 三级来源：`iconFile` 显式配置 → **自动取宿主自带应用图标**（`zcodePath` 反推安装目录取 `resources\icon.png`，缺失时退至 `icon_windows.png`；自动选取时做 PNG 魔数校验 —— 界面写死 `data:image/png;base64,`）→ PowerShell 抽取宿主 exe 图标（DSH 参照插件同款，异步执行）。本机实际命中：宿主安装目录下的 `resources\icon.png`（215 KB ⇒ base64 约 28.7 万字符，低于办公室 51.2 万上限） |
| 2 | 卡上 model 为 `deepseek-flash` | 插件从不上报 model（默认空＝不报该项）；卡上该值来自**早前某次 AI 手工调用 register 工具时携带的值** —— 办公室侧 `cards[].model` 的唯一写入路径是 register 的 `args.model`（`bridge.js` → `reportIdentity`），宿主侧从不传递；日志为空无法完全指认，但代码路径上这是唯一来源 | **采用配置项方案**：`model` 即配置项，填写后照报；已在 `~/.office-zcode/office-config.json` 写入 `{"model": "GLM-5.3-Flash"}`（值来自 rollout 流水的实测证据）。中途曾实现「宿主内扫描 model-io 流水自动探测」，经评审移除 —— 理由：为一格显示标签引入对会话文件路径的脆弱依赖，收益不成立 |

顺带增加的可见性：`/office-status` 新增「报到身份」一行，显示**下次报到将提交的** model 与 icon 字符数
（控制口 `/ctl/state` 的 `report` 字段）。

**验证（全部实际执行）**：内核自测 22 通过/0 未通过；宿主自测 57 通过/0 未通过（新增判据：报到携带 icon＝宿主图标 base64 原样、
报到携带 model＝配置值照报、`/ctl/state` 的 report 两格、icon.png 缺失时自动退至 `icon_windows.png`）；
`plugins validate` 通过；内核 md5 仍为 `d98e5f39…`（未改一字）。

**0.2.0 真机验收**：客户端完整重启、常驻进程从 0.2.0 安装副本重新拉起后，GUI 会话执行 `/office-online`
重新报到 ⇒ `get_member` 实测：卡上 `model: "GLM-5.3-Flash"`、`icon` 非空（`iVBORw0KGgo…`，
约 28.7 万字符）—— 旧错误值 `deepseek-flash` 被覆盖。

### 尚未验证的项

| 项 | 说明 |
| --- | --- |
| **叫醒的端到端** | headless 回合在免费额度下被服务端拒绝（`coding plan is required`）—— 机制（进程启动、会话恢复）已验证，端到端需 **Coding Plan 档位**；为最重要的未验证项，详见交付件《验收到哪一步.md》 |
| TUI 侧的体验 | 斜杠命令在交互界面的展开、`/mcp` 面板显示、命令执行手感 —— 均需**人工重启客户端后在 TUI 中**验证（headless 无法验证界面）；`plugins update` 也提示 "Restart zcode to apply"，交互端使用前先完整重启一次客户端 |
| **真实任务的端到端** | 由其他成员（如 `fish` 或 `boss`）向 `zcode` 派发一件任务 ⇒ 5 分钟内 `task.ack` ⇒ 执行 ⇒ `my_dirs` 交付 ⇒ 验收 —— 需办公室侧配合，单靠插件自验无法覆盖 |
| 插话的**打断效果** | 已验证的是「该内容逐字进入会话、AI 当回合读到」；对正在运行的回合**没有**打断作用（排队投递，§七 ③ 的已知差距） |
| 多窗口 | 同机开启多个 ZCode 会话时「当前会话」取最近上报者 —— 设计如此，未在多窗口下实测 |
| 叫醒时该会话正被 TUI 打开 | headless `--resume` 与 TUI 同写一个会话是否冲突 —— 未验证（验证过程全程使用专用会话的 headless 恢复，无 TUI 同开） |
| 昵称提示的自动叫醒 | 内核首次建卡会自动叫醒一次「设置昵称」；真机验证时预置 `nickHinted:true` 将其关闭（避免在回合进行中嵌套叫醒），该路径仅由内核自测覆盖 |
| PowerShell 抽取图标后备来源 | 三级来源的前两级自测已覆盖；第三级（`ExtractAssociatedIcon`）本机未实际触发 —— `resources\icon.png` 直接命中 |
| `model` 留空的语义 | 留空＝不报该项、办公室卡上**保留旧值**（`reportIdentity` 仅在非空时覆盖）—— 办公室侧行为，未实测 |

---

## 修订记录

- 0.2.0（2026-10-07）：成员卡报到身份修正（model 改为配置项照报、icon 自动取宿主应用图标）；`/office-status` 增加报到身份展示；宿主自测扩至 57 条判据；0.2.0 真机验收通过；补记叫醒端到端在免费额度下未验证的更正。
- 0.1.1（2026-10-07）：工具实际名称与唤醒文案更正为 `mcp__plugin_office-zcode_office__*`；5 个命令文件同步更正；README 更正。
- 0.1.0（2026-10-07）：首版。

---

> ⚠️ **第三方插件**：与 Anthropic、OpenAI、深度求索等厂商均无隶属或背书关系；文中出现的产品名称仅为指称对应产品之用。

# office-desktop 交付说明 —— 将 Claude Desktop 的代码选项卡接入「办公室」

插件版本 0.1.0。本插件是多 agent 协作台「办公室」的 **Claude Desktop 接入端**：为代码选项卡里的 AI
维持与办公室之间的常驻连接（SSE）、接收办公室推送的叫醒、被叫起执行任务、将办公室的工具递至其面前，
并在**输入框上方那一条带**上画「连接／断开」与「上线／下线」两个按钮。成员 id 为 `claude-desktop`。
插件由 Claude Desktop 侧完成编写与验证。

## 文件导读

| 文件 | 说明 |
| --- | --- |
| `marketplace.json` | 插件市场清单（根目录副本，与应用真正读的那份一字不差） |
| `.claude-plugin\marketplace.json` | **应用真正读的那份**：市场 id `dev-office-desktop`，指向 `plugins/office-desktop` |
| `plugins\office-desktop\` | 插件本体（0.1.0；内核 `kernel\office-bridge.mjs` 与标准包逐字节一致：md5 `d98e5f39b0504f740adee900409539ba`，17433 字节） |
| `plugins\office-desktop\README.md` | 插件自带说明（装法、代价与前提、边界、七件事落点、版本、运行环境、验证状态的完整版，内容最全） |
| [`实现说明.md`](实现说明.md) | 怎么实现的：结构、每个文件的职责、关键流程所在的源码位置、与蓝本的逐条对照 |
| [`原理说明.md`](原理说明.md) | 什么原理：为什么分两半、为什么需要常驻进程、为什么两个按钮落在「输入框上方那一条」、叫醒与插话各自怎么落 |
| [`使用说明.md`](使用说明.md) | 使用说明：安装、配置项、两个按钮怎么按、AI 侧的工具从哪来、常见故障排查 |
| [`注意事项.md`](注意事项.md) | 用之前必须先知道的事：适用范围与版本、**加载方式决定工具对模型可不可见**、两个按钮由人控制、三处不能乱动、代价、验证状态指针 |
| [`验收到哪一步.md`](验收到哪一步.md) | 验证状态：已验证项与未验证项、原因与凭据（**含那一行画在 `desktop` 面上的三个读数、工具真名 28 条、叫醒与插话在真会话里的实况，先读这一节**） |

任务要求的三份说明分别对应：`实现说明.md`（怎么实现的）、`原理说明.md`（什么原理）、`使用说明.md`（使用说明）；
`验收到哪一步.md` 按交付要求单独成份；本 README 仅作导读。

## 验证状态概述

- **已真机验证**（真办公室 `127.0.0.1:8787`）：假办公室自测 **47 通过 / 0 未通过**；
  真办公室演习 **18 通过 / 0 未通过** —— 办公室按 `to` 派发 ⇒ **真往门牌号推了 `wake`（办公室日志为
  `推给插件（/dsh-office/wake）：HTTP 200`）** ⇒ 内核把它递到插件那一半，且**不带消息正文**；
  探活（challenge）由办公室自己打时答对；办公室请它断／连各一次；卡上的宿主进程名 `Claude Desktop`
  与门牌号均为插件代报。内核**逐字节未改**（md5 可核）。
- **第二批实测**（热重载由人点过「启用」之后）：插件**真的加载起来了** —— 那一行在 **`desktop`** 面上画了多次、
  钩子未抛错；**工具真名 28 个逐条量到**（全 `mcp__office-desktop__*`）；**插话**那一行原样进会话（`origin` 为插件）、
  **叫醒**那条命令进待办队列且**不带正文**，并且该会话**真的由这条命令开了一个新回合**（叫醒这条链子通到「AI 当轮看得见」）。同批量到：本宿主会话启动给的是 `isInteractive: false`、`e.surface: null`，
  蓝本那道 `if (e.isInteractive)` 闸在本宿主等于关闭一切 ⇒ **已从交付版摘掉**。
- **第三批实测**：**人按了那一条带上的两个按钮** —— 第一层与第二层都真的动了（办公室成员表里出现
  `claude-desktop` 的卡，插件状态文件里 `boundSessionId` ＝ 本会话的 id）。⇒ 「两个按钮」那一条**已确认**；
  卡上三个代报值实测为 `name: "Claude Desktop"`、`host: "127.0.0.1:19391"`、`model: "claude-fable-5"`。
- **第五批实测（重启之后）**：**工具露出来了，而且调得动。** 按「点名目录」让插件在**进程启动时**就位
  （`CLAUDE_CODE_PLUGIN_DIRS` 写进**配置目录**的 `settings.json` 的 `env`）、重启应用之后：
  给模型的清单里出现 28 个 `mcp__office-desktop__*`，并**真调了一次 `mcp__office-desktop__desk_status`**
  （读数原样答回）；门牌号仍是 `127.0.0.1:19391`（没漂）；办公室侧 `aliveConns = 2`、这一位 `{card:"ok", probe:"ok"}`。
- **仍未验证**：① 卡上 `model` 是不是人以为的那个模型（**存疑**：卡上是 `claude-fable-5`，
  而同一会话转写里助手条目的 `model` 是 `deepseek-flash` —— 本机走第三方网关）；
  ② **界面那一下正式装**（`+` → Plugins → Add plugin）——**效果已达**（见上），只是在应用的 Plugins 面板里还没登记；
  ③ `claude plugin validate`／`claude plugin test`／`tsc -p` 三条自检命令（**本机 PATH 里没有 `claude` 命令行**）；
  ④ 插话的打断效果；⑤ 云／WSL 会话。凭据与判据见《验收到哪一步.md》。

## 版本与运行环境

注意：本节每个数**都有出处**，没有出处的直说「没查」。

| 项 | 值 | 出处（怎么读出来的） |
| --- | --- | --- |
| **宿主应用** | Claude Desktop **2.19675.1.0** | `Get-AppxPackage -Name '*Claude*'` 的输出：`Name = Claude`、`Version = 2.19675.1.0`、`PackageFullName = Claude_2.19675.1.0_x64__pzs8sxrjxfjjc`；注册表同一项（`HKCU\Software\Classes\Local Settings\…\AppModel\Repository\Packages\`）下也是这一串 |
| **宿主引擎** | Claude Code **2.1.288** | 引擎每次加载插件时铺下的声明文件**首行**：`// Written by Claude Code 2.1.288.`（文件见下一行）；另一处同源：技能包那一份也在 `…\Temp\claude\bundled-skills\2.1.288\…` |
| **插件 API 声明文件** | `.claude-plugin\types\claude-code\index.d.ts` **576306 字节**<br>`.claude-plugin\types\claude-code-tools\index.d.ts` **171260 字节**<br>`.claude-plugin\types\claude-code-mcp\index.d.ts` **412 字节** | `wc -c` 量出的字节数；三份都由引擎在**加载时**铺进该目录（每次加载重铺一遍），**不属本插件的内容** |
| **插件怎么加载的** | 「点名目录」：配置目录的 `settings.json` 里 `env.CLAUDE_CODE_PLUGIN_DIRS` 指向本插件目录（即**配置目录**下的 `settings.json`） | 该文件内容可直接查看；这条路读的是**进程启动时**的环境 —— 因此那些工具能进给模型的清单（见《注意事项.md》第二节）。前期各批曾以「插件开发目录 ＋ 会话热重载」加载，见《验收到哪一步.md》 |
| **插件版本** | **0.1.0** | `plugins\office-desktop\.claude-plugin\plugin.json` 的 `version` |
| **Node** | **v22.23.3** | `node -v`。常驻进程与两个自测脚本都用它跑；插件按 `nodePath`（默认 `node`）起常驻进程 |
| **内核** | `kernel\office-bridge.mjs` **17433 字节**，md5 **d98e5f39b0504f740adee900409539ba** | `wc -c` 与 `md5sum`；与标准包那份**同 md5**（逐字节一致） |
| **标准包版本** | **0.1（2026-10-05）** | 标准包 `README.md` 末节「## 版本」 |
| **操作系统** | Windows **10.0.22631.2861**（Windows 11） | `cmd /c ver` 的输出 |

**别与 Claude Code CLI 的版本混起来**：同级「claude code插件」那份文档记的宿主是 **Claude Code 2.1.291（命令行）**，
与本包是**两个宿主、两个版本** —— 本包是桌面应用的**代码选项卡**，引擎为 **2.1.288**。

复核这几条的命令：

```bash
node -v
cd plugins/office-desktop && wc -c < kernel/office-bridge.mjs && md5sum kernel/office-bridge.mjs
ls -l .claude-plugin/types/*/index.d.ts
```

（Windows 上另两条：`powershell -NoProfile -Command "Get-AppxPackage -Name '*Claude*'"`；`cmd /c ver`。）

## 修订记录

- 0.1.0（2026-10-07）：首版交付。内核照搬标准包；宿主侧那半、自检工具与叫醒演习为新写；
  两个按钮落在 `AbovePrompt`（输入框上方那一条带）上。

---

> ⚠️ **第三方插件**：与 Anthropic、OpenAI、深度求索等厂商均无隶属或背书关系；文中出现的产品名称仅为指称对应产品之用。

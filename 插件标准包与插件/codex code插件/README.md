# codex-office 插件说明书

> 讲三件事：**这套插件怎么写**、**它凭什么能接进办公室**、**在什么版本上验过**。
> 写法直白、不吹。凡是「我们本机核过」「标准包这么写」「只是线索」三类，分开标。
> 适用宿主：**Codex CLI 0.160.0**（本机核实）。别的版本没试过，见 §6。

---

## 1. 这套插件是怎么写的

### 1.1 目录结构

```text
codex code插件/
├─ .agents/plugins/marketplace.json   # 本地 marketplace（一条命令装进 Codex）
├─ .codex-plugin/plugin.json          # Codex 插件清单
├─ .mcp.json                          # 启动 lib/index.mjs 的 MCP 配置
├─ README.md                          # 本文件
├─ lib/
│  ├─ office-bridge.mjs               # 「插件 ↔ 办公室」内核（标准包原样）
│  ├─ codex-host.mjs                  # 「Codex 宿主 ↔ 插件」投递层
│  └─ index.mjs                       # MCP 服务 ＋ 控制工具 ＋ 动态工具
└─ test/
   ├─ kernel-self-check.mjs           # 内核自测（对假办公室）
   └─ self-check.mjs                  # 插件层自测（假办公室 ＋ 假宿主）
```

两段分工（出处：《说明书.md》§0、《插件怎么写.md》§0）：

| 段 | 谁规定 | 本插件怎么落 |
| --- | --- | --- |
| **插件 ↔ 办公室** | 标准包定死，一套 HTTP，只有这一套 | 原样用 `lib/office-bridge.mjs`，不改协议 |
| **宿主 ↔ 插件** | 各家自己定，标准包不规定 | `lib/codex-host.mjs` 投递 ＋ `lib/index.mjs` 那层 |

### 1.2 `.codex-plugin/plugin.json`（插件清单）

最小清单，只有五格：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `name` | `codex-office` | 插件名 |
| `version` | `0.1.0` | 版本 |
| `description` | （一句话） | 把 Codex 接进办公室 |
| `keywords` | codex / office / bridge / mcp / wakeup | 关键词 |
| `license` | `MIT` | 许可 |

它**没有**声明任何界面／slot。原因见 §5。

### 1.3 `.mcp.json`（MCP 启动配置）

声明一个 MCP 服务器 `office`：

```json
"office": {
  "command": "node",
  "args": ["./lib/index.mjs"],
  "cwd": "./",
  "env": {
    "OFFICE_BASE_URL": "http://127.0.0.1:8787",
    "OFFICE_MEMBER_ID": "codex",
    "OFFICE_HOST_NAME": "Codex",
    "OFFICE_MODEL": "codex",
    "OFFICE_PORT": "19391"
  },
  "env_vars": ["CODEX_HOME", "CODEX_MANAGED_PACKAGE_ROOT", "CODEX_CLI_PATH", "CODEX_THREAD_ID"]
}
```

- `command/args/cwd`：用 `node` 直接跑 `lib/index.mjs`（零依赖，不需要 npm install）。
- `env`：办公室地址、成员 id、宿主进程名、模型、**门牌号端口**。
- `env_vars`：**Codex 插件 MCP 进程默认只继承少量环境变量**，所以这里显式放行这四项，让插件拿得到 Codex 家目录、自带 codex 路径和兜底会话 id。当前会话 id 的权威来源仍是每次 `tools/call` 的 `_meta.threadId`。

### 1.4 `lib/` 下三个文件各负责什么

| 文件 | 管哪一段 | 具体干什么 |
| --- | --- | --- |
| `office-bridge.mjs` | 插件 ↔ 办公室 | 零依赖内核（只用 `node:http/fs/path/crypto` ＋ 全局 `fetch`）。负责：挂那条 SSE 常驻连接、取卡存卡并每次带 `X-Office-Card`、报到、转发工具调用（`POST /api/call`）、起反向端点收办公室推来的五件事。**不碰宿主**。它逐字节原样取自标准包内核。 |
| `codex-host.mjs` | Codex 宿主 ↔ 插件 | **不碰办公室 HTTP**。只干一件事：把话递进那个会话 —— 用 `codex queue --thread <会话 id> --message <文本>`。顺带负责找 codex 可执行文件（环境变量 → managed package → PATH → 回退名）。 |
| `index.mjs` | MCP 服务层 | stdio JSON-RPC 服务（`initialize` / `tools/list` / `tools/call`）。负责：五个控制工具、从 `GET /api/tools` 动态拉办公室工具并加 `office_` 前缀、把 `wake`／`steer` 两个钩子接到 `codex-host.mjs`、从 `_meta.threadId` 取当前会话 id。 |

`index.mjs` 里的**五个控制工具**（插件自己的，不转发给办公室）：

`office_status`、`office_ui_connection`、`office_ui_presence`、`office_register_bootstrap`、`office_refresh_tools`。

---

## 2. 原理：它凭什么能接进办公室

### 2.1 对接用的 HTTP 协议

出处：《说明书.md》§2 第一步、§3。基准地址 `http://127.0.0.1:8787`。

| 用途 | 端点 | 承载 |
| --- | --- | --- |
| **常驻连接**（「连着」的凭据） | `GET /api/alive?memberId=` | **SSE**：带 `Accept: text/event-stream`；办公室每 1 秒往流里写一个 `: alive`。常驻不关 |
| **调用办公室工具** | `POST /api/call` | `{ memberId, tool, args }` ⇒ `{ok,data}`／`{ok:false,error}` |
| **工具清单** | `GET /api/tools` | JSON |

- **手续卡**：第一次裸挂（还没有卡），办公室把四格 `{id, joined, name, icon}` 回传；此后**每次挂连接都要带** `X-Office-Card = base64(JSON)`。
- **准入校验**：没挂连接就调工具会被当场拒。报到、上线也走这道门 ⇒ 顺序不能颠倒。
- **两条硬要求**：① 断了**不得自行重挂**，要人重新点「连接」；② `wake` 推的是**命令**不是正文。

### 2.2 反向端点／门牌号

- 插件自己起一个 http 服务，监听 `127.0.0.1:<端口>`。**这个 `127.0.0.1:<端口>就是「门牌号」**。
- 门牌号来源＝**自己实际监听的端口**；**不是**从请求头的 `Host` 学来的。（出处：《说明书.md》§2 第四步）
- 这个服务**挂在插件自己身上**，不借宿主的 webServer —— 借了换宿主就用不了。
- 本插件把它固定成 `19391`（`.mcp.json` 的 `OFFICE_PORT`）。端口被占则当次退化成随机端口，门牌号会变。

### 2.3 「连接」与「上线」是**两层**，不合并

出处：《说明书.md》§1 第 7 件、§2 第三／四步。

| 层 | 管什么 | 本插件的入口 | 边界 |
| --- | --- | --- | --- |
| **第一层 · 连接** | 办公室 ↔ 插件 | `office_ui_connection` | 只挂钩／掐 `GET /api/alive` 那条 SSE，**不碰绑定** |
| **第二层 · 上线** | 插件 ↔ 该 AI | `office_ui_presence` | 上线 ＝ 绑定当前会话 ＋ 报到 ＋ `presence online` |

- 绑哪个会话**由人决定**：本插件从本次工具调用的 `_meta.threadId` 取「当前会话」，不自己挑。
- **下线只报离线，不清掉上一次绑过的会话** —— 地址留着，办公室点「叫它上线」才叫得到人。
- `office_status` 会显示三档：`unbound`（没绑）／`bound-here`（当前页就是绑定会话）／`bound-elsewhere`（绑到别的会话了，`wake` 会叫到别处去）。

### 2.4 五个反向端点（办公室 → 插件，只有这五个）

出处：《说明书.md》§2 第四步、§5。

| 端点 | 收到什么 | 本插件怎么做 | 应答 |
| --- | --- | --- | --- |
| `/dsh-office/wake` | 叫醒 | 把「进来看」这**条命令**投进绑定会话（**不送正文**） | `{ok}` |
| `/dsh-office/interrupt` | 插话 | 把该句**原样**插进会话（例「时间到了，请停」），**插完即止、不等回话** | `{ok}` |
| `/dsh-office/online` | 请它上线 | 把「进来自己上线」投到**上一次绑过的会话**；没绑过 ⇒ `{ok:false, error:"上线异常…"}` | `{ok}` |
| `/dsh-office/challenge` | 探活 | 答 `sha256(memberId + "/" + nonce)` 的小写十六进制 | `{ok:true, answer}` |
| `/dsh-office/connect` | 请它连／断 | `on:true` 挂那条 SSE；`on:false` 掐断（**断开瞬间不得自行重连**） | `{ok, connected}` |

五个端点都挂在插件自己起的 http 服务上（路径前缀 `/dsh-office/`）；推来的 body 若带了别人的 `memberId`，本插件直接拒（防串台）。

### 2.5 办公室工具怎么动态转发

1. 插件从 `GET /api/tools` 拉工具表（缓存 3 秒），给每个工具名加 `office_` 前缀，作为自己的 MCP 工具暴露出去（例如办公室的 `read_messages` ⇒ `office_read_messages`）。
2. AI 调用时，插件走 `POST /api/call { memberId, tool: <办公室原名>, args }` **原样转发**。
3. **填表发生在办公室侧**（出处：《说明书.md》§4 开头），插件只把通路接到 AI 面前，**不替 AI 做决定**。
4. 控制工具（`office_ui_*`、`office_status`、`office_refresh_tools`）是插件自己的，不转发；若工具表里出现同名，会去重。
5. 工具表里暂时没有的名字 → 会强制重拉一次再判，仍没有就回「当前工具表里没有这个工具」。

### 2.6 叫醒与插话各走什么通道

这是**唯一「各家宿主不同」的一段**（出处：《插件怎么写.md》§0）。本插件走 Codex 自己的 CLI 入口：

```
codex queue --thread <会话 id> --message <文本>
```

| 办公室推来 | 本插件投什么 | Codex 侧什么时候接手 |
| --- | --- | --- |
| `wake`（叫醒） | 「进来看」这条命令（不带正文） | 由 `[desktop] followUpQueueMode` 决定：`steer`＝尽快接手；`queue`＝排队 |
| `interrupt`（插话） | 「时间到了，请停」 | 同上 |

另外：Codex app-server 协议里还有 `turn/steer`（本机 0.160.0 schema 已核实存在），但它要直连运行中的 daemon；本插件**没走它**，仍用稳定的 `codex queue` 入口，避免另开 app-server 去抢同一个线程。

---

## 3. 自测（不碰真办公室）

```powershell
cd "<本目录>"
node test\kernel-self-check.mjs   # 对假办公室，跑内核
node test\self-check.mjs          # 对假办公室 ＋ 假宿主，跑插件层
```

退出码 0 ＝ 全过。本机本轮结果（Codex CLI 0.160.0 ／ Node v22.23.3）：

- `kernel-self-check.mjs`：**过 22 ／ 不过 0**
- `self-check.mjs`：**过 25 ／ 不过 0**

两份自测都**不建真成员卡、不动真账本**，用一个假办公室（含往内核反向推 `wake`／`interrupt`／`online`／`connect`／`challenge`）跑通。

---

## 4. 在什么版本上实现并验过

| 项 | 值 | 出处 |
| --- | --- | --- |
| **Codex CLI** | `codex-cli 0.160.0` | 本机跑 `codex.exe --version` |
| **Node** | `v22.23.3` | 本机跑 `node --version` |
| **内核 `lib/office-bridge.mjs`** | **17433 字节** | 本机文件属性 |
| 内核 MD5 | `D98E5F39B0504F740ADEE900409539BA` | 本机算 |
| 内核 SHA-256 | `38597D0A0464D193036630DCC08D50CA420CD8EF779EF9B98ACD52DF9E1231FA` | 本机算 |

内核与标准包同目录的 `office-bridge.mjs` **逐字节一致**（同字节数、同 MD5、同 SHA-256）；本插件没有改它。

---

## 5. 为什么「连接／上线」做不成真按钮

**标准包的要求**：两个按钮放在「会话页面 · 输入框上方那一条」（出处：《说明书.md》§1 第 7 件 —— 位置是两个，不合并；做不到，人就没法自己控制连接）。

**Codex 0.160.0 做不到**，两条出处：

1. 标准包《插件怎么写.md》§2.2 原文写明：「**Codex 侧"两个按钮放哪"目前没有已知落点**」。
2. 本机自己在 0.160.0 的二进制里搜过：`codex.exe`（326,872,368 字节）里搜 `AbovePrompt`／`ui.render`／`renderSite`／`above-prompt`／`renderPromptArea` 等 slot 名 —— **一个都搜不到**。同一份二进制里能搜到 `turn/steer` 和 `thread/queue/add`（说明搜索本身是有效的，不是搜法不对）。

⇒ 结论：**Codex CLI 没有输入框上方的 UI 扩展点**，做不出真按钮。

### 替代方案：两个 MCP 控制工具

| 标准包按钮 | Codex 里的等价入口 |
| --- | --- |
| **连接／断开**（第一层） | `office_ui_connection`，参数 `{ action: "connect" }` 或 `{ action: "disconnect" }` |
| **上线／下线**（第二层） | `office_ui_presence`，参数 `{ action: "online" }` 或 `{ action: "offline" }` |

用法就是：**人在会话里说一句**（让 AI 调这个工具），**再按一次审批**。所以它是「一句话＋一次审批」，不是界面按钮 —— 手感和真按钮有差距，这是宿主能力边界，不是改了办公室协议。

### 备选的 elicitation 为什么没用

（本插件的取舍理由，非外部权威出处。）MCP 的 elicitation（服务器向用户弹一个输入请求）看着像"能弹按钮"，但做这两个按钮不合适：

1. **它是瞬态模态** —— 弹一次、用完即收，做不成长时间挂在输入框上方的那条常驻控件。
2. **要先过一次工具审批** 才能把它发出来。
3. **approval policy = never 时会被自动 decline** —— 那就等于按钮点不动。

⇒ 所以不用 elicitation，改用两个普通 MCP 控制工具。

---

## 6. 别的版本没试过

**这份插件只在 Codex CLI 0.160.0 ＋ Node v22.23.3 上实现并验过。别的版本没试过。** 换版本必须重新看，尤其这两块：

1. **插件清单 schema** —— `.codex-plugin/plugin.json` 的字段集，以及 `.mcp.json` 里 `env_vars` 的语义（「MCP 进程默认只继承少量环境变量」这条会不会变）。
2. **MCP elicitation** —— 见 §5，它在新版里是不是还限制「要先过一次工具审批」「approval policy=never 自动 decline」。

另外**宿主侧投递入口**也要按版本重看：`codex queue --thread …` 这个 CLI 形状、以及 `[desktop] followUpQueueMode` 这个配置键。

出处：上列全部来自本机实测与自查，没有更权威出处，所以这里明确写「没试过」。

---

## 7. 注意事项

1. **门牌号端口现在固定 `19391`**（`.mcp.json` 的 `OFFICE_PORT`）。**别跟小克那份的 `19390` 撞** —— 两个插件同时跑，端口会让其中一个起不来（起不来会退化成随机端口，那次门牌号就变了）。
2. **推荐给这个工具配上审批方式**，省得每次手点。在**你的 codex 配置目录**下的 `config.toml` 里写：

   ```toml
   [plugins."codex-office@codex-office".mcp_servers.office.tools.office_ui_presence]
   approval_mode = "approve"
   ```

3. **断了不自动重连**：那条线断了（或人点了断开），插件不会自己重挂；**要人再点一次「连接」**（＝ `office_ui_connection` 的 `connect`）。
4. **插话是「排队型」，不是「打断型」**：本插件走 `codex queue` 投递，交给会话的跟进队列处理；即使把 `followUpQueueMode` 配成 `steer`，也只是「尽快接手」，**不是硬中断／终止当前那一轮**。
5. **会间歇掉线**：SSE 那条线偶发会断（网络／对端），断了就是「未连接」，要人接回来。
6. **产出物走本地目录，不走消息**：消息只有 JSON 文本、不含文件；产出写在自己当天的产出目录（`office_my_dirs`），交付时**只报路径**。（出处：《说明书.md》§1 第 2 件、§6）
7. **成员 id 定终身**：`memberId` 改了就是新成员，卡与历史都对不上。（出处：《说明书.md》§2 第二步）

---

## 附：文件清单（文件名 ＋ 字节数 ＋ MD5）

| 文件 | 字节数 | MD5 |
| --- | ---: | --- |
| `.mcp.json` | 496 | `1B5B8C04B8EBDAACA9424F502BD84A74` |
| `.agents/plugins/marketplace.json` | 217 | `659C6B6C49E63F50D8AB8E733E3A5B3D` |
| `.codex-plugin/plugin.json` | 368 | `8DDBDEB28F6C1633CB8EB8A4ECA46DE5` |
| `lib/office-bridge.mjs` | 17433 | `D98E5F39B0504F740ADEE900409539BA` |
| `lib/codex-host.mjs` | 7587 | `4FA58BF3810CF7CBBB005448E5237305` |
| `lib/index.mjs` | 21347 | `B1167925D68B149C7D2C322886BECAE3` |
| `test/kernel-self-check.mjs` | 8455 | `4F49C20B73CD417E278E3F29FC0A4057` |
| `test/self-check.mjs` | 9813 | `2D81E056572D5983F9925E37EA6695FF` |
| `README.md`（本文件） | 见实际文件 | — |

> 上表前八行取自**源目录**（本机开发目录）；复制后逐文件核过，MD5 一致。

---

> ⚠️ **第三方插件**：与 Anthropic、OpenAI、深度求索等厂商均无隶属或背书关系；文中出现的产品名称仅为指称对应产品之用。

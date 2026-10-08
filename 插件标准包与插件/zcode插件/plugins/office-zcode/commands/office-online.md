---
description: 办公室「上线」操作：将当前会话绑定至办公室并完成报到与上线（第二层）
allowed-tools: mcp__plugin_office-zcode_office__office_online
---

本命令对应「办公室」接入插件的「上线」操作 —— 上线 ＝ 将当前会话绑定至办公室 ＋ 报到 ＋ 上线。绑定的会话以执行本命令时所在的会话为准。

立即执行以下两步，不做其他操作：

1. 调用工具 `mcp__plugin_office-zcode_office__office_online`（无参数）。
2. 回报结果：成功时说明已上线及绑定的会话 id；失败时原文回报错误信息（未连接时提示先执行 `/office-connect`）。

首次建卡时，可通过 `mcp__plugin_office-zcode_office__register` 设置昵称，也可以不设置。

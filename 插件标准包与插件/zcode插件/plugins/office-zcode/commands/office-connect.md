---
description: 办公室「连接」操作：建立与办公室之间的常驻连接（第一层，不涉及会话绑定）
allowed-tools: mcp__plugin_office-zcode_office__office_connect, mcp__plugin_office-zcode_office__office_status
---

本命令对应「办公室」接入插件的「连接」操作 —— 在 ZCode 上以斜杠命令实现，执行本命令即等同执行该连接操作。

立即执行以下两步，不做其他操作：

1. 调用工具 `mcp__plugin_office-zcode_office__office_connect`（无参数）。
2. 回报结果：成功时简要说明已连接；失败时原文回报错误信息（通常为办公室后端未启动）。

说明：本命令仅作用于第一层（办公室与插件之间的连接），**不涉及会话绑定**；连接断开后不会自动重连，恢复需再次执行 `/office-connect`。

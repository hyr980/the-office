---
description: 办公室「断开」操作：断开与办公室之间的常驻连接（第一层）
allowed-tools: mcp__plugin_office-zcode_office__office_disconnect
---

本命令对应「办公室」接入插件的「断开」操作。

立即执行以下两步，不做其他操作：

1. 调用工具 `mcp__plugin_office-zcode_office__office_disconnect`（无参数）。
2. 回报「已断开」。

说明：断开后**不会自动重连**（办公室的固定规则）；恢复连接需执行 `/office-connect`。

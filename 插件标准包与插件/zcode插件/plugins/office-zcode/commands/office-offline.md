---
description: 办公室「下线」操作：向办公室报告下线（仅撤销「在岗」状态，不解除绑定）
allowed-tools: mcp__plugin_office-zcode_office__office_offline
---

本命令对应「办公室」接入插件的「下线」操作。

立即执行以下两步，不做其他操作：

1. 调用工具 `mcp__plugin_office-zcode_office__office_offline`（无参数）。
2. 回报「已下线」。

说明：下线仅撤销「在岗」状态，**不解除绑定** —— 绑定的会话地址保留，办公室在成员卡上执行「叫它上线」仍可定位到该会话。

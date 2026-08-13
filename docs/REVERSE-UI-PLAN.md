# 逆向 + UI 改造计划（2026-08-13）

> 目标：① 全面逆向 @cursor/sdk（协议层之外的所有东西：local runtime、ConnectRPC 全集、
> 错误/限流矩阵、模型/工具细节），联网补全社区逆向成果；② cursorapi UI 改成 windsurf 风格。
> 产出：逆向研究报告（docs/REVERSE-SDK.md 系列）+ UI 改造（ui.mjs → windsurf 风格）。

## Wave 1（研究，5 个并行）

| # | 任务 | 产出 |
|---|---|---|
| 1 | SDK 本地深挖 A：协议全集 | REST 端点全集、ConnectRPC 服务/方法全集、错误矩阵、限流头、usage 事件形状、模型字段 |
| 2 | SDK 本地深挖 B：local runtime 执行链 | cursorsandbox 子进程协议、eventNotifier、customTools 调用链、resume/idempotency 语义 |
| 3 | 联网研究 A：社区逆向 | GitHub cursor-api/cursor-chat/cursor-fetch 等，补全 key 生成、token、端点、限流细节 |
| 4 | 联网研究 B：官方文档 | cursor agent SDK 文档、模型目录、计费、限流、版本变更 |
| 5 | windsurf dashboard 结构分析 | 主题系统、组件、页面、图表、i18n、后端 API 映射 → cursorapi 改造输入 |

## Wave 2（执行，依赖 Wave 1）

- UI 改造：按 windsurf 风格重写 ui.mjs（主题/布局/统计页/账号管理），保持 test-ui 兼容或同步改测试
- 逆向结论整理：落盘 docs/REVERSE-SDK.md，作为自研协议层（cursor-client.mjs）的设计输入

## 验收

- 逆向报告覆盖：协议全集、local runtime、错误矩阵、限流语义、模型/工具细节，附文件:行号或 URL 证据
- UI：windsurf 风格（暗色默认、冷色调、统计图表、i18n 可选），npm test 全绿

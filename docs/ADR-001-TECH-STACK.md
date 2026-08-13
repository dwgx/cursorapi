# ADR-001：技术栈决策 — 保持 Node ESM + @cursor/sdk（2026-08-13）

状态：**已接受**。决策人：dwgx（经对话确认）。

## 背景

cursorapi 是 Cursor 号池网关：把一池 Cursor API key 包装成 OpenAI + Anthropic 双协议 HTTP API。
规划阶段对比了三个参考网关（kirostudio / sub2api / windsurf-api），提出技术栈问题：
**改用 Rust（如 kirostudio）或 Go（如 sub2api），还是做 0 依赖 npm（如 windsurf-api）？**

## 决策

**保持现状：Node.js ESM + `@cursor/sdk ^1.0.27`（唯一依赖），不重写 Rust/Go，不做 0 依赖。**

## 理由（按优先级）

1. **上游决定语言，这是硬约束**。Cursor 官方只有 TypeScript/Node SDK 和 Python SDK，
   没有官方 Rust/Go SDK（2026-08-13 GitHub 检索确认）。`@cursor/sdk` 不只是 HTTP 客户端——
   它带原生模块（sandbox helper、ripgrep），承担整个 agent 运行时：`Agent.create`/`send`/
   `customTools` 工具中继/`Cursor.me()` 身份/`Cursor.models` 目录。**换 Rust/Go = 自己实现
   Cursor agent 协议**（逆向或 ACP，如 copenai 项目，工程量是重写 agent 引擎而非网关），
   现阶段净亏。

2. **0 依赖不适用于我们**。windsurf-api 能做到 0 依赖是因为上游是公开 HTTP 协议可手写；
   cursorapi 的 1 个依赖（`@cursor/sdk`）恰是别人做不到的部分——官方 agent 运行时封装。
   这 1 个依赖是资产不是负担。

3. **现有资产**：4.8k 行、16 模块、7 个测试全绿、双协议出口 + 工具中继 + 号池 + 管理面板
   全部可用。重写 = 全部扔掉重来。

4. **本机约束**：8GB MacBook Air M2。kirostudio 自证「本机编不过，必须服务器 Docker 编译」
   （kirostudio/CLAUDE.md）。Rust 重写后本机迭代开发不可行。

5. **性能匹配**：网关是 IO 密集（HTTP + SSE 流式转发 + SDK 子进程），非计算密集。
   瓶颈在上游 Cursor 不在网关；单机按 request 计费的号池网关，Node 撑数千 RPM 无压力。

## 反决策（何时推翻这条 ADR）

- Cursor 发布官方 Rust/Go SDK（目前无迹象）
- 决定换上游（如转纯 HTTP 协议转发而非 agent 运行时——那等于换产品）
- 实测单机 Node 撑不住目标量级（目前无此迹象）

## 影响

- 开发迭代继续走 Node：`npm install && npm test`（7 测试串联）
- 环境变量保持 `CURSOR_` 前缀（改名 CURSOR_* 是纯运营项，与语言无关，按 PLAN.md Phase 0 走）
- 借鉴来源侧重同语言同形态的 windsurf-api（模式可直接移植）；kirostudio/sub2api 的
  调度/熔断/用量设计作为架构思想参考（详见 docs/COMPARISON.md）

## 相关文档

- docs/COMPARISON.md（四方能力对比与借鉴 TOP 10）
- docs/PLAN.md（基础建设计划）

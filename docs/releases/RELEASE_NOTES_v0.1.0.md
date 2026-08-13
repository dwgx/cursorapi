# v0.1.0

CursorAPI 首个版本：Cursor 号池网关。

## 能力

- OpenAI / Anthropic 双协议出口，35 个 Cursor 模型
- 号池：多号负载均衡、错误分类、冷却、自动探活恢复
- 工具中继：客户端工具调用原样回传（Claude Code / opencode 通用）
- 管理面板：号池 / 账号 / 日志 / 模型 / 统计 / 设置 / 更新
- 配置热更新 + OTA 更新（git/zip 双模式 + 崩溃自动回滚）
- CURSOR_PROXY 代理支持（国内部署走代理）
- Docker 镜像（GHCR）+ 单二进制（Linux / macOS / Windows）

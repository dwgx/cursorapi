# 协议研究：Anthropic 兼容层对照（完成）

4 仓库研究完成（代码全部本地核实，issue 全部抓取原文）：
- /tmp/ccp-research（1rgs/claude-code-proxy, server.py 1711 行全文）
- /tmp/ccnexus-research（ccNexus, claude_openai.go/claude_gemini.go/think_tags.go/streaming.go/proxy_request.go）
- /tmp/new-api-research（new-api, relay/channel/claude/relay-claude.go, relaykit/relayconvert/oai_chat/to_claude_messages_resp.go, relaykit/types/error.go, controller/relay.go）
- /tmp/ccr-research（claude-code-router, packages/core/src/gateway/features/anthropic-response-model.ts, request/pipeline.ts, http/io.ts, hosted-web-search/response-transform.ts）

重磅证据：
- CCR#1629：message_start.model 必须 == 请求 model，否则 Claude Code 剥光历史 thinking 块（双向抓包证实）
- CCR#1587：finish_reason 与 usage 分 chunk，转换器时序 bug 导致 usage 丢失（output_tokens:0）
- 1rgs#99：Claude Code system 前缀含 x-anthropic-billing-header: cch=<hash> 每请求变，转发破坏 prompt cache
- CCR#1130：空 text content block → "text content blocks must be non-empty"；错误体多层嵌套
- new-api 块状态机注释："Mismatched content block type" 是已知坑；finish 延迟等 usage

对照 cursorapi 的结论见 docs 报告（协议研究四仓对照.md）。

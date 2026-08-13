# 双协议转换深度对比研究：cursorapi vs 同类项目

> 2026-08-13。只读研究。对比对象：1rgs/claude-code-proxy（Py/LiteLLM，下文 **1rgs**）、
> ZyphrZero/kiro.rs + GreyGunG/Kiro-RS-Tool（Rust，**kiro**）、musistudio/claude-code-router（TS，**CCR**）、
> new-api / ccNexus（Go，**new-api / ccNexus**）。
> 我方实现：src/anthropic.mjs、src/openai.mjs、src/format.mjs、src/stream.mjs、src/relay.mjs、src/tool-relay.mjs。
> 参考资料：docs/KIRO-RESEARCH.md（kiro 系算法）、docs/COMPARISON.md（网关能力对比）、
> `.claude/CONTEXT.md`（2026-08-12/13 实测坑记录）。

## 零、TL;DR

我们的事件序列、model 回显、空 content 兜底、错误体形状都做对了（详见 §四）。
**真正值钱的 4 个缺陷**（§三 P0）：

1. **system 里 `x-anthropic-billing-header` 行未剥离** —— Claude Code 每请求变化的 `cch=` hash 会打爆上游 prompt cache（1rgs #99 实测 5-10x 成本）。我们在 anthropic.mjs:63-64 把 system 逐字拼进 Cursor prompt。
2. **message_delta usage 丢字段** —— cache_read_input_tokens 只在非流式出现、cache_creation_input_tokens 全路径缺失，而数据在手（relay.mjs:29）。k2cc 按 usage 计费。
3. **孤儿/重复 tool_result 无配对校验** —— 找不到 turn 时静默当新请求 → 新 run 双计费。kiro 有三分类过滤（converter.rs:971-1078）。
4. **全池限流时错误 type 丢失重试语义** —— 502/503 一律 `api_error`，Claude Code 不重试；kiro 映射 429→rate_limit_error、503→service_unavailable 并透传 Retry-After。

## 一、对比对象定位

| | cursorapi | 1rgs | kiro.rs | CCR | new-api / ccNexus |
|---|---|---|---|---|---|
| 形态 | Node ESM，自实现协议层 | Python 单文件 + LiteLLM | Rust 双仓（T 分支较早，Z 主线含 invoke 捞回/credit 透传） | TS，v3 网关 + ai-gateway 翻译引擎 | Go 多协议中转站 / Go Claude Code 网关 |
| 上游 | Cursor SDK（单串 prompt） | OpenAI/Gemini | Kiro/Bedrock（Anthropic 系协议） | 任意（Anthropic/OpenAI/Gemini/...） | OpenAI 系/Claude |
| 出口 | OpenAI + Anthropic | Anthropic | Anthropic（+OpenAI/Responses） | Anthropic | Anthropic |
| 历史消息 | **折叠成单文本 prompt** | tool_result 摊平文本 | 结构化保留 + 配对校验 | 结构化保留（v2 配对回插/v3 快照重放） | 结构化保留（tool_result→tool 消息） |
| 工具中继 | customTools 挂起 → 客户端执行 → resume 同 run | 无（文本化） | 结构化 tool_use 还原 | 结构化 | 结构化 |

关键差异：**我们和 1rgs 一样把历史文本化**（架构使然——Cursor SDK 只吃字符串 prompt），
kiro/CCR/new-api 全部结构化转发。这决定了两边缺陷形态不同：我们不存在消息交替 400 问题，
但存在「文本化丢失工具上下文」的固有损失。

## 二、八维度对比差异表

| # | 维度 | 我们 | 1rgs | kiro | CCR | 结论 |
|---|---|---|---|---|---|---|
| 1 | SSE 事件顺序 | 手写纪律（constructor 一次 message_start → 块配对 → message_delta → message_stop），无状态机 | 顺序固定，message_start 恰好一次，自造 ping，末尾发 [DONE]（Anthropic 没有，示范错误） | **SseStateManager 状态机**（stream.rs:1092-1334）：start/delta/stop 合法性校验、tool_use 自动关 text 块、收尾统一关块再 message_delta 再 message_stop | 透传不重组；自产流同序，message_delta 在最后（transformer.ts:314-383） | **顺序正确**（缺防御性校验，见缺陷 12） |
| 2 | message_start.model 回显 | **回显请求原文**（flow.model=req.publicModel，relay.mjs:163） | 回显改写后的 model（`openai/gpt-4.1`，server.py:934）——错误示范 | 回显请求 model（Z:1479） | **专门流式改写**回请求 model（anthropic-response-model.ts） | **我们正确**。CCR #1629 实锤：不回显 = Claude Code 剥光历史 thinking 块 |
| 3 | billing header | 不转发任何客户端头（SDK 独立建连）✓；**但 system 文本里的 billing 行未剥离** ✗ | 头不转发，system 文本行原样转发 → #99 缓存打爆 | 完全不管（上游不需要） | **v3 从 body.system 剥离**（claude-code-router-plugin.ts:1008-1028） | **P0 缺陷 1**：剥离 system 里的 `x-anthropic-billing-header:` 行 |
| 4 | 工具配对 | id→turn Map + resume；**孤儿静默开新 run** | 无配对（文本化，多轮脆弱 #41/#91） | 三分类配对 + 悬空 tool_use 删除（converter.rs:971-1078） | v2 按 id 配对回插 + 缺响应塞伪成功（converter.ts:121-131） | **P0 缺陷 3**：加配对校验，孤儿结果不静默计费 |
| 5 | thinking 块 | 响应侧从不发；历史侧 blockToText 静默丢弃（anthropic.mjs:37）；body.thinking 完全不读 | 非 Anthropic 后端丢弃；thinking 参数形状校验失败 422（#37） | 完整支持：thinking 块 + signature 占位符 + redacted_thinking（Z:2093-2213） | 透传/合成 thinking 块；model 不一致剥历史 thinking（#1629） | 剥离方向正确（Cursor 无 thinking），但参数静默忽略需显式化（缺陷 6） |
| 6 | 错误映射 | 400→invalid_request_error、401→authentication_error、其余 api_error（anthropic.mjs:308-316）；**429/RA 不透传** | 无 Anthropic 错误格式（{detail:...}，#60/#89） | 全表：429→rate_limit_error+RA、503→service_unavailable、400→invalid_request_error（handlers.rs:309-389） | 透传 status+body；流内错误 event:error；429 内部重试后最终错误才给客户端 | **P0 缺陷 4**：type 枚举补 429/503 分支 + RA 决策 |
| 7 | 非流式 vs 流式 | usage 口径不一致：**流式 message_delta 丢 cache_read，两路都缺 cache_creation**；content/stop_reason 一致；空 content 兜底 ✓ | usage 流式 input 恒 0；结构一致 | 四字段同构 + 互斥分摊（Z:1259-1309） | usage 双路完整；content 空兜底 ✓ | **P1 缺陷 2**：message_delta 补全四字段 |
| 8 | 多轮工具历史 | 折叠文本（<conversation-so-far>）+ resume 同 run 续轮；**重启后 turn 失联 → 白计费** | 纯文本化 | 结构化 + 校验 | 结构化 + 快照重放 | 架构取舍（缺陷 10），CCR #1629 的 model 一致性我们已满足 |

## 三、缺陷清单（按价值排序）

### P0（高价值，建议先修）

**1. system 中的 `x-anthropic-billing-header` 行未剥离 → 上游 prompt cache 永不命中**
- 发现：Claude Code 把 `x-anthropic-billing-header: cc_version=…; cch=<hash>` 作为 system[0] 文本块发送，其中 `cch=` 每请求变化。我们的 renderPrompt 把 system 逐字拼进 Cursor 上游 prompt（anthropic.mjs:63-64；OpenAI 路径同款 format.mjs:33），每次请求 prompt 前缀都变 → Cursor 侧 prompt cache 永远 miss。
- 证据：1rgs issue #99（实测成本 5-10 倍）；CCR #1372/#1343/#1220（"every turn presents a brand-new prefix to the backend"）；CCR v3 在 claude-code-router-plugin.ts:1008-1028 从 body.system 剥离。
- 修复建议：`renderPrompt` 拼 system 前按行过滤 `/^x-anthropic-billing-header:/i`（flatten 后对文本逐行过滤，保留其余 system）。同时解析 `cc_is_subagent` 之类的元数据可留日志。
- 备注：HTTP 头层面我们天然免疫（从不转发客户端头），只有 system 文本行这一个口子。

**2. message_delta usage 字段不全（丢 cache_read / cache_creation），k2cc 计费口径缺失**
- 发现：toAnthropicUsage 能算 cache_read_input_tokens（anthropic.mjs:22），但流式 finish() 只发 `{input_tokens, output_tokens}`（anthropic.mjs:197-201）；cache_creation_input_tokens 两条路径从未发。而数据在手：relay.mjs:29 `cacheWrite` 有值（SDK 的 cacheWriteTokens）。
- 证据：kiro message_delta 四字段全带（Z:1297-1309）；CCR ai-gateway `CO()` 四字段；CONTEXT.md 已记录「k2cc 按 usage 计费」的坑。
- 修复建议：finish() 改用完整 toAnthropicUsage；toAnthropicUsage 增加 `cache_creation_input_tokens: u.cacheWriteTokens ?? 0`。顺带使流式/非流式 usage 口径一致（缺陷 7 的根）。

**3. 孤儿/重复 tool_result 无配对校验 → 静默开新 run 双计费**
- 发现：digToolResults 在 lookupTurn 全部 miss 时返回 null（anthropic.mjs:90-102），relay.mjs:168-171 将其当作全新请求 → 重新选号建 run 记一次费。k2cc/Claude Code 网络重试、重复提交 tool_result 时会发生；服务重启后（byToolCall 内存 Map 清空）所有续轮请求都会踩中。
- 证据：kiro 三分类（converter.rs:971-1078）：配对成功 / 已配对过的重复 tool_result（warn 跳过）/ 找不到 tool_use 的孤儿（warn 跳过）+ 悬空 tool_use 从历史删除——动机是上游 400 硬约束，我们是防白计费。
- 修复建议：请求带 tool_result 但无命中 turn 时：记录日志（含 tool_use_id）+ 返回 400 invalid_request_error（"no matching pending tool call; the turn may have expired"），而不是静默开新 run。至少做成可配置。

**4. 全池限流时错误 type 丢失重试语义（429 吞掉 + Retry-After 丢弃）**
- 发现：池耗尽 → 502/503，Anthropic 面一律 `api_error`（anthropic.mjs:312）；429 的 Retry-After 刻意不透传（relay.mjs:109-115）。Claude Code 只对 rate_limit_error/overloaded_error 类重试，api_error 直接放弃。全池被 Cursor 限流时用户只能重发，且得不到退避信号。
- 证据：1rgs #89（429 必须诚实返回，否则客户端盲重试）；kiro 映射 429→rate_limit_error + Retry-After 透传、503→service_unavailable（handlers.rs:309-389，RA 规范化见 kiro/error.rs:6-46）；CCR 429 走内部退避重试，最终失败才给客户端。
- 权衡：池内吸收 429 是正确设计（最多 3 次换号）。问题只在「吸收完仍失败」的出口语义。
- 修复建议：launch 耗尽时，若 lastErr 判定为限流 → 返回 503（或 429）+ `Retry-After` + type=`rate_limit_error`；其他上游错 → 503 + type=`service_unavailable`。这不会破坏「不主动发 429」的既有纪律（我们仍在池内吸收），只是把最终失败表达得更可重试。

### P1（中价值）

**5. 流内错误只能当文本吐，无 SSE error 事件**
- 发现：fail() 把错误拼进 content 文本（anthropic.mjs:208-212）并以 stop_reason=end_turn 收尾——错误污染正文、客户端拿不到结构化错误。流已 200 无法改状态码是事实，但 1rgs/kiro/CCR 都补发 `event: error`（kiro Z:2487-2500 的 upstream_tool_json_error；CCR v2 transformer.ts:427-442）。
- 修复建议：fail() 先发 `event: error` + `{type:"error",error:{type:"api_error",message}}` 再正常收尾；文本化兜底可保留但后置。

**6. thinking 参数静默忽略，未显式声明能力边界**
- 发现：parse 只读 messages/model/stream/tools（anthropic.mjs:275-287），body.thinking 完全不读；历史 thinking 块 flatten 时静默变 ""（blockToText anthropic.mjs:37）。对无 thinking 的 Cursor 模型这是正确剥离，但客户端若请求 `thinking:{type:enabled,budget_tokens:N}` 会期待 thinking 块返回——静默无视会让客户端以为 thinking 生效。
- 证据：1rgs #37（thinking 参数形状必须被接受，否则 422）；CCR #1629（model 一致性是历史 thinking 的保护条件——我们回显请求 model 原文，此条件已满足，thinking 处理不会被 model 改写破坏）。
- 修复建议：parse 读 body.thinking；enabled 时 log.info 声明「upstream does not support extended thinking, silently disabling」；或直接 400 invalid_request_error 让客户端降级到非 thinking 模式（更诚实，但依赖客户端处理能力）。

**7. message_start usage 恒 0 占位，无估算**
- 发现：constructor 写死 `{input_tokens: 0, output_tokens: 0}`（anthropic.mjs:135-137）。CONTEXT.md 已记录「k2cc 按 message_start usage 计费会归零」的坑，真值已挪到 message_delta 兜底——但 message_start 给个估算值，客户端展示/计费会更平滑。
- 证据：kiro 用 token 估算填 message_start（Z:1482-1487），缓冲流模式收尾还用真值覆写（Z:2590-2601）。
- 修复建议：用 prompt 长度粗估（chars/4 之类）填 message_start.input_tokens，真值照旧走 message_delta。

**8. SSE 无心跳（ping）**
- 发现：全流无 ping 事件。长生成（Anthropic 官方 API 会发 ping 事件）或长空闲下，中间代理可能掐连接；我们的 idle 判据 10min 说明长思考是常态。
- 证据：1rgs 自造 ping（server.py:952）；kirostudio 研究 P2 建议 25s ping 保活。
- 修复建议：AnthropicSseWriter 起 unref 定时器，每 ~25s 发 `event: ping`（SDK 兼容，官方 API 同款）。

### P2（低价值/角落）

**9. tryJson 静默回退 {}（工具参数解析失败无信号）**
- anthropic.mjs:104-106 + 175：args 非法 JSON 时 input 静默变 {}。kiro 的 ToolJsonAccumulator 宁可显式报错不静默 {}（Z:953-1039，InvalidJson/IncompleteJson 两种错误）。我们整块 JSON 一次发所以没有分片问题，但非法参数应记日志而非静默吞。

**10. 多轮历史文本化的固有损失（架构取舍，记录不修）**
- renderPrompt fold（anthropic.mjs:47-56）把 tool_use/tool_result 摊平成文本，模型二次推理看不到结构化工具上下文；对比 CCR/new-api 的结构化转发是明确损失。对「单串 prompt 的 Cursor SDK」这是唯一解，但建议在日志里记录续轮是否走 resume（结构化）而非新 run（文本化），便于观测长对话质量。

**11. tool_result.is_error 丢弃**
- digToolResults 只取 content（anthropic.mjs:97），is_error 标志进不了提示词，模型不知道工具执行失败。折叠文本时至少拼 `[error]` 前缀。

**12. attach 顶掉旧 sink 时旧连接不结束（角落）**
- tool-relay.mjs:143-147：stale() 只 resolve 旧 promise，旧 res 不 end()。客户端断连重发场景下旧 SSE 连接悬挂到 keepAliveTimeout。可顺手在替换前对旧 sink 调 finish("stop")。

## 四、已做对（防回归清单）

- **message_start.model 回显请求原文** ✓（CCR #1629 的最高优先级要求；catalog 的 [1m,max] 解析只影响上游，不影响回显）
- **SSE 顺序 + 必带 event: 行** ✓（SDK 按事件名分派）
- **message_start 恰好一次、块 start→delta→stop 配对、tool 自动关 text 块** ✓（与 kiro 同款语义）
- **空 content 兜底 `[{type:"text",text:""}]`** ✓（CCR #1130 的 400 教训）
- **非流式 usage 完整（含 cache_read）** ✓（只差 cache_creation，见缺陷 2）
- **错误体顶层 {error:{type,message}} 不嵌套** ✓（CCR #1130 教训；1rgs 的 {detail:...} 是反面教材）
- **stop_reason 映射表** ✓（tool_calls→tool_use、stop→end_turn、length→max_tokens，与各参考一致）
- **不发 [DONE]、不发 stop_reason:"error"** ✓（1rgs 的两个非标准示范）
- **工具 id 前缀 toolu_/call_** ✓（CCR 兜底生成 toolu_ 同款思路）
- **流终点不在 finish_reason** ✓（我们 SDK 一次性给 usage，天然免疫 CCR #1587 的「usage-only chunk 被挡」bug 形态）
- **工具调用 80ms 攒批 + park 重放** ✓（比各参考更强的断连容错）

## 五、可抄的实现要点 TOP 10

1. **SseStateManager 防御性状态机**（kiro stream.rs:1092-1334）：8 字段（message_started/message_delta_sent/active_blocks/...）+ 4 不变量；start 幂等、delta 必须块 open 否则拒绝、stop 幂等、message_delta 只能在所有 stop 之后且只一次。我们目前靠调用纪律，抄成状态机可防未来重构踩坑。~100 行。
2. **文本块自愈重建**（kiro Z:1994-2023）：已关 text 块再来文本 → 丢旧索引开新块，根治「吞字」。我们 #sealText 后 blockIdx 递增，语义等价，但无防御。
3. **工具配对三分类**（kiro converter.rs:971-1078）：配对我们有（id→turn），缺「重复/孤儿」两类处理 → 即缺陷 3。
4. **Retry-After 规范化 + 有 RA 不本地重试**（kiro error.rs:6-46）：只认纯数字秒/httpdate，非法置 None；RA 存在时不重试防放大限流。对 launch 的 429 退避可直接套用。
5. **错误 type 标准枚举**（kiro handlers.rs:309-389）：429→rate_limit_error、503→service_unavailable、400→invalid_request_error、500→internal_error。type 决定客户端重试语义。
6. **billing header 剥离**（CCR claude-code-router-plugin.ts:1008-1028 + 1rgs #99）：即缺陷 1，~5 行。
7. **message_start usage 估算 + 收尾修正**（kiro Z:1482-1487, 2590-2601）：即缺陷 7。
8. **thinking signature 占位符**（kiro Z:2195-2221）：Anthropic 客户端要求 thinking 块必须回传非空 signature（CCR #1641 同族）。我们当前不做 thinking 块用不上，但未来若要透传 Cursor 的 reasoning 内容，这是必踩的坑，先记住。
9. **半截/非法工具 JSON 显式报错**（kiro ToolJsonAccumulator Z:953-1039）：即缺陷 9。
10. **错误体不嵌套 + 空 text 块清零**（CCR #1130）：我们已满足，列为回归红线。

## 六、参考 issue / 证据链接

- 1rgs/claude-code-proxy：#99（billing header 打爆缓存）、#37（thinking 参数形状 422）、#89（429 必须诚实返回）、#60（错误体缺失）、#41/#91（文本化多轮脆弱）
- musistudio/claude-code-router：#1629（model 不回显 → 剥光历史 thinking）、#1606（事件重复/丢 stop_reason/message_stop 被过滤）、#1587/#1325（usage-only chunk 被挡）、#1130（空 text 块 + 错误嵌套）、#1641/#1382/#1401（thinking 必须回传）、#1161/#1372/#1343/#1220（billing header）
- kiro.rs（ZyphrZero/kiro.rs）：stream.rs:1092-1334（SseStateManager）、converter.rs:971-1078（工具配对）、handlers.rs:309-389（错误映射）、kiro/error.rs:6-46（Retry-After）、converter.rs:102-131（strip_top_level_combinators）、stream.rs:1795-1916（invoke 捞回）
- ccNexus：claude_openai.go:445-638（流式转换）、think_tags.go:131-170（<think> 标签拆分）
- new-api：to_claude_messages_resp.go:20-132（块状态机 + Mismatched content block type 坑）、:301-309（等 usage 再收尾）

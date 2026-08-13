# 外部项目研究报告：Cursor 反代 / 网关类开源项目可吸收点审计

日期：2026-08-13
范围：GitHub + searxng 检索 Cursor 反代/网关类项目，深度读码 8 个，对照本网关（cursorapi）现状。
方法：所有结论均来自源码、CHANGELOG、README、issues 原文；克隆目录在 `/var/folders/.../T/opencode/` 下可复查。本项目现状以 `src/` 当前代码为准。

---

## 一、项目清单（12 个 + 3 个轻扫）

| # | 项目 | star | 最后更新 | 用 @cursor/sdk | 定位 |
|---|---|---|---|---|---|
| 1 | dwgx/WindsurfAPI | 2931 | 2026-08 | 否 | 姊妹项目（Windsurf/Devin 版双协议网关），非吸收源，仅对照 |
| 2 | 7836246/cursor2api | 1875 | 2026-08（已凉，README 自述） | 否（直连 Web Docs API） | Cursor 文档页免费 API → OpenAI/Anthropic，防御逻辑密度最高 |
| 3 | Xchat1/cursor2api-go | 1067 | 2026-08 | 否 | gemini 反代，JS 包装，未深读（低相关） |
| 4 | wisdgod/cursor-api | 692 | 2026-07（已归档） | 否 | 老牌 Rust 反代，已 archived，未深读 |
| 5 | Nomadcxx/opencode-cursor | 660 | 2026-08 | **是**（^1.0.18，子进程） | OpenCode 插件：@cursor/sdk → OpenAI 兼容 HTTP 代理，SDK 限制记录最全 |
| 6 | FakeOAI/tokens | 416 | 2026-08 | 否（调各 2api 后端） | 号池调度平台，**核心闭源**（docker 镜像），只能从 CHANGELOG/文档站取证 |
| 7 | askalf/dario | 340 | 2026-08 | 否（Claude 订阅 OAuth） | Claude 订阅 → OpenAI/Anthropic 代理；账号池/会话粘性/漂移检测教科书 |
| 8 | standardagents/composer-api | 303 | 2026-08 | **是**（bridge 脚本，另有两套协议直连） | Cursor Composer → OpenAI/Responses；SDK 协议字段号逆向最完整 |
| 9 | anyrobert/cursor-api-proxy | 176 | 2026-08 | 否（绕 agent CLI） | 多账号池 + 真实配额 API 接入 + reset-hwid |
| 10 | AprilNEA/BYOKEY | 130 | 2026-07 | 否 | 订阅 → API 网关（无 Cursor 实现）；key 四态状态机、Retry-After 尊重 |
| 11 | leeguooooo/agent-cli-to-api | 70 | 2026-08 | 否（绕 agent CLI） | agent CLI → OpenAI，未深读 |
| 12 | tageecc/cursor-agent-api-proxy | 51 | 2026-08 | 否（绕 agent CLI 子进程） | 流式差分去重（turnBuffer） |
| 13 | mt-altman/cursor2api | 56 | 2025-05（已归档） | 否 | 早期项目，已死 |
| 14 | vinshanks/cursor2api | 1 | 2026-07 | **是**（^1.0.24，同我们） | 与我们同 SDK 同定位：Agent.create 单轮文本 → OpenAI/Anthropic，619 行单文件 |
| 15 | cursor/plugins cursor-sdk skill + 官方 TS SDK 文档 | - | 2026-08 | 官方一手 | SDK 已知限制/top traps 权威来源 |
| 16 | openlit / paperclip / cursor-sdk-gateway | - | - | **是** | SDK 事件流 instrumentation、Agent.resume 会话恢复、SDK 协议逆向（字段号表） |

深读：2、5、6、7、8、14、15、16 + 轻扫 9、10、12。以下可吸收点按此范围。

---

## 二、深度项目可吸收点清单

### 2.1 7836246/cursor2api（1875★，防御逻辑密度最高，但上游已凉）

上游是 Cursor 文档页 `cursor.com/api/chat`（SSE：text-delta / finish），单 Cookie 无号池。它的价值在防御逻辑，不在架构：

| 机制 | 证据 | 对我们的价值 |
|---|---|---|
| **空闲超时**（读数据重置计时器，仅"完全无数据 N 秒"才 abort） | cursor-client.ts:109-124 | 已有（relay.mjs waitTurn），验证方向正确 |
| **退化循环检测**：连续相同 text-delta ≥8 次（仅 ≤20 字符短 token）→ 中止且不重试；HTML token 跨 delta 拼接后检测重复 | cursor-client.ts:151-252 | **缺**。我们 consume 无此检测 |
| **warmup/guard 流式释放器**（前 300 字符缓冲、尾部 256 字符 guard，用于"已发数据后不可重试"的补救） | streaming-text.ts:134-217 | 我们流开始后不 failover，此约束天然满足；warmup 无必要 |
| 上下文预算：**实测 Cursor 隐藏开销**（基础 1300 tokens + per-tool 20/240） | converter.ts:708-762 | 记账参考值，可选 |
| 会话 ID = sha256(system+首条 user 消息) 派生（#56 修复） | converter.ts:1373-1407 | 会话粘性 hash 方案可直接用（见 Top3） |
| tolerantParse 五层容错（反向贪婪提取大值字段） | converter.ts:1058-1242 | SDK 路径不需要（结构化事件），不采纳 |
| 工具 schema 压缩 135K→15K（#输出预算挤压） | converter.ts:43-68 | SDK customTools 走 MCP 通道，不适用 |
| 错误映射：429/5xx 不做专门映射（#107 open，作者未修） | handler.ts:414-417 | **反面教材**，我们已做得更好 |
| 模型 region-block 探测 + 默认模型 fallback | openai-handler.ts（对应 server.mjs:162-167 同类） | 见 Top 8 |

### 2.2 Nomadcxx/opencode-cursor（660★，同 @cursor/sdk，SDK 限制记录最全）

| 机制 | 证据 | 对我们的价值 |
|---|---|---|
| **SDK 跑持久子进程 + NDJSON stdio + 按 request id demux** | sdk-runner.mjs:55-71, 339-365；src/client/sdk-child.ts:124-311 | 可选项：SDK 的 sqlite3 native 依赖/HTTP2 栈崩了不拖垮网关主进程。我们单进程目前没出问题，列入观察 |
| **stdout 协议保护**（SDK 自己写 process.stdout 会污染协议，重定向到 stderr） | sdk-runner.mjs:55-64 | 我们不做子进程协议，不适用；但如果日志曾混入 SDK 输出可参考 |
| **错误四分类 + quota 文本正则**（"usage limit"/"saved $X"/reset 日期） | src/utils/errors.ts:42-120 | quota 错误是自然语言而非结构化，见 Top 9 |
| **quota 误报修复**：已产生有用输出 + 后续 quota 错误 → 吞掉，不追加第二个错误块（issue #104） | plugin.ts:1770 附近 | 见 Top 9 |
| **流式差分去重**（SDK 事件有 partial 增量 + 非 partial 累积双发 → 前缀 diff 只发新后缀；修复重复输出 #41/#43） | src/streaming/delta-tracker.ts:49-88；openai-sse.ts:73-96 | 见 Top 7 |
| **MCP 工具名 remap**（SDK 把 MCP 工具发成 generic `mcp` + providerIdentifier/toolName，需重映射为 mcp__server__tool） | sdk-runner.mjs:117-129 | 我们走 customTools 回调不经过 MCP 工具名，低相关 |
| **模型动态发现**（Cursor.models.list() + 5 分钟缓存 + 硬编码 fallback；#112 证明猜的 id 直接无响应） | src/models/discovery.ts:12-105 | 已有（catalog.mjs），验证方向正确 |
| 工具循环守卫（重复 read/探索循环检测，2.3.x 调参史） | CHANGELOG:33-41；issue #61 | 与退化循环检测合并考虑（Top 4） |
| OpenAI 协议层**一次只能回一个 tool call**（结构性限制，issue #123 open） | plugin.ts（createToolCallCompletionResponse 单元素数组） | 我们 stream.mjs 每个 chunk 一个 index 递增的 tool_calls 元素，**已支持并行**，无此问题 |

**@cursor/sdk 已知限制清单（本组最重要的产出）**：

| 限制 | workaround | 证据 |
|---|---|---|
| Agent.create+send 约 6s 冷启动（流开始前） | 持久子进程只省 Node boot+import，create 的 6s 消不掉 | CHANGELOG:29；issue #92 作者评论 |
| Node ≥ 20 必须（SDK runner） | CURSOR_ACP_NODE_BIN 覆盖 | CHANGELOG:30 |
| **SDK 的 ConnectRPC/HTTP2 栈在 Bun runtime 挂起** | 必须独立 Node 子进程 | issue #85 |
| native sqlite3 无法 bundle | optionalDependencies + 子进程 | CHANGELOG:16 |
| SDK 内部日志写 process.stdout | 重定向 | sdk-runner.mjs:55-64 |
| kill() 无法中断 in-flight run（取消 best-effort） | 请求级停止转发事件 | sdk-child.ts:21-22 |
| local 的 settingSources 默认加载 Cursor 环境（rules/skills/MCP 重复注入拖慢请求） | 默认 `settingSources: []` | CHANGELOG:17；**我们已这样做**（relay.mjs:66） |
| 模型 id 必须来自 models.list() | 动态发现 | issue #112；**我们已这样做**（catalog.mjs） |
| 无 customTools 支持迹象（他们传的是 tools:["mcp"] 白名单，工具执行靠拦截 tool_call 事件） | tool-loop 拦截 + executor 链 | sdk-runner.mjs:250-255 |
| 并发无显式上限；429/rate-limit 无任何处理 | 无 | 全仓 rg 无结果；**我们已有** |

### 2.3 FakeOAI/tokens（416★，号池调度平台，核心闭源，证据为 CHANGELOG/文档站）

| 机制 | 证据（CHANGELOG 行号） | 对我们的价值 |
|---|---|---|
| 账号级限速传染：某账号任一模型被限 → 该账号整体停轮询（gemini-2.5-flash 除外） | L297、L658 | 我们冷却按账号记（keys.mjs reportFailure），已等效 |
| 按官方返回的具体限速时间冷却（而非固定值） | L1236、L1243、L1347 | 已有 Retry-After 解析（keys.mjs:36-43） |
| **粘性会话必须能被 429/异常解除重绑**（否则用户卡在坏号上；CC 粘性遇 429 不换号是 v3 修过的 bug） | L1002、L1862 | 做粘性时必带解绑（Top 3） |
| 权重加权随机选号 | L33 | 我们用 5 维排序 + round-robin，更优 |
| 刷新过期 token 不生效 → 轮询永远 401 | L1872 | SDK 内部管 token，不适用 |
| 谱号（共享额度号）限速误标异常 | L1409、L1421 | 池混不同套餐号时注意区分 |

### 2.4 askalf/dario（340★，账号池机制教科书，全开源）

| 机制 | 证据 | 对我们的价值 |
|---|---|---|
| **会话粘性**：首条 user 消息 SHA-256 16hex 作 stickyKey 绑定账号，TTL 按最后一次使用计 6h，429 failover 后 rebindSticky，2000 条 LRU | pool.ts:21-25, 281, 469-508, 537-542 | 见 Top 3（动机：prompt cache 按 {账号×key} 作用域，跨账号轮换 5-10 倍 cache 重写成本） |
| **请求内 failover**：429 → markRejected → selectExcluding(triedAliases) → 换 token/重发同一请求，客户端只见一次成功 | proxy.ts:3202-3203, 3438-3447 | 已有（relay.mjs launch tried 集合），方向一致 |
| **全局并发闸**：10 并发 / 128 排队 / 60s 超时，满则显式 429 queue-full；stalledSince 卡死检测 | request-queue.ts:108-110, 139-143 | 见 Top 5 |
| **选号降级阶梯**：全耗尽取最早 reset → 无数据取最少请求数 | pool.ts:414-451 | 我们 select 无候选直接 null；可加兜底（Top 5） |
| **冷却指数退避**（60s×2^(n-1) 上限 30min）+ **并发 401 突发只升一次级**（防 k 个并发同时 401 推满冷却）+ 成功清零 | pool.ts:102-115, 375-389, 399-405 | 我们 429 冷却是 base×streak 线性；见 Top 6 |
| **探活语义**：429/529 不算故障（重启解决不了限流）；TTL 60s + single-flight；不占并发槽 | serving-probe.ts:130-139, 223-237 | 我们探活用 Cursor.me()（API 级只读），已天然满足；配额维度见 Top 2 |
| **refresh-token 复用检测**（双刷新循环 → token 家族全失效，6/23 全线宕机） | issue #644 | SDK 内部管 token，我们不碰 refresh；**但单账号单刷新者原则要守住：不要自建 token 刷新** |
| **身份漂移检测**（deviceId/accountUuid 漂移 → 非 Haiku 全 401，Haiku 宽松通过 → 伪装成间歇限速） | issue #353 | 我们的探活只验 key 有效性；如果以后支持"用户级账号"要加身份快照对比 |
| **queue 槽位泄漏**（客户端连上不读 → 槽位不释放 → 全 504，/health 还显示 ok，14h 停机×4） | issue #905（PR #910） | 见 Top 1 的同类风险：我们无全局队列所以无槽位，但"run 不 cancel"是同类资源泄漏 |
| **overage guard**：计费分类出现非订阅 claim 立即 503 停代理 | overage-guard.ts:89-105 | 可选：检测账号被降级（Pro→免费）立即停用 |
| **400 恢复链**（beta flag 剥离/effort clamp/max_tokens clamp，按账号缓存结论，MAX_RECOVERY_PASSES=4） | proxy.ts:3240-3434 | 可选：SDK 对参数校验严格，客户端参数非法时我们目前直接 400 |
| **pacing/jitter 防封禁**（请求间隔 500ms 下限 + jitter；think-time 模拟；session-id 按 idle 轮换） | pacing.ts:47-61, 139-161 | 见 Top 10 |
| **0% 利用率也 429**，且 429 可能无任何限速头 | issue #6 | 别把"空闲号"当"肯定能用"；冷却信号不能只依赖限速头 |
| 池枯竭排队（50 上限/60s 超时/5s drain）而非立即失败 | pool.ts:646-674 | 见 Top 5 |

### 2.5 三个 SDK 反代小项目（vinshanks/cursor2api、composer-api、cursor-sdk-gateway）

| 机制 | 证据 | 对我们的价值 |
|---|---|---|
| **Anthropic SSE 最小完整序列**（message_start→content_block_start→delta×N→stop→message_delta→message_stop） | vinshanks server.mjs:529-570 | **已有**（anthropic.mjs:131-205，序列一致，含 event: 行） |
| OpenAI 流序列 + finish chunk `{delta:{}, finish_reason}` + [DONE] | vinshanks server.mjs:443-474 | 已有（stream.mjs:71-79） |
| **工具调用"捕获即 cancel、一次一个"**（onDelta 抓 tool-call-started → 立即 run.cancel() → 客户端执行完再续） | composer-api bridge :257-317, :1463-1469 | 我们 RelayTurn 批量+缓存+补发更强，不采纳；但其"cancel 避免状态交错"思路值得在断开时用（Top 1） |
| **SDK 事件集**：assistant（整块文本）/ text_delta（增量）/ tool_call（running+completed 两次，completed 重复发）/ status ERROR / error | bridge :300-315 | 我们只消费 assistant + usage（tool-relay.mjs:281-287）；**text_delta 事件我们没处理**（见 Top 7） |
| **流式终止信号**：turn-ended 帧（field 14）+ end-envelope（flags 0x02） | composer-api cursor-sdk.ts:784-799 | SDK 层细节，不用管 |
| 协议字段号表（ToolCall oneof + EXEC_TOOL_SPECS，两项目独立逆向一致） | gateway local-protocol.js:4-29, 458-473；composer-api cursor-sdk.ts:74-97 | 我们走 SDK 高层 API 不需要，留档备查（SDK 版本升级出问题时可查） |
| **错误映射**：上游 401→401（code cursor_unauthorized）、429 透传、≥500→502、**464→502 "Cursor refused this account/session"**（账号被拒特殊码） | composer-api cursor.ts:330-370 | 464 特判值得记入分类（Cursor 特有状态码） |
| **SDK 错误归一化**：isRetryable/status 429/503/code 8/14（RESOURCE_EXHAUSTED/Unavailable）/容量文案 → 503；沿 error.cause 链找 HTTP status | bridge :2124-2269 | 我们 classifyError 已用 isRetryable + status；cause 链查找可补（见 Top 7） |
| 重试策略：**只在还没发出任何事件时重试**，指数退避 500ms×2^n 封顶 5s，最多 3 次 | bridge :216-221 | 与我们的"流开始前 failover"一致 |
| **模型 region-block 正则**（/model not available|not supported in your region|provider is not supported/i）→ 换默认模型 | vinshanks server.mjs:162-167 | 见 Top 8 |
| **sticky agent 双倍历史 → 空回复**（客户已发全量 messages[]，sticky 复用会重复应用历史） | vinshanks server.mjs:276-280 | 我们每请求 fresh Agent + renderPrompt 扁平化，天然规避；**别做 sticky agent 复用** |
| agentId 持久化 + TTL 6h 会话恢复；agent 池 key=sha256(apiKey\0model\0cwd\0sessionKey) + LRU 128 | composer-api bridge :228-247, 1978-1997；cursor-sdk.ts:1017-1092 | 可选（见 Top 3 的会话恢复讨论） |
| **工具命中后下一轮强制新 agent**（避免带工具上下文的 agent 复读） | bridge :325-333 | 我们每轮 fresh agent，天然满足 |
| 图片只处理最后一条 user 消息；SVG 防御 | vinshanks vision.ts:10-19 | 我们 prompt 是纯文本（blockToText 占位），不适用 |
| **openlit 实证**：usage 可从 onDelta 的 turn-ended 事件拿；reasoningTokens 已含在 outputTokens，别重复计 | openlit wrapper.ts:582-587 | 我们 from run.wait() result/usage 事件拿；不重复计 ✓ |
| **paperclip 会话恢复模式**：持久化 {agentId, latestRunId, env...}；新请求先 Agent.getRun 检查 running → 先 stream+wait 完旧 run 再发 follow-up（同时规避 AgentBusyError）；sessionMatches 校验配置没变才复用 | execute.ts:306-323, 469-493, 239-255 | 可选（Top 3 备选方案） |
| **官方 SDK 陷阱**（cursor/plugins skill + 官方文档）：Agent.create 是 lazy 的（重试要包在 send 外层）；双轨错误（throw vs result.status）；isRetryable 后端权威；RateLimitError 至少退避 30s；同 agent 并发 → AgentBusyError(409) 不重试；tool_call 事件每个工具发两次（running→completed）；FINISHED status ≠ 结束（要 wait()）；run.supports() 守卫；`Cursor.configure({local:{useHttp1ForAgent:true}})`（**我们已用**，proxy-tunnel.mjs:85）；enableAgentRetries 默认 true（SDK 自带传输层重试） | 官方文档:1336, 2028, 2176, 766, 574-589；plugins SKILL.md:124-168 | 见 Top 7 |
| **客户端断开挂 res.close 而非 req.close**（req.close 在 body 收完就触发）→ abort 杀上游 | anyrobert client-disconnect.ts:11-22 | 见 Top 1 |

### 2.6 轻扫（anyrobert、BYOKEY、tageecc）

| 机制 | 证据 | 价值 |
|---|---|---|
| **真实配额 API**：用账号 token 直调 `api2.cursor.sh/auth/usage`（每模型 numRequests/maxRequestUsage）+ `/auth/full_stripe_profile`（会员类型/试用天数） | anyrobert usage.ts:77-94, :124 | 见 Top 2 |
| token 缓存落盘（每次运行后从 Keychain 抓 token 写 .cursor-token，供 usage 直调用） | anyrobert token-cache.ts:31-42 | 配合 Top 2 使用 |
| 全池冷却时选最早恢复的（rateLimitUntil 升序）而非拒绝 | anyrobert account-pool.ts:59-64 | 见 Top 5 |
| reset-hwid（重置 5 个 machine id，账号被设备指纹卡住的救急工具） | anyrobert reset-hwid.ts | 可选运营工具 |
| **key 四态状态机**：Ready/Cooldown/Blocked（403 硬错误永不自动恢复）/Disabled（管理员） | BYOKEY routing.rs:19-28 | 见 Top 6 |
| **尊重 Retry-After**（有 retry_after 用服务端值，否则默认 30s） | BYOKEY retry.rs:123-127 | 已有 ✓ |
| FillFirst 路由（主 key 优先，失败才换） | BYOKEY routing.rs:13-15, 145-152 | 与我们的优先级维度等价 |
| 重试上限 len().min(3) 不全池试一遍 | BYOKEY retry.rs:88-91 | 我们有 config.maxAccountAttempts ✓ |
| 流式差分去重（turnBuffer：新文本以已发开头只发增量） | tageecc manager.ts:171-182 | 见 Top 7 |

---

## 三、我们缺的 Top 10（按价值排序）

### Top 1. 客户端断开/空闲超时后 run 不取消 —— 配额泄漏与僵尸 run

- **发现**：relay.mjs 的 `waitTurn` 超时只 `out.fail()` 注入文本（relay.mjs:221-222）；tool-relay.mjs 工具超时只 reject promise（tool-relay.mjs:213-218）；客户端断开（attach 换 sink）只释放 sinkRelease。**没有任何路径调用 `run.cancel()`**——SDK 的 run 会一直跑完，烧掉配额并占用账号 inflight 语义上的真实上游负载。
- **证据**：本项目 src/relay.mjs:218-224、src/tool-relay.mjs:213-218（无 cancel）；外部：anyrobert/client-disconnect.ts:11-22（断开即 kill 上游）；dario issue #905（连接不读 → 资源不释放 → 全线 504 的同类泄漏）；官方文档:2224-2249（run.cancel() 语义）。
- **修复建议**：在 turn 上挂 AbortController：① `waitTurn` 超时 → `out.fail()` 后 `run.cancel()`；② sink 被替换/客户端断开（res close）→ `run.cancel()`；③ 工具超时 → reject 后同一 turn 若已无 pending 且 sink 已关 → cancel。调用前 `run.supports?.("cancel")` 守卫（官方文档），避免 UnsupportedRunOperationError。

### Top 2. 选号只有"健康+负载"，没有"配额余量"维度

- **发现**：probe 用 `Cursor.me()` 只验 key 有效 + 拉身份（keys.mjs:952-978），拿不到配额。Cursor 官方有只读配额端点：`api2.cursor.sh/auth/usage`（每模型 numRequests/maxRequestUsage）+ `/auth/full_stripe_profile`（会员类型）。
- **证据**：anyrobert/cursor-api-proxy src/cli/usage.ts:77-94, :124。
- **修复建议**：probe 循环里附带拉一次配额（带缓存 TTL，如 10 分钟，避免每次打）；存进 Account（如 `quota = {usage, max}`），`rankVector` 加一维"配额余量比例"，并给"余量 < X%"的账号打预警标记；keys.mjs 的 view() 展示。注意：该端点需要 Cursor 的 token 而非 API key——先验证 SDK 内部能否拿到（可查 @cursor/sdk 的 auth 模块），拿不到就降级为可选配置。

### Top 3. 会话粘性（session affinity）缺失 —— prompt cache 成本与多轮稳定性

- **发现**：relay.mjs 每次请求独立 `pool.select()`（relay.mjs:48），同一用户的连续会话/并发子会话会被打散到不同账号。Cursor 的会话缓存按 {账号 × 会话键} 作用域（dario 实测跨账号轮换 5-10 倍 cache 重写成本）。我们 turn 内已绑定 account（tool-relay.mjs:118），但**新会话没有粘性**。
- **证据**：dario pool.ts:21-25, 281, 469-508（stickyKey = sha256(首条 user 消息)16hex，TTL 按最后使用 6h，2000 条 LRU）；tokens CHANGELOG L1002/L1862（粘性必须能被 429/异常**解除重绑**，否则用户卡在坏号）；vinshanks server.mjs:276-280（sticky **agent** 复用会双倍历史，别做 agent 级粘性，只做账号级）。
- **修复建议**：在 keys.mjs 加 `selectSticky(stickyKey, exclude)`：Map<stickyKey→accountId>，命中且账号可用→用它；miss→select() 并绑定；429/5xx 账号失败 → 解除绑定重绑。stickyKey 从 adapter 的 prompt 首条 user 消息 sha256 派生（复用 anthropic.mjs renderPrompt 的输入）。TTL 按最后一次使用（idle 过期），LRU 上限 2000。

### Top 4. 流式输出无退化/重复检测 —— 模型死循环时烧配额还污染客户端

- **发现**：consume（tool-relay.mjs:274-315）只透传文本，不检测连续重复/退化输出。SDK agent 在工具输出截断或上游 API 错误时会陷入重复 read/输出死循环（opencode-cursor issue #61 曾挂起）。
- **证据**：7836246/cursor2api cursor-client.ts:151-252（连续相同 delta ≥8 次 → 中止；短 token 才判，长文本重复代码行不误判；HTML token 跨 delta 拼接检测）；opencode-cursor issue #61。
- **修复建议**：consume 里维护最近 N 条文本块（如 8 条），全部相同且单条 ≤20 字符 → 判定退化 → `run.cancel()` + `turn.error = "degenerate output loop"`。误判护栏：只对短块判，长块跳过。

### Top 5. 无网关级并发闸与池枯竭排队 —— 突发请求打爆上游整体限速

- **发现**：并发控制只有 per-account inflight/rpm（keys.mjs rankVector），没有网关级闸。池化网关会放大对 Cursor 的整体请求频率——tokens 官方池有 ~3/min 整体限速的记录，dario 的 OAuth 池也撞过官方限速。全池无可用时我们直接 503/502（relay.mjs:101-106），没有排队语义。
- **证据**：dario request-queue.ts:108-110（10 并发/128 排队/60s 超时，满则 429 queue-full）；pool.ts:646-674（全池枯竭排队 60s 等 headroom 恢复）；tokens CHANGELOG L1037（官方 ~3/min 限速）；anyrobert account-pool.ts:59-64（全池冷却时选最早恢复的兜底）。
- **修复建议**：relay.mjs 入口加轻量 semaphore（并发上限可配 CURSOR_MAX_CONCURRENT，默认如 16；超出立即 429 或短排队）；select 无候选时先检查"是否有账号在冷却中且最早恢复时间 < 30s"→ 排队等待而非直接 503。

### Top 6. 403 无永久 Blocked 态；429 冷却线性而非指数；并发突发会把冷却一次推满

- **发现**：403 → RETRY_OTHER（keys.mjs:70），冷却 10 分钟后回来再打——Cursor 的 403 是账号级硬拒（封禁/region 拒），冷却后回来只会重复失败；429 冷却 = base×streak 线性（keys.mjs:742-744）；多个并发请求同时失败会把 streak 连加多次（无去抖）。
- **证据**：BYOKEY routing.rs:19-28（Blocked 态，403 永不自动恢复）；dario pool.ts:102-115（指数退避 60s×2^(n-1) 封顶 30min）；pool.ts:375-389（并发 401 突发只升一次级）。
- **修复建议**：① classifyError 加第 4 个 Verdict：403 连续 N 次（如 3）→ BLOCK（autoDisabled + 不自动恢复，仅手动 enable）；② 冷却改为指数 `min(base * 2^streak, max)`；③ reportFailure 对同账号并发失败合并：streak 只在"上一失败距今 > 某窗口（如 10s）"时递增。

### Top 7. SDK 事件流只消费 assistant/usage —— 对 SDK 版本漂移不设防

- **发现**：consume 只处理 `assistant` 和 `usage` 事件（tool-relay.mjs:281-287）。SDK 事件集有：assistant（整块）、**text_delta（增量，部分版本用）**、tool_call（running/completed 两次）、status ERROR、error、task、request、thinking。opencode-cursor 实测过 SDK 事件既发 partial 增量又发累积全文导致**重复输出**（#41/#43），我们没处理 text_delta，SDK 升级若切换事件类型会丢内容；另外 `truncated` 标志（工具结果被服务端截断）未处理。
- **证据**：官方 streaming.md（事件全集，tool_call 每个工具发两次 running→completed）；composer-api bridge :300-315；opencode-cursor delta-tracker.ts:49-88（前缀 diff 去重）；官方文档:766（tool_call schema 不稳定，按 unknown 解析）。
- **修复建议**：consume 加：① `text_delta` 事件 → 与已发文本做前缀 diff（增量为空或与已发内容重合则跳过）后 emit；② `status ERROR`/`error` 事件 → 结构化记录（已有 error 通道，但补 event 级）；③ `tool_call.truncated` → 记录到 turn 供日志诊断；④ 错误映射沿 `error.cause` 链找 HTTP status（composer-api bridge :2124-2269 的做法）。

### Top 8. 模型 region-block / 不可用错误无 fallback

- **发现**：模型不在目录 → 400（catalog.mjs:162-166，合理）；但模型存在、`send()` 时才报 region/availability 错误（"model not available / not supported in your region / provider is not supported"）时，我们只按 classifyError 处理——非 429/5xx/401 的话走 RETURN（keys.mjs:75），客户端得到一个 502/错误，不尝试换默认模型。
- **证据**：vinshanks server.mjs:162-167（正则命中 → fallback 默认模型换 agent 重试）；opencode-cursor issue #112（模型 id 猜错直接无响应）；官方文档:246-263（composer-2 退役自动重路由，模型是移动靶）。
- **修复建议**：launch 的 catch 里加正则（/not available|not supported in your region|provider is not supported/i）→ 把 model 换成配置的 fallback 模型（CURSOR_MODEL_FALLBACK，默认取 catalog 第一个可用模型）重试一次；记日志区分。

### Top 9. 已产生有效输出后的流中错误被追加污染 —— quota 误报处理

- **发现**：consume finally 里 error 时 `sink.text("\n\n[cursorapi] ...")`（tool-relay.mjs:311）——如果 run 已经产出完整答案、结尾又报 quota/限流类错误，客户端会看到"成功回答 + [cursorapi] 错误"双输出；同时 reportFailure 会把这次记成失败（settle → reportFailure，relay.mjs:141）。
- **证据**：opencode-cursor issue #104（流成功 + 非零退出 = 诊断而非错误，只有无成功输出才走硬错误路径）；其 errors.ts:42-120（quota 是自然语言文本 "usage limit"/"saved $X"，不是结构化错误）。
- **修复建议**：consume 收尾分诊：`#hasText`（已有文本）且 error 是 quota/限流类 → 只记日志 + 记失败但不往流里追加文本；无文本 → 维持现状注入。错误分类可以扩 isSessionAuthError 的模式集（usage limit/rate limit/quota）。

### Top 10. 无请求节奏控制（pacing/jitter）—— 固定频率轮询是防封禁维度指纹

- **发现**：探活/失败重试的时间都是固定值（probe 300ms 间隔、failover 300ms、冷却固定窗口），账号池整体对 Cursor 呈现可预测的请求节奏。dario 专门做了 pacing（请求间隔下限 + jitter、think-time 模拟、session-id 轮换）防观察者推断；tokens 侧也在反复修 CF 盾/封控问题。
- **证据**：dario pacing.ts:47-61, 139-161；session-rotation.ts:89-102；tokens CHANGELOG L400、L432、L543（封控修复十余条）。
- **修复建议**：低成本版：探活循环和 failover 退避的固定 sleep 加 ±20-30% 均匀 jitter（relay.mjs:96、keys.mjs:990）；probe 间隔本身加 jitter。可选进阶：每账号最小请求间隔（如 500ms）+ jitter。

---

## 四、已确认覆盖、无需重复建设（防重复劳动的对照表）

| 外部机制 | 我们已有 |
|---|---|
| Retry-After 尊重（429 按 RA、5xx 才转发 RA） | keys.mjs:36-43、relay.mjs:90-94, 108-115 |
| 空闲超时而非总时长超时 | relay.mjs:124-132 |
| launch 阶段 failover + tried 集合 + 指数退避 | relay.mjs:43-99 |
| 模型动态发现（models.list）+ 别名 + 参数解析 + 缓存 | catalog.mjs 全文件 |
| Anthropic SSE 七事件序列 + event: 行 + X-Accel-Buffering | anthropic.mjs:114-213 |
| OpenAI SSE + finish chunk + [DONE] + usage chunk | stream.mjs:35-88 |
| 并行工具调用批量 + 缓存补发 + 超时 | tool-relay.mjs（BATCH_WINDOW_MS / parked / #armTimer） |
| isRetryable 后端权威 | keys.mjs:65-67 |
| 本地 agent settingSources: [] 隔离 | relay.mjs:66 |
| useHttp1ForAgent 强制 HTTP/1.1（官方代理开关） | proxy-tunnel.mjs:85 |
| 探活语义：API 级只读、429 不涉及、无 quota 消耗 | keys.mjs:952-978（Cursor.me） |
| 每账号原子写（tmp+fsync+rename） | keys.mjs:203-217 |
| 会话级 auth 错误检测（run 流内） | keys.mjs:84-86（isSessionAuthError） |
| 流开始后不 failover（防双脑拼接） | relay.mjs:36-38 注释 + launch 结构 |
| FINISHED status ≠ 结束，wait() 拿 result | tool-relay.mjs:289 |
| 工具结果超时、跨请求 turn 恢复（resumeTurn） | tool-relay.mjs:213-218、relay.mjs:232-256 |

## 五、明确不采纳（及其理由）

- 持久子进程 + NDJSON demux（opencode-cursor）：我们无 Bun 约束、SDK in-process 可用；列入观察。
- 工具 schema 压缩 / few-shot 注入 / tolerantParse / JSON-string-aware 扫描器（cursor2api）：其上游是无结构文本通道，我们是 SDK 结构化事件，问题域不同。
- Composer 控制 token 清洗（</think>、<|final|> 全角变体）：SDK 路径不产生这些 marker。
- reset-hwid：运营救急工具，与网关代码无关，需要时单独脚本。
- 会话恢复 Agent.resume（paperclip）：我们是每请求 fresh Agent + prompt 扁平化（vinshanks 的 sticky 双倍历史教训），当前设计正确；如未来支持长会话恢复再评估。
- BYOKEY FillFirst：与现有 priority 维度功能重叠。

## 六、来源（克隆目录，可复查）

- 7836246/cursor2api（约 9000 行 TS 全读）
- Nomadcxx/opencode-cursor（全读 + 123 条 issues + CHANGELOG）
- askalf/dario（核心文件全读 + issues #644/#353/#905/#805/#921/#234/#6）
- FakeOAI/tokens（CHANGELOG 1895 行 + config + 文档站；核心闭源，源码级证据仅此）
- standardagents/composer-api（worker 三核心文件 + bridge 全读）
- vinshanks/cursor2api（server.mjs 619 行全读）
- divyaran7an/cursor-sdk-gateway（src+test 全读）
- cursor/plugins cursor-sdk skill 全套 + cursor.com/docs/api/sdk/typescript 官方文档
- openlit cursor-sdk instrumentation、paperclip cursor-cloud adapter、cookbook quickstart
- anyrobert/cursor-api-proxy、AprilNEA/BYOKEY、tageecc/cursor-agent-api-proxy（轻扫）

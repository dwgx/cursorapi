# @cursor/sdk v1.0.27 逆向全集（协议层 + local runtime + 社区情报）

> 2026-08-13。逆向方法：bundle loader 合并 910 个 webpack 模块 + 反射 1640 个 protobuf Message +
> 4 个并行 agent 交叉验证 + 联网社区情报（oh-my-pi/jcode/egoist/pi-frontier/composer-api 等 12 仓）。
> dump 资产：`/var/folders/_w/0f4j47c15_qb3l2trtbrk4000000gn/T/opencode/cursor-re/`
> （dump-messages.json 1640 消息、de-min 源码、loader.mjs、REPORT-FINAL.md + 4 份子报告）。
> 用途：自研协议层（cursor-client.mjs）+ CURSOR_USE_SDK 双实现的唯一设计输入。

## 1. 传输全景（三个面）

1. **REST**：`https://api.cursor.com`（`CURSOR_BACKEND_URL` 可覆盖），**原始 apiKey Bearer**。
   头五件套：`Authorization: Bearer <key>`、`x-ghost-mode`、`x-cursor-client-version: sdk-1.0.27`、
   `x-cursor-client-type: sdk`、有 body 时 `Content-Type: application/json`。
2. **ConnectRPC**：`https://api2.cursor.sh`，走 exchange 后的 accessToken。
   进程内缓存 token，仅 Unauthenticated 失效重换 + 重放一次。JSON 传输（application/json）。
3. **本地 executor**：`agent.v1.AgentService`（HTTP2 Run 双向流；HTTP1.1 降级 RunSSE + BidiAppend 推送，
   seqno 递增 ≤16 并发）。

**SDK 无客户端限流**（穷举确认）：无 Retry-After 解析、无 RPM/并发控制，429 只映射 RateLimitError 抛给调用方。
唯一退避：云流重连 `min(30s, 1s·2ⁿ)`、6 次后转 15s 轮询、总时限 2h。

## 2. REST 端点全集（18 个）

```
GET  /v1/me                              getMe
GET  /v1/models                          listModels → {items: ModelListItem[]}
GET  /v1/repositories                    listRepositories
POST /v1/agents                          createAgent → {agent:{id}, run}
GET  /v1/agents/{id}                     getAgent
GET  /v1/agents                          listAgents?limit,cursor,prUrl,includeArchived
POST /v1/agents/{id}/archive|unarchive
DELETE /v1/agents/{id}
POST /v1/agents/{id}/runs                createRun → {run}（body: {prompt, mcpServers, model?, envVars?, mode?, idempotencyKey?}）
GET  /v1/agents/{id}/runs                listRuns?limit,cursor
GET  /v1/agents/{id}/runs/{runId}        getRun
POST /v1/agents/{id}/runs/{runId}/cancel
GET  /v1/agents/{id}/runs/{runId}/stream  SSE（Accept:text/event-stream、Last-Event-ID、x-cursor-streaming:true）
GET  /v1/agents/{id}/artifacts           → {items:[{path,sizeBytes,updatedAt}]}
GET  /v1/agents/{id}/artifacts/download?path= → {url}（预签名 15 分钟有效）
GET  /v1/agents/{id}/usage?runId=        → {totalUsage, cost?, runs:[...]}
```

**SSE 事件**：assistant{text}、thinking{text}、tool_call{callId,name,status,args,result,truncated}、
interaction_update（zod 校验失败静默丢）、status{status}、result（立即 cancel 流）、heartbeat（忽略）、
error{code,message}、`done`。`id:` 断点续传，`[invalid_last_event_id]` 且 id 未变 → 清零重来。
状态机：CREATING/RUNNING→running、FINISHED→finished、CANCELLED→cancelled、其他→error。

## 3. ConnectRPC 服务全集

| 服务 | 方法 | 备注 |
|---|---|---|
| aiserver.v1.AnalyticsService | trackEvents/batch/bootstrapStatsig/getFirstWindowStatsigDecision/submitLogs/ingestConversation/uploadIssueTrace/downloadIssueTraces | 遥测，buffer 200/3s |
| agent.v1.AgentService | **run(bidi)/runSSE/runPoll**/nameAgent/updateConversationMetadata/createTranscriptOverview/getUsableModels/getDefaultModelForCli/getAllowedModelIntents/uploadConversationBlobs/uploadLocalAgentRunToPromptQuality/getSignedUrlForAttachedMedia/notifyConversationClone/getNewChatNudge×2/getPromptContextUsage | 核心 |
| aiserver.v1.DashboardService | 576 方法，SDK 只用 getMe/createUserApiKey/getUserPrivacyMode | createUserApiKeyRequest{name,scopes,expires_at}→{api_key} |
| aiserver.v1.ServerConfigService | getServerConfig → http2_config（FORCE_BIDI_DISABLED 等） | 进程级缓存 |
| aiserver.v1.BidiService | bidiAppend | HTTP1.1 兜底 |

**agent.v1 核心消息**：AgentClientMessage oneof 8 分支（run_request/exec_client_message/exec_client_control/
kv_client_message/conversation_action/interaction_response/client_heartbeat/prewarm_request）；
AgentServerMessage oneof 7 分支（interaction_update/exec_server_message/exec_server_control/
conversation_checkpoint_update/kv_server_message/interaction_query/ttft_breakdown）。
ToolCall oneof **68 个工具分支**（shell/mcp/pi_* 系列）。KV blob 握手：system prompt SHA-256 做 blobId。

## 4. local runtime 执行链（关键纠正）

- **cursorsandbox 不是 agent 容器**——只是每个沙箱化命令的包装器（argv + stdio pipe，
  `cursorsandbox --policy <policy.json> -- <cmd>`）。agent 推理跑在 Cursor 后端 Run 双向流。
- **链路**：send → 本地 SQLite 建 run → createLocalExecutor 连后端 Run 双向流 → 后端下发
  InteractionUpdate（token/thinking/tool_call）+ ExecServerMessage（工具调用请求）→ SDK 主进程
  本地执行工具 → ExecClientMessage 回后端 → turnEnded → checkpoint 落库 → markRunTerminal。
- **事件持久化**：SQLite run_events 表（schemaVersion:1 信封），LocalRunEventNotifier 只是 Unix
  socket 上的 wakeup 闹钟（250ms 轮询兜底）——**自研可直接去掉 socket 只留轮询**。
- **customTools**：定义经 `RunRequest.mcp_tools`（providerIdentifier="custom-user-tools"）下发后端；
  调用经 ExecServerMessage{mcpArgs} 回主进程 wrapper → execute(args, {toolCallId}) → McpResult 回传。
  execute 只收两个参数！返回 {content:[MCP item]}。无 per-tool 超时，无 schema 校验。
- **run 状态机**：QUEUED→RUNNING→FINISHED/ERROR/CANCELLED/EXPIRED；每次 send 都是新 run
  （首次复用预建 run，之后 createFollowUpRun turn_number 递增）；active run 未终止 → busy
  （本地普通 Error，cloud 是 agent_busy code）。force:true 可 EXPIRED 旧 run。
- **checkpoint**：agent.v1.ConversationState → SHA-256 内容寻址存 blobs；进程内自动 resume +
  跨会话 Agent.resume(agentId)（is_resume=true + conversationId 恒等于 agentId）。
- **工具执行**：35 种工具主进程内执行；rg 优先级 CURSOR_RIPGREP_PATH > vendored > PATH；
  沙箱默认 insecure_none；SDK 拒绝所有交互式审批（"not supported in local SDK runs"）。
- **错误**：TURN_IDLE_TIMEOUT 不存在（之前假设错误）；实际 stall 30s 检测 + heartbeat-only 90s +
  连续 stall ≥10 次抛错；agent 主进程崩溃无看门狗（run 卡 RUNNING）。

## 5. 错误矩阵

- 类族：CursorSdkError{code,status,cause,endpoint,requestId,operation,isRetryable,toJSON} →
  CursorAgentError → AuthenticationError / RateLimitError(429, retryable) / ConfigurationError /
  AgentBusyError / NetworkError(retryable) / UnknownAgentError / AgentNotFoundError（死类）。
  message 格式 `[code] message`（REST 401 例外：裸 message）。
- REST 映射：integration_not_connected / agent_busy / 401→Auth / 429→RateLimit / 400·404·409→Config /
  5xx→Network；requestId 取自 x-request-id 头。
- Connect 转换：ErrorDetail{title,detail,isRetryable,error}——11 个限流码（FREE_USER_RATE_LIMIT_EXCEEDED
  等）→RateLimit，7 个认证码→Auth，9 个配置码→Config。

## 6. usage 与模型字段

- usage：`{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, reasoningTokens?}`
  （total=input+output+cacheRead+cacheWrite，跨 turn 累加）。来源：turn-ended 帧 or /usage 端点。
- 模型 item：`{id, displayName, description?, aliases?, parameters?:[{id, displayName?, values:[{value,displayName?}]}],
  variants?:[{params:[{id,value}], displayName, description?, isDefault?}]}`；发送用 ModelSelection{id, params}。
- 幂等：SDK 原样透传 `Idempotency-Key` 头（createAgent 取 send 级或 options 级；createRun 仅 send 级），
  冲突 = HTTP 409 → ConfigurationError 不可重试。

## 7. 社区情报补全（联网研究）

### token 生命周期（6 家独立实现一致的标准做法）
- exchange 响应 = `{accessToken, refreshToken}`；刷新 = 把 refreshToken 当 Bearer 再 POST 同一端点，
  body `{}`，返回新 refreshToken 则轮换（省略则沿用旧值）。
- accessToken 是 JWT，exp 在 payload；按 exp−5min 预判，解析失败兜底 1h。TTL≈1h（唯一实测断言 expiresIn≤3600）。
- 401 → 刷新 → 重试一次（无自动刷新）。落盘 `~/.cursor/auth.json`。

### 限流（官方 + 社区）
- 官方 Cloud Agents API = "标准速率限制"，数字未公开；429 body
  `{"error":"Too Many Requests","message":"Rate limit exceeded..."}` + 头 **Retry-After / X-RateLimit-Limit /
  X-RateLimit-Remaining / X-RateLimit-Reset** 四件套；官方建议指数退避 2**attempt。
- 错误码：rate_limit_exceeded、usage_limit_exceeded（超用量）；stream_expired(410)、invalid_last_event_id。
- SDK run 重试判定（composer-api bridge）：HTTP 429/503、gRPC code 8/14、关键词
  `server at capacity`/`temporarily unavailable`/`resource exhausted`/`rate limit`/`too many requests`；
  退避 `min(5000, 500*2^attempt)`。
- 风控：`ERROR_UNAUTHORIZED` → "suspicious activity from your account"（isRetryable:false）；
  主要针对 free tier；机器指纹关联试用。**464 = 账号级拒绝（非限流）**。
- **区域网关迁移**：agent 流式通道正在从 api2.cursor.sh 迁到 `agentn.global.api5.cursor.sh`
  （agentn.us/eu 区域化），区域团队拒绝 global host；端点缓存在 ~/.cursor/cli-config.json。

### 其他关键
- **pacing 是 load-bearing**：RunInput 拆多帧按 1500/800/400ms 节奏发 + 每 5s 心跳
  （monopi CURSOR_HEARTBEAT_MS=5000 三处独立一致）；一次性发完再 half-close → 只有 keepalive / No exec result。
- 反检测头族：x-client-key=sha256(accessToken)、x-cursor-checksum（混淆时间戳+machineId）、
  x-session-id、UA connect-es/1.6.1；`x-cursor-client-version` 必须匹配在役 CLI 构建（过旧被拒）。
- 官方 OpenAPI spec：`cursor.com/docs-static/cloud-agents-openapi.yaml`（直接拉取做类型校验）。
- crsr_ key：官方格式 crsr_ + 64 字符；生成算法无公开剖析；两种鉴权（Admin API Basic Auth /
  用户级 Bearer）。
- 模型价格公开（cursor.com/docs/models-and-pricing）；流量不返回 OpenAI 式 token 计数，
  社区全用字符估算；proto TokenDeltaUpdate{tokens} 疑似原生计数但无人消费——**值得网关实测**。
- 旧 IDE 内网通道（StreamUnifiedChatWithTools）已死（resource_exhausted "Update Required"）。

## 8. 自研实现设计输入（cursor-client.mjs）

1. **cloud 语义为主**（纯 REST + SSE，无二进制依赖）：exchange → /v1/me /v1/models → createAgent →
   createRun → stream（SSE 解析 + Last-Event-ID 续传 + 2h 时限 + 重连退避）。
2. token 刷新：refreshToken 轮换语义 + JWT exp−5min 预判 + 401 刷新重试一次（社区 6 家一致标准）。
3. 429：解析 Retry-After（兜底 60s）+ X-RateLimit-* 四头；SDK 判定矩阵（429/503/code 8/14 + 关键词）。
4. 工具中继（若保 local 语义）：RunRequest.mcp_tools 下发 + mcpArgs 通道拦截即可，不碰 exec 协议细节；
   或接受 cloud 无工具中继限制。
5. 监控 api5.cursor.sh 迁移；x-cursor-client-version 头需跟踪在役版本。
6. 流式 pacing（Connect 双向流时）：1500/800/400ms 分帧 + 5s 心跳。
7. 官方 OpenAPI spec 拉下来做契约测试基线。
8. **windsurf 0 依赖基建直接可抄**：HTTP/2 session 池（grpc.js:36-75）、代理 host 固定 IP、
   解析器永不向上抛、varint BigInt 兜底、只广告能解码的压缩。

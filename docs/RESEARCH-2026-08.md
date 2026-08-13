# Cursor 协议与 SDK 深度研究（2026-08-13）

> 联网研究（4 个并行 agent：版本演进 / 官方文档 / 社区情报 / 协议实测探测），只读。
> 结论：**@cursor/sdk 1.0.27 = npm 最新，无需升级**；但发现 5 类需要跟进的变化（错误码全集、
> usage 端点 early access、api5 区域路由、Composer 2 退役、大上下文 429 放大器）。

## 1. SDK 版本对比

| 项 | 我们 | 最新（npm） | 结论 |
|---|---|---|---|
| 版本 | 1.0.27 | 1.0.27（2026-08-06 发布） | 未落后 |
| dist-tags | - | latest=1.0.27、next=1.0.27-beta.0（08-05） | 无更新的 beta |
| 2.x | - | 不存在 | - |

- npm 元数据 `modified: 2026-08-12`（晚于 1.0.27 六天），且官方文档已提到
  `@cursor/sdk/bundled` / `bundled/sqlite` 两个导出入口——**1.0.27 的 package.json 里没有**，
  文档超前于发布 → 1.0.28 随时可能发布，值得监控。
  证据：https://registry.npmjs.org/@cursor/sdk 、https://cursor.com/docs/sdk/typescript
- 版本演进（我们 1.0.15 起）：1.0.19 Node>=22.13 + 移除 sqlite3；1.0.22 全量 token usage；
  1.0.23 per-run envVars + 失败 run 结构化错误；1.0.24 与 PyPI cursor-sdk 同步发布；
  1.0.25 云侧 billed cost（getUsage）；1.0.26 prewarm + customTools 免审批；1.0.27 auth 登录体系。
  最完整第三方 changelog：https://github.com/mrkhachaturov/agent-harness-docs/blob/main/docs/cursor/sdk/changelog.md
- **1.0.27 新能力（我们逆向文档遗漏，已在本机 node_modules 验证存在）**：
  - `Cursor.auth.login()`：PKCE 浏览器登录 → POST /auth/poll 轮询 → CreateUserApiKey
    mint 90 天命名 API key → 存 `~/.cursor/sdk/auth.json`。凭证解析顺序：显式 apiKey →
    CURSOR_API_KEY → 存储 login。与 exchange_user_api_key 是**两套流程**（login 是 mint key，
    exchange 是 key→token）。本地包 `dist/*/auth/{login,mint-api-key,credential-store,login-flow}`。
    文档：https://cursor.com/docs/api/sdk/typescript#cursorauth（官方路径 /docs/sdk/typescript）
  - `tools` / `disallowedTools`（限制内置工具集，走私有头 x-cursor-agent-allowed-tools /
    x-cursor-agent-exclude-tools，仅本地 agent）
  - `openAsCursorGithubApp`（cloud PR 以 Cursor GitHub App 署名）——本机 executor-types.d.ts 已含
  - `local.dirs` 多根工作区；**破坏性类型变化：cwd 从 `string|string[]` 收窄为 `string`**
  - 本地 run 也返回 per-turn usage
- 依赖面 1.0.21 起完全未变（@connectrpc/connect ^1.6.1、@bufbuild/protobuf 1.10.0、zod ^3.25.0）。
- GitHub cursor/cursor 仓库无 SDK 代码（releases/tags 全空），npm 包无 README。

## 2. 协议变化清单（影响我们的点）

### 2.1 api5 区域迁移（实测探测，无鉴权）
| host | 状态 | 记录 |
|---|---|---|
| api5.cursor.sh（裸域） | **死** | 无 DNS |
| agentn.global.api5.cursor.sh | 活 | CNAME 两级（geo→lat）→ 新加坡 ap-southeast-1（54.169.137.161 / 52.74.223.220） |
| agentn.us.api5.cursor.sh | 活 | us-west-1 北加州（54.241.60.143 / 3.101.224.52），接受 h2 prior-knowledge |
| agentn.eu.api5.cursor.sh | **死** | NXDOMAIN，全 GitHub 无引用——欧区未开通 |

- **区域路由坑**：硬编码 global host 对「区域路由团队」静默假死（HTTP 200 + 立即关流，
  "This region is not yet available for your team"，伪装得像账号问题）。官方 CLI/IDE 用
  GetServerConfig unary RPC 读 `agentUrlConfig.agentnUrl`（缓存 ~/.cursor/cli-config.json）。
  证据：https://github.com/1jehuang/jcode/issues/637 （2026-07-28）
- 架构：两级 CNAME（geo→lat）全 AWS，不走 Cloudflare；agentn 与 api2 是两套独立部署
  （今日构建 hash 不同）；GET / 返回自定义 health 文本（不再有 ConnectRPC JSON 错误）。
- 我们的 REST 面（api.cursor.com）不受 api5 迁移影响；**自研 Connect 路径（local）必须
  用 GetServerConfig 的 agentnUrl，不能硬编码 global**。

### 2.2 错误码全集（官方 spec 29-30 个，我们只覆盖 4-5 个）
我们已覆盖：rate_limit_exceeded、usage_limit_exceeded、stream_expired(410)、
invalid_last_event_id、agent_busy、integration_not_connected。
**新增需关注**：`agent_id_conflict`(409, 自定义 agentId 冲突)、`stream_unavailable`、
`service_account_required`、`feature_unavailable`（usage 端点未开=403）、`run_not_cancellable`、
`agent_archived`、`plan_required`、`role_forbidden`、`api_key_not_found`。
Error 对象另有 helpUrl / provider 可选字段。
证据：https://cursor.com/docs-static/cloud-agents-openapi.yaml （本机已存
/var/folders/_w/0f4j47c15_qb3l2trtbrk4000000gn/T/opencode/cursor-openapi.yaml）

### 2.3 限流与端点
- **/v1/repositories 官方限流极严：1 次/用户/分钟、30 次/用户/小时**（我们文档未标）。
- **/v1/usage 是 early access**：未开启返回 403 feature_unavailable（计费路径要有兜底）。
- 429 四头（Retry-After/X-RateLimit-Limit/Remaining/Reset）确认，spec 仅文字提及无 schema。
- **新端点 `POST /v1/sub-tokens`**：给团队成员 mint 1 小时 accessToken（forUserEmail/forUserId →
  accessToken/expiresAt/userId/teamId，worker 用 --auth-token）。需要 service account key。
- `/v0/private-workers` 4 个端点（Fleet Management：list/summary/{id}/pending-requests）。
- 官方明确：v1 无 webhooks（coming soon），v0 有（HMAC-SHA256 X-Webhook-Signature，仅
  statusChange）。runs 无 resume、agents 无 fork、无 schedule/cron 端点。
- CreateAgentRequest 新字段：envVars（session 级加密）、mcpServers 内联（stdio/http/sse +
  OAuth，≤50）、customSubagents（≤20）、mode: agent|plan、prompt.images（≤5 张 15MB，
  base64 或 URL——**prompt 从 string 变对象**）、workOnCurrentBranch、自定义 agentId、
  AgentEnv{type: cloud|pool|machine}（v1 正式支持自托管路由）。
- **Basic Auth 与 Bearer 等价**（API key 作用户名、密码留空）——官方一等公民，spec 双 scheme。
- SSE 流 9 种事件官方化：interaction_update 是 SDK 形态完整事件与简化事件并行发出；
  新增响应头 **X-Cursor-Stream-Retention-Seconds**；Last-Event-ID 必须属于该 run 否则 400；
  Run 状态枚举含 **EXPIRED**。

### 2.4 模型与路由
- **Composer 2 已退役**：composer-2/composer-2-fast 请求在 auth 时自动重路由到 Composer 2.5
  （对我们：models 目录会变，客户端旧模型 id 仍可用但语义变了）。
  证据：https://cursor.com/docs/models-and-pricing 、https://cursor.com/changelog
- **新模型（08-12 刚发布）**：Cursor Grok 4.6 / 4.6 Fast（与 SpaceXAI 联合训练，首周 50%
  折扣：$2/$0.5/$6 与 $4/$1/$12）。第三方新增 Claude 4.7 Opus、Fable 5、Opus 4.8/5、
  Sonnet 5（8/31 前促销 $2/$10）、GPT-5.x Codex 系、Gemini 3.x、Kimi K2.7 等。
  证据：https://cursor.com/docs/models/grok-4-6
- Cursor Models 池收窄为三：Grok 4.6 / Grok 4.5 / Composer 2.5。
- **Cursor Router**：模型 id `auto-smart` + 参数 `optimize_for: cost|balanced|intelligence`；
  `auto`/`default` 是未支持的历史值。证据：https://cursor.com/docs/cursor-router
- Cursor Token Rate：Teams/Enterprise 第三方模型每 M token 加收 $0.25（自营豁免）。
- fast 参数仍在：Composer 2.5 Fast $3/$15。

## 3. 社区新坑清单（2026-05 ~ 08）

1. **api2.cursor.sh ChatService 已对 API key/CLI token 下线**（Update Required/actionRequired:
   payment，必须用 agent.v1.AgentService/Run）——2026-07-08 jcode commit 8a91c8f。我们文档已标死，确认。
2. **agentn.global 对区域路由团队静默假死**（见 2.1）——jcode #637（07-28）。
3. **464 新语义**：Run 传输纯 HTTP/2，h1 请求被 ALB 回 **HTTP 464**（h2-only target group）——
   与「账号级拒绝」无关，别误判。oh-my-pi issue #5828（07-17）。
4. **大上下文 = 429 放大器**：全量重放 rootPromptMessagesJson 压掉 cache_read_tokens 复用 →
   上游 429（cursor/claude-fable-5 反复 rate_limit_exceeded，kimi-k3 输出坍缩）。opencodex
   issue #1527（08-12，仍 open）。**与我们 relay 每轮全量 renderPrompt 高度相关**。
5. **空 assistant turn 坑**：经 SDK 桥接时 opus-5/sonnet-5 返回空 content + 声称 tool_calls
   但无 tool_calls delta（内置工具就地干活，客户端声明工具映射不到）；composer-2.5 正常。
   composer-api issue #30（07-30）。
6. **官方清剿托管代理**：composer-api 被要求下架 hosted API path，改签名 macOS 本地 app；
   cursor2api 系（web 免费接口代理）2026-04 集体死亡（x-is-human token、Vercel 风控）。
7. **pacing 未放宽**：1500/800/400ms + 5s 心跳仍是硬约束（缺帧报 `internal: No exec result`），
   头 x-cursor-client-type: cli + x-cursor-client-version: cli-<date>-<hash>——jcode agent_transport.rs。
8. **在役版本参考**：CLI cli-2026.07.23-e383d2b（jcode #637）、社区见 sdk-1.0.13 也被接受
   （composer-api README）→ 客户端版本头宽松，不必最新，但过旧被拒成立。我们发 sdk-1.0.27 安全。
9. **exchange_user_api_key 原样在役**：实测 api2.cursor.sh/auth/exchange_user_api_key 返回
   401 Invalid User API Key（端点活着）；/auth/poll 返回 400 uuid must be a string。oh-my-pi 仍用。
10. 订阅滥用封禁：Ungate 作者 HN 承认「早些时候有 suspension，Anthropic 后来解锁」（08-11 HN 49255661）。

## 4. 升级建议（我们要改什么）

**不用动**：
- SDK 版本（已是最新）。监控 npm modified/dist-tags，1.0.28（bundled 入口）发布后评估。

**建议跟进（按优先级）**：
1. **错误码扩充**（keys.mjs classifyError）：补 agent_id_conflict、stream_unavailable、
   service_account_required、feature_unavailable、run_not_cancellable、agent_archived →
   归入相应档位（409 类→Config/RETURN、403 feature_unavailable→RETURN 原样报错、
   stream_unavailable→RETRY_OTHER）。错误消息格式 {error:{code,message}} + helpUrl/provider。
2. **usage 端点 early access 兜底**：getUsage 403 feature_unavailable 时跳过计费走
   turn-ended 帧的 usage（REVERSE-SDK §6 已知双来源，确认一条路 403 时另一条可用）。
3. **大上下文 429 监控**：relay 每轮全量 flatten 历史 → 观测长对话 429 率；如恶化，
   研究官方 continuation/cache 语义（社区 1527 同款问题）。至少记日志留证据。
4. **Composer 2 退役语义**：catalog 若收到 composer-2/composer-2-fast 请求会被重路由到 2.5，
   计费档/显示名要能对上；新模型（Grok 4.6 等）会自动进 /v1/models 目录，白名单默认档检查。
5. **空 assistant turn 兜底**：tool_call 声明但流里无 tool_calls delta 时，别让 RelayTurn
   挂死等 tool_result（等 10min 白烧）——对已知模型（opus-5/sonnet-5）直接终止该轮。
6. **464 语义区分**：我们走 REST h1 不受 h2-only 影响；但日志里 464 不要一律当账号级拒绝
   （REVERSE-SDK §7 的 464=账号级 结论需要限定语境：h1 请求 h2 通道也会 464）。
7. **Basic Auth 可选**：官方一等公民，成本低，作为 Bearer 备用鉴权路径（可选）。
8. **interaction_update**：我们 zod 校验失败静默丢——确认没丢 usage/关键状态；如 SDK
   形态事件里有简化事件没有的字段（X-Cursor-Stream-Retention-Seconds 相关续传信息），再解析。
9. **自研 Connect 路径（若做 local/tool relay 直连）**：用 GetServerConfig 的 agentnUrl，
   不硬编码 global；Run 通道只发 h2。
10. **/v1/sub-tokens**：了解即可（需要 service account key，我们的池是用户 key，用不上）。

## 5. 证据 URL 汇总

- npm registry: https://registry.npmjs.org/@cursor/sdk
- 官方 SDK 文档: https://cursor.com/docs/sdk/typescript （含 auth login 节）
- 官方 SDK changelog: https://cursor.com/docs/sdk/changelog
- 官方 OpenAPI spec: https://cursor.com/docs-static/cloud-agents-openapi.yaml
- Cloud Agents API 端点: https://cursor.com/docs/cloud-agent/api/endpoints.md
- 模型与价格: https://cursor.com/docs/models-and-pricing
- Grok 4.6: https://cursor.com/docs/models/grok-4-6
- Cursor Router: https://cursor.com/docs/cursor-router
- Changelog: https://cursor.com/changelog （SDK 更新 2026-06-04、Router 07-22、Start 07-28）
- 第三方 SDK changelog: https://github.com/mrkhachaturov/agent-harness-docs/blob/main/docs/cursor/sdk/changelog.md
- jcode（区域路由 + ChatService 下线）: https://github.com/1jehuang/jcode/issues/637 、commit 8a91c8f
- oh-my-pi（464/h2）: https://github.com/can1357/oh-my-pi/issues/5828
- opencodex（大上下文 429）: https://github.com/lidge-jun/opencodex/issues/1527
- composer-api（清剿 + 空 turn）: https://github.com/standardagents/composer-api （README + issue #30）
- cursor-opencode-provider（agentnUrl 使用）: https://github.com/oakimov/cursor-opencode-provider commit 72388f3

## 6. 探测原始数据（2026-08-13，全部无鉴权）

- DNS/HTTP 指纹见 2.1 表；api.cursor.com/v1/models 无鉴权 GET = 401 JSON（REST 面由 Connect
  网关承载）；三个 host 共享 connect-go 指纹头（Grpc-Status/Grpc-Message/x-request-id 等），
  无 Server 头、无 cf-ray。
- agentn.global GET / 200: "Welcome to Cursor. From 20260813-011155-..."; api2 GET / 200:
  "From 20260813-014214-..."（两套独立部署）。
- spec 58,950 字节，15 path / 18 operation，servers 仅 api.cursor.com。

# CursurSPIKEY 项目背景（subagent 专用，原 skcc → cursorapi）

> 2026-08-13 大改版后重写（同日二次改名：cursorapi → CursurSPIKEY，配置前缀 CURSOR_* → CSPK_*，端口 8008，src 模块重命名）。架构：双协议（OpenAI + Anthropic）+ 编排层 relay + 会话化管理面。

## 项目一句话

CursurSPIKEY（原 skcc / cursorapi）把**一池 Cursor API key** 包装成 OpenAI 兼容（`/v1/chat/completions`）**和 Anthropic 兼容**（`/v1/messages`，k2cc 中转站上游）的 HTTP API。客户端写 Cursor 模型 id 直接调用，号由池子挑、坏了自动换（自动禁用 + 冷却自愈），客户端无感。Node ≥ 22.13，ESM，仅依赖 `@cursor/sdk ^1.0.27`。环境变量前缀 `CSPK_`（2026-08-13 由 CURSOR_ 改名）；默认端口 8008。

与作者另一项目 cursor-bridge 刻意不同：**无状态、每轮独立、每轮计费**（数据面），管理面则有会话登录（另一回事，别混）。

## 架构分层（无环依赖）

```
底层（无项目内依赖）: settings.mjs  logger.mjs  http-helpers.mjs  stream.mjs  format.mjs
中层:                 keys.mjs（池） sessions.mjs（管理面会话） catalog.mjs  tool-relay.mjs（RelayTurn）
编排:                 relay.mjs（双协议共用的编排核心，只认 adapter 契约，不懂任何线格式）
协议适配:             openai.mjs（/v1/chat/completions） anthropic.mjs（/v1/messages）
UI:                   ui.mjs（管理界面 SPA + snapshot + loginPage）
最高:                 app.mjs（路由、鉴权、生命周期）  boot.mjs（入口，OTA 守卫先跑）
```

关键设计：**relay.mjs 不知道任何协议线格式**，openai/anthropic 只提供 adapter 五件套：`parse(body)` / `makeSink(res, ctx)` / `feed(turn, results)` / `finishNonStream(res, sink, ctx)` / `callIdPrefix`（OpenAI `call_`、Anthropic `toolu_`）。抄编排层一处 = 每协议修两遍的教训（relay.mjs:7-12）。

## 模块职责表（19 个 src 文件）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `src/app.mjs` | HTTP 入口、路由、鉴权、生命周期。管理面错误只认 `err.httpStatus`（不认 `status`——SDK 上游码会伪装成鉴权失败） | 无具名导出，加载即启动 |
| `src/relay.mjs` | 编排核心：parse → resume 续轮 → resolveModel → startWithFailover → makeSink/attach/consume → awaitTurn → 记账 | `handle(adapter, body, res, {respondError})` |
| `src/openai.mjs` | OpenAI 适配器（只做协议形状）：normalizeTools / findResume / adapter / handleChat | `handleChat` |
| `src/anthropic.mjs` | Anthropic 适配器：AnthropicSseWriter（带 `event:` 行）/ CollectSink / toAnthropicUsage / renderPrompt / normalizeTools(input_schema) / findResume(tool_result 块) | `handleMessages`、`respondError` |
| `src/keys.mjs` | API key 池：加载/热重载/选号/错误归类（4 档）/记账落盘/探活/冷却重试/管理面 CRUD | `Verdict`、`classify`、`isSessionAuthError`、`Account`、`loadAccounts`、`select`、`reportSuccess/Failure`、`setDisabled`、`probe`、`probeOne`、`startProber`、`flush`、`addAccount(s)`、`removeAccount`、`updateAccount` |
| `src/sessions.mjs` | 管理面登录会话（纯内存，与池/计费零耦合） | `createSession`、`validSession`、`destroySession`、`penaltyMs`、`resetPenalty`、`cookie` |
| `src/catalog.mjs` | 模型目录（TTL 1h + inflight 去重、全池共用一份）、`name[参数]` 解析、便宜档默认值 | `getCatalog`、`resolveModel`、`listModels` |
| `src/tool-relay.mjs` | 工具中继：customTools ↔ tool_calls；`RelayTurn` 单轮状态机；子程序拦截 | `buildCustomTools`、`RelayTurn`、`lookupTurn`、`feedResults`、`pendingToolCalls` |
| `src/format.mjs` | messages → 单字符串 prompt、usage 字段映射 | `flatten`、`renderPrompt`、`toOpenAiUsage` |
| `src/guard-auth.mjs` | 鉴权：isClient（clientKeys）+ isAdmin（**会话 cookie 或口令头二选一**）、extractKey 三格式 + Basic、timingSafeEqual。cookie 名 `cursurspikey_sess` | `isClient`、`isAdmin`、`isAdminSecret`、`extractKey`、`authMode` |
| `src/ui.mjs` | 管理界面 SPA（琥珀色主题，区别于 k2cc 紫色）+ snapshot + loginPage。**注意：2026-08-13 起由另一个 agent 重写中，别碰** | `snapshot`、`page`、`loginPage` |
| `src/stream.mjs` | OpenAI SSE 线格式 + CollectSink + nonStreamBody（usage 在此转 OpenAI 形状） | `SseWriter`、`CollectSink`、`newCompletionId`、`nonStreamBody` |
| `src/settings.mjs` | 环境变量（14 个，CSPK_ 前缀，加载时同步求值）。默认端口 8008 | `config`、`assertConfig` |
| `src/runtime-settings.mjs` | 配置热更新：runtime-config.json（热覆盖）→ env → 默认三层；PUT /admin/config；restart-only 回填防 split-brain | `getConfig`、`getConfigView`、`setConfig`、`getField`、`reloadOverrides` |
| `src/logger.mjs` | 分级日志 + `describe`（对象序列化防 [object Object]）+ `errShape` 七字段 + 环形缓冲（/admin/logs SSE） | `log`、`describe`、`errShape`、`subscribeLogs`、`recentLogs` |
| `src/http-helpers.mjs` | JSON/文本/错误响应、readBody（64MB） | `respondJson`、`respondError`、`respondText`、`readBody` |
| `src/guard.mjs` | OTA 启动守卫 / 健康标记 / 回滚（零依赖，标记 `cursurspikey.boot_attempts/.health/.bak`） | `bumpBootAttempts`、`clearBootAttempts`、`confirmHealth`、`readStatus` |
| `src/updater.mjs` | OTA 热更新：git 模式优先 + zip 兜底；tag 白名单/防降级/token 只走直连 | `checkUpdate`、`performUpdate`、`otaEnabled`、`detectMode`、`restartNow` |
| `src/proxy-tunnel.mjs` | 上游代理注入：CONNECT 隧道 + 强制 HTTP/1.1 + undici ProxyAgent | `injectProxy` |

## 核心机制（改代码前必读）

1. **编排流程**（relay.mjs）：adapter.parse → 错误则 respondError → `resume` 分支（工具续轮最优先，不选号不建 agent）→ resolveModel → startWithFailover（选号→Agent.create→send，最多 `CSPK_MAX_ACCOUNT_ATTEMPTS`=3 次，**失败对客户端不可见**）→ **run 跑起来才 makeSink**（刻意顺序，流开始后绝不换号）→ turn.attach + consume → awaitTurn（判「无事件时长」非总耗时）→ 记账 → 非流式 finishNonStream。
2. **错误归类 4 档**（keys.mjs classifyError，顺序严格）：
   - 结构化 401 / AuthenticationError → DISABLE_AND_RETRY（可探活恢复）
   - **会话鉴权失效**（`isSessionAuthError`，消息匹配 `/authentication error/i`，如 `run error: Authentication error...`）→ DISABLE_AND_RETRY（**不可探活恢复**，走冷却；HTTP 成功、me() 200 但每次 run 都失败，2026-08-12 实测坑，test-sessionauth 守着）
   - isRetryable / 403 / 429 / 5xx → RETRY_OTHER（只换号）
   - 其余（400 等）→ RETURN（原样报错）
3. **冷却重试**（P0 分级冷却）：429 短冷却 base×连击递增（默认 5s→10s→15s，封顶 90s）、5xx 固定 30s、鉴权失效长窗 10min（`cooldownAuthMs`）。autoRecoverable=false 的号（会话鉴权失效）设 `cooldownUntil`，`select()` 前先 `releaseCooled()` 把到点的放回。**401 类不排冷却**（由探活负责，两套机制不打架）。手动禁用不被冷却放回。
4. **探活**（keys.mjs probe）：`Cursor.me()` 免费；失败 401 → 禁用 + autoRecoverable=true；成功只解禁 autoRecoverable 的号；启动 2 秒后无条件跑一轮（关周期探活也有身份）。串行 + 号间 300ms。
5. **管理面会话**（sessions.mjs + app.mjs）：`POST /admin/login`（免鉴权，口令校验，失败 penaltyMs 递增延迟前 3 次不罚封顶 5s，**刻意不锁定**——防别人锁死管理员）→ `Set-Cookie: cursurspikey_sess; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=43200`（12h 内存，上限 64 会话，Secure 仅在 X-Forwarded-Proto=https 时加）。**永不发 WWW-Authenticate**（防浏览器 Basic 弹框，弹框退不出去）。未登录访问 /admin → 200 登录页；接口 → 401 JSON。
6. **管理面 CRUD**（app.mjs）：`POST /admin/accounts`（**先 Cursor.me() 验 key 再落盘**，401 直接拒）、`/accounts/batch`（上限 200，坏的跳过带 reason、key 打码）、PATCH（只改名字/优先级，key 不可改）、DELETE、`/:id/disabled`、`/:id/probe`、`/admin/models`、`/admin/reload`、`/admin/config`（GET/PUT）、`/admin/logs`（SSE）、`/admin/logs/export`、`/admin/stats`、`/admin/update/*`、`/admin/accounts/export`。文件写入：临时文件 + rename 原子写 + **chmod 600**（踩过 644 泄露坑，有测试守着）。login/password 字段只为 key 过期后找回，view() 只回 `hasPassword` 布尔。
7. **Anthropic 协议要点**（anthropic.mjs）：流式事件序列 `message_start → content_block_start/delta/stop×N → message_delta → message_stop`，**必须带 `event:` 行**（Anthropic SDK 按事件名分派，只有 data: 会解析失败）；**usage 真值在 message_delta 补发**（message_start 时 usage 只能填 0 占位，k2cc 按 usage 计费只看 start 会归零——2026-08-12 影子实测坑）；stop_reason 映射 tool_calls→tool_use、stop→end_turn、length→max_tokens；content 不能是空数组；工具 id 前缀 `toolu_`（客户端原样回传 tool_use_id）。
8. **工具中继**（tool-relay.mjs）：请求带 tools → 中继模式（`tools:["mcp"]` 白名单关 agent 自带工具）；不带 → agent 自理。customTools 回调宿主进程执行 → 挂起 → 80ms 攒批 → `tool_calls` 吐回客户端 → 客户端另发请求带结果 → adapter.findResume 抠 id → `lookupTurn` 找回 RelayTurn → `feedResults` resolve → **同 run 继续，不选号不重计费**（工具往返中间不记账，只在 turn.finished 记一次，relay.mjs）。`RelayTurn.account` 锁定本轮号（中途换号=换脑子）；attach 顶掉旧 sink 防挂死；无 sink 时缓存补发。子程序拦截正则 `/^(task|subagent|best[_-]?of[_-]?n|(spawn|launch|create|run|start|dispatch|delegate)[_-]?(sub)?agent)/i`（误伤 taskStatus 是已知取舍），`CSPK_ALLOW_SUBAGENTS=true` 放行（tool-relay.mjs 直接读 env，不进 config）。
9. **usage 转换下沉**：RelayTurn 往 sink 送 **SDK 原始形状**（inputTokens/outputTokens），stream.mjs 转 OpenAI（prompt_tokens/completion_tokens/cached_tokens）、anthropic.mjs 转 Anthropic（input_tokens/output_tokens/cache_read_input_tokens）。曾在这里直接转死一种导致另一种全 undefined 且不报错（tool-relay.mjs 注释有记录）。
10. **模型参数解析**（catalog.mjs resolveModel）：`模型id[word1, word2]`，裸词反查维度值、k=v、维度 id 即开关、未知词 warn 忽略、未知模型 400。**fast/thinking 默认强制 false 档**（防烧钱：composer-2.5-fast 一次扣 2 request）。
11. **鉴权**（guard-auth.mjs）：isClient 认 clientKeys（空 = 不鉴权，仅限本机监听有告警）；isAdmin = 有效会话 cookie **或** isAdminSecret（口令头，Bearer/x-api-key/Basic 都认）；调用方 key 绝不能当管理员（Basic 取密码段、口令带冒号只按第一个冒号切）；timingSafeEqual 定长比较，长度不同也对自身比一次。
12. **超时设计**：HTTP 超时全关（app.mjs，流式靠 turnIdleTimeoutMs 默认 10min 兜底，判静默非总耗时）；工具结果等 client 回传 10min（toolResultTimeoutMs，tool-relay.mjs）；keepAliveTimeout 75s。
13. **OTA**（updater.mjs + guard.mjs + boot.mjs）：zip 模式替换 src/ 前先备份 `cursurspikey.bak`；守卫在 src 之外，新版本启动即崩时 boot_attempts 计数 ≥3 自动回滚；listen 成功清零、30s 稳定写 `cursurspikey.health`。git 模式无 bak（回滚靠 git 历史）。

## 配置项（14 个，settings.mjs，CSPK_ 前缀）

`CSPK_PORT`(8008) / `CSPK_HOST`(127.0.0.1) / `CSPK_ACCOUNTS`(/data/accounts.json) / `CSPK_MAX_ACCOUNT_ATTEMPTS`(3) / `CSPK_PROBE_INTERVAL_MS`(30min，0=关周期但启动仍探一次) / `CSPK_CLIENT_KEYS` / `CSPK_ADMIN_KEY` / `CSPK_PREFIX` / `CSPK_WORKSPACE`(/work) / `CSPK_SHOW_TOOLS`(**定义未消费**，settings.mjs) / `CSPK_TURN_IDLE_TIMEOUT_MS`(10min) / `CSPK_TOOL_RESULT_TIMEOUT_MS`(10min) / `CSPK_LOG_LEVEL`(info，可热更) / `CSPK_ALLOW_SUBAGENTS`（散装 env）。热更新键见 runtime-settings.mjs FIELDS。

注意：**会话 TTL 12h 硬编码**（sessions.mjs，非 env）；docker-compose.yml **不传** TURN_IDLE/TOOL_RESULT/SHOW_TOOLS 三个键（改 .env 这两个超时值容器不生效——静默坑）。

## 已知边界与坑

- **ui.mjs 正在被另一个 agent 重写**（品牌/API 展示文案适配中），别碰；后端 API 路径 /v1/*、/admin/* 已冻结。
- **本地 .env 尚未迁移**（用户侧）：仍是 CURSOR_* 前缀 + 8790 端口，需手动改（仓库内已全量 CSPK_*）。
- docs/ 研究文档（KIRO-RESEARCH / REVERSE-SDK / COMPARISON / ADR-001 / REVERSE-UI-PLAN）仍引用旧名，历史记录刻意未动。
- **CSPK_SHOW_TOOLS 仍未消费**（settings 定义，全仓无引用）。
- 非流式 idle 超时疑点（旧记录）：relay.mjs 超时分支对 CollectSink 是否写 HTTP 响应未复核，候选 bug。
- 工具续轮 `byToolCall` 内存 Map：**重启服务后未完成轮次失联**，客户端回传走新对话白计一次费（无状态设计固有代价）。
- 测试触网问题：test-keys 异步探活残留打到真网（假 key 401）+ test-ui 的 /admin/models 断言 502 打真网。「测试不触网」不再严格成立。
- 流开始后的错误只能当文本混进流（`\n\n[cursurspikey] ...`），HTTP 已是 200，finish_reason 仍 stop。
- 换 key = 新 id（sha256 前 12 位）= 旧 stats 变孤儿（不清理，无害）。
- 状态页/接口绝不含 key 原文：view() 只出 maskedKey（头 10 尾 4）+ hasPassword 布尔，有测试守着。

## 测试与验证

```bash
npm test    # 9 个测试串联，2026-08-13 全部通过
```

- test-keys.mjs（池：归类/选号/热重载/记账/CRUD/批量/权限 600/不泄露 key/failover）
- test-format.mjs（messages → prompt、usage 映射）
- test-protocol.mjs（双协议适配：工具归一、Anthropic usage 红线、renderPrompt、SSE 事件序列红线）
- test-tool-relay.mjs（工具中继：注册/拦截/对号/usage 原样/describe）
- test-guard-auth.mjs（鉴权三格式 + Basic + 会话 cookie + 惩罚不锁定）
- test-ui.mjs（管理界面端到端：真服务 + vm 跑页面脚本；WWW-Authenticate 永不出现红线；含少量中文断言——UI 仍中文）
- test-sessionauth.mjs（会话鉴权失效识别 + 冷却自愈）
- test-runtime-settings.mjs（三层解析/PUT 热更/restart-only/脱敏/原子写）
- test-updater.mjs（OTA：semver/tag 白名单/防降级/镜像安全线/守卫回滚）

跑前要 `npm install`（无 node_modules 会 ERR_MODULE_NOT_FOUND）。测试基本离线，但如上所述有两处打真网（失败请求、不计费）。

## 部署

Dockerfile：node:22-slim + 非 root UID/GID 10003（用户 cursurspikey）+ 依赖层缓存 + HEALTHCHECK /ping（免鉴权就是为它留的，CSPK_PORT||8008）。docker-compose.yml：服务名 cursurspikey、只绑 `127.0.0.1:8008`、data/work 卷（stats 是唯一账必须可写）、CSPK_CLIENT_KEYS/CSPK_ADMIN_KEY 无默认值。**docker-compose.override.yml**：容器名 `skiapi-cursurspikey` + 挂 external 网络 `skiapi`——已并入 skiapi 部署环境（Caddy 反代后，cookie Secure 判断靠 X-Forwarded-Proto）。

## 设计哲学（改代码先对表）

1. 注释写实测证据（「composer-2.5-fast 扣 2 request」「getUsage 一律 403」「上游 3h16m 自愈」），新注释跟这个风格。
2. 失败路径不静默：非 function 工具跳过打日志、errShape 七字段全量落日志、describe() 序列化对象（[object Object] 事故）。
3. 不可逆动作（禁号）只给精确判据（401/会话鉴权失效）；拿不准就换号重试。禁用要能自愈（探活或冷却），禁死不放会「只禁不放不自愈」。
4. 管理面错误只认 `httpStatus`，不让 Cursor 上游错误伪装成鉴权失败踢用户回登录页。
5. 改动最小、风格跟随（ESM、英文注释、无分号）。

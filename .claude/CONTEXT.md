# cursorapi 项目背景（subagent 专用）

> 2026-08-14 重写。品牌：**cursorapi / CURSOR_* 前缀 / cookie `cursorapi_sess`**（旧版 CursurSPIKEY / CSPK_* 内容已全部废弃）。功能描述对照 `src/` 源码核实，锚点附 `文件:行号`；拿不准的标「未核实」或省略，不要编。

## 项目一句话

**cursorapi**（GitHub `dwgx/cursorapi`，公开）把**一池 Cursor API key** 包装成 OpenAI 兼容（`/v1/chat/completions`）与 Anthropic 兼容（`/v1/messages`）的 HTTP API。客户端写 Cursor 模型 id（可带 `[参数]` 后缀，如 `claude-opus-5[1m,max]`），号由池子挑、坏了自动换、禁用可自愈，客户端无感。Node ≥ 22.13、ESM、零框架，唯一运行时依赖 `@cursor/sdk ^1.0.27`；默认端口 8008。生产部署 nbus VPS（38.244.34.15:8008，systemd + OTA git 模式）。与 cursor-bridge 刻意不同：**数据面无状态、每轮独立计费**（管理面才有会话登录）。

## 架构分层（无环依赖）

```
底层（无项目内依赖）：settings  logger  http-helpers  stream  format
中层：                keys（号池）  sessions（管理面会话）  catalog（模型目录）  tool-relay（工具中继）
编排：                relay（双协议共用，只认 adapter 契约，不懂任何线格式）
协议适配：            openai（/v1/chat/completions）  anthropic（/v1/messages）
UI：                  ui（管理面板 SPA + snapshot + loginPage）
最高：                app（路由/鉴权/限流/生命周期）  boot（唯一入口，OTA 守卫最先跑）
```

19 个 src 模块 + `_bundle.cjs`（构建产物，勿改）。关键锚点：`app.mjs` clientIp:450 / createRateLimiter:470 / dispatchData:535；`relay.mjs` settle:306 / consumeDeadlineMs:39；`keys.mjs` classifyError:121 / pushRecentRequest:577 / listRecentRequests:590 / slidingLoad:860 / rankVector:892；`guard-auth.mjs` SESSION_COOKIE="cursorapi_sess":10；`tool-relay.mjs` byToolCall:20 / BATCH_WINDOW_MS:26。

| 模块 | 职责 |
|---|---|
| `app.mjs` | HTTP 路由 + 鉴权 + 入站限流；管理面错误只认 `err.httpStatus` |
| `relay.mjs` | 编排：parse→resume→resolveModel→startWithFailover→attach/consume→awaitTurn→settle→记账 |
| `openai.mjs` / `anthropic.mjs` | 协议适配器（parse/makeSink/feed/finishNonStream/callIdPrefix 五件套）；Anthropic SSE **必须带 `event:` 行**、usage 真值在 message_delta |
| `keys.mjs` | 号池：加载/热重载/选号/错误分类/冷却/探活/记账/CRUD/最近请求环形缓冲 |
| `sessions.mjs` | 管理面登录会话（纯内存，12h TTL 硬编码、上限 64、惩罚不锁定） |
| `catalog.mjs` | 模型目录（TTL 1h + inflight 去重）、`name[参数]` 解析 |
| `tool-relay.mjs` | 工具中继：customTools↔tool_calls、RelayTurn 状态机、子程序拦截 |
| `format.mjs` | messages→单串 prompt、usage 字段映射 |
| `guard-auth.mjs` | 鉴权：isClient / isAdmin（会话 cookie 或口令头）/ extractKey 三格式 + Basic / timingSafeEqual |
| `ui.mjs` | 管理面板 SPA（琥珀主题）+ snapshot + loginPage |
| `stream.mjs` | OpenAI SSE 线格式 + CollectSink + nonStreamBody |
| `settings.mjs` | 环境变量 27 个（CURSOR_ 前缀，加载时同步求值） |
| `runtime-settings.mjs` | 三层热配置：runtime-config.json→env→默认；PUT /admin/config |
| `logger.mjs` | 分级日志 + errShape + 环形缓冲 1000 条（/admin/logs SSE 底） |
| `http-helpers.mjs` | JSON/文本/错误响应、readBody(64MB) |
| `guard.mjs` | OTA 启动守卫/健康/回滚（标记 `cursorapi.boot_attempts`/`.health`/`.bak`） |
| `updater.mjs` | OTA：git 优先 + zip 兜底；tag 白名单/防降级/token 只走直连 |
| `proxy-tunnel.mjs` | 上游代理：CONNECT 隧道 + 强制 HTTP/1.1 |

## 数据流要点

1. **数据面**（app.mjs dispatchData :535）：isClient 鉴权（401）→ `rateLimiter.check`（429 + Retry-After）→ `/v1/models` / 双协议 POST。限流在鉴权后、处理前：无 key 洪水不计桶。
2. **编排**（relay.mjs）：adapter.parse → 错误则 respondError → `resume` 分支（工具续轮最优先，不选号不建 agent）→ resolveModel → startWithFailover（选号→Agent.create→send，最多 3 次，**失败对客户端不可见**）→ **run 跑起来才 makeSink**（流开始后绝不换号）→ attach + consume → awaitTurn（判「无事件时长」非总耗时）→ settle 记账 → finishNonStream。
3. **结算**（settle :306）：工具往返不是 turn，只有真正结束才落：reportSuccess/Failure → recordRequest → **pushRecentRequest**（:313）。
4. **工具中继**：请求带 `tools` → 中继模式（关 agent 自带工具）；customTools 回调宿主进程执行 → 挂起 → 80ms 攒批 → `tool_calls` 吐回 → 客户端回传结果 → findResume 抠 id → `byToolCall` 找回 RelayTurn → feedResults resolve → **同 run 继续，不选号不重计费**。RelayTurn.account 锁定本轮号。
5. **Anthropic 要点**：事件序 `message_start → content_block_* → message_delta → message_stop`，**必须带 `event:` 行**（SDK 按事件名分派）；usage 真值在 message_delta 补发；工具 id 前缀 `toolu_`。

## v0.1.0 新功能（已对照源码核实）

- **最近请求明细**：keys.mjs 环形缓冲 500（RECENT_REQUESTS_CAP :568）；app.mjs `GET /admin/requests?limit=N`（默认 50 上限 500，:235）；relay.mjs settle 挂钩 :313；UI 表 `renderReqTable`:1687 / `loadRequests`:1601（reqBusy/reqFailAt 守卫 :840），一行一请求、点击展开详情（reqRowHtml :1660 的 detail-row）。
- **入站限流**：`CURSOR_RATE_LIMIT_PER_MIN`（0=关）+ `CURSOR_TRUSTED_PROXY`（settings.mjs:92,100）；app.mjs `clientIp`:450 —— **无信任代理一律忽略 XFF**（socket 地址即身份，防伪造换桶）；有信任代理只信最右一段且须公网地址；`createRateLimiter`:470 固定窗口 60s + 桶上限清扫。test-rate-limit.mjs 15 项。
- **select 优化**：keys.mjs `slidingLoad`:860 head 指针 + 数组引用校验（:864）；`rankVector`:892 5 维预计算（health/ramp/inflight/rpm/priority，:963-971 先算后比，比较器纯化；200 号池 34.4→20.6µs）。
- **consume 死线**：relay.mjs :39 = `2×turnIdleTimeoutMs + toolResultTimeoutMs`；流挂死（上游死流且 cancel 无效）触发补 cancelRun（:407-415）。test-relay-cancel.mjs 用 load hook 伪造 SDK 覆盖。
- **管理面板**（ui.mjs）：冷却倒计时 `coolTick`:2930（全局 1s interval + 账号页可见性守卫）；账号搜索 `filteredAccounts`:1290；ESC 退出登录 `onKeyDown`:2914（输入框/弹窗开着不抢）；日志断线自动重连 `scheduleLogRetry`:1449（2s→30s 退避，nostream/manual 不重试）；主题切换 `toggleTheme`:732（按钮在 page-header :707）；footer 设置按钮:699 + 退出登录:700；复制 `copyText`:1374 / `copyBtn`:1384（clipboard try/catch + fallback），完整 Key 走 `GET /admin/accounts/:id/secret`（app.mjs:383，唯一可审计的明文揭示路径，导出接口仍只给掩码）。
- **统计图**：图例 `updateLegend`:2130 带区间合计（legendHtml :2159，随区间切换重画）；Y 轴从 0 起 niceMax 取整 1/2/5×10ⁿ（:2186）；tooltip 成功率（:950）。

## 核心机制（改代码前必读）

1. **错误分类**（classifyError :121，顺序严格）：401 / AuthenticationError → DISABLE_AND_RETRY（可探活恢复）；会话鉴权失效（`isSessionAuthError` 消息匹配；key 在 API 层仍有效但每次 run 都失败——2026-08-12 实测坑，test-sessionauth 守）→ DISABLE_AND_RETRY（**不可探活恢复**，长冷却）；region blocked → RETRY_OTHER 不冷却；gRPC resource_exhausted 区分模型门禁（RETURN）与真限流（RETRY_OTHER + quota 标记）；CODE_VERDICTS 按 code 优先；Retry-After 只对瞬时错误；isRetryable / 403 / 5xx / 超时 → RETRY_OTHER；其余 → RETURN 原样报错。
2. **冷却分级**：429 base×连击递增封顶 90s、5xx 固定 30s、鉴权失效 10min、quota 30min、401 45s / 403 20s；半开恢复 `CURSOR_HALF_OPEN_SUCCESSES`=3；401 类不排冷却（探活负责，两套不打架）。手动禁用不被冷却放回。
3. **探活**（keys.mjs probe）：`Cursor.me()` 免费；失败 401 → 禁用 + autoRecoverable=true；成功只解禁 autoRecoverable 的号；启动 2s 后无条件跑一轮。
4. **管理面会话**：`POST /admin/login` 免鉴权口令校验，失败 penaltyMs 递增前 3 次不罚封顶 5s（**刻意不锁定**，防别人锁死管理员）；cookie `cursorapi_sess`、12h 内存态（硬编码）、上限 64，Secure 仅 X-Forwarded-Proto=https 时加。**永不发 WWW-Authenticate**（防浏览器 Basic 弹框退不出去）。未登录 /admin → 200 登录页；接口 → 401 JSON。
5. **管理面 CRUD**：POST /admin/accounts **先 Cursor.me() 验 key 再落盘**；/accounts/batch 上限 200 坏的跳过带 reason、key 打码；PATCH 只改名字/优先级；`/:id/secret` 是唯一明文揭示路径。文件写入：临时文件 + rename 原子写 + **chmod 600**（644 泄露坑有测试守）。
6. **鉴权**（guard-auth.mjs）：isClient 认 clientKeys（空 = 不鉴权，仅限本机监听有告警）；isAdmin = 会话 cookie **或** isAdminSecret（Bearer / x-api-key / Basic 都认）；**调用方 key 绝不能当管理员**；timingSafeEqual 定长比较。
7. **超时**：HTTP 超时全关；流式靠 turnIdleTimeoutMs（默认 10min，判静默非总耗时）+ consume 死线兜底；工具结果等回传 10min；keepAliveTimeout 75s。
8. **模型参数**（catalog.mjs resolveModel）：`模型id[word1, word2]`，裸词反查维度值、k=v、维度 id 即开关、未知词 warn 忽略、未知模型 400。**fast/thinking 默认强制 false 档**（防烧钱：实测 composer-2.5-fast 一次扣 2 request）。
9. **OTA**（updater + guard + boot）：zip 模式替换 src/ 前先备份 `cursorapi.bak`；守卫在 src 之外，启动即崩时 boot_attempts ≥3 自动回滚（guard.mjs:13-15）；listen 成功清零、30s 稳定写 `.health`。git 模式无 bak（回滚靠 git 历史）。zip 走 release 源码包 + **sha256 双信道**（哈希强制 github 直连）。
10. **usage 转换下沉**：RelayTurn 往 sink 送 SDK 原始形状，stream.mjs 转 OpenAI（prompt_tokens 等）、anthropic.mjs 转 Anthropic（input_tokens 等）。曾在此直接转死一种导致另一种全 undefined 且不报错。

## 配置项（settings.mjs，CURSOR_ 前缀，27 个）

核心：`PORT`(8008) / `HOST`(127.0.0.1) / `ACCOUNTS`(/data/accounts.json) / `MAX_ACCOUNT_ATTEMPTS`(3) / `PROBE_INTERVAL_MS`(30min，0=关周期但启动仍探) / `CLIENT_KEYS` / `ADMIN_KEY` / `RATE_LIMIT_PER_MIN`(0=关) / `TRUSTED_PROXY` / `PROXY` / `MODEL_DEFAULTS` / `PREFIX` / `WORKSPACE`(/work) / `TURN_IDLE_TIMEOUT_MS`(10min) / `TOOL_RESULT_TIMEOUT_MS`(10min) / `LOG_LEVEL`(info，可热更) / 冷却族（COOLDOWN_429_BASE/429_MAX/5XX/AUTH/401/403/QUOTA + HALF_OPEN_SUCCESSES + RATE_LIMIT_DECAY_MINUTES） / `ALLOW_SUBAGENTS`（散装 env，tool-relay.mjs:39）。热更键见 runtime-settings.mjs FIELDS。

注意：`CURSOR_SHOW_TOOLS` → `showToolActivity` 已注册热配置 + UI 设置页，但数据面未见消费点（未核实，疑似延续旧「定义未消费」状态）。会话 TTL 12h 硬编码非 env。

## 测试体系（14 个 test-*.mjs，13 套真实断言 309 项）

`npm test` 串联全部，离线不花钱；跑前要 `npm install`（无 node_modules 会 ERR_MODULE_NOT_FOUND）。**test-relay-hook.mjs 不是套件**，是 test-relay-cancel.mjs 的 load hook 支撑模块（`node:module registerHooks` 伪造 @cursor/sdk，覆盖 cancel/死流/启动超时）。

项数：keys 97 · protocol 30 · ui 34（真服务 + vm 跑页面脚本；WWW-Authenticate 永不出现红线）· runtime-settings 22 · tool-relay 21 · guard-auth 15 · rate-limit 15（XFF 信任模型）· sessionauth 14 · relay-cancel 9 · format 9 · http-helpers 7 · logger 3 · updater 33（OTA/semver/防降级/sha256/守卫回滚）。

## 常用命令

```bash
npm test                 # 全部 13 套（离线）
node boot.mjs            # 本地起服务（8008）
curl localhost:8008/ping # 健康（免鉴权）
```

## 铁律

- **生产不能死机**：禁止直接改生产文件、禁止重启 cursorapi.service（除非用户明确指令）；流程 = 本地验证 → 用户确认 → 生产。
- 不动 skiapi（143.20.230.62）上任何服务；不碰账号池/凭据/配置。
- 涉及凭证读 `~/.claude/SECRETS.md`，值绝不输出/落盘/提交；subagent prompt 要带上这条（不自动继承）。
- 本地 8GB 内存：跑构建/测试的 agent 并行 ≤5。
- **ui.mjs 转义铁律**：模板字符串嵌套——JS 块内禁反引号与 `${}`；字符串内换行必须 `\\n`（模板层 `\\\\n`）；curl 示例避免反斜杠续行；改完必须「渲染后 script 提取 + node --check」验证（测试沙箱无 classList/querySelector）。
- 不可逆动作（禁号）只给精确判据（401/会话鉴权失效）；拿不准就换号重试；禁用要能自愈（探活或冷却）。
- 注释写实测证据（「composer-2.5-fast 扣 2 request」「getUsage 一律 403」），新注释跟这个风格。
- 改动最小、风格跟随（ESM、英文注释、无分号）。

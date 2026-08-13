# cursorapi 与三个参考网关的对比（2026-08-13）

研究基线：本地 clone/已有仓库（kirostudio 本地已有、sub2api 已 clone 到 `~/Documents/WorkSpace/Project/sub2api`、windsurf 本地已有）。

## 一、四方定位

| | cursorapi | kirostudio | sub2api | windsurf-api |
|---|---|---|---|---|
| 语言/形态 | Node.js ESM 单体 | Rust 单二进制（前端 embed） | Go 单体（前端 embed） | Node ESM 模块化 |
| 上游 | **Cursor 号池**（API key） | Kiro/AWS Q（OAuth/ksk key/透传） | 6 平台订阅（Claude/OpenAI/Gemini/Grok/Antigravity/Bedrock） | Windsurf/Devin（token/本地提取） |
| 协议出口 | OpenAI + Anthropic | Anthropic（主）+ OpenAI | OpenAI + Anthropic + Gemini + 专用 | OpenAI + Anthropic + Gemini + Responses |
| 规模 | ~4.8k 行，17 模块 | ~9 万行 Rust | ~15 万行 Go | ~60+ 文件 |
| 号池 | priority+RR+冷却+自动禁用 | 8 键排序+亲和+熔断+族级连坐 | 负载感知+快照+粘性+并发槽 | 5 维排序+粘性+熔断+配额感知 |
| 管理面 | 会话登录+号池 CRUD 面板 | React SPA 40+ 端点 | Vue SPA 20+ 管理页 | 单 HTML 面板 40+ 端点 |
| 计费 | 自己记账（run 次数+token） | 无（B2B 网关） | **完整商业计费**（订阅/倍率/支付） | 无（账号余额感知） |
| 数据库 | JSON 文件（stats） | SQLite（用量） | **Postgres + Redis** | JSON 文件 |

## 二、能力矩阵（cursorapi 现状 vs 三家）

| 能力域 | cursorapi 现状 | kirostudio | sub2api | windsurf-api | 差距判断 |
|---|---|---|---|---|---|
| 多协议出口 | ✅ OpenAI + Anthropic（adapter 模式） | ✅（主 Anthropic） | ✅（4 协议） | ✅（4 协议） | 持平，架构同款（薄适配层） |
| 双协议共用管线 | ✅ engine.mjs 编排核心 | ✅（openai 层调 anthropic 管线） | ✅ | ✅ 统一内部格式 | 持平，三家都是这个思路 |
| 选号调度 | priority 档 + RR + 排除集 | 8 键排序 + 原子锁 + 排除集 | 负载感知 + 快照 + 权重随机 | 5 维排序 + 哈希分片 | **差距：cursorapi 最朴素的** |
| 粘性会话 | ❌ 无（每轮换号） | ✅ session_id→credential TTL | ✅ session_id 绑定 | ✅ sticky 30min + 开关 | **差距：prompt cache 成本直接相关** |
| 熔断/冷却分层 | ✅ 冷却 10min + autoRecoverable | ✅ AIMD 熔断 + 8 种冷却 + 族级连坐 | ✅ 状态机 | ✅ 指数退避 + 半开恢复 | 中差（cursorapi 冷却单一） |
| 错误分类 | ✅ 4 档（401/会话鉴权/可重试/其余） | ✅ map_provider_error + Retry-After | ✅ 阶段归因 | ✅ 3 级分类 + !emitted 纪律 | 持平偏优 |
| 流式处理 | ✅ SSE 线格式（OpenAI/Anthropic） | ✅ 字节缓冲切帧 + 明确终止 | ✅ | ✅ 字节级管道 + 心跳 | 中差（cursorapi 无心跳/字节缓冲） |
| 工具中继 | ✅ customTools 拦截 + 子程序拦截 | ✅ 工具配对修复 | ✅ | ✅ 参数规范化 | 持平（子程序拦截是独有） |
| 用量统计 | ✅ 内存计数 + stats.json 防抖落盘 | ✅ SQLite + OS 线程管道 | ✅ usage_logs 异步批量 | ✅ stats.json + 分桶 | 中差（cursorapi 最简，够用但无维度） |
| 管理面板 | ✅ 会话登录 + CRUD + 模型/接入视图 | ✅ 40+ 端点 | ✅ 20+ 管理页 | ✅ 40+ 端点 | 持平（功能够用） |
| 配置热重载 | ✅ 号池热重载 + stats 落盘 | ✅ 三档热重载 | ✅ | ✅ runtime-config.json | 中差（cursorapi 无运行时配置热调） |
| 模型目录 | ✅ 动态拉取 + 参数解析 + 便宜档 | ✅ 声明式单一真相源 | ✅ 价格表 | ✅ 静态+动态+别名表 | 中差（cursorapi 依赖上游拉取） |
| 安全 | ✅ 两级 key + 会话 cookie + 定长比较 | ✅ IP 白名单 + SSRF + 脱敏 | ✅ 全套 | ✅ 两层 key + 防爆破 | 中差（cursorapi 无 IP 白名单/SSRF） |
| 计费 | ❌ 只记账不收费 | N/A | ✅ 完整商业闭环 | ❌ | 差距大（如需商业化） |

## 三、对 cursorapi 最有借鉴价值的 TOP 10（按性价比）

| # | 借鉴项 | 来源 | 为什么 | 复杂度 |
|---|---|---|---|---|
| 1 | **粘性会话（sticky session）**：callerKey+model→account TTL 绑定，开关控制绑号失败拒绝/轮转 | windsurf-api sticky-session.js | Cursor 上游 prompt cache 按账号隔离，换号 = 上下文重写 = 10 倍写入单价。当前 cursorapi 每轮换号，长对话用户被反复打 cache 成本 | 中（~200 行） |
| 2 | **原子选号**：选号+inflight+1+rpm 记录同临界区；排除集是偏好非硬门（全排除允许重选，不报池空） | kirostudio token_manager.rs:3220-3329 | 防并发惊群（N 请求同时选中同号）+ 防假性排队。cursorapi 的 `rr++` 选号在并发下无保护 | 中 |
| 3 | **错误 Retry-After 透传**：内层算好退避秒数挂头，出口只透传不重写判据 | kirostudio openai/handlers.rs:357-427 | 双协议对同一上游 429 行为一致，客户端才能正确 backoff。cursorapi 目前错误处理两协议各写各的 | 低 |
| 4 | **SSE 字节缓冲切帧 + 心跳**：按 `\n\n`/`\r\n\r\n` 边界缓冲解码（防中文截断），`: ping` 15s 心跳防代理断连 | kirostudio handlers.rs:429-509 + windsurf-api | 流式是客户端感知最敏感处；中文/emoji 多字节被网络 chunk 切断是真实坑 | 低-中 |
| 5 | **运行时配置热调**：runtime-config.json（null→env→默认三层），面板改不重启 | windsurf-api runtime-config.js | 号池运营 90% 调参（冷却时长、限流阈值）不该重启。cursorapi 目前除号池外全静态 | 低-中 |
| 6 | **账号健康分排序**：候选过滤后按 in-flight 最少→近期故障→配额→RPM 剩余→LRU 排序 | windsurf-api getApiKey | 每个维度对应一个真实故障模式；cursorapi 的 priority+RR 不看健康度，抽风号会被反复选 | 中高 |
| 7 | **用量统计升级**：请求级埋点 → 有界队列 → 独立线程/进程写盘（防阻塞事件循环） | kirostudio usage/pipeline.rs | Node 单线程下 stats 写盘会卡主循环；cursorapi 现在防抖 10s 落盘其实 OK，但无维度聚合 | 低 |
| 8 | **熔断器 + 半开恢复 + degraded serve**：连续错误指数退避；冷却到期半开试探；全池冷却选最短冷却号顶上（不硬 429） | windsurf-api runtime-config.js:113-138 | 自愈闭环；cursorapi 冷却到点直接全量放回（kirostudio 指出会全量涌回再打崩） | 中 |
| 9 | **模型目录别名表 + 静态兜底**：静态 100+ 目录离线可用 + 启动拉云端合并 + 别名（opus-4.6→claude-opus-4.6） | windsurf-api models.js | cursorapi 现在纯靠上游拉取，上游挂了 /v1/models 就 502；加静态兜底 + 别名提升兼容 | 低-中 |
| 10 | **工具配对修复 + 消息交替归一**：转发前修复孤儿 tool_result/悬空 tool_use/连续同角色 | kirostudio convert.rs:601-731 | Cursor 上游（Anthropic 系）对消息交替极严；双协议网关 400 大部分来自这里 | 中 |

## 四、明确不做 / 后置（现阶段）

- **sub2api 式商业计费**（订阅/支付/倍率/拼车）：需要 PG+Redis 全套，与 cursorapi 的 JSON 文件形态冲突。如果要做商业化，优先借鉴三层模型（Account/Group/UserSubscription）而不是整套支付。
- **族级连坐 / OAuth 多平台接入 / OTA 自更新**：kirostudio 重工程，Cursor 号池场景不适用（无族概念、key 非 OAuth、更新靠 docker compose 重拉即可）。
- **多副本 / 分布式**：windsurf-api 自己都标注多副本有共享问题；cursorapi 单机 JSON 足够。
- **Gemini/Responses 协议**：除非有明确客户端需求，OpenAI+Anthropic 已覆盖 Claude Code/Codex/Cline 生态。

## 五、架构确认

cursorapi 的「engine.mjs 编排核心 + 协议适配器」结构与 kirostudio（openai 薄层调 anthropic 管线）、windsurf-api（统一内部格式 + 翻译器三件套）、sub2api（统一入口按平台路由）是**同一流派**——新增协议只加转换器，调度/重试/冷却/鉴权/用量全复用。这个架构不需要改，往里加能力即可。

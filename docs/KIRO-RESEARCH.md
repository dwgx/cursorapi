# 四仓研究：对 cursorapi 的可复用逻辑与 0 依赖路线

> 2026-08-13。研究范围：kiro-rs-tool（GreyGunG，36k 行）、kiro-rs（ZyphrZero，45k 行）、
> kirostudio（本地，112k 行）、windsurf（本地，用户自研 0 依赖网关）。
> 四份 subagent 报告已抽查核实关键锚点（选号/双检锁/排序键/会话池/varint 等）。
> 目的：① 移植可复用算法到 cursorapi；② 为逆向 @cursor/sdk 后的自研实现（CURSOR_USE_SDK 双实现）铺路。

## 一、四仓定位与关系

| 仓库 | 定位 | 与 cursorapi 的关系 |
|---|---|---|
| kiro-rs-tool | Anthropic 兼容面 → Kiro 上游（AWS Event Stream），Claude Code 工具兼容增强分支 | 同构：协议转换 + 号池 + 工具适配 |
| kiro-rs | Anthropic/OpenAI/Responses 三兼容面 → Kiro 上游，token 刷新 + 故障转移 + admin | 同构：三协议面 + 凭据调度 + 计量 |
| kirostudio | 同一祖先的三个平行增强 fork 中工程量最大的运维/韧性向深度增强（token_manager 15,975 行） | 同构 + 深度：健康分/熔断/冷却分级/吸收层 |
| windsurf | **用户自己的 0 依赖网关**（Windsurf/Devin → 三套标准 API，零 npm 依赖） | **0 依赖路线直接蓝本** |

共同结论：cursorapi 与 kiro 系是**同构网关**（协议兼容面 + 号池 + 计量 + 面板），
高价值移植区高度重合；windsurf 证明 0 依赖网关在此规模（数千行）完全可行且踩坑清单现成。

## 二、cursorapi 现状缺口（研究确认）

1. 选号只有 priority+round-robin，无健康/用量/inflight 维度，无临界区（pool.mjs:451-459）
2. 单一 10min 冷却，429/5xx 完全不冷却（pool.mjs:33,94-96）
3. classify 只有 4 类，错误体无 Retry-After、无退避语义
4. failover 循环无 sleep 无预算（engine.mjs:50-99），流开始后失败只能当内容吐
5. 无会话亲和（每轮新建 agent，轮间不绑定）
6. 无用量统计维度（仅按号聚合 stats.json）
7. sse.mjs 直接字符串 write，无缓冲切帧、无心跳（sse.mjs:42）
8. 无任何限流
9. 无半开试探恢复（冷却到期全量放回，pool.mjs:188-194）
10. 工具中继 resume 喂不进结果直接 fail（engine.mjs:188-195）
11. 探活固定 30min 无按需（pool.mjs:752-773）
12. 中文被 chunk 切断风险（sse.mjs 模板串拼接）
13. 无模型别名映射表
14. sameSecret 无常量时间防护（auth.mjs:19-28）
15. Retry-After 不透明（上游原值被吞）

## 三、移植优先级（P0-P3，跨四仓去重后）

### P0（先做，~220 行）

1. **选号 5 维排序键**：`(health_tier, ramp_tier, inflight, rpm_usage, priority_tiebreak)`，
   select() 内同步完成选号+占位（消除窗口）。来源：kirostudio token_manager.rs:3407-3589。
2. **冷却分级替换单一 10min**：429→短冷却递增（5-15s，上限 90s）、5xx→30s、鉴权失效→长窗+探活恢复。
   429 冷却必须短（kirostudio 实测：300s→50s 冷却让小池整池 503 自伤）。
   来源：kirostudio cooldown.rs:36-116、494-525。
3. **错误翻译表 + Retry-After 透传**：classify 扩展为 `{code, retryAfterSecs, absorbable, exchange}` 判定表。
   铁律：429 带 RA 透传；永久态（模型不支持）绝不带 RA；池空返 503 不返 429（Cursor 见 429 掐会话）。
   来源：kirostudio handlers.rs:1461-1760、kiro-rs error.rs:35-46。

### P1（次做，~330 行）

4. **瞬态错误吸收层**：engine.mjs 加 `absorb(maxRounds, budgetSecs)` 包裹 send 阶段
   （send 返回前可安全重试，engine.mjs:41-49 已有隐式边界）。总预算 45s + 每请求 ≤4 次上游硬顶。
   429 退避 1s→2s→4s→8s；流式发过字节绝不重试。来源：kirostudio provider.rs:2376-2590、4087-4095。
5. **会话亲和**：`Map<conversationId, {credId, expiresAt}>` TTL 30min，命中旁路排序；
   三条约束：排除集旁路生效、饱和不粘、饱和时临时解绑不删表（保 prompt cache）。
   来源：kirostudio affinity.rs:37-52、token_manager.rs:3279-3327。
6. **用量双口径聚合**：新建 metrics.mjs，内存聚合 + 10s 批量 flush JSONL；
   by_model / by_requested_model 双口径、TTFB 独立分母。来源：kirostudio usage/、windsurf trace.js。
7. **令牌桶限流入站**（简单版 30 行）：容量 `max(1, rpm*1000/60)*burst`，排队超时默认放行（整形不拒绝）。
   来源：kirostudio throttle.rs:243-282。

### P2（~180 行）

8. **半开试探恢复**：冷却到期不整池放回，admit_prob 0.1 试探，成功连续 5 次回 Closed，失败回 Open 种子 ×0.5。
   来源：kirostudio health.rs:276-315。
9. **SSE 心跳 + 缓冲切帧**：25s ping 保活 + 首字节前不发 + Buffer 按 UTF-8 边界切帧 + 空流兜底错误事件。
   来源：windsurf chat.js:3401-3405、messages.js:1370-1377、kiro-rs-tool handlers.rs:856-860。
10. **模型映射表**：全局扁平 map + 每凭据豁免 + 单跳 + 大小写不敏感。来源：kirostudio model_mapping.rs:16-53。
11. **EWMA 健康分**（选号 1 的支撑）：α 成功 0.3 / 429 0.5，惩罚独立时钟衰减（防饥饿自锁）。
    来源：kirostudio health.rs:28-30、424-457。

### P3（~180 行）

12. **工具配对修复**：孤儿 tool_result 过滤 + 悬空 tool_use 删除（上游严格配对否则 400）。
    来源：kiro-rs converter.rs:971-1078。
13. **令牌桶 AIMD 自动挡**（如需）：429 乘性砍半（3s 去抖窗口内不刷新 last_md——修 RPM 卡死死锁的双修复点）。
    来源：kirostudio throttle.rs:386-424。
14. **常量时间鉴权**：先 SHA-256 定长再 timingSafeEqual。来源：kirostudio common/auth.rs:43-47。
15. **IP 级 429 突发检测**：同模型 8s 内 3 号被限 → 判定上游 IP 冷却短路 429。来源：windsurf chat.js:4485-4514。

## 四、0 依赖路线（逆向 SDK 后自研，CURSOR_USE_SDK 双实现）

### 依据一：windsurf 0 依赖方法论（现成蓝本）

- package.json 无 dependencies，Dockerfile 从不 npm install；全仓只有 node: 内置模块 + 内部模块。
- 用到的 16 个内置模块：http/https、http2、net、tls、crypto、zlib、string_decoder、child_process、fs/path/url/os/dns/util/buffer。
- 手写替代的 npm 包（15 个）：@grpc/grpc-js、protobufjs、@connectrpc/connect、undici、https-proxy-agent、socks-proxy-agent、ipaddr.js、sharp、pdf-parse、write-file-atomic、dotenv、lru-cache、pino、bcrypt、generic-pool。
- 8 个关键陷阱：IPv6 Happy Eyeballs 假死（autoSelectFamily(false)）、zip bomb 双闸、多字节 UTF-8 跨 chunk（StringDecoder）、varint BigInt 兜底、gRPC Trailers-Only 双事件、只广告能解码的压缩、decodeURIComponent 在 end 里抛异常杀进程、Atomics.wait 做同步 sleep。

### 依据二：@cursor/sdk 协议面（已逆向，见会话记录）

- key 换 token：`POST api2.cursor.sh/auth/exchange_user_api_key`（Bearer crsr_key, body {}）→ `{accessToken}`
- REST 面：`api.cursor.com/v1/me`、`/v1/models`、`/v1/agents`、`/v1/agents/:id/runs`、`.../stream`（SSE，Last-Event-ID 续传）、`.../cancel` —— 纯 JSON + SSE
- ConnectRPC JSON 传输：`api2.cursor.sh/aiserver.v1.*/Method`（Content-Type: application/json，免 protobuf 二进制）
- 错误映射：401→认证、429→限流（可重试）、400/404/409→客户端错、5xx→可重试
- local agent（现用）执行在 cursorsandbox 子进程（二进制），cloud agent（bc- id）纯 REST —— 自研路线走 cloud 语义

### 自研实现结构（建议）

```
src/cursor-client.mjs    协议层：exchange + REST 调用 + SSE 客户端（~500 行）
src/cursor-errors.mjs    错误类型与映射（对齐 SDK 的 name/status/isRetryable，pool.classify 零改动）
src/agent-run.mjs        run 生命周期：createRun / stream 事件解析 / wait / cancel / resume
src/proto-json.mjs       ConnectRPC JSON 调用（若需 aiserver 方法）
开关：CURSOR_USE_SDK=true 走官方 SDK（现状代码），false 走自研层；接口形状完全对齐
```

双实现要点：
- 接口对齐是硬约束：engine/tools/pool 依赖的 `Agent.create/send/run.stream/Cursor.me/models.list` 形状 + 错误对象字段
- 自研层可顺带获得 windsurf 已验证的基建：HTTP/2 session 池（grpc.js:36-75）、代理 host 固定 IP（windsurf-api.js:72-73）、解析器永不向上抛
- 魔改 kiro 系为 Rust 参考实现 vs 自研 Node 层：Node 层与 cursorapi 同语言，优先；kiro 系的价值在算法（已提炼进本报告）而非代码搬运

### 风险与对策

| 风险 | 对策 |
|---|---|
| Cursor 私有协议无文档 | 探针实测（会话记录的方法）：替换 globalThis.fetch 抓 SDK 全部调用 + 真实 key 最小验证 |
| 上游协议漂移 | CURSOR_USE_SDK 保底开关 + 端点集中在 cursor-client.mjs 单文件 |
| resume/计费语义未知 | 实测验证（Step 0 决定性实验）后再定工具中继改造方案 |
| 流式兼容细节 | windsurf 的 SSE 三件套 + kiro-rs-tool 的 ToolJsonAccumulator 是现成答案 |

## 五、下一步行动

1. 先落 P0 三项（选号排序键、冷却分级、错误翻译表+RA 透传）——不依赖 0 依赖决策，纯增益
2. 决定性实验：真实 key 验证自研协议层（exchange→me/models→createRun→stream 一轮真实对话）
3. 实验通过 → 建 cursor-client.mjs 骨架 + CURSOR_USE_SDK 开关
4. 渐进替换：me/models（低风险）→ send/stream（核心）→ 工具中继（按实测结果）
5. 全程 7 测试全绿守门

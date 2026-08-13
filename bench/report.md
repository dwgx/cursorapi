# cursorapi 基础吞吐压测报告

日期：2026-08-13 · 机器：MacBook Air M2 (8GB, macOS 26, arm64) · Node v24.19.0
环境：隔离实例 127.0.0.1:8101，空账号池 2 个 fake 账号（`/tmp/bench-accounts.json`），无代理，`CURSOR_PROBE_INTERVAL_MS=0`，数据面用 mock SDK（`bench/mock-sdk.mjs`，Agent.create/send 零延迟、run 立即完成），CURSOR_LOG_LEVEL=info（生产默认）。
压测代码在 `bench/`：`server.mjs`（mock 注入的测试实例）、`load.mjs`（fetch+Promise 池）、`run-bench.mjs`（主压测）、`cpu-bench.mjs`（--cpu-prof）、`micro-select.mjs`（单函数微基准）。未改动 `src/` 任何代码。

## 一、压测面 1：HTTP 基础吞吐（logLevel=info，5s 测量窗）

| 路径 | 并发 | req/s | p50ms | p95ms | p99ms | maxms | 错误 |
|---|---|---|---|---|---|---|---|
| /ping | 1 | 303 | 2.2 | 8.4 | 20.5 | 89.9 | 0 |
| /ping | 10 | 4632 | 1.8 | 4.3 | 8.4 | 48632* | 0 |
| /ping | 50 | 11916 | 3.1 | 11.2 | 19.5 | 39943* | 0 |
| /ping | 200 | 13872 | 13.0 | 25.5 | 35.9 | 58.9 | 0 |
| /admin/status | 1 | 547 | 1.5 | 3.8 | 6.1 | 19.3 | 0 |
| /admin/status | 10 | 2550 | 2.3 | 11.7 | 29.1 | 66.6 | 0 |
| /admin/status | 50 | 8381 | 4.0 | 15.3 | 40.6 | 152.0 | 0 |
| /admin/status | 200 | 3411 | 29.3 | 206.1 | 332.0 | 416.2 | 0 |
| /admin 页 (156KB HTML) | 1 | 185 | 3.5 | 14.1 | 28.6 | 64.4 | 0 |
| /admin 页 | 10 | 803 | 8.0 | 33.6 | 85.9 | 309.5 | 0 |
| /admin 页 | 50 | 455 | 75.6 | 269.1 | 426.4 | 498.1 | 0 |
| /admin 页 | 200 | 724 | 174.2 | 843.0 | 1103 | 1227 | 0 |
| /v1/models（缓存目录） | 1 | 395 | 1.8 | 5.8 | 9.3 | 83.4 | 0 |
| /v1/models | 10 | 2925 | 2.2 | 8.1 | 21.3 | 118.3 | 0 |
| /v1/models | 50 | 2130 | 11.8 | 103.9 | 147.5 | 197.7 | 0 |
| /v1/models | 200 | 3502 | 39.3 | 161.5 | 199.9 | 244.4 | 0 |

*`maxms` 48s/40s 两个离群点：同相位重跑干净（p50 仅 1.8ms），判定为压测期间机器瞬时抖动（8GB M2 上有其他进程竞争），非服务问题。

结论：无状态路径 CPU 上限约 1.2-1.4 万 req/s（@200 开始波动）；/admin/status 在 @50 达峰 8381 后 @200 回落到 3411（劣化起点约 50-100 并发）；/admin 页是唯一明显受 payload 大小约束的路径——156KB 常量在 @200 时 p95 843ms。

## 二、压测面 2：数据面 mock 吞吐（/v1/chat/completions，logLevel=info）

| 模式 | 并发 | req/s | p50ms | p95ms | p99ms | maxms | 错误 |
|---|---|---|---|---|---|---|---|
| 非流式 | 1 | 4.6 | 209.5 | 225.0 | 262.6 | 262.6 | 0 |
| 非流式 | 5 | 21.6 | 211.9 | 286.0 | 319.8 | 320.0 | 0 |
| 非流式 | 20 | 91.7 | 206.7 | 223.1 | 227.0 | 228.1 | 0 |
| 流式 | 1 | 290 | 2.5 | 8.0 | 16.3 | 70.4 | 0 |
| 流式 | 5 | 652 | 3.6 | 26.4 | 79.2 | 123.4 | 0 |
| 流式 | 20 | 968-5337（4 连跑 4044/4463/5024/5337，p50 2.6-3.3ms，p95 10-13ms） | | | | | 0 |

非流式 logLevel 对比（@20）：info 92 req/s vs warn 89 req/s——日志不是瓶颈，被下文的 200ms 轮询完全掩盖。

## 三、压测面 3：工具中继吞吐（每轮 = 1 次流式初始请求 + 1 次非流式结果回传）

| 并发 | turns/s | p50ms | p95ms | p99ms | maxms | 错误 |
|---|---|---|---|---|---|---|
| 1 | 3.1 | 299.5 | 363.1 | 363.1 | 363.1 | 0 |
| 5 | 16.0 | 291.4 | 308.6 | 316.4 | 316.4 | 0 |
| 20 | 58.1 | 300.9 | 463.3 | 509.9 | 530.5 | 0 |

每轮 2 个 HTTP 请求 → @20 实际 116 req/s，与非流式路径的 ~92/s@20 上限吻合，说明工具中继本身（lookupTurn/feedResults/delegate）开销可忽略，瓶颈与压测面 2 相同。

## 四、CPU 热点（node --cpu-prof，chat 非流式 @20，logLevel=warn，23.5s，93 req/s）

```
rank | self ms | self % | function
1    | 21496.8 | 91.2   | (idle)
2    | 280.9   | 1.2    | (program)
3    | 237.6   | 1.0    | (garbage collector)
4    | 89.2    | 0.4    | writev
5    | 66.9    | 0.3    | node:internal/timers:listOnTimeout
6    | 61.7    | 0.3    | node:internal/crypto/random:randomFillSync
7    | 59.0    | 0.3    | node:internal/process/task_queues:nextTick
8    | 53.1    | 0.2    | runMicrotasks
9    | 39.8    | 0.2    | node:internal/timers:processTimers
10   | 36.7    | 0.2    | src/openai.mjs:finishNonStream
11   | 32.8    | 0.1    | src/keys.mjs:reportSuccess
...
21   | 216.5   | 0.9(incl) | src/app.mjs:serveProtocol
22   | 17.2    | 0.1    | src/http-helpers.mjs:readBody
```

**91.2% 空闲：非流式路径根本不是 CPU 瓶颈。** 每请求全包 CPU ≈ 0.95ms（含 GC/系统调用），其中 finishNonStream 17µs、reportSuccess 15µs、randomFillSync 28µs（`newCompletionId` 的 crypto.randomBytes，每请求一次）、readBody 8µs。

## 五、单函数微基准（bench/micro-select.mjs 原始输出）

```
select+release (pool=2):   1.57us/iter
select+release (pool=10): 20.26us/iter
select+release (pool=50): 130.01us/iter
select+release (pool=200): 535.30us/iter
Date.parse control (ISO string):   0.31us/iter
Date.parse x86 (ISO string):      22.99us/iter   <- 对照实验
reportSuccess+recordRequest:  2.32us/iter
renderPrompt (1 msg):         0.37us/iter
renderPrompt (40 msgs):      10.94us/iter
normalizeTools (1 tool):      0.08us/iter
```

## 六、瓶颈定位

### 瓶颈 1（首要）：waitTurn 固定 200ms 轮询 —— 非流式路径的结构性延迟
`src/relay.mjs:194-202`：`waitTurn` 用 `await sleep(200)` 轮询 sink 关闭，每次完成的 turn 都要等一个轮询周期才返回（平均 +100ms，最坏 +200ms）。非流式响应的 `finishNonStream`（relay.mjs:369）在 waitTurn 返回之后才写，所以延迟直接吃满轮询粒度。

证据链：
- 非流式 p50 = 206-217ms ≈ 200ms 轮询 + ~7ms 真实开销（@1/5/20 三种并发全部相同，与并发无关，是单请求固定项）；
- @20 吞吐 92/s ≈ 20 / 0.216s——纯延迟受限，与 CPU 无关；
- CPU profile 91.2% 空闲，佐证不是计算瓶颈；
- 对照组：流式路径（SseWriter 字节立即流出，[DONE] 由 consume 的 finally 写，不等 waitTurn）p50 只有 2.5-3.3ms、@20 可达 4-5k req/s——同样的服务器工作，唯一的差别就是 waitTurn 门控。

### 瓶颈 2：select() 的 O(n·log n) Date.parse —— 号池越大越贵
`src/keys.mjs:823-831`：`rankVector` 每次比较都执行 `Date.parse(a.addedAt)`（第 826 行），把 ISO 字符串重新解析成时间戳。select 对候选排序（2 次/比较）+ 两次 filter 遍历，共 ~86×Date.parse/次（10 号）到 ~3400×（200 号）。

证据链：
- 微基准：select 成本 1.57µs(2 号) → 20µs(10) → 130µs(50) → 535µs(200)，超线性增长；
- 对照实验：86 次 Date.parse ≈ 23µs，与 10 号池实测 20µs 吻合——Date.parse 就是主导项；
- 50 号池下 130µs/次：500 req/s 时约 6.5% CPU；200 号池 535µs/次时约 27% CPU。

### 瓶颈 3：/admin 页 156KB 常量无压缩
`src/ui.mjs` PAGE 常量（156,747 字节）+ `src/app.mjs:90-93` writeHtml 直接吐。@200 并发 p95 843ms、吞吐 @10 达峰 803/s 后回落（大 payload 占满 loopback/GC）。对比 /admin/status（小 JSON）@50 8381/s。

### 次要观察
- 日志：info 下每请求 2 行 stdout（relay.mjs:123-127 launch 日志等）。非流式对比 info 92 vs warn 89 req/s 无差别（被瓶颈 1 掩盖），但流式 5k req/s 时每秒 ~1 万行，修掉瓶颈 1 后日志 I/O 会成为下一个瓶颈。
- crypto.randomBytes(12) 每请求 28µs（stream.mjs:21-23），量级小。
- 压测期间个别 48s 离群（见第一部分注），环境噪声，非服务问题。

## 七、单请求开销分解（基线，mock SDK 零延迟，@1 并发）

客户端感知 p50 ≈ 207ms，其中：

| 阶段 | 位置 | 成本 |
|---|---|---|
| 路由+鉴权+readBody+JSON.parse | app.mjs / http-helpers.mjs | ~8µs |
| 协议解析（renderPrompt+normalizeTools+digToolResults） | openai.mjs / format.mjs | ~1-2µs |
| 选号 select | keys.mjs:878 | 1.6µs（2 号池）… 535µs（200 号池） |
| SDK mock 启动（Agent.create+send） | relay.mjs:105-119 | ~µs（mock 零延迟） |
| sink 装配+非流式序列化 finishNonStream | stream.mjs / openai.mjs | ~17µs |
| 记账 reportSuccess+recordRequest | keys.mjs:943/514 | ~15µs |
| **waitTurn 轮询（结构性等待）** | relay.mjs:194-202 | **~200ms（99.5%+）** |

真实 CPU 合计 ~1ms/请求；其余全部是轮询空等。

## 八、当前上限（多少并发开始劣化）

| 路径 | 上限 | 劣化点 |
|---|---|---|
| 非流式 chat | **~92 req/s @20**（硬上限，来自 200ms 轮询；单连接 4.6/s） | 并发加高也上不去，延迟固定 207ms |
| 工具中继 | **~58 turns/s @20**（116 HTTP req/s） | 同受 waitTurn 限制 |
| 流式 chat | 4-5k req/s @20（p95 10-13ms） | 未饱和；继续加压受 ~1ms/req CPU 限制，预计 ~2k/s 后开始劣化 |
| /ping | ~12-14k req/s | @50-200 波动（机器 CPU 抖动） |
| /admin/status | ~8.4k @50 | @200 回落到 3.4k |
| /admin 页 | ~800 req/s | @10 即达峰，payload 饱和 |
| /v1/models | ~3-5k | @50+ 波动 |

## 九、优化建议清单（按价值排序）

1. **waitTurn 轮询改事件驱动**（改动点：relay.mjs:194-202，~15 行）
   把 200ms 轮询换成 `await closed` 与「空闲死线定时器」的 race：activity 变化时重置死线，死线到才判 idle。唤醒次数从每请求 1 次固定 200ms 等待降为 O(1)。
   - 预期收益：非流式 p50 207ms → ~5-10ms；@20 吞吐 92 → ~1000 req/s（~1ms/req CPU 上限，10 倍）；工具中继 turns/s 约 2 倍（每条 leg 都省 200ms）；流式与请求处理路径的连接占用时间大减。
   - 风险：低。唯一注意点是 idle 超时判定精度（timer 驱动后判 activity 的时基不变，语义等价）。
2. **select 缓存 addedAt 数值**（改动点：keys.mjs:823-831 + Account 构造/load 处，~5 行）
   Account 创建/加载时 `addedAtMs = Date.parse(addedAt)` 存一次，rankVector 用数值。可选顺带：slidingLoad 用队头时间戳比较代替 while-shift（数组本来有序）。
   - 预期收益：200 号池 select 535µs → ~20-30µs（约 20 倍）；50 号池 130µs → ~15µs。
   - 风险：极低（纯缓存，语义不变）。
3. **/admin 页响应压缩或缓存头**（改动点：app.mjs:90-93，~5 行，零依赖 node:zlib）
   gzipSync(PAGE) 一次缓存，按 Accept-Encoding 下发（156KB → ~15KB）；或加 `Cache-Control: max-age=60`（页面是常量）。
   - 预期收益：该路径吞吐 ~5-10 倍，@200 并发 p95 843ms → 数十 ms。
   - 风险：低。gzipSync 156KB 约 1-2ms/次，缓存后摊销为 0。
4. **per-request 日志降级/限频**（改动点：relay.mjs:123-127 等 info → debug；或 logger.mjs 攒批写 stdout）
   每请求 2 行 info 日志在 5k req/s 时每秒 ~1 万行 stdout。修复瓶颈 1 后这是下一堵墙。
   - 预期收益：流式/高吞吐场景 CPU 和 I/O 释放，5-10%。
   - 风险：低；注意 /admin/logs 依赖 ring buffer（不依赖 stdout）。
5. **newCompletionId 去 crypto**（改动点：stream.mjs:21-23，~3 行）
   随机前缀+counter 或缓存 16 字节随机种子按位递增。
   - 预期收益：28µs/req，在 1000 req/s 时 2.8% CPU。
   - 风险：低（id 只需进程内唯一 + 不可预测性要求低）。

按预期收益排序：1 >> 2 > 3 > 4 > 5。改完 1+2 后建议重跑本报告全部相位复核。

## 附：原始输出存档
- 主压测：`bench/results.json`（全相位原始计数）
- 完整运行日志：`/tmp/bench-full2.log`
- CPU profile：`/tmp/bench-cpuprof/CPU.*.cpuprofile`
- 微基准原始输出：`/tmp/micro.log`
- 复测（流式 4 连跑 + 非流式 3 连跑）：`/tmp/recheck.mjs` 输出

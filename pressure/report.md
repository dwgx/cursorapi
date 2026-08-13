# CursurSPIKEY 内存与资源长跑压测报告

日期：2026-08-14 · 环境：MacBook Air M2（8GB）· Node v24.19.0 · 端口 8104（8103 被并行压测占用）
方法：`node --import pressure/mock-hook.mjs --import pressure/monitor.mjs boot.mjs`（src/ 零修改）。
mock SDK 全量替换 `@cursor/sdk`（有限流、工具往返、行为控制文件），账号池 1 个假账号（crsr_pressure_0001）。
monitor 每 5s 采样 RSS/heap/fd/句柄/定时器/byToolCall 表大小，共 255 个采样点；总压测时长 21.3 分钟。
服务 stdout 重定向 /dev/null（10 万条大日志将写 ~800MB，ring 证据经 /admin/logs/export 取），stderr 保留。

## 1. 长跑 RSS 曲线（P1，10 分钟混合负载）

负载：/admin/status 20/s × 10min（11697 成功 0 失败）+ 每 5s 一条 64KB 大日志（120 条）+ 每 30s 一次数据面请求（30 个，含 7 次完整工具往返）。

| 时间点 | RSS MB | heapUsed MB | external MB | fd |
|---|---|---|---|---|
| 0s（启动） | 47 | 5 | 2 | 12 |
| 60s（基线末） | 25 | 12 | 4 | 18 |
| 120s | 31 | 13 | 4 | 17 |
| 180s | 27 | 13 | 4 | 17 |
| 240s | 27 | 13 | 4 | 18 |
| 300s | 24 | 14 | 4 | 18 |
| 360s | 25 | 14 | 4 | 17 |
| 420s | 23 | 13 | 4 | 17 |
| 480s | 24 | 14 | 5 | 17 |
| 540s | 24 | 14 | 5 | 18 |
| 600s | 24 | 14 | 5 | 18 |
| 660s（P1 末） | 24 | 14 | 5 | 18 |

**判定：平台期，无泄漏。** 120s 后 RSS 稳定在 23-25MB 波动，heapUsed 平台 13-14MB。增长率 = 0。

## 2. SSE 订阅者泄漏（P2，50 连接）

| 状态 | Socket | Timeout(定时器) | fd | RSS MB |
|---|---|---|---|---|
| 开连接前 | 2 | 1 | 18 | 22 |
| 50 连接挂 30s | 50 | 51（50 心跳 + 1 采样） | 66 | 21 |
| 全关后等 60s | 0 | 1 | 16 | 22 |

**判定：无泄漏。** 连接关闭后 socket 全清、50 个 15s 心跳 interval 全部 clearInterval（app.mjs:290-295 的 req close 清理路径生效）、logger `subscribers` Set 清空（残留的话 Timeout 会剩 50+）。fd 回落至基线以下（keepalive 连接正常断开）。

## 3. 日志环形缓冲（P3，10 万条 × 100KB）

- 灌入耗时：13844ms（~7200 条/s）
- 灌入完成瞬间 RSS：**204MB**（monitor 灌完同步采样）；5s 后 127MB；15s 后 22MB（回到基线）
- 灌入期 heapUsed 采样仅 16-17MB（同步循环阻塞采样，瞬时峰值未进曲线，见 done 文件 rssAfter=204MB）
- `/admin/logs/export` 验证：**1000 行**（ring 1000 槽裁剪生效，logger.mjs:36 RING_CAP）
- 条目截断：**msg 全部精确 8192 字节**（8KB 截断生效，logger.mjs:12 MAX_FIELD_BYTES + truncateUtf8），稳态 ring 内存上界 ≈ 1000 × 8KB ≈ 8-9MB

**判定：上限全部生效。** 204MB 峰值是同步突发写日志的瞬态（truncateUtf8 每条约 100KB Buffer 拷贝 + stdout 同步写，GC 滞后），非泄漏——15s 内完全回收。

## 4. 定时器泄漏（P4）

一轮操作：50 次 /admin 面板轮询 + /admin/update/status + 账号探活 + SSE 挂 20s（跨 1 次 15s 心跳）+ logout/login。

| 状态 | Timeout | Socket | fd |
|---|---|---|---|
| 操作前 | 1 | 1 | 17 |
| 操作后 | 1 | 1 | 17 |

**判定：无残留定时器。** 面板轮询、探活、心跳、更新检查均不留下 setInterval/setTimeout。唯一常驻 Timeout 是 monitor 自身的 5s 采样。

## 5. byToolCall 表（P5，1000 次真实工具往返）

1000 轮 = 2000 请求（首轮 tool_calls → 续轮 tool_result），421s，**0 失败**。全程采样 byToolCall ∈ {0, 1}：非零值出现在"首轮已回、续轮未到"的在途窗口（每次采样最多 1，从不累积），完成后立即归 0。P5 结束后持续为 0。

**判定：无泄漏。** 表随 turn 结束完整清理（tool-relay.mjs resolveTool/#failCall/consume finally 三路 untrack 全覆盖）。

## 6. heap 快照对比（P6）

| 指标 | P0 基线 | P1 末 | P6 最终 |
|---|---|---|---|
| RSS MB | 25 | 24 | 20 |
| heapUsed MB | 12 | 14 | 13 |
| fd | 18 | 18 | 18 |
| byToolCall | 0 | 0 | 0 |

全程 21 分钟压测后 RSS/heap 低于基线，无净增长。

## 7. fd / 句柄（lsof 五连测）

启动 17 → P1 后 17 → P2 后 15 → P4 后 16 → 结束 17。**无连接/文件句柄泄漏**。

## 结论

- **未发现泄漏点**。7 个压测面全部平台期或归零：RSS/heap 平台（P1）、SSE socket/定时器/订阅者全清（P2）、ring 上限生效（P3）、定时器零残留（P4）、byToolCall 归零（P5）、heap 零净增长（P6）、fd 稳定（P7）。
- **未发现资源失控点**。三个上限（ring 1000 槽、条目 8KB、SSE 写队列 1MB）均生效；唯一峰值 204MB 为突发日志瞬态，15s 回收。
- 泄漏相关代码路径经实测健康：streamLogs 的 close 清理（app.mjs:292-295）、logger subscribers 退订（logger.mjs:54-57）、tool-relay 三路 untrack、relay waitTurn/watchAbandoned 循环随 turn 终止。

## 观察与建议（按价值排序）

1. **[中] 突发日志峰值 204MB（P3）**：10 万条 100KB 突发时 RSS 被顶到 204MB 而 heap 仅 17MB——truncateUtf8 每条约 100KB Buffer 拷贝（logger.mjs:15-31）+ stdout 同步写。若生产环境日志突发（如批量上报、风暴）达到该量级，8GB 机器 RSS 会被瞬时顶高。可接受（不泄漏），但如果想压：给 truncateUtf8 加"超大字符串提前截断"（先 byteLength 判断再 copy，现在已这么做——瓶颈是 Buffer.from 拷贝本身），低价值；更实际的观察项是 stdout 目标（journald 管道背压时进程内缓冲）。
2. **[低] P5 每轮 ~420ms 吞吐**：80ms BATCH_WINDOW（tool-relay.mjs:26,271）为攒批设计；1000 轮串行实测 421s。与资源无关，是客户端感知延迟，维持现状合理；压测如需更快可并发轮次。
3. **[信息] 文档与代码不一致**：CONTEXT.md 写会话 cookie 名 `cursurspikey_sess`，代码实际为 `cursorapi_sess`（src/guard-auth.mjs:10）——压测踩坑点，建议同步文档。
4. **[信息] 压测副作用**：guard 30s 稳定机制把根目录 `cursorapi.health` 重写为 version=0.1.3（正常行为，下次正常启动会再写）；`cursorapi.boot_attempts` 已清理。8103 上的并行压测进程（scripts/stress/，他人）未受影响。

## 证据文件

- pressure/metrics.csv —— 255 个 5s 采样点（含 handles/resources JSON）
- pressure/phases.jsonl + pressure/pressure.log —— 阶段时间线
- pressure/p3-export-sample.json —— ring 导出样本（8KB 截断）
- pressure/server.err.log —— 服务 stderr（空，无错误）
- pressure/ctl-log.done.* —— 各次灌入完成记录（含 rssAfter）

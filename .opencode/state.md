# CursurSPIKEY 会话状态（原 cursorapi，2026-08-13 全仓重构）

> 当前阶段：v0.1.1 发布中（CI 重跑）；OTA 闭环已本地验证通过（v0.1.0→v0.1.1）；UI 第一批完成。
> 品牌 CursurSPIKEY / CSPK_* 配置 / 8008 端口 / 全英文注释。
> 仓库：dwgx/cursorapi。换窗口先读 HANDOFF.md。

## 最新波次（2026-08-14 性能优化 + 语义修复，已改 src）

### 已完成（压测发现的 4 项修复，零新依赖，13 套测试全绿）
- **select addedAtMs 缓存**（keys.mjs:823-842）：rankVector 的 Date.parse 改缓存（懒 memo，字符串变则失效，测试直接改 addedAt 也正确）。微基准：select@200 号 535µs → 40.7µs（13x），@50 130µs → 10.5µs，@10 20.3µs → 1.45µs。
- **SSE cap 判定前移**（app.mjs:294-323）：writeFrame 收 thunk，先判 writableLength > 256KB（原 1MB）再构造帧字符串；丢帧计数行为不变。实测（20 SSE 连接 + 5000×1KB 风暴）：RSS 峰值增量旧代码 +124MB vs 新代码 +15.8MB（~8x）。新代码送达 242/1000（cap 生效）。
- **/admin 页面 gzip**（app.mjs:90-116）：writeHtml 按 Accept-Encoding 下发 gzipSync 缓存（143KB → 51KB，零依赖 node:zlib）；SSE 路径不压缩。
- **perform 错误码透传**（app.mjs:450 顶层 catch `err?.httpStatus ?? 500`）+ updater.mjs zip 失败补 502（downloadZipball 全镜像失败 / bytes<1024 / verifyAndExtract 全部分支）。锁冲突 409、tag gate 409/502 不再被压成 500。
- 新增测试：test-keys.mjs select 缓存回归（排序一致 + 突变失效）、test-updater.mjs 502 标注、test-ui.mjs gzip 头/409 透传/SSE 丢帧（test-fixtures/log-flood.mjs 预加载注入真实 emit 路径）。
- **未做**：per-request 日志降级（relay.mjs 被另一 agent 改 waitTurn，硬约束不碰）。

## 最新波次（2026-08-14 并发压力压测 P2，只测未改 src）

### 已完成（pressure2/ 套件，端口 8105 空池 + mock SDK + fetch 桩；报告 pressure2/report.md）
- **S1 SSE 50/100/200 + 3MB 日志风暴**：丢帧恒定 67%（1MB cap/3MB 写入 = 33% 保留，三次运行帧数 965/1007/1007 完全吻合 app.mjs:283 cap 判定）；RSS 峰值 249.8/117.1/491.5MB——**瓶颈：帧字符串先构造后判 cap**（app.mjs:291 模板串在 writeFrame 前求值 + logger.mjs:44 广播），200 连接瞬时 ~720MB 构造。
- **S2 账号操作 20/70 并发**：全部成功；写队列串行无 lost update（文件 JSON 合法、数量精确）；add 50 个 195ms（fsync 主导 keys.mjs:722）；probe 无锁 5-10ms。
- **S3 混合 50 流式+50 status ×60s**：1184+1192 req/s 零失败；15s 窗口吞吐降 27%/21% = 单线程事件循环饱和自然退化。
- **S4 慢客户端**：送达率 2%（419/20050），内存有界（峰值 239.3MB，稳态 ~6MB）；背压丢帧生效。
- **S5 连接风暴 84/s ×35s**：无泄漏，lsof 120→15 全回收，handles 无残留。
- **S6 热更新**：50+50+1 并发 fetch 数 1→1→2，ttlCache 生效（p50 66→16→132ms）。
- 坑：ctl-log done 文件残留会污染重跑（启动已加清理）；zsh `echo ===` 报错是 equals-expansion 误报，非服务器问题（err.log 0 字节）。
- 建议按价值排序见 report.md：①cap 判定前移（省 ~70% 瞬态内存）②cap 1MB→256KB ③慢客户端降级重连 ④批量导入引导 ⑤GC 抖动低优先。


## 最新波次（2026-08-14 OTA 热更新压力压测，只测未改 src）

### 已完成（pressure-ota/report.md + /tmp/ota-press/）
- **A 面全部通过**：8106 隔离实例 + 本地 bare origin git 副本（v0.1.3 树，commit-tree 叠上 main）：
  1. 并发 perform ×10 轮 + 跨进程文件锁：in-flight/.ota-lock 三层互斥全拦截（second 7-40ms 拒），10/10 零残留；
  2. fetch 失败 ×10（tags/下载/坏 zip 三类 stub）：502/抛错稳定，10/10 无 .ota-tmp/.ota-lock 残留，锁复位；
  3. 回滚压力：崩→崩→第 3 次 bump 触发回滚（留证 cursorapi.failed.* + src 恢复 sha 匹配 + 计数清零）→ 第 4 次稳定 ping 200；
  4. 检查风暴 20 并发：冷墙钟 4058ms 散布仅 35ms（共享 1 次 fetch）+ 模块层 ttlCache 计数=1；热缓存 12ms；
  5. 防降级 5/5 拒绝（updated:false），git tag gate 10 轮稳定触发。
- **发现的 2 个问题**（未改，见 report.md）：
  1. [高] perform 错误 httpStatus 被 app.mjs:422-425 顶层 catch 压成 500（锁冲突应 409、tag gate 应 409/502）——perform 路径不走 run() 包装；
  2. [中] zip 模式 downloadZipball/verifyAndExtract 失败抛裸 Error（httpStatus=null）→ HTTP 统一 500，与 fetchTags 502 不一致。
- **B 面真实链路：阻塞跳过**（用户指示）——两个真实 key 全部 401 失效（api.cursor.com/v1/me 直测 401，enable 后 502 Invalid API Key）。脚本 b-real.mjs 就绪，key 恢复 30 秒可跑。
- 环境注记：真实仓库 main 分支是 v0.1.1 旧代码（CSPK_*），v0.1.3 在 detached；8105 有上波次遗留压测实例（fetch-hook，CPU 58%），未动。

## 波次（2026-08-14 内存/资源长跑压测，只测未改 src）

### 已完成（pressure/ 套件 + pressure/report.md）
- 方法与 bench/ 互补：monitor.mjs（--import 注入，5s 采样 RSS/heap/fd/句柄/定时器/pendingToolCalls 到 metrics.csv，255 点）+ mock-hook.mjs（mock SDK 增强：有限流 + 工具往返 + ctl-mock.json 行为控制）+ run-pressure.mjs（7 相位，端口 8104，stdout→/dev/null）。
- **结论：无泄漏、无资源失控。** 21 分钟压测：P1 混合负载 RSS 平台 24MB；P2 SSE 50 连接关闭 60s 后 socket/timer/subscribers 全清；P3 10 万条 100KB 日志 ring 保持 1000 行、8KB 截断精确生效（瞬态峰值 204MB，15s 回收）；P4 操作后定时器零残留；P5 1000 次工具往返 0 失败、byToolCall 采样 ≤1 无累积；P6 heap 零净增长；lsof fd 稳定 15-18。
- 已知文档偏差：CONTEXT.md 写 cookie 名 cursurspikey_sess，代码实际 cursorapi_sess（guard-auth.mjs:10）。
- 注：cursorapi.health 被压测实例重写为 0.1.3（guard 正常行为）。
- 8103 有他人并行压测进程（scripts/stress/）在跑，未干扰。


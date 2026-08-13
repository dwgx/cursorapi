# OTA 热更新压力 + 真实链路基线 压测报告（2026-08-14）

> 只测未改 src/。隔离端口 8106；副本环境 `/tmp/ota-press/`（git-bare / git-repo / zip-repo / zip-repo-downgrade / rollback-repo，全部基于 v0.1.3 代码树 + 本地裸仓库 origin + fake 账号池）。脚本与原始数据在 `/tmp/ota-press/scripts/` 与 `/tmp/ota-press/results/`。

## 环境注记

- 真实仓库 main 分支（edc3fe8）是 v0.1.1 旧代码（CSPK_* 前缀）；v0.1.3 在 detached HEAD。git 副本用 commit-tree 把 v0.1.3 树叠上 main（C 提交），保证压测对象 = 当前工作区代码。
- git 副本 origin = 本地裸仓库，超前 1 个未打 tag 的 commit（B）→ perform 每次都会走到 tag gate 拒绝 + reset 回滚路径（可重复）。
- 本机有上波次遗留压测实例（8105，带 pressure/fetch-hook，CPU 58%）在跑，未干扰（端口不冲突），B 面延迟若测会对齐该负载。
- 环境：MacBook Air M2 / 8GB / Node 24.19.0；A 面每个 perform 的 fetchTags 打真实 GitHub API（镜像链 gh-proxy → 直连）。

## A 面：热更新 / OTA 压力

### A-1 并发 perform（git 模式）—— in-flight 锁拦截重入 ✓

方法：同进程 2 并发 POST /admin/update/perform × 10 轮；另起第二实例（同目录 8108）测跨进程文件锁。

| 轮 | first | second | 残留 (.ota-lock/.ota-tmp) |
|---|---|---|---|
| 1-10（全部一致） | 500，1.8-6.4s，tag gate 拒绝 + reset 回滚 | **500，7-40ms，"an OTA update is already running"** | 10/10 全无 |

- 跨进程：8106 实例拿锁（3.9s 跑完整流程），8108 实例 **16ms** 内被 `.ota-lock` 文件锁拦截（"another OTA update is in progress"）。
- 锁释放后零残留（10 轮 + 跨进程各 1 轮），`git status` 检查 + `.ota-lock` wx 独占 + finally 释放，工作正常。
- 副本 HEAD 每轮被 perform 的 `reset --hard` 还原到 C，测试可无限重复。

**发现（高优先）**：perform 的错误 httpStatus 全部被压成 **500**。源码：`app.mjs:225-235` 的 perform 路径不经过 `run()` 包装，`update.performUpdate()` 抛出的 `err.httpStatus`（409 锁冲突 / 409 tag gate / 502 无法校验）冒泡到 `app.mjs:422-425` 的顶层 catch，被写死的 `respondError(res, 500, ...)` 吞掉。**锁的功能语义正确，但客户端/监控无法区分「冲突/门禁拒绝」与「服务器错误」**。预期行为是第二个并发请求返回 409。

### A-2 失败重试 ×10（fetch stub，zip 模式）—— 错误稳定、无状态污染 ✓

方法：模块级 `performUpdate({fetchImpl: stub, projectRoot: zip-repo})`，三类失败交替 ×10：tags 全镜像失败、zipball 下载抛错、zipball 返回坏数据（解压失败）。

- 10/10 稳定抛错；**10/10 无任何残留**（`.ota-lock` / `.ota-tmp` / `.ota-pkg-old` / `cursorapi.bak` 全不存在）。
- tags 失败 → `httpStatus=502`（"cannot fetch a remote version (all mirrors failed)"）✓
- follow-up：健康 stub（旧 tag）→ `updated:false` 正常返回 —— 锁复位、无状态污染，后续 perform 不受影响。

**发现（中优先）**：`downloadZipball` 全镜像失败（`updater.mjs:202`）与 `verifyAndExtract` 解压失败抛的是**裸 Error（httpStatus=null）**，HTTP 层会统一变 500。与 fetchTags 失败的 502 不一致——zip 模式的错误语义分级缺失。

### A-3 回滚压力（启动即崩的新版本 ×4 启动）—— guard 3 次计数触发回滚 ✓

方法：rollback-repo（好版本 src → `cursorapi.bak`，新版本 src/app.mjs 顶层 throw），连续 `node boot.mjs` ×4（端口 8110）。

| 启动 | 结果 | boot_attempts | 证据 |
|---|---|---|---|
| 1 | 崩（exit 1） | 1 | `[boot] startup failed: intentional crash...` |
| 2 | 崩（exit 1） | 2 | 同上 |
| 3 | **回滚后存活（ping 200）** | 清零 | `[guard] crash loop detected (3 consecutive boot failures); rolled back from cursorapi.bak (bad version kept as cursorapi.failed.2026-08-13T16-42-30-127Z)` |
| 4 | 稳定（ping 200） | 1（重新计数） | src/app.mjs sha == 好版本 sha |

- 留证正确：`cursorapi.failed.2026-08-13T16-42-30-127Z/` 完整保留了坏版本 src（含坏 app.mjs，sha 匹配），回滚后 src 与 bak 内容 sha 一致。
- 第二轮重复（16-41-15Z 留证）行为完全一致 —— 回滚路径稳定可重复。

### A-4 检查风暴 20 并发 —— ttlCache 去重 ✓

方法：HTTP 20 并发 GET /admin/update/check（冷缓存 + 热缓存）+ 模块级 ttlCache stub 计数。

- 冷风暴：墙钟 4058ms，20 个全部 200、latest 一致（v0.1.3），**延迟散布仅 35ms（p50=4018ms，min=4016 / max=4049）** —— 20 个请求共享同一次上游 fetch 的强信号。
- 热风暴（60s TTL 内）：墙钟 12ms，单请求 9-11ms（纯内存缓存，零上游调用）。
- 模块层直接计数：**ttlCache 20 并发调用 → 上游 fn 执行 1 次**（dedup=true，返回值一致）。
- 结论：fetch 调用数 ≈1 成立（HTTP 层无法直接数真实 fetch 次数，用「延迟散布 <40ms + 模块层计数=1」组合证据）。

### A-5 版本门禁 —— 防降级稳定 ✓

- zip 模式 HTTP 层（本地 99.0.0 vs 远程 v0.1.3）5/5：200 + `updated:false` + "downgrade refused"，无副作用（无 .ota-tmp / src 未动）。
- 模块层 stub 旧 tag（v0.0.9）同样拒绝。
- git 模式 tag gate（新 HEAD 非最新 release tag 后代 → 拒绝 + reset --hard 回滚）在 A-1 的 10 轮中全部稳定触发（409 语义被 500 吞，见 A-1 发现）。

## B 面：真实链路基线 —— 阻塞，跳过

两个真实 key（/tmp/cursorapi-live/accounts.json）均已失效：

- 网关 probe：`401 Invalid API Key`（账号被自动禁用）。
- 直测上游：`GET https://api.cursor.com/v1/me`（经代理 10808，SDK 的 me 端点）→ **401**；代理链路本身正常（api2.cursor.sh 返回业务 404）。
- 重新 enable 后真实请求 → 网关 `502 Invalid API Key`（两个号都失败）。

用户指示「3 不行就 2」：B 面跳过。脚本 `/tmp/ota-press/scripts/b-real.mjs`（B-1 非流式×5 / B-2 流式×3 TTFB / B-3 工具往返×2 / B-4 串行 vs 并发×3）已就绪，key 恢复后 30 秒可跑。

## 优化建议

1. **[高] perform 错误状态码失真**：`app.mjs` serveUpdateRoutes 的 perform 路径包一层 `try/catch` 用 `err.httpStatus`（或顶层 catch 改为 `err?.httpStatus ?? 500`）。现在锁冲突（应 409）、tag gate 拒绝（应 409/502）全变 500；管理面板自动重试/监控告警无法区分「冲突」与「故障」。
2. **[中] zip 模式失败缺 httpStatus 标注**：`downloadZipball` 全镜像失败、`verifyAndExtract` 解压/校验失败抛裸 Error → HTTP 层统一 500；与 fetchTags 失败的 502 不一致，建议标 502。
3. **[保持] 锁与清理机制**：in-flight 标志 + `.ota-lock` wx 独占 + finally 释放 + boot guard 兜底清理，三层互斥在 10+2 轮并发/失败/跨进程下零残留 —— 这是对的，别动。
4. **[保持] 回滚证据链**：failed 留证 + 计数清零 + 第 4 次启动稳定，完整可审计。
5. **[观察] A-1 中 perform 依赖真实 GitHub API（镜像链），延迟 1.5-6.4s 波动**；check 冷启动 ~4s。网关侧无优化空间（上游网络），管理面板可提示「检查/更新可能较慢」。

## 数据文件

- `/tmp/ota-press/results/a1.json`（10 轮 + 跨进程）、`a2.json`、`a3.json`（2 轮）、`a4.json`、`a5.json`、`b-real.json`（B 面未跑）
- 各实例日志：`/tmp/ota-press/*/server*.log`

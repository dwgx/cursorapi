# CursorAPI 基础建设计划（2026-08-13）

> 基于三方对比（docs/COMPARISON.md）的落地计划。目标是给 CursorAPI 补齐「网关」该有的地基，
> 不做商业计费、不做多平台、不做分布式。

## 背景

CursorAPI 已具备：双协议出口（OpenAI/Anthropic，adapter 模式）、号池（priority+RR+冷却+自动禁用）、
工具中继、会话登录管理面、号池 CRUD、双协议错误体、7 个测试全绿。代码约 4.8k 行。

缺的（按用户价值排序）：粘性会话（prompt cache 成本）、原子选号（并发惊群）、Retry-After 透传（双协议一致）、
SSE 字节缓冲+心跳（流式健壮性）、运行时配置热调（运营体验）、健康分排序（选号质量）、熔断半开恢复（自愈）、
模型目录静态兜底+别名（可用性）、工具配对修复（400 来源）、用量维度聚合。

## Phase 0：改名收尾（本次会话已做或已列出）

- [x] package.json / package-lock.json name → cursorapi（2026-08-13 已改）
- [x] README 标题改 CursorAPI（2026-08-13 已改）
- [x] 删除孤儿 status.mjs、.env.bak-*
- [x] 环境变量 CURSOR_* → CURSOR_*（2026-08-13 完成：settings.mjs 全部键名 + .env.example + docker-compose + README + 测试；用户侧 .env 需自行迁移）
- [ ] README 全面重写（现状落后一个大版本，见 state.md 遗留项）
- [ ] docs/COMPARISON.md、docs/PLAN.md、HANDOFF.md 已落盘（本计划与对比）

## Phase 1：号池核心加固（建议优先，直接关系成本与稳定性）

### 1.1 粘性会话（sticky session）— 中复杂度
- **动机**：Cursor/Claude 上游 prompt cache 按账号隔离；换号 = 整段上下文重写，写入单价约为读取 10 倍。长对话用户反复换号 = 白白烧钱。
- **做法**（借鉴 windsurf-api sticky-session.js:193-395）：
  - `Map<callerKey+modelKey, {accountId, expiresAt}>`，TTL 30min，活跃续期，LRU 上限
  - 选号时：绑定命中 → 优先选该号（但尊重冷却/禁用/排除集）
  - 两个开关：`stickyNoFallback`（绑号失败拒绝轮转，适合强一致场景）/ 默认轮转
  - 状态持久化到 stats.json（跨重启保留）
- **验收**：同一 callerKey+model 连续请求选同一号；号冷却后解除绑定换号；测试覆盖 TTL 过期、绑号失效换号。

### 1.2 原子选号 + 排除集语义 — 低复杂度
- **动机**：当前 `pool.select` 的 `rr++` 无锁，并发下多个请求可能同时选中同一个号（Cursor 上游对同号并发有限制）；全排除时返回 null 会误报池空。
- **做法**（借鉴 kirostudio token_manager.rs:3220-3329）：
  - Node 单线程本身无竞争，但「选号」与「标记 in-flight」之间有空窗——把 `select` + `account.inflight++` 合并为一个同步临界区（Node 里就是同一 tick 内完成）
  - 排除集改为偏好而非硬门：全排除时退化为允许重选（而不是返回 null 502）
  - 可选：选号后记账 `inflight`，请求结束释放——让 `select` 能避开高并发号
- **验收**：并发测试（Promise.all 50 请求）不出现同号被选中超过并发上限；全排除返回可重选。

### 1.3 熔断半开恢复 + degraded serve — 中复杂度
- **动机**：现在冷却到点直接全量放回，刚缓过来的号可能又被一波打回冷却（kirostudio 明确指出这问题）；全池冷却时直接 429，服务不可用。
- **做法**（借鉴 windsurf-api runtime-config.js:113-138 + kirostudio cooldown.rs）：
  - 冷却到期后不直接回池：进 half-open 状态，只放行少量请求试探（如 1/10 概率），成功才恢复 full
  - 全池冷却时：选冷却最短的号 degraded serve（替代硬 429）
  - 冷却时长分级（现在只有 10min 一种）：429→30s~5min、401→禁用（不变）、会话鉴权→10min（不变）
- **验收**：模拟全池 429 时返回降级而非 429；half-open 成功恢复、失败重新冷却；测试覆盖。

### 1.4 账号健康分排序 — 中高复杂度（可选，排 1.3 后）
- 候选过滤后按：in-flight 最少 → 近期故障分 → RPM 剩余比 → LRU 排序（配额维度 Cursor 查不到，跳过）
- 替代现在的 priority+RR：priority 保留为硬档位，档内用健康分
- 需要记账扩展：失败时间窗、RPM 滑动窗口

## Phase 2：协议与流式健壮性

### 2.1 Retry-After 透传 — 低复杂度
- **做法**：pool.classify 或 engine 错误渲染时算退避秒数，挂 `Retry-After` 响应头；两个协议出口只透传不重写
- **验收**：429 响应带 Retry-After；OpenAI 和 Anthropic 出口行为一致（测试）

### 2.2 SSE 字节缓冲切帧 + 心跳 — 低-中复杂度
- **做法**：
  - 出站流：按 `\n\n`/`\r\n\r\n` 边界缓冲解码，避免中文/emoji 被 chunk 切断（现在直接字符串拼接有风险）
  - 入站（消费 Cursor SDK 流）：不做，SDK 已处理
  - 心跳：15s `: ping`（OpenAI）/ `event: ping`（Anthropic 透传），防反代/防火墙断连
- **验收**：中文长文本流式无乱码；挂 120s 无输出的流不被代理掐断

### 2.3 工具配对修复 — 中复杂度（可选）
- 转换层修复：孤儿 tool_result 丢弃、悬空 tool_use 丢弃、连续同角色合并（Anthropic 400 主要来源）
- 现在 convert.mjs 是纯函数层，加归一函数 + 测试即可

### 2.4 模型目录静态兜底 + 别名 — 低-中复杂度
- 内置静态目录（上次实测的 34 个模型快照）作为上游拉取失败兜底，/v1/models 不再 502
- 别名表：`opus-4.6` → `claude-opus-4.6` 这类（windsurf-api models.js:521-569 的模式，Cursor 生态真实兼容需求）
- 注意 models.mjs 现在的「全池通用一份目录」假设，混套餐号时失效——顺带处理

## Phase 3：运营体验

### 3.1 运行时配置热调 — 低-中复杂度
- runtime-config.json：null→env→默认三层；面板可改冷却时长/熔断参数/粘性开关；改不重启
- 与 settings.mjs 的关系：settings.mjs 保持启动时固定，runtime-config 提供覆盖层
- **注意**：加配置要同时更新 .env.example、docker-compose 传参、README

### 3.2 用量维度聚合 — 低复杂度
- stats.json 加：按模型/按账号聚合（现在只有总数）
- 面板展示：模型用量 Top、账号用量排行
- 不引入 SQLite（JSON 够用），但写入走「防抖 + 原子写」已有

### 3.3 CURSOR_* → CURSOR_* 改名 + README 重写 — 已完成（2026-08-13）
- 已完成：settings.mjs 全部键名、.env.example、docker-compose.yml、docker-compose.override.yml、README、测试；用户侧 .env 需自行迁移
- 与 README 重写合并做，避免两次大 diff
- **风险**：改名后旧 .env 失效，需要迁移提示（启动时检测旧键名并告警）

## 每项验收标准汇总

每个 Phase 项完成后：`npm test`（现有 7 个测试）必须全绿 + 新增对应测试 + 手动冒烟（本地起服务 curl 验证）。

## 依赖关系

```
Phase 1.1（粘性）→ 依赖 select 的排除集改造（1.2 先行或同批）
Phase 1.2（原子选号）→ 无依赖，最优先
Phase 1.3（熔断）→ 依赖冷却时长分级
Phase 2.1/2.2 → 无依赖，可并行
Phase 2.4 → 依赖 models.mjs 现有结构（不改）
Phase 3.1 → 独立
Phase 3.3 → 建议最后（牵动面大）
```

## 风险与注意

- 8GB 机器：Phase 1.4 健康分排序的滑动窗口内存可控（每号固定大小）；不做任何常驻大结构
- 粘性会话持久化注意：stats.json 已存 autoDisabled 等，加 sticky 表时保持向后兼容（loadStats 容错）
- 所有改动遵循「注释写实测证据、失败路径不静默、改动最小」的项目哲学（见 .claude/CONTEXT.md）

# CursorAPI 项目接收文档（HANDOFF）

> 最后更新：2026-08-14（v0.1.0 发布后）。**新会话第一件事：读本文件 + `.opencode/state.md` + `.claude/state/CURRENT.md`，然后读 README.md + docs/ARCHITECTURE.md 建立架构认知。**

## 一、项目一句话

**cursorapi** = 把一池 Cursor API key 变成 OpenAI/Anthropic 双协议标准接口的网关（Node.js 零框架 ESM，唯一依赖 @cursor/sdk ^1.0.27）。生产部署在 nbus VPS（38.244.34.15:8008），源码在本地 `~/Documents/WorkSpace/Project/cursorapi`，GitHub 仓库 `dwgx/cursorapi`（公开）。

## 二、架构（读 docs/ARCHITECTURE.md 深入）

```
客户端（Claude Code / OpenAI SDK / opencode）
  ↓ OpenAI /v1/chat/completions 或 Anthropic /v1/messages
app.mjs（HTTP 路由：数据面 /v1/* + 管理面 /admin/* + 入站限流）
  ↓ adapter（anthropic.mjs / openai.mjs —— 五件套契约：makeSink/handleMessages/digToolResults...）
relay.mjs（编排：选号→launch→waitTurn→settle；failover；记账；run 取消；consume 死线兜底）
  ↓
keys.mjs（号池：5 维选号/分级冷却/半开恢复/探活/持久化禁用/最近请求明细缓冲）
  ↓
tool-relay.mjs（RelayTurn 状态机：80ms 攒批/并行缓存补发/isError 通道/byToolCall 全局表）
  ↓
@cursor/sdk → Cursor 云端（api.cursor.com REST + api2.cursor.sh ConnectRPC）
```

关键模块与文件：
- `src/relay.mjs` 编排核心（**waitTurn 事件驱动**：closed race + 活动死线 timer，非流式 ~10k req/s；**consume 死线兜底**：上游流挂死时强制释放号池预留）
- `src/keys.mjs` 号池（usage 耗尽 → 持久化禁用；**recentRequests 环形缓冲 500 条**喂 /admin/requests；**select 热路径优化**：rank 预计算 + 滑动窗口 head 指针，200 号池 ~20µs）
- `src/tool-relay.mjs` 工具中继（parallel 缓存补发、schema 规范化、describeFromSchema 兜底）
- `src/app.mjs`（**入站限流**：CURSOR_RATE_LIMIT_PER_MIN 每-IP 60s 窗口，XFF 仅信任代理）
- `src/updater.mjs` OTA（git/zip 双模式；zip 走 release 源码包 + sha256 双信道；崩溃回滚 boot.mjs 守卫）
- `src/runtime-settings.mjs` 三层热配置（runtime-config.json → env → 默认；FIELDS 注册表；PUT /admin/config）
- `src/ui.mjs` 管理面板（windsurf/kirostudio 风格 7 视图；最近请求明细表、统计图例、复制按钮、冷却倒计时、账号搜索、ESC 退出登录、日志自动重连；**模板字符串嵌套：JS 块禁反引号与 `${}`；字符串内换行必须 `\\n`；测试沙箱无 classList/querySelector**）
- `src/proxy-tunnel.mjs` 上游代理（CURSOR_PROXY；CONNECT 隧道 + useHttp1ForAgent）
- `boot.mjs` 唯一服务入口（守卫最先跑；pkg 打包的 esbuild 入口）

## 三、当前状态（2026-08-14）

- **版本**：v0.1.0（洗刷后首个版本；CI 9 job 全绿；release 含 4 平台二进制 + 源码包 + sha256 双信道）
- **git 历史已洗刷**：远程/本地均为单 commit 重新初始化（`v0.1: initial commit` → 57b49c3 面板增强+并发加固 → 5831745 docs）；旧 24 commit 完整历史保留在本地 `backup-pre-wipe` 分支（不推远程）
- **本地**：main = 5831745；14 套测试全绿（309 项，含新增 test-rate-limit 15 项）
- **生产（nbus）**：38.244.34.15:8008，`/opt/cursorapi`（源码 + systemd cursorapi.service），**仍是 v0.1.4 代码**（洗刷后远程历史重写，git 模式 OTA 无法 ff-merge；部署 v0.1.0 需手动同步 + 重启，**等用户指令**），号池 2/2 可用（kirsthillerman61 ×2），CURSOR_MODEL_DEFAULTS 已配 `{"claude-fable-5":"[1m]"}`
- **kirostudio（nbus）**：/opt/kirostudio，8990 端口，凭据含 cursorapi custom_api 透传凭据（baseUrl `http://38.244.34.15:8008/v1`——**必须带 /v1**，否则探测模型 404）
- **skiapi（143.20.230.62）**：只读监督，**不碰**（用户其他服务在跑）
- **GHCR 镜像未清**：ghcr.io/dwgx/cursorapi（0.1.0/0.1/latest）是旧 v0.1.4 构建残留，v0.1.0 的 CI 已推新镜像覆盖同名 tag；如需彻底清空 gh token 需 packages scope（gh auth refresh 或网页删）

## 四、最近重大进展（按时间）

1. **git 洗刷**（2026-08-14）：远程 tags/releases 清空、历史重写为单 commit、版本定为 0.1.0；本地留 backup-pre-wipe
2. **v0.1.0 发布**（57b49c3）：管理面板增强（最近请求明细表 /admin/requests、统计图例、复制完整 Key、冷却倒计时、账号搜索、ESC 退出登录、日志自动重连、布局调整）+ 数据面并发加固（入站限流、inflight 死线兜底、select 热路径 -40%）
3. **性能优化**（洗刷前，已并入）：waitTurn 事件驱动（非流式 92→10023 req/s）、select addedAtMs 缓存、SSE cap 判定前移、/admin gzip
4. **usage 复活 bug 修复**（洗刷前）：usage 耗尽 → 持久化禁用；手动禁用清冷却/半开
5. **auth0 账号 → crsr_ key 换法跑通**：`POST api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey`（Bearer 只取 JWT 部分、expires_at 毫秒 int64）——用于多方式添加账号功能

## 五、待办

1. **生产部署 v0.1.0**（等用户指令）：VPS git 历史与远程不连续，需 `git fetch origin && git reset --hard origin/main`（先备份）后重启 cursorapi.service
2. **GHCR 清理**（等用户授权）：gh auth refresh -s read:packages,delete:packages 或网页删
3. **UI/后端**：添加账号批量导入页面（多行粘贴/格式校验/逐条探活/汇总）、多方式添加账号（crsr_ key / auth0 token 换 key / 邮箱+密码；端点 `POST /admin/accounts/import-auth0`）
4. **RPM 均衡**：per-credential rpm_limit / balanced 选号 / 饱和溢出——对齐 kirostudio token_manager.rs
5. **监督日常**：探活 nbus + 出入研究（/admin/stats + 日志）+ 性能基线（bench/ 可复跑）

## 六、红线（生产铁律）

- **生产不能死机**（用户大量任务在跑）：禁止直接改生产文件（备份+本地验证+用户确认）；禁止重启生产服务（除非用户明确指令）
- 不动 skiapi 上任何服务；不碰账号池/凭据/配置
- 涉及凭证：读 `~/.claude/SECRETS.md`，值绝不输出/落盘/提交
- 本地 8GB 内存：压测渐进，OOM 前停；执行类 subagent ≤5 并行

## 七、关键教训（避免重蹈）

1. **ui.mjs 转义地狱**：模板字符串嵌套——字符串内换行必须 `\\n`、curl 示例避免反斜杠续行、shell 单引号避免；改完必须「渲染后 script 提取 + node --check」验证
2. **detached HEAD 事故**（旧历史）：git 操作后确认分支；发版前 `git rev-parse HEAD origin/main` 一致
3. **XFF 信任模型**：限流身份若信客户端自填 XFF 就是可绕过的（每次换公网值拿新桶）——无信任代理（CURSOR_TRUSTED_PROXY）一律忽略 XFF 用 socket 地址；测试不能把绕过路径固化
4. **测试 env 污染**：CI runner 有 systemd（INVOCATION_ID）——测试 spawn 前清除 supervisor env
5. **对抗式 review 前置**：UI/并发改动上生产前跑两轮 reviewer（一轮找 MAJOR、二轮发版门禁），修完再发版
6. **Claude Code 上下文虚高**：上游 input 26.9k/轮（Cursor 系统提示）+ 会话恢复历史——不是网关问题，别误改网关

## 八、交接约定（给新会话的自我要求）

- 读本文件 → .opencode/state.md → .claude/state/CURRENT.md → README.md → docs/ARCHITECTURE.md → 按需读 docs/（ENV-SWITCHES/DEPLOY/RESEARCH/SECURITY-AUDIT/REVERSE-SDK）
- 任务流程：理解意图 → 本地改 → npm test 全绿 → 压测/验证 → 用户确认 → 生产变更
- 汇报：改了什么 / 关键验证 / 实质注意事项；不暴露内部推理

# CursorAPI 项目接收文档（HANDOFF）

> 最后更新：2026-08-14。**新会话第一件事：读本文件 + `.opencode/state.md`，然后读 README.md + docs/ARCHITECTURE.md 建立架构认知。**

## 一、项目一句话

**cursorapi** = 把一池 Cursor API key 变成 OpenAI/Anthropic 双协议标准接口的网关（Node.js 零框架 ESM，唯一依赖 @cursor/sdk ^1.0.27）。生产部署在 nbus VPS（38.244.34.15:8008），源码在本地 `~/Documents/WorkSpace/Project/cursorapi`，GitHub 仓库 `dwgx/cursorapi`（公开）。

## 二、架构（读 docs/ARCHITECTURE.md 深入）

```
客户端（Claude Code / OpenAI SDK / opencode）
  ↓ OpenAI /v1/chat/completions 或 Anthropic /v1/messages
app.mjs（HTTP 路由：数据面 /v1/* + 管理面 /admin/*）
  ↓ adapter（anthropic.mjs / openai.mjs —— 五件套契约：makeSink/handleMessages/digToolResults...）
relay.mjs（编排：选号→launch→waitTurn→settle；failover；记账；run 取消）
  ↓
keys.mjs（号池：5 维选号/4 档错误分类/分级冷却/半开恢复/探活/持久化禁用）
  ↓
tool-relay.mjs（RelayTurn 状态机：80ms 攒批/并行缓存补发/isError 通道/byToolCall 全局表）
  ↓
@cursor/sdk → Cursor 云端（api.cursor.com REST + api2.cursor.sh ConnectRPC）
```

关键模块与文件：
- `src/relay.mjs` 编排核心（**waitTurn 事件驱动**：closed race + 活动死线 timer，非流式 ~10k req/s）
- `src/keys.mjs` 号池（**usage 耗尽 → 持久化禁用**，2026-08-14 修复；手动禁用清冷却/半开）
- `src/tool-relay.mjs` 工具中继（parallel 缓存补发、schema 规范化、describeFromSchema 兜底）
- `src/updater.mjs` OTA（git/zip 双模式；zip 走 release 源码包 + **sha256 双信道**（哈希强制 github 直连）；崩溃回滚 boot.mjs 守卫）
- `src/runtime-settings.mjs` 三层热配置（runtime-config.json → env → 默认；FIELDS 注册表；PUT /admin/config；source 徽章 effective 数组）
- `src/ui.mjs` 管理面板（windsurfapi 风格 7 面板；**模板字符串嵌套：JS 块禁反引号与 `${}`；字符串内换行必须 `\\n`（模板里 `\\\\n`）；测试沙箱无 classList/querySelector**）
- `src/proxy-tunnel.mjs` 上游代理（CURSOR_PROXY；CONNECT 隧道 + useHttp1ForAgent）
- `boot.mjs` 唯一服务入口（守卫最先跑；pkg 打包的 esbuild 入口）

## 三、当前状态（2026-08-14）

- **版本**：v0.1.4（CI 全绿；release 含 4 平台二进制 + 源码包 + sha256 双信道）
- **本地**：main = 8197c6d 之后（quota 修复已提交）；13 套测试全绿（npm test，exit 0）
- **生产（nbus）**：38.244.34.15:8008，`/opt/cursorapi`（源码 + systemd cursorapi.service），号池 2/2 可用（kirsthillerman61 ×2），CURSOR_MODEL_DEFAULTS 已配 `{"claude-fable-5":"[1m]"}`（热更），OTA enabled（git 模式）
- **kirostudio（nbus）**：/opt/kirostudio，8990 端口，凭据 `/opt/kirostudio/config/credentials.json` 含 cursorapi custom_api 透传凭据（baseUrl `http://38.244.34.15:8008/v1`——**必须带 /v1**，否则探测模型 404）
- **skiapi（143.20.230.62）**：只读监督，**不碰**（用户其他服务在跑：fuckopencode/kiro2cc/skcc 容器）

## 四、最近重大进展（按时间）

1. **性能优化**（0e87259）：waitTurn 事件驱动（非流式 92→10023 req/s，109x）；select addedAtMs 缓存（13x）；SSE cap 前移（内存 8x）；/admin gzip；perform 错误码语义化
2. **OTA 完整性**（v0.1.4）：zip 模式改 release 源码包 + sha256 双信道 + tar 切换；source-package 发布链 job
3. **usage 复活 bug 修复**（8197c6d）：usage 耗尽 → 持久化禁用（原 30 分钟冷却导致坏号复活、客户端一直报 usage 错误）；手动禁用清冷却/半开（releaseCooled 无法复活）
4. **SSE 对齐 windsurfapi**：流内错误改 error 帧（已发内容合成 stop / 未发内容 error 帧）、Anthropic typed ping、15s 心跳、no-store、优雅停机（SIGTERM 写 error 帧）
5. **auth0 账号 → crsr_ key 换法跑通**：`POST api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey`（Bearer 只取 JWT 部分、expires_at 毫秒 int64）——用于多方式添加账号功能
6. **品牌**：CursurSPIKEY → cursorapi（配置键 CURSOR_*、端口 8008、cookie cursorapi_sess）

## 五、待办（第一波任务，用户确认过）

1. **UI：添加账号批量导入页面**（ui.mjs：多行粘贴、格式校验、逐条探活、汇总）
2. **UI：按 ESC 退出登录**（复用 askConfirm 模态）
3. **UI/后端：多方式添加账号**（crsr_ key / auth0 token 换 key / 邮箱+密码——动态验证；后端端点 `POST /admin/accounts/import-auth0`）
4. **监督日常**：探活 nbus + 出入研究（/admin/stats + 日志）+ 性能基线（bench/ 可复跑）
5. **后续待命（第一波完成后）**：RPM 均衡与优先级对齐 kirostudio（per-credential rpm_limit / balanced 选号 / 饱和溢出——参考 kirostudio token_manager.rs）

## 六、红线（生产铁律）

- **生产不能死机**（用户大量任务在跑）：禁止直接改生产文件（备份+本地验证+用户确认）；禁止重启生产服务（除非用户明确指令）
- 不动 skiapi 上任何服务；不碰账号池/凭据/配置
- 涉及凭证：读 `~/.claude/SECRETS.md`，值绝不输出/落盘/提交
- 本地 8GB 内存：压测渐进，OOM 前停；执行类 subagent ≤5 并行

## 七、关键教训（避免重蹈）

1. **ui.mjs 转义地狱**：模板字符串嵌套 4 层——字符串内换行必须 `\\n`（模板层 `\\\\n`）、curl 示例避免反斜杠续行、shell 单引号避免（用无引号 JSON）——改完必须「渲染后 script 提取 + node --check」验证
2. **detached HEAD 事故**：git 操作后确认分支（曾在 tag 状态提交导致 main 落后 3 个版本）——发版前 `git rev-parse HEAD origin/main` 一致
3. **测试 env 污染**：CI runner 有 systemd（INVOCATION_ID）——测试 spawn 前清除 supervisor env
4. **re.sub 在部分环境不替换**：文件修补用逐字符手写替换更可靠
5. **Claude Code 上下文虚高**：上游 input 26.9k/轮（Cursor 系统提示）+ 会话恢复历史——不是网关问题，别误改网关

## 八、交接约定（给新会话的自我要求）

- 读本文件 → .opencode/state.md → README.md → docs/ARCHITECTURE.md → 按需读 docs/（ENV-SWITCHES/DEPLOY/RESEARCH/SECURITY-AUDIT/REVERSE-SDK）
- 任务流程：理解意图 → 本地改 → npm test 全绿 → 压测/验证 → 用户确认 → 生产变更
- 汇报：改了什么 / 关键验证 / 实质注意事项；不暴露内部推理

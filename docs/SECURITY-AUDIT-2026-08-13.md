# CursorAPI 安全审计报告

- 审计日期：2026-08-13
- 审计对象：`/Users/dwgx/Documents/WorkSpace/Project/cursorapi`（v0.1.0，提交后状态）
- 审计方式：源码逐文件审计 + 临时实例动态验证（本地 127.0.0.1 随机端口，测试账号文件，未触碰生产数据/网络）；恶意 zip 用 stub fetch + 真实 unzip 验证
- 验证证据标注：【实测】= 有临时实例/脚本复现；【静态】= 代码路径确认；【已测】= 仓库自带测试覆盖

---

## 一、漏洞清单

### BLOCKER

无。未发现无需前置条件即可远程利用的代码执行/未认证数据窃取。最接近的两条（OTA 供应链、工具轮白嫖）列 MAJOR。

### MAJOR

#### M1. 工具轮永不回传 → 白嫖上游额度 + 账本无痕 + 长期占号（【静态】，数据面）

- 位置：`src/relay.mjs:138-144`（settle）、`src/relay.mjs:216-226`（handle）、`src/tool-relay.mjs:305-314`（consume finally）、`src/tool-relay.mjs:213-221`（结果超时）
- 描述：`settle()`（记账唯一入口）只在 `handle`（relay.mjs:226）和 `resumeTurn`（relay.mjs:254）被调用，且要求 `turn.finished`。客户端带 `tools` 发起请求 → 拿到文本 + `tool_calls`（HTTP 200，relay.mjs:218 waitTurn 在 sink 封口即返回）→ **永不回传结果**：10 分钟后 `#armTimer` 超时 reject（tool-relay.mjs:213-218）→ run 被终止 → `consume` 的 finally 只置 `finished=true`、清 pending、封 sink，**全程无人调 `settle`** → `reportSuccess/reportFailure/recordRequest` 全部不执行。
- 攻击路径：持有合法 client key（数据面调用方），反复发带 tools 的请求并在 tool_calls 边界断开。每次白嫖：模型输出 token（Cursor 上游照常计费）+ 账号 `inflight` 被占满 10 分钟；池不记失败、账本不记请求 → 无法发现、无法追责。小池子场景等于占号 DoS（选号按 inflight 排序，keys.mjs:619-627）。
- 修复建议：在 `consume` 的 finally 中对「未结算的 finished turn」补调一次 `settle`（需要把 model/startAt 带给 turn 或由 handle 的 finally 兜底）；或者 `#armTimer` 超时后由 turn 自身触发一次结算。同时给账号 `inflight` 设上限（见 M3）。

#### M2. zip 模式 OTA 对真实 GitHub zipball 必然生成 `src/src` 嵌套 → 升级后启动崩溃、守卫回滚，升级功能不可用（【实测】）

- 位置：`src/updater.mjs:423-429`（swapSrc）、`src/updater.mjs:391-396`（verifyAndExtract 校验 `pkgDir/src/app.mjs`）
- 描述：GitHub `repos/{repo}/zipball/{tag}` 的目录结构是 `{repo}-{tag}/src/app.mjs`（顶层目录 + 完整项目树）。`findPkgDir` 找到顶层目录后，`swapSrc` 把**整个顶层目录** rename 成 `src/`，结果是 `src/src/app.mjs`、`src/app.mjs` 缺失。`boot.mjs`（留在 projectRoot 的旧版）`import "./src/app.mjs"` → MODULE_NOT_FOUND → 崩溃 → 守卫计数 → 3 次后从 `cursorapi.bak` 回滚。
- 实测：构造真实 zipball 结构包 → `performUpdate` 返回 `updated:true`，但更新后 `src/app.mjs` 不存在、`src/src/app.mjs` 存在。**每次点击升级 = 服务崩溃重启循环（最多 3 次）+ 回滚，升级永远失败**。
- 攻击路径/影响：管理员点 `/admin/update/perform` → 可用性中断（分钟级）+ 升级路径完全不可用。附带安全含义：zip 模式的防护设计（版本校验/条目扫描）全部白做，因为载荷根本不会执行——「防御通过 bug」，修好结构后必须同时补 hash 校验（见 M5）。
- 修复建议：`swapSrc` 应把 `pkgDir` 的**内容**（或 `pkgDir/src`）搬进 `projectRoot/src`，而不是整目录 rename；补一条测试：用真实 zipball 形状的包跑通升级 + 重启冒烟。

#### M3. 慢速 body / 无超时连接 → 远程 DoS（【静态】；暴露部署场景）

- 位置：`src/app.mjs:383-386`（`requestTimeout=0`、`headersTimeout=0`、`timeout=0`）、`src/http-helpers.mjs:32-45`（readBody 只有 64MB 上限，无时间上限）、`src/app.mjs:42-62`（`/admin/login` 免鉴权且先 readBody）
- 描述：Node 默认 300s 的 requestTimeout 被显式关闭，readBody 无时间上限、全服务无并发连接上限。
- 攻击路径：**无需任何凭据**连 `/admin/login`（或 `/admin/logout`、`/ping` 之外的所有 POST），以极慢速率（如 1 byte/30s）发送 body → 连接无限期挂起，不占内存但占 fd；上万连接耗尽 fd → 服务拒绝新连接。`.env.example:56` 的 `CURSOR_HOST=0.0.0.0` 是示例默认，按示例部署即暴露。
- 修复建议：恢复合理的 `requestTimeout`（如 60s）或给 readBody 加 per-request 读超时；`/admin/login` 用更小的 limit（如 64KB）；评估 `server.maxConnections`。

#### M4. SSE 无背压 + 客户端断开不取消 run → 慢客户端内存增长 + 孤儿计费（【静态】）

- 位置：`src/stream.mjs:54`、`src/anthropic.mjs:145`、`src/app.mjs:250-255`（res.write 返回值全被忽略）；`src/relay.mjs:216`（`void turn.consume(run).finally(...)`，fire-and-forget，无 `req.on("close")` 取消）
- 描述：数据面流式响应全速从上游拉取并 `res.write`，不检查返回 false、不 pause 上游；客户端慢读/不读 → Node socket 写缓冲无界增长 → OOM。客户端断开后 run 继续跑完（或 idle 10min），上游照常计费、账号继续被占。
- 攻击路径：合法 client key + `stream:true` + 大输出 + 不读响应 → 内存耗尽；断开连接 → 上游额度持续消耗。
- 修复建议：`res.write` 返回 false 时暂停上游事件消费（drain 后再恢复）；`req.on("close")` 时调用 run 的取消接口并结束 turn。

#### M5. zip 下载无 sha256 校验，镜像链为供应链信任盲区（【静态】）

- 位置：`src/updater.mjs:102-109`（apiCandidates：4 个第三方 gh-proxy 镜像优先于直连）、`src/updater.mjs:156-183`（downloadZipball 无 hash 校验）、`src/updater.mjs:366-407`（verifyAndExtract 的「版本匹配」只是包内自述，镜像可随意伪造）
- 描述：无 token 时 zipball 优先走 4 个第三方镜像；下载后唯一的内容校验是「package.json 版本 == 请求的 tag」——这是包内自述字段，恶意镜像改一行 JSON 即可通过。无 GitHub 侧指纹（release 资产的 sha256 / tag commit SHA）比对。
- 攻击路径：镜像被攻陷/定向投毒（gh-proxy.org 一类公共服务不在控制内）→ 管理员点升级 → 任意代码以服务用户权限执行（当前被 M2 的结构 bug 挡住，修复 M2 后此漏洞成为实际入口；git 模式则信任 git 历史本身）。
- 修复建议：优先用直连 `api.github.com` 的 tag commit SHA（`repos/{repo}/git/refs/tags/{tag}` 或 release assets + sha256）做内容指纹，镜像只作字节搬运并交叉校验两个镜像返回一致；或直接取消镜像链。注意 `CURSOR_UPDATE_TOKEN` 已强制直连（updater.mjs:104，测试覆盖），该设计保留。

#### M6. 管理面批量操作 = 同步 IO × N，冻结事件循环数秒（【静态】）

- 位置：`src/keys.mjs:1012-1042`（batchOps 串行循环）、`src/keys.mjs:878-891`（removeAccount：readStore + writeStore 全量重写 + persistUsage）、`src/keys.mjs:928-944`（setDisabled → persistUsage）、`src/keys.mjs:203-217`（atomicDump 每次 fsyncSync）
- 描述：批量 delete 500 个 id = 500 次全量读文件 + 全量写文件 + 磁盘 fsync；批量 disable/enable 同。全部同步阻塞事件循环。
- 攻击路径：任何能拿到 admin 权限的人（adminKey 泄露者；`settings.mjs:112-117` 已警告 adminKey 未设时**复用 clientKeys**——此时持有 client key 的调用方即可触发）→ 一次批量请求冻结整个网关数秒，所有 `/v1/*` 流式请求与 `/ping` 心跳全部排队。
- 修复建议：批量操作合并为「读一次、内存改、写一次」；写盘异步化或延迟合并（现有 10s ledger 落盘机制可参考）；batch 上限从 500 降下来或分片。

#### M7. 非流式请求 idle 超时后 HTTP 响应永不写入 → 连接/内存永久泄漏（【静态】，CONTEXT.md:80 旧疑点属实）

- 位置：`src/relay.mjs:219-224`（waitTurn 超时分支 `out.fail(...)` + `return`，到达不了 228 行的 `finishNonStream`）、`src/relay.mjs:249-252`（resumeTurn 同病）
- 描述：非流式请求（CollectSink）触发 10 分钟 idle 超时后，错误只写进 sink（CollectSink 不持有 res），HTTP 响应永远不写、连接永远不关（叠加 M3 的 timeout=0）。每触发一次泄漏一个 fd，重复触发耗尽连接。
- 触发条件：非流式 + 上游 10min 无任何事件（上游挂起/长静默）。
- 修复建议：超时分支统一走 `finishNonStream` 或直接 `respondError`；给 CollectSink 持有 res 引用用于收尾。

### MINOR

#### m1. 代理凭据泄漏：CURSOR_PROXY 完整 URL 进日志 + GET /admin/config 不脱敏（【实测】）

- 位置：`src/proxy-tunnel.mjs:91`（`console.log("...goes through ${proxyUrl}")` 打完整 URL）、`src/runtime-settings.mjs:22`（STATIC_FIELDS 的 `proxy` 字段**未标记 secret**）
- 实测：`runtime-config.json` 写 `proxy: "http://user:secretpw@proxy.example.com:8080"` 后，`getConfigView()` 返回的 `config.proxy` 与 `overrides.proxy` 均为完整明文（adminKey/clientKeys 则正常掩码）。启动日志同样打印完整 URL。
- 影响：代理带 `user:pass@` 凭据时，凭据进入 stdout 日志（可能被日志采集系统收集）与 `/admin/config` 响应。查看 `/admin/config` 需要 admin 权限，但日志出口更宽。
- 修复建议：`proxy` 字段标 `secret: true`；proxy-tunnel.mjs:91 只打 host:port（proxyEndpoint 已有解析结果）；启动日志同理。

#### m2. 日志注入：客户端可控字符串原样拼进日志行（【静态】）

- 位置：`src/keys.mjs:796`/`903`（name 无长度/字符校验）、日志拼接点 `keys.mjs:651,719,733,833,889,962,967`、`src/openai.mjs:34`（`dropped.join(", ")` = 客户端 tools[].type）、`src/tool-relay.mjs:78,161,235,239`（客户端工具名）、`src/logger.mjs:56-57`（msg 原样写 stdout + 环形缓冲）
- 攻击路径：管理员（或 adminKey 泄露者）提交 name 含 `\n`/ANSI 控制字符的账号；或数据面调用方传 `tools:[{type:"x\n伪造条目\ny"}]` → 伪造日志行，污染 `/admin/logs` SSE 与 `/admin/logs/export` 导出文件。UI 渲染有 esc() 兜底，不构成 XSS，纯日志面。
- 修复建议：name 加长度上限（如 200）与控制字符过滤；日志行统一转义换行。

#### m3. 账本 models 键客户端可控，无限膨胀（内存 + 磁盘）（【静态】）

- 位置：`src/relay.mjs:163`（`flow.model = req.publicModel` 客户端原串）、`src/keys.mjs:370-383`（`ledger.models.set(model, ...)` 无去重/上限）、`src/keys.mjs:328-335`+`307-325`（每 10s 全量序列化落盘）
- 攻击路径：合法 key 用大量不同模型拼写（未知参数词被忽略仍解析成功，catalog.mjs:168+61）发请求 → `ledger.models` 无限键 → 内存增长 + `cursorapi-agg-stats.json` 无限膨胀。
- 修复建议：模型键归一化（去 `[参数]` 段）或设上限（如 500 键，超出淘汰最旧）。

#### m4. 错误消息信息泄漏：`tried N` 池规模 + 上游错误原文进客户端 502 响应（【静态】）

- 位置：`src/relay.mjs:101-107`（`tried N accounts, all failed; last error: ${errShape(lastErr).message}`）、`src/relay.mjs:196`（原样进响应体）
- 影响：触发可重试失败（5xx/400 类）时，客户端读到上游错误原文（最多 500 字符，可能含 request id 等内部信息）与池内可用号数量。429/401 被吞不泄漏。管理面（errShape 七字段）本就需要，客户端侧应裁剪。
- 修复建议：对客户端只返回通用文案，详细错误进日志。

#### m5. XSS 纵深缺失：无 CSP / X-Content-Type-Options；esc() 缺单引号 + onclick 裸拼接（【静态】）

- 位置：`src/app.mjs:84-87`（writeHtml 无安全头）、`src/ui.mjs:749-750`（esc 只转义 `& < > "`）、`src/ui.mjs:1037-1062,2350`（`a.id` 直接拼进单引号 JS 字符串 onclick，未过 esc）
- 说明：当前全部动态数据（账号名/email/模型名/日志/错误）进入 HTML 前均过 esc()（全量审计 + 实测恶意名渲染转义正确）；`a.id` 恒为 sha256 前 12 位 hex（keys.mjs:91-92），字符集内无引号/尖括号，**当前不可利用**。但这是三处脆弱模式：id 派生逻辑若混入用户输入、新增单引号 attribute、或向 `JSON.stringify(I/PROV)` 塞动态数据（ui.mjs:2407，`</script>` 不转义），XSS 立即成立。
- 修复建议：补 `'` → `&#39;`；onclick 处 `esc(a.id)`；`</` 转义或 `\u003c`；加 CSP（注意 ui.mjs:72 外部 Google Fonts @import 需放行）。

#### m6. X-Forwarded-Proto 直接信任 → Secure cookie 标记可被伪造（【静态】）

- 位置：`src/app.mjs:31-35`（cookieAttrs 只信 `x-forwarded-proto` 头）
- 影响：服务直连暴露（不经反代）时，攻击者发 `X-Forwarded-Proto: https` 只能让 cookie 加 Secure（无害方向）；反向是反代未传头时 HTTPS 部署下 cookie 无 Secure（明文传输可被嗅探）。标准做法是信任配置中的反代而非任意请求头，建议限定来源（如校验 `X-Forwarded-For` 或要求配置 CSPK 已知反代）。

#### m7. 本地：writeStore 临时文件非独占创建，可被 symlink 劫持写任意文件（【实测】）

- 位置：`src/keys.mjs:526-538`（`fs.writeFileSync(tmp, ...)` 默认 flag "w"，跟随已存在 symlink；tmp 名固定含 pid；chmod 0600 在写入之后，短暂 0644 窗口；异常不清理 tmp）。对照同文件 atomicDump（keys.mjs:206 `openSync(tmp,"wx",0o600)`）与 runtime-config（runtime-settings.mjs:73 `"wx"`）都防预创建，此处是全仓唯一例外。
- 实测：起真实实例 → 预置 `accounts.json.tmp-<pid>` symlink 指向 victim → `DELETE /admin/accounts/:id` → victim 被写入账号 JSON（服务进程权限）。
- 前提：本地攻击者能写数据目录且知道服务 pid（本机多进程场景）；同用户攻击者通常已有更高价值路径，故列 MINOR。
- 修复建议：改 `fs.openSync(tmp, "wx", 0o600)` 独占创建 + 失败清理（对齐 atomicDump）。

#### m8. `CURSOR_UPDATE_REPO` 未校验（【静态】）

- 位置：`src/updater.mjs:26-29`（repo() 原样拼进 URL 路径与镜像 URL）
- 说明：operator 环境变量，非攻击者可控；但 `https://{mirror}/https://api.github.com/repos/{repo}/tags` 拼接受控时可能指向意外 URL。列 MINOR 备忘：建议约束 `owner/name` 格式。

### 已确认安全（正面清单）

| 面 | 结论 | 依据 |
|---|---|---|
| 认证 | 口令比较 timingSafeEqual 定长（guard-auth.mjs:12-20）；永不发 WWW-Authenticate；client/admin 角色分离；`isAdminSecret` 空 adminKey 时复用 clientKeys 有启动告警 | 【已测】test-guard-auth |
| 会话 cookie | HttpOnly + SameSite=Strict + Path=/admin + 12h TTL + 32 字节随机 token；CSRF：SameSite=Strict 下跨站 POST 不带 cookie，管理面操作（含批量 DoS 触发）需真凭据 | 【已测】test-ui.mjs:112-140 |
| 登录防爆破 | 失败延迟惩罚（前 3 次不罚，封顶 5s）+ 刻意不锁定（防别人锁死管理员），方向正确 | 【已测】test-guard-auth |
| 导出掩码 | view()/exportAccounts/批量失败回执三处输出点全掩码，无明文 key 泄漏路径；export 无 password 字段；有测试守护 | 【已测】test-keys.mjs:179-184,441-449 |
| 文件权限 | accounts.json 0600 + 原子写（writeStore 除外见 m7）；stats/ledger open 即 0600；runtime-config 0600 | 【已测】test-keys.mjs:243-251 |
| XSS | 全部动态数据过 esc()，attribute 均为双引号包裹；实测恶意账号名渲染全部转义；location.search 无回显；loginPage 无动态数据 | 【实测】+ 全量拼接点审计 |
| SSE 帧注入 | 所有 SSE 行经 JSON.stringify，内容换行无法伪造事件帧 | 【静态】stream.mjs:54、anthropic.mjs:145 |
| usage 记账输入 | adapter.parse 不读客户端 usage 字段，只来自 SDK usage 事件，不可伪造 | 【静态】openai.mjs:53-64、anthropic.mjs:275-287 |
| OTA 校验 | tag 白名单严格（v?纯数字 1-4 段，大小写敏感）；防降级；恶意 zip（../ 条目、symlink、版本投毒）全部实测拒绝；条目数/大小/解压总量三档上限；token 只走直连 | 【实测】+【已测】test-updater |
| 守卫回滚 | boot_attempts 计数、30s health 确认、3 次崩溃回滚、evidence 保留，逻辑完备 | 【已测】test-updater |
| 上传/注入 | 管理面 JSON 全经 cast 校验（类型/范围/白名单键）；无命令拼接面（git/unzip 全走 execFile 参数数组）；账号 id 路由正则 `[a-f0-9]{6,}` 防路径穿越；stats 文件名固定 | 【静态】 |
| 敏感文件 | git 追踪面无 .env/accounts.json/data/runtime-config.json；.env 本地 0600；.gitignore 覆盖完整 | 【实测】git ls-files + stat |
| 批量上限 | addAccounts ≤200、batchOps ≤500、op 白名单、批量内重复键拦截 | 【静态】keys.mjs:843,1013-1016 |
| 路径穿越 | 无：id 不进文件名，目录固定 | 【静态】keys.mjs:199,221,233 |

### 备注（非漏洞，供参考）

- `GET /admin/config` 的 `accountsPath` 等重启生效字段无路径校验——但写入方是 admin（runtime-config.json 0600），在管理员权限边界内，未列漏洞。
- `POST /admin/reload` 遇文件缺失返回成功但池不变（keys.mjs:544-549），有误导性，非数据破坏。
- 登录成功响应无延迟 vs 失败有惩罚延迟 → 轻微时序 oracle，但攻击者需先猜到密码才能利用，无实际价值。
- `/v1/*` 无请求级限速：客户端洪泛依赖池规模自然限制，M3/M4 修好后仍建议评估。

## 二、测试证据汇总

| 验证 | 方法 | 结果 |
|---|---|---|
| zip 穿越条目拒绝 | python 构造 `x/../escape.txt` zip + stub fetch + 真实 unzip 路径 | 拒绝：`archive contains a suspicious path entry`；父目录无逃逸文件 |
| zip symlink 拒绝 | 构造 S_IFLNK 条目 | 拒绝：`archive contains a symlink entry` |
| zip 版本投毒拒绝 | package.json 自述 9.9.9 vs 请求 tag v1.2.3 | 拒绝：`does not match requested tag` |
| zipball 结构升级 | 真实 GitHub zipball 形状包 | **升级后 `src/app.mjs` 缺失，生成 `src/src/app.mjs` 嵌套（M2）** |
| config 脱敏 | runtime-config 写入带凭据 proxy | `config.proxy`/`overrides.proxy` 明文返回；adminKey/clientKeys 掩码正常（m1） |
| writeStore symlink | 真实实例 + 预置 `accounts.json.tmp-<pid>` symlink + DELETE 账号 | victim 被写入账号 JSON（m7） |
| 账号名 XSS | 真实实例 + 4 种恶意 name + vm 执行页面 JS + buildRows | 全部转义（`&lt;img...&gt;`），无原始 payload 元素（正面） |

## 三、修复优先级建议

1. M1（白嫖/记账）+ M7（挂起泄漏）——同一处 settle/收尾逻辑，一起改，补测试。
2. M2 + M5（zip OTA）——修结构 bug 的同时必须补 sha256/commit SHA 指纹，否则修好 M2 反而打开供应链入口。
3. M3/M4（连接超时 + 背压）——低成本高收益，恢复 requestTimeout + write 背压 + close 取消。
4. M6（同步 IO 批处理）——合并写盘。
5. m1/m2/m3/m7——一行到几行的低风险加固，顺手做。

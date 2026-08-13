# 环境开关全表（CURSOR_*）

本文件是全部配置项的单一事实来源，逐键对照 `src/settings.mjs`（env → 默认值）与 `src/runtime-settings.mjs`（注册表 + 热更新）整理，2026-08-13 核对。

## 配置解析顺序（三层）

```
runtime-config.json（热覆盖层） → env（CURSOR_*） → 默认值（settings.mjs）
```

- `runtime-config.json` 放在**账号池文件同目录**（`CURSOR_ACCOUNTS` 的目录），启动时加载，之后每次读配置也会重新同步磁盘。
- 手动改文件即可生效（下次读配置时同步）；面板 / `PUT /admin/config` 是正规途径，原子写盘（tmp + fsync + rename，显式 0600，崩溃不留半个 JSON）。
- **热更字段**：`PUT /admin/config` 提交后立即作用于运行态，无需重启。
- **重启字段**（`restartOnly`）：提交后持久化到文件，但运行态冻结在启动时的值，重启才生效。`GET /admin/config` 返回的 `restartOnly` 数组列出全部这类键。
- 未知键、非法值：写文件时整批校验失败返回 400；文件里已有的坏值会跳过，保持旧值运行，不带着病启动。
- 交叉校验：`cooldown429BaseMs <= cooldown429MaxMs`（429 阶梯步长必须装得进上限），违反则整个 PUT 拒绝。
- 校验规则（`cast`）：int 有 min/max 区间；bool 只收 true/false；list 收字符串数组或逗号分隔串；json 收对象；**所有标量拒绝嵌套对象**（防 `{"adminKey":{...}}` 把口令覆盖成 `[object Object]`）。

## 脱敏规则

`clientKeys` / `adminKey` 两个字段标了 `secret`：`GET /admin/config` 响应里一律掩码——长度 ≤ 8 全打 `*`，否则保留前 4 后 4 位（`abcd…wxyz`）。掩码同时作用于「当前生效值」和「磁盘 overrides」两个视图。

## 注册表内字段（runtime-config.json 可覆盖）

| 环境变量 | 配置键 | 默认值 | 生效 | 脱敏 | 说明 |
|---|---|---|---|---|---|
| `CURSOR_PORT` | `port` | `8008` | 重启 | — | 服务端口。int 1–65535 |
| `CURSOR_HOST` | `host` | `127.0.0.1`（Docker 镜像内 `0.0.0.0`） | 重启 | — | 监听地址。源码跑默认只听本机，对外暴露请显式改 `0.0.0.0` 并配好 key |
| `CURSOR_ACCOUNTS` | `accountsPath` | `/data/accounts.json` | 重启 | — | 账号池文件路径。`runtime-config.json`、`cursorapi-stats.json`、`cursorapi-agg-stats.json` 都落在它的同目录 |
| `CURSOR_MAX_ACCOUNT_ATTEMPTS` | `maxAccountAttempts` | `3` | 热更 | — | 一次客户端请求最多轮换几个号。int 1–100。超过 3 个全挂基本是集体故障，继续换只浪费时间 |
| `CURSOR_PROBE_INTERVAL_MS` | `probeIntervalMs` | `1800000` | 重启 | — | 探活周期（ms）。用 `Cursor.me()` 只读接口，不花钱不耗额度；`0` = 禁用周期探活（启动 2s 后仍会拉一次身份）。int ≥ 5000 |
| `CURSOR_COOLDOWN_429_BASE_MS` | `cooldown429BaseMs` | `5000` | 热更 | — | 429 冷却基值（ms），按连续 429 次数 x 阶梯（5s→10s→15s…），一次成功即清零。int 1000–300000，必须 ≤ max |
| `CURSOR_COOLDOWN_429_MAX_MS` | `cooldown429MaxMs` | `90000` | 热更 | — | 429 冷却上限（ms）。int 1000–3600000。设太长会在小池子上自我制造整池 503 |
| `CURSOR_COOLDOWN_5XX_MS` | `cooldown5xxMs` | `30000` | 热更 | — | 上游 5xx 固定短冷却（ms）。int 1000–3600000 |
| `CURSOR_COOLDOWN_AUTH_MS` | `cooldownAuthMs` | `600000` | 热更 | — | 会话级鉴权失败的长冷却（ms）。int 60000–86400000。秒级会让断网风暴把整池号全打一遍 |
| `CURSOR_CLIENT_KEYS` | `clientKeys` | 空 | 热更 | **是** | 调用方 key，逗号分隔多把。空 = 不鉴权——只允许 localhost 场景，这服务前端是一整池付费账号 |
| `CURSOR_ADMIN_KEY` | `adminKey` | 空 | 热更 | **是** | 管理口令。空 = 复用 client keys（客户端能看到账号池内部） |
| `CURSOR_PREFIX` | `prefix` | 空 | 热更 | — | 对外模型名前缀。空 = 直接用 Cursor 原始 id |
| `CURSOR_SHOW_TOOLS` | `showToolActivity` | `true` | 热更 | — | 把工具活动作为文本流出（自管模式可见） |
| `CURSOR_MODEL_DEFAULTS` | `modelDefaults` | `{}` | 热更 | — | 按模型的默认参数（JSON 对象）。客户端发裸模型名时自动补上，客户端显式写的永不覆盖。例：`{"claude-opus-5":"[1m]","claude-sonnet-5":"[1m]"}`——Cursor 300k 默认上下文在长会话（Claude Code）里不够用，这是客户端侧修复 |
| `CURSOR_TURN_IDLE_TIMEOUT_MS` | `turnIdleTimeoutMs` | `600000` | 热更 | — | 单轮无事件超时（ms）。计的是「没有事件流动」，不是总时长——长思考/长回答阶段本来就长时间无事件，总时长截断会杀掉明显活着的轮。int ≥ 1000 |
| `CURSOR_TOOL_RESULT_TIMEOUT_MS` | `toolResultTimeoutMs` | `600000` | 热更 | — | 等客户端回传工具结果的最长时间（ms）。客户端可能正等用户批准动作，要宽。int ≥ 1000 |
| `CURSOR_LOG_LEVEL` | `logLevel` | `info` | 热更 | — | debug / info / warn / error |
| `CURSOR_PROXY` | `proxy` | 空 | 重启 | — | 上游 HTTP 代理（如 `http://127.0.0.1:10808`）。国内部署必填：Cursor 按出口区域限制推理流，且 SDK 的 HTTP/2 传输忽略系统代理。设置后强制 HTTP/1.1 + CONNECT 隧道（白名单域名见 [ARCHITECTURE.md](ARCHITECTURE.md#8-上游代理隧道proxy-tunnelmjs)），REST 侧走 undici ProxyAgent；空 = 直连 |
| `CURSOR_WORKSPACE` | `workspace` | `/work` | 重启 | — | agent 工作目录。工具中继模式会关掉内置文件工具，但 SDK 仍要求一个工作区 |
| `CURSOR_RATE_LIMIT_PER_MIN` | —（静态 env） | `0` | 重启 | — | 数据面（`/v1/*`）每-IP 60s 固定窗口限流。`0` = 关（默认）；`>0` 每 IP 每分钟请求上限，超限回 429 + `Retry-After`。只挡数据面，管理面不受影响。故意不进热更：洪峰不能靠热配置关掉自己的守卫 |
| `CURSOR_TRUSTED_PROXY` | —（静态 env） | 空 | 重启 | — | 信任的反向代理 IP（逗号分隔）。**设了之后**才相信这些对端发来的 `X-Forwarded-For`（限流身份取最右公网段）；不设则一律忽略 XFF，用 socket 地址做限流身份——未信任的客户端可以在 XFF 里填任意公网 IP 每次换新桶，绝不能信。国内部署若前面有 Caddy/nginx 反代，把反代 IP 填这里 |

## 只存在于 env 的开关（不进 runtime-config.json）

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CURSOR_ALLOW_SUBAGENTS` | `false` | 放行「派子程序」类工具（`Task` / `subagent` / `*_agent` / `best-of-n`，前缀匹配，`taskStatus` 这类会误伤）。默认挡的原因：一轮派 5 个子程序 = 6 次计费，客户端看不出钱花在哪。`src/tool-relay.mjs` 启动时读一次，重启生效 |
| `CURSOR_OTA_ENABLED` | 空（关） | OTA 总开关。`1/true/yes/on` 才放行 `POST /admin/update/perform`，关着返回 403 |
| `CURSOR_UPDATE_REPO` | `dwgx/cursorapi` | OTA 拉取的 GitHub 仓库（`owner/repo`）。私有仓配 token |
| `CURSOR_UPDATE_TOKEN` | 空 | OTA 用 GitHub token（仅私有仓库需要）。**设置了之后强制直连 api.github.com，绝不经 gh-proxy 镜像**——镜像都是 HTTP 中间人，不能让它们见到凭证 |
| `CURSOR_OTA_SUPERVISOR` | 空 | 显式声明存在 supervisor（systemd / PM2 / Docker 会自动检测）。OTA 重启时检测到 supervisor 就 `exit(75)` 等它拉起新代码，否则自己 spawn 分离进程 |

## 附：docker-compose 注入的附加变量

`docker-compose.yml` 额外透传 `TZ`（默认 `Asia/Shanghai`，影响小时桶的时区划分）与 `CURSOR_ALLOW_SUBAGENTS`（默认 false）。Dockerfile 构建时注入 `CURSOR_BUILD_VERSION` / `CURSOR_BUILD_COMMIT`（release 流水线传 tag 和 commit sha，本地构建回退 `dev` / `unknown`）。

## 改配置的正确姿势

- **热更字段**：面板「设置」页或 `curl -X PUT /admin/config -d '{"prefix":"cspk-","logLevel":"debug"}'`，立即生效。
- **重启字段**：`PUT /admin/config` 会持久化并返回 `restartFields` 提示，重启服务生效；或直接改 `.env` 重启。
- **账号池文件**（`accountsPath`）：与上面无关，改完 `POST /admin/reload` 或点状态页「重载」，已有号保留运行期状态（计数、自动禁用），只更新名字/优先级/禁用标记。

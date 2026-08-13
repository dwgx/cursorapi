# 部署指南

CursorAPI 有三种部署形态，按场景选：

| 形态 | 适合 | 前提 |
|---|---|---|
| Docker（GHCR 镜像） | 服务器 / 常驻 | 任意容器运行时 |
| 单二进制 | 免 Node 环境、快速分发 | 从 GitHub Releases 下载对应平台包 |
| 源码运行 | 开发调试 / 需要改代码 | Node ≥ 22.13 |

三种形态跑的是同一套代码、同一套配置（`CURSOR_*`），行为无差异。唯一注意点：**OTA zip 模式需要系统 `unzip` 命令**（Docker 镜像已装；Windows 宿主不自带，见下文）。

## 0. 数据目录：必须持久化的三样东西

无论哪种形态，以下文件都落在**账号池文件（`CURSOR_ACCOUNTS`）的同目录**，务必持久化：

| 文件 | 内容 | 丢了会怎样 |
|---|---|---|
| `accounts.json` | 账号池（明文 key，chmod 600） | 池子空了，全部请求 503 |
| `runtime-config.json` | 热配置覆盖层（可能含 client/admin key，0600） | 回到 env/默认值 |
| `cursorapi-stats.json` | 每账号 run 数 / token / 失败数 | 用量账清零（内存态重启即失） |
| `cursorapi-agg-stats.json` | 聚合统计（总量/模型/账号/小时桶 30 天） | 统计面板清零 |

写盘全部是「临时文件 + fsync + rename」原子操作，进程崩溃不会留下半个 JSON。

## 1. Docker（推荐）

### 1.1 从 GHCR 拉镜像

```bash
docker run -d --name cursorapi \
  -p 8008:8008 \
  -e CURSOR_CLIENT_KEYS=sk-给客户端用的key \
  -e CURSOR_ADMIN_KEY=管理口令 \
  -e CURSOR_PROXY=http://127.0.0.1:10808 \
  -v $(pwd)/data:/data \
  -v $(pwd)/work:/work \
  ghcr.io/dwgx/cursorapi:latest
```

- 镜像：`ghcr.io/dwgx/cursorapi`，多架构 `linux/amd64` + `linux/arm64`，tag 语义化（`0.1.0`、`0.1`、`latest`——预发布 tag 不推 latest）。
- 基础镜像 `node:22-slim`（SDK 要求 ≥ 22.13），以 **uid/gid 10003 非 root** 运行——宿主挂载的 `data/` 目录要让它可写（`chown 10003:10003` 或 `chmod 777`）。
- 自带 `HEALTHCHECK`：每 30s 打 `/ping`（该端点不需要鉴权，就是给健康检查用的）。
- 容器内默认 `CURSOR_HOST=0.0.0.0`、`CURSOR_ACCOUNTS=/data/accounts.json`、`CURSOR_WORKSPACE=/work`。

### 1.2 用仓库自带 compose

```bash
cp .env.example .env              # 填 CURSOR_CLIENT_KEYS / CURSOR_ADMIN_KEY
mkdir -p data work
cp accounts.example.json data/accounts.json
chmod 600 .env data/accounts.json
docker compose up -d --build      # 本地构建；想用 GHCR 镜像改 image 字段即可
docker compose logs -f
```

compose 默认把端口绑在 **127.0.0.1:8008**（只对本机）——背后是一整池付费账号，建议保持这样，对外走反向代理 + HTTPS。挂载 `./data:/data` 与 `./work:/work`，日志 json-file 轮转（单文件 20m，保留 5 个）。

**升级**：`docker compose pull && docker compose up -d`（镜像形态不需要 OTA；OTA 是给非容器部署用的）。

## 2. 单二进制

从 [GitHub Releases](https://github.com/dwgx/cursorapi/releases/latest) 下载：

| 文件 | 平台 |
|---|---|
| `cursorapi-linux-x64` | Linux x64 |
| `cursorapi-macos-arm64` | macOS Apple Silicon |
| `cursorapi-macos-x64` | macOS Intel |
| `cursorapi-win-x64.exe` | Windows x64 |

每个文件旁边有同名 `.sha256` 校验和。运行：

```bash
chmod +x cursorapi-linux-x64
CURSOR_ACCOUNTS=/etc/cursorapi/accounts.json \
CURSOR_CLIENT_KEYS=sk-xxx \
CURSOR_ADMIN_KEY=xxx \
CURSOR_PROXY=http://127.0.0.1:10808 \
./cursorapi-linux-x64
```

- 二进制是 esbuild 打包 + pkg 封装的完整 Node 22 运行时，**目标机器不需要装 Node**；`@cursor/sdk` 的平台原生模块（sandbox 助手、rg、tree-sitter）已打进包。
- Windows 宿主若要用 **OTA zip 模式**，需自行安装 `unzip`（Git 自带 `C:\Program Files\Git\usr\bin\unzip.exe` 可用，或装一个）。没有就提示用 git 模式或手更。
- 二进制更新：下载新版本替换即可（OTA 对二进制同样可用——`detectMode` 识别到 `package.json` + `src/` 就按 zip 模式走，但二进制形态更新后代码不会进二进制，意义有限；**二进制形态建议直接换文件**）。

## 3. 源码运行

```bash
git clone https://github.com/dwgx/cursorapi.git
cd cursorapi
npm install
cp .env.example .env && cp accounts.example.json data/accounts.json
node boot.mjs
```

- 入口是 `boot.mjs` 而不是 `src/app.mjs`：OTA 崩溃循环守卫（`src/guard.mjs`）在业务代码之前先跑，直接 `node src/app.mjs` 会跳过守卫（那是测试专用路径）。
- 建议用 supervisor 托管（systemd / PM2 / Docker）。OTA 重启时检测到 supervisor 会 `exit(75)` 等它拉起新代码；没有 supervisor 就自己 spawn 一个分离进程。

systemd 示例：

```ini
[Unit]
Description=CursorAPI
After=network.target

[Service]
WorkingDirectory=/opt/cursorapi
ExecStart=/usr/bin/node boot.mjs
EnvironmentFile=/opt/cursorapi/.env
Restart=always
User=cursorapi

[Install]
WantedBy=multi-user.target
```

## 4. OTA 更新（非容器部署）

面板「更新」页，或管理 API：

```
GET  /admin/update/check      检查更新 → { mode, current, latest, behind, hasUpdate }
POST /admin/update/perform    执行更新（CURSOR_OTA_ENABLED=true 才放行，否则 403）
GET  /admin/update/status     健康标记 / 回滚点状态
```

### 4.1 开关

```bash
CURSOR_OTA_ENABLED=true          # 总开关，默认关
CURSOR_UPDATE_REPO=dwgx/cursorapi  # 私有仓改这里 + 配 token
CURSOR_UPDATE_TOKEN=ghp_xxx      # 私有仓专用；设置后强制直连，不经镜像
```

### 4.2 两种模式（自动检测）

| 模式 | 检测条件 | 做法 | 备注 |
|---|---|---|---|
| **git** | 项目根有 `.git/` | `git fetch` → 计算落后提交数 → `git merge --ff-only` → 重启 | 要求工作区干净（有未提交改动会 409 拒绝）；推荐源码部署用它 |
| **zip** | 有 `package.json` + `src/app.mjs`、无 `.git` | 下载 zipball → 解压校验 → 原子换掉 `src/`（旧版存为 `cursorapi.bak`）→ 重启 | 需要系统 `unzip`；下载走 gh-proxy 镜像链（4 个镜像 + 直连兜底） |

### 4.3 zip 模式的安全校验（下载经过了第三方镜像，所以全查）

- 版本 tag 白名单：只认 `v?X.Y.Z`（1–4 段纯数字），防路径注入和 git ref 注入；
- zip 体量上限 64MB、条目上限 5000、解压总量上限 512MB（防 zip-bomb）；
- 逐条扫描条目路径（拒绝 `..` 穿越、绝对路径）、全树拒绝 symlink（防把 `src/app.mjs` 换成指向攻击者路径的符号链接）；
- 校验解出的 `package.json` version 必须等于请求的 tag（防镜像投毒）；
- 必须有 `src/app.mjs`，否则拒绝替换。

### 4.4 崩溃自动回滚守卫（boot.mjs 最前面跑）

```
启动 → 写 boot 计数（cursorapi.boot_attempts +1）
     → 若存在 cursorapi.bak 且计数 ≥ 3 → 自动回滚：
         当前 src/ 改名 cursorapi.failed.<时间戳>（保留坏版本证据）
         cursorapi.bak 改回 src/ → 清计数 → 正常启动
     → 监听成功（listen 回调）→ 清计数
     → 稳定运行 30s → 写健康标记 cursorapi.health + 删除回滚点（确认新版没问题）
```

- 连续 3 次启动崩溃自动回到上一个版本，坏版本不删（证据保留在 `cursorapi.failed.*`）。
- `GET /admin/update/status` 报告：`healthConfirmed` / `rollbackPointPresent` / `rolledBackBinaryPresent`。
- 注意：**listen 失败（如端口被占）也计入崩溃计数**——这是启动期崩溃，守卫必须数它。

### 4.5 重启方式

更新完成后：有 supervisor（systemd / PM2 / Docker / `CURSOR_OTA_SUPERVISOR`）→ 优雅排空在飞请求（10s 上限）后 `exit(75)`，supervisor 自动拉起；无 supervisor → spawn 分离子进程后自身退出。

## 5. 端口 / 防火墙 / 代理

### 5.1 端口

默认 `8008`（`CURSOR_PORT`）。暴露到公网前想清楚：这服务前面是一整池付费账号的额度。

```bash
# Ubuntu
ufw allow 8008/tcp

# CentOS
firewall-cmd --add-port=8008/tcp --permanent && firewall-cmd --reload
```

云服务器记得去安全组放行 8008（或只放行反向代理的 443）。

### 5.2 建议的对外形态

```
客户端 → HTTPS 443（Caddy/nginx 反代） → 127.0.0.1:8008（CursorAPI）
```

compose 默认就是这么绑的（`127.0.0.1:8008:8008`）。反代要把流式透传关掉缓冲，否则 SSE 变成「转半天圈然后一次性全出来」：

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 300s;   # 长 thinking 阶段长时间无事件，别提前断
```

`/v1/*` 的 SSE 响应自带 `X-Accel-Buffering: no`，nginx 会认。

### 5.3 上游代理（国内部署必读）

Cursor 按出口区域限制推理流，且 `@cursor/sdk` 的 HTTP/2 传输**忽略系统代理**——所以必须显式配：

```bash
CURSOR_PROXY=http://127.0.0.1:10808
```

设置后网关做三件事（见 [ARCHITECTURE.md](ARCHITECTURE.md#上游代理隧道)）：

1. HTTPS 全局 agent 换成自定义 CONNECT 隧道 agent，只对 Cursor 的域名白名单（`api.cursor.com`、`api2.cursor.sh`、`api5.cursor.sh`、`agentn.*.api5.cursor.sh`）开隧道；
2. 强制 SDK 走 HTTP/1.1（HTTP/2 over 代理容易出问题）；
3. REST 侧走 undici `ProxyAgent`。

注意：`CURSOR_PROXY` 是**重启生效**字段（在注册表的 STATIC_FIELDS 里）。设了之后 `PUT /admin/config` 改它不会立即生效，要重启。代理地址改错会全体 502——检查代理本身先通（`curl -x http://127.0.0.1:10808 https://api2.cursor.sh`）。

### 5.4 安全基线

- `CURSOR_CLIENT_KEYS` 用长随机串（≥ 32 字符），逗号分隔多把；**监听非 localhost 而 key 为空会在启动时打警告**——等于把整池账号的额度敞开给全世界。
- `CURSOR_ADMIN_KEY` 单独设一个，别复用 client keys（否则客户端能看到账号池有多少号、各是谁的）。
- `data/accounts.json`、`runtime-config.json` 明文含 key，0600；容器以 uid 10003 跑，宿主挂载目录的属主要对齐。
- 反向代理层加 HTTPS + 基本限流（`/admin/login` 有延迟惩罚，但别指望它挡分布式爆破）。

## 6. 发布流水线（维护者视角）

tag push `v*` 触发 [release.yml](../.github/workflows/release.yml)：

```
test（npm test + esbuild bundle 门禁 + 版本门禁）
  ├─ docker（GHCR 多架构推镜像，tag 语义化）
  ├─ binary-macos-arm64 / linux-x64 / win-x64（各平台自己 npm install + pkg 打包 + 冒烟测试）
  ├─ binary-macos-x64（continue-on-error：runner 贵且慢，赶不上发布照发）
  └─ release（下载产物 → 生成 sha256 → GitHub Release，正文取 docs/releases/RELEASE_NOTES_<tag>.md）
```

**版本门禁**：tag 必须等于 `package.json` 的 `version`，不一致拒绝发布——OTA 的 `hasUpdate` 判定是「远端最大 tag > 本地 version」，tag 忘了同步 package.json 会造成无限升级循环。

二进制必须矩阵构建的原因：`@cursor/sdk` 的本地 agent 依赖平台原生二进制（`sdk-<os>-<arch>` 包），npm 按 optionalDependencies 只装当前平台的，一个 runner 交叉打不出三平台。

# cursorapi 会话状态（2026-08-14 洗刷后重新开始）

> 当前阶段：**v0.1.0 已发布**（CI 全绿，release 完整）→ 待办：生产部署决策 + GHCR 清理
> 仓库：dwgx/cursorapi（公开）。main = 57b49c3（v0.1.0），tag v0.1.0 已推，CI 9 job 全绿。
> 备份分支 **backup-pre-wipe**（旧完整历史 24 commit，v0.1.4，不推远程）。
> 版本：package.json = 0.1.0，release 含 4 平台二进制 + 源码包 + sha256 双信道。
> 遗留：GHCR 镜像（ghcr.io/dwgx/cursorapi 0.1.0/0.1/latest）未清——gh token 缺 packages scope，需用户授权或网页删除。

## v0.1.0 发布内容（57b49c3）

### 管理面板
- 最近请求明细表（/admin/requests 环形缓冲 500 条，keys.mjs pushRecentRequest/listRecentRequests；app.mjs GET /admin/requests?limit=N；relay.mjs settle 挂钩）
- 统计图：图例（区间合计）、Y 轴 0 起 nice 刻度、X 轴智能标注、tooltip 成功率（ui.mjs drawLine/updateLegend）
- 复制：账号管理复制完整 Key（复用 /admin/accounts/:id/secret，HEAD 已有）、conn 页 5 处复制（clipboard try/catch + fallback）
- 便捷：冷却倒计时（coolTick 全局 1s interval + 视图守卫）、账号搜索（af-q 200ms 防抖）、ESC 退出登录（onKeyDown，输入框不触发）、日志 SSE 断线自动重连（scheduleLogRetry 2s→30s，nostream/manual 不重试）
- 布局：注销→退出登录、主题切换挪 header、footer 设置按钮；请求表独立 10s 刷新 ticker（reqTicker）
- M1 修复：maybeRefreshRequests reqBusy/reqFailAt 守卫；M2：updateLegend 并入 drawCharts；catch 只清自己 controller

### 数据面并发
- B1 入站限流：CURSOR_RATE_LIMIT_PER_MIN（0=关）+ CURSOR_TRUSTED_PROXY（无信任代理忽略 XFF，防伪造换桶；app.mjs clientIp/createRateLimiter；test-rate-limit 15 项）
- B2 inflight 兜底：consume 死线 2×turnIdleTimeoutMs+toolResultTimeoutMs，触发补 cancelRun（relay.mjs 394-416）
- B3 select 优化：rank 预计算（比较器纯化）+ slidingLoad head 指针 + _rtArr 数组引用校验（keys.mjs 850-871, 962-970；200 号池 34.4→20.6µs）

### 二轮 review 结论（发版前已修）
- M-1 XFF 信任模型（无信任代理一律忽略 XFF）+ 两条固化绕过路径的测试修正
- m-1~m-7 全部修复：deadline 补 cancelRun、slidingLoad 数组替换、abort 竞态、切回日志页重连、ESC 输入框守卫、请求表独立刷新、ENV-SWITCHES 文档
- 发版判定：14 套测试全绿（97+9+30+21+15+15+7+3+34+14+22+33+9+9）

## 待办
- [ ] **生产部署决策**：VPS（nbus 38.244.34.15:8008）还是 v0.1.4 代码。洗刷后远程历史重写，VPS 的 git 模式 OTA 无法 ff-merge（历史不连续）——需手动同步（备份 → git fetch origin main → reset --hard origin/main 或重拉）+ 重启 cursorapi.service（**等用户明确指令**）
- [ ] GHCR 清理（等授权：gh auth refresh -s read:packages,delete:packages 或网页删）
- [ ] 后续波次（HANDOFF 待办）：批量导入页面、多方式添加账号（auth0 换 key）、RPM 均衡对齐 kirostudio

## 铁律
- 生产不重启不直改；本地验证→用户确认→生产
- ui.mjs 转义：JS 块禁反引号与 ${}；改完渲染后 script 提取 node --check
- 凭证读 ~/.claude/SECRETS.md，值不输出；8GB 机器执行类 agent ≤5 并行

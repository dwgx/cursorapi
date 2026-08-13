# cursorapi 会话状态（2026-08-14 洗刷后重新开始）

> 当前阶段：**v0.1 洗刷后 → UI 增强波次 → 准备发版 v0.1.0（tag+release+CI）**
> 仓库：dwgx/cursorapi（公开）。本地 main = 洗刷后单 commit `1fbdede v0.1: initial commit`，远程 main 已 force push 同步；远程 tags/releases 已清空；本地 tags 已清。
> 备份分支 **backup-pre-wipe**（旧完整历史 24 commit，v0.1.4，不推远程）。
> 版本：package.json = 0.1.0（发版时 tag v0.1.0 + release）。
> 遗留：GHCR 镜像（ghcr.io/dwgx/cursorapi 0.1.0/0.1/latest）未清——gh token 缺 packages scope，需用户授权或网页删除。

## 本波次（UI 增强 + 请求明细，已实现待修 MAJOR）

### 已完成（13 套测试全绿）
- **T1 后端请求明细**（app.mjs/keys.mjs/relay.mjs + 测试）：
  - keys.mjs `pushRecentRequest`/`listRecentRequests`：内存环形缓冲 500 条（keys.mjs:564-596），error 截断 200 字符，accountName 取 push 时池状态
  - relay.mjs settle（297-313）：recordRequest 处同步 push；只在 settle 主路径推
  - app.mjs `GET /admin/requests?limit=N`（235-242）：默认 50、上限 500
  - test-keys 97 通过、test-ui 24 通过
- **T2+T3 UI**（src/ui.mjs + test-ui.mjs，test-ui 28 通过）：
  - footer 注销→退出登录；主题切换按钮挪 page-header；footer 换设置按钮（go('settings')）
  - 日志页「最近请求」明细表（renderLogsView 1548-1653）：时间/模型/账号/结果徽标/耗时/Token，点击行展开详情，SSE 心跳顺带刷新（3s 节流）
  - 统计图增强（drawLine 2078-2217）：图例（请求蓝/成功率绿+区间合计）、Y 轴 0 起 nice 刻度、X 轴智能步进 ≤6、tooltip 加成功率
  - 账号管理「复制完整 Key」按钮（复用既有 /admin/accounts/:id/secret，app.mjs:383，HEAD 已有）
  - conn 页 5 个复制按钮（copyText/copyBtn，clipboard try/catch + fallbackCopy 降级）
  - 设置页 secret 显示明文：**不做**（后端一律掩码，无支持端点）
- **对抗式 review 结论**（可交付但先修 2 个 MAJOR）：
  - **M1**（ui.mjs:1561）：maybeRefreshRequests 无 in-flight 守卫 → 进日志页打 ~50 个重复请求、故障时帧率即请求率。修：reqBusy 标志 + 失败退避 + reqAt 完成时更新
  - **M2**（ui.mjs:2032-2042）：chartRange 切区间后图例合计值不重算（24h 852 vs 6h 实际 267）。修：图例值并入 drawCharts
  - MINOR：展开态按下标索引刷新漂移；文案「最近 500 条」vs limit=200；请求表时间 UTC vs 日志本地时间；limit parseInt 怪癖；settle 热路径多余分配；测试断言空转；keys.mjs `{...rec}` 全字段拷贝
- **A/B 调研**（对比 windsurf/kirostudio/kiro-rs）：
  - A 前端缺口 top：冷却倒计时、账号搜索、RPM/在飞数展示、ESC 快捷键、批量导入失败明细、日志 SSE 自动重连、导出选中子集、更新后健康轮询、代理连通性测试、模型实测
  - B 并发 top：**B1 入站限流缺失**（每-IP 固定窗口起步）、**B2 inflight 泄漏**（cancelRun 失败时 consume 永不 finally）、**B3 select 热路径**（O(n) 遍历×3 + shift O(n) memmove + rank 重复求值）、B4 记账分配、B5 persistLedger 同步阻塞、B6 SSE 订阅无上限、B7 全池 429 提前放弃、B9 连接无上限

## 本波次进行中（发版前收尾）

- [ ] 修 M1（请求表刷新风暴）、M2（图例失真）
- [ ] 并发三件套：B1 每-IP 固定窗口限流、B2 consume deadline 兜底、B3 select 优化（rank 预计算）
- [ ] 便捷功能：冷却倒计时、账号搜索、ESC 退出登录（HANDOFF 待办 #2，复用 askConfirm）、日志 SSE 自动重连
- [ ] 13 套测试全绿 + 二轮 review
- [ ] 发版：git tag v0.1.0 + push + GitHub Release + CI 全绿
- [ ] 遗留：GHCR 清理（等授权）

## 铁律
- 生产（nbus 38.244.34.15:8008）不重启不直改；本地验证→用户确认→生产
- ui.mjs 转义：JS 块禁反引号与 ${}；字符串换行 `\\n`；改完 node --check 验证
- 凭证读 ~/.claude/SECRETS.md，值不输出；8GB 机器执行类 agent ≤5 并行

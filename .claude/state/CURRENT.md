# CURRENT — cursorapi 会话状态

> 更新：2026-08-14（v0.1.0 发布 + 文档全量同步后）。交接散在 HANDOFF.md 与 .opencode/state.md，本文件为 .claude/state/ 规范位置，三者同步维护。

## 目标

本会话任务已完成（v0.1.0 发布 + 文档同步）。候选方向（等用户指定）：
- 生产部署 v0.1.0（等用户指令；VPS git 历史与远程不连续，需手动 reset + 重启）
- 添加账号批量导入页面 + 多方式添加账号（auth0 换 key，CreateUserApiKey 已跑通）
- RPM 均衡对齐 kirostudio（per-credential rpm_limit / balanced 选号 / 饱和溢出）

## 已确认事实（2026-08-14 核对 git）

- HEAD 5831745（docs: state 更新）；前序 57b49c3（v0.1.0 面板增强+并发加固）、1fbdede（洗刷单 commit）。
- 洗刷：远程 tags/releases 清空、历史单 commit、版本 0.1.0；本地 backup-pre-wipe 留旧历史（v0.1.4，不推）。
- v0.1.0 发布：tag + CI 9 job 全绿 + release 完整（4 平台二进制 + 源码包 + sha256）。
- 测试：14 套 309 项全绿（含 test-rate-limit 15 项）。
- 新功能（均已核实）：/admin/requests 最近请求明细（keys.mjs:568 环形 500）、入站限流（settings.mjs:92/100 + app.mjs clientIp 信任代理模型）、consume 死线（relay.mjs:39）、select 优化（keys.mjs:850-871 rank 预计算 + head 指针）、UI 便捷（复制/冷却倒计时/搜索/ESC/自动重连）。
- 生产 nbus 仍是 v0.1.4 代码（等部署指令）。GHCR 镜像未清（等授权）。
- 品牌：cursorapi / CURSOR_* / cookie cursorapi_sess（guard-auth.mjs:10）。
- 无 .codegraph 索引。

## 文档现状（2026-08-14 已全量同步）

- HANDOFF.md ✓（v0.1.0 状态、待办、教训含 XFF 信任模型）
- .opencode/state.md ✓（v0.1.0 发布完成）
- .claude/CONTEXT.md ✓（品牌修正、新功能锚点核实、14 测试套）
- README.md ✓（管理面板功能表 + API 表补 /admin/requests + 测试节）
- docs/ARCHITECTURE.md ✓（补限流章节、recentRequests、select 优化）
- docs/PLAN.md ✓（逐项勾选完成状态）
- docs/REVERSE-UI-PLAN.md ✓（标注已完成）
- docs/ENV-SWITCHES.md ✓（补 RATE_LIMIT_PER_MIN / TRUSTED_PROXY）
- docs/releases/RELEASE_NOTES_v0.1.0.md ✓（v0.1.0 内容）
- 研究类 8 篇（COMPARISON/KIRO-RESEARCH/PROTOCOL-COMPARISON/RESEARCH×2/REVERSE-SDK/SECURITY-AUDIT/ADR）保持不动——历史情报仍有效

## 风险 / 注意

- ui.mjs 改前先确认无并行会话在动它（模板字符串转义地狱，改完必须 node --check）。
- 生产部署 v0.1.0 时 VPS git 模式 OTA 已不可用（历史不连续），只能手动同步。
- relay.mjs waitTurn 事件驱动（0e87259）与 consume 死线（v0.1.0）已在文档反映。

## 待办

- [ ] 等用户指定下一任务（生产部署 / 批量导入 / RPM 均衡）
- [ ] GHCR 清理（等授权）

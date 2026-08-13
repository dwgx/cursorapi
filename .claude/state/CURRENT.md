# CURRENT — cursorapi 会话状态

> 建于 2026-08-14 接手会话（/onboard）。此前交接散在 HANDOFF.md 与 .opencode/state.md，本文件起为 .claude/state/ 规范位置。
> 本会话约定：派 subagent 时 model 用 claude-fable-5[1m]。

## 目标

本会话任务待用户指定。候选方向（来自 HANDOFF.md 待办）：
- Phase 1 池核心：粘性会话（prompt cache 成本）→ 原子选号（并发惊群）。熔断半开已存在（HEAD 提交提到 half-open）。
- B 面真实链路压测：脚本 pressure-ota/b-real.mjs 就绪，被两个真实 key 401 失效阻塞，key 恢复后 30 秒可跑。
- 本地 .env 迁移（旧前缀/旧端口 → CURSOR_*/8008）；README 功能细节滞后。

## 已确认事实（2026-08-14 核对 git）

- HEAD 8197c6d：quota 耗尽改为持久禁用（原 30min 冷却会复活坏号导致全客户端报 usage 错，线上 bug）。工作区干净。
- 版本线：v0.1.4（d08e99b，OTA zip 完整性双信道）+ 上述 fix。
- 品牌已回改 cursorapi / CURSOR_* / cookie cursorapi_sess（b218018、4cca0c7）。
- 测试：npm test 全套（需先 npm install）；test-keys / test-ui 有两处打真网（失败请求，不花钱）。
- 无 .codegraph 索引。

## 文档不一致（相信 git，不信文档）

1. .claude/CONTEXT.md（8/13）仍是 CursurSPIKEY / CSPK_ 时期内容，品牌与 cookie 名已过期（state.md 也注明此偏差）。
2. HANDOFF.md 被机械改名污染：多处「CURSOR_* → CURSOR_*」自我抵消，改名映射不可读。
3. .opencode/state.md 头部写「v0.1.1 发布中」，实际已 v0.1.4+；正文各压测波次是最新的（8/14 03:26）。
4. HEAD 的 quota 持久禁用 fix 未进任何交接文档。

## 风险 / 注意

- ui.mjs 曾由另一 agent 重写（UI 第一批已在 v0.1.1 落地）；改前先确认无并行会话在动它。
- relay.mjs waitTurn 已事件驱动化（0e87259），旧文档中「非流式 idle 超时候选 bug」需按新代码复核。
- 8103/8105 端口曾有遗留压测实例，动压测前先查。

## 待办

- [ ] 等用户指定本会话任务
- [ ] （顺手项）CONTEXT.md 品牌/cookie 名过期内容更新

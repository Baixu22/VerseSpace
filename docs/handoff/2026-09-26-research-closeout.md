# Workbench 工程研究原型收尾（2026-09-26）

研究问题：在读取行为只能被部分观测的条件下，为个人开发者与开发代理提供可追溯的前提失效提示和恢复支持。范围由 [ADR-0023](../decisions/0023-research-prototype-closeout.md) 固定。

## 核心声明与复核入口

| 声明 | 实现与仪器 | 证据及边界 |
| --- | --- | --- |
| 已记录的文件/区间变化可检测，包含去重和保守回退 | [前提检测](../../packages/workbench/src/runtime/premises.ts)、[检测场景](../../packages/workbench/scripts/benchmark-premises.ts) | claim-premise-contract；合成契约，不代表语义正确性或用户精度 |
| 世界事实与会话观测共用日志，投影有方向性边界 | [事件实现](../../packages/workbench/src/blackboard/events.ts)、[事件测试](../../packages/workbench/src/blackboard/events.test.ts) | claim-workbench-suite 的覆盖读数；不是全部历史节点原验收的复算 |
| 入队、投递、重新读取分开计量；未知结局保持未知 | [投递测试](../../packages/workbench/src/runtime/delivery.test.ts)、[结局测试](../../packages/workbench/src/runtime/notice-outcome.test.ts) | claim-workbench-suite；送达不等于修复 |
| 上下文继承与前提继承分别展示 | [线程标记](../../apps/workbench-ui/src/components/chat/thread-observability.tsx)及同目录测试 | claim-ui-suite；Codex 始终标为实验通道 |
| Codex 有命令形状边界，写保护未完成真实验收 | [足迹边界测试](../../packages/workbench/src/chat/codex-footprint.test.ts)、[实验前置测试](../../packages/workbench/scripts/verify/codex-seal-baseline.test.ts) | claim-workbench-suite；受控测试，不是真实 CLI 或自然用户样本 |
| 声明可失效，失败读数不能认证成功 | [声明评估器](../../scripts/claims/ledger.mjs)、[反例测试](../../scripts/claims/ledger.test.mjs) | claim-claims-gate；仅覆盖注册声明，非任意散文的语义证明 |
| 本机二进制与 JS 包均能在隔离工作区运行 | [产物检查](../../packages/workbench/scripts/check-built.ts) | claim-built-shapes；只覆盖 Windows 本机，不代表已公开发行或跨平台通过 |

最新数字、时间、环境、被测提交及原始输出摘要见 [evidence/readings](../../evidence/readings/claim-workbench-suite.json)，定义见 [claims.json](../../evidence/claims.json)。本文不复制随重跑漂移的计数。valid 与 observation 分开报告；本次保留一条 Codex 旧实验的历史观测。

两点边界，避免把工具读数读成研究结论：`doctor` 报的「117 条架构断言」是指令文件**引用存在性**检查的条数，不是 117 条设计与效果主张成立；声明账本里的 `valid` 也只表示**该条已登记命题**在其声明的依赖范围内有可复核读数，不是对任意散文的语义证明。文档里尚未登记的旧数字仍是历史读数（含 38 个历史节点的间接覆盖证据），不因本轮收尾自动升级为当前结论。

## 本次修正

评估器原先只查字段存在，失败套件和错误类型可能被标 valid；现增加类型、实际退出码、期望值和最低样本要求。Workbench 失效范围包含直接导入的 context-rot 与依赖锁文件。记录器拒绝没有执行的记录与未完成的子进程；JSON 门禁保留具体问题。
Codex 实验修正默认参数、写者归属、前提捕获时机和对照快照。读取无足迹时报告无法测量；不把没有前提的 pass 当成保护有效。生产接线保留为实验性，包说明、界面和工程约定对齐。
Windows 测试清理重试窗口延长；最终清理失败仍然抛出，不静默转绿。所有自动测试均是受控验证，不充当真人价值读数。

## 复跑

使用固定的 Bun 1.3.14。Windows shell 需要正常 PATH / PATHEXT；loopback 用 NO_PROXY=127.0.0.1,localhost,::1。按序执行，避免全 UI 测试与重构建争用内存。

~~~sh
bun run lint
bun run typecheck
bun run test:workbench
bun run test:workbench-ui
bun run test:context-rot
node scripts/claims/ledger.test.mjs
bun packages/workbench/scripts/benchmark-premises.ts --json
bun packages/workbench/src/index.ts doctor
node scripts/check-upload-surface.mjs --strict-references
pwsh -NoProfile -File scripts/win/e2e-browser.ps1
cd packages/workbench
bun run build
bun run test:build
~~~

构建产生本机版本 0.4.1；可执行文件、JS 包及许可文件在包的 dist 目录。源码提交见读数 subject_sha。当前本地构建与旧公开 0.4.0 发行物区分；本轮不推 tag、不发布 Release。
取读数须在源码和文档提交后运行记录器 --run，再提交读数；输入变化后必须重取。构建声明的仪器同时执行 build 与 test:build，不能用旧二进制冒充新源码结果。
可选的真实 Codex 实验需独立 CODEX_HOME 和明确 WORKBENCH_CODEX_COMMAND，见[前置条件](2026-09-26-codex-preconditions.md)。分别执行 own-fresh、own-stale；本轮只验证仪器和已知命令形状，不运行付费模型、不宣称真实写保护通过。

## 历史资料处置

此前 fit 账本和设计提示词指向六份本机专用材料。现改为仓库中的权威边界和复跑说明；原始本机材料保留，不批量上传过程日志，不以新实验替代旧结果。六条断链按 ADR-0020「复核」逐条裁决：材料维持本机，承重引用改为指向本记录；2026-09-25 那份交接记录 §5 的待裁决表格本身是裁决载体，作为具名例外记在 `scripts/upload-surface/policy.json` 的 `acceptedLocalReferences`，`node scripts/check-upload-surface.mjs --strict-references` 现 exit 0。门禁按子串判定，ADR 里 `../positioning-v5.md` 这类相对写法不在覆盖内（已知盲区，见 ADR-0023）。
- 定位 v5/v6 为调研历史，当前设计以 ADR-0010、ADR-0023 为准。
- 2026-09-05 的 Claude 继承实验结论已在 [ADR-0010 §5](../decisions/0010-premise-custody.md) 保存；仪器为 [measure-fork-inheritance.ts](../../packages/workbench/scripts/measure-fork-inheritance.ts)。本轮未重取真实继承读数。
- 2026-09-07 的模型实验与原始 JSON 属旧现场观测；本轮不认证其当前有效性。现行复跑方式见[包说明](../../packages/workbench/README.md)。[2026-09-25 独立现场](2026-09-25-real-provider-e2e.md)是另一份有日期的记录，不是旧样本的替代证据。
- L3 砍留与真人窗口的现行范围依据是 ADR-0019、ADR-0023。旧判决不作为当前效率收益证明。

## 结论边界与重启条件

工程产物的支持范围可复核；尚无足够自然用户证据证明效率、返工率或恢复速度改善，不宣称算法首创。notified/overlaps 是负载相关诊断统计，不能单独代替精确率、召回率或因果对照。
后续仅在明确需要时分别立项：真实个人使用研究；Codex 指定版本及命令范围的读写闭环；非 Windows 验证；公开发行。它们不是本轮原型的隐含未完成项。森林提案保留限制和重启条件，不把未执行实验改成 done。

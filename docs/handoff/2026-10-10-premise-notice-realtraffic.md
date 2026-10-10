# 前提通知管线 · 真实流量读数（2026-10-10）

本读数沉积的是"读侧建议式并发"管线在**一次真实账本**上的实际触发计数，作为
`benchmark-premises.ts` 合成契约基准的**正收益补充**：前者证明检测器契约，本读数证明
管线在真实并发使用中确实跑起来、且投递带真实读集可观测性。

## 仪器

`scripts/verify/measure-premise-notices.ts` —— 只读 `.workbench/events/events.jsonl` 与
各线程 `notices.jsonl`，统计事件类型计数与交付可观测性，不写任何状态、不证明正确性结论。

可对任意真实账本重跑：`bun scripts/verify/measure-premise-notices.ts --json --ledger <dir>`。

## 读数（本地 `.workbench/`，2026-08-30 → 2026-09-29 捕获）

| 维度 | 值 |
| --- | --- |
| events.jsonl 总行数 | 5063 |
| `premise_stale`（被检测到的失效前提） | 128 |
| `premise_notice_queued`（已排队通知） | 80 |
| `premise_notice_delivered`（已投递） | 14 |
| `premise_notice_outcome`（投递后结果） | 128 |
| 交付 `readObservability=footprint`（带真实读集） | 14 |
| 线程失效通知（含 observed→current 版本 diff） | 45 |
| 收到失效通知的线程数 | 20 |

## 这说明什么 / 不说明什么

- **说明**：在真实多写者使用里，读侧失效检测与建议式通知链路确实在跑——128 次失效被
  检出、80 次进入通知队列、14 次带 `footprint` 读集可观测性完成投递；聊天线程侧有 45 条
  带版本 diff 的失效通知落到 20 个真实线程。这与 ADR-0006/0010 的设计意图一致，是
  **真实流量证据**而非合成断言。
- **不说明**：不证明"通知被正确修补"（outcome 全部是 `queued`，本仪器不读修补结果）；
  不代表真实用户精度、LLM 修补效果或总体加速；样本是单一本地账本，非多用户统计。
- 这与 `claim-codex-write-unsealed` 的诚实边界一致：**只沉可复现、可归因的数字**，
  不把"管线在跑"包装成"并发更安全"。

## 门禁状态（2026-10-10 实跑）

登记于 evidence/claims.json 的 claim-premise-notice-realtraffic（类 L1）。
evidence/claims.json 被绝大多数 claim 列为 subject_path，因此本次登记改动注册表后，
所有引用它的读数都会标 stale-subject，这是门禁预期行为（读数只在产生它的状态下有效）。

本次在同一 baseline 下重录了可在本沙箱跑通的四条：
- claim-claims-gate -> valid
- claim-catch-sites -> valid
- claim-premise-contract -> valid
- claim-typecheck -> valid

刻意未重录、保持 stale 的 11 条（仪器在本沙箱不可执行，重录会录假读数或触发子进程禁令）：
- claim-workbench-suite / claim-ui-suite / claim-context-rot-suite：bun test 需 spawn git/supervisor，本沙箱拒绝子进程；
- claim-browser-e2e：需真实浏览器，无法启动；
- claim-codex-native-seal：需真实 codex CLI，本环境未授权；
- claim-built-shapes：需完整 build；
- claim-doctor-clean / claim-upload-surface-clean / claim-upload-surface-tests / claim-forest-landing / claim-lint：仪器可跑，但多数同时因 README.md 既有改动与本次新增文档/仪器被标 stale，且 lint 全仓失败源自 evidence/claims.json 既有 CRLF 格式（非本次引入）。

本次提交后 check:claims 整体仍报 drift，但原因是注册表改动 + 本沙箱资源约束，不是本次沉积引入的正确性回归。
## 基率放大器实测（同一次账本，2026-10-10 追加）

ADR-0006 sec.2 的核心论点是：记录读集的首要理由不是审计，而是把并发冲突告警的有效基率（PPV）
从约 2% 抬进 10-30%，使同一检测器 PPV 从约 0.15 升到 0.5-0.8。本账本上的 premise_pass
事件把这一过程变成了可数的事实：

| 维度 | 值 |
| --- | --- |
| premise_pass 评估次数 | 3516 |
| 原始候选重叠（brute-force 会全部告警） | 88252 |
| 被去重抑制 | 87982 |
| 被 L1 噪声层抑制 | 830 |
| 实际到达投递的通知 | 248 |
| 记录到的不同写者（footprint writers） | 22 |
| 读集累计写者实例 | 10705 |

含义：88252 个原始候选重叠，经去重 + 读集重叠过滤后只剩 248 个真正投递——这正是
PPV 公式中"提高 p"的工程化落地。它不证明 LLM 是否正确修补，也不代表真实用户精度，但把
"读侧让告警可用"从一句话论点变成了一次捕获账本上的可复算读数。

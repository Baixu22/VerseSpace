# TF-0136 四项判决书（真实使用样本门 · 2026-09-06）

> 样本源：E2E 租户黑板（`workbench-e2e-tenant`，2026-09-06 经用户确认登记为正式样本源）。
> t0 = `2026-09-06T06:35:51.936Z`（eventSeq=1，首条 `thread.created`，无自举噪音）。
> 判决时点样本：95 线程 / 57 注册写者 / 497+ 事件；全部数字来自 `workbench stats --json`
> 与 `events.jsonl` 实测，可复跑核对（`bun scripts/e2e/run.ts --workspace <租户>` 累积）。
> 本文是判断文档；数字的生成器是 `scripts/fit-ledger/`，窗口判据见 `docs/fit-ledger.md`。

## 样本窗口（TF-0141，先决条件）

| 判据 | 实测 | 门槛 | 结果 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 56 | ≥3 | ✓ |
| 通知结局 noticeOutcomes.rows | 61 | ≥5 | ✓ |
| 封印判决 seal.decisions | 25 | ≥3 | ✓ |

窗口凑齐，t0 已登记——**可以裁决，不看日历**。

## 判决一：恢复卡值得继续投入 → **通过，保留叙事段**

- 判据：`resume_note_consumed / thread.restored ≥ 0.3` 且 `resume_action > 0`。
- 实测：`stats.lifecycle.resumeNotesConsumed = 17`，`stats.lifecycle.restores = 56`
  → **17/56 = 0.304 ≥ 0.3**；`resumeActions = 27`（`resume_card_revealed` ×17、
  `resume_card_dismissed` ×10，事件 `thread.resume_action`）。
- 边际提示：0.304 刚过线。恢复后的首动作有观测（`restoreFirstAction.observed = 23`，
  known 23 / unknown 33），「卡片被读」成立，但「读了就行动」的转化还没有独立计数。
- 结论：恢复卡（叙事 + 事实双通道）继续投入，不降级为纯 facts 行。

## 判决二：前提检测精度可用 → **通过，不加第 4 层谓词**

- 判据：agent 侧 `dismissed / notified ≤ 0.5` 且 `ignored ≤ 0.1`。
- 实测：`stats.noticeOutcomes.agent`：delivered 17、**repaired 16**、dismissed 0、
  ignored 0、unknown 1（no-later-activity）。`dismissedRatio = 0`、`ignoredRatio = 0`。
- 含义：16/17 = 94% 的通知让写者回头复查了失效文件（S7b 复读回合，事件
  `premise_notice_outcome` 的 repaired 标注）。没有一封通知被无视。
- 结论：谓词层数维持三层，不新增 import 可达性层。

## 判决三：阶段 C 是否开工 → **通过，不延后**

- 判据：样本窗口内真实 fork ≥ 5 且 TF-0140 问题 1 成立。
- 实测：`stats.forks.total = 50`（25 个 fork 家族，最大家族 3 线程）；TF-0140 Q1
  成立（`--resume <id> --fork-session` 实测接上并铸新 session id，见
  `docs/report-2026-09-05-claude-fork-inheritance.md`；且租户每轮 fork 都在真实
  走 `threads.ts` 拼的这条命令行，`thread.inheritance_observed` 事件在账）。
- 结论：阶段 C 不整体延后。落地口径：TF-0131/TF-0134 已收口，TF-0132/TF-0146 已
  废止，唯一未收口子项 TF-0133（通知预算）继续由自己的开工闸门持有（见下）。
- 附带读数（诚实交代）：`stats.premises.notifiedRatio` 批次 #2 结束时 0.16（带内），
  当前读数 **0.087（too-quiet，低于 0.1 下界）**——漂移来自空闲期 ticker 对同一批
  声明的 dedup 重查（suppressedDedup 999 / overlaps 1094），是负载形状而非谓词
  失灵；这正是 TF-0133 的开工门（ratio > 0.3）**不满足**的直接证据：家族折叠不开工。

## 判决四：L3 去留 → **砍 TF-0099**

- 判据：无判据可满足（事件结构性为零）则砍。
- 实测：`variant.promoted` / `promotion_reverted` 在事件系统里**没有生产者**
  （`types/event.ts` 无此类型；租户 95 线程全部事件中出现 0 次；原门槛已在
  TFP-2026-09-06-foundation-and-blocker-audit 中删除）。样本窗口凑齐后依然为零
  ——这不是「还没用到」，是「无可观测行为可言」。
- 佐证（TF-0099 证据栏既有）：ALLOY（UIST'25）推导结构正确性输给手写（9/12 vs
  10/12）；规格挖掘误报 90-99%；LLM 解冲突与开发者一致率仅 55-59%。
- 结论：**TF-0099 废止**；TF-0100（N=2 推导）、TF-0101（重放验证）随之废止——
  它们的 depends_on 目标已不存在。资源集中到有行为证据的恢复卡（判决一）与
  通知通道（判决二）。

## 判决后的森林动作

1. TF-0136 → done（本判决书即验收五「结论写回森林」的载体，节点证据引用本文）。
2. TF-0099 → deprecated；TF-0100 / TF-0101 → deprecated。
3. TF-0130 → in_progress 维持（判决三「不延后」；余量只剩 TF-0133 的门控等待）。
4. TF-0133 → blocked 维持（0.087 < 0.3，开工门不满足，证据入栏）。

以上全部进 TFP-2026-09-06-stage-b-and-sample-window 提案，随该提案一次性落库。

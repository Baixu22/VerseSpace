# TF-0136 四项判决与当前范围（2026-09-07）

四项判据现由 `packages/workbench/scripts/fit-ledger/verdicts.ts` 统一计算，JSON 与 Markdown 使用同一份结果。当前读数见 [fit 账本](./fit-ledger.md)，本轮修改和独立验收见 [阶段 D 接力记录](./report-2026-09-07-phase-d.md)。

| 判决 | 当前范围 | 证据要求 |
| --- | --- | --- |
| 恢复卡 | 保留现有实现，记录未达标样本，继续核对自然使用效果 | 笔记消费 / 恢复 ≥ 0.3 且恢复动作 > 0；脚本手势不能证明人类认可或耗时改善 |
| 前提检测 | 依据实际投递及其结局继续校准 | dismissed ≤ 50%、ignored ≤ 10%；未知结局的上界也必须在阈值内才能支持结论 |
| 阶段 C | 工程实现已完成，保留分叉、通知与封印 | ≥5 次分叉，且存在上下文与读集同时继承的观测；仅复制 transcript 不满足 |
| L3 | 已砍：TF-0099 / TF-0100 / TF-0101 于 2026-09-09 废止（[判决书](./tf0136-l3-cut-verdict.md)） | 行为事件在代码库里结构性为零，自然使用无法改变这一点；账本仍记录自然使用是否曾达门槛，仅作长期观察 |

工程采样仍使用 3 次恢复 / 5 行校准 / 3 次封印的门槛，不因日历不足而暂停开发。来源通过 `--evidence-kind` 明确声明；未声明则四项判决保持证据不足。声明仅说明报告口径，不筛选、认证或改写原始事件。

2026-09-10 起，账本对**人类认可类指标**加了同样的来源门：TF-0154 的 L1 认可率只在 `--evidence-kind natural` 下推动 fit。脚本或模型运行安排的复核手势（`scripts/e2e/landmark-coverage.ts` 以 0.75 的概率 endorse）只会让读数收敛到脚本常数，2026-09-09 据此写入森林的「L1 升 partial (0.75)」已作为偏差更正；数字仍显示，用于核对通道与覆盖率。

兄弟交替按全部根家族计算，包含未切换的家族；同一根家族内的多层兄弟只计一次。两次交替须处于同一个 30 分钟窗口。L3 的事实消费只计已有的 `resume_fact_opened` 和 `resume_branch_opened`，不使用 `promotion_reverted`，也不把 dismiss 或叙事展开当作事实消费。

这些结果用于范围复核，不自动修改 UI、增加谓词或解除森林依赖。TF-0136 / TF-0137 保持进行中；自然效果和对外 benchmark 的样本要求尚未全部满足。校准量门限制对外结论，不阻塞继续做工程验证。

## 历史候选

下面保留 2026-09-06 的候选判决，便于追溯。该综合提案未整体应用；其中“废止 L3”“阶段 C 尚未完成”“家族折叠不开工”等表述不代表当前森林状态。

<details>
<summary>2026-09-06 候选原文（已被当前范围说明取代）</summary>

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

</details>

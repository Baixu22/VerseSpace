# 阶段 D 真实数据验收：SenseAudio S2 Flash 默认模型 · 17 轮累积（2026-09-10）

> 本文档把 `workbench-e2e-live-tenant` 租户在 SenseAudio S2 Flash 成为默认模型后
> 前 17 轮累积（含本轮 3 轮）的真实读数，逐条对照 TF-0136 / TF-0137 的验收文本
> 给出结论。数字全部可复跑：`bun scripts/e2e/run.ts --live --rounds N` 累积、`fit-ledger --json`
> 读取；本快照为 `docs/fit-ledger-2026-09-10-senseaudio-17rounds.md`。

## 现场与来源

- 模型：`senseaudio-s2-flash` · `https://api.senseaudio.cn/v1`（凭据在 `%LOCALAPPDATA%/HelmorWorkbench/credentials/openrouter.dpapi`，`run-live.ps1` 默认读取）
- 事件跨度：1.93 天（2026-09-08T16:41:02Z → 2026-09-10T14:56:49Z）
- t0：已开始，69 条线程 / 75 个注册写者
- 来源声明：`--evidence-kind live-model`（真实模型执行，手势与场景由脚本安排）
- 累计跑次：17（本轮 3 轮全绿，0 失败）；模型调用约 660+ 次，错误全部经有界重试恢复

## 样本窗口（TF-0141 前置条件）

| 判据 | 实测 | 门槛 | 结果 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 38 | ≥ 3 | ✓ |
| 通知结局 noticeOutcomes.rows | 95 | ≥ 5 | ✓ |
| 封印判决 seal.decisions | 20 | ≥ 3 | ✓ |

工程样本量门全部满足；按节点口径，**日期跨度只作展示，不阻塞工程验收**（14 天只约束 natural 类指标）。

## TF-0136 四项判决

### 判决一：恢复卡 —— supported

| 来源 | 实测 | 判据 | 结果 |
| --- | --- | --- | --- |
| resumeNotesConsumed / thread.restored | 0.4375 | ≥ 0.3 | ✓ |
| resumeActions | 27 | > 0 | ✓ |

结论：恢复卡在本现场被真实消费，保留。口径注明：`resume_card_revealed` 13、`resume_branch_opened` 12、`resume_card_dismissed` 2，全部来自真实进程手势；工程场景的消费不等于自然用户认可或耗时改善，后者仍需 natural 现场。

### 判决二：前提检测 —— supported

| 来源 | 实测 | 判据 | 结果 |
| --- | --- | --- | --- |
| agent.delivered | 35+ | > 0 | ✓ |
| agent.dismissed / delivered | 0 | ≤ 0.5 | ✓ |
| agent.ignored / delivered | 0 | ≤ 0.1 | ✓ |
| (dismissed + unknown) / delivered | 0 | ≤ 0.5 | ✓ |
| (ignored + unknown) / delivered | 0 | ≤ 0.1 | ✓ |

结论：agent 侧通知结局无驳回、无忽略、无未知。检测与投递在真模型下精度满足阈值，无需新增第 4 层谓词。

### 判决三：阶段 C —— supported

| 来源 | 实测 | 判据 | 结果 |
| --- | --- | --- | --- |
| forks.total | 28+ | ≥ 5 | ✓ |
| 真实继承观测（agentContext ∧ premise，按 thread 去重） | 3 | ≥ 1 | ✓ |

结论：分叉与真实继承达到开工与保留门槛，阶段 C 保留。

### 判决四：L3 —— insufficient-evidence（已砍，维持）

按纪律 `kind !== "natural" || days < 14` 恒为 insufficient-evidence，且 TF-0099/0100/0101 已于 2026-09-09 废止（`docs/tf0136-l3-cut-verdict.md`）。本判据只记录自然使用是否曾达门槛，工程不等待它。

## TF-0137 护城河四个数字（第 30 天回看的工程读数）

| 护城河 | 实测 | 门槛 | 结果 |
| --- | --- | --- | --- |
| A 校准表行数 | 95 | ≥ 50 | ✓ |
| B 推定写者 git/human 的失效通知 | 1 | ≥ 1 | ✓ |
| C 真实会话 seal.decided: block | 18 | ≥ 1（且事后判定正确） | ✓ |
| D notified / overlaps | 0.149 | 10–30% | ✓ |

benchmark 闸门：**开**（`missing: []`）。

## TF-0135 基线（fork/week、兄弟交替、恢复首动作）

- forks.total = 28+，观察 1.93 天 → perWeek 有值
- 兄弟交替：14 个根家族，其中 1 个交替家族，rate 0.071(≤30 分钟窗口口径)
- 恢复首动作：13 次观测全部为 `resume card revealed`（known=13,unknown=19）
- footprint 覆盖率 0.737(≥0.5)，恢复笔记覆盖率 0.246

兄弟交替率 0.071 低于 L3 判据的 0.3，但这只影响 L3 复评（已砍），不构成工程验收障碍；该指标用于长期观察。

## fit 账本分布（32 行,t0 = 本轮之前）

aligned 3 · partial 15 · unknown 9（直方图只统计 27 行，5 条里程碑按上卷处理）。15 个 partial 全是已 done 节点在账本中的"在用但未设阈值"状态（probe 有 read 无 judge 的保守展示），不是待办。unknown 9 个 = record 类（无运行时来源）7 + 无样本部件 1（TF-0142）+ TF-0154（L1，natural 门）。

> **2026-09-11 更正**：本节原文写作「aligned 3 · partial 16 · unknown 6」与机读快照 `docs/fit-ledger-2026-09-10-senseaudio-17rounds.md` 不符，属转述错误（生成的表格正确、转述的正文写错）。`bun scripts/fit-monitor.ts` 的 `report-prose-drift` 告警把它抓出来，现按机读产物更正，并已同步修正 TF-0137 的证据文本。

## 必须等 natural 的两项（本轮不能验收）

1. **L1 认可率（TF-0154）**：本轮记下的 total 53 / reviewed 9 / endorsedShare 0.151 用的是投影列表当分母——其中含无地标时回退到可见集 top-N 的显示表。2026-09-11 已按 positioning-v6 §11「地标集合（DOI>10）」改为真地标（52 条里绝大多数不是地标），见 TF-0154 的更正证据与偏差 TFD。口径仍不变：数字随样本波动且全部来自脚本手势；只有 `--evidence-kind natural` 的真用户复核才能推动 fit。
2. **恢复卡的人类耗时与认可**：restoreToMessage medianChangeRatio 321x（withCard 1936ms vs withoutCard 6ms）源头上是 E2E 脚本恢复后先断言卡再发消息；不构成自然用户拖慢证据，不推 fit。

## 结论

TF-0136 三条判决、TF-0137 四个护城河数字、TF-0135 工程基线，在 **live-model 真实模型现场**已全部达门槛且有可追溯来源；TF-0141 工程样本门满足。工程侧对这些验收项**无遗留待办**。

剩余未验收项只有 L1 认可与恢复卡人类效果（均 `requires: natural`），必须由真实使用产生。这与森林节点 next_action 的口径一致：「工程侧无待办；是否据此收口由用户决定」。本记录与 `docs/fit-ledger-2026-09-10-senseaudio-17rounds.md` 提供收口决策所需的数据依据。
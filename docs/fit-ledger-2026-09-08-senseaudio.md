# fit 账本（TF-0137）

> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，
> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。

- 生成时间：2026-09-08T15:51:50.716Z
- 数据源黑板：`C:\Users\27933\AppData\Local\Temp\workbench-e2e-cSJhox\.workbench`
- 样本来源（运行者声明）：真实模型执行，手势与场景由脚本安排。该声明不筛选或认证事件，混合现场须单独核对。
- 事件跨度：0.0 天（2026-09-08T15:14:26.078Z → 2026-09-08T15:16:58.755Z）。工程窗口不以日历设门；L3 自然使用仍要求至少 14 天。

两条纪律（词表与证据）：

1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。
2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。

同一个词表，两种问法，别混：

- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。
- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。

共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。
所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。

## t0（现场采样起点，TF-0141）

**已开始**：实测 9 条线程、11 个注册写者，部件行按该现场来源计入 fit。

## 样本窗口（TF-0141）

| 样本类别 | 实测 | 目标 | 齐 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 7 | 3 | 是 |
| 通知结局 noticeOutcomes.rows | 8 | 5 | 是 |
| 封印判决 seal.decisions | 6 | 3 | 是 |

**工程窗口已凑齐**：可以核对四项判据；自然用户效果与 L3 长期门槛仍单独判断。

## 四项判决（TF-0136）

仅从本现场提出判断与下一步，不自动修改卡片、谓词或森林状态。

### 判决一：恢复卡：本现场不满足判据

保留现状，复核恢复与消费记录；达到使用证据要求后再判断是否缩为纯事实行。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.lifecycle.resumeNotesConsumed / stats.lifecycle.restores | 0.2857142857142857 | ≥ 0.3 |
| stats.lifecycle.resumeActions | 2 | > 0 |

### 判决二：前提检测：本现场支持判据

现有检测满足本现场阈值，继续采样。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.noticeOutcomes.agent.delivered | 4 | > 0 |
| stats.noticeOutcomes.agent.dismissed / .delivered | 0 | ≤ 0.5 |
| stats.noticeOutcomes.agent.ignored / .delivered | 0 | ≤ 0.1 |
| stats.noticeOutcomes.agent.unknown | 0 | 保留为未知 |
| (stats.noticeOutcomes.agent.dismissed + .unknown) / .delivered | 0 | ≤ 0.5 才足以支持判据 |
| (stats.noticeOutcomes.agent.ignored + .unknown) / .delivered | 0 | ≤ 0.1 才足以支持判据 |

### 判决三：阶段 C：本现场支持判据

保留已完成的阶段 C；继续回归分叉继承、通知与封印。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.forks.total | 5 | ≥ 5 |
| events[thread.inheritance_observed]：agentContextInherited && premiseInherited，按 threadId 去重（TF-0125/0131） | 3 | ≥ 1 |

### 判决四：L3：证据不足

继续延后 L3，保留 TF-0099 / TF-0100 / TF-0101 的阻塞状态；工程开发照常推进。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.observation.days（仅时间跨度，来源须另行核对） | 0.0017670949074074073 | 自然使用且 ≥ 14 天 |
| stats.forks.total / (stats.observation.days / 7) | 无样本 | ≥ 1 |
| stats.siblingAlternation.alternatingFamilies / .families（全部根家族为分母，TF-0122） | 0.5 | ≥ 0.3 |
| events[thread.resume_action]：resume_fact_opened / resume_branch_opened（TF-0129/0151） | 无样本 | ≥ 1 / 周；dismiss 与叙事展开不计事实消费 |

## 恢复到首条消息（TF-0126，近 7 天）

| 恢复时卡片 | 有效样本 | 中位耗时（ms） |
| --- | --- | --- |
| 可见 | 2 | 1286 |
| 不可见 | 5 | 5 |
| 未记录 | 0 | 无样本 |

未配对恢复：0。来源：`stats.lifecycle.restoreToMessage`；恢复事件与当次加载后的第一条用户消息配对，切走即结束。

中位耗时差异：25620.0%；超过 20%：是。这是观察值，不证明卡片导致变化，不自动改变卡片或节点状态。

## 地标集合认可（L1）

当前地标 40 个，已复核 1 个，认可 1 个，不认可 0 个。

完整集合认可率 2.5%；复核覆盖率 2.5%。

来源：`stats.landmarkReviews.current`。分母包含未复核地标；每个写者的每个条目只取最新结论，重复反馈不累加成认可率。

## 护城河四个数字（样本齐备后回看）

| | 数字 | 门槛 | 当前 | 齐备 | 来源 |
| --- | --- | --- | --- | --- | --- |
| A | 校准表行数 | ≥ 50 | 8 | **否** | `stats.noticeOutcomes.rows` |
| B | 推定写者是 git 或人的失效通知 | ≥ 1 条 | 1 | 是 | `events[premise_stale] ⋈ sessions/<writer>.kind` |
| C | 来自真实会话的 seal.decided: block | ≥ 1 次（且事后判定为正确封印） | 4 | 是 | `stats.seal.blocked + stats.seal.reviews.correct` |
| D | notified / overlaps | 有真实值且落在 10-30% | 0.304 | **否** | `stats.premises.notifiedRatio` |

**闸门关：** 缺 A 校准表行数、D notified / overlaps。缺任何一个先补它，不扩树。

> 近 7 天窗口读数：notified/overlaps = 30.4%（23 次重叠 / 6 轮）。聚合比值随空闲重查的 dedup 累积自然衰减，窗口读数反映当前谓词健康度；聚合口径与 band 判定不变。

## fit 分布

计入 fit 的节点 0 个（里程碑不计，deprecated 不入账也不进分母）：

- aligned 0 · partial 0 · weak 0 · misaligned 0 · **unknown 0**

## 逐节点

| 节点 | 类型 | 状态 | fit | 可观测指标（authored） | 当前值（measured） | 依据 |
| --- | --- | --- | --- | --- | --- | --- |


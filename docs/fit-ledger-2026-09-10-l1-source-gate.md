# fit 账本（TF-0137）

> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，
> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。

- 生成时间：2026-09-09T17:27:48.282Z
- 数据源黑板：`C:\Users\27933\AppData\Local\Temp\workbench-e2e-live-tenant\.workbench`
- 样本来源（运行者声明）：真实模型执行，手势与场景由脚本安排。该声明不筛选或认证事件，混合现场须单独核对。
- 事件跨度：0.7 天（2026-09-08T16:41:02.612Z → 2026-09-09T09:16:02.899Z）。工程窗口不以日历设门；L3 自然使用仍要求至少 14 天。

两条纪律（词表与证据）：

1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。
2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。

同一个词表，两种问法，别混：

- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。
- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。

共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。
所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。

## t0（现场采样起点，TF-0141）

**已开始**：实测 53 条线程、59 个注册写者，部件行按该现场来源计入 fit。

## 样本窗口（TF-0141）

| 样本类别 | 实测 | 目标 | 齐 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 30 | 3 | 是 |
| 通知结局 noticeOutcomes.rows | 70 | 5 | 是 |
| 封印判决 seal.decisions | 16 | 3 | 是 |

**工程窗口已凑齐**：可以核对四项判据；自然用户效果与 L3 长期门槛仍单独判断。

## 四项判决（TF-0136）

仅从本现场提出判断与下一步，不自动修改卡片、谓词或森林状态。

### 判决一：恢复卡：本现场支持判据

保留现有恢复卡；工程场景中的消费不等于自然用户认可或耗时改善。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.lifecycle.resumeNotesConsumed / stats.lifecycle.restores | 0.43333333333333335 | ≥ 0.3 |
| stats.lifecycle.resumeActions | 25 | > 0 |

### 判决二：前提检测：本现场支持判据

现有检测满足本现场阈值，继续采样。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.noticeOutcomes.agent.delivered | 32 | > 0 |
| stats.noticeOutcomes.agent.dismissed / .delivered | 0 | ≤ 0.5 |
| stats.noticeOutcomes.agent.ignored / .delivered | 0 | ≤ 0.1 |
| stats.noticeOutcomes.agent.unknown | 0 | 保留为未知 |
| (stats.noticeOutcomes.agent.dismissed + .unknown) / .delivered | 0 | ≤ 0.5 才足以支持判据 |
| (stats.noticeOutcomes.agent.ignored + .unknown) / .delivered | 0 | ≤ 0.1 才足以支持判据 |

### 判决三：阶段 C：本现场支持判据

保留已完成的阶段 C；继续回归分叉继承、通知与封印。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.forks.total | 26 | ≥ 5 |
| events[thread.inheritance_observed]：agentContextInherited && premiseInherited，按 threadId 去重（TF-0125/0131） | 3 | ≥ 1 |

### 判决四：L3：证据不足

继续延后 L3 复评：TF-0099 / TF-0100 / TF-0101 已于 2026-09-09 废止（docs/tf0136-l3-cut-verdict.md），本判据只记录自然使用是否曾达门槛；工程开发照常推进。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.observation.days（仅时间跨度，来源须另行核对） | 0.6909755439814815 | 自然使用且 ≥ 14 天 |
| stats.forks.total / (stats.observation.days / 7) | 无样本 | ≥ 1 |
| stats.siblingAlternation.alternatingFamilies / .families（全部根家族为分母，TF-0122） | 0.07692307692307693 | ≥ 0.3 |
| events[thread.resume_action]：resume_fact_opened / resume_branch_opened（TF-0129/0151） | 无样本 | ≥ 1 / 周；dismiss 与叙事展开不计事实消费 |

## 恢复到首条消息（TF-0126，近 7 天）

| 恢复时卡片 | 有效样本 | 中位耗时（ms） |
| --- | --- | --- |
| 可见 | 12 | 2159.5 |
| 不可见 | 17 | 6 |
| 未记录 | 0 | 无样本 |

未配对恢复：1。来源：`stats.lifecycle.restoreToMessage`；恢复事件与当次加载后的第一条用户消息配对，切走即结束。

中位耗时差异：35891.7%；超过 20%：是。这是观察值，不证明卡片导致变化，不自动改变卡片或节点状态。

## 地标集合认可（L1）

当前地标 46 个，已复核 45 个，认可 34 个，不认可 11 个。

完整集合认可率 73.9%；复核覆盖率 97.8%。

来源：`stats.landmarkReviews.current`。分母包含未复核地标；每个写者的每个条目只取最新结论，重复反馈不累加成认可率。

本现场来源为「真实模型执行，手势与场景由脚本安排」：复核手势由脚本或模型运行安排，读数只会收敛到脚本里的认可概率，不构成用户认可。TF-0154 行的 fit 因此停在 `unknown`；上面的数字只用于核对通道与覆盖率。

## 护城河四个数字（样本齐备后回看）

| | 数字 | 门槛 | 当前 | 齐备 | 来源 |
| --- | --- | --- | --- | --- | --- |
| A | 校准表行数 | ≥ 50 | 70 | 是 | `stats.noticeOutcomes.rows` |
| B | 推定写者是 git 或人的失效通知 | ≥ 1 条 | 1 | 是 | `events[premise_stale] ⋈ sessions/<writer>.kind` |
| C | 来自真实会话的 seal.decided: block | ≥ 1 次（且事后判定为正确封印） | 14 | 是 | `stats.seal.blocked + stats.seal.reviews.correct` |
| D | notified / overlaps | 有真实值且落在 10-30% | 0.127 | 是 | `stats.premises.notifiedRatio` |

**数字闸门开：** 四个数字齐备，可以整理与本现场来源相符的 stale-premise benchmark；工程记录不能据此声称自然用户效果。

> 近 7 天窗口读数：notified/overlaps = 12.7%（849 次重叠 / 39 轮）。聚合比值随空闲重查的 dedup 累积自然衰减，窗口读数反映当前谓词健康度；聚合口径与 band 判定不变。

## fit 分布

计入 fit 的节点 27 个（里程碑不计，deprecated 不入账也不进分母）：

- aligned 3 · partial 15 · weak 0 · misaligned 0 · **unknown 9**

## 逐节点

| 节点 | 类型 | 状态 | fit | 可观测指标（authored） | 当前值（measured） | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| TF-0120 Fable 5.1 前提守护收敛：交互 / 会话树 / 并发统一 | 里程碑 | in_progress | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0121 阶段 A：证据与架构地基 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0122 stats fold：分叉 / 切换 / 恢复基线 | 部件 | done | `partial` | 基线可读：分叉 + 切换 + 恢复的合计次数 | 86 | 实测 86，来源 stats.forks.total / stats.lifecycle.switches / .restores |
| TF-0123 稳定事件身份与因果时钟 | 部件 | done | `partial` | 带稳定身份（id + eventSeq）的事件条数 | 1255 | 实测 1255，来源 events[].id / events[].eventSeq |
| TF-0124 会话生命周期事件与投影边界 | 部件 | done | `partial` | 会话生命周期事件条数（这些必须不进世界投影） | 189 | 实测 189，来源 events[type^=thread.] |
| TF-0125 fork 继承事实拆分：transcript / agent context / premise | 部件 | done | `partial` | 落定过三种继承事实的分叉数 | 25 | 实测 25，来源 events[thread.inheritance_observed] |
| TF-0138 ADR：前提守护架构与产品边界 | 决策/实验/修复 | done | `unknown` | 架构边界是否被后续评审引用 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/decisions/0010-premise-custody.md（已接受） |
| TF-0139 会话观测埋点：switch / restored / 恢复事实消费 | 部件 | done | `partial` | 会话观测埋点合计（切换 + 恢复 + 笔记消费 + 恢复动作） | 98 | 实测 98，来源 stats.lifecycle.* |
| TF-0140 Claude 上下文继承三问实验（10 分钟，成败皆 done） | 决策/实验/修复 | done | `unknown` | 实验结论是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/report-2026-09-05-claude-fork-inheritance.md；已定形 TF-0131 并修订 ADR-0010 §5 |
| TF-0142 通知通道语义与测试 | 部件 | done | `unknown` | 被显式标成不可观测的通道数（HTTP 无工具通道） | 0 | insufficient-history：stats.noticeOutcomes.agent.unknownBy.unobservable 无样本 |
| TF-0143 足迹追加写路径预算与基准 | 部件 | done | `partial` | 有足迹的线程数（写路径预算的分母） | 39 | 实测 39，来源 stats.threads.withFootprints |
| TF-0144 提交闸门：已实现的前提守护代码落库并对齐森林状态 | 决策/实验/修复 | done | `unknown` | 提交闸门是否真的挡住了『代码领先森林』 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：git log（TF-0144 之后的落库批次） |
| TF-0145 contextgen 世界事件载荷上限 | 部件 | done | `partial` | 进过世界投影的世界事件条数（截断行未单独计数，指标偏弱） | 1066 | 实测 1066，来源 events[!thread.*] |
| TF-0148 通知结局标注（护城河 A 的数据源） | 部件 | done | `aligned` | 校准表行数（护城河 A） | 70 | 实测 70，来源 stats.noticeOutcomes.rows |
| TF-0149 三层谓词逐层计数 | 部件 | done | `aligned` | notified / overlaps（护城河 D，目标区间 10-30%） | 0.127 | 实测 0.127，来源 stats.premises.notifiedRatio |
| TF-0150 git 作为写者：merge / rebase / checkout 后注册变更 | 部件 | done | `partial` | 推定写者是 git 或人的失效通知条数（护城河 B） | 1 | 实测 1，来源 events[premise_stale] ⋈ sessions/<writer>.kind |
| TF-0153 修掉 CLI 黑板根定位缺陷：每条子命令都在读一个影子黑板 | 决策/实验/修复 | done | `unknown` | 影子黑板缺陷是否复发 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：提交 b292dc4 |
| TF-0126 阶段 B：恢复处境（R2′ + 恢复卡） | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0127 恢复时读集 diff（R2′） | 部件 | done | `partial` | 带读集 diff 的恢复次数 | 30 | 实测 30，来源 stats.lifecycle.restores |
| TF-0128 双通道恢复卡：叙事 + 事实 + 证据 | 部件 | done | `partial` | 恢复卡被真正消费的次数（笔记 + 恢复动作） | 38 | 实测 38，来源 stats.lifecycle.resumeNotesConsumed / .resumeActions |
| TF-0129 恢复覆盖率行与指标 | 部件 | done | `aligned` | 足迹覆盖率（恢复卡事实段的分母） | 0.7358490566037735 | 实测 0.7358490566037735，来源 stats.threads.footprintCoverage |
| TF-0151 恢复卡规则 R10：兄弟分支在你离开后改了什么 | 部件 | done | `partial` | R10 分支行是否被恢复卡消费（查看分支手势） | 11 | 实测 11，来源 events[thread.resume_action].payload.action = resume_branch_opened |
| TF-0130 阶段 C：分支与并发收敛 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0131 分支读集继承与诚实开关 | 部件 | done | `partial` | 写出 inherited 读集的分叉数 | 4 | 实测 4，来源 events[footprint.inherited] |
| TF-0133 通知预算：每轮一束 + 家族折叠 | 部件 | done | `partial` | 实际交付的通知束数（预算与折叠正确性另由契约测试验证） | 32 | 实测 32，来源 events[premise_notice_delivered]；不以 queued 充当 delivered |
| TF-0134 封印观测与降级模式 | 部件 | done | `partial` | 封印决策次数（护城河 C 的分母） | 16 | 实测 16，来源 stats.seal.decisions |
| TF-0135 阶段 D：fit 门与范围仲裁 | 里程碑 | in_progress | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0136 两周真实使用门与 L3 证据门 | 决策/实验/修复 | in_progress | `unknown` | 四项判决是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/tf0136-verdict.md；scripts/fit-ledger/verdicts.ts（四项判据；L3 延后） |
| TF-0137 fit 账本与砍留决策 | 决策/实验/修复 | in_progress | `unknown` | 账本是否被引用于一次真实砍留决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/fit-ledger.md；判决归 TF-0136，账本只提供行与来源 |
| TF-0141 日用起点 t0 登记与两周观察窗口 | 部件 | done | `partial` | t0 是否已登记：真实线程数（判据的一半，另一半是注册写者） | 53 | 实测 53，来源 stats.threads.total × sessions/* |
| TF-0154 地标认可反馈：L1 验收的事件通道 | 部件 | done | `unknown` | L1 认可率：已认可地标 / 全部当前地标，按写者隔离并取最新复核；≥0.8 为 aligned | 0.7391304347826086 | 来源 live-model 不是自然使用：实测 0.7391304347826086 只反映脚本或模型运行安排的复核手势，不构成用户认可，fit 停在 unknown；来源 stats.landmarkReviews.current.endorsedShare（完整集合；reviewedCoverage 单列） |
| TF-0155 真实模型执行闭环与无空会话阻塞验证 | 决策/实验/修复 | done | `unknown` | 真实模型执行、复读恢复与持久分叉验证是否可复跑 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/report-2026-09-07-live-model.md；docs/live-model-evidence-2026-09-07.json |


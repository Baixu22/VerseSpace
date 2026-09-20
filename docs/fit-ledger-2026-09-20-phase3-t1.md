# fit 账本（TF-0137）

> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，
> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。

- 生成时间：2026-09-20T12:28:29.172Z
- 数据源黑板：`D:\helmor-main\.workbench`
- 样本来源（运行者声明）：真实模型执行，手势与场景由脚本安排。该声明不筛选或认证事件，混合现场须单独核对。
- 事件跨度：20.8 天（2026-08-30T08:28:54.895Z → 2026-09-20T04:20:42.395Z）。工程窗口不以日历设门；L3 自然使用仍要求至少 14 天。

两条纪律（词表与证据）：

1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。
2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。

一条叙事纪律（issue #13）：**`unknown` 不得在对外材料中被表述为 `validated` 或已验证**。
它既不是「通过」也不是「失败」，而是「这行还没有可引用的证据」。结构性 unknown 用记录回答
（见各行的复核指路），证据缺口 unknown 用补样本或换来源回答——两者都不是「已验证」。
下表的 fit 列把两种 unknown 分开标注，就是为了挡住这个误读。

同一个词表，两种问法，别混：

- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。
- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。

共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。
所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。

## t0（现场采样起点，TF-0141）

**已开始**：实测 29 条线程、29 个注册写者，部件行按该现场来源计入 fit。

## 样本窗口（TF-0141）

| 样本类别 | 实测 | 目标 | 齐 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 171 | 3 | 是 |
| 通知结局 noticeOutcomes.rows | 46 | 5 | 是 |
| 封印判决 seal.decisions | 0 | 3 | **否** |

**窗口未凑齐**：还差 sealDecisions 0/3。凑齐之前结论一律 `unknown`，不以测试或日历替代。

## 四项判决（TF-0136）

仅从本现场提出判断与下一步，不自动修改卡片、谓词或森林状态。

### 判决一：恢复卡：证据不足

保留现状，复核恢复与消费记录；达到使用证据要求后再判断是否缩为纯事实行。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.lifecycle.resumeNotesConsumed / stats.lifecycle.restores | 0 | ≥ 0.3 |
| stats.lifecycle.resumeActions | 32 | > 0 |

### 判决二：前提检测：证据不足

补通知后的可观测活动；unknown 不能当作未忽略或未驳回。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.noticeOutcomes.agent.delivered | 14 | > 0 |
| stats.noticeOutcomes.agent.dismissed / .delivered | 0.07142857142857142 | ≤ 0.5 |
| stats.noticeOutcomes.agent.ignored / .delivered | 0 | ≤ 0.1 |
| stats.noticeOutcomes.agent.unknown | 12 | 保留为未知 |
| (stats.noticeOutcomes.agent.dismissed + .unknown) / .delivered | 0.9285714285714286 | ≤ 0.5 才足以支持判据 |
| (stats.noticeOutcomes.agent.ignored + .unknown) / .delivered | 0.8571428571428571 | ≤ 0.1 才足以支持判据 |

### 判决三：阶段 C：证据不足

阶段 C 已完成；本现场尚不足以重复支持范围判据，继续补分叉与真实继承观测。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.forks.total | 24 | ≥ 5 |
| events[thread.inheritance_observed]：agentContextInherited && premiseInherited，按 threadId 去重（TF-0125/0131） | 15 | ≥ 1 |

### 判决四：L3：证据不足

继续延后 L3 复评：TF-0099 / TF-0100 / TF-0101 已于 2026-09-09 废止（docs/tf0136-l3-cut-verdict.md），本判据只记录自然使用是否曾达门槛；工程开发照常推进。

| 来源 | 实测 | 判据 |
| --- | --- | --- |
| stats.observation.days（仅时间跨度，来源须另行核对） | 20.827633101851852 | 自然使用且 ≥ 14 天 |
| stats.forks.total / (stats.observation.days / 7) | 8.066207003860779 | ≥ 1 |
| stats.siblingAlternation.alternatingFamilies / .families（全部根家族为分母，TF-0122） | 无样本 | ≥ 0.3 |
| events[thread.resume_action]：resume_fact_opened / resume_branch_opened（TF-0129/0151） | 6.049655252895584 | ≥ 1 / 周；dismiss 与叙事展开不计事实消费 |

## 恢复到首条消息（TF-0126，近 7 天）

| 恢复时卡片 | 有效样本 | 中位耗时（ms） |
| --- | --- | --- |
| 可见 | 15 | 296457 |
| 不可见 | 1 | 214 |
| 未记录 | 0 | 无样本 |

未配对恢复：31。来源：`stats.lifecycle.restoreToMessage`；恢复事件与当次加载后的第一条用户消息配对，切走即结束。

中位耗时差异：138431.3%；超过 20%：是。这是观察值，不证明卡片导致变化，不自动改变卡片或节点状态。

## 地标集合认可（L1）

- **新口径 `session-top-k`**（每会话文件级 top-3，叠加种类门 + 「只认可落笔」过滤，requireEdits true）：当前候选 41 个，已复核 0 个，认可 0 个，不认可 0 个。
  - 完整集合认可率 0.0%；复核覆盖率 0.0%。
- **旧口径 `threshold`**（DOI>10 的文件级集合，历史可比）：当前地标 0 个，已复核 0 个，认可 0 个 → 认可率 无样本（分母为空 → 不可计算），复核覆盖 无样本（分母为空 → 不可计算）。
- **未过滤对照 `requireEdits: false`**（翻默认前的旧定义）：当前候选 50 个，已复核 0 个，认可 0 个 → 认可率 0.0%。与第一条的差距即被过滤的纯浏览噪声（2026-09-11 翻默认，对照并报一个周期）。
- 相对选择的可计量性：有文件级触碰的会话 22 个，其中排得出非空 top-3 的 22 个（覆盖 100.0%，条目 50 条，去重 handle 32 个）。
- 种类门排除 git/human 写者 0 个（记录的是「文件被动过」，不是「这次干的活是什么」）。
- 代理自审口径（真实数据，但**不构成用户认可**）：候选 41 个，已复核 0 个，认可率 0.0%。
- 结论连续性：落在当前集合之外的旧结论 0 条记为 legacy——**保留、不改判**；口径漂移不是数据丢失。

**为什么有两把尺子**：旧口径要求「同一条 handle 在衰减窗口内被推过 10 分」，而真实形状是很多文件各被碰一两次（权重 1–2），跨四个现场实测门后有**三个直接是空集**——分母空了，判据不是 0 分而是**不可计算**。新口径是**换定义**，不是修 bug；双读数期两条并排，满一个周期后再撤旧的那条。

来源：`stats.landmarkReviews.current`（新，含只认可落笔过滤）/ `.threshold`（旧阈值）/ `.unfiltered`（未过滤对照）/ `.coverage`。分母包含未复核条目；每个写者的每个条目只取最新结论，重复反馈不累加成认可率。

## 护城河四个数字（样本齐备后回看）

| | 数字 | 门槛 | 当前 | 齐备 | 来源 |
| --- | --- | --- | --- | --- | --- |
| A | 校准表行数 | ≥ 50 | 46 | **否** | `stats.noticeOutcomes.rows` |
| B | 推定写者是 git 或人的失效通知 | ≥ 1 条 | 0 | **否** | `events[premise_stale] ⋈ sessions/<writer>.kind` |
| C | 来自真实会话的 seal.decided: block | ≥ 1 次（且事后判定为正确封印） | 0 | **否** | `stats.seal.blocked + stats.seal.reviews.correct` |
| D | notified / overlaps | 有真实值且落在 10-30% | 0.003 | **否** | `stats.premises.notifiedRatio` |

**闸门关：** 缺 A 校准表行数、B 推定写者是 git 或人的失效通知、C 来自真实会话的 seal.decided: block、D notified / overlaps。缺任何一个先补它，不扩树。

> 近 7 天窗口读数：notified/overlaps = 0.3%（88252 次重叠 / 3516 轮）。聚合比值随空闲重查的 dedup 累积自然衰减，窗口读数反映当前谓词健康度；聚合口径与 band 判定不变。

## fit 分布

计入 fit 的节点 36 个（里程碑不计，deprecated 不入账也不进分母）：

- aligned 1 · partial 15 · weak 0 · misaligned 0 · **unknown 20**

## 逐节点

| 节点 | 类型 | 状态 | fit | 可观测指标（authored） | 当前值（measured） | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| TF-0120 Fable 5.1 前提守护收敛：交互 / 会话树 / 并发统一 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0121 阶段 A：证据与架构地基 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0122 stats fold：分叉 / 切换 / 恢复基线 | 部件 | done | `partial` | 基线可读：分叉 + 切换 + 恢复的合计次数 | 337 | 实测 337，来源 stats.forks.total / stats.lifecycle.switches / .restores |
| TF-0123 稳定事件身份与因果时钟 | 部件 | done | `partial` | 带稳定身份（id + eventSeq）的事件条数 | 4841 | 实测 4841，来源 events[].id / events[].eventSeq |
| TF-0124 会话生命周期事件与投影边界 | 部件 | done | `partial` | 会话生命周期事件条数（这些必须不进世界投影） | 465 | 实测 465，来源 events[type^=thread.] |
| TF-0125 fork 继承事实拆分：transcript / agent context / premise | 部件 | done | `partial` | 落定过三种继承事实的分叉数 | 20 | 实测 20，来源 events[thread.inheritance_observed] |
| TF-0138 ADR：前提守护架构与产品边界 | 决策/实验/修复 | done | `unknown`（结构性） | 架构边界是否被后续评审引用 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/decisions/0010-premise-custody.md（已接受） |
| TF-0174 ADR-0012：GUI 写端点准入复核与事实订正 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0139 会话观测埋点：switch / restored / 恢复事实消费 | 部件 | done | `partial` | 会话观测埋点合计（切换 + 恢复 + 笔记消费 + 恢复动作） | 345 | 实测 345，来源 stats.lifecycle.* |
| TF-0140 Claude 上下文继承三问实验（10 分钟，成败皆 done） | 决策/实验/修复 | done | `unknown`（结构性） | 实验结论是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/report-2026-09-05-claude-fork-inheritance.md；已定形 TF-0131 并修订 ADR-0010 §5 |
| TF-0142 通知通道语义与测试 | 部件 | done | `unknown`（证据缺口） | 被显式标成不可观测的通道数（HTTP 无工具通道） | 0 | insufficient-history：stats.noticeOutcomes.agent.unknownBy.unobservable 无样本；处置：fixture 通道语义测试验证 unknownBy.unobservable 计数路径活着；不在 live 现场造样本 |
| TF-0143 足迹追加写路径预算与基准 | 部件 | done | `partial` | 有足迹的线程数（写路径预算的分母） | 22 | 实测 22，来源 stats.threads.withFootprints |
| TF-0144 提交闸门：已实现的前提守护代码落库并对齐森林状态 | 决策/实验/修复 | done | `unknown`（结构性） | 提交闸门是否真的挡住了『代码领先森林』 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：git log（TF-0144 之后的落库批次） |
| TF-0169 check-landing 子命令：把「done ≠ 已落库」的人肉纪律变成可跑的对账 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0145 contextgen 世界事件载荷上限 | 部件 | done | `partial` | 进过世界投影的世界事件条数（截断行未单独计数，指标偏弱） | 4376 | 实测 4376，来源 events[!thread.*] |
| TF-0147 裁决：task-forest 历史与派生产物的体量口径（events / snapshots / exports） | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0152 task-forest 引擎侧修正：历史载荷与派生分母 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0165 把「事件不内嵌全图」的载荷修复补到当前生效的 skill 副本上，并定下唯一权威副本 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0166 把 graph/forest.json 出仓：它是只写不读的派生副本，跟踪它让每次导出都弄脏工作区 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0168 导出 HTML 声明投影边界：未纳入的未完成项不再被隐瞒 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0148 通知结局标注（护城河 A 的数据源） | 部件 | done | `partial` | 校准表行数（护城河 A） | 46 | 实测 46，来源 stats.noticeOutcomes.rows |
| TF-0149 三层谓词逐层计数 | 部件 | done | `partial` | notified / overlaps（护城河 D，目标区间 10-30%） | 0.003 | 实测 0.003，来源 stats.premises.notifiedRatio |
| TF-0150 git 作为写者：merge / rebase / checkout 后注册变更 | 部件 | done | `unknown`（证据缺口） | 推定写者是 git 或人的失效通知条数（护城河 B） | 0 | insufficient-history：events[premise_stale] ⋈ sessions/<writer>.kind 无样本 |
| TF-0153 修掉 CLI 黑板根定位缺陷：每条子命令都在读一个影子黑板 | 决策/实验/修复 | done | `unknown`（结构性） | 影子黑板缺陷是否复发 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：提交 b292dc4 |
| TF-0126 阶段 B：恢复处境（R2′ + 恢复卡） | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0127 恢复时读集 diff（R2′） | 部件 | done | `partial` | 带读集 diff 的恢复次数 | 171 | 实测 171，来源 stats.lifecycle.restores |
| TF-0128 双通道恢复卡：叙事 + 事实 + 证据 | 部件 | done | `partial` | 恢复卡被真正消费的次数（笔记 + 恢复动作） | 32 | 实测 32，来源 stats.lifecycle.resumeNotesConsumed / .resumeActions |
| TF-0129 恢复覆盖率行与指标 | 部件 | done | `aligned` | 足迹覆盖率（恢复卡事实段的分母） | 0.7586206896551724 | 实测 0.7586206896551724，来源 stats.threads.footprintCoverage |
| TF-0151 恢复卡规则 R10：兄弟分支在你离开后改了什么 | 部件 | done | `partial` | R10 分支行是否被恢复卡消费（查看分支手势） | 6 | 实测 6，来源 events[thread.resume_action].payload.action = resume_branch_opened |
| TF-0130 阶段 C：分支与并发收敛 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0131 分支读集继承与诚实开关 | 部件 | done | `partial` | 写出 inherited 读集的分叉数 | 15 | 实测 15，来源 events[footprint.inherited] |
| TF-0133 通知预算：每轮一束 + 家族折叠 | 部件 | done | `partial` | 实际交付的通知束数（预算与折叠正确性另由契约测试验证） | 14 | 实测 14，来源 events[premise_notice_delivered]；不以 queued 充当 delivered |
| TF-0134 封印观测与降级模式 | 部件 | done | `unknown`（证据缺口） | 封印决策次数（护城河 C 的分母） | 0 | insufficient-history：stats.seal.decisions 无样本 |
| TF-0135 阶段 D：fit 门与范围仲裁 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0136 两周真实使用门与 L3 证据门 | 决策/实验/修复 | done | `unknown`（结构性） | 四项判决是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/tf0136-verdict.md；scripts/fit-ledger/verdicts.ts（四项判据；L3 延后） |
| TF-0137 fit 账本与砍留决策 | 决策/实验/修复 | done | `unknown`（结构性） | 账本是否被引用于一次真实砍留决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/fit-ledger.md；判决归 TF-0136，账本只提供行与来源 |
| TF-0141 日用起点 t0 登记与两周观察窗口 | 部件 | done | `partial` | t0 是否已登记：真实线程数（判据的一半，另一半是注册写者） | 29 | 实测 29，来源 stats.threads.total × sessions/* |
| TF-0154 地标认可反馈：L1 验收的事件通道 | 部件 | done | `unknown`（证据缺口） | L1 认可率（新口径 session-top-k）：已认可候选 / 全部当前候选，按写者隔离并取最新复核；≥0.8 为 aligned | 0 | insufficient-history：stats.landmarkReviews.current.endorsedShare（每会话文件级 top-K + 种类门；reviewedCoverage 与 legacyReviews 单列；旧口径 .threshold 并报一个周期） 无样本；处置：依赖 issue #12 的 J3 条件②（真实使用者参与复核）；不靠多跑脚本拉读数（TF-0167 §F5 已否决受控实验路线） |
| TF-0160 代理自审（steward）口径：无人环境下的地标复核来源与读数链路 | 部件 | done | `unknown`（证据缺口） | 代理自审认可率（steward）：无真人时由 agent 按证据复核地标，≥0.8 表示「投影选出来的核心」与证据一致 | 0 | insufficient-history：stats.landmarkReviews.steward.endorsedShare；与 TF-0154 的 human 口径**分开报**，不构成用户认可 无样本 |
| TF-0161 修地标投影：让「这次干活的核心」真的进集合，且不误杀真实重复编辑 | 未开工/缺指标 | done | `unknown` | 尚未指定可观测指标 | 无样本 | 已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论 |
| TF-0155 真实模型执行闭环与无空会话阻塞验证 | 决策/实验/修复 | done | `unknown`（结构性） | 真实模型执行、复读恢复与持久分叉验证是否可复跑 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/report-2026-09-07-live-model.md；docs/live-model-evidence-2026-09-07.json |


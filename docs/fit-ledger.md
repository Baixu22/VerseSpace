# fit 账本（TF-0137）

> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，
> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。

- 生成时间：2026-09-06T10:14:21.478Z
- 数据源黑板：`D:\helmor-main\.workbench`
- 事件跨度：0.0 天（2026-08-30T08:28:54.895Z → 2026-08-30T08:31:38.740Z）。跨度只是信息项，不做门槛。

两条纪律（词表与证据）：

1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。
2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。

同一个词表，两种问法，别混：

- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。
- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。

共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。
所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。

## t0（日用起点，TF-0141）

**未开始**：实测 0 条线程、0 个注册写者。t0 之前 `events.jsonl` 里是自举期数据，所有部件行强制停在 `unknown`——下面的「当前值」照常显示，但不推动 fit。

## 样本窗口（TF-0141）

| 样本类别 | 实测 | 目标 | 齐 |
| --- | --- | --- | --- |
| 恢复周期 lifecycle.restores | 0 | 3 | **否** |
| 通知结局 noticeOutcomes.rows | 0 | 5 | **否** |
| 封印判决 seal.decisions | 0 | 3 | **否** |

**窗口未凑齐**：还差 restores 0/3、noticeOutcomes 0/5、sealDecisions 0/3。凑齐之前结论一律 `unknown`，不以测试或日历替代。

## 数据质量：insufficient-history

- no threads
- no thread footprints
- no restore cycle observed
- no thread.switch observations

## 护城河四个数字（样本齐备后回看）

| | 数字 | 门槛 | 当前 | 齐备 | 来源 |
| --- | --- | --- | --- | --- | --- |
| A | 校准表行数 | ≥ 50 | 0 | **否** | `stats.noticeOutcomes.rows` |
| B | 推定写者是 git 或人的失效通知 | ≥ 1 条 | 0 | **否** | `events[premise_stale] ⋈ sessions/<writer>.kind` |
| C | 来自真实会话的 seal.decided: block | ≥ 1 次（且事后判定为正确封印） | 0 | **否** | `stats.seal.blocked` |
| D | notified / overlaps | 有真实值且落在 10-30% | 无样本 | **否** | `stats.premises.notifiedRatio` |

**闸门关：** 缺 A 校准表行数、B 推定写者是 git 或人的失效通知、C 来自真实会话的 seal.decided: block、D notified / overlaps。缺任何一个先补它，不扩树。

## fit 分布

计入 fit 的节点 25 个（里程碑不计，deprecated 不入账也不进分母）：

- aligned 0 · partial 0 · weak 0 · misaligned 0 · **unknown 25**

## 逐节点

| 节点 | 类型 | 状态 | fit | 可观测指标（authored） | 当前值（measured） | 依据 |
| --- | --- | --- | --- | --- | --- | --- |
| TF-0120 Fable 5.1 前提守护收敛：交互 / 会话树 / 并发统一 | 里程碑 | in_progress | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0121 阶段 A：证据与架构地基 | 里程碑 | done | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0122 stats fold：分叉 / 切换 / 恢复基线 | 部件 | done | `unknown` | 基线可读：分叉 + 切换 + 恢复的合计次数 | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0123 稳定事件身份与因果时钟 | 部件 | done | `unknown` | 带稳定身份（id + eventSeq）的事件条数 | 15 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0124 会话生命周期事件与投影边界 | 部件 | done | `unknown` | 会话生命周期事件条数（这些必须不进世界投影） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0125 fork 继承事实拆分：transcript / agent context / premise | 部件 | done | `unknown` | 落定过三种继承事实的分叉数 | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0138 ADR：前提守护架构与产品边界 | 决策/实验/修复 | done | `unknown` | 架构边界是否被后续评审引用 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/decisions/0010-premise-custody.md（提案，待评审） |
| TF-0139 会话观测埋点：switch / restored / 恢复事实消费 | 部件 | done | `unknown` | 会话观测埋点合计（切换 + 恢复 + 笔记消费 + 恢复动作） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0140 Claude 上下文继承三问实验（10 分钟，成败皆 done） | 决策/实验/修复 | done | `unknown` | 实验结论是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/report-2026-09-05-claude-fork-inheritance.md；已定形 TF-0131 并修订 ADR-0010 §5 |
| TF-0142 通知通道语义与测试 | 部件 | done | `unknown` | 被显式标成不可观测的通道数（HTTP 无工具通道） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0143 足迹追加写路径预算与基准 | 部件 | done | `unknown` | 有足迹的线程数（写路径预算的分母） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0144 提交闸门：已实现的前提守护代码落库并对齐森林状态 | 决策/实验/修复 | done | `unknown` | 提交闸门是否真的挡住了『代码领先森林』 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：git log（TF-0144 之后的落库批次） |
| TF-0145 contextgen 世界事件载荷上限 | 部件 | done | `unknown` | 进过世界投影的世界事件条数（截断行未单独计数，指标偏弱） | 15 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0148 通知结局标注（护城河 A 的数据源） | 部件 | done | `unknown` | 校准表行数（护城河 A） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0149 三层谓词逐层计数 | 部件 | done | `unknown` | notified / overlaps（护城河 D，目标区间 10-30%） | 无样本 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0150 git 作为写者：merge / rebase / checkout 后注册变更 | 部件 | done | `unknown` | 推定写者是 git 或人的失效通知条数（护城河 B） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0153 修掉 CLI 黑板根定位缺陷：每条子命令都在读一个影子黑板 | 决策/实验/修复 | done | `unknown` | 影子黑板缺陷是否复发 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：提交 b292dc4 |
| TF-0126 阶段 B：恢复处境（R2′ + 恢复卡） | 里程碑 | in_progress | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0127 恢复时读集 diff（R2′） | 部件 | done | `unknown` | 带读集 diff 的恢复次数 | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0128 双通道恢复卡：叙事 + 事实 + 证据 | 部件 | done | `unknown` | 恢复卡被真正消费的次数（笔记 + 恢复动作） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0129 恢复覆盖率行与指标 | 部件 | done | `unknown` | 足迹覆盖率（恢复卡事实段的分母） | 无样本 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0151 恢复卡规则 R10：兄弟分支在你离开后改了什么 | 决策/实验/修复 | in_progress | `unknown` | R10 分支行是否被恢复卡消费（查看分支手势） | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：scripts/e2e/scenario.ts S6（R10 渲染断言）；docs/tf0136-verdict.md 判决一 |
| TF-0130 阶段 C：分支与并发收敛 | 里程碑 | proposed | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0131 分支读集继承与诚实开关 | 部件 | done | `unknown` | 写出 inherited 读集的分叉数 | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0133 通知预算：每轮一束 + 家族折叠 | 未开工/缺指标 | blocked | `unknown` | 尚未指定可观测指标 | 无样本 | 状态 blocked，尚未开工，没有可测行为 |
| TF-0134 封印观测与降级模式 | 部件 | done | `unknown` | 封印决策次数（护城河 C 的分母） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |
| TF-0135 阶段 D：fit 门与范围仲裁 | 里程碑 | proposed | `unknown` | 里程碑本身不是部件，fit 由其子节点上卷 | 无样本 | 里程碑不单独计 fit，避免把子节点的 unknown 重复计一次 |
| TF-0136 两周真实使用门与 L3 证据门 | 决策/实验/修复 | blocked | `unknown` | 四项判决是否改变了下游决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/tf0136-verdict.md（L3 砍、恢复卡保留、阶段 C 不延后、折叠不开工） |
| TF-0137 fit 账本与砍留决策 | 决策/实验/修复 | blocked | `unknown` | 账本是否被引用于一次真实砍留决策 | 无样本 | 决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown；复核指路：docs/fit-ledger.md；判决归 TF-0136，账本只提供行与来源 |
| TF-0141 日用起点 t0 登记与两周观察窗口 | 部件 | blocked | `unknown` | t0 是否已登记：真实线程数（判据的一半，另一半是注册写者） | 0 | t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本 |


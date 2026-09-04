# Fable 5.1 Briefing · Part 1 — 上下文、现状与约束(缓存核心包)

> 用途:作为喂给 Fable 5.1 的稳定前缀(可 prompt-cache)。Part 2(问题集)单独追加。
> 整理日期:2026-09-02,基于对仓库的全量审计(源码逐文件精读 + 任务森林 119 节点核对 + ADR/positioning 原文核对)。
> **证据等级标记**:【本机实测】= 仓库内脚本/测试可复现;【文献引用】= 引自论文,本机未复现;【设计意图】= 写在文档里但未实现或未验证。所有路径相对仓库根。

---

## 1. 产品是什么(30 秒)

**Workbench**(Helmor 的下一代架构):本地优先的 CLI + 文件系统状态管理器,管理 AI 辅助开发的"项目元结构"——目标 DAG、架构决策、接口契约、工位(git worktree)、checkpoint 验证、事件审计,以及**对话本身**。类比物是 git / turborepo(它们管理代码的元结构,我们管理 AI 协作的结构)。**不是 IDE、不是 agent、明确拒绝成为编排器**(positioning-v5:"产品必须可证明地不是编排器")。零数据库,状态全部是仓库内 `.workbench/` 的 YAML + JSONL,git 可追踪、人可直读;零重依赖红线(为拒绝 tree-sitter 曾记录偏差 TFD-386fc39351)。

包名 `@baixu22/workbench` v0.3.0;160 个 TS 源文件(56 个测试文件),约 14,700 行源码 + 9,000 行测试;全量 bun test 355 例(2026-09-02:354 过 / 1 挂,挂因见 §11)。另有冻结的 legacy Helmor(Tauri v2 桌面应用,ADR-0003 冻结为行为规格)和 `.agent-workbench/task-forest` 元层(自管理任务图,119 节点)。

## 2. 两条数据流(理解三支柱的底座)

**执行管线(代码层)**:goal(带验收断言与 CAS 版本)→ dispatch(CONWIP 令牌准入,WIP 由 Little 定律从事件日志实测推导)→ workspot(git worktree,`.agent-context.md` 由 contextgen 按 contextNeeds 编译)→ agent 产出 → checkpoint(staging/verified/failed 三区,含 `blackboardEffects` 写集声明位)→ verifier 裁决 → 接口注册表 contentHash/version CAS → 漂移传播。后台 watcher 每轮比对各写者读集,把失效前提写进事件日志(R2 接线,有测试)。

**会话管线(对话层)**:`chat/threads.ts` 每线程一个持久 claude CLI 子进程(stream-json 输入输出,`--session-id`/`--resume`,目录名即会话 id);每条 tool-call 抽取足迹(读集 `used` 带调用时哈希、写集 `generated` 带结果哈希,64KB 内容暂存供 diff);`runtime/premises.ts` 每轮比对读集发 `premise_stale`;`runtime/delivery.ts` 分桶投递;`threads.notifySession` 注回活会话(轮间注入,KV-cache 安全追加)或排队到下轮前。**注意**:曾计划用 `CLAUDE_CODE_MESSAGING_SOCKET`,实测 headless 不可用,整个换掉(偏差记录在案)。

**关键断层**:三条事件流彼此独立——blackboard events、interactions log、chat 的 messages.jsonl。fork/leave/restore **没有任何一等事件类型**(全仓库 0 处离散 fork 事件;只在图快照里有痕迹)。

## 3. 三支柱现状矩阵(核心)

| 支柱 | 已建(全为 done,有测试) | 未建 | 与竞品差异现状 |
| --- | --- | --- | --- |
| **交互**(L0–L3) | L0 线性默认;L1 隐式层(TF-0087–89:interactions 日志、Mylyn 式 DOI、landmark 投影);L2 加法式(TF-0094 扇出 generate-N-show-1、TF-0095 系统建议+安静决策账本、TF-0096 切换清场/停放) | L3 显式层(N=2 推导、对源轨迹重放 diff)整体 proposed;对话层与交互层"一次采集两处使用"只做了 DOI 一半 | L1/L2 是自研;对照 ADR-0008 的 35 年坟场论证(对话推断结构 90–99% 误报) |
| **会话树** | TF-0093 追溯式分叉(零仪式一次 POST;`meta.forkOf` 血统;`ForkDeclaration` 类型强制显式继承声明,字面量 `true` 编译期锁死);TF-0092 信号驱动直接晋升(B=3ms≪K,不建提议 UI);TF-0097 恢复笔记(离开时刻纯函数起草 3–5 拍:doing/decided/shifted/next + `leaveSignature`,返回时 `resumeDelta` 报"你不在时多了 N 条",UI 折叠条,确认不阻塞) | **合并回主线(merge-back):零代码零设计**;树形导航 UI(现为平铺+↳徽标+hover 血统);恢复笔记是启发式拼接(最后一条用户消息/分叉计数/最后 assistant 的 tool-call/建议首条),**不含"为什么放弃另一条"**;分叉线程 `freshAgentSession`——**与兄弟分支、与代码工位零耦合**(兄弟改了仓库,本分支毫不知情) | Claude Code 已上线 `/branch`、`/fork`、`--fork-session`(2026-09-02 核实),fork 本身不再是空白;空白收窄为 merge-back、树导航、血统/前提感知恢复(issue #32631 全规格仍开) |
| **并发** | R1 写者登记(thread 即 agent 写者;人肉编辑与外部 commit 也被 watcher 捕获);R2 读集失效(premises/delivery,三区判定);merge-guard TF-0079(`git merge-tree --write-tree` 零误报预测 + ConE 式写集重叠账本,30 分钟窗口、稀有作者过滤阈值 1);WIP TF-0083(L=λ×W 从事件日志推导,样本<3 时明说 `insufficient-history` 退回物理上限;CONWIP 全局令牌;`--force` 只留给人);接口注册表 contentHash 漂移 + version CAS(不匹配抛 `BlackboardConflictError`);ADR-0009 实测 B_goal=3ms/C_goal=12ms → 提议区间恒空 → 不建"要不要做X"UI,廉价可逆替代 | 对话层读集失效(R2′:恢复会话时 diff 读集,注入"你的 37 个前提有 4 个为假"——v5 §11.2 设计,未实现);写前触碰范围声明(`view.yaml` 停在 v4/v5 的"明确不做"清单;写集声明位置已留在 checkpoint 类型上但未接线);promote 的 commit/重复测试失败两个信号"由足迹侧喂入,本层只定义形状"——未接线;chat 层通知无队列/限速(tribunal 队列只管 workspot 写者) | CoAgent 实验支持建议式(1.4×)优于排他锁(1.04×)与乐观重试(0.93×)【文献引用】;ConE 生产验证便宜信号(26000 PR→3% 通知→70% 有用)【文献引用】 |

## 4. 决策约束红线(全部有出处,违反即方案否决)

| # | 约束 | 出处 |
| --- | --- | --- |
| R1 | 结构来自执行轨迹(tool calls/文件读写/测试/commit),绝不从对话文本推断结构 | ADR-0008;Shipman & Marshall "Formality Considered Harmful";35 年坟场(VKB/Aquanet/IBIS/Tinderbox 移除识别器/Ink & Switch) |
| R2 | 对话是输入面;执行是结构的来源;仓库是结构的裁判;**用户永远不画图** | ADR-0008 原话 |
| R3 | 单调性优先(CALM):先问操作是否根本不需要协调;完成/构建绿是非单调的,必须由 Verifier 在封印区裁决,agent 自称完成永远不可信 | ADR-0007;Hellerstein & Alvaro 2020 |
| R4 | 建议式并发,永不阻断、永不整体回滚:运行时通知,写者修补;拒绝排他所有权/文件租约/fail-closed 写拒绝/CRDT 合并 | ADR-0006(状态:提案,但 R1–R4 已按此实施) |
| R5 | 不建任何"要不要把它变成任务?"式提议 UI:B=3ms、C=12ms【本机实测】、K≥2s【文献】,提议区间恒空;替代 = 廉价可逆 | ADR-0009(已裁决) |
| R6 | 中位任务只有 2–4 轮(LMSYS 2.0 轮;Clio 典型 4 轮):**任何带每会话前置成本的结构,摊销分母≈0** | positioning-v6 C1;ADR-0008 |
| R7 | 加法式呈现,绝不破坏性替换用户已有内容;generate N show 1;账本无分歧时完全不渲染(不是空折叠条) | positioning-v6;Findlater & McGrenere |
| R8 | 恢复对话/恢复代码/两者都恢复,必须是三个明确标签的不同动作(ChatGPT 把删除版本箭头删掉的教训) | positioning-v6 C6 |
| R9 | 故往精度错,不往召回错(漏报下游自纠);**永远不要把沉默包装成安全保证** | ADR-0006 §8 红线 |
| R10 | 产品必须可证明地不是编排器;验证成本对付钱的人不可见(METR:开发者慢 19% 却自觉快 20%) | positioning-v5 §12;METR RCT【文献引用】 |
| R11 | 零重依赖;L0 线性对话是默认且不动它 | TFD-386fc39351;v6 C1 |
| R12 | 派生组件的拆除成本必须 ≤ 一次 undo ≤ K(所以绝不自动建 worktree,1.30s) | ADR-0009 硬预算 |

## 5. 实测数据清单(分证据等级,防止模型把引用当本机事实)

**本机实测**(`packages/workbench/scripts/measure-ask-costs.ts` 可复跑):
- 晋升(创建 goal,写一个 YAML)= 3ms;拆除 = 12ms;`git worktree remove` 重路径 = 1.30s
- `git merge-tree --write-tree --name-only` 热态 33ms(本仓库 2053 文件,git 2.51,Windows)
- R3 验收实测:裁决队列 0.75 条/小时(上限 6)、严重项 5.6%(上限 25%)、优先级分布接近 5/15/30/50
- 本地 FS 慢:删除 350–500ms/条(Windows);`git worktree add` 拒绝含斜杠分支名 `ws/<id>`(git 2.55.0.windows.3 本机 bug,阻断 dispatch,记为风险 TF-0117)

**文献引用(本机未复现,决策时需注明)**:
- CoAgent(arXiv:2606.15376,十竞争负载):2PL 悲观锁 1.04×/每轮死锁 0.81;OCC 全量重试 0.93×/token 1.83×;MTPO 建议式通知 1.4×/正确性差 ≤5%/token 1.15×;无协调并行通过率 13%
- ConE(arXiv:2101.06542,微软,234 仓库生产):故意不做推测式合并,文件重叠信号,26000 PR → 775 通知(3%),70% 有用,>90% 愿继续用;明确拒绝 ML("精度太低,误报太多会让工具无人使用")
- CALM(Hellerstein & Alvaro 2020):程序单调 ⟺ 存在免协调一致实现
- Mylyn DOI:地标识别 84.17%(L1 验收对照线)
- METR 2025 RCT:经验开发者 +AI 慢 19%,自觉快 20%
- LLM 语义合并与开发者一致率仅 55–59%(merge-guard 因此只做零误报预测)

## 6. 已知失败先例("别踩"清单)

1. **ChatGPT 对话分支**:做了但存不住、找不回、不能并行跑;删了版本箭头(C6 的由来)。
2. **Claude Code `/fork`/`--fork-session`**:互不相干的副本,无回归路径、无 merge-back;issue #32631(全规格:分支感知/命名检查点/带摘要合并回主线/分支间 diff)截至 2026-09-02 仍开。⚠️ 此为快习速变领域,分发本简报前应复查。
3. **对话推断结构的 35 年坟场**:VKB、Aquanet、IBIS、Tinderbox 移除识别器、Ink & Switch 自认不可靠;spec-mining 误报 90–99%。
4. **Nimbalyst(原 Crystal)**:"同一 prompt 多份隔离 worktree、对比留赢家"——空间复制,无时间分叉、无血统、无 merge-back。差异化在"过程"不在"结果"。
5. **本机踩坑**:messaging socket headless 不可用(已换 stream-json stdin);bun 默认测试超时撞慢 FS(改 60s);git worktree 斜杠分支名 Windows bug。

## 7. 成功定义(已有的验收纪律,新方案必须兼容)

- **L1 验收**(v6 §11):会话结束后系统能列出地标集合(DOI>10),≥80% 用户认同"这就是核心"(对照 Mylyn 84.17%);不要求用户批准任何东西。
- **L2 验收**:实测 B/C 算 p*,区间空则不建提议 UI(已被 ADR-0009 落实为"直接做 + 廉价撤销")。
- **L3 验收**:任一衍生产物能一键"对源轨迹重放并 diff";拒绝一个占位符不需审计整个产物。
- **整体证伪**(v6 原话):"给三个月内的日常工作记账——你有多少次真的想从一段对话里岔出去但因为成本放弃了?若每周 <1 次,L2/L3 都不该建,只建 L1。"
- **v5 证伪账本**:按周计数前提失效/通知/修补/救回四类事件,≥3 次/周才算命题成立。
- **树线候选验收**(内部讨论,未入正式文档):一周后回看树,不看代码只看树,能否想起当时为什么放弃另一条路。
- **元事实**:119 个任务节点中 117 个 `alignment.fit: unknown`(仅 TF-0001、TF-0080 aligned)——整个体系至今没有把"真实使用有没有用"纳入验收闭环,这是当前最大的结构性风险,也是本次咨询要解决的元问题之一。

## 8. 三个支柱的开放问题(问题空间)

**交互**:DOI 的信号面(IDE selection/edit)迁到 chat 语料(切换/停留/引用/复活/确认)后是否还成立?隐式→显式(L1→L3)的升级判据 N=2 推导具体是什么?交互日志与 blackboard 事件何时合并成一条流?

**会话树**:merge-back 的最小正确语义(引用/摘要/合并三级)?血统如何进入写者模型(兄弟分支互为并发写者)?树的清理学(死分支的 DOI 衰减/归档)是否违反"无分歧不可见"纪律?恢复笔记何时值得升级为真摘要(现在零模型调用的纯函数是刻意的)?

**并发**:R2′(恢复时读集 diff)与恢复笔记如何合成一个"回来时的处境"?写前触碰范围声明与 C1 的摊销矛盾是否在"分叉时刻"这个低频高信息点被解开?chat 层通知(fork 扇出会放大)何时需要 tribunal 式队列?advisory 通知对**人类复核者本人**的呈现形态(v5 只设计了二元保守门槛)?

## 9. 当前假设 H1–H6(供攻击,不是结论)

- **H1 分支间前提失效**:分叉时刻从继承前缀的已记录足迹(按会话存于 `sessions/<id>/`)为新分支**合成初始读集**;兄弟分支其后写盘,现有 R2 reconcile 循环原样生效——"分支 B 的前提(继承自父对话的前缀)已失效"。改动小、复用现有机制。
- **H2 恢复双通道**:resume note(叙事,离开时已生成)+ R2′ 读集 diff(仓库事实,返回时计算)合成一张恢复卡;事实与叙事冲突时事实优先并标注。
- **H3 DOI 做树的清理学**:低 DOI 分支自动降权/归档(可逆、廉价),避免树熵;归档不删除(试错记录本身是价值)。
- **H4 分叉时刻是唯一的零成本结构化时刻**:C1 禁止每会话前置成本,但 fork 是低频、高信息、用户主动的事件——`ForkDeclaration` 已存在,可携带从继承前缀足迹推导的 touch-scope(用户零输入),供并发层预比对。
- **H5 merge-back 最小语义**:不合并内容;把分支的恢复笔记 + 决策账本差异 + (若碰了代码)merge-guard 预测与接口版本变化,作为**一条系统消息**注回源线程;一次手势 + 改回即撤销。若分支触碰接口注册表条目,回注时附 CAS 校验结果。
- **H6 三支柱统一事件流**:fork/leave/restore/merge-back 升格为一等事件类型并入统一 append-only 流(现状:0 个离散 fork 事件),使"哪些分支的前提失效了""哪些分支的 DOI 在衰减"成为对同一条流的两个查询,而非三个子系统各自记账。

## 10. 外部参照(精选,均已人工核过一遍;未列者视为低置信)

CoAgent arXiv:2606.15376 · ConE arXiv:2101.06542 · CALM(Hellerstein & Alvaro, CACM 2020)· Mylyn DOI(Kersten & Murphy)· METR 2025 RCT · ISA-18.2 报警合理化(5/15/30/50 分布,R3 队列的纪律来源)· drum-buffer-rope/CONWIP(Goldratt)· Tree of Thoughts arXiv:2305.10601 与 LATS arXiv:2310.04406(推理时树搜索,与"持久决策树"本质不同:无血统、无仓库裁判、跑完即弃——可作对照,不建议照搬)· anthropics/claude-code issues #32631、#69712 · stravu/crystal → Nimbalyst。

## 11. 工程快照(2026-09-02,影响排期的事实)

- L2 收口(TF-0093–0098)+ TF-0097 恢复笔记已标 done,但 **1267 行改动未提交**;`server.test.ts:518` respawn 断言 3/3 稳定失败(600ms 固定等待 vs Windows 慢 FS 子进程回收,测试健壮性问题,非产品逻辑回归)。
- TF-0119(`@baixu22/workbench` npm 发布)被用户主动挂起为 in_progress。
- `.agent-workbench/task-forest/events.jsonl` 21.4MB(62 行,每行嵌入整图快照 ~370KB)——存储格式需瘦身。
- 待办池(20 proposed)里与三支柱直接相关的:TF-0099(L3 里程碑)、TF-0100(N=2 推导)、TF-0101(重放验证)、TF-0085(L0 要求);其余多为风险记录与基础设施。

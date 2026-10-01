**VerseSpace / Workbench：面向 AI 应用与 Agent 工程实习的技术价值调查**

调查日期：2026-09-30。代码基线：`68ebef5`；工作区已有 README 和图片改动。本次读取核心实现、设计决策、既有实验记录，并通过 AnySearch 检索论文、开源实现、官方文档和社区讨论；另行复跑检测基准与相关测试。没有修改产品代码、更新任务森林、重记声明账本或运行收费模型实验。

**结论：项目有足够具体的工程内容可谈，最适合的主题是编码 Agent 的上下文时效性与运行时可靠性。** 目前的证据不支持“原创并发算法”“已解决多 Agent 协作”或“已验证开发提效”。有价值的部分是：把既有并发与依赖失效思想，适配到可观测性有限、执行时间长、会话会中断的编码 Agent 中，并用代码和对照实验划清保证范围。

这是一份有针对性的横向调查，不是穷尽性查新、竞品运行评测或全仓质量审计。对外部产品的描述限于本次读取的文档和源码；论文数字属于其作者的实验，不是 Workbench 的成绩。不能由未搜到某项能力推导“其他项目都没有”。

| 判断维度 | 本次结论 | 依据 |
| --- | --- | --- |
| 算法或理论首创 | 没有充分依据 | OCC、依赖失效已有长期研究；CoAgent、Token Coherence、Planfence 与核心主题直接重合 |
| 系统组合与场景取舍 | 有辨识度 | 文件足迹、版本对账、通知、恢复卡与有限写前拦截形成了一条可解释的链路 |
| 面试中的工程深度 | 足够展开 | 可讨论可观测性、通知确认、故障恢复、误报漏报、真实通道实验和保证强弱 |
| 并发效率与产品价值 | 尚未证明 | 本次及既有门禁不能证明生产率收益；自然用户研究与非 Windows 执行验证已经退役 |

**先用一个具体问题解释项目，比先介绍所有模块更有效。**

下面是机制示例，不是本次运行过的真实模型案例：

| 时刻 | 发生什么 |
| --- | --- |
| T1 | Agent 读取 `api.ts`，根据旧参数或返回值约定规划 `handler.ts` 的改动 |
| T2 | 人、Git 更新或另一个 Agent 改变 `api.ts` 的约定 |
| T3 | 原 Agent 继续按旧约定修改 `handler.ts`；两个写者修改不同文件，可能没有文本合并冲突 |
| T4 | 集成或运行时才暴露不兼容，或者旧会话仍给出已经过时的判断 |

这里有三个不同问题：文件内容能否合并、记录过的读取是否过期、模型的计划是否仍然正确。Git 的文本合并回答第一个；Workbench 的读集对账为第二个提供证据；第三个仍需要模型重新判断以及程序验证。

Workbench 的实际链路是：捕获可识别的工具读写 → 记录路径、版本及可用的读取范围/快照 → 对照当前文件 → 产生带差异的失效提示 → 进入通知或恢复界面。见 [footprint.ts](../../packages/workbench/src/blackboard/footprint.ts)、[session-view.ts](../../packages/workbench/src/blackboard/session-view.ts)、[premises.ts](../../packages/workbench/src/runtime/premises.ts)、[delivery.ts](../../packages/workbench/src/runtime/delivery.ts)。

这个使用场景不需要同时运行十个 Agent：**一个 Agent 加一个人类编辑者，或者一个会话离开期间发生一次 Git 更新，就可能出现。** 因此，项目的可讨论价值不必依赖“并发越多越快”成立。

还必须把示例中的限制一起讲清：当前 [seal.ts](../../packages/workbench/src/runtime/seal.ts) 按写目标与失效路径的重叠来判定。`api.ts` 失效不等于写 `handler.ts` 会被拦截；项目没有构建完整的“某项输出依赖哪些输入”的语义图。上述跨文件例子可说明通知价值，不能用来宣传完整写保护。

**与开源项目和现有框架对照，哪些已经是常见能力。**

| 对照对象与可核对来源 | 已有能力 | 对 Workbench 的判断 |
| --- | --- | --- |
| [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) | 多会话、独立上下文、直接通信、任务协调；官方明确说明额外 token 和协调开销，同文件编辑及强依赖任务未必适合组队 | “启动多个 Agent、分任务、交换消息”不足以构成创新。Workbench 可以讨论它如何从文件证据产生定向失效提示，但不能据此宣称全面超过原生团队能力 |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | 任务看板、Agent 工作区与分支、终端、开发服务器、diff 评审与 PR 流程 | 面板、分支、多模型接入和评审入口已有大量重合。不要把这部分当主要差异。本次读取时其 README 已宣布 sunsetting，本文仅比较公开机制 |
| [Beads](https://github.com/steveyegge/beads) | 持久任务图、依赖与就绪判断、原子领取、项目记忆与压缩；当前 README 描述的是 Dolt 后端 | 任务 DAG 和结构化记忆并非稀缺。可区分“记得要做什么”和“当时依赖的代码是否变化”；也不能用旧版 JSONL 描述代替它当前的架构 |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | 消息、身份、可搜索历史、文件预约租约；明确称为 advisory reservations，并有可选 pre-commit guard | 不是所有竞品都等到 merge 才协调。它偏向提前声明写意图，Workbench 偏向记录已发生的读取再检测变化；这是不同取舍，不是独占问题 |
| [AgentFS](https://docs.turso.tech/agentfs/introduction) | copy-on-write 隔离、文件操作审计、可携带的 SQLite 状态；有 CLI 与 SDK 接入形态 | “为 Agent 建文件审计日志”已有直接替代。Workbench 可谈的是把足迹用于前提对账和恢复；覆盖率与隔离强度不能仅凭文档认定孰优 |
| [Mastra 的文件系统接口](https://github.com/mastra-ai/mastra/blob/dc4a243b639247af1c9a867dfbb28b4c6be12c3e/packages/core/src/workspace/filesystem/filesystem.ts) | `expectedMtime` 写入条件明确用于 optimistic concurrency control；接口说明不匹配时产生 `StaleFileError`，并定义可选审计能力 | “写前检查版本”也不是新发明。本次确认的是接口契约，没有运行它的具体后端。Workbench 额外可谈会话读集、通知与恢复，而不能把接口差异说成性能胜出 |
| [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence) | checkpointer 保存线程图状态，store 保存跨线程数据，支持会话连续性和故障恢复等用途 | 持久化、checkpoint 与 memory 都是成熟框架能力。恢复保存下来的状态，仍需要应用决定是否重新验证外部世界；Workbench 的场景重点在这一层 |
| [Context Surgeon](https://github.com/jackfruitsandwich/context-surgeon) 及其 [Show HN](https://news.ycombinator.com/item?id=47753430) | 通过代理给上下文块标识，允许 evict / replace / restore | 直接管理旧上下文是另一条路线。Workbench 追加新事实通知、保留历史，便于溯源和保持前缀稳定，但旧信息仍占空间，也仍需模型正确处理新旧冲突 |

不能继续使用旧定位稿中“对照过的产品都只在 merge 才知道”来做当前宣传。本次已经读到提前文件预约、条件写入、共享产物一致性协议和行动前依赖验证；这些能力不是同一种保证，但足以否定笼统的唯一性表述。

**论文与经典方法给出的定位更明确。**

| 工作 | 与项目的关系 | 可借鉴的讨论与证据边界 |
| --- | --- | --- |
| [Kung / Robinson，On Optimistic Methods for Concurrency Control](https://doi.org/10.1145/319566.319567)，1981 | 先执行、再验证读写冲突是经典方法 | 可以用来解释为什么长耗时 Agent 的整体重试很贵；不能将读取版本验证说成新的并发理论 |
| [Build Systems à la Carte](https://doi.org/10.1145/3236774)，2018；[作者资料](https://ndmitchell.com/) | 依赖追踪、变更失效和最小重建与“前提过期”有共同结构 | 构建系统通常有更明确的依赖与执行语义；Agent 的阅读只是语义依赖的代理信号，不能直接继承构建系统正确性 |
| [ConE](https://arxiv.org/abs/2101.06542v3)，2021 | 预先发现并发编辑，利用重叠与“平时很少同时改”的文件控制噪声；仓库设计已引用 | 作者报告在微软 234 个仓库评估 26,000 个 PR，775 条建议中超过 70% 被认为有用。这支持“便宜且低噪声的提示可能有用”，但不是 Workbench 的精度或收益数据 |
| [Why Do Multi-Agent LLM Systems Fail? / MAST](https://arxiv.org/abs/2503.13657v3)，2025 | 将失败分成系统设计、Agent 间失配、任务验证等类别 | v3 报告 1,600+ 轨迹、7 个框架、14 种失败模式。Workbench 只针对其中一部分风险，不能把所有协作失败都归因为陈旧读取 |
| [CooperBench](https://arxiv.org/abs/2601.13295v2)，2026 | 直接研究编码 Agent 的合作，而非只测单 Agent 解题 | 600 多个协作任务，作者报告共同工作时平均成功率比单个 Agent 承担两项工作低约 30%。这只适用于其测试设定，也不是“降低 30 个百分点”。能说明协作值得独立评估，不能证明并发一律无效 |
| [Token Coherence / agent-coherence](https://arxiv.org/abs/2603.15183v1)，2026 预印本 | 已把 MESI 的失效机制迁移到多 Agent 共享产物 | 使用 TLA+ 和仿真分析单写者安全、版本单调及陈旧界限。其 token 节省数字来自仿真；“Agent cache coherence”本身也不是本项目首创 |
| [CoAgent](https://arxiv.org/html/2606.15376v1)，2026 预印本 | 最接近的既有方案；仓库 [ADR-0006](../decisions/0006-advisory-concurrency-control.md) 已明确引用 | 核心同样是 runtime 通知、Agent 判断并选择性修补。论文还实现 MTPO 顺序、受控读值与补偿机制，并将工具完整中介、协议服从和自修复正确性列为假设。Workbench 不具备这些完整条件，不能继承其可串行化结论或约 1.4 倍加速结果 |
| [The Working Set of a Coding Agent](https://arxiv.org/abs/2608.16630v1)，2026 预印本 | 给读集方法提出重要反例：模型也会从参数记忆或推测中取得事实 | 作者在其设定下发现，读取行为不一定预测成功；没有读取记录不等于没有依赖，读过也不等于仍在上下文中或被正确使用。这限制了“读集=真实推理依赖”的说法 |
| [AgentRoom](https://arxiv.org/abs/2608.23740v1)，2026 预印本 | CRDT 共享工作区，加文件 claim / status / broadcast MCP 工具 | 提供另一种实际并发组织方式。其小规模任务实验与部分 LLM-judge 对照不能证明普遍优越；CRDT 的内容收敛也不自动证明程序语义正确 |
| [Fresh Memory, Stale Plans / Planfence](https://arxiv.org/abs/2609.03340v2)，2026-09-27 修订的预印本 | 最直接的近期相关工作：读到最新事实，计划仍可能由旧版本推导 | 计划保留精确输入链接，在受保护行动前验证依赖并有限重规划。作者报告 30 个受控 live 工作流；应用代码负责声明链接与范围。它既支持问题的现实意义，也说明仅通知“文件变了”比验证行动的推导来源弱 |

最后两类研究尤其值得用来反问自己的设计：**文件当前版本、会话已接收的事实、计划实际依赖的版本，是三个不同对象。** Workbench 记录了第一、第二层的部分证据，没有完整建立第三层。

CoAgent 是明确的思想来源，应该主动承认。更可信的讲法是：“我参考建议式并发控制，把范围收敛到本地编码工具的文件前提；为了兼容外部 CLI 和人类编辑，没有实现通用工具中介与补偿，因此只声明检测和有限拦截。”这比给既有机制换名字更经得起追问。

**社区讨论呈现的是场景分歧，不是统一结论。**

本次完整提取了 [Ask HN: Are you using an agent orchestrator to write code?](https://news.ycombinator.com/item?id=46993479) 和 [Context Surgeon 的 Show HN](https://news.ycombinator.com/item?id=47753430)。它们属于自选择样本与个人经验，不能拿评论票数或个人百分比当行业统计。

| 讨论中可核对的观点 | 对项目定位的启发 |
| --- | --- |
| [一位参与者](https://news.ycombinator.com/item?id=46999194)认为管理大量 Agent 与回溯错误的成本会吃掉并行收益 | 不用活跃 Agent 数或 token 消耗代替完成质量 |
| [另一位使用者](https://news.ycombinator.com/item?id=47021998)报告自己会在约 2–3 个 Agent 时成为评审瓶颈 | 人类注意力与验证吞吐也是资源；通知要让人能行动，不能只是增加一屏告警 |
| 同一讨论也有人使用多个会话处理研究、计划、编码、评审以及不同项目 | 并行不是全无价值；任务可分离程度与跨任务耦合影响收益，需要具体工作负载 |
| Context Surgeon 的作者直接描述旧工具结果长期留在上下文中的问题，评论者追问跨会话持久化 | “长会话中的事实时效性”有独立讨论价值；体积管理、事实时效性、恢复连续性不能混成一个指标 |

对 AI 应用岗位而言，值得讲的是如何控制一个具体失败链条；对 Agent 工程岗位而言，还可以继续深入工具协议、状态恢复和观测边界。无需证明“多 Agent 是未来”这种宏大判断。

**最值得准备的第一段：把上下文失效做成能检查的工程对象。**

已有实现不是只在提示词里写一句“注意其他人的改动”。它保存路径和版本；显式内容读取保留范围，整文件读取按整文件正文处理；对账根据版本、跨度与适用的导出表面启发式产生提示。读取范围外改动、重复失效以及部分不相关变化可以被过滤。

具体入口：[foldReadSet](../../packages/workbench/src/blackboard/session-view.ts)、[reconcilePremises](../../packages/workbench/src/runtime/premises.ts)、[spanInvalidated / surfaceUnchanged](../../packages/workbench/src/runtime/premise-predicate.ts)。

这里能谈清楚的权衡包括：

- 全文件 hash 容易实现，但可能把与已读片段无关的编辑也通知出去；跨度规则降低噪声，却引入插入、删除、行号平移等边界。
- 显式读取正文后，即便导出签名没变，函数体变化也可能使代码审查结论失效；不能把所有读取都视为“只依赖接口”。现有代码和基准已经为此区分路径。
- 非显式正文依赖的导出表面比较是启发式。签名不变但行为改变，仍可能影响调用者；词法投影不等于完整语义分析。
- 快照缺失、工具不提供结构化路径、Shell 读取无法识别，会削弱保证。单条路径当前保存的读集条目也不是完备的计划依赖图。

值得让面试官继续问的是：“怎样定义相关变化？误报和漏报谁的代价更大？读集何时失效，何时能重新获得可信度？”而不是“我支持了多少种模型”。

可概括为：**将 Agent 的部分上下文依赖外置为可追溯的文件版本记录，检测它在会话生命周期中的失效。** 这是场景化的工程贡献，不是新的依赖追踪理论。

**第二段：通知进入队列、进入进程、完成回合与修复代码，是不同事件。**

检测可能发生在 watcher，真正持有 Agent stdin 的却是 UI 宿主进程。若检测后直接当作“模型已经知道”，进程不在线、回合失败或队列滞留就会制造假成功。

当前实现把失效与投递分开：

- 失效证据进入事件日志，再由投递路径折叠为每写者的待发通知；同一路径更新后保留较新状态。
- 通道不可用、投递失败或只有 queued 结果时，通知保持待处理。
- Claude 路径在成功 result 帧时调用通知确认；不是以 stdin 写入或 UI 显示为完成证明。
- 默认通知预算是**近似 300 token**，代码按字符估算；先保路径/版本事实，再裁差异，并报告未展开数量。这不是精确 tokenizer 上限。

见 [delivery.ts](../../packages/workbench/src/runtime/delivery.ts)、[notice-render.ts](../../packages/workbench/src/runtime/notice-render.ts)、[claude-router.ts](../../packages/workbench/src/chat/claude-router.ts)、[claude-ack.ts](../../packages/workbench/src/chat/claude-ack.ts)。

可讨论的深度在故障窗口：provider 已执行成功但本地 ack 未持久化时，可能重投；成功回合也不证明模型理解了通知，更不证明生成结果正确。因此不能把该链路叫端到端 exactly-once 或语义修复证明。

相邻的 [fork / inheritance](../../packages/workbench/src/chat/thread-inheritance.ts) 把 UI transcript、provider 上下文与文件前提继承分开。HTTP 车道在本项目当前实现中可以重发聊天历史，但没有文件工具足迹；这不是说 HTTP 协议天然无法承载工具。这个区分适合回答“为什么一个统一聊天接口不等于所有 Agent 能力都相同”。

这些机制采用了已有的消息可靠性思想，面试价值来自对真实 Agent 协议的适配及失败处理，而不是“发明了队列”。

**第三段：用负面实验审计 Agent 护栏的真实执行路径。**

仓库最有说服力的一份材料是 [2026-09-27 Codex 写侧封印对照](2026-09-27-codex-write-seal-gap.md)。下面数字属于那次历史运行，本次没有重跑模型：

| 历史实验 | 已捕获失效前提 | 写入落盘 | 写回合 seal 事件 | 同写者、同前提的冻结判定对照 |
| --- | --- | --- | --- | --- |
| own-fresh | 0 | 是 | 0 | pass |
| own-stale | 1 | 是 | 0 | block |

这个实验说明在该模型、profile、Codex 构建和命令路径下，写入没有到达期望的拦截点。它把“判定逻辑能识别失效”和“真实工具执行被判定逻辑覆盖”分开了。不能因此宣称所有 Codex 写路径都一样，也不能拿后续夹具绿灯覆盖这份实测。

当前 [codex-session.ts](../../packages/workbench/src/chat/codex-session.ts) 已在可归因写审批上咨询 seal，但 [ADR-0023](../decisions/0023-research-prototype-closeout.md) 明确保留没有审批、目标不明、读取不可见及错误放行等缺口。[9 月 28 日收尾](2026-09-28-readme-release-closeout.md)的真实 fresh 实验 exit 2，表示没有测出来，不能改读为修复成功。

这一段很适合 AI 应用 / Agent 平台面试：从“guardrail 函数通过测试”到“工具副作用发生前必定走 guardrail”之间存在完整中介与归因问题。你能展示真实失败、控制变量、冻结基线和观测边界，比再堆一个 planner / reviewer 角色更有信息量。

**可以备用，但不应压过主线的两个话题。**

1. **恢复时分开模型叙述与仓库事实。** [resume-card/index.ts](../../packages/workbench/src/chat/resume-card/index.ts) 根据版本与引用标注“后来被改写、删除、回滚”等情况。它不把旧总结直接当作现状。可以连接到 RAG 的时效性问题：检索到一段相关文本不代表它仍适用。但没有真人研究，就不能声称已经降低用户恢复时间。
2. **完成声明也有适用范围和保质期。** 产品内 [goal-machine.ts](../../packages/workbench/src/automaton/goal-machine.ts) 要求 checkpoint 已验证、效果已应用且依赖仍有效，接口漂移可产生 `stale_done`。仓库开发侧的 [claims/ledger.mjs](../../scripts/claims/ledger.mjs) 则关联被测提交、仪器 hash、依赖路径和实际退出码。这是两个不同系统：后者是本仓库的工程验证工具，不能包装成已发布产品的通用 Agent 能力。手工定义的范围可能遗漏依赖，登记 valid 也不是防篡改证明或产品验收。

独立的 [context-rot](../../packages/context-rot/src/scan.ts) 把指令文档中的路径、符号和包引用变成可检查对象，适合做小演示；静态引用检查本身并不新，也不能检查自然语言的所有语义过期。

**哪些内容不宜作为“创新卖点”。**

- CLI + React 面板、MCP 接入、多模型支持、SSE/JSON-RPC、任务 DAG、git worktree、checkpoint：可以证明完成过工程集成，但单独拿出来区分度有限。
- YAML/JSONL、append-only 事件、单写者锁：是存储和一致性取舍，不等于比数据库更先进。文件账本也有扫描成本、锁竞争、恢复和多文件一致性问题。
- 自动化测试数量、ADR 数量、任务节点数、代码行数：不能直接度量用户收益或设计质量。
- “保证安全”“杜绝冲突”“所有工具都可观测”“并发效率提升 X 倍”：现有证据不足。
- 已经退役的旧桌面技术栈及未交付功能：不能混进当前成果清单。

本次没有做全面代码质量审计，所以不据代码规模断言它是优秀架构或“屎山”。可以明确看到的是：有一条可解释的核心链路，也有围绕它累积的编排与交互复杂度。面试无需替每个模块辩护；应能说明哪些是问题必需、哪些尝试没有获得足够收益证据，以及为何停止继续扩张。

**可直接练习的面试开场。**

> 我最初想做编码 Agent 并发工作台，后来把重点收敛到一个更具体的问题：Agent 读过的代码被人或其他任务修改后，仍可能沿用旧上下文，而且不同文件之间未必有 Git 合并冲突。
>
> 我参考建议式并发控制，做了本地文件前提账本，记录可观测的读取版本，检测变化，再通过持久通知和恢复卡回传证据。实现上重点处理了范围读取的误报、通知入队和成功回合确认的区别，以及外部 CLI 的读写归因。
>
> 项目目前是工程研究原型。我没有证明并发提效，也不宣称全局写保护；真实 Codex 对照还发现过判定函数会阻断、实际写路径却没经过它的问题。这个项目让我具体理解了 Agent 系统里“模型说完成、状态已保存、外部副作用正确”是不同的事。

上述措辞应按自己实际参与的设计、实现与验证范围使用。继承的上游组件、Agent 辅助生成的实现、自己做出的取舍应能分清；面试官更可能沿着一条失败路径追问，而不是逐个听完所有模块。

**建议准备的追问与答案边界。**

| 追问 | 可以站住的回答 |
| --- | --- |
| 这不就是 Git diff 吗？ | diff 告诉你内容变化；额外记录告诉你哪些会话曾读到什么版本，并把差异定向关联到恢复/通知。是否真影响计划仍需判断 |
| 这不就是缓存失效或 OCC 吗？ | 思想确实已有。这里的工程问题是外部工具不完全受控、读取不完全可见、推理时间长且重做有成本，因此收敛为建议式失效提示与有限拦截 |
| 为什么不直接让 Agent 重读全部文件？ | 重读仍有成本，也没有自动解决重读后继续沿用旧计划的问题；定向提示的收益需要实测，当前没有证明它比全量重读更优 |
| 一定能发现依赖失效吗？ | 不能。工具覆盖、片段记录、启发式、模型的隐含知识和未显式读取都限制覆盖 |
| 收到通知是否就修好了？ | 不是。queued、成功回合 ack、复读足迹、验证结果分别是不同证据 |
| hook 能否作为安全边界？ | 只有所有相关副作用都经过它、目标可归因且策略满足要求时才能讨论该保证；当前条件不成立 |
| 怎样测这个项目？ | 分别测检测契约、投递故障路径、真实工具拦截和最终任务结果；不同层的通过不能互相替代 |
| 已经证明并发更快了吗？ | 没有。已有并发执行能力不等于证明速度收益，应同时比较最终正确率、总耗时、token 与人工干预 |
| 不引入数据库是不是更简单？ | 部署和检查状态更简单，但会承担文件锁、全量投影、恢复等成本；这是本地原型的约束选择，不是通用优越性 |
| 项目是否有原创？ | 没有主张算法首创；可归属的价值是具体集成、边界取舍、失败复现与适配经验，按实际个人贡献描述 |

**简历可以写得短一些。**

> VerseSpace / Workbench：面向编码 Agent 的本地上下文时效性与执行证据原型。实现文件读写足迹、版本/范围失效检测、持久通知和可追溯恢复；集成受监督 CLI，并通过真实通道对照定位写前护栏的覆盖缺口。

按岗位选择其中两到三项展开即可。“自研多 Agent 高并发 IDE，显著提升开发效率”不是当前最稳妥的简历表述。

**已有材料足以做小而完整的演示，不需要再扩一轮平台。**

建议按三幕讲现有机制：先展示一次已读文件发生变化及其证据；再展示读范围外改动或重复变化怎样被过滤；最后展示通知待处理与确认的区别，并拿历史 own-fresh / own-stale 表解释真实 hook 缺口。展示真实模型效果时，必须另有该次模型运行记录；本次 11 场景基准不能冒充模型演示。

如果之后为了面试练习做自动化对照，最有解释力的基线是同任务下的“不通知 / 无过滤通知 / 现有过滤通知”，分别记录检测、重读、最终测试与消耗。这里只说明评估逻辑，没有创建新的开发任务，也不重新开启已经退役的真人或非 Windows 验证范围。

**本次测量与未测量范围。**

| 项目 | 本次实际执行 |
| --- | --- |
| 检测契约 | `bun packages/workbench/scripts/benchmark-premises.ts --json`；exit 0；11/11 场景通过；Windows / Bun 1.3.14 |
| 相关测试 | 在 `packages/workbench` 执行下面命令；exit 0；45 pass、0 fail；7 个文件、290 个断言；5.63 秒 |
| 源码核对 | 读取足迹、读集折叠、对账谓词、seal、通知、Claude/Codex 集成、继承、恢复卡、目标状态机、声明检查及 context-rot 的关键实现 |
| 历史证据 | 读取 9 月 27 日真实 Codex 对照与 9 月 28 日发行收尾，未将旧读数登记为本次实测 |
| 外部对照 | AnySearch 检索、正文提取和公开源码阅读；没有安装、运行或评测对照产品 |
| 未执行 | 全仓 lint/typecheck/全套测试、浏览器验收、真实模型调用、并发收益实验、生产率研究 |

```powershell
$env:NO_PROXY = '127.0.0.1,localhost,::1'
bun test src/runtime/premises.test.ts src/runtime/delivery.test.ts src/runtime/seal.test.ts src/chat/notice-ack.test.ts src/chat/fork-inheritance.test.ts src/chat/codex-write-capture.test.ts src/chat/provider-capabilities.test.ts --timeout 60000
```

这些测试包含夹具与模拟 CLI 进程。通过说明相关实现的契约得到复核，不说明真实模型已经有效修补、不说明所有故障窗口关闭，更不替代整仓验收。

值得保留的成果是一组可以从具体失败讲到机制、再讲到保证边界的工程材料。下一步面试准备的重点是把这几条链路讲透，而不是给项目补一个更大的愿景。

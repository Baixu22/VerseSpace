# Workbench 定位：并发安全层（v4，取代 v3 任务主权层）

> **⚠️ 本文已被 [`positioning-v5.md`](./positioning-v5.md) 取代（2026-08-30）。**
> 第二轮深度调研推翻了本文的若干结论：产品形态（两个写者而非两个 agent）、通知形态（高门槛二元而非分级）、命名与分发（hooks + context rot 而非独立协调层产品）、合并策略（杠杆在上游切分而非合并算法）、以及"上下文抖动"这一整个类比（已证伪）。
> 本文保留作为演进记录，**不要据此实施**。

- 状态：**已被取代**
- 日期：2026-08-29
- 演进：v1「任务赢过会话」（已废）→ v2「两态模型」→ v3「任务主权层：任务即身份证」→ **v4 本文：任务即事务，运行时即并发控制器** → v5「前提守护者」
- 与 v3 的关系：**不推翻，是把 v3 的"为什么"换掉。** v3 的架构判断（会话挂靠任务、治理是副产品、对话不可推翻）全部保留；v3 卖的是"治理"，v4 卖的是"并发安全"，而治理成为并发安全的账本副产品。

---

## 一、裁定：不做 harness，做 harness 底下那层

三个选项里没有正确答案：

| 选项 | 否决理由 |
| --- | --- |
| 在传统 harness 上做任务专精 | 引擎厂商每月吞并这一层（agent teams、跨会话消息、云端并行任务）。单人打不过 |
| 造全新交互架构 | v1–v3 已论证过：对话是 LLM 的终端形态，推翻它是范畴错误 |
| 再做一个 worktree 启动器 | 13 个产品的红海，且 `git worktree` + tmux 已经免费 |

**第四选项：做协调层。** harness 拥有模型循环、上下文、工具执行、权限；工作台拥有"起 N 个 harness + 一个 UI"；**没有人拥有"知道所有会话读过什么、写过什么、按什么因果顺序"的那一层**。它按构造是 agent 无关的（它观测文件与事件，不观测模型调用），而且**引擎越强它越值钱**（见 §二自动化偏见）。

一句话：**对话即引擎，任务即事务，运行时即并发控制器，治理是事务日志的副产品。**

把 v3 的"任务即身份证"换成"任务即事务"，全部就位：事务有读集写集（所以必须采足迹）、有隔离级别（所以能**声明**提供什么保证）、要么提交要么修补（checkpoint + Verifier 就是提交协议）、正确性判据是可串行化（**得到可测试属性而非口号**），审计日志就是事务日志。

对外一句话：**唯一能告诉你"同时开五个 agent 时你拿到的是什么保证"的 agent 运行时。** 别人都在说"可以并行跑 agent"，没人敢说它们撞上时会发生什么。

---

## 二、第一性修正：并发不是价值，协调才是

「并发原生」这个提法会把产品带进坑。证据一致且反直觉：

| 来源 | 结论 |
| --- | --- |
| Google《Towards a Science of Scaling Agent Systems》（180 组配置，2026-01，arXiv 2512.08296） | 可并行任务 +80.9%；**顺序依赖任务每种多智能体变体退化 39–70%**；**互不通信的并行放大错误 17.2×**，中心编排只放大 4.4×。工具越多协调税越不成比例——编码 agent（16+ 工具）是最差场景 |
| CoAgent（SJTU，2026-06，arXiv 2606.15376） | **无协调并行通过率 13%**；2PL 每轮死锁 0.81 次、加速比 1.04×；OCC 每轮回滚 0.95 次、比串行更慢（0.93×）、token 涨 1.83× |
| MAST（1600+ 真实 trace / 7 框架，arXiv 2503.13657） | 41.8% 规格设计 + ~37% 智能体间失配——**三分之二以上失败与模型能力无关** |
| METR RCT（2025-07） | 熟练开发者用 AI **慢 19%** |
| DORA | AI 采用 ↔ 交付**稳定性 −7.2%** |
| 实测天花板（Kilo 七位工程师 / Willison / Anthropic 官方） | **2–4 个主动监督的 agent**；Anthropic 自述 3–5 之后收益递减 |

Google 那句 "orchestrator acts as a validation bottleneck" 说的正是：**瓶颈是特性，不是缺陷。**

### 剃刀：fan-out 方程

人因工程（Olsen & Wood, CHI 2004）：

```
FO = (NT + IT) / IT
NT = neglect time    一个 agent 能被忽略多久才开始出错
IT = interaction time 你服务它一次要花多久
```

只有两个杠杆：**抬高 NT，压低 IT**。MIT（Cummings/Nehme）证明：算进等待时间（排队 + 你没注意到它需要服务 + 态势感知丢失后的重建），**容量预测下调最多 67%——实测打三折**。

代入真实数字：IT ≈ 10 分钟，NT ≈ 15 分钟 → 朴素 FO = 2.5 → **实际 ≈ 1.7**。

**而 IT 不是常数。** 合并冲突面按 ~N(N−1)/2 增长，每解决一次使其他分支 base 失效；实测冲突解决吃掉并行时间 30–50%，10 个 agent 以上 15–25% 冲突率、4× CI 容量。所以 **IT 随 N 增长，FO 曲线会翻头**——这就是为什么所有实践者都落在 2–4。

> **`maxConcurrentWorkspots ?? 2` 不是保守，它正好压在天花板上。**
> 想上到 5，需要 NT = 4×IT（agent 能无人干预跑 40 分钟不跑偏），或把 IT 压到 3 分钟。

**产品剃刀：不服务于「抬高 NT」或「压低 IT」或「压平 N(N−1)/2 项」的功能，一律不做。** 这条替代未来 80% 的功能争论，且可测量。

### 三条设计约束（有标准与实证背书）

1. **自动化偏见阈值 ~70%**：工具准确率超过 ~70% 后人停止交叉核对。**一个 90% 正确的 agent 比 60% 正确的更难监督。** → 引擎越强，人的监督越失效，**机械验证层越值钱**。产品随引擎变强而增值。
2. **人的事件容量（ANSI/ISA-18.2、IEC 62682、EEMUA 191）**：~1 条/10 分钟可持续；~12 条/小时是上限；**10 分钟内 ≥10 条 = 洪泛（定义为超出人类能力）**。合理化后优先级分布目标 5% 严重 / 15% 高 / 30% 中 / 50% 低；若 >25% 为"严重"则分级已失败。
3. **警觉性衰减 ~20 分钟**起（30 分钟内目标检出率降约 15%）；Endsley & Kiris：**中等自动化程度在态势感知与接管表现上优于完全自动化**。Graicunas 管理跨度上限 5（理想 4）——但那是对**需要互相协调**的单元；互不依赖的单元由 fan-out 管。**先把单元间依赖砍到 0，再谈数量。**

---

## 三、差异化落点：读侧

CoAgent 精确否掉了整个现有品类：

> **"Partitioning constrains writes; the bug is in reads."**

写集分区（= worktree、= agent teams 的提示词纪律）不够：两个 agent 写集完全不重叠，照样能产生任何串行顺序都产生不了的错状态，因为 B 读到的是 A 改之前的值，而且**静默**。fork-and-merge 三个死穴：文本合并不保留意图；LLM 复核无法从合并后代码反推作者意图；活状态（数据库/集群）根本不能 fork。

**竞品核实（13 个产品，2026-08）：预冲突检测全员空白。** 无一在两个 agent 即将碰同一段代码前给出提示，**全部只在 merge 时才知道**。唯一有真实跨车道协调机制的是 Claude Code agent teams（`~/.claude/teams/{team}/inboxes/{agent}.json` mailbox + `~/.claude/tasks/{team}/` 共享任务表 + 依赖自动解除 + 点对点消息），但**共享工作目录且无锁**，官方指引是"两个队友编辑同一文件会互相覆盖，请拆分文件所有权"——把问题外包给提示词；且会话原子、`/resume` 不恢复队友、实验性默认关闭、仅 Anthropic。

**同样无人建的另外两块**：语义/AST 级重叠预测（最接近的 Fletch 给每车道私有符号与调用图索引，但完全不跨车道）；**按车道的进程/内存计量**——而并行 Claude Code 下的孤儿进程与内存耗尽是公开记录的第三大杀手（claude-code#4953）。

### 已有的最接近先例，及为何不构成竞争

**agent-coherence** + 论文《Token Coherence: Adapting MESI Cache Protocols…》（arXiv 2603.15183，2026-03）实现了 MESI 式产物一致性：按 agent 追踪所有权、对端提交时失效、拒绝基于已移动视图的写，**TLA+ 验证三个不变量**（~2400 状态），并带一个往会话里丢 stale-read 警告的 Claude Code 插件。

五个限定条件把它与本产品分开：

1. **目标函数不同**：它优化**同步 token 成本**（O(n×S×|D|) 全状态重播），报出的收益是节省 token 84–95%；正确性是搭车副产品。
2. **姿态相反**：MESI 的 Modified 态是排他所有权 → **single-writer、fail-closed**。这正是 CoAgent 用数据否掉的悲观路线。
3. **它自划的边界恰好是错的那处**：它明确声明「每个 agent 有自己的 worktree 就不需要它」，目标是共享 `plan.md`/`memory.json` 而非源文件——**而这正是表内每个产品的配置，也正是 CoAgent 证明不成立的那句话**。
4. **评估是四种负载的仿真**，非真实编码 CLI、非跨 worktree、非 Windows。
5. **集成面是 LangGraph/CrewAI/AutoGen 的进程内 agent**，非独立 CLI 会话。

> **楔子一句话：它说"有 worktree 就不用管"，CoAgent 证明"有 worktree 恰恰还得管"。**

工程收益：**去读那份 TLA+ 规格，不要重新发明不变量。** monotonic versioning 与 bounded staleness **照抄**；single-writer safety **明确拒绝**（见 ADR-0006）。

---

## 四、既有资产盘点（比想象的强，但接错了地方）

### 已经写出来的差异化雏形

`blackboard/interfaces.ts` + `automaton/goal-machine.ts`：`goal.verifiedAgainst.interfaces` 是一张 `{接口: 读到的版本号}` 表，`entry.version > version` 即发 `mark_stale`。**用数据库术语说，这是快照隔离的读校验**，做在 goal 粒度。schema 里 `blackboardEffects.publish/update` 与 `artifacts:[{path,hash}]` 已把**写集声明**的位置留好——读集、写集、解锁关系，四件套里三件已定类型，两件解析了没接线。

Hearsay-II（1975）黑板架构有**三个**部件：黑板 + 知识源 + **调度器**；现代 agent 栈普遍只重建了第一个（共享 plan 文件），而原作者认为调度器才是真正的研究贡献。**本项目三个都有。** Hayes-Roth BB1（1984）把控制决策本身放上第二块黑板——automaton 输出 `Transition[]` 正是这个形状。收敛演化，且收敛到了更完整的点。

### 三个断点（差异化资产未接到用户面上）

| 断点 | 证据 |
| --- | --- |
| **chat 运行时与 blackboard 完全解耦** | `chat/threads.ts` 仅读 `bb.paths.root` 与 config；spawn 用 `cwd: this.bb.projectRoot`（threads.ts:280）——**日常在用的路径跑在主 checkout 里，无隔离亦无协调**；会话无 goal/workspot/task 字段，**没有对象可通知** |
| **漂移只查 `done` 的 goal** | 正在跑的会话永远不被检查；漂移在工作做完之后才发现。**把检查从"完成的 goal"扩到"在飞的会话"，是单点杠杆最大的改动** |
| **裁决队列不存在** | `notify_human` 有 9 个发射点遍布三个状态机与 scheduler，runtime 收进数组、打一行日志、`sync` printf 出来，**前端零 UI**。§5 第一定律「裁决优先」目前是一个被丢掉的数组 |

---

## 五、架构：五层

### L0 · 进程 supervisor（前置，非功能）

结构化并发（scope 拥有进程组，取消向下传播，错误聚合）+ OTP 监督树。POSIX `detached:true` + 负 pid 杀进程组；Windows 去 `shell:true` + `taskkill /T /F`（正解是 Job Object `KILL_ON_JOB_CLOSE`，Node/Bun 无绑定，需小 shim）；`pid → sessionId` 落盘 + 启动收割孤儿。**OTP 真正承重的不是 restart 而是升级放弃**：60 秒内崩 3 次 → `failed` → 上抛 goal → 停止派发；`rest_for_one` 映射到依赖边。

> 在一个连自己起的进程都停不掉的 runtime 上，谈不了并发控制。而"按车道计量进程/内存"是竞品全员空白且行业第三大杀手。

### L1 · 会话成为黑板公民

`sessions/` 区：会话记录带 `task / workspot / status` + `footprint.jsonl`。**这不是治理美学——runtime 无法通知一个不在模型里的会话。** R1 因此不是"身份证功能"，是**协调的前置条件**，且必须包含读写集捕获。

**采集主通道 = stream-json 输出，非 hooks。** 区分两件事：transcript 文件（`~/.claude/projects/…jsonl`，文档明确警告格式内部、随版本变化，**不可依赖**）vs stream-json 输出（文档化契约，`tool_use`/`tool_result` 作为消息出现，带 `parent_tool_use_id` 标明派生来源，v2.1.219+ 转发任意嵌套深度的 subagent）。**`chat/threads.ts:338-343` 与 `:355-363` 已在解析它**，现在渲染完就丢——足迹采集是既有解析点加几行落盘。hooks（`async: true`）退为第二通道，用于不控制输出格式的 `agents/runner.ts` 派发路径。

事件 schema 借 W3C PROV 词汇 + OpenLineage facets 可扩展性：

```
{ seq, ts, activity: sessionId, agent:{cli,model},
  used:[{path,hash}], generated:[{path,hash}], facets:{} }
```

因果只需版本向量的一半：会话快照加 `observed: Record<key, version>`，写入时 diff——**这一个字段就是"B 有没有看见 A 的写"的全部答案**。

粒度：除 `contentHash` 外存 `interfaceHash` = 依赖的**规范投影** hash（TS 即产出的 `.d.ts`）。`contentHash` 变而 `interfaceHash` 未变 = 不打扰；`interfaceHash` 变 = 必须通知。加子树 Merkle 目录 hash。

**简化**：`--session-id <uuid>` 可由 runtime 指定会话 ID，把当前的 `t-<base36>` 线程 id 与捕获来的 `claudeSessionId` 塌成一个。

### L2 · 建议式失效通知（差异化本体）

CoAgent 的核心洞察：对 LLM agent，**正确的并发控制是建议式而非阻塞式**——一次 agent「事务」跨越数分钟推理，2PL 锁太久、OCC 回滚太贵；而 LLM 有经典事务没有的三种能力：判断冲突是否真的推翻前提、只修补依赖失效值的那几步、为几乎每个写生成 saga 式逆操作。

**"runtime 通知，agent 修补。"** 落地：reconciliation 循环比对每个**活着的**会话读集 hash 与磁盘现值；不匹配发 `notify_session`（`notify_human` 的镜像，automaton 保持纯函数，runtime 负责投递）。

**投递通道 = `CLAUDE_CODE_MESSAGING_SOCKET`。** stdin（`--input-format stream-json`）是**排队顺序处理**，不是自由轮内注入；而跨会话消息 socket（Unix socket / Windows 命名管道，首行发 `{"type":"auth","token":…}`）**在活跃轮次的工具调用之间投递**，空闲时开启新轮。**Anthropic 发的是运输管道，没人发要运的东西——消费它，不要跟它竞争、也不要自造 stdin 土办法。**

双视界（借 ATC）：**STCA ~2 分钟战术**（"这两个会话下一个 commit 就会在这个文件上撞"）+ **MTCD 10–20 分钟战略**（"这三个分支合并时会冲突"）。分开做。

对照 MCP Agent Mail 的公开失败点——"agents forget to check their messages"——**拉模型必败**；reconciliation 循环是强制推送，不依赖 agent 自觉。而文件租约是 CoAgent 证伪的悲观路线（Claudio、forge-orchestrator 两个小项目走的正是这条）。

### L3 · 裁决队列，按 ISA-18.2 报警管理纪律

`notify_human` 的 9 个发射点已在正确位置，把它从 printf 变成真队列：

- **合理化（Stage 3 五准则）**：异常 / 有后果 / **要求动作** / 相关 / 唯一。**没有既定动作的不是告警**（工业实测砍掉 40–60% 事件）。每个事件类型必须先回答"人看到会做什么不一样的事"，并**自带那个动作**。
- **优先级 = 后果严重度 × 响应时限**（二维矩阵）绑 SLA：<5min / 5–30min / 30min–2h / 数小时。
- **首因 + 因果抑制**：一个失效依赖打断 30 个会话 → **一条，挂 30 个**。
- **状态化告警**：会话在"探索态"与"落 PR 态"不发同一套事件。
- **搁置必须自动到期**（5min–4h），搁置数本身是被监控 KPI；永久忽略走变更记录。
- **队列健康度**：速率/小时、洪泛次数、抖动、陈旧（>24h）、已确认未解决、Top-10 贡献者、响应时间。
- **NEWS2 式单参数越级**：碰认证代码 / force-push / 检出密钥 → 单独升级，不看综合分。
- **卡片形状用 SBAR**（结尾是 Recommendation）：**打断你的东西必须带建议，不能带问题。**
- **挑战-应答**：agent 断言 "tests pass: 412/412"，你核对**产物**而非声明。合并闸门 ≤5 项、60–90 秒、只放"漏了就死"的项（WHO 清单：死亡率 1.5%→0.8%；Pronovost 5 项：CLABSI 2.7→0/千导管日）。

### L4 · WIP 由推导得出，不由配置得出

**drum-buffer-rope：你（复核者）就是 drum。** agent 启动速率由裁决吞吐量闸住，而非任务数量。用 **CONWIP**（一个全局令牌池封顶总 WIP）而非逐段 kanban——更易调且吞吐更高。

**Ground Delay Program 是这里最漂亮的机制**：到达容量 < 需求时，飞机**在起飞地停住**并按时刻表分配落地时隙——延误在源头廉价吸收而非空中昂贵盘旋。翻译：**不要启动那些产出会烂在队列里没人看的 agent，给它时隙让它排着别起飞。**

配套：**andon 是求助不是停线**（有界窗口内自动解决，超时才阻塞；丰田每班约 1000 次拉绳，**拉绳率下降才是警报**）；**jidoka**（agent 自身 test/lint 失败自己停自己重试，只有解不掉的进队列）；**两次挑战规则**（被挡两次必须停下上报而非绕过去）；**无菌驾驶舱**（14 CFR 121.542 在关键阶段禁止非必要活动 → 声明式"关键复核模式"硬压非关键通知）；**留一个不分配的储备**（发现问题的人不能是修问题的人；满负荷监督者响应能力为零）。

### 会话间通信：转交 vs 知会

ATC 的答案比"一个会话伸手进另一个"精确：**转交（handoff）与知会（point-out）是两件事**。转交雷达识别与转交通信是两个独立动作，在定义好的移交点完成且**需要显式接受**；point-out 共享认知**而不转移控制权**。

正确原语对：「另一会话现在拥有此文件」（需显式接受）vs「另一会话应知道此文件」（单向）。

**会话间上下文交接用 I-PASS**——全篇证据最强：五槽（一词严重度 / 摘要 / 带 owner 的动作清单 / 态势感知与"若 X 则 Y"应变 / **接收方复述综合**），9 家医院 10,740 例：**差错 −23%、可预防不良事件 −30%、险兆 −21%，且交接时长不增加**。承重部件是最后一槽：**接入的会话必须先复述状态并被核对，才允许动手。**

---

## 六、明确不做

| 砍掉 | 理由 |
| --- | --- |
| a2a / 互聊协议 | Google 数据：独立并行与去中心化辩论是最差架构；MAST：37% 失败是智能体间失配；且已被引擎商品化 |
| **四提供商里的三个 HTTP 纯文本路径**（openai-chat / openai-responses / anthropic） | 无工具调用 → **产不出读写集 → 无法参与协调**。表面积翻三倍却拿不到差异化。留 claude CLI，之后加 codex CLI |
| `/api/state` 仪表盘幻觉 | 要么接线要么删掉死的 `apps/workbench-ui/src/api.ts` |
| 手动工作流 DAG 编辑器 / 取代对话的工作台 / 数据库依赖 / Agent SDK 内嵌 | v3 已排除，继续有效 |
| CRDT（Automerge/Yjs） | **买的是收敛不是正确性**；跨对象不变量证明上需要协调；文本 CRDT 会把两个 agent 的编辑收敛成语法正确但编译不过的代码。单机无分区 → 直接串行化写入。`events.jsonl` 已是唯一真正需要的 CRDT（G-Set） |
| **Jujutsu（现在不做，记在案上）** | 天花板最高（冲突是可提交对象、`jj workspace` 原生多工作副本、op log 免费全局 undo），但：`jj-lib` 无稳定 API → 只能 CLI + 模板（无稳定 JSON）；**op log 是仓库全局而非按 workspace，一个 workspace 的 `jj undo` 能撤掉另一个的操作** → 必须自行串行化所有 mutating 调用；冲突提交无法表示进 git，会以 `.jjconflict-*` 目录让 CI/PR 看到垃圾；`working-copy.eol-conversion` **忽略 `.gitattributes`**——与已修复的 CRLF 竞态直接冲突。**换地基会吃掉整个路线图。等 L2 上线、合并痛苦被实测为下一瓶颈时再评估** |
| Plan 9 式 per-session 命名空间 | Windows ProjFS 无 Node/Bun 绑定、需管理员启用可选功能、旗舰消费者（VFS for Git）已被微软放弃。**worktree 就是你的命名空间**，把它显式化为 `view.yaml` 并在工具调用 broker 层校验 |

---

## 七、顺序

### Sprint 0 · 前置（不加功能）

1. **修 CORS/鉴权**：`ui/server.ts:238` 每个响应带 `access-control-allow-origin: *`；绑 127.0.0.1 挡不住浏览器，而 `POST /api/agent/run` 是任意 agent 执行、`PATCH /api/config/chat` 写 API key。**这是漏洞不是待办。**
2. **抽 L0 supervisor**：`verifier/index.ts:34` 已写对的杀进程纪律抽成模块，三处 spawn 全走它；`agents/runner.ts` 的无界内存缓冲改流式落盘（当前不退出就无限增长且日志空白）。
3. **blackboard 真写前置条件**（CAS on version+hash）；`queue.yaml`/`registry.yaml` 从"单文件装数组"改"一条一文件"（goals 已是此形状），结构性消灭并发丢失；**改掉 `blackboard/fault-tolerance.test.ts:96` 那条把丢更新断言成正确的测试**。
4. **`runOnce` 单写者**：锁覆盖 `sync`/`dispatch`/API 全路径，用 `O_EXCL`（`open(…,'wx')`）而非 check-then-write（`watcher/lock.ts:31`）。
5. **升 claude CLI 至 2.1.234+**（原生 Windows 的跨会话消息地板；macOS/Linux/WSL2 为 2.1.224+，本机 2.1.220），并决定 runtime 与 agent 是否同处原生 Windows 一侧（**WSL2 ↔ 原生 Windows、宿主 ↔ 容器互相到不了**）。做一个最小连通性验证：起一个 `-p` 会话、从外部往其 socket 投一条、确认在工具调用之间收到。**这是整套架构唯一的二元风险，值得在写任何功能代码前用半天打掉。**
6. **在本仓库 `workbench init`，用它推进下一个里程碑。** 自举闭环合上之前，关于 runtime 的一切声明都没被唯一重要的用户验证过。

### R1′ · 会话成为黑板公民

会话记录 + stream-json 足迹采集。**验收改为**：*一段会话结束后，runtime 能回答"这个会话读了哪些文件的哪个版本、写了哪些"*——而非"卡片上能看到动过的文件"。前者支撑 L2，后者只是好看。

### R2′ · 建议式失效通知（差异化本体）

**验收**：*构造两个会话，B 读了 A 随后修改的文件；runtime 在 A 写入后 60 秒内把带 diff 的通知投递进 B 的活会话，B 的回应被记录。* 这一条做出来，品类里唯一的东西就有了。

### R3′ · 裁决队列 + WIP 推导

**验收**：*队列 24 小时内速率 ≤6/小时、无洪泛、严重项占比 ≤25%，且每条都带既定动作。*

### R4 · 发行

先修 `ci.yml` 的 15 处 tab 缩进；npm 公开发布；macos/linux 二进制宿主冒烟。

---

## 八、证伪实验（写代码之前，一周）

给现在的日常工作装一个记账本。出现下列任一情况记一行：

- (a) 发现某会话基于已过时信息干了活
- (b) 两个并行产出合并时**语义**打架（非文本冲突）
- (c) 因记不清哪个会话在干什么而重复劳动或做错决定
- (d) 想问"这个会话到底动过什么"但答不上来

裁定：

| 频次 | 结论 |
| --- | --- |
| **每周 ≥3 次** | 命题成立，按本文执行，L2 是产品 |
| **每周 <1 次且并发数为 2** | 在为尚不存在的问题造工具。两条路：把自己并发逼到 4–5 让问题浮出（但按 fan-out 这需要 NT 翻倍，而 NT 翻倍恰恰要靠 L2——自证循环），或承认当前瓶颈是 IT 而非协调，则先只做 L3（单独也有价值） |
| **痛点全在 (c)/(d) 而非 (a)/(b)** | 产品是**外化记忆**（ATC 飞行进度条：每 agent 一张可手写批注的持久卡片，价值在建立**接收方**的态势感知），而非并发控制。则 v3 定位正确，本文属过度设计 |

**此实验区分"我认为的问题"与"我的问题"，且只有你能诚实回答。**

---

## 九、关键引用

- Google, *Towards a Science of Scaling Agent Systems*, arXiv 2512.08296（2026-01）
- Lyu et al., *CoAgent: Concurrency Control for Multi-Agent Systems*, arXiv 2606.15376（SJTU, 2026-06）
- Cemri et al., *Why Do Multi-Agent LLM Systems Fail?* (MAST), arXiv 2503.13657
- Parakhin, *Token Coherence: Adapting MESI Cache Protocols…*, arXiv 2603.15183（2026-03）
- Meiklejohn, *Multi-Agent Systems Have a Distributed Systems Problem*（2026-03）
- Guo et al., *From Question Answering to Task Completion: A Survey on Agent System and Harness Design*, arXiv 2606.20683
- Olsen & Wood, *Fan-out: measuring human control of multiple robots*, CHI 2004；Cummings & Nehme (MIT) 等待时间修正
- Bainbridge, *Ironies of Automation*, Automatica 1983；Endsley & Kiris, Hum Factors 1995
- ANSI/ISA-18.2、IEC 62682、EEMUA 191（报警管理）
- Starmer et al., *I-PASS*, NEJM 2014
- Erman et al., *The Hearsay-II Speech-Understanding System*；Hayes-Roth, *BB1: A Blackboard Architecture for Control*, 1984

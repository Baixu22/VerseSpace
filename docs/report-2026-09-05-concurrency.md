# Helmor 并发控制策略分析报告

- 日期：2026-09-05
- 依据：task-forest 全量节点（147 个）与 209 条边、`docs/decisions/` ADR-0006/0007/0008、`packages/workbench/src/` 实现逐文件核实、`docs/fable-brief/06-implementation-status.md`、deviations 账本（17 条）、legacy `src-tauri` 抽查
- 范围：编码并发（多写者同仓）、多任务同步处理（调度与准入）、子 agent 方案、legacy 侧现状对照

---

## 结论先行

Helmor 的并发控制不是单一机制，而是一个**三层漏斗**，且每一层都已在 `packages/workbench` 里有真实实现（非纸面设计）：

1. **结构层——把不需要协调的变成不需要协调**（ADR-0007 单调优先）：`runOnce` 单写者互斥、blackboard CAS 写前置条件、一条一文件的事件/队列/足迹存储、全局因果时钟。这是唯一的强制（fail-fast）部分，作用域被刻意压到最小。
2. **协调层——免不掉的协调走建议式**（ADR-0006）：所有写者不阻塞、不回滚；runtime 记录读写集，用三层谓词判定陈旧前提，在**轮次边界**投递带 diff 的通知，LLM 自行裁决并只修补受影响的步骤；唯一例外是**封印点**（向已知失效区域写入时同步阻塞）。
3. **准入层——控制并发度而不是控制冲突**：worktree 车道物理隔离写集，CONWIP 准入上限由 Little 定律从实测吞吐推导而非人为配置，人类通道走 ISA-18.2 裁决队列（因果折叠 + 硬性泛滥闸门）。

最准确的概括：**物理上最小互斥、逻辑上建议式、调度上准入控制、人类通道上裁决队列、操作设计上单调优先。**

当前最大的实际落差有两个：其一，**编码并发的物理通道（worktree 派发）在本机不可用**（TF-0117 已成真：本机 git 2.55 拒绝含斜杠的分支名），导致整套建议式并发缺少真实多写者负载；其二，原定的 `CLAUDE_CODE_MESSAGING_SOCKET` 投递通道已在实现中**整体转向**为持久 `--input-format stream-json` stdin 会话（S0 验证结论），行为等价（轮次间追加、KV 缓存安全），但 ADR-0006 §5 尚未按此修订。

---

## 一、并发控制在任务森林中的位置

task-forest 当前 147 个节点：**103 done / 35 proposed / 6 in_progress / 2 ready / 1 review_needed**。并发主题横跨两棵全局任务树：

| 节点 | 内容 | 状态 |
| --- | --- | --- |
| TF-0057 | 全局任务：前提守护者（协调运行时 v5 + 追溯交互层 v6） | in_progress |
| TF-0058 | 决策 ADR-0006：建议式并发控制，拒绝 single-writer 排他 | **proposed（待用户裁决）** |
| TF-0059 | 决策 ADR-0007：单调优先 | proposed |
| TF-0060 | 决策 ADR-0008：结构从执行推导 | proposed |
| TF-0061 里程碑 S0 | 前置修复与二元风险验证（CORS、supervisor、CAS、runOnce 单写者、CLI 连通性） | done |
| TF-0068 里程碑 R1 | 写者成为黑板公民（sessions 区、stream-json 足迹、PROV 事件、单调 seq） | done |
| TF-0073 里程碑 R2 | 陈旧前提检测（三层谓词、socket 投递、封印点、合并安全网） | done |
| TF-0080 里程碑 R3 | 裁决队列 + WIP 推导 + 每车道计量 | done |
| TF-0120 | Fable 5.1 收敛：交互 / 会话树 / 并发统一 | in_progress |
| TF-0121 阶段 A | 证据与架构地基（stats 基线、事件身份、生命周期事件、fork 继承拆分） | in_progress |
| TF-0126 阶段 B | 恢复处境（R2′ 读集 diff done、双通道恢复卡 in_progress） | proposed |
| TF-0130 阶段 C | **分支与并发收敛**（分支读集继承、merge-back L1、通知预算、封印观测） | proposed |
| TF-0135 阶段 D | fit 门与范围仲裁（两周真实使用门、L3 证据门、砍留决策） | proposed |

值得注意的治理事实：**ADR-0006/0007/0008 三个决策节点仍是 proposed（文档状态也是"提案，待用户裁决"），而实现这些决策的里程碑 S0/R1/R2/R3 已全部 done**。deviations 账本里有先例（TFD-56f68d0653：上一份提案因"越权标 done"被撤回），说明这是刻意的严格姿态而非遗漏——但悬而未决的正式裁决迟早需要一次补课。

未闭合的 blocking 边共 20 条，收敛在四个咽喉节点上：TF-0123（稳定事件身份与因果时钟，review_needed）、TF-0124（会话生命周期事件，in_progress）、TF-0142（通知通道语义，ready）、TF-0140（Claude 真实上下文继承裁决，proposed）。**阶段 C 的全部内容（TF-0131~0134）都被 TF-0140/TF-0142 前置阻塞**——即"分支与并发收敛"在证据链上还不能开工。

---

## 二、结构层：把协调移出关键路径

对应 ADR-0007（CALM 定理：后到的事实不应推翻已产生的结论；非单调操作才需要协调）。实现落在 `packages/workbench/src/`：

### 2.1 runOnce 单写者（TF-0065）

`runtime/index.ts:337` — 每个运行周期先抢 `run.lock`（`fs/lockfile.ts`，O_EXCL 创建 + pid 存活检查 + 崩溃残留接管）。watcher、`workbench sync`、UI server 的 POST /api/sync 全部漏斗到 `runOnce`；竞争者拿到的不是排队，而是一个诚实的 `{ busy: true, lockHolder }`。这是整个系统里**唯一的全局互斥**，它的作用是把 reconciliation 自身排除出竞争源——否则建议式通知的发起者自己就是竞争者。

锁实现本身经受过专门加固（Fable 5.1 修复项）：新鲜的部分写入视为 contention（1 秒宽限期），超时且内容/mtime 未变的残留才接管，Windows 暂态 `EFAULT`/共享冲突按 contention 重试——有 `fs/lockfile.test.ts` 覆盖。

### 2.2 Blackboard CAS 写前置条件（TF-0064）

`blackboard/goals.ts:81`、`blackboard/interfaces.ts` — `update()` 接受 `expectedVersion` 前置条件：版本不符时抛 `BlackboardConflictError`，**异常对象携带当前值**，调用方（通常是 LLM 驱动的流程）拿到的是可用来重判断的事实，不是裸拒绝。对象级 pid 锁串行化读改写，version 单调递增——这正是 ADR-0006 从 agent-coherence 继承的 **monotonic versioning** 不变量。`interfaces.version` 同时锚定内容 hash，drift 时 re-anchor 并在下一个周期把已 done 的目标标记 stale（`runtime/index.ts:378`），做到"漂移处理绝不追溯改写已完成的目标"。

### 2.3 一条一文件（TF-0064 后半）

队列（`state/queue/<goalId>.yaml`）、裁决队列（`state/tribunal/<id>.yaml`）、足迹（`sessions/<writer>/footprint.jsonl`）都是一对象一文件。这是 ADR-0007 的直接工程化：**把共享可变状态换成可并集合并的文件集**——并发 enqueue 同一目标落在同一文件（幂等），不同目标写不同文件（无丢失更新），没有任何文件级协调开销。

### 2.4 全局因果时钟（TF-0071 / TF-0123）

`events.jsonl` 是唯一真正的 G-Set CRDT。R1 加了单调 seq；Fable 5.1 阶段 A（TF-0123）进一步把**稳定 `id` + `eventSeq` 写进磁盘**、在 PID 锁内分配，修复了"读取时才生成 seq 导致跨进程漂移"的问题（`blackboard/events.test.ts` 有并发实例回归）。足迹镜像行通过 `eventId`/`eventSeq` 与共享时钟对齐，跨写者视图是单日志上的 fold。

### 2.5 操作分类表（ADR-0007 §1）

分类表写进了 ADR 但**没有作为操作注册元数据落入代码**——当前代码里的"单调操作"（追加日志、建文件、上界计数）是隐式遵守的。分类表要求人工维护、无自动判定，这是 ADR 自己承认的税；目前操作种类少，税还没到期。

---

## 三、协调层：建议式并发控制（系统的心脏）

对应 ADR-0006，全部落在 `runtime/`（premises / delivery / seal / merge-guard / durability / read-set-diff）+ `blackboard/sessions|footprint`。这一层的设计立场有明确的实证依据（写进 ADR 并在代码注释里复述）：

- CoAgent 实测：2PL 悲观锁加速比 1.04×（死锁常态化），OCC 乐观重试 0.93×（比串行还慢），建议式 MTPO 1.4× 且正确性损失 ≤5%；
- "Partitioning constrains writes; the bug is in reads" —— 所以记录读集不是审计需求，是**数学需求**（把告警基率从 2% 抬进 10–30% 区间，PPV 才可能 ≥0.7）；
- 产品红线："争取依从，不争取信赖。永远不要把沉默包装成安全保证。"

### 3.1 写者注册与足迹采集（R1，done）

`blackboard/sessions.ts` — 每个能触碰仓库的写者（agent 会话、人、git、CI）注册进 `sessions/` 区。足迹从 claude 的 **stream-json 输出**在 tool_use/tool_result 解析点提取（`blackboard/footprint.ts`：Read/Glob/Grep/LS → used，Edit/Write/MultiEdit/NotebookEdit → generated，Bash 里启发式提取 `cat` 读），每条声明带：

- **内容 hash**（≤2MB；超过记 size）；
- **durability 层级**（R2 谓词第 1 层：`node_modules/dist/build/.git` 等可再生产物直接判 durable，永不进入前提检查——纯精度收益，O(1)）；
- **读跨度**（`offset/limit` 的部分读只记录那几行的 hash，R2 谓词第 2 层）；
- **读时 spool 快照**（≤64KB 的 volatile 文件留底，最近 20 个——这是后来通知里 diff 证据的来源）。

并发安全细节：同一写者的父子 agent 可能并发产出工具结果，`recordActivity` 用 per-writer pid 锁串行化本地镜像与共享事件的顺序（`blackboard/sessions.ts:236`）。

### 3.2 陈旧前提检测：三层谓词（R2，done）

`runtime/premises.ts:304` `reconcilePremises()` 每个 pass：

1. **第 1 层 durability**（`runtime/durability.ts`）：durable 声明直接跳过；
2. **第 2 层跨度重定位**：文件变了不等于读的部分变了——用 `git diff --no-index -U0`（零上下文，精确 hunk）解析 hunks，与读跨度求交；不重叠则按累计位移重定位跨度重新哈希，hash 相同 → 编辑落在别处 → 不通知；
3. **第 3 层导出面**（`runtime/surface.ts`）：只读不写的文件按**依赖式读**处理——只要导出面（签名）不变，函数体改动不构成前提失效；同时被该写者编辑过的文件按**主题式读**处理（内容变了就通知）。关键设计：**依赖/主题不是让 agent 声明的，是从"是否也写了这个文件"推导的**——避免又一次向前者收"声明税"。

失败方向是显式选择的："往精度错，不往召回错"——没有 spool、无法解析 diff、非 JS/TS 文件，一律按失效处理（误报代价是一次额外推理，漏报是下游才发现的静默错误）。跨进程去重用 `(writer, path, currentVersion)` 稳定键写进事件日志，多检测器并发时下一轮收敛。

### 3.3 投递：通道已转向，语义已加固（TF-0077 + Fable 5.1）

**这是实现与 ADR 的最大偏差，也是最值得记录的一次工程裁决**：

- ADR-0006 §5 原定 `CLAUDE_CODE_MESSAGING_SOCKET`（在工具调用之间投递）；
- S0（TF-0066）验证后，`chat/threads.ts:938` 注释明说 "after the messaging socket turned out to be headless-unavailable"——通道整体转向**持久 stream-json 会话**：每线程一个常驻 `claude -p --input-format stream-json` 子进程，`keepStdinOpen`，轮次间通过 stdin 写入追加式用户帧（`turnLine` 保证每帧带换行分隔符），前提通知拼进下一轮提示头部（`promptWithNotices`），KV 缓存红线（只追加、不改历史/系统提示/工具集）由投递侧注释明文维护。

投递语义经 Fable 5.1 收紧：检测与投递**分离**（检测在 watcher 与 UI server 的 15 秒周期里跑，投递只在持有会话 stdin 的进程跑）；通知先进 **durable 队列**（`notices.jsonl` + 稳定 noticeId），`queued` 只表示"已入队"，只有 provider 发出真实成功终止帧后才 ack 清除（`premise_notice_delivered`）；通知有 token 预算（默认 300），先保路径/版本事实再截断 diff，省略数明说。批次 runner（无聊天频道的 batch agent）的通知**保持 pending 而不假装已投递**（`threads.ts:1403`）。

watcher 侧检测已接线（TF-0116 done，`watcher/index.ts:144`），"只写不读"的旧缺口（TFD-700224dabd）已闭合。

### 3.4 封印点：唯一的同步阻塞（TF-0078，done）

`runtime/seal.ts` + `commands/premises.ts:61` — `workbench premises seal` 作为 Claude Code PreToolUse hook：目标文件与该写者的 pending 失效声明重叠时 **exit 2**，stderr 返回的不是拒绝而是**证据**（每个文件读到的版本 → 当前版本 + 指令：先重读、只修补依赖失效值的步骤）。这是整个系统唯一允许打断写者的地方，论证是"向已知失效的区域写下去不是打断，是封印"。

诚实的边界：封印 hook 需要用户在 Claude Code settings 里手工接线（`commands/premises.ts` 注释给出了 JSON）；封印行为本身**没有可观测性**（`seal.decided` 事件是 TF-0134 的内容，被 TF-0123/TF-0124 阻塞，未开工）——即封印现在盲打，无降级模式、无命中率统计。

### 3.5 合并安全网（TF-0079，done）

`runtime/merge-guard.ts` — 刻意便宜的两件事：

1. `git merge-tree --write-tree --name-only` 两两预测真实冲突（配对并发上限 8）——**零误报 by construction**，预测冲突就是真冲突；
2. 写集重叠账本按"稀有度"过滤：只有近期作者数 ≤1（非常共享）的文件上的重叠才告警——避免把人训练成忽略通道。

明确不做的（注释里写明）：语义合并、LLM 解冲突（对开发者一致率仅 55–59%）、约束调度。saga 式补偿（ADR-0006 §1.5 的逆操作注册表 / pivot 分类）**没有通用实现**——补偿路径目前只有 TF-0098 的 checkpoint 双面回退（git 面按 HEAD 还原 + 上下文面按键值回写，无快照明确拒绝）。这是 ADR 承诺与实现之间已知的第二处缩水。

### 3.6 人类通道：裁决队列（R3，done）

`tribunal/` — `notify_human` 从"运行时返回值里的一个数组"变成真正的队列，三件套：

- **ISA-18.2 合理化闸门**（`rationalize.ts`，定性半）：abnormal / consequence / actionable / urgent / distinct 五测，工业界跑这套会删 40–60% 的报警；
- **first-cause 因果折叠**（`queue.ts`）：同一 causeKey 30 分钟窗口内的孪生事件折叠进第一条（一条失效打断 30 个会话 = 1 项带 30 个折叠孪生），更严重的孪生只升不降；定量软阈值在**创建路径**检查，折叠不查（TFD-0c728e7685 修正）；
- **硬性泛滥闸门**：≤6 项/小时、10 分钟内 <10 项、critical 占比 ≤25%，验收数字直接写进 `stats()`。

人类通道保持**二元**（推/不推），拒绝 3–4 级告警——依据 Zirk/Wiczorek/Manzey 2020（保守二元漏报最优、无狼来了效应）与 Wickens & Colcombe 2007（三级系统无收益）。低于门槛的内容走自然边界的**拉取**式软摘要。shelve 有界（5 分钟–4 小时）且 shelve 计数本身是 KPI（"经常被搁置的队列是错分级，不是忙"）。每车道计量（TF-0084）逐轮折叠缓存命中率（先累加再折叠会把命中率算成 100%——TFD-7c94d28e17），lane-distress（压缩次数/连续失败超限）自动挂起车道并转裁决队列。

---

## 四、准入层：多任务同步处理

### 4.1 调度器与车道（里程碑八，done）

`scheduler/tick.ts` — 三策略纯函数 tick：manual（永不派发）/ semi-auto（只建议）/ auto（队列序 × 空闲工位贪心配对，受 `maxConcurrentWorkspots` 上限，默认 2）。工位（workspot）= **git worktree 车道**（`scheduler/dispatch.ts:89`，分支已存在则 checkout）：写集物理隔离。但 ADR-0006 明确引 CoAgent 原话——写侧分区不是答案，读侧才是；worktree 解决的是"两个 agent 别改同一个文件"，读集追踪解决的是"你依赖的事实被别人改了"。

### 4.2 CONWIP 准入：WIP 是推导出来的，不是配置的（TF-0083，done）

`scheduler/wip.ts` — drum-buffer-rope，**复核者是鼓点**：开工快过复核只会制造积压，积压正是上下文腐烂的地方。上限 L = λ × W（Little 定律），λ 是 24 小时窗口实测完成率、W 是实测平均驻留时间（派发→done，>8 小时视为弃置车道剔除），全部从事件日志 join 得来（`goal_dispatched` × `goal_status=done`，重派发按最后一次计）。样本 <3 时**不编数字**：退回物理上限（工位数）并明说 `insufficient-history`（TFD-0dd565fb09）。准入是单一全局令牌池（CONWIP，不用分级限流——分级限流会让各阶段局部最优而饿死鼓点），`--force` 是人类显式插队且只记日志，自动调度器永远没有 force 权。拒绝理由用鼓点自己的语言播报（在制/上限/推导依据/未复核积压）。

### 4.3 进程层：supervisor（S0，done）

`supervisor/index.ts` — 所有 agent 邻接 spawn 走一处：Windows 树杀（`taskkill /T /F`）/ POSIX 进程组杀；argv 数组到底（Windows .cmd shim 是唯一显式 `cmd.exe /d /s /c` 包装）；pid 注册表 + 重启后孤儿收割（`reapOrphans`）；崩溃熔断（60 秒内 3 次异常退出 → 拒绝再派发，OTP 式升级放弃）；stdin 闸门（等 stream-json `init` 帧证明管道活着再写，规避 cmd.exe shim 吞 stdin）。agent runner 的完成状态**先落审计事件再发布 latest.json=done**，消除读者竞态（Fable 5.1 修复项）。

---

## 五、子 agent 方案现状

这是一个**刻意薄**的层，与 L0 要求（"线性对话是默认且不动它"）一致：

1. **足迹归因**：stream-json 的 `parent_tool_use_id`（CLI v2.1.219+ 任意深度透传）把子 agent 的工具调用归到子 agent 名下——一个会话可以携带多个"行动者"，全部记进同一个 writer 的足迹。**子 agent 不是独立调度单元**，没有独立的写者身份、独立的通知通道或独立的 WIP 令牌；它的读写经父 writer 的读集参与前提检查。
2. **fanout 变体**（TF-0094，done）：`chat/fanout.ts`，并发请求 N（1–3）个变体，流式展示第一个，其余挂在消息上一击展开——"生成 N 个、展示 1 个"的加法式自适应，无选择界面。
3. **追溯式 fork**（TF-0093 done + TF-0125 done）：`chat/fork.ts` — 继承声明是硬要求，**transcript / agent context / premise 三类事实显式拆分**（Fable 5.1 修复项）：UI 前缀逐字节继承（`transcriptInherited: true` 是字面量类型，强制每条"不继承"都被声明）；provider 事实 fork 时未观测为 `null`，绝不静默猜测；尾部 fork 生成 `--resume <source> --fork-session` 计划。
4. **分支读集继承**（TF-0131，阶段 C）：未开工，且被 TF-0140（真实 Claude 上下文继承语义裁决）阻塞——"fork 后子分支的读集是否可信继承父分支"这个问题，在拿到一次真实 provider 运行的证据前，设计上拒绝回答。

对照：这套方案**没有** Claude Code 原生 agent-teams 式的多 agent 编排，没有 agent 间消息总线；跨会话协调统一走"黑板事件 + 前提通知"。森林的阶段 C 才是子 agent 并发的真正战场（merge-back、通知预算每轮一束、家族折叠）。

---

## 六、通道与偏差账本（森林如何记录现实）

deviations.jsonl（17 条）是这套策略自我修正的审计痕迹，与并发直接相关的：

| 偏差 | 内容 |
| --- | --- |
| TFD-bb1336dc77 | **本机 git 2.55 拒绝含斜杠的分支名 → 派发链路（worktree 车道）在本机不可用**（TF-0117 已成真） |
| TFD-700224dabd → ae192d22d0 | 检测/投递两半各自"早已存在一半"的缺口，先后补齐并连带修出两个真 bug |
| TFD-386fc39351 | 谓词第 3 层弃用 tree-sitter，改自写词法投影；依赖/主题式判定改为推导而非声明 |
| TFD-0dd565fb09 | WIP 样本不足时退回物理上限并明说，不编数字 |
| TFD-7c94d28e17 | 每车道缓存命中率必须逐轮折叠 |
| TFD-b9eaca2290 | pull 型事件从"抑制"调到"入队不打断"的 low 带，保证合理化后的分布健康 |
| TFD-56f68d0653 | 越权标 done 被撤回（验收 ≠ 单测通过） |
| TFD-06b2b1bd8f | R2 第 1 层代码早已落地而森林记 0%——森林与现实的双向校准 |

---

## 七、legacy Helmor 侧：两个并发的世界

`src-tauri`（ADR-0003 冻结）的并发形态与 workbench 完全不同源：

- **单一 sidecar 进程**：`sidecar.rs` 用 `Mutex<Option<SidecarProcess>>` 持有唯一的 Bun 子进程，按 session 分发事件的 listener 表（`Mutex<HashMap<String, Sender>>`）——GUI 会话间本质是**串行复用**一个 SDK 桥；
- **终端会话各自 PTY**：`session_kind` 区分 terminal/GUI，busy/idle 由 agent 生命周期 hook 驱动，输出经 8ms/16KB 合帧降 IPC 成本；
- **SQLite 单写者** + git watcher 文件监听。

即：legacy 的并发控制 = "一个 SDK 桥 + N 个 PTY + 数据库锁"，**没有任何跨写者协调概念**。这也是 ADR-0003 冻结它的理由——并发策略的主战场从一开始就规划在 workbench 的文件系统黑板上。

---

## 八、风险与差距（按影响排序）

1. **物理车道在本机断路（最高优先）**：TF-0117 已成真。`workspot.branch` 是自由字符串（`types/workspot.ts:30` 仅 min(1)），创建工位不校验分支名合法性，而本机 git 2.55 拒绝含斜杠分支名 → `dispatchGoal` 里 `createWorktree` 失败。**这意味着编码并发的主通道当前只能靠手工规避（无斜杠分支命名），整套建议式并发（R2 检测、封印、merge-guard 的两两预测）没有真实多写者负载可测**——检测器的精度/基率假设全部停留在测试夹具上。
2. **读集覆盖率缺口**：footprint 只覆盖白名单工具 + Bash 的 `cat` 启发式；grep/glob 命中内容、`sed/head/Get-Content` 等读不进读集（实施状态文档明确承认"有限启发式，不能包装成静默安全保证"）。HTTP 纯文本 provider 产不出任何读写集——ADR-0006 已预警"四提供商裁撤三个"，未解。
3. **决策节点悬置**：ADR-0006/0007/0008 三个 proposed 决策节点 + 对应文档都待用户裁决，而实现已 done。需要一次正式裁决（或按 deviations 惯例补记偏差）来消除治理错位。
4. **封印点盲打**：无 `seal.decided` 观测（TF-0134 被阻塞）、无降级模式、hook 需手工接线。封印是唯一同步阻塞点，出错代价不对称，恰恰最需要观测。
5. **saga 补偿缺位**：ADR-0006 §1.5 的逆操作注册表/pivot 分类未实现，补偿只有 checkpoint 双面回退。当前动作面（本地文件 + git）风险可控，但任何 pivot 类动作（push、PR）进入自动化前必须补上。
6. **阶段 C 全线待命**：分支读集继承、merge-back L1、通知预算束、封印观测——全部 proposed 且被证据链阻塞。TF-0140（真实 Claude fork probe）是唯一解 锁路径。
7. **task-forest 自身体量（TF-0147）**：森林自己的 timeline.json 已 64MB（147 节点 / 143 快照 / 65MB 导出），其存储体积口径待答——森林在监管一个关于"存储体量"的问题时自己也长出了同类问题。
8. **14 天日用门未启动**（TF-0141 依赖恢复卡事实段上线），阶段 D 的 fit 裁决没有计时起点。

---

## 九、建议

1. **先修 TF-0117**（工位创建时校验/归一化分支名，或按环境探测约定命名），让派发链路在本机真实可用——这是唯一能让整套建议式并发从夹具走向实测的动作，优先级高于一切新功能。
2. **正式裁决 ADR-0006/0007/0008**，并在 ADR-0006 里补记 socket → stream-json 的通道修订（§5 重写），使文档、森林、代码三方一致。
3. **按实施状态文档的边界推进**：一次最小真实 Claude fork probe（TF-0140）→ 启动 14 天窗口 → 再评估阶段 C 是否值得全量开工；在此之前不扩树、不动 L3。
4. 封印点接线进 TF-0105 的 hooks 分发产物（让默认安装即获得封印），并优先补 `seal.decided` 观测——TF-0123 收口后它就是第一条该落的事件。
5. 读集覆盖按"先命令读、后 HTTP"的顺序扩展，且每一步都以"往精度错"为默认方向，与既有谓词的失败姿态保持一致。

---

## 附：关键实现索引

| 主题 | 文件 |
| --- | --- |
| 单写者互斥 / pid 锁 | `packages/workbench/src/fs/lockfile.ts`、`runtime/index.ts:337` |
| CAS 前置条件 | `blackboard/goals.ts:81`、`blackboard/interfaces.ts`、`errors.ts`（BlackboardConflictError） |
| 写者注册 / 足迹 / 读集视图 | `blackboard/sessions.ts`、`blackboard/footprint.ts` |
| 三层谓词检测 | `runtime/premises.ts`、`runtime/durability.ts`、`runtime/surface.ts` |
| 通知队列与投递 | `runtime/delivery.ts`、`chat/threads.ts:1403`（notifySession）、`ui/server.ts:648`（15s 周期） |
| 封印点 | `runtime/seal.ts`、`commands/premises.ts:61` |
| 合并安全网 | `runtime/merge-guard.ts` |
| WIP 推导与准入 | `scheduler/wip.ts`、`scheduler/dispatch.ts:42` |
| 调度 tick | `scheduler/tick.ts` |
| 裁决队列 | `tribunal/queue.ts`、`tribunal/rationalize.ts`、`tribunal/lane-distress.ts` |
| 进程监督 | `supervisor/index.ts`、`agents/runner.ts` |
| 子 agent 归因 / fork | `blackboard/footprint.ts:251`（parent_tool_use_id）、`chat/fork.ts`、`chat/fanout.ts` |
| 回退安全网 | `runtime/rollback.ts` |
| 实施状态与诚实边界 | `docs/fable-brief/06-implementation-status.md` |

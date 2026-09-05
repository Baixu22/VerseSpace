# Helmor 会话树：开发规划与实现状态报告（审计交接版）

- 日期：2026-09-05
- 目的：向审计 agent 交接「会话树」（thread fork / leave / restore / merge-back 及其前提守护）这条主线的规划全貌与实现真相。所有断言标注了证据来源与复核方式。
- 数据来源：
  - 任务森林：`.agent-workbench/task-forest/graph/nodes.json`（147 节点）+ `graph/edges.json`（209 边）+ `todos/`、`deviations/deviations.jsonl`（17 条）
  - 代码：`packages/workbench/src/`（逐文件核实）、`apps/workbench-ui/`
  - 文档：`docs/fable-brief/`（00–06，含 `06-implementation-status.md`）、`docs/decisions/` ADR-0001..0009、`docs/report-2026-09-05-concurrency.md`
- 本报告作者的独立复核（2026-09-05 实测）：
  - `cd packages/workbench && bun test --timeout 60000` → **421 pass / 0 fail**，59 files，33.55s（含当前工作区未提交改动）
  - `git log`、`git diff --stat`、关键源码逐文件阅读；本机 `.workbench/` 实地检查

---

## 结论先行

1. 会话树主线是 **TF-0057（前提守护者）→ TF-0120（Fable 5.1 收敛）**，下分阶段 A/B/C/D。当前：**阶段 A 9/11 done、阶段 B 1 done + 1 进行中（55%）+ 1 未开工、阶段 C/D 全部未开工且被证据链刻意阻塞**。整体森林 147 节点：107 done / 34 proposed / 5 in_progress / 1 ready（2026-09-05 实测计数）。
2. 架构定位一句话：**会话树不是一棵要导航的 UI 树，而是「一条日志、两类事实、三个投影」里的会话侧事实流**。TF-0120 的 non-goals 白纸黑字：不做树导航 UI、不做内容级 merge-back、不做每会话结构化仪式、不让调度器依赖线程拓扑。
3. 最需要审计注意的真相是**规划状态与工作区状态双向漂移**：
   - TF-0145（contextgen 载荷上限）今天被标 done，但其实现**仍在工作区未提交**——与 TF-0144 确立的「提交闸门」纪律存在时序差；
   - TF-0128（双通道恢复卡）森林记 55%，但工作区已包含其证据栏所列全部四个缺口的实现与测试（R1–R9 冲突规则、分区、refs、dismiss 抑制）——这是 TFD-06b2b1bd8f（代码领先于森林）的反向重演；
   - TF-0120/TF-0121 两个里程碑的 `progress` 字段仍是 0，与实际大幅推进不符。
4. **两周真实使用观察窗（TF-0141）的 t0 尚未开始**：实测本机 `.workbench/` 无 `threads/` 目录、`events.jsonl` 仅 15 行（最后活动 2026-08-30，全部来自 MVP 自举测试）。阶段 D 的一切 fit 裁决当前样本量为 0。
5. 解锁阶段 C 的唯一钥匙是 **TF-0140（真实 Claude fork probe）**：当前 Claude fresh fork 不继承 agent 上下文是「假设 + fake CLI 证据」，没有一次真实运行时裁决之前，分支读集继承（TF-0131）按设计拒绝开工。

---

## 一、规划谱系：这条线是怎么长出来的

### 1.1 根节点与两支柱

**TF-0057 [global_task, in_progress]**「前提守护者：协调运行时（v5）+ 追溯式交互层（v6）」

- 目的：让单人开发者在多写者（agent／人／git／CI）并发下，前提不失效、注意力不被淹没，且无需前置声明任何结构。
- 验收：v5/v6 证伪实验各跑一轮有记账；R1 验收（会话结束能回答读了哪些文件的哪个版本）；L1 验收（地标 80% 是用户认可的核心）。
- 明确不做：a2a 多 agent 互聊协议、手动 DAG 编辑器、画布界面、取代对话的工作台、Verifier 加 LLM 裁判。
- 执行顺序约束（hints）：阶段 A 三件并行（TF-0122/0123/0125）；阶段 B 开始前必须收口事件身份与继承事实；阶段 C 只在阶段 B 完成后进入。

### 1.2 交互层 L 线（会话树的行为学约束来源）

| 节点 | 内容 | 状态 | 关键约束 |
| --- | --- | --- | --- |
| TF-0085 [requirement] | **要求 L0：线性对话是默认且不动它** | proposed（常设要求） | 新增任何交互功能，不增加发出第一条消息前的任何步骤 |
| TF-0086 里程碑 L1 | 隐式上下文层（Mylyn DOI） | done | 交互事件日志（6 字段）、DOI 重置规则、地标投影 |
| TF-0090 里程碑 L2 | **晋升、分叉与恢复（加法式的一层）** | done | 接受任何提议后，对话滚动位置与内容排布不变 |
| TF-0099 里程碑 L3 | 显式衍生产物（N=2 推导、重放验证） | proposed, p5 | 最后建、最容易砍；无法通过执行检查的产物一律不建 |

L2 的七个叶节点（TF-0092..0098）全部 done，是会话树的直接前身：加法式晋升（TF-0092）、追溯式分叉零仪式（TF-0093，`chat/fork.ts`）、fanout 变体生成 N 展示 1（TF-0094，`chat/fanout.ts`）、系统提议下一步 + 决策账本（TF-0095，`chat/suggest.ts` + `chat/ledger.ts`）、切换时自动关闭（TF-0096）、离开时生成恢复笔记（TF-0097，`chat/resume.ts`）、回退 + diff 安全网（TF-0098，`runtime/rollback.ts`）。

### 1.3 并发 R 线（会话树的证据基础设施）

S0/R1/R2/R3/R4 里程碑全部 done（TF-0061/0068/0073/0080/0102）：runOnce 单写者、CAS 写前置条件、写者注册与 stream-json 足迹、三层陈旧前提谓词、通知投递、封印点、合并安全网、裁决队列、CONWIP 准入。这部分的全貌见 `docs/report-2026-09-05-concurrency.md`（2026-09-05，另一份交接文档），本报告只引用不重复。

### 1.4 收敛：TF-0120（Fable 5.1）

**TF-0120 [milestone, in_progress]**「Fable 5.1 前提守护收敛：交互 / 会话树 / 并发统一」

- 目的：把三支柱从并列子系统收敛为**「一条日志、两类事实、三个投影」**的前提守护架构，后续开发以此为主线。
- 一条日志 = `events.jsonl`（单调 eventSeq + 稳定 eventId）；两类事实 = 世界事实（读写集/前提）与会话事实（thread.* 生命周期）；三个投影 = 前提 reconcile（premises）、投递（delivery）、上下文生成（contextgen）——外加调度 WIP 投影只读世界侧。
- 验收 6 条：事件身份跨进程稳定；恢复卡叙事与事实同呈且事实优先可溯源；fork 的 transcript / agent context / premise 继承分开声明；merge-back 只作为恢复卡一拍；通知有每轮预算与家族折叠；用真实使用数据给 L3 砍留结论。
- **Non-goals（审计者应据此核查一切实现是否越界）**：不做树导航 UI；不做内容级 merge-back；不做每会话结构化仪式；不让调度器依赖线程拓扑。
- 关键假设（自述）：Fable 5.1 文献引用未重新联网复核；当前仓库没有可用的真实分叉样本；Claude fresh fork 不继承 agent 上下文、HTTP 有历史但无足迹；**阶段 A 的实现已在工作区完成但未提交，基线以 TF-0144 提交闸门为准**（注：TF-0144 已于 2026-09-04 落地 7 个提交，但今天又有新的未提交改动，见 §六）。

### 1.5 悬置的决策与问题

| 节点 | 内容 | 状态 | 要点 |
| --- | --- | --- | --- |
| TF-0146 [decision] | 是否提供「以分支为主线」（adopt）手势 | proposed | TF-0132 的 summary 提到 adopt，但全仓库无 `thread.adopted` 事件、无 UI、无验收项——无主承诺，要么补齐要么删除 |
| TF-0147 [question] | task-forest 历史与派生产物的体量口径 | proposed | 实测 events.jsonl 66.5MB/142 行、snapshots 58MB、exports 106MB；GitHub 已发 GH001 大文件警告。本轮重新导出的 exports 已按此暂缓提交 |
| TF-0058/0059/0060 [decision] | ADR-0006/0007/0008（建议式并发、单调优先、结构从执行推导） | proposed | **实现这些决策的里程碑 S0–R3 已全部 done**，治理错位待正式裁决（deviations 有先例：TFD-56f68d0653 越权标 done 被撤回，说明这是刻意姿态而非遗漏） |

---

## 二、TF-0120 的波次计划与当前状态总表

规划侧的波次（TF-0120 execution hints，估时按叶子上卷，全主线 5640 分钟）：

| 波次 | 节点 | 估时 | 当前状态 |
| --- | --- | --- | --- |
| 1 | TF-0143 写路径预算；并行 TF-0142 通道语义、TF-0146 adopt 裁决；收口 TF-0122/0123/0125 | 1320min | TF-0143/0142/0122/0123/0125 done；TF-0146 未裁决 |
| 2 | TF-0144 提交闸门、TF-0124 投影边界、TF-0127 R2′、TF-0140 继承实验、TF-0133、TF-0137 | 1680min | 0144/0124/0127 done；0140/0133/0137 未完成 |
| 3 | TF-0128 恢复卡、TF-0139 埋点、TF-0145 contextgen 上限、TF-0131、TF-0132、TF-0134 | 1860min | 0139/0145 done；0128 进行中；0131/0132/0134 未开工 |
| 4 | TF-0129 覆盖率行、TF-0138 ADR | 360min | 均未开工 |
| 5 | TF-0141 登记日用起点（两周窗口从此刻才开始计时） | 180min | 未开工（t0 未开始） |
| 6 | TF-0136 L3 证据门 | 240min | 未开工 |

阶段归属与节点状态（2026-09-05 实测自 nodes.json）：

| 阶段 | 里程碑 | done | in_progress | proposed |
| --- | --- | --- | --- | --- |
| A 证据与架构地基 | TF-0121 (in_progress) | TF-0122, 0123, 0124, 0125, 0139, 0142, 0143, 0144, 0145 | — | TF-0140, 0141 |
| B 恢复处境 | TF-0126 (proposed) | TF-0127 | TF-0128 (55%) | TF-0129 |
| C 分支与并发收敛 | TF-0130 (proposed) | — | — | TF-0131, 0132, 0133(25%), 0134 |
| D fit 门与范围仲裁 | TF-0135 (proposed) | — | — | TF-0136, 0137, 0138 |

注意三处里程碑状态与内容的错位：TF-0121 标 in_progress 但其 11 个子节点里 9 个 done；TF-0126 标 proposed 但 3 个子节点已 1 done + 1 进行中——森林的里程碑进度字段（`progress`）与子节点状态不同步，属进度记账债，不是事实矛盾。

---

## 三、阶段 A：已落地什么、怎么落的（含提交哈希）

阶段 A 的闸门是 **TF-0144**（提交闸门）：先在工作区完成实现，再以「一节点一提交」落库并对齐森林。实际落地为 7 个提交（分支 `feat/premise-custody-phase-a`，随后合并回 main）：`28a0d91`（CI PAT 回退）、`d79a5c2`（ignore 规则）、`8b960ff`（事件身份+投影边界+批量追加）、`d7e262d`（通知身份+预算配置）、`087c553`（fork 继承+生命周期事件）、`b5720ed`（恢复复读集+恢复卡）、`836e27f`（stats 基线）。闸门当时实测：test 全绿、`tsc --noEmit` 0 退出、biome 1081 文件无错误。此后又有三个后续提交：`b9e7f7a`（TF-0142 通道语义钉死为 queue-and-fold）、`b6561a9`（TF-0123 跨进程事件身份测试）、`c161f65`（森林状态对齐）。

### 逐节点：状态、实现位置、验收证据

**TF-0122 stats fold（done）** — `chat/stats.ts`（431 行）+ `commands/stats.ts` + CLI 注册，提交 `836e27f`。
只读统计：fork/week、fork 深度、兄弟交替、恢复笔记覆盖率、足迹覆盖率；支持 `--json` 供 fit 账本消费；不产生任何新事件。按 `thread.forkOf` 聚合（刻意不用会被 reload 污染的 `meta.forks`）。不可测时返回 `available:false` / `insufficient-history`，不编数字。

**TF-0123 稳定事件身份与因果时钟（done，2026-09-05 收口）** — `blackboard/events.ts` + `fs/atomic.ts`，提交 `8b960ff` + `b6561a9`。
稳定 `id` + `eventSeq` 写进磁盘、在 PID 锁内分配（锁内读行数再分配 seq），修复「读取时才生成 seq 导致跨进程漂移」。跨进程测试：Bun.spawn 3 子进程 × 8 条与父进程 10 条真 pid 锁竞争追加，重复 5 次稳定（234–283ms）。旧日志兼容视图保留；读侧单次线性扫描无 O(n²)；足迹镜像行经 `eventId`/`eventSeq` 与共享时钟互引。

**TF-0124 会话生命周期事件与投影边界（done）** — `types/event.ts` 白名单 + `blackboard/events.ts` schema 校验，提交 `8b960ff`。
10 种 `thread.*` 事件类型注册白名单（`thread.created/forked/left/restored/switch/resume_note_consumed/inheritance_observed/resume_action/merged_back`，实测 `types/event.ts:30-40`）；`FORBIDDEN_THREAD_KEYS`（status/verdict/done/passed/success/completed）拒绝状态机结论混入；未知线程事件类型直接抛错（实测 `thread.merged_back_v2` 拒绝）。**世界投影不读会话拓扑**有四个消费者的 fold 测试证明：premises（5 条 thread.* 在场时 reconcile 结果不变）、delivery（pending 逐字不变）、scheduler/wip（observeFlow 前 toEqual 相等——λ×W 只读 goal_dispatched/goal_status）、contextgen（过滤后不进 `.agent-context.md`）。

**TF-0125 fork 继承事实拆分（done）** — `chat/fork.ts` + `chat/threads.ts`，提交 `087c553`。
消除「UI 前缀已复制」被误当「模型上下文已继承」的架构谎言：`ForkInheritance` 三事实（transcript / agentContext / premise），`transcriptInherited: true` 是字面量类型强制逐条声明，provider 事实 fork 时未观测为 `null` 绝不静默猜测；首跑只在 `null` 时补写一次 `thread.inheritance_observed`；`ForkAgentPlan` 预留 `--resume <source> --fork-session` 路径（语义裁决归 TF-0140）。

**TF-0139 会话观测埋点（done）** — `chat/threads.ts`（实测 269/379/478/665/695/705/714/720 行处的 appendThreadEvent 调用），提交 `087c553` + `b5720ed`。
切换线程落 `thread.switch`、返回落 `thread.restored`、展开恢复卡落 `thread.resume_note_consumed`、UI 动作落 `thread.resume_action`；无真实使用不伪造样本。事件名以代码为准，提案期的 `restore_card_expanded` 等已废弃。

**TF-0142 通知通道语义（done，2026-09-05）** — `chat/threads.ts` notifySession（实测 1380–1460 行区域），提交 `b9e7f7a`。
钉死 queue-and-fold：通知永不写 live stdin，先进 durable 队列（`notices.jsonl` + 稳定 noticeId），`premise_notice_queued.reason` 记录 `turn-in-flight` / `next-user-turn`，下一轮折叠进提示头部，provider 真实成功终止帧后才 `premise_notice_delivered` 落账。批量写者（无聊天频道）保持 pending 不假装投递；HTTP 显式 `readObservability: unobservable`。6 个通道语义测试覆盖。

**TF-0143 足迹追加写路径预算（done）** — `fs/atomic.ts` appendJsonlLines + `blackboard/events.ts` appendMany + `sessions.ts` recordActivity 单批。
before 9.03 ms/activity → after **4.41 ms/activity**（2.05×）；批内 eventSeq 连续、任一成员校验失败不留部分写入（两条回归测试）；套件 43.19s → 34.22s。顺带修掉 checkpoints.ts 绕过锁与游标的裸 append。更正记录在案：先前「默认超时导致套件红」是裸跑 `bun test` 绕过 package.json 的 `--timeout 60000`（TFD-75ba0195c9）。

**TF-0144 提交闸门（done）** — 见上文 7 提交。其第四条验收「exports 单独提交或先 gitignore」因 TF-0147 体量问题处于暂缓状态。

**TF-0145 contextgen 世界事件载荷上限（done，2026-09-05，⚠️ 未提交）** — `contextgen/render.ts`（`DEFAULT_EVENT_LINE_CHARS = 400`、逐行截断）+ `types/config.ts`（`contextgen.eventLineChars` schema，默认 400，可配）。
验收测试：1MB payload（JSON.stringify 回退路径）逐行 ≤400、全文不含 marker；1MB 世界事件生成的 `.agent-context.md` < 20K；`generate.test.ts` / `render.test.ts` 各 +64 行。**本文作者今日实测 421 pass / 0 fail 含这些测试，但 `git diff --stat` 显示该实现仍在工作区未提交**。

### 阶段 A 未完成的两项

**TF-0140 Claude 真实上下文继承与前缀匹配裁决（proposed，阶段 C 的解锁钥匙）**
当前只有：本机 claude 2.1.251 `--help` 含 `--fork-session`（resume 时新建 session id）；代码承认前缀偏差（reload 后铸新 session id 的理由即 "claude resume context diverges after truncation"）；fork.ts 已预留 ForkAgentPlan。没有：任何一次真实 provider 运行的证据。计划是最小 10 分钟上下文知情实验，再评估精确重放 / superset 继承 / 否决继承三选一。

**TF-0141 日用起点与两周观察窗口（proposed）**
实测（2026-09-05 作者复核）：本机 `.workbench/` 无 `threads/` 目录、`events.jsonl` 15 行、最后活动 2026-08-30——t0 未开始。唯一历史线程在另一仓库（2 条、0 分叉、0 足迹，早于 fork/恢复功能）。stats 当前如实输出 `insufficient-history`。

---

## 四、阶段 B / C / D：恢复处境与未来战场

### 阶段 B（TF-0126，恢复处境）—— 进行中

**TF-0127 恢复时读集 diff R2′（done）** — `runtime/read-set-diff.ts`（372 行）+ 接入 `ui/server.ts` 线程 GET，提交 `b5720ed`。
离开基线 `leaveSignature = (footprintSeq, eventSeq, eventId)`，由 `threads.ts leave()` 落盘（实测 threads.ts 460–494 行：leave 时 append `thread.left` 并把三元组写进 note）。返回时锚点与足迹用 toolCallId 精确 join，每个失效前提带 observed/current version 与推定写者；spool 轮转后降级为仅版本号（明确降级，不假装可用）；`comparable / uncoveredTools / compared` 分开报告供 TF-0129 消费。

**TF-0128 双通道恢复卡（in_progress 55%，⚠️ 工作区领先于森林）** —
森林证据栏（2026-09-04 06:51）记录：已提交 b5720ed 完成 sidecar 挂载与 store 侧 consume/dismiss/resume-action 路由；剩余四个缺口：事实段与叙事段分区、每行 refs、冲突标注规则、一次 dismiss 后的注入抑制。
**但当前工作区（未提交）已包含这些缺口的完整实现**：
- 新文件 `packages/workbench/src/chat/resume-card.ts`（398 行）：`ResumeCardView` 双通道结构（narrative + facts 分区、事实优先）、冲突规则 R1–R9（R1 无变化/R2 被改写/R3 被回滚/R4 已删除/R5 已移动/R6 decided 无注解/R7 晋升已撤销/R8 next 前提已变/R9 无 refs 的 shifted 省略）、`isResumeCardDismissed` dismiss 抑制（按 eventSeq 比较 leave 边界，新的 thread.left 重开卡片）、facts 无 refs 即丢弃、空卡不渲染；
- 测试 `chat/resume-card.test.ts`（新文件，18 个用例覆盖 R1–R9、dismiss 重开、legacy notes）；
- 路由 `ui/server.ts` GET `/api/chat/threads/:id` 组装 readSetDiff + resumeCard + dismissed（实测 438–476 行），`resume-note/consume|dismiss`、`resume-action` POST 路由齐备；
- UI 侧 `apps/workbench-ui/src/components/chat/resume-card.tsx`（196 行改动）与 `store.ts`（59 行改动）。
审计者应实测后把 TF-0128 状态对齐——这是 TFD-06b2b1bd8f（「代码早已落地而森林记 0%」）的镜像问题。

**TF-0129 恢复覆盖率行（proposed）**
防止「没消息」被误读为「安全」：卡片永不出现安全/无变化措辞；无覆盖时显示未知范围；覆盖率由 TF-0127 的 comparable/uncoveredTools 派生；Grep/Glob 的 version:null 目录 claim 必须剔除（审计 D1 发现其 reconcile 恒判未变，会虚高覆盖率）。

### 阶段 C（TF-0130，分支与并发收敛）—— 全部未开工，被证据链阻塞

| 节点 | 内容 | 前置 |
| --- | --- | --- |
| TF-0131 | 分支读集继承与诚实开关：仅 `agentContextInherited=true` 才写 `footprint.inherited` | **TF-0140（真实继承语义裁决）** |
| TF-0132 | merge-back L1：恢复卡上的分支摘要（指针级，不做内容合并） | TF-0146（adopt 裁决）；注意其验收项「thread.merged_back 注册白名单」**已随 TF-0124 提前满足**（types/event.ts:38），节点证据栏「白名单当前无 merged_back」已过时 |
| TF-0133 | 通知预算：每轮一束 + 家族折叠 | 部分前置已落地：稳定 noticeId + token 预算截断（省略 footer 明说）已在 `d7e262d` 提交，`runtime/delivery.ts` renderNotice 实测按预算裁 diff、保留事实行；**真正缺口是每轮一束（同 writer 一轮合并为一条）与家族折叠（三路分叉不逐文件洪泛）**，节点证据栏「renderNotice 仍内嵌完整 diff」相对现状已部分过时 |
| TF-0134 | 封印观测与降级：`seal.decided` 事件、block/warn/off 模式 | TF-0123/0124 已收口，可开工；实测 `runtime/seal.ts` 当前不追加任何事件（封印盲打） |

阶段 C 的架构语境（TF-0132 证据栏实测）：所有线程共享同一 `projectRoot`，fork 不建 worktree/分支——所以 merge-back 只能是摘要/指针语义，`git merge-tree` 预测对线程不适用；这也使 TF-0146 的 adopt 只能是指针语义而非分支切换。

### 阶段 D（TF-0135，fit 门与范围仲裁）—— 全部未开工，被 t0 阻塞

- **TF-0136** 两周真实使用门与 L3 证据门：原门槛（promotion_reverted / variant.promoted）已实测结构性为零并删除；新门槛全部依赖 TF-0139 的观测事件与 TF-0129 的事实段，窗口起点必须晚于事实段上线，否则重复同一类错误。
- **TF-0137** fit 账本：实测全图 142 节点 fit=unknown 140、aligned 2；TF-0120..0146 的 fit_confidence 全为 0（有意保留的未知）。
- **TF-0138** ADR-0010 前提守护架构与产品边界：等 TF-0123/0125/0140/0145 收口后定稿，先 proposed 入库。

---

## 五、已落地能力 → 代码索引（审计者快速定位）

| 能力 | 文件 | 提交 |
| --- | --- | --- |
| 线程模型与生命周期事件（10 类白名单 + 校验） | `packages/workbench/src/chat/threads.ts`（1928 行）、`types/event.ts:30-48` | 087c553, 8b960ff |
| 追溯式分叉与三事实继承声明 | `chat/fork.ts`（124 行） | 087c553 |
| 恢复笔记（3-5 节拍，离开时生成） | `chat/resume.ts`（205 行） | 34983d9, b5720ed |
| 恢复时读集 diff（R2′） | `runtime/read-set-diff.ts` | b5720ed |
| 双通道恢复卡（R1–R9 冲突规则） | `chat/resume-card.ts`（新，未提交）、`ui/server.ts:438-476`、`apps/workbench-ui/src/components/chat/resume-card.tsx` | 工作区 |
| 使用观测（switch/restored/consume/action） | `chat/threads.ts` + 消费方 `chat/stats.ts` | 087c553, 836e27f |
| 只读统计基线（fork/week、深度、兄弟交替） | `chat/stats.ts` + `commands/stats.ts` | 836e27f |
| 事件身份与因果时钟（跨进程） | `blackboard/events.ts` + `blackboard/events.test.ts` | 8b960ff, b6561a9 |
| 写路径批量追加（4.41 ms/activity） | `fs/atomic.ts`、`blackboard/sessions.ts` | 8b960ff 系 |
| 通知 queue-and-fold 语义 | `chat/threads.ts` notifySession、`runtime/delivery.ts` | b9e7f7a, d7e262d |
| 世界投影边界（thread.* 不进四消费者） | `runtime/premises.test.ts`、`scheduler/wip.test.ts`、`contextgen/render.test.ts`（fold 测试，工作区/已提交混合） | 8b960ff + 工作区 |
| contextgen 载荷上限（400 字符/行） | `contextgen/render.ts`、`types/config.ts` | 未提交 |
| 恢复相关 UI 路由 | `ui/server.ts`（threads/fork/leave/switch/restore/resume-note/resume-action 全套） | 087c553, b5720ed + 工作区 |

上游参照：交互层设计文档 `docs/positioning-v6.md`；收敛审计 `docs/fable-brief/`（00–05）与实现状态 `docs/fable-brief/06-implementation-status.md`（基线 3cd9f54，385 pass——注意其数字早于当前工作区的 421）。

---

## 六、规划与现实的偏差清单（审计重点，按严重度排序）

1. **TF-0145 标 done 但实现未提交**（2026-09-05 06:40 标 done；`git diff --stat` 实测 render.ts/config.ts/generate.test.ts/render.test.ts 在工作区）。测试已由本文作者跑绿（421/0），但违反 TF-0144 确立的「森林状态与工作区一致」纪律的时序要求。裁决建议：先提交再审计。
2. **TF-0128 状态滞后于工作区**：森林 55% + 四个缺口，工作区代码与测试显示缺口已闭合（见 §四）。属 TFD-06b2b1bd8f 的反向（这次是森林落后）。
3. **里程碑进度记账债**：TF-0120 与 TF-0121 `progress=0`，TF-0126 proposed，与其子节点实际状态不同步（`progress_source: manual` 未更新）。
4. **节点证据栏的时点性过时**（两处实测）：TF-0132 说「白名单无 merged_back」——已被 TF-0124 补上；TF-0133 说「renderNotice 仍内嵌完整 diff、预算无人强制」——`d7e262d` 后 renderNotice 已按预算截断并带省略 footer。审计时应以代码现状为准，而非节点 evidence 字段。
5. **治理悬置**：ADR-0006/0007/0008 三个决策节点 proposed 而实现 done；TF-0146（adopt）与 TF-0147（森林体量）待裁决。TF-0147 已产生实际后果：本轮重新导出的 exports（timeline.json 15667 行 diff）按其建议暂缓提交。
6. **文档基线漂移**：`docs/fable-brief/06-implementation-status.md` 记 385 pass（2026-09-04 基线 3cd9f54），当前工作区 421——文档是时点快照，非实时状态，审计时应注明基线。
7. **会话树 ≠ git 树**：线程共享 projectRoot、fork 不建 worktree（TF-0132 证据实测）。「分支」全部是对话级概念；任何把会话树当作 git 分支树审计的预设都会得出错误结论。

## 七、诚实边界：当前不能宣称的东西

以下均为节点自述 + 本文作者抽查确认的「未证实」状态，审计者不应允许任何「全绿测试 = 方案成立」的推论：

1. **真实 Claude 上下文继承**（TF-0140）：零真实运行证据；fresh fork 不继承 agent 上下文是假设；`--fork-session` 只有 fake CLI argv 检查 + 本机 `--help` 能力核对。
2. **HTTP provider 足迹**：无真实工具执行，`footprint.inherited` 不能被解释为 HTTP 已验证。
3. **恢复卡的省时效果**（TF-0129 的动机）：无任何真实用户数据；本机样本量为 0（§二、TF-0141）。
4. **L3 显式衍生产物**：全仓库无 `promotion_reverted` / `variant.promoted` 事件，证据门结构性为零，节点刻意 proposed p5。
5. **读集覆盖率**：grep/glob 命中内容、`sed/head/Get-Content` 等不进读集（有限启发式，`06-implementation-status.md` 明文承认「不能包装成静默安全保证」）。
6. **封印点可观测性**：`runtime/seal.ts` 不追加任何事件（TF-0134 未开工），封印盲打、无降级模式、hook 需手工接线。
7. **桌面运行时验收**（Tauri/Electron/browser）：未执行；本轮与阶段 A 的全部验证仅覆盖 workbench package 与 UI bundle。

## 八、建议的下一步顺序（由森林 execution hints 与实施状态文档汇合而成）

1. **先提交工作区**（TF-0145 + TF-0128 的实现与测试），把森林 TF-0128/0145/0120/0121 的状态与 progress 对齐——恢复「一节点一提交、森林与工作区一致」的基线纪律。
2. **TF-0140 最小真实 Claude fork probe**（明确授权与凭据下；失败也要留结果）——这是阶段 C 唯一解锁路径。
3. **TF-0128 收口 → TF-0129 覆盖率行 → 阶段 B 收口**（TF-0126 转 done）。
4. **TF-0141 登记日用起点**，两周窗口从事实段上线后起算；期间 stats 持续产出（当前如实 `insufficient-history`）。
5. **TF-0146 / TF-0147 两个裁决**（adopt 手势去留；森林体量口径），外加 ADR-0006/0007/0008 的正式裁决与 ADR-0006 §5 的 socket→stream-json 通道修订补记。
6. 满两周后 **TF-0136 L3 证据门**，再定阶段 C 全量开工范围与 TF-0138 ADR 定稿。

## 九、给审计 agent 的复核命令

```bash
# 测试（本文 2026-09-05 实测：421 pass / 0 fail, 59 files, 33.55s）
cd packages/workbench && bun test --timeout 60000
# 注意：裸跑 bun test（不带 --timeout）会因本机文件删除慢出现假红——TFD-75ba0195c9

# 类型与 lint
cd packages/workbench && bunx tsc --noEmit && bunx biome check src

# 任务森林节点详情（本报告的节点状态/证据/AC 全部出自此处）
bun -e 'const n=JSON.parse(await Bun.file(".agent-workbench/task-forest/graph/nodes.json").text());' # 结构见 config.json schema_version=1

# 工作区未提交改动（TF-0145/TF-0128 相关）
git diff --stat -- packages/workbench/src apps/workbench-ui
git status --short

# 会话树实现抽查
sed -n '30,48p' packages/workbench/src/types/event.ts          # thread.* 白名单
grep -n appendThreadEvent packages/workbench/src/chat/threads.ts # 生命周期事件落点
sed -n '438,476p' packages/workbench/src/ui/server.ts           # 恢复卡组装路由

# 本机使用数据（t0 未开始的证据）
ls .workbench/ && wc -l .workbench/events/events.jsonl
```

审计时的三个已知陷阱：
1. **节点 `evidence` 字段是历史陈述**，存在时点性过时（§六.4），一切以代码现状 + 你自己复跑的测试为准；
2. **测试必须带 `--timeout 60000`**，否则会出现已记录在案的假红；
3. **工作区有未提交改动**——你看到的代码状态可能新于任何提交、也新于森林节点状态，先 `git status` 定格时点再下结论。

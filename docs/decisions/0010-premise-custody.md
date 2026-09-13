# ADR-0010：前提守护架构与产品边界

- 状态：已接受（2026-09-06 完成阶段 A 代码与测试复核）
- 日期：2026-09-05
- 收敛：ADR-0006/0007/0008 的工程边界；其中 socket 投递、通用 saga、自动分类与 L3 开工承诺由本文取代，调研原文保留。
- 森林节点：TF-0138（父：TF-0121 阶段 A；主线 TF-0120 → TF-0057）
- 相关：[`positioning-v5.md`](../positioning-v5.md) · [`positioning-v6.md`](../positioning-v6.md) ·
  [`fable-brief/05-review/D2-Q1-unified-abstraction.md`](../fable-brief/05-review/D2-Q1-unified-abstraction.md) ·
  ADR-0006（建议式并发）· ADR-0007（单调优先）· ADR-0008（结构从执行推导）· ADR-0009（提议区间为空）

## 一句话取舍标准

> **Helmor = 写者中立的前提账本。**
> agent 走 **R2 + stdin 通知**，人走 **R2′ + 恢复卡**，两者都答不了的走 **裁决队列**。

任何新功能先过这一句：它服务哪一类写者、走哪一条通道、答的是不是「你上次看到的东西现在还成立吗」。
三条通道之外的东西不是这个产品的。

## 背景

三支柱（交互 DOI、会话树、并发前提）此前是三个并列子系统，各自有事件、各自有状态。
TF-0120 要求把它们收敛成一个架构，否则每加一个功能都要在三处重复决定同一件事。
`fable-brief/05-review/D2-Q1` 的结论是：**可以统一，但统一的对象是「日志」而不是「语义」**。
本 ADR 把那个结论连同阶段 A 的实测结果固化成边界，防止后续开发滑回编排器或树导航。

## 决策

### 1. 一条日志、两类事实、三个投影

- **一条日志** = `events.jsonl`。单调 `eventSeq` 在持有追加锁时分配、稳定 `id` 写一次不再派生
  （`src/types/event.ts:7-23`，TF-0123）。`seq` 只保留为物理行号兼容视图。
- **两类事实** = 世界事实（读写集、前提、构建）与会话事实（`thread.*` 生命周期）。
  分两类而不是一类，因为两者的**非单调性位置不同**：世界事实的非单调性在「状态」，
  会话事实的在「注意力」，衰减函数不同，不能共用一个投影。
- **三个投影** = 前提 reconcile（`src/runtime/premises.ts`）、投递（`src/runtime/delivery.ts`）、
  上下文生成（`src/contextgen/`）。调度 WIP 投影只读世界侧。

**方向性不变量（硬约束）：世界投影只折叠世界事件；会话事件可以引用世界事件，世界事件永不引用会话事件。**

证据：`isWorldEvent()`（`src/types/event.ts:111-117`）同时按 `source !== "threads"` 与
`!type.startsWith("thread.")` 两条件过滤——命名边界与类型边界都拦一次，任一条漏写都拦不住。
执行点是 `src/contextgen/generate.ts:26` 与 `src/contextgen/render.ts:63`：世界投影在入口就把
会话事件滤掉，不靠调用方自觉。
「一个线程不是一条车道」由此从存储边界变成投影过滤器（TF-0118 的新家）。

### 2. 命名边界：`source=threads` 是会话事实，其余是世界事实

会话生命周期事件一律 `source: "threads"`（`THREAD_EVENT_SOURCE`，`src/types/event.ts:25`），
类型收在一个白名单里（`THREAD_EVENT_TYPES`，同文件 28-39 行）——未知 `thread.*` 直接抛错，
不给「先写进去以后再说」留口子。

**会话事件只记观测，永不记裁决。** `validateThreadEvent()` 在信任边界上递归拒绝
`status / verdict / done / passed / success / completed` 任一字段
（`FORBIDDEN_THREAD_KEYS`，`src/types/event.ts:41-107`），追加路径在
`src/blackboard/events.ts:237,303` 两处强制调用。理由：一旦生命周期事件能带结论，
会话侧就成了第二个状态机，方向性不变量当场失效。

`source=sessions` 保留给写者足迹：`src/blackboard/sessions.ts` 的 `recordActivity()`
仍以此来源追加 `type=footprint`，它记录文件读写，属于**世界事实**。
线程创建、分叉、离开与恢复使用 `source=threads`，属于**会话事实**。
两者不能按名字合并，也不能把所有 `sessions` 事件一并从世界投影排除。

### 3. 世界事件进工位上下文必须有载荷上限

`contextgen` 渲染世界事件时按**每事件**截断，默认 400 字符
（`DEFAULT_EVENT_LINE_CHARS`，`src/contextgen/render.ts:21-23`，TF-0145），
配置键 `contextgen.eventLineChars`。通知侧同理：一束通知有 token 预算（默认 300），
裁剪顺序是先砍 diff、再砍文件列表、保留总数（`src/runtime/delivery.ts:43-147`）。

理由：**上下文体量不得随载荷体量增长。** 一次 `git diff` 的 maxBuffer 是 1MB，
没有上限就等于允许一条事件吃掉整个工位上下文。

### 4. 禁止内容级合并

**merge 时刻是错误的用力点**，真正的功夫在上游——把改动保持得小，那是调度问题不是合并问题。
所以合并层只买两样近乎免费且不可能算错的东西
（`src/runtime/merge-guard.ts:1-22`，TF-0079；2026-09-13 注：模块已实现并有单测，
但截至收尾审计**未接入调度链路**——零生产调用，下列为设计意图，接入前生产链路不含此网）：

1. `git merge-tree --write-tree --name-only` —— 真做一次合并，预测到的冲突就是真冲突，
   构造上零误报：无启发式、无相似度打分；
2. 写集重叠账本，按「这次重叠有多意外」过滤。信号在**稀有度**（ConE 的发现）：
   两个写者落在同一个文件只有在该文件平时不共享时才是新闻。对每次重叠都通知，
   等于训练人忽略这条通道。

明确不做：语义合并、LLM 冲突解决（与开发者一致率只有 55-59%）、约束调度。
TF-0132（merge-back L1 独立里程碑）已按此裁决 deprecated，只保留为恢复卡的一条规则（TF-0151）。

### 5. 真实继承语义：以文件级逐字复刻为准，不以计费数字为准

TF-0140 的实测（2026-09-05，claude 2.1.251，脚本
`packages/workbench/scripts/measure-fork-inheritance.ts`，报告
[`report-2026-09-05-claude-fork-inheritance.md`](../report-2026-09-05-claude-fork-inheritance.md)）：

- `--resume <id> --fork-session` **能**接上 `--input-format stream-json` 铸出的会话，
  且铸新 session id（两次实测）。`src/chat/threads.ts:1141` 拼的命令行成立。
- fork 把源会话消息**逐字复刻**进新文件：`uuid` / `parentUuid` 链原样保留，只改写 `sessionId`。
  33/33 fork 配对的共享前缀内 `tool_use_id` 序列完全一致（合计 9733 条）。
  **`tool_use_id` 过 fork 不变 → 足迹可 join，`ForkAgentPlan.sourceFootprintSeq` 是真实切点。**
- **`cache_read_input_tokens` 不是继承判据。** 分叉首轮命中只有 10/33；缓存 TTL 内（≤5 分钟）
  的 11 个配对里命中 5 个、未命中 6 个，未命中者普遍带大额 `cacheCreate`。
  同一继承语义能给出完全不同的数字——它是时序与计费后端的产物。

**边界：**继承是否发生，只看会话文件是否逐字复刻，不看任何计费侧数字。

**诚实开关分两级，不合成一个布尔：**

| 字段 | claude `--fork-session` | HTTP provider |
| --- | --- | --- |
| `agentContextInherited` | `true`，`mode: "fork-session"` | `true`，`mode: "http-history"`（每轮重发全量历史，上下文确实继承了） |
| `premiseInherited`（读集） | 仅当源足迹非空且可比对 | **恒 `false`**：无工具通道 → 足迹恒为空集 |

**读集继承只能来自 `--fork-session` + 真实非空足迹**，HTTP 永远不是合法继承样本
（`readObservability: "unobservable"`，`src/runtime/notice-outcome.ts:59,289-293`；
HTTP 侧的观测点在 `src/chat/threads.ts:895-899`）。把两级压成一个布尔会同时犯两个错：
对 HTTP 谎称有读集，或对 fork-session 谎称没继承上下文。

`ForkDeclaration` 的两个字段首次 run 前保持 `null`，绝不静默猜测（`src/chat/fork.ts:36-70`）；
且**只在 provider 发出第一条 assistant/result 之后**才落定——fork 时刻与 stdin 入队都不算证据
（`src/chat/threads.ts:1242-1247`）。

### 6. L0 线性对话是默认，且不动它

新增任何交互功能，**不得增加发出第一条消息前的任何步骤**（TF-0085）。
分叉是一个手势：一次 POST、零仪式——不要求标题、不要求类型、不弹对话框，
原线程逐字节不变（`src/chat/fork.ts:1-11`）。
交互只做加法且可一次撤销（ADR-0008）；提议区间为空，所以系统直接做、用廉价回退兜底
（ADR-0009，实现在 `src/runtime/rollback.ts`）。

## Non-goals（明写并保持）

这七项不是「以后再做」，是**决定不做**。要推翻其中任何一条，新开一条 ADR 标注取代关系。

| 不做 | 理由 / 证据 |
| --- | --- |
| 树导航 UI | 会话树是投影里的会话侧事实流，不是要导航的 UI 树（TF-0120 non-goals；L0 不动它） |
| agent 消息总线 | 跨会话 socket 在 Windows／WSL2 边界不可达（TF-0109）；已选的通道是 stdin 通知 |
| CRDT 代码底座 | 六轴分类里每一轴最贵的角，朴素多主并发更新率随主节点数 O(M²)（ADR-0007 §成本背景） |
| LLM 语义合并 | 与开发者一致率 55-59%（`src/runtime/merge-guard.ts:19-21`，数据为该模块实验读数；模块未接入调度链路，见 TF-0079 偏差记录 TFD-c1b2f26f45） |
| 3-4 级告警 | 只有两级：沉默 / 一束通知。分级等于要求人做优先级判断，与「不淹没注意力」冲突 |
| 通用 saga 逆操作注册表 | 回退只做 code 与 context 两个面，且必须有快照，没快照就明确拒绝（`src/runtime/rollback.ts:1-13`） |
| HTTP 纯文本 provider（作为前提守护通道） | 无工具通道 → 足迹恒为空集，`readObservability: "unobservable"`（TF-0142）。仍可聊天，但不参与继承与读集观测 |

## 后果

- **收益**：三支柱共用一条日志与一个因果钟；新功能只需回答「属于哪类事实、进哪个投影」；
  方向性不变量与命名边界都有代码级拦截，不靠评审记忆。
- **代价**：会话侧永远不能带结论，任何需要「会话状态机」的想法都要先改成观测 + 投影；
  载荷上限意味着长 diff 一定被截断，恢复卡与通知都必须靠 refs 回溯原文而不是内嵌原文。
- **未决**：三支柱的真实价值仍待 TF-0141 的 t0 与 TF-0136 的两周门裁决；
  截至 2026-09-05 护城河四个数字全为「无样本」。本 ADR 固化的是**架构边界**，不是价值主张。

## 旧提案的收口

- ADR-0006 保留建议式通知、写者自行修补与沉默不代表安全的原则。实际通道是持久队列 + Claude stdin，运行中的轮次只排队；provider 消费后才确认。跨会话 socket 不再是前置条件。只有显式封印点可以拦截写入，支持 block / warn / off，不能宣称整个仓库因此可串行化。
- ADR-0007 保留单调优先的设计判据。操作表是人工分析工具，不是自动正确性证明；不建操作注册表、CRDT 源码合并或通用 saga。现有回退仅处理带快照的 code / context。
- ADR-0008 保留从执行取证、L0 默认和加法式交互。ADR-0009 已裁掉询问式提议 UI；L3 受 TF-0136 的真实两周数据门限制，TF-0100/0101 不因自身没有依赖边就可以提前开工。

2026-09-06 复核：Workbench 全套 509 项测试、1 份快照与 `bun run typecheck` 通过。
事件并发身份、世界/会话投影、载荷上限、Claude/HTTP 继承差异均有对应测试。
本仓库 `stats --json` 仍为 0 线程、0 次 fork、`insufficient-history`；不据此声称实际使用有效。

## 复核方式

```bash
cd packages/workbench && bun test --timeout 60000     # 投影边界与载荷上限的单测
bun run scripts/measure-fork-inheritance.ts           # 第 5 节的继承实测（只读历史会话）
```

第 1/2/3 节的边界各有单测钉住（`src/blackboard/events.test.ts` 钉 `validateThreadEvent`,
`src/contextgen/generate.test.ts` 与 `render.test.ts` 钉 `isWorldEvent` 过滤，
`src/runtime/delivery.test.ts` 钉预算裁剪顺序）；第 5 节的数字随 claude CLI 升级需重测，
`--live` 在未登录机器上仍可回答前两问。

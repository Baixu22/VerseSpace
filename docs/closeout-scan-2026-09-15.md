# Workbench 收尾扫描与完整性报告 · 2026-09-15

> 2026-09-16 复验更新：[审计修复与验证](audit-errors-closeout-2026-09-16.md)记录了后续状态。
> 本文的森林和指标数字保留 9 月 15 日扫描快照；后续已补齐 ADR 事实、argv 回归、真实 agent run 与 unknown 分类，并通过任务森林 CLI 创建正式节点 TF-0174/TF-0175。

范围：`packages/workbench`、`apps/workbench-ui`、`packages/context-rot`、任务森林（`.agent-workbench/task-forest/`）、`docs/`。
方法：森林普查（173 节点逐条读取）+ 三套测试套件 + 三个包 typecheck + 官方构建产物的冒烟 + 逐符号死代码扫描 + 全命令树的真实 argv 执行 + ADR 逐条比对。

---

## 一、逐节点核对结果

**森林普查：173 节点 = 164 done + 8 deprecated + 1 blocked，0 proposed / in_progress / ready。**

除一个节点外全部终态。没有「部分完成」的中间态节点——森林里不存在半成品。

### 8 个 deprecated 节点（全部有据关闭，非烂尾）

| 节点 | 内容 | 关闭依据 |
| --- | --- | --- |
| TF-0099 | 里程碑 L3：显式衍生产物 | L3 砍留（超前于证据） |
| TF-0108 | 风险：L3 明确超前于证据 | 同上，风险随 L3 一并关闭 |
| TF-0100 | N=2 推导：两条相似轨迹之差即泛化 | 依赖 L3，随 L3 砍 |
| TF-0101 | 重放验证 + 逐字面量占位符 | 同上 |
| TF-0132 | merge-back L1：恢复卡上的分支摘要 | 砍留，保留审计痕迹 |
| TF-0146 | 决策：是否提供「以分支为主线」手势 | 否决，deprecated |
| TF-0167 | benchmark 闸门剩下的三项（B/C/D） | **有据的关闭**，见 `docs/tf0167-moat-gate-verdict.md` |
| TF-0172 | L1 真实使用评估 | issue #7 `NOT_PLANNED`，用户明确按工程范围收口 |

### 1 个 blocked 节点（唯一的未完成项）

**TF-0173 · Git apply 历史堆损坏归因（缺原始转储，当前未复现）**

- 这不是产品功能，是**取证类遗留问题**：Git 2.51 原生进程堆损坏（0xC0000374）发生过三次，18 个 WER 报告与转储均已不存在，当前无法复现，无法确定责任模块。
- 它的 `alignment.fit` 诚实地停在 `unknown`，验收标准明确要求「不能仅凭版本变化或当前未复现宣布根因」。
- **重启条件**：拿到当时的崩溃转储，或在原宿主环境中出现新的可重复失败。在此之前它应该保持 blocked——这是正确的状态，不是要清掉的债。

### 适配度读数（`docs/fit-ledger.md` 计数子集，27 个部件节点）

aligned 3 · partial 15 · weak 0 · misaligned 0 · **unknown 9**

关键在于**没有一行 weak 或 misaligned**：已做完的方向没有跑偏的。但 9 行 unknown 是结构性结果——账本纪律第二条写着「无真实使用一律 `unknown`，测试通过不算使用」，这 9 行缺的是自然使用样本，不是代码。

---

## 二、集成测试结果

| 目标 | 结果 |
| --- | --- |
| `packages/workbench`（106 文件） | **667 pass / 0 fail**，2619 次断言，1 个快照 |
| `packages/context-rot` | **65 pass / 0 fail** |
| `apps/workbench-ui`（vitest） | **25 pass / 0 fail** |
| 三个包 `tsc --noEmit` | **全绿** |
| 官方构建 `bun run build` + `test:build` | **native exe 与 js bundle 双双通过**（init / doctor / stats / 无头 UI 服务 / 内嵌界面资源全部断言通过） |

**真实 argv 执行链路**（不只是命令树形状）：通过编译产物 `.exe` 在干净沙箱里跑完整写入生命周期——
`init → goal add → decision add → interface register → ws create → dispatch → sync → tribunal 自动入队 → shelve → resolve`，全部成功，事件流可读。

**前提守护的端到端证据**（四个 `.evidence-sites/`）：足迹 → 重叠 → 通知 → 修复的链条闭合。soak 现场 9766 次重叠 / 3075 次通知 / 送达 4 条 / 修复 4 条，恒等式精确闭合（L1/L2/L3 全零）。

**本次扫描未覆盖的部分**：9 月 15 日扫描没有执行真实 `agent run`，不能从 fixture 推断通过。9 月 16 日已补做 3 个真实模型批处理会话，读写及前提修复闭环通过，见 [issue #11](issue-11-closeout.md)。

---

## 三、假阳性代码排查

逐符号扫描了 572 个导出符号。**没有桩函数、没有 TODO/FIXME 残段、没有逻辑断裂的半成品。**

### 发现并已修复的两个真假阳性

这是本次扫描最有价值的发现——**两处代码「存在、被测试覆盖、文档里写着可用，但实际调用时是坏的」**。

**P0 · `workbench tribunal shelve <id>` 对任意 id 崩溃**

- 现象：`workbench: undefined is not an object (evaluating 'command.optsWithGlobals')`，退出码 1。
- 根因：`shelve <id>` 只有一个操作数，commander 传入 `(id, options, command)` 三个参数，但 action 声明了四个参数 `(id, options, _c, command)`——`command` 拿到的是 `undefined`。
- 为什么测试没挡住：`cli.test.ts` 只断言命令树形状（`commands.map(c => c.name())`），从不执行 `parseAsync`。**一个 action 的参数个数与操作数个数不匹配时，注册阶段完全正常，只在调用时崩**，形状测试对这个故障类是盲的。
- 修复：参数改为 3 个；并新增 `describe("argv execution")` 回归块，把 tribunal 的 list/show/shelve/resolve 和 ws create 的必选参数都走真实 argv 路径执行一遍。

**P2 · `ws create` / `ws reassign` 的必选参数被声明成可选**

- `--task`、`--branch` 在运行时是必需的（缺了会报错），但声明成了 `.option()`，于是产生了一段**永远不可达的守卫代码**（运行时分支被参数解析器挡死）。
- 修复：改为 `.requiredOption()`，删掉不可达守卫，类型从 `task?: string` 收紧为 `task: string`。错误信息也从运行时异常提前到参数解析阶段，对用户更友好。

### 13 个未使用的类型别名 —— **本条是误报，已在 2026-09-13 由 issue #4 收口**

初次扫描把它们列为「装饰性、无害、建议删除」。复核后发现这是**扫描方法的问题**：只做了引用计数，没有读注释。

**issue #4 已经对这 13 项作出决定**：保留为公共 API 契约面，不删除，并逐项加了声明注释：

`Artifact`、`BlackboardEffects`、`UnblockEntry`（types/checkpoint）、`AcceptanceCriteria`（types/goal）、`WriterStatus`（types/session）、`CheckpointZone`（types/snapshot）、`ConflictsFile`、`QueueFile`（types/state）、`TribunalFolded`、`TribunalItemState`（types/tribunal）、`ContextNeeds`、`WorkspotBinding`（types/workspot）、`WatchLock`（watcher/lock.ts 的 re-export 别名）。

注释统一为 `// X 是预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。`，本次扫描确认 12 处注释与清单一致（`watcher/lock.ts` 的声明在 re-export 行上）。

另外，初次扫描误把 `LifecycleEventLike`（chat/resume-card）也列入其中。**它不是死代码**：它是 `payloadOf` / `isResumeCardDismissed` 的参数类型，并从 `chat/resume-card/index.ts:17` 对外再导出，是活的契约类型。

**结论：这一项从事项清单里移除。** 下次做死导出扫描时，应当先识别「预留导出」注释再计数，而不是把已声明的契约面重新标成嫌疑。

### 排查中排除的

- `commands/context.ts` 的 `resolveBlackboard()`：cli.ts 不直接导入它，但它是所有命令模块共用的黑板解析器，**不是死代码**。
- UI 服务器里曾在 2026-09-13 删除过三个零客户端引用的死读路由（`/api/tribunal`、`/api/wip`、`/api/metrics`）——那次清理已经做过，本次扫描确认没有复发。

---

## 四、设计是否偏离了开发的边界或初衷

扫描时结论：**ADR-0010 的产品边界（七条非目标）在代码里全部被遵守；ADR-0005 的 GUI 范围需要后续决策记录。** 后续 [ADR-0012](decisions/0012-gui-write-endpoint-admission.md) 已按 27 条真实路由补齐并复核；下面保留问题发现时的依据。

### ADR-0010（前提守护架构与产品边界）——遵守

七条非目标逐条核对代码，全部守住：

- 树状导航 UI：无（GUI 是黑板视图，不是会话树导航）
- agent socket 消息总线：无
- CRDT：无
- LLM 语义合并：无
- 3–4 级告警：无（通知只有两级：推送 / 不推送）
- 通用 saga 注册表：无
- HTTP 明文 provider 作为前提通道：无（该通道被显式标为不可观测，`stats.noticeOutcomes.agent.unknownBy.unobservable` 无样本）

**方向性不变量也守住了**：世界投影从不折叠会话事件——347 条会话生命周期事件被排除在世界投影之外，1832 条世界事件单独计数，测试覆盖了这个边界。

### ADR-0005（本地 Web UI）——**这是唯一一处代码与决策记录不一致**

ADR-0005 第 15 行写的是：

> **范围**：GUI 只读 + 一个幂等 sync 按钮；dispatch/review 等有副作用的操作不进 GUI（后续逐个评估）。

实际代码（`packages/workbench/src/ui/server.ts`）暴露的路由远超这个范围：

`/api/state`、`/api/sync`（只读，符合）**＋** `/api/dispatch`、`/api/review`、`/api/agent/run`、`/api/chat/feedback`、`/api/config/chat`（PATCH）、以及 `/api/chat/threads` 下一整套写入子路由（cancel / reload / promote / fork / leave / switch / restore / resume-note / resume-action / messages）。前端 `apps/workbench-ui` 共 5459 行，是一个完整的聊天工作台。

这不是静默越界——ADR-0005 自己就预留了「后续逐个评估」「写操作端点未来需逐个设闸」的口子。**但这个口子从来没有落地成任何记录**：ADR-0006 到 0011 里没有任何一条是关于 GUI 写端点准入的。

所以这是一个**决策记录的缺口，不是边界的秘密违反**。写端点本身做得很规矩——每个端点都要过 per-run 随机令牌认证、只绑回环地址、无 CORS 头、资产读取有路径穿越防护。但按项目自己的决策纪律（TF-0138 那类节点存在的前提就是「架构边界要被后续评审引用」），这块该补一份 ADR。

---

## 五、风险点

**R1 · 差异化价值主张从未在自然使用上验证（最大风险）**

Helmor 卖的是「前提守护保护真实开发者」。但：

- L1 人工复核：issue #7 `NOT_PLANNED`；2026-09-14 冻结现场 5 个候选，**人答 0/5，覆盖率 0%**（用户说明自己不是一线开发者，无法判断会话核心——这是能力错配，不是产品驳回）。
- 护城河读数（`workbench-e2e-live-tenant` 现场）：A=140（达标）、**B=1**（缺 human 读集自动生产路径）、C=25（缺真人复核者）、D=0.157（在 10–30% 带内，但来自 soak 形态）。
- 四个证据现场里 3/4 读 `too-noisy`——TF-0167 已判定这是 soak 负载形状（每轮产生全新组合，dedup 压不下去），不是噪声也不是口径错误，**band 不动**。

**R2 · B/C/D 三项结构性不可达（已被 TF-0167 判决，不是遗留 bug）**

- B：human 读集只有手动 CLI 路径（`sessions record --kind human --used`），没有编辑器集成这类自动触发面。现场 232 个写者全是 `kind=agent`。
- C：`seal.reviewed` 强制 `source: "human"`，现场 165 条 block 全来自脚本编排的模型线程，无真人复核者。
- D：需要真实使用窗口（非 soak）的 `premise_pass` 积累才能复核比值带。

TF-0167 的 J3 给出了重启条件（三者同时满足）：①human 读集有自动生产路径；②有真实使用者参与封印复核；③真实使用窗口的读数积累。**重启时新开节点，不复活 TF-0167。**

**R3 · 扫描时缺少真实 agent run 验证（后续已补齐）**

9 月 16 日使用有效 SenseAudio 通道完成 3 个真实批处理会话、8 次模型调用及足迹/通知/复读修复验证。旧凭据的 HTTP 401 与本机代理失败现场保留，未算通过。该工程场景不替代 R1/R2 的自然使用评估。

**R4 · 9 行 fit `unknown`**

按账本纪律这是诚实的，但对产品叙事是硬约束：**不能把 unknown 当 validated 讲**。

---

## 六、收尾前必须处理的优先级事项

| 优先级 | 事项 | 状态 |
| --- | --- | --- |
| **P0** | 落库本次三处修复（`cli.ts` / `commands/ws.ts` / `cli.test.ts`）——P0 崩溃修复现在只在工作区，未提交，森林状态也未同步 | **已完成**（`d0d9caa`，已推送；667 用例全绿） |
| **P0** | 补 ADR 并对照实际 GUI 写端点 | ADR 与代码事实已订正，正式节点 TF-0174 已创建，见 [issue #9](issue-9-closeout.md) |
| **P1** | 全部带操作数命令经过真实 argv 执行 | 32 项 CLI 测试及完整 Workbench 700 项复验通过，见 [issue #10](issue-10-closeout.md) |
| **P2** | 真实 `agent run` 端到端 | 3 个真实模型会话通过，见 [issue #11](issue-11-closeout.md) |
| **记录性事项** | TF-0167 J3 三项 + L1 重启条件 | 可核验判据已补齐，产品评估仍未启动，见 [issue #12](issue-12-closeout.md) |
| **P2** | fit 账本 unknown 分类处置 | 7 条结构性 + 2 条证据缺口已在历史账本标注，数值不变，见 [issue #13](issue-13-closeout.md) |

---

## 七、结论：现在能不能作为一个产品上线

**分成两个问题回答，因为答案不同。**

### 作为工程产物：可以

- 173 节点除 TF-0173（取证类遗留，本就该 blocked）外全部终态；
- 三套测试 757 个用例全绿，typecheck 全绿，构建产物双冒烟通过；
- 降级语义做得诚实：`insufficient-history`、`no-sample`、`unknown` 在该出现的地方全部出现，没有用「测试通过」冒充「被使用」；
- 今天的两个 P0/P2 缺陷已修复并带了回归测试。

### 作为价值验证过的产品：不能

差异化主张（前提守护）的四个护城河里，B、C、D 三项在当前产品形态下**结构性不可达**，A 是唯一达标的一项。L1 人工认可 0/5。

按项目自己写下的纪律——**「无真实使用一律 `unknown`，测试通过不算使用」**——现在上线，等于把 `unknown` 当成 `validated` 卖出去。这不是工程没做完，是**验证对象不存在**：B 缺的是产品路径（编辑器集成），C 缺的是真人，D 缺的是真实负载窗口。这三样都不是再写一代码能解决的。

**上线的最小前置条件就是 TF-0167 的 J3 三项加 L1**。在此之前，它是一个完成度很高、边界很清楚、审计痕迹完整的**工程原型**，不是一个验证过价值的产品。

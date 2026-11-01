# ADR-0029：中断原因只用可观测事实，断点与积压分开判读

- 状态：已接受（2026-11-01）
- 补充 ADR-0027（会话延续性投影）与 ADR-0028（延续性接入既有表面）；ADR-0023 的冻结范围与 ADR-0024 的退役范围不变。
- 追踪：任务森林 TF-0329 / TF-0330 / TF-0331（本机 untracked 脚手架）。

## 问题

阶段一/二把「这一轮被切断」变成了账本里的一等观察，但它有两个还没解决的问题：

1. **所有中断都叫 `host-restarted`。** 这个取值是**生产者的位置**（启动清扫发现 `status` 还停在 `running`），不是原因。它同时覆盖了「宿主进程被杀」「机器重启」「终端关掉」等好几种情形，而账本里并没有能区分它们的字段。把「provider 崩了」这种猜测写进 `reason`，会让一条读数看起来比它实际知道的更多。
2. **断点和积压没有联合判读。** 真实账本上 30 条会话里 20 条带未投递积压；一条会话同时有「未恢复的断点」和「未投递通知」时，人应该先看哪个，此前没有答案。

第 1 条还有一个具体的**假阳性**：用户自己按停的那一轮，在账本里和「被切断」完全同形——末条是人类消息、没有助手回复。于是「我停了它」被读成「需要你处理」。

## 决定

### 1. 原因只写可观测的取值，不猜（TF-0329 / TF-0330）

`thread.turn_interrupted.reason` 只允许两类取值：

| 取值 | 产生路径 | 它实际说明了什么 |
| --- | --- | --- |
| `host-restarted` | `chat/threads.ts` 的 `reconcileRunningOnStartup`：启动时发现 `meta.status` 仍为 `running` | 上一个宿主进程在回合中途消失了。**不说明**是被杀、崩溃还是重启。 |
| `unknown` | 事件没有 `reason` 字段（旧日志） | 原因没有被记录。不就近归入最接近的类别。 |

`provider-exit` / `user-kill` / `host-crash` **没有被加入枚举**，因为账本里没有能区分它们的字段：`status === "running"` 这个观察对三者完全一致。新增枚举的前置条件写在 TF-0330 里——先有能绑定到具体事件的信号，再谈取值。

### 2. 用户主动停止是一条独立观察（TF-0330）

新增线程事件 **`thread.turn_cancelled`**，由 `chat/thread-lifecycle.ts` 的 `cancel` 在**确实有一个在跑的回合**时落盘（带 `source: "user"`、`atMessageCount`、末条消息身份）。没有在跑的回合就不写——凭空写一条会把「用户按了停」变成可以伪造的记录。

随后在投影层：

- 末条是人类消息、且最后一次终止观察落在它之后 → **不排进待办**（「没有回复」是有人主动停的，不是被切断）。
- 有中断事件、且终止观察在它之后 → 该中断 `userStopped = true`，同样不进 `because`。
- 记录本身保留（`turns.cancellations` + `refs`），随时可核对。

`cancel` 因此变成可 `await` 的：终止观察必须在下游读取（延续性投影、GET 载荷）之前落盘，否则同一次点击在两个读者眼里会有两个答案。取消语义本身不变（仍是 abort / 树杀），本决定只加一条观察。

### 3. 联合判读：两维分开，顺序明确（TF-0331）

`SessionContinuity.priority` 给出「先看哪个」，**只依赖已有两维事实**，不新增采集：

| 观察 | priority | 含义 |
| --- | --- | --- |
| `because` 非空（有未恢复中断，或没有回复的人类消息） | `break-first` | 先看断点 |
| 无断点，但 `delivery.pendingNotices > 0` | `backlog-only` | 只有全局投递积压，不急 |
| 两者都没有 | `neither` | 无待办 |

四条硬约束：

- **不合并成单一分数**，也不引入加权健康分：两维各自可核对。
- **积压不并入 state**（沿用 ADR-0027 判据）：`backlog-only` 的会话 state 仍是 `intact`。
- **与 state 不矛盾**：用 `because`（而不是只看中断）判定，所以「没有回复的人类消息」也算断点，不会出现「state=review 但 priority=neither」。
- **CLI / MCP / 恢复卡三处同源**：`priority` 由 `derive.ts` 一处算出，恢复卡的 `continuityCardRows` 与 CLI/MCP 都读它。

### 4. 每条 unknown 指名字段或事件（TF-0334）

`SessionContinuity.unknowns` 从 `string[]` 改为 `{ text, pointer }[]`：

| 缺口 | pointer |
| --- | --- |
| `meta.status` 仍为 `running` | `meta.status` |
| claude 车道缺 provider 会话 id | `meta.claudeSessionId / meta.hasResumableSession` |
| codex 车道缺 provider 会话 id | `meta.codexSessionId / meta.hasResumableSession` |
| 旧中断事件没记条数 | `event:<id>`，无 id 时 `eventType:thread.turn_interrupted` |
| 有消息但没有时间 | `messages.jsonl:at` |

`unknownLine()` 统一渲染成 `…（可核对：<pointer>）`，CLI 与 MCP 共用。这是「读数只指字段、不推断成因」的直接落地：`codex reload 不重建远端会话`、`跨 provider 切换`两种成因都体现在同一个字段缺失上，读数说「这个字段是空的」，原因由那次操作自己的事件回答。

## 边界：本切片不做什么

- **不新增原因枚举**（`provider-exit` / `user-kill` / `host-crash` 均未加）：没有能绑定的事实就不加，这是本决定的第 1 条。
- **不推断因果**：不写「模型变慢导致超时」「provider 崩了」这类结论。
- **不改取消语义**：`cancel` 仍是 abort / 树杀，本决定只加一条观测。
- **不做自动动作**：`break-first` 不触发重跑、重投、归档或修复。
- **不引入授权/派工概念**（TF-0332 继续成立）：没有 Mandate / Ticket / Assignment。
- **不恢复非 Windows 实机或真人研究**（ADR-0024 不变）。
- **不声称会话正确**：`intact` 仍只表示「没有观察到需要人处理的事实」。

## 验收与读数

| 面 | 仪器 | 读数 |
| --- | --- | --- |
| 原因取值与用户终止 | `src/chat/continuity.test.ts` | 真实临时账本上 `cancel` 落一条 `thread.turn_cancelled`；该轮 state=intact、priority=neither；对照组（无终止观察）仍是 review |
| 判定表（两维四组合） | `src/chat/continuity/derive.test.ts` | 15 pass：break-first / backlog-only / neither 全覆盖 |
| 恢复卡四组合 | `src/chat/resume-card/continuity.test.ts` | 13 pass |
| unknown 指针 | `src/chat/continuity/derive.test.ts` | 每类缺口各断言 pointer；HTTP 车道不产生 unknown |
| 三处同源 | `src/artifacts/projection.test.ts` | 5 pass（工具目录 6 条） |
| 真实账本 | 手工（交接记录 §3） | 用户主动停 = 无待办观察；问了没答 = 需要人看一眼 |
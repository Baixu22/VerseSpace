# ADR-0012：GUI 写操作端点的准入决策

- 状态：已接受（2026-09-15）
- 日期：2026-09-15
- 收敛：ADR-0005 的「后续逐个评估」与「写操作端点未来需逐个设闸」——这两处预留口子从未落地成记录，本文把它们正式收口。
- 森林节点：TF-0174（父：TF-0138；主线 TF-0057）
- 相关：ADR-0005（本地 Web UI）· ADR-0010（前提守护架构与产品边界）·
  ADR-0009（提议区间为空，以廉价撤销替代）·
  [收尾扫描报告 2026-09-15](../closeout-scan-2026-09-15.md) §四

## 一句话取舍标准

> **写端点不是「能不能进 GUI」，而是「破坏发生时拿什么兜底」。**
> 追加式或可撤销的操作，认证边界够了就放；**不可撤销的操作必须自带确认**，
> 因为认证只挡得住「别人误用」，挡不住「自己手滑」。

任何新增 GUI 写端点先过这一句：它的最坏后果是什么，那个后果能不能被撤销或被一次确认拦下。

## 背景

ADR-0005 第 15 行声明的 GUI 范围是「只读 + 一个幂等 sync 按钮」，并把
dispatch/review 一类写操作明确划在界外，批注「后续逐个评估」；第 26 行后果段
也留了「写操作端点未来需逐个设闸」。

实际代码（`packages/workbench/src/ui/server.ts`）远超这个范围。这不是静默越界——
预留口子是 ADR-0005 自己开的。但截至本文落库，**从 ADR-0006 到 0011 没有任何一条
收口它**，任务森林里也没有跟踪节点（TF-0056 只跟踪 GUI 面板本身的交付）。
2026-09-15 收尾扫描把这是定为「唯一一处代码与决策记录不一致」。

现状盘点（逐路由核对 `server.ts`，并与前端 `apps/workbench-ui/src` 的真实调用比对）：

| 分类 | 路由 |
| --- | --- |
| 只读 | `GET /api/bootstrap`（免令牌握手）、`GET /api/state`、`GET /api/config/chat`、`GET /api/chat/threads`、`GET /api/chat/threads/:id`、`GET /api/chat/threads/:id/evidence` |
| 幂等写（ADR-0005 已声明） | `POST /api/sync` |
| 有副作用的写 | `POST /api/dispatch`、`POST /api/agent/run`、`POST /api/review`、`POST /api/chat/feedback`、`PATCH /api/config/chat` |
| 会话生命周期写 | `POST /api/chat/threads`、`POST .../messages`（NDJSON 流）、`.../cancel`、`.../reload`、`.../promote`、`.../fork`、`.../leave`、`.../switch`、`.../restore`、`.../resume-note`（PATCH / consume / dismiss）、`.../resume-action`、`PATCH .../`（标题 / 权限 / 归档）、`DELETE .../` |

已确认的既有安全边界（**本文不改这些，它们是准入的前提，不是准入的结果**）：

1. **per-run 令牌**：`server.ts:242` 的 `randomUUID()`，除 `/api/bootstrap` 握手外所有
   `/api` 路由都要求 `x-workbench-token` 匹配（`server.ts:283-290`）。
2. **回环绑定**：`Bun.serve` 只听 `127.0.0.1`（`server.ts:618`）；请求层另有一份
   hostname 白名单 `{"127.0.0.1","localhost","::1"}`，否则 403（`server.ts:278-281`），
   端口无关，`vite dev` 的代理仍能工作。这一层挡的是 DNS 重绑定。
3. **零 CORS**：不发任何跨域头，SPA 同源；跨站页面即使能读到令牌也发不出请求。
   握手响应本身不可跨域读（同源策略），所以它免令牌是安全的（`server.ts:236-241` 的注释）。
4. **资产路径穿越防护**：解析后必须落在资产目录内（`server.ts:255-257`）。
5. **机密不外泄**：`publicChatConfig()` 剥掉 `apiKey` 只留 `hasKey` 布尔
  （`src/chat/credentials.ts:8-11`），`/api/config/chat` 的 GET 与 PATCH 响应都过它。
6. **输入边界校验**：线程 ID 白名单 `/^[a-zA-Z0-9_-]+$/`（`server.ts:423`），
   恢复观测走 zod schema（`server.ts:469`），各端点缺字段直接 400。
7. **并发护栏**：`POST /api/sync` 持锁忙碌返 409（`server.ts:306`）；
   会话操作经 `enqueue(id, ...)` 按线程串行，`turnInFlight` 拒绝运行中的轮次
   （`src/chat/threads.ts:425`、`:1431`）。

## 决策

### 1. 准入判据（四条同时满足才放行）

| # | 判据 | 为什么这条是必需的 |
| --- | --- | --- |
| ① | 有令牌 + 回环 + 零 CORS 的认证边界 | 挡住「别的页面替你操作」。本机单用户场景下这是充分的来源校验 |
| ② | 破坏可撤销，或追加式，或有运行时护栏 | 追加到事件日志的操作天然可回放；`sync`/`dispatch`/`remove` 有 409 护栏 |
| ③ | 不可撤销的操作必须带显式确认 | 认证挡不住手滑。这是唯一需要「闸」的类别 |
| ④ | CLI 有等价命令，GUI 不是唯一入口 | 保持「GUI 是观察面」的定位；HTTP 端点不是第二个必须维护的 CLI |

**判据 ④ 的含义**：被准入的端点全都只是既有 CLI 能力的同源镜像
（`workbench dispatch`、`workbench agent run`、`workbench tribunal review` 等）。
CLI 仍是权威执行面，GUI 的价值是「不必切终端就能做同一个动作」。

### 2. 逐端点准入决定

**A 组 · 维持 ADR-0005 声明（只读，无需准入）**

`/api/bootstrap`、`/api/state`、`/api/config/chat`（GET）、`/api/chat/threads`（GET）、
`/api/chat/threads/:id`（GET）、`/api/chat/threads/:id/evidence`。
`/api/state` 额外暴露 reconcile 失败计数与最后一次错误（`server.ts:271-272`、`:294-299`），
这是有意的——R2 巡检静默失败的表现是「再也没有失效通知」，必须可见。

**B 组 · 幂等写（ADR-0005 已声明，本次确认其幂等性成立）**

| 端点 | 闸 | 决定 |
| --- | --- | --- |
| `POST /api/sync` | 运行锁，忙碌 409（`server.ts:306`） | **保留**。`runOnce` 是幂等的：重复触发只重放同一批未投递通知，不产生副作用累积 |

**C 组 · 有副作用的写（本次正式准入）**

| 端点 | 闸 | 最坏后果 | 决定 |
| --- | --- | --- | --- |
| `POST /api/dispatch` | 必填 `goalId`；merge-guard 预检；冲突 409（`server.ts:308-325`） | 创建工位 / 派发一轮工作 | **准入**。可撤销——工位与派发记录可回滚；预检保持建议性质不阻塞派发（ADR-0010 §4） |
| `POST /api/agent/run` | 必填 `workspotId` + `prompt`（`server.ts:331-348`） | 起一个 agent 会话花钱跑 | **准入**。等价 `workbench agent run`；会话可取消（`.../cancel`） |
| `POST /api/review` | 必填 `cpId` + `approve` 布尔（`server.ts:349-362`） | 封印一个检查点结论 | **准入**。等价 `workbench tribunal review`；结论落事件日志，可审计 |
| `POST /api/chat/feedback` | 仅追加 `source: "human"` 的观测事件（`server.ts:364-377`） | 记一条反馈 | **准入**。纯追加，零破坏 |
| `PATCH /api/config/chat` | zod schema 校验；空串清键（`server.ts:382-396`） | 改聊天配置 | **准入**。等价 `workbench config set`；响应不含键值 |

**D 组 · 会话生命周期写（本次正式准入）**

全部落在 ADR-0010 §2 的命名边界内：`source=threads` 的会话事件**只记观测不记裁决**，
所以这些端点的写入天然是追加式的，不构成第二个状态机。

| 端点 | 闸 | 决定 |
| --- | --- | --- |
| `POST /api/chat/threads` | 无必填（标题可后补，TF-0092） | **准入**。创建可删，零仪式 |
| `POST .../messages` | 必填 text；按线程串行；运行中轮次被拒 | **准入**。流式响应，`idleTimeout: 120` 保证慢启动模型不被切断（`server.ts:620-624`） |
| `.../cancel` | 运行中才有效，否则空操作 | **准入**。撤销手势本身 |
| `.../reload` | 丢弃末条 assistant 消息，返回可重发文本（`threads.ts:746`） | **准入**。这是有意的丢弃，但文本被原样返回，可一次重发 |
| `.../promote` | 仅无名线程生效，已命名直接返回原值（`threads.ts:570-572`） | **准入**。幂等 |
| `.../fork` | 必填 `anchorMessageId`；运行中 409；源线程逐字节不变（`threads.ts:594-606`） | **准入**。ADR-0010 §5 的加法式交互原型 |
| `.../leave` / `.../switch` / `.../restore` | 追加观测事件 | **准入**。纯观测 |
| `.../resume-note`（PATCH / consume / dismiss）、`.../resume-action` | 追加观测；无笔记时 404 | **准入**。纯观测 |
| `PATCH .../`（标题 / 权限 / 归档） | 无破坏性；归档是可逆标记 | **准入** |
| `DELETE .../` | **见下** | **附条件准入** |

### 3. 唯一附条件的端点：`DELETE /api/chat/threads/:id`

这是全部端点里**唯一不可撤销**的一个。`threads.ts:732-743` 的实现是
`rm(threadDir, { recursive: true, force: true })`——转录、恢复笔记、派生关系一并删除，
且事件日志里只留下「删除了」这一条观测，内容不可回放。

准入前的实际状态：前端有可触发的删除按钮
（`apps/workbench-ui/src/components/chat/thread-list.tsx:126-137` 的 `Trash2`），
经 `adapter.ts:103` 的 `onDelete` 接到 `store.ts:859-863` 的 `deleteThread`，
**中间没有任何确认**。判据 ③ 不满足。

**决定：附条件准入。** 条件是删除前必须有一次显式确认。本次已落库
（`apps/workbench-ui/src/chat/store.ts` 的 `deleteThread`，原生 `confirm`），
理由是它是零依赖、零新增组件、一次点击的最小闸；要换成内联对话框是纯 UI 美化，
不影响本判据。

**为什么不用「软删除」替代确认**：软删除会把「删了」变成「可能还没删」，
与会话事件的追加式语义冲突——恢复卡会以为线程还在。一次确认比一个隐藏的墓地区更诚实。

## Non-goals（明写并保持）

| 不做 | 理由 |
| --- | --- |
| 给 GUI 加用户系统 / 权限分级 | 本机单用户，per-run 令牌 + 回环绑定已经是充分的来源校验；加账户层是解决不存在的问题 |
| 给写端点加审计落库 | 事件日志**就是**审计：所有写操作要么本身是事件，要么经 Blackboard 追加（`背景` §7 之外没有第三条写入路径） |
| 让 GUI 成为唯一入口 | 判据 ④：CLI 保持权威执行面，GUI 是同源镜像。已被删的 `/api/tribunal`、`/api/wip`、`/api/metrics` 是反例——零客户端引用的 HTTP 面就是没人维护的第二个入口（`server.ts:326-330`） |
| 给每个写端点单独写 ADR | 准入判据是通用的，本文一次收口；新端点只需在复核清单里答四条判据 |
| 令牌持久化 / 「记住此设备」 | per-run 令牌随进程生灭，重启即换。持久化只会扩大可重放窗口 |

## 后果

- **收益**：ADR-0005 的两处预留口子正式收口，代码与决策记录重新一致；
  新增 GUI 写端点有四条可对照的判据，不必每次重开「该不该进 GUI」的讨论；
  唯一的不可撤销操作有了显式确认，判据 ③ 从纸面变成代码。
- **代价**：删除对话多一次点击（这是有意的）；确认对话框是原生控件，
  与应用视觉不统一——要换内联组件是独立的 UI 工作，不改变本判据。
- **未决**：`POST /api/agent/run` 与 live 通道在本机无活动 agent 凭据，
  只能靠 fixture 与沙箱验证（issue #11）。准入决定不依赖它跑通过真实模型会话。

## 与 ADR-0010 的关系

本文只管「GUI 写端点能不能开」，不管「写下去的东西长什么样」。所有被准入的端点
仍然受 ADR-0010 的边界约束：会话事件只记观测不记裁决（`validateThreadEvent`）、
世界投影不折叠会话事件、载荷上限 400 字符、通知有两级不是四级。
**GUI 写端点不是这些边界的例外通道。**

## 复核方式

```bash
cd packages/workbench && bun test --timeout 60000   # server.test.ts 覆盖令牌、回环、路由
cd apps/workbench-ui && bunx vitest run             # store 的删除确认回归
```

复核清单（新增 GUI 写端点时照此填，四条都满足才放行）：

1. 它过令牌 + 回环 + 零 CORS 吗？（不加端点的话自动满足）
2. 破坏可撤销 / 追加式 / 有运行时护栏吗？
3. 不可撤销的话，带显式确认吗？
4. CLI 有等价命令吗？

2026-09-15 复核：Workbench 667 项、workbench-ui 27 项通过；`server.ts` 路由清单与
本文表格逐条一致；前端无未登记的写端点调用。

# ADR-0017：第二个可观测 provider 的接入形态——直接监督外部 CLI，主包内轻量协议适配

- 状态：已接受（2026-09-22，用户在 TF-0247 明确选定 codex 并授权本轮落地）
- 森林节点：TF-0246（决策），上级阶段 TF-0245，目标 TF-0232
- 取代：[ADR-0013](0013-workbench-identity-and-compliance.md) **决策 3 的接入形态一句**——「触发后，接入形态只允许 `spawn-sidecar`」。ADR-0013 决策 3 的其余结论（触发条件 = 出现第二个需要足迹观测的 provider；不把「补足迹」与「接第二个 provider」混为一谈；UI 诚实标注可观测性）继续有效。
- 相关：[ADR-0015](0015-legacy-retirement-execution.md)（删除 sidecar 的执行）、[ADR-0006](0006-advisory-concurrency-control.md) / [ADR-0010](0010-premise-custody.md)（建议式并发 + seal 是唯一拦截点）

## 背景

ADR-0013 决策 3 在 sidecar 尚存时写下：第二个需要足迹观测的 provider «接入形态只允许 `spawn-sidecar`»——把 sidecar 当成一个更丰富的 `spawnSupervised` 目标，交换 JSON Lines 协议。当时的硬约束是「不允许把 `@anthropic-ai/claude-agent-sdk` 之类的 SDK `import` 进主包」，以保住「4 个运行时依赖 + 单文件编译二进制」的生态特征（风险节点 TF-0221）。

此后 ADR-0014 / ADR-0015 执行了存量退役：`src/`、`src-tauri/`、`sidecar/` 已删除。ADR-0013 决策 3 的复核条款明确列出「出现第二个需要足迹观测的 provider」为触发重估的条件——现在这个条件命中了（用户在 TF-0247 选定 codex），且 sidecar 已不复存在。若照字面复活一个独立 sidecar 进程只为跑 codex，方向与退役相反，且引入一层不必要的进程。

同时有一个此前 ADR-0013 未掌握的事实：codex CLI 自带 `app-server` 子命令，它本身就是一个可被直接监督的外部进程，讲一套 JSON-RPC 式的 stdio 协议。这使「把 sidecar 当成更丰富的 spawn 目标」这层间接完全多余——codex 二进制自己就是那个更丰富的 spawn 目标。

## 决策

**第二个可观测 provider 的接入形态 = 直接 `spawnSupervised` 外部 CLI 二进制 + 主包内 per-provider 轻量协议适配层。** 不复活 sidecar 进程，不新增独立包。

具体到本轮落地的 codex：

- **进程**：`spawnSupervised("codex app-server -c notify=[]", …)`——复用现有 supervisor（liveness 静默判死、registry 孤儿回收、killTree），与 claude 车道走同一套进程监督，不新起 sidecar。
- **协议**：codex `app-server` 讲换行分隔的 JSON-RPC 式 stdio 协议（省略 `jsonrpc` 版本字段）。握手 `initialize`（await 响应）→ `initialized` 通知；建线程 `thread/start` / `thread/resume`（返回 `thread.id`）；发回合 `turn/start`；回合以 `turn/completed` 通知终结。就绪信号是 `initialize` 响应 resolve，不是 claude 那样的 `{"subtype":"init"}` 文本 sentinel。
- **适配层**：主包内 `chat/codex-*.ts`，把 app-server 通知归一化成 `type`-tagged 事件后，翻译成与 claude 车道同构的规范 render 决策与工具足迹。这层是**纯数据翻译**。
- **凭据**：走 codex 自身登录会话，不读也不写 `OPENAI_API_KEY`、不写 `~/.codex/config.toml`。

**保留 ADR-0013 的硬约束不变**：

- 不把任何 provider SDK（`@anthropic-ai/claude-agent-sdk`、`@openai/codex` npm 包等）`import` 进主包。协议适配是对着 stdio 字节做翻译，不依赖 provider SDK。
- 保持「4 个运行时依赖 + 单文件编译二进制」的生态特征（TF-0221）。
- provider 能力仍以数据表达（`provider-capabilities.ts`，TF-0204），新增 provider = 表里加一行 + 一个适配层，不在各调用点比较 provider 名字。

## 交互协议：只接服务前提账本的那一项

codex 的 `app-server` 会发出六类交互协议。逐项按「它如何服务前提账本」表态，**不为与 claude 对等而对等**（对应 TF-0250）：

| 协议 | codex 线方法 | 是否服务账本 | 处置 |
| --- | --- | --- | --- |
| 权限请求 | `item/{commandExecution,fileChange,fileRead}/requestApproval` | **是——请求本身就是「即将读/写」的声明** | 接线：auto-accept（不设第二道人工闸），读/写目标经 `commandExecution` item 的结构化 `commandActions[].path` 落足迹。见下方「本轮实现边界」。 |
| 用户输入请求 | `item/tool/requestUserInput`、`mcpServer/elicitation/request` | 否 | 最小应答（auto-decline）以免回合永久挂起；不建独立 UI。 |
| 回合中打断 | `turn/interrupt` | 否（车道健壮性） | 不接。teardown / 判死走 supervisor 的 killTree（Windows `taskkill /T /F`、POSIX 组杀），与 claude 车道一致——不先发 `turn/interrupt` 帧。回合级取消经 `context.running` 的 `ProcHandle.kill()` 树杀该进程。 |
| 上下文用量 | `thread/tokenUsage/updated` | 否（纯遥测） | render noop，与 claude 车道对 `contextUsageUpdated` 的处置一致。 |
| 模型目录 | 无（静态表） | 否 | 不做多 provider 模型选择器。 |
| slash 命令 | `skills/list` | 否 | 不做。 |
| 回合中转向 | `turn/steer` | 否（UX 便利） | 不做；用户可发新回合。 |

**权限请求 auto-accept 的理由**：Workbench 的并发哲学是建议式（ADR-0006）、单调优先（ADR-0007），seal（R2）是运行时唯一被授权打断写者的地方（ADR-0010 / `workbench.yaml` 的 `seal.mode`）。在 codex 车道里再引入 provider 自己的每次工具人工批准，等于设第二道拦截点，与这套哲学冲突。因此车道对 codex approval 请求一律 accept，把「该不该让这次写落地」的判断留给 seal。

### 本轮实现边界（2026-09-22 对抗式复审补记）

上表第 1 行的「请求本身就是读/写声明」是**设计意图**；实现到什么程度必须写明，否则这句话比代码承诺得多：

- **approval 请求只回 accept，不解析其 params**（`codex-app-server.ts` 的 `answerServerRequest`）。退役时迁入的 11 个 codex 夹具里没有任何一个包含 approval 请求，其 payload 形状没有可核对的样本；按猜测解析会把无法验证的声明写进账本。
- **真正进账的读足迹**来自 `commandExecution` item 的结构化 `commandActions[].path`（`codex-footprint.ts`），这条路径由夹具门禁证明（11/11 零 undecided）。
- **写侧尚无证据**：`WRITE_ACTIONS`（edit / write / applyPatch / createFile）与 `fileChange` / `fileRead` item 类型都没有夹具覆盖——11 个夹具里只有 `read` / `listFiles`。因此「写目标照常落账」目前是未验证的设计意图；未建模的 item 类型会以 `undecided` 被 `codex-turn.ts` 报警，不会静默丢失。
- ⚠️ **本句已由 ADR-0023 取代（2026-09-26）**：可归因的 codex 写审批现在会咨询封印（`codex-session.ts` 的 `sealApproval`），但缺读足迹、无审批或无法归因时仍然放行——所以「不受封印保护」这个结论仍然成立，只是原因变了。以下保留为作出本决策时的状态。
- **seal 不在这条车道上。** 上文「把该不该落地留给 seal」没有实现：`decideServerRequest` 不调用 `decideSeal`。`seal.decided` 只来自 Claude Code 的 PreToolUse hook（`workbench premises seal`）。codex 写文件被自动接受，不会因为前提失效而被拦住。在有 approval 夹具之前，不要为了补上这句话去猜 params。
- **复核条件**：拿到一个包含 approval 请求或写动作的真实 codex 会话后，补夹具门禁，并把本节收窄为已证事实。

## 验证方式

- **协议翻译层**：以退役轮迁入的 11 个 `packages/workbench/src/chat/fixtures/streams/codex/*.jsonl` 为门禁（TF-0248），断言每条事件都有显式 render 决策（零 undecided）、文本与足迹路径正确。夹具是 app-server 通知归一化后的形态，正好是翻译层的输入。
- **传输/驱动层**：假 app-server 脚本驱动一轮的集成测试（TF-0249），断言足迹落账、回合以 done 收尾、线程回 idle、`codexSessionId` 落库。负面路径同属门禁：进程中途死亡与启动失败都必须让回合以 error 收尾且线程回 idle（而不是悬挂），空闲关闭计时器必须被下一轮取消，前提通知必须按共享口径折入 prompt；另有单测钉住「静默的 app-server 被判死」。以上每条都做过对照实验：在修复前的实现上跑同一测试，四条全部失败。
- **不改 claude 默认**：`chat.provider` 默认仍是 `claude`，现有 claude 夹具与 HTTP 车道测试不变。
- **依赖不变**：`bun install` 不新增运行时依赖；单文件二进制构建产物形状不变。

## 复核

- 触发重估：出现第三个 provider 且其协议无法用「spawnSupervised + 纯翻译适配」表达（例如只提供 HTTP-only 的可观测通道）；或本决策的硬约束之一（不 import SDK / 单文件二进制）被要求放宽。
- 不因「codex 也有 steer/模型目录」而回填与账本无关的交互面：新增交互协议前，须先回答它如何服务前提账本。

## 补记（2026-09-27）：写侧证据已取得，边界由「尚无证据」收窄为「结构性缺席」

> 本节是**追加记录**，不改写上文任何句子。它收窄的是 §「本轮实现边界」里那句
> 「**写侧尚无证据**：`WRITE_ACTIONS`（edit / write / applyPatch / createFile）与
> `fileChange` / `fileRead` item 类型都没有夹具覆盖……因此『写目标照常落账』目前是
> 未验证的设计意图」，以及同一节末尾的复核条件「拿到一个包含 approval 请求或写动作的
> 真实 codex 会话后，补夹具门禁，并把本节收窄为已证事实」。

**已测量（真实运行，2026-09-27）**：codex `0.158.0-alpha.2.1`，隔离 `CODEX_HOME`
（`.agent-contexts/codex-verify`，profile：模型 `glm-5.3-flash`、provider `wb_verify`
→ `http://127.0.0.1:3065/v1`、`wire_api = responses`、`sandbox_mode = "read-only"`、
`approval_policy = "on-request"`），提示词要求模型用 `apply_patch` 把
`src/target.ts` 的 `export const target = 1;` 改成 `2`。同 recipe 下的对照：
`sandbox_mode = "danger-full-access"` 时**0 个 server→client 请求**（权限全开没有审批可抓），
`read-only` 时才逼出审批请求。

> 读数来源分层：模型调用由该轮 Lead 在 2026-09-27 执行（本节作者**未**重跑），
> 本节作者做的是复核磁盘产物（`.agent-contexts/codex-raw-dump.jsonl` 等）、
> 跑新增门禁测试、以及读代码路径。哪些是真实运行、哪些是代码读数，
> 见交接记录
> [`docs/handoff/2026-09-27-codex-write-capture.md`](../handoff/2026-09-27-codex-write-capture.md) §0。

- **写确实发生了**：回合末尾的读回命令输出 `export const target = 2;`；成功那次
  `apply_patch` 自报 `exitCode 0` / `Success. Updated the following files: M src/target.ts`。
- **整条流里没有任何原生写 item**：item 类型普查 = `agentMessage` 16 / `commandExecution` 22 /
  `reasoning` 16 / `userMessage` 2；`fileChange`、`applyPatch`、`fileRead` **各 0**。
- **审批不可归因**：5 次 `item/commandExecution/requestApproval` 全部 `kind: "command"`，
  `commandActions` 全部 `[{ "type": "unknown", "command": "apply_patch …" }]`——**没有 `path` 字段**。
  写目标 `src/target.ts` 只出现在散文 `reason` 里。
- **`commandActions` 侧也没有写类型**：22 个 action 中 8 个 `read`（都带结构化 `path`）、
  14 个 `unknown`（都不带）；`WRITE_ACTIONS` 一次都没出现。
- **模型把 `apply_patch` 当 shell 命令用**（`pwsh.exe -Command 'apply_patch …'`；
  成功那次是 `$patch = @'…'@` + `codex.exe --codex-run-as-apply-patch`），
  所以写不会变成原生写 item。

**收窄后的结论**：在这条车道上，写侧夹具门禁不是**尚未收集**，而是对本次抓取的
模型 / profile / 回合**结构性缺席**——真实写回合不产生 `fileChange` / `applyPatch` /
`fileRead` item，`codex-footprint.ts` 的 `WRITE_ACTIONS` 分支没有输入，
`codex-router.ts` 落账的只有读足迹。上文「未建模的 item 类型会以 `undecided` 被
`codex-turn.ts` 报警」仍然成立，并且**这一次也没有被触发**（这 6 类未建模形状是
`item/commandExecution/outputDelta` 等通知，不是 item 类型）。

**顺带测到的边界（同一次抓取）**：`approvalTargets` 对这 5 个真实写审批全部返回
`kind: "unknown"`（不是 `"write"`），因此 `session.ts` 的封印闸门
（`kind === "write" && paths.length > 0`）与「写审批无法归因到路径」提示分支
（同样要求 `kind === "write"`）**都不执行**——真实 `apply_patch` 写审批走的是默认
`accept`，且不打印任何诊断。结论与上文「seal 不在这条车道上」一致，但原因更具体：
不是「不解析 params」，而是**解析了却判不出写**。

**夹具与门禁**（本次新增）：
`packages/workbench/src/chat/fixtures/streams/codex/write-turn-0.158.jsonl`（第 12 个流夹具，
含读回证据与零写 item）、`packages/workbench/src/chat/fixtures/approvals/apply-patch-0.158.json`
（5 次真实写审批 params 原样）、`packages/workbench/src/chat/codex-write-capture.test.ts`
（逐条钉住上述读数）。若 codex 开始发 `fileChange` / `applyPatch` / `fileRead` item
或写类型 `commandAction`，该测试会失败，本节结论必须重做。

**不作泛化**：以上是**一个模型、一个 profile、一个回合**的观测。ADR-0023
「对某个命令的负面观测不能泛化到整个 CLI 版本」同样适用——这**不**证明 codex 在
别的模型、别的 `sandbox_mode` / `approval_policy`，或原生 `apply_patch` 工具可用时
也不发写 item。完整读数、recipe 与诚实边界见
[`docs/handoff/2026-09-27-codex-write-capture.md`](../handoff/2026-09-27-codex-write-capture.md)。

## 补记（2026-09-27 第二次）：上一条补记的「结构性缺席」不成立

> 本节仍是**追加记录**：上面两个 2026-09-27 / 2026-09-22 的小节都**不改写**。
> 本节明确**取代**上一条补记的结论句——即「**收窄后的结论**：在这条车道上，写侧
> 夹具门禁不是**尚未收集**，而是对本次抓取的模型 / profile / 回合**结构性缺席**——
> 真实写回合不产生 `fileChange` / `applyPatch` / `fileRead` item」。那句话的**前提**
> 已经由一个更宽的实验否掉，它不再是本条 ADR 对写侧的当前表述。
> 上一条补记里的其余句子——写确实发生了、第一次抓取的那条流里没有原生写 item、
> 那 5 个 `commandExecution` 审批不可归因、`commandActions` 侧没有写类型——都仍然
> 成立，且仍然是那一次抓取的忠实读数。被否掉的只有「**一次观测 → 结构性**」这一步。

### 否证它的读数（真实运行，2026-09-27，6 变体重复实验）

同一 recipe（codex `0.158.0-alpha.2.1`、隔离 `CODEX_HOME`、本地网关
`wb_verify`、`read-only` 沙箱、`approval_policy = "on-request"`）下重复了 6 条变体。
原始 dump 在 `.agent-contexts/codex-matrix/<label>.jsonl`，item 类型普查在
`.agent-contexts/codex-matrix/matrix.json`（两者均为本地未跟踪 scratch）：

| 变体 | 模型 / 沙箱 / 提示词 | items | 审批 |
| --- | --- | --- | --- |
| 01 | glm-5.3-flash / read-only / apply_patch | `commandExecution` 6、**`fileChange` 2** | 3 × `commandExecution`(unknown) + **1 × `fileChange`(kind write)** |
| 02 | glm-5.3 / read-only / apply_patch | `commandExecution` 12 | 3 × unknown |
| 03 | deepseek-v4.1-flash / read-only | `commandExecution` 6 | 无（写没落地） |
| 04 | sn-kimi-k3 / read-only | `commandExecution` 18 | 5 × unknown |
| 05 | glm-5.3 / workspace-write | 只有 `userMessage` 2（没有可用回合） | 无 |
| 06 | glm-5.3-flash / read-only / **新建文件** | **`fileChange` 2** | **1 × `fileChange`(kind write)** |

**关键**：变体 01 与上一条补记所依据的那一次抓取是**同一个模型、同一个 profile、
同一个提示词**，而它发出了 `fileChange` item。所以那一次的「零原生写 item」是
**回合间的方差**，不是结构性事实。变体 05 不构成任何证据（它没有产生回合）。

### 机制：写目标在 item 上，审批只带 `itemId`

变体 06 的有序事件（`.agent-contexts/codex-matrix/06-glm53flash-readonly-create.jsonl`，
已沉淀为 `packages/workbench/src/chat/fixtures/approvals/file-change-0.158.json`）：

```
item/started    id=call_49ea214b036846fcafa94549
                item={"type":"fileChange","id":"call_49ea214b036846fcafa94549",
                      "changes":[{"path":"…\\src\\notes.md","kind":{"type":"add"},"diff":"hello\n"}],
                      "status":"inProgress"}
item/fileChange/requestApproval
                params={"threadId":…,"turnId":…,"itemId":"call_49ea214b036846fcafa94549",
                        "startedAtMs":…,"reason":null,"grantRoot":null}   ← params 里没有任何 path
item/completed  … same item, "status":"completed"
```

变体 01 是同一形状、`"kind":{"type":"update","move_path":null}`、目标是
`…\\src\\target.ts`。**路径在 `fileChange` ITEM 的 `changes[].path` 上，靠
`params.itemId` 与审批关联；审批 params 本身不含路径。** 这解释了为什么
`approvalTargets` 对 `item/fileChange/requestApproval` 早就返回 `kind: "write"` 却
`paths: []`：不是方法判断错了，而是 params 里根本没有可收集的东西。

### 由此实现的关联（本次新增）

- `codex-app-server/file-change-paths.ts`（新）：纯函数 `fileChangeItemPaths(event)`
  从 `item/started` / `item/completed` 读出 `{ itemId, turnId, paths }`；以及
  `FileChangePathIndex`——**按回合**、**有上限**（`MAX_TRACKED_FILE_CHANGES`）的
  `itemId → paths` 索引。
- `codex-app-server/session.ts`：在通知分支里记录（`fileChanges.note(event)`，在
  router 看到该行之前），在终端帧（`turn/completed` / `error`）清空；应答审批时用
  `fileChanges.pathsFor(params.itemId)` 作为第三个参数传给 `approvalTargets`。
- `codex-app-server/approval-targets.ts`：新增**可选**第三参数 `itemPaths`，
  只对 `item/fileChange/requestApproval` 生效。模块保持无状态、纯、保守；
  `commandExecution` 的判定一字未改。
- 效果：原生写审批的 `kind === "write" && paths.length > 0` 闸门现在真的会成立，
  封印（`codex-session.ts` 的 `sealApproval`）被咨询；阻断时回 `cancel`。
- 顺带（上一条补记点出的沉默）：`kind === "unknown"` 的审批此前**不打印任何诊断**。
  现在它会打印一条「审批无法判定读/写，未咨询封印」，措辞只陈述已观测到的事实
  （判不出），不声称那是一次写。

**闸门**：`packages/workbench/src/chat/fixtures/approvals/file-change-0.158.json`
（变体 06 + 01 的原始帧，路径在 item 上、审批无路径）、
`packages/workbench/src/chat/codex-write-capture.test.ts`（关联前/后对照 + 用假
app-server 端到端证明封印拿到真实路径并被阻断），以及
`codex-app-server/approval-targets.test.ts` 的第三条参数用例。上一条补记的
`write-turn-0.158.jsonl` 与 `apply-patch-0.158.json` 保留不动，其「零原生写 item」
断言已按本文件范围收窄为**那一个回合**的读数。

**双向不作泛化**：这次是 6 个回合、4 个模型；它证明「原生 `fileChange` 写侧**存在**」，
**不**证明它是**唯一**的写路径，也不缩小上一条补记里那条 shell + `apply_patch` 写
（`commandActions[].type === "unknown"`、无 `path`）的不可归因性——那条今天仍然
不可归因、仍然只拿默认 `accept`。ADR-0023「对某个命令的负面观测不能泛化」对正反
两个方向同样成立。完整读数、实现与诚实边界见
[`docs/handoff/2026-09-27-codex-filechange-seal.md`](../handoff/2026-09-27-codex-filechange-seal.md)。

## 补记（2026-10-01）：原生审批路径的成对实测

接力 #31 在 Codex 0.159.0 + 显式原生 apply_patch 工具目录 + 本地 GLM profile 上取得 own-fresh / own-stale 对照：fresh 有一次 pass 和一条成功写足迹，stale 有一次 block 且不落盘，两者均无写回合复读。原生 item 与审批通过 itemId 归因；0.159 精选协议夹具和成对验收仪器进入仓库，详见[接力记录](../handoff/2026-10-01-issue-relay-closeout.md)。

这是对已观测原生审批路径的证明，不是全通道保证。第二次采集中的 stale 模型报告补丁上下文失配，未出现原生审批、封印未介入，该样本不能算通过；仪器会拒绝。无审批、未知目标、缺读足迹和失败放行的边界继续按 ADR-0023 披露。旧 shell/profile 的缺口读数保留为历史观测，新的原生成对命题独立登记，不改写旧结果。

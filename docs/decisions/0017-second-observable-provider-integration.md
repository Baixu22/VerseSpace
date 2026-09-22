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
| 权限请求 | `item/{commandExecution,fileChange,fileRead}/requestApproval` | **是——请求本身就是「即将读/写」的声明** | 接线：auto-accept 后照常落足迹。与「建议式并发 + seal 是唯一拦截点」一致（ADR-0006/0010）——车道不再设第二道人工闸。 |
| 用户输入请求 | `item/tool/requestUserInput`、`mcpServer/elicitation/request` | 否 | 最小应答（auto-decline）以免回合永久挂起；不建独立 UI。 |
| 回合中打断 | `turn/interrupt` | 否（车道健壮性） | 接 teardown / 判死路径：发 interrupt 再 killTree。 |
| 上下文用量 | `thread/tokenUsage/updated` | 否（纯遥测） | render noop，与 claude 车道对 `contextUsageUpdated` 的处置一致。 |
| 模型目录 | 无（静态表） | 否 | 不做多 provider 模型选择器。 |
| slash 命令 | `skills/list` | 否 | 不做。 |
| 回合中转向 | `turn/steer` | 否（UX 便利） | 不做；用户可发新回合。 |

**权限请求 auto-accept 的理由**：Workbench 的并发哲学是建议式（ADR-0006）、单调优先（ADR-0007），seal（R2）是运行时唯一被授权打断写者的地方（ADR-0010 / `workbench.yaml` 的 `seal.mode`）。在 codex 车道里再引入 provider 自己的每次工具人工批准，等于设第二道拦截点，与这套哲学冲突。因此车道对 codex approval 请求一律 accept，把「该不该让这次写落地」的判断留给 seal，而 approval 请求携带的读/写目标照常进足迹账本。

## 验证方式

- **协议翻译层**：以退役轮迁入的 11 个 `packages/workbench/src/chat/fixtures/streams/codex/*.jsonl` 为门禁（TF-0248），断言每条事件都有显式 render 决策（零 undecided）、文本与足迹路径正确。夹具是 app-server 通知归一化后的形态，正好是翻译层的输入。
- **传输/驱动层**：假 app-server 脚本驱动一轮的集成测试（TF-0249），断言足迹落账、回合以 done 收尾、线程回 idle、进程被 killTree。
- **不改 claude 默认**：`chat.provider` 默认仍是 `claude`，现有 claude 夹具与 HTTP 车道测试不变。
- **依赖不变**：`bun install` 不新增运行时依赖；单文件二进制构建产物形状不变。

## 复核

- 触发重估：出现第三个 provider 且其协议无法用「spawnSupervised + 纯翻译适配」表达（例如只提供 HTTP-only 的可观测通道）；或本决策的硬约束之一（不 import SDK / 单文件二进制）被要求放宽。
- 不因「codex 也有 steer/模型目录」而回填与账本无关的交互面：新增交互协议前，须先回答它如何服务前提账本。

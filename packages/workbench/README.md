# @baixu22/workbench

**Workbench 是写者中立的前提账本**：记录 agent、人和 git 读写过哪些文件，在已记录的前提失效时给出证据。agent 走 R2 + stdin 通知，人走 R2′ + 恢复卡，无法回答的问题进入裁决队列。状态保存在仓库内 `.workbench/`（YAML + JSONL），不依赖数据库或指定编辑器。

默认直接开始线性对话；分叉、恢复和证据查看按需出现。足迹覆盖有限，沉默不代表前提全部有效。工程边界见 [ADR-0010](../../docs/decisions/0010-premise-custody.md)，真实使用数据见 [fit 账本](../../docs/fit-ledger.md)。

## 安装

**方式一：下载单文件二进制**（无需 Bun）——从 [GitHub Releases](https://github.com/Baixu22/VerseSpace/releases) 下载对应平台的 `workbench-*` 可执行文件，放入 PATH。

**方式二：npm 形态**（需要 Bun ≥ 1.3）——**尚未发布**。2026-09-16 核实公开 registry 上 `@baixu22/workbench` 返回 404，下列命令在包正式发布前不可用，请改用方式一。

```bash
# 以下命令仅在包发布后可用；当前执行会 404
bunx @baixu22/workbench --help
bun install -g @baixu22/workbench
```

## 发行

**当前对外承诺的形态是方式一的单文件二进制**（`workbench-v*` tag → 四平台构建 → 挂到 GitHub Release）。npm 形态的目标没变，但被两件事挡住，都不是代码问题：本机 `~/.npmrc` 里的 npm token 已被 registry 拒绝（`/-/whoami` → 401），且仓库里没有把 publish 接进任何 workflow。

```bash
# 看这一版会打什么 tag（默认 dry-run，不做任何写操作）
bun run release:tag:workbench

# 真正发布：创建并推送 workbench-v<version>，触发 release-workbench.yml
bun run release:tag:workbench --push
```

`release-workbench.yml` 会先跑 `packages/workbench` 的测试，再交叉编译 windows-x64 / linux-x64 / macos-arm64 / macos-x64 并把产物挂到该 tag 的 Release。**推送 tag 是真实发布动作**，先确认 `packages/workbench/package.json` 的 version 与 CHANGELOG 已经更新。根目录只保留 `release:tag:workbench`；旧 Helmor 的 `release:tag` 与 `v*` 发布流程已随 ADR-0015 退役。

## 5 分钟上手

```bash
# 0. 在项目根目录初始化 .workbench/
workbench init

# 1. 添加目标（可带依赖与验收条件）
workbench goal add "实现 Blackboard 数据层" --acceptance "读写往返一致"

# 2. 记录架构决策（append-only，修正靠新决策取代）
workbench decision add "所有写走原子 rename" --rationale "防止并发写损坏"

# 3. 注册接口契约（漂移检测的锚）
workbench interface register contracts/api.md --key core/api

# 4. 创建工位并派发（创建真实 git worktree + 生成上下文）
workbench ws create ws-a --task <goal-id> --branch ws/ws-a
workbench dispatch <goal-id>            # 或 dispatch <goal-id> ws-a

# 5. Agent 在工位 worktree 内开发；完成阶段落 checkpoint
#    （.agent-context.md 已由 workbench 生成，告知 agent 遵守）
workbench checkpoint create --goal <goal-id> --workspot ws-a \
  --assertion "测试全绿" --strategy test

# 6. 跑一轮 runtime：验证 checkpoint → 推进状态 → 传播接口漂移
workbench sync

# 7. 后台监听模式（替代手动 sync）
workbench watch
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `init` | 幂等初始化 `.workbench/` 目录 |
| `goal add/list/show/cancel` | 目标 DAG 管理 |
| `decision add` | 追加架构决策（不可改） |
| `interface register/list/check` | 接口注册表与 hash 漂移检查 |
| `ws create/list/reassign/status` | 工位（git worktree 绑定）管理 |
| `checkpoint create/list/review` | 三区 checkpoint（staging/verified/failed） |
| `dispatch <goal> [ws]` | 派发就绪目标到空闲工位 |
| `sync` | 手动跑一轮 Runtime 循环 |
| `watch` | 后台监听，文件变化自动跑循环 |
| `status` / `map` / `log` / `queue` | 状态概览 / DAG 文本图 / 事件流 / 执行队列 |
| `doctor` | 全量一致性体检（错误退出码 1，可作 CI 闸门） |
| `config set <key> <value>` | 修改 `workbench.yaml` |
| `stats` | 分叉、恢复耗时、通知结局、地标认可率与样本不足情况 |
| `sessions list/record` | 写者记录；登记 git 或人的文件改动 |
| `premises` | 查看前提失效与通知；显式封印点 |
| `context list/lower/review --writer <id>` | 查看上下文、降低过时条目的兴趣，以及记录地标认可或拒绝反馈 |

所有命令支持 `--json`（机器可读）与 `--quiet`。

## 本地面板（GUI）

```bash
workbench ui            # 打开 http://127.0.0.1:7700（自动开浏览器）
workbench ui --no-open  # 只启动服务，适合自动验证与无界面环境
workbench ui --port 8080 --ui-dir ./some-dist
```

本地聊天面板支持线性对话、消息处分叉与双通道恢复卡，事实可点击查看原始消息、工具、事件和足迹。Claude CLI 支持工具足迹；HTTP 纯文本 provider 可聊天但读集不可观测，不参与读集继承。前端在 `apps/workbench-ui`（开发用 `bun run dev:ui`），资源内嵌进单文件二进制；npm 形态随 `dist/ui` 一起分发（ADR-0005）——**包本身尚未发布**，见上文「安装」。

HTTP provider 可从 `WORKBENCH_CHAT_API_KEY` 环境变量读取密钥，不必将它写入 `.workbench/workbench.yaml`。已保存的 `chat.apiKey` 优先；删除保存值不会清除进程环境中的密钥。聊天配置与面板状态 API 都只返回 `hasKey`，不返回密钥。OpenRouter 的 `chat.baseUrl` 可填 `https://openrouter.ai/api/v1` 或完整的 `/chat/completions` 地址，粘贴时两端的引号会被清理。

### 两条聊天车道的观测能力

| 车道 | provider | 读集（agent 读了哪些文件） | 前提失效时 |
| --- | --- | --- | --- |
| 工具车道 | `claude`（本机 Claude Code） | **可观测**：工具调用留下足迹，可追溯到具体文件 | 能定位受影响的消息，并给出证据 |
| 纯文本车道 | `openai-chat` / `openai-responses` / `anthropic` | **不可观测**：没有工具通道，读过什么无从得知 | 只能标注「读集不可观测、不参与继承」，不给证据 |

选择建议：要让前提链成立（读集继承、失效定位、分叉时的读集来源），用 `claude`；只做对话、不在意前提链，HTTP 车道可用且不需要本机 Claude 登录。面板线程头按**每一轮实际使用的 provider** 标注可观测性——provider 是全局配置，同一条线程换过 provider 时，标注跟着最后一轮走，不回头改写历史轮次。

### 以分支为主线（收养 adopt）

分叉出的支线聊出更好的方向时，不必把内容搬回源线程——在恢复卡的分支行点「以分支为主线」，该分支就升为主线程、源线程就地归档（`POST /api/chat/threads/:id/adopt`，`:id` 是被收养的分支线程）。收养只翻转身份：双方消息一字不改、不合并，源线程的分叉血统也原样保留。

收养随时可反转。已归档的源线程在侧栏标「已归档」，其线程头有「反转收养」按钮（`POST /api/chat/threads/:id/revert`，`:id` 是源线程）：源线程复归主线、分支线程降回支线。反转靠收养时打的一份身份快照，只记指针不记内容，成本与消息量无关，因此瞬时完成。

已归档线程仍可见、可检索、可点开，只是退出默认活跃列表；源线程在锚点之后新增的消息只留在源线程，不并入新主线程。收养与反转都落审计事件（`thread.adopted` / `thread.adoption_reverted`）。

## `.workbench/` 目录结构

```
.workbench/
├── workbench.yaml            # 配置（调度策略、保护规则、阈值）
├── blackboard/               # 唯一数据层（所有模块经它读写）
│   ├── goals/*.yaml          # 目标（状态机 + 依赖 + 接口锚定）
│   ├── decisions/*.yaml      # 架构决策（append-only）
│   ├── interfaces/registry.yaml
│   └── state/                # 工位、执行队列、已知冲突
├── checkpoints/              # staging / verified / failed 三区
└── events/events.jsonl       # 追加式事件审计日志
```

## 与 Agent 协作

派发时 Workbench 在工位 worktree 内生成 `.agent-context.md`（按工位声明的 `contextNeeds` 组装任务、验收条件、相关决策与接口）。让 Agent 阅读该文件即可——不侵入任何 Agent，利用已有的项目指令机制。调度策略由 `workbench.yaml` 控制：`manual`（默认，人工派发）/ `semi-auto`（提示建议）/ `auto`（自动填充空闲工位，受并发上限约束）。

### MCP（前提账本只读通道）

`workbench mcp` 在 stdio 上以 MCP 协议暴露**五条只读工具**（JSON-RPC 2.0，零 SDK 依赖）：

| 工具 | 回答的问题 |
| --- | --- |
| `premises` | 哪些写者读过的文件已被其他写者修改（待投递的前提失效通知） |
| `footprints` | agent 实际读/写了哪些文件（足迹账本） |
| `resume_cards` | 线程在离开期间发生了什么（读集 diff、恢复笔记、分支动静） |
| `tribunal` | 裁决队列里有什么在等人类决策 |
| `notices` | 通知投递情况（已投递 / 待投递） |

工具只读账本，不暴露编排动作；每个响应默认截断到 ≤2000 字符，防止把模型上下文吃光。运行目录需要有 `.workbench/`（`workbench init` 初始化）。

**Claude Code**：在项目根 `.mcp.json` 添加：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "bun",
      "args": ["packages/workbench/src/index.ts", "mcp"]
    }
  }
}
```

已安装单文件二进制时把 `command` 换成 `workbench`、`args` 只留 `["mcp"]`。也可用命令注册到用户级：

```bash
claude mcp add workbench -- bun /abs/path/to/packages/workbench/src/index.ts mcp
```

**Cursor**：Settings → MCP → Add global MCP server，command 填 `bun`，arguments 填 `["/abs/path/to/packages/workbench/src/index.ts", "mcp"]`；或使用项目 `.mcp.json`（Cursor 支持 `.cursor/mcp.json`，形状同上）。

## 开发

```bash
bun install
bun run test        # cd packages/workbench && bun test
bun run build       # 本机二进制 + npm JS 包及 UI 资源
bun run test:build  # 在独立工作区验证两种构建；需先运行 build
bun run build:all   # 交叉编译四平台二进制到 dist/
```

`test:build` 可用 `--native <二进制路径> --js <workbench.js 路径>` 指定独立构建。检测层基准可运行 `bun scripts/benchmark-premises.ts --json`；它验证合成场景的检测契约，不代表真实用户效果。

显式设置 `E2E_LLM_KEY`、`E2E_LLM_MODEL` 后，`bun run test:live` 会创建全新的临时仓库，用真实模型决定 Read/Write 工具调用，验证恢复、分叉、通知、证据与封印链路，并单独验证原生 HTTP 流式回合。`E2E_LLM_BASE_URL` 可选，**脚本默认 `https://api.senseaudio.cn/v1` + `senseaudio-s2-flash`**（见 `scripts/e2e/live-credentials.ts`）；换成别的 provider 时必须同时给定 `E2E_LLM_BASE_URL` 与 `E2E_LLM_MODEL`，端点、模型、密钥三者是配套关系。随后模型自主修复一个 URL 兼容问题，另一个线程恢复并复核，再验证三个持久分支确实继承 provider 历史与读集。工具只允许隔离仓库 `src/` 下的文本读写，不开放 shell，不读取配置或密钥；原始模型调用 ID、用量、线程和工具结果保存在该临时仓库。该模式会访问第三方模型服务；不会在普通 `bun test` 中运行。报告明确标注脚本驱动的动作和复核；模型判为 pass 也不能替代独立测试或冒充自然用户数据。

Windows 上如已配置仓库外 `%LOCALAPPDATA%/HelmorWorkbench/credentials/openrouter.dpapi`（当前用户 DPAPI 加密），可直接运行 `powershell -NoProfile -File scripts/e2e/run-live.ps1`；加 `-CheckOnly` 只验证凭据可读取，不调用模型。脚本运行结束后恢复原环境变量，不输出或保存明文密钥。

注意：`openrouter.dpapi` 只是历史文件名——**凭据文件叫什么，不决定它配哪个 provider**。实际 provider 由 `E2E_LLM_BASE_URL`（默认 `https://api.senseaudio.cn/v1`）与 `E2E_LLM_MODEL`（默认 `senseaudio-s2-flash`）决定，密钥必须与这组端点/模型配套；换 provider 时三者一起换，否则会得到 401 或 404。

Windows 入口默认模型为 `senseaudio-s2-flash`（默认端点 `https://api.senseaudio.cn/v1`），可通过 `E2E_LLM_MODEL`/`E2E_LLM_BASE_URL` 覆盖（历史默认 `cohere/north-mini-code:free`、`minimax/minimax-m3:free` 均已失效）。

**实测（2026-09-16）：默认模型过不了这条验收。** `senseaudio-s2-flash` 能跑完整链路（S0–S11 全过、30 次模型响应），但最后那关「模型产物独立执行 12 项 URL 用例」固定停在 **11/12**，差的是「尾部弯引号」标定，两轮纠正都修不动。换成 `doubao-seed-2-0-code-preview-260215` 后同样两轮纠正就收敛（10/12 → 11/12 → **12/12**），整轮 `通过；模型响应 49 次`。要跑通 `test:live` 的完整验收，请显式指定这个模型：`E2E_LLM_MODEL=doubao-seed-2-0-code-preview-260215`。两次读数都在 `.agent-contexts/integrity-fixes-2026-09-16/`。默认值未改——它同时也决定了日常开发用的模型，换不换留给人决定。S6c 在每次写入后检查各写者的家族通知，再分别记录投递与复读版本；通知离开待投递队列不等于前提已修复。完整集成阶段成功后立即保存 `runs/live-integration.json`，后续开发或分叉失败时，最终报告仍保留已完成的集成步骤，整轮 `ok` 仍为 `false`。

模型产物会独立执行固定 12 项 URL 用例，最多交回模型纠正两轮，全部结果保存在 `runs/live-validation.json`。如完整场景在开发阶段之前失败，可加 `-DevelopmentWorkspace <隔离现场路径>` 单独运行开发、恢复和分叉；只接受已有授权标记的现场，会重新初始化示例源文件，原 `runs/live-report.json` 保持不变，专项通过不代表完整场景通过。

架构决策见 [ADR 目录](../../docs/decisions/README.md)。目标、工位与 checkpoint CLI 保留兼容，当前开发主线是 ADR-0010 的前提守护；存量退役与收口见 [ADR-0015](../../docs/decisions/0015-legacy-retirement-execution.md) 和 [ADR-0016](../../docs/decisions/0016-retirement-closeout.md)。

## License

**MIT，含 Apache-2.0 部分。** 包本身以 MIT 发布（`LICENSE`）。内联主题 token 子集和
权限拒绝提示的移植实现来自 Helmor（Copyright 2026 Caspian Zhao, Nathan Lian），
按 Apache-2.0 分发；迁入的流协议夹具也保留原归属，仅用于源码参考与测试。
具体文件、来源与改动声明见 `NOTICE` 与 `LICENSE-APACHE`。

```
license: MIT AND Apache-2.0     # SPDX
```

这三个文件随每次分发一起走：`scripts/build.ts` 把它们复制进 `dist/`，包 `files` 字段把它们
留在 npm tarball 里，`release-workbench.yml` 把它们挂到 GitHub Release。Apache-2.0 §4(d)
要求分发时附上可读的 NOTICE，请不要删除。

"Helmor" 与 Helmor logo 是 Caspian Zhao 与 Nathan Lian 的商标。Apache-2.0 授权源码的
使用、修改与再分发，但不授权用该名称或 logo 标识本产品或派生品——所以本包以自己的名字
`@baixu22/workbench` 发布。

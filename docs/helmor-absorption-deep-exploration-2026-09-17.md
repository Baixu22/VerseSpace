# 深度探索报告：Workbench（主线）与 Helmor（支线）的关系、设计理念与吸收分析

- 日期：2026-09-17
- 分支：`feat/premise-evidence-base`
- 立场：**Workbench 是当前开发主线，Helmor 是支线**。本文按此立场梳理两者的真实关系（到细枝末节）、workbench 的设计理念与现有状况，以及应该把支线的什么地方吸收进主线。
- 目的：**为后续完整规划提供证据基础**。本文是探索与分析，不是规划。规划者应基于本文的已核验事实与约束给出方案。

## 0. 阅读须知：证据分级

每条结论带证据等级，规划者据此分配信任度：

- **【直接核验】**——本次会话中由 grep / git / 文件读取直接确认，附文件路径与行号。
- **【子代理盘点】**——由只读探索子代理通读源码后报告，附文件路径，未逐条复核，可信但动手前需抽查。
- **【判断】**——基于上述事实的推理，属分析意见，非事实。

**规划前必读的四份文档**（定义主线的尺子与支线的处置）：

- `docs/decisions/0010-premise-custody.md`——前提守护架构与产品边界，含一句取舍标准、五条硬约束与七项 non-goals
- `docs/decisions/0011-legacy-retention.md`——支线处置结论（保留，按实际引用抽取）
- `docs/decisions/0003-helmor-legacy-freeze.md`——冻结基线与"行为参考"声明
- `docs/fable-brief/05-review/D3-Q2-merge-back.md`——交互层"分支动静"的完整设计与验收标准（设计完成度最高、尚未落地）

---

# 第一部分：主线与支线的真实关系

## 1.1 一句话定性

**【判断】** 关系不是"基于 Helmor 修改"，也不是"完全独立"，而是：

> **Workbench 是产品，Helmor 是容器。** 主线的全部代码、数据、发版、用户价值都在 workbench 里；但主线今天仍寄生在一个 Helmor 命名的 monorepo 骨架里——工具链、锁文件、lint 规则、主题 token、图标生成、依赖提升，都由支线提供或共享。

这个"产品 / 容器"的倒挂，是所有弊病的根源：**主线在支线的壳里长大，却没有自己的壳。**

## 1.2 commit 与代码分布：主线已成立

**【直接核验】** 冻结基线 `dd87e97`（首个提交，无上游 git 历史）至 HEAD 共 216 个 commit，按路径统计：

| 路径 | commits | 性质 |
|---|---|---|
| `packages/workbench` | **96** | 主线核心 |
| `apps/workbench-ui` | **23** | 主线 UI |
| `packages/context-rot` | **6** | 主线兄弟包（指令文件腐化扫描） |
| `src`（支线前端） | 2 | `e5149d9` 图标层重生成 184 文件、`48c5925` 1 文件 |
| `src-tauri` | **0** | 支线后端，一行未动 |
| `sidecar` | **0** | 支线 agent 进程，一行未动 |
| `apps/marketing` / `apps/registry` | 0 | 支线外围（官网、手机配对服务） |

**主线 125 commit，支线有效改动 2 commit。** 主线在代码层面早已成立。

## 1.3 细枝末节：支线今天仍在为主线提供什么

**【直接核验】** 这是本节的核心——四样东西，逐条给路径：

### (1) 主题系统（运行时依赖）

- `apps/workbench-ui/src/index.css:10` → `@import "../../../src/styles/color-theme.css"`
- 该 import 不是借一个颜色。`index.css` 的注释自述 *"Reuses the repo's REAL theme file (single source of truth — no copied token drift)"*，并把支线 815 行主题的 **Base 层 token**（`--bg-base` / `--fg-default` / `--fg-default` / `--border-default` / `--status-success` 等）加整套 shadcn 协议层（`--color-background` ↔ `--background` 等 15 对）映射进 Tailwind
- 这是**全仓唯一的跨目录代码级 import**（workbench 与 workbench-ui 指向 `src/`/`sidecar/`/`src-tauri/` 的 TS/TSX import 均为 0，已精确 grep 核实，区分了包内自引用）

### (2) 图标层生成（构建时依赖，产物已入库）

**【直接核验】** 这是一条容易被忽略的耦合：

- `scripts/gen-icon-layer.mjs:10-11` 从**一个映射表**同时为两个 app 生成图标层：
  - `join(ROOT, "src/components/icon")`（支线）
  - `join(ROOT, "apps/workbench-ui/src/components/icon")`（主线 UI）
- 生成输入是根 `node_modules/reicon-react/index.d.ts`（`:16`）
- **生成物已入库**（`git ls-files` 确认 `apps/workbench-ui/src/components/icon/{index,reicon,compat,types}.ts` 均 tracked，未被 gitignore）
- 这解释了 `e5149d9` 为何改动 184 个支线文件——那是图标层重生成，严格说违反 ADR-0003 的"仅必要修复"冻结约定，但它是共享生成机制的必然副作用

### (3) 依赖提升与单一锁文件

**【直接核验】**

- `packages/workbench/node_modules` 只有 `@types`——**4 个运行时依赖（chokidar/commander/yaml/zod）全部从根 `node_modules` 解析**（已确认根存在）
- `reicon-react` 装在根 `node_modules`，主线 UI 与支线共用
- 单一 `bun.lock`（1MB+）覆盖全仓
- 根 `package.json` 的 `postinstall` 执行 `cd sidecar && bun install`——**每次主线开发者 `bun install` 都会装配支线的 agent SDK 依赖**

### (4) 工具链容器

**【直接核验】**

- 根 `package.json` 仍名 **`helmor@0.46.0`**，`workspaces: [".", "apps/*", "packages/*"]`
- `biome.json` 的 lint 覆盖全仓含支线（显式 ignore 列表里排除了 `.claude`、`.agent-*`、`worktrees` 等，但不含 `src-tauri` 源码——Rust 由 clippy 管）
- `.husky/pre-commit` → `bunx lint-staged --no-stash`；CLAUDE.md 记录该 hook 对 JS/TS 跑 biome、对 Rust 跑 clippy/fmt——**主线提交会触发支线的 Rust 检查**
- 根 `tsconfig.json` 的 `@/*` → `./src/*` 指向支线前端；主线 UI 的 `vite.config.ts` **故意镜像**该约定（注释 *"Mirrors the root app so `@/components/icon` resolves in both frontends"*）
- `typecheck` 根脚本串联五段：根 `tsc` → `sidecar` → `packages/workbench` → `packages/context-rot` → `apps/workbench-ui`

## 1.4 主线已经完全独立的部分

**【直接核验 + 子代理盘点】** 反向看，主线在产品层面不依赖支线的任何东西：

| 维度 | 主线自己的 |
|---|---|
| 包身份 | `@baixu22/workbench` @ 0.3.0，自带 `bin`、`publishConfig`、`engines: bun>=1.3`，repository 指向 `github.com/Baixu22/VerseSpace.git` |
| 依赖 | 4 个运行时依赖，零 agent SDK、零数据库驱动、零 Tauri |
| 持久化 | 纯文件系统：项目内 `.workbench/`（YAML + JSON + JSONL），无 DB |
| 发版 | 自己的 `scripts/tag-workbench-release.mjs` + `.github/workflows/release-workbench.yml`（四平台交叉编译，挂 GitHub Release）。README 明确指出根目录 `release:tag` 是**旧 Helmor 的 tag（v0.46.0），与本包无关** |
| 前端栈 | 独立 vite（端口 5188）、zustand、`@assistant-ui/react` + remark-gfm、radix-ui + motion——与支线的 react-query/context + streamdown + shadcn(base-nova) **完全分家** |
| 进程模型 | Bun 单文件编译二进制 + 本地 HTTP 面板（`ui/server.ts`，127.0.0.1 + UUID token），非 Tauri webview |

**注意**：主线 UI 重新引入了 `@assistant-ui/react`，而这恰是支线 CLAUDE.md 明文"已移除、不得再引入"的依赖。两套前端连 UI 约定都相反——**不存在渐进合并的可能**，这点规划者必须放弃幻想。

## 1.5 嵌入链：支线的 Apache-2.0 代码如何进入主线的发布物

**【直接核验】** 这条链把第 3 节的合规问题落实成可追溯的路径：

```
src/styles/color-theme.css          ← 支线 Apache-2.0 主题（815 行，Caspian Zhao / Nathan Lian）
  ↓ @import
apps/workbench-ui/src/index.css     ← 主线 UI，映射 Base 层 token 进 Tailwind
  ↓ vite build
apps/workbench-ui/dist/*.css        ← 68KB，token 值已编译进去
  ↓ packages/workbench/scripts/ui-prepare.ts
packages/workbench/src/ui/assets.generated.js   ← 已入库的嵌入资产清单
  ↓ src/ui/assets.ts 读取 + Bun.build --compile
packages/workbench/dist/workbench-{platform}    ← 单文件二进制，内嵌 UI 与主题
```

**结论**：主线每次发布，都把支线的 Apache-2.0 主题代码编译进一个声明为 **MIT** 的二进制里，且 `dist/` 中**无 NOTICE 无 LICENSE**（已核实）。

## 1.6 合规暴露面

**【直接核验】** `NOTICE` 文件要求：

- §4(b)：被修改的源文件须带"已变更"的显著标注
- §4(d)：衍生品分发须附 readable NOTICE，保留版权与归属
- **商标条款**：'"Helmor" 及 Helmor logo 是商标…**Forks must ship under a distinct name**。Apache-2.0 授权源码使用、修改、再分发，但**不授权使用 "Helmor" 名称、logo、品牌资产**

| 项 | 现状 | 要求 |
|---|---|---|
| 发布物含 Apache 代码 | **是**（见 1.5 嵌入链） | — |
| 许可声明 | `@baixu22/workbench` 声明 **MIT** | 须保留 Apache-2.0 与 NOTICE |
| `dist/` 中 NOTICE/LICENSE | **无** | §4(d) 要求附 |
| 包名 | `@helmor/workbench-ui`（支线商标） | fork 须用独立名称 |
| 根容器 | `helmor@0.46.0`（支线商标） | 同上 |

**【判断】** 这是主线"打着开发旗号在开源项目里做小项目"这一不舒服感的**法律层面具象化**，且它有明确解法：解掉 1.3(1) 的 CSS 耦合（Base 层子集内联进 workbench-ui）+ 补 NOTICE/归属 + 改名，是同一件事的三面。

---

# 第二部分：Workbench 的设计理念

## 2.1 命题与一把尺子

**【子代理盘点 + 直接核验】** `packages/workbench/README.md` 与 ADR-0010 的定性：

> **Workbench 是写者中立的前提账本**：记录 agent、人和 git 读写过哪些文件，在已记录的前提失效时给出证据。agent 走 **R2 + stdin 通知**，人走 **R2′ + 恢复卡**，两者都答不了的走**裁决队列**。

ADR-0010 给出唯一取舍标准，**任何规划都必须先过这一句**：

> 任何新功能先过这一句：它服务哪一类写者、走哪一条通道、答的是不是「你上次看到的东西现在还成立吗」。**三条通道之外的东西不是这个产品的。**

注意 ADR-0010 行文里把这条命题也写作"Helmor = 写者中立的前提账本"——那是历史用词，**实质指 workbench 主线**，规划者不要被字面迷惑。

## 2.2 架构主轴：一条日志、两类事实、三个投影

**【直接核验，ADR-0010 §1-2】**

- **一条日志** = `events.jsonl`。单调 `eventSeq` 在持有追加锁时分配、稳定 `id` 写一次不再派生。`seq` 只保留为物理行号兼容视图
- **两类事实** = 世界事实（读写集、前提、构建）与会话事实（`thread.*` 生命周期）。分两类因为**非单调性位置不同**：世界事实的非单调性在「状态」，会话事实的在「注意力」，衰减函数不同，不能共用一个投影
- **三个投影** = 前提 reconcile（`runtime/premises.ts`）、投递（`runtime/delivery.ts`）、上下文生成（`contextgen/`）。调度 WIP 投影只读世界侧

三支柱（交互 DOI、会话树、并发前提）此前是三个并列子系统，TF-0120 要求收敛。结论是：**可以统一，但统一的对象是「日志」而不是「语义」**。

## 2.3 五条硬约束（代码级拦截，不靠评审记忆）

**【直接核验，ADR-0010】**

| 约束 | 实现位置 | 为何存在 |
|---|---|---|
| **方向性不变量**：世界投影只折叠世界事件；会话事件可引用世界事件，世界事件永不引用会话事件 | `isWorldEvent()`（`types/event.ts`）按 `source !== "threads"` 与 `!type.startsWith("thread.")` **两条件**过滤；执行点 `contextgen/generate.ts` 与 `render.ts` 在入口就滤掉 | 「一个线程不是一条车道」由存储边界变成投影过滤器 |
| **命名边界**：`source=threads` 是会话事实，其余是世界事实 | `THREAD_EVENT_SOURCE` + `THREAD_EVENT_TYPES` 白名单；未知 `thread.*` **直接抛错**；`validateThreadEvent()` 递归拒绝 `status/verdict/done/passed/success/completed`（`FORBIDDEN_THREAD_KEYS`），在 `blackboard/events.ts` 的 `append`/`appendMany` 两处强制 | 会话事件一旦能带结论，会话侧就成了第二个状态机，方向性不变量当场失效 |
| **载荷上限**：世界事件进工位上下文须截断 | 默认 400 字符/事件（`DEFAULT_EVENT_LINE_CHARS`，配置键 `contextgen.eventLineChars`）；通知侧 token 预算默认 300，裁剪顺序先砍 diff、再砍文件列表、保留总数（`runtime/notice-render.ts`） | **上下文体量不得随载荷体量增长**。一条 `git diff` 的 maxBuffer 是 1MB，无上限等于允许一条事件吃掉整个工位上下文 |
| **禁止内容级合并** | `runtime/merge-guard.ts` 只买两样：`git merge-tree --write-tree --name-only`（真做一次合并，构造上零误报）+ 写集重叠账本（按**稀有度**过滤） | merge 时刻是错误的用力点；真功夫在上游把改动保持小。明确不做语义合并、不做 LLM 冲突解决（与开发者一致率 55–59%） |
| **L0 线性对话是默认，且不动它** | 新增交互功能**不得增加发出第一条消息前的任何步骤**（TF-0085）；分叉是一次 POST、零仪式 | 提议区间为空（见 2.4），所以系统直接做、用廉价回退兜底（`runtime/rollback.ts`） |

## 2.4 产品交互哲学

**【直接核验，ADR-0006/0008/0009 + D3-Q2】**

1. **提议区间恒空 → 直接做 + 廉价可逆**。Horvitz 几何在本机实测落入 `K(1/B+1/C)>1`，即"要不要合并？"这类提议 UI 永远不该出现。系统的正确行为是**直接做，用一次手势可撤销**
2. **交互只做加法，且可一次撤销**（ADR-0008）。分叉不改原线程一个字节（`chat/fork.ts`）
3. **无分歧不渲染、无证据不渲染**（D3-Q2 的门）。分支无账本差、无写、无接口 Δ → 不渲染任何东西
4. **事实在前、叙事折叠**。恢复卡每行事实带溯源 `refs`（seq / ledger 条目 / diff）；叙事只放展开区并标"由足迹拼接"，**且叙事不注入模型**
5. **诚实开关分两级，不合成一个布尔**。例：`agentContextInherited`（claude `--fork-session` 为 true）与 `premiseInherited`（读集继承，HTTP provider **恒 false**）分开标注——压成一个布尔会同时犯两个错
6. **宁缺毋滥（R9）**。信任建立的条件是"每一行都能点开验证且从未错过"；信任破裂的最快方式是一行错的 "verified"
7. **合并纪律**：≥3 个分支有动静合并为一行；dismiss 率 >50%（负样本）自动降级为 L0（熔断）

## 2.5 明确不做（七项 non-goals）

**【直接核验，ADR-0010】** 这七项**不是「以后再做」，是决定不做**。推翻任一条须新开 ADR 标注取代关系：

| 不做 | 理由 |
|---|---|
| 树导航 UI | 会话树是投影里的会话侧事实流，不是要导航的 UI 树 |
| agent 消息总线 | 跨会话 socket 在 Windows/WSL2 边界不可达（TF-0109）；已选 stdin 通知 |
| CRDT 代码底座 | 朴素多主并发更新率随主节点数 O(M²) |
| LLM 语义合并 | 与开发者一致率 55–59% |
| 3-4 级告警 | 只有两级：沉默 / 一束通知。分级等于要求人做优先级判断 |
| 通用 saga 逆操作注册表 | 回退只做 code 与 context 两面，且**必须有快照**，没快照就明确拒绝 |
| HTTP 纯文本 provider（作为前提守护通道） | 无工具通道 → 足迹恒为空集（`readObservability: "unobservable"`）。**仍可聊天，但不参与继承与读集观测** |

**这条尺子对吸收分析是决定性的**：支线的旗舰能力（一键创建 PR / 修 CI / inbox）全部落在"编排器"范畴，**恰恰是该被拒绝的**。

---

# 第三部分：Workbench 的现有状况

## 3.1 规模与技术形态

**【子代理盘点】**

- `packages/workbench/src/`：**294 个 `.ts` 文件、40,421 行**（含测试）
- 纯 Bun 1.3 + TypeScript；**4 个运行时依赖**：chokidar / commander / yaml / zod
- 无 SQLite、无任何数据库驱动、无 agent SDK、无 Tauri
- 版本 0.3.0；形态为单文件编译二进制（`scripts/build.ts` 交叉编译 windows-x64 / linux-x64 / macos-arm64 / macos-x64）
- ADR-0011 记录：**509 项测试与类型检查通过**

## 3.2 模块清单与职责

**【子代理盘点】** 核心循环：`snapshot → automaton(纯函数求值) → apply(落盘) → 重新锚定接口 → scheduler 派发`，由 `runtime/runOnce` 单一入口编排，通过 O_EXCL pid 锁保证全局单写。

| 模块 | 职责 |
|---|---|
| `blackboard/`（16 源） | **唯一数据层**。`openBlackboard()` 是所有模块碰 `.workbench/` 状态的唯一通道。goals/decisions/interfaces/state/checkpoints/events/sessions/tribunal/metrics/snapshot |
| `automaton/`（5） | 纯状态机求值：`evaluate(snapshot)` 无 IO、确定性、幂等。goal-machine（`planned→ready→in_progress→done`，`done→stale_done` 接口漂移）、checkpoint-machine、workspot-machine |
| `chat/`（41 源 / 21 测试） | **全仓最复杂模块**，对话 lane（见 3.3） |
| `runtime/`（28 源 / 21 测试） | 核心编排 + 前提守护（ADR-0010 主线）：premises / delivery / seal / rollback / merge-guard / notice-* |
| `scheduler/`（6） | 派发：tick（纯函数，manual/semi-auto/auto 三策略）、dispatch（check-ref-format → createWorktree → 激活 → 出队 → generateContext）、merge-guard、wip |
| `supervisor/`（6） | **所有 spawn 的唯一入口**：spawnSupervised / crash-loop 熔断（60s 内 3 次）/ killTree（Windows taskkill /T /F，POSIX 组杀）/ reapOrphans / argv 分割（为 `--settings {"a":"b"}` JSON 参数保留内部引号） |
| `tribunal/`（11） | 裁决队列：submit → rationalize（去重/限流/软底线）→ 建条目或抑制；escalation、lane-distress（车道挂起决策） |
| `verifier/`（1） | checkpoint 验证：test → `bun test`、type-check → `bunx tsc`、build → `bun run build`、human-review → `needs_human`；超时 300s |
| `agents/`（5） | 批处理 agent lane：startAgent → pid 锁 → 崩溃熔断 → 车道健康检查 → spawnSupervised → 流式落盘 JSONL |
| `interactions/`（8） | Mylyn 式 DOI 兴趣模型：衰减 + 生命周期自适应 + 父级传播（文件→目录→项目根，指数衰减）；landmark 认可/拒绝反馈 |
| `contextgen/`（2） | 组装 goal / decisions / interfaces / 过滤后的 world events / conflicts → 写 `.agent-context.md` 进 worktree；每事件行 400 字符上限 |
| `ui/`（7） | 本地 HTTP 面板：`Bun.serve`，127.0.0.1 + UUID token 鉴权，`idleTimeout: 120`（默认 10s 会杀慢启动 LLM 流）；每 15s 定时 reconcile + 投递通知进活会话 stdin |
| `fs/`（2） | 原子操作：writeFileAtomic（POSIX rename，Windows EPERM/EACCES/EBUSY 重试退避）、appendJsonlLine、O_EXCL pid 锁 |
| `git/`（2） | **极简**：`git(args, cwd)` 永不抛错返回 `{ok,code,stdout,stderr}`；`resolveInProject`、`createWorktree`、`normalizeBranchName` |
| `rot/`、`watcher/`、`doctor/`、`types/`、`commands/`（22）、`cli/`（4）、`test/` | 指令腐化扫描、后台监听（chokidar + 500ms debounce，把人与 git 变动登记为 writer）、一致性体检（可作 CI 闸门）、跨模块契约、命令实现、commander 注册、测试夹具 |

## 3.3 两条车道与观测能力差异（产品命门）

**【子代理盘点 + 直接核验】** 这是主线最重要的内部结构：

| | claude CLI 车道 | HTTP provider 车道 |
|---|---|---|
| 命令 | `claude -p --verbose --output-format stream-json [--include-partial-messages]`（`chat/claude-session.ts`，可用 `WORKBENCH_CHAT_COMMAND` 覆盖） | `chat/http-run.ts` 的 `runHttp()`，支持 `claude` / `openai-chat` / `openai-responses` / `anthropic` 四种协议（`types/config.ts:82`） |
| 会话保活 | `--input-format stream-json` 让进程跨轮次存活：首轮 `--session-id`，后续往同一常驻进程写新 turn；`--resume`；分叉 `--resume <src> --fork-session`；空闲 5 分钟才关闭 | 无状态 HTTP + 手写 SSE 帧解析（`http-stream.ts`，尾帧缺分隔符标记 `complete: false`，此时**绝确认通知投递**） |
| 足迹观测 | **有**：`claude-router.ts` 解析 `assistant + tool_use` → `extractFootprint` → `hashPathClaim` 读时打哈希；`user + tool_result` → 写时打哈希 + `recordActivity` | **无**：无工具通道 → 足迹恒空 → `readObservability: "unobservable"`（`thread-run.ts:68-70`） |
| 继承合法性 | 是（`--fork-session` 逐字复刻，`ForkDeclaration` 只在 provider 发出第一条 assistant/result 后才落定） | **永不**（ADR-0010 §5：HTTP 永远不是合法继承样本） |

**【直接核验】** 受控试用实测（commit `d419223`）：

> **UI 聊天走 HTTP provider 不产生足迹**（`footprintSeq: 0`，`withFootprints: 0`）…因此**前提失效链的观测必须走 agent 车道**

**即：前提守护（核心卖点）在用户最常用的交互面上失效。** 但修复路径有两条，代价差一个数量级：

| 路径 | 做什么 | 代价 | 拿到什么 |
|---|---|---|---|
| **轻路** | 让 UI chat 默认/优先走 claude CLI provider（provider 选择与默认值，`types/config.ts` 的 `chat.provider`）——**车道本身已实现且已有足迹** | 极小 | UI chat 立刻有真实读集足迹 |
| **重路** | 接入支线 sidecar 的 Claude Agent SDK（进程内工具事件） | 大（依赖、体积、协议适配、打包链） | 同上 + steer + 即时 abort + 统一权限弹窗 + MCP 注入 + 多 provider |

**【判断】** 若目标只是"让前提守护在 UI 生效"，**轻路就够，应先走**。重路的真实理由**不是补足迹，而是多 provider + 可靠性基础设施**。把两件事混为一谈会严重高估接入 sidecar 的紧迫性——这是规划必须拆开的第一个决策点。

## 3.4 数据与持久化

**【子代理盘点】** 零数据库，全部在项目内 `.workbench/`（`paths.ts:80` 向上发现，镜像 git 行为）：

- `workbench.yaml`（zod 校验配置）
- `blackboard/{goals,decisions,interfaces}/*.yaml`、`blackboard/state/workspots/*.yaml`、`state/queue/*.yaml`（一文件一条目）、`state/tribunal/`、`state/conflicts.yaml`
- `blackboard/sessions/<writer>/writer.yaml` + `footprint.jsonl`（每写者一份读写足迹）
- `checkpoints/{staging,verified,failed}/` 三区
- `events/events.jsonl`（撕裂行跳过不失败）
- `agents/<ws>/<ts>-<uuid>.jsonl` + `latest.json`、`threads/<id>/{meta.json,messages.jsonl}`
- `locks/`（pid 锁）、`proc/`（进程注册表）

并发安全：`writeFileAtomic` + `appendJsonlLine`（单行原子追加）+ O_EXCL pid 锁 + 运行锁（watcher/sync/POST /api/sync 三路归一，忙时报 `busy` 不竞争）。

## 3.5 测试与发版

**【子代理盘点 + 直接核验】**

- **98 个测试文件**，`bun test --timeout 60000`。分布集中在两半主线：`chat`（21）+ `runtime`（21）= 43%；最大单文件 `chat/threads.test.ts` 1318 行
- 薄弱区：`git/`（0 测试）、`cli/`（0）、`commands/`（22 源仅 2 测试）
- 另有 `scripts/e2e/live-run.ts`（`test:live`，需真实模型；README 记录 2026-09-16 实测：默认模型卡 11/12，换 `doubao-seed-2-0-code-preview-260215` 才 12/12）
- 发版：`release:tag:workbench` → `release-workbench.yml` 先跑测试再四平台交叉编译。**推送 tag 是真实发布动作**

## 3.6 真实使用状态：无样本

**【直接核验】** `docs/fit-ledger.md` 与 ADR-0010 复核：

- **所有护城河指标 = 无样本**；`stats --json` 仍是 **0 线程、0 次 fork**、`insufficient-history`
- L1「真人认可率」判据（阈值 ≥0.8 · 全站）**无数据**
- 受控试用（2026-09-16）是 Playwright/agent-browser 驱动真实 UI + agent 车道，边界严格执行（地标复核的 endorse/reject **没有代答**）。地标复核只扫出 **1 条**真实候选，文档明确"这一问必须由柏旭本人回答"——自动化"**只代替手，不代替数据**"
- 读数示例：线程 3 / 分叉 1 / switches 12 / restores 12 / resumeActions 1 / 观察窗 0.056 天

**【判断】** 主线是一个**架构极深、但还没有一个真实用户**的产品。这直接改变吸收优先级：不能按功能酷炫度排，要按"哪一块能先让真实使用转起来、先产生可读数"排。

---

# 第四部分：应该把什么地方吸收进主线

## 4.1 吸收的判据

**【判断】** 不是"支线有什么主线没有的"，而是逐项过 ADR-0010 的尺子：

> 它服务哪一类写者？走哪一条通道？答的是不是「你上次看到的东西现在还成立吗」？三条通道之外的不是这个产品的。

由此得到三类结论：**该吸收（可靠性基础设施）/ 想清楚形态再吸收 / 明确不吸收**。

## 4.2 该吸收：可靠性基础设施

**【子代理盘点 + 判断】** 共同特征：直接命中 TS CLI 运行时的典型短板，大多可零依赖翻译成 TS。

| 能力 | 支线证据 | 为何该吸收 | 主线现状 |
|---|---|---|---|
| **git ops 深度** | `src-tauri/src/git/ops.rs`（2085 行）：`worktree_holding_branch`（分支被哪个 worktree 占着）、`stash_create`/`stash_pop`（显式 `StashPopOutcome::Clean/Conflict`）、`workspace_action_status`（conflict_count + uncommitted_count + sync + push 聚合成一个状态对象）、`preflight_merge_ref`、`list_worktrees`/`remove_worktree`、`push_current_branch` | **最大空白**：dispatch 创建真实 worktree 却无法预检"分支已被别处占用"（会两工位抢同一分支）；stash 冲突会被 exit code 吞掉 | `src/git/` **仅 2 文件 4 函数**。merge-guard 已用 `git merge-tree --write-tree --name-only`，天然接续 |
| **sidecar 存活协议** | `sidecar/src/index.ts`：每 15s 心跳；**EPIPE vs stdin-EOF 双信号**区分"父进程没了 / 写管道坏了"（对应 issue #398/#402）；`uncaughtException`/`unhandledRejection` 只记日志绝不崩 | 主线 `supervisor/` 有 spawnSupervised / crash-loop / killTree / reapOrphans，但**没有进程存活心跳**；abort 只能 kill 子进程 | 代码量小、与现有 supervisor 同构，即战力 |
| **turn id 预分配** | `src-tauri/src/agents/persistence.rs`：流式事件 id 与持久化 id 天然对齐，前端无需二次匹配 | 主线 `chat/thread-repository.ts` 用 `messages.jsonl` 追加，id 对齐是隐痛 | 直接借鉴 |
| **pipeline 三段式** | `src-tauri/src/pipeline/`：accumulator（**每 provider 一份状态块**，`PushOutcome::Finalized/StreamingDelta/NoOp` 强制每种新事件类型做一次显式渲染决策）→ adapter → collapse（连续 search/read/shell 折叠成摘要行，规则对齐 Claude Code TUI：40 字符 pattern 去重 + 文件计数聚合）；`PipelineEmit::Full/Partial` 增量 IPC（终态发全量、delta 只发尾部，把每按键 IPC 压到几百字节） | **纯数据变换、零 IO 依赖，最适合 TS 翻译**。collapse 直接决定终端与 UI 输出体验；Full/Partial 把"忘了处理某种事件类型"变成强制决策 | `claude-router.ts` 已是雏形（按 `event.type` 分派），但无折叠、无增量策略 |
| **workspace 两阶段创建 + 双向回滚** | `src-tauri/src/workspace/lifecycle.rs`：Phase1（只写 Initializing 状态行）/Phase2（才建 worktree）拆分，使"创建中"可观测、崩溃可恢复、启动可清理；`branching.rs` 的 `rollback_continue_branch`——**git 操作与状态写入双向回滚**（DB 失败时回滚 git 操作）；archive 的 plan/validate/execute/restore 四段式 | 主线 `scheduler/dispatch.ts` 一气呵成（check-ref-format → createWorktree → 激活 → 出队 → generateContext），崩溃会留半个 workspot；TS 侧通常完全缺回滚层，是事故高发区 | **与主线纯文件系统持久化兼容，不需要 DB** |
| **`ProviderCapabilities` 数据化能力表** | `src-tauri/src/agents/provider_capabilities.rs`：把"该 provider 支不支持 X"编码成**数据**（supports_plan_mode / supports_steer / supports_context_usage / supports_slash_commands / requires_api_key），而非满地 `provider === "codex"`；前后端读同一份结构 | 主线已有 `agents/runner.ts`，换查表是直接收益；新增 provider 只改一处 + 一个测试矩阵 | 即战力 |

## 4.3 想清楚形态再吸收

| 能力 | 判断 |
|---|---|
| **MCP server** | **高价值且过尺子**。支线实现仅 `src-tauri/src/mcp/mod.rs`（142 行 stdio JSON-RPC 2.0，`protocolVersion 2025-06-18`，实现 initialize/ping/tools/list/tools/call，自建 DB 连接不依赖 Tauri 运行时）+ `catalog.rs`（16 工具，含 `helmor_workspace_run_action`：外部 MCP client 可触发与 GUI **完全相同**的动作，走同一 prompt 入口）+ `response.rs`（响应体积控制：字段白名单 + 递归删 null + 2000 字符截断）。<br><br>**为何过尺子**：MCP 是"agent 操作主线"的一条**通道**，正是 R2 语义（agent 走 R2 + stdin 通知）。代价极低，换来 Claude Code / Cursor / 任何 MCP client 原生调用主线的前提账本——可能是**最低成本的真实使用来源**。**最该抄的是响应体积控制**，因为 LLM 上下文就是成本 |
| **forge 内核** | **模式该吸收，功能不该吸收**。支线位于 `src-tauri/src/forge/`（GitHub + GitLab **多 provider 抽象层**，非 github 专用）：`gh`/`glab` CLI 包装 + per-spawn 设 `GH_TOKEN` 的**多账号无侵入**模型（从不修改全局 active-account 指针，惰性登出哲学）；`GithubResolution` 预检枚举（Ready/Initializing/Unavailable/Unauthenticated，把"为什么打不通"变成类型而非散布早返回）；`MergeMethods::pick()` 按 MERGE→SQUASH→REBASE 协商；`build_check_insert_text` 把 CI 失败渲染成多段文本注入会话。<br><br>**但"创建 PR / 修 CI"落在 non-goals（编排器）**。且注意：支线的 create-PR/fix/resolve-conflicts **本身就是 prompt 驱动的 agent session**（`src/lib/commit-button-prompts.ts` + `src/features/commit/hooks/use-commit-lifecycle.ts` 1013 行），只有 merge/close 是直接 GraphQL。**建议只取 `GithubResolution` 模式与 merge 方式协商，并入主线的 merge-guard 预测层** |
| **sidecar 多 provider** | 见第五部分。**理由必须是想做多 provider，不能是"补足迹"**。五家（claude/codex/cursor/opencode/kimi）均为完整生产实现，非 stub；统一抽象把各家的用户输入收敛成 `userInputRequest`（ask-user-question / form / url）与 `permissionRequest` |

## 4.4 明确不吸收

**【判断】**（均落在 non-goals 或与产品形态不符）：

- **Monaco 编辑器**（`src/features/editor/index.tsx` 1287 行）——CLI 产品形态不符；主线的 `verifier/` 已覆盖"代码是否改对"的判定
- **inbox（issue/PR/discussion 搜索，`forge/github/inbox.rs` 2153 行）、forge detect 六层探测链**——桌面应用特性 + 编排器外围
- **chat / non-git workspace 模式**——主线的 workspot 语义更窄更纯
- **LLM 语义合并 / CRDT**——主线自己的 non-goals，与支线一致
- **Tauri webview、SQLite 持久化、Rust 后端**——架构选择，不迁移

---

# 第五部分：不破坏主线生态的吸收路径

## 5.1 硬约束：主线的生态特征

**【直接核验 + 判断】** 任何吸收方案必须保住三点，否则就是破坏现有生态：

1. **零重依赖的单文件编译二进制**：4 个运行时依赖，`scripts/build.ts` 交叉编译。**直接 `import @anthropic-ai/claude-agent-sdk` 进主包会破坏这一点**（SDK 重依赖、编译体积爆炸）
2. **纯文件系统持久化**：无数据库。吸收任何持久化相关能力必须保持 FS 模型
3. **现有车道与 API 契约不破**：`workbench ui` 的 HTTP 面板（127.0.0.1 + UUID token，`/api/*` 路由，前端经 `/api` 代理消费）；CLI 的 `--json` / `--quiet` / 退出码（0/1/2）约定

## 5.2 关键洞察：sidecar 与主线是同一个架构形状

**【子代理盘点 + 直接核验】**

- sidecar **本身就是独立 Bun 编译二进制**（`sidecar/dist/helmor-sidecar-x86_64-pc-windows-msvc.exe` 已存在）
- 全仓 grep `@tauri-apps|tauri::|invoke(` 于 `sidecar/` → **0 匹配**。sidecar 里一行 Tauri 代码都没有
- 它与宿主的耦合**只是一条 JSON Lines 文本协议**（stdin 逐行 `{id, method, params}`，stdout 逐行 `{id, type, ...}`）+ 若干 `HELMOR_*` env 约定
- 主线的 `supervisor/spawnSupervised`（spawn + stdin 投递 + 逐行 stdout 分派）+ `chat/claude-router.ts` 的按 `event.type` 路由，**与 sidecar 的协议模型是同一个形状**

**因此最自然的接入点**：把 sidecar 当成一个更丰富的 spawn 目标——`spawnSupervised("claude -p --output-format stream-json", …)` 换成 `spawnSupervised("helmor-sidecar", …)`，路由器词汇表从 stream-json 换成 sidecar 的 typed event。**主线包依然零 agent SDK 依赖，生态不破。**

## 5.3 但代价必须看清

**【子代理盘点】**

- **心跳接收端要自己实现**：sidecar 只管每 15s 发心跳，45s 超时判定在支线 Rust 那一半（`src-tauri/src/agents/streaming/mod.rs` 的 `HEARTBEAT_TIMEOUT`）
- **打包链**：`sidecar/scripts/stage-vendor.ts`（1156 行）+ `vendor-platform.ts` 负责固定版本 + SHA256 严格校验（不匹配删文件并抛错）+ macOS 签名/公证（`APPLE_SIGNING_IDENTITY` + Entitlements）+ 跨架构（`TAURI_TARGET_TRIPLE`）。若要离线可复现运行，得一并搬，否则用户机必须有 claude/codex 在 PATH 上
- **契约级耦合**（非代码依赖，搬走或重写必须同步）：
  - passthrough 事件命名空间：`opencode/<type>`、`codex_*`、`cursor/<original>`
  - 模型目录同步：`sidecar/src/model-catalog.ts` 注释明写须与 `src-tauri/src/agents/catalog.rs` 保持同步
  - env 约定：`HELMOR_LOG_DIR` / `HELMOR_APP_VERSION` / `HELMOR_CLAUDE_CODE_BIN_PATH` / `HELMOR_CODEX_BIN_PATH` / `HELMOR_KIMI_BIN_PATH` / `HELMOR_OPENCODE_BIN_PATH` / `HELMOR_NODE_BIN_PATH` / `HELMOR_CURSOR_WORKER_PATH` / `HELMOR_CLAUDE_BG_DRAIN_TIMEOUT_MS`
- **可复用分层**：
  - **A 层（纯 TS 库，可直接 import）**：`session-manager.ts`（接口 + Provider 联合类型）、`emitter.ts`（全部事件类型 + `createSidecarEmitter(write)`，`write` 是函数，写文件/socket/内存都行）、`request-parser.ts`、`abort.ts`、**`active-turn-registry.ts`（begin-before-await 即时 abort，五家共用，无 per-provider abort 逻辑）**、`title.ts`（标题 + 分支名生成，五家共用）、`images.ts` / `image-resize.ts`（零原生依赖的图片尺寸/缩放）、`model-catalog.ts`、`context-usage.ts`、`pushable-iterable.ts`、`logger.ts`（NDJSON 环形日志）、`git-access.ts`、`agent-path-env.ts`（Windows 注册表 PATH 合并）、`agent-proxy.ts`（**仅 macOS**）
  - **B 层（provider 实现）**：依赖 `node:child_process` + 各 SDK npm 包，仍是纯 TS 无 Tauri
  - **C 层（唯一"宿主形状"的）**：只有 `index.ts`——stdio 传输、ready 握手、心跳、stdin-EOF 判定、EPIPE 容错、shutdown 礼让退出、`trackHandler` fire-and-forget 调度
- sidecar 有 **33 个测试文件**，`bun test` 直接跑，不需要 Tauri——搬走可连带把回归测试一起搬走

## 5.4 建议的吸收顺序（分析，非排期）

**【判断】** 先不整体接入 sidecar：

1. 先走**轻路**（UI chat 默认 claude CLI provider）解决足迹命门——见 3.3
2. 同时吃下 4.2 里**纯 TS、零依赖**的那几块（git ops 深化、pipeline collapse、两阶段创建 + 回滚、ProviderCapabilities、心跳协议）——这些不需要 sidecar，直接提升可靠性，且**只有 git ops 与 pipeline collapse 是用户能立刻感知的**
3. **MCP server 可提前做**——是"让别的 agent 用起来"的杠杆，可能是最低成本的真实使用来源
4. 等**多 provider 成为真实需求**（而非假设）时，再以 spawn-sidecar 形态接入

---

# 第六部分：交互层面的开发需要

## 6.1 现状

**【直接核验 + 子代理盘点】** 主线 UI 的交互组件（`apps/workbench-ui/src/components/chat/`）：fork 手势（`message-actions.tsx`，一条消息即隐式分叉点）、branch picker（`@assistant-ui/react` 的 `BranchPickerPrimitive`）、resume card（`resume-card.tsx` 175 行 + 后端 `chat/resume-card/` 5 文件）、promote thread、parked bar、decision ledger、suggestion chips、thread notices、settings。后端交互逻辑在 `packages/workbench/src/chat/`（41 源 / 21 测试）。

## 6.2 最缺的一拍：设计已完成、尚未落地

**【子代理盘点 + 判断】** D3-Q2 把恢复卡上的**"分支动静"L1 结构摘要**设计完了，验收标准都写好了：

- **内容** = 指针 + 一行：账本差（选了哪个 variant）· 写集(N 文件, hash) · 接口版本 Δ · merge-guard 预测（`git merge-tree` clean/conflict + 重叠账本）· **Verifier 状态**（`verified@cp-7` 或"未经 Verifier"）· 分支自身失效前提数
- **触发点** = 用户回到源线程的**恢复时刻**（零手势、自动、加法式）；adopt（"以分支为主线"）为唯一显式手势（改身份不改内容，拓扑操作）
- **门**：无分歧不渲染；无证据不渲染；≥3 个分支有动静合并为一行；叙事折叠标"由足迹拼接"且**不注入模型**；模型侧注入 ≤300 token、每分支每次 ≤1 行
- **明确否决**：L2 内容合并（伪造无人经历的线性史；LLM 语义合并一致率 55–59% = 掷硬币；模型读过即不可撤）
- **验收**：空分支零痕迹、refs 全溯源（测试断言渲染输出的 refs 完整性）、R3 措辞互斥（"未经 Verifier" 与 checkpoint id 不能同时出现）、dismiss ≤2s 且注入队列清空、adopt 可逆（快照逐项一致）、fit 指标（被展开/被点比例 ≥50%，否则自动降 L0）
- **熔断**：dismiss 率 >50%（负样本）→ 自动降为 L0；一行里若有 "verified@" 必须并列"分支自身 k 个前提已失效"，**从不出现"完成"二字**

**这是设计完成度最高、只差实现的一块**，且它正是前提账本向人交付价值的瞬间（R2′ 通道）。

**数据支持这个优先级**：受控试用 `resumeActions: 1` 而 `switches 12 / restores 12`——**恢复是高频手势，但恢复卡几乎没有被真正消费。**

## 6.3 另两个交互缺口

- **UI chat 的足迹不可见**：与 3.3 同源——即便后端有了足迹，前端也没有把读集 / 前提失效状态可视化出来
- **裁决队列无前端入口**：`packages/workbench/src/tribunal/`（11 源：queue/rationalize/kinds/escalation/lane-distress/queue-stats）目前只能 CLI 操作；它是"无法回答的问题"的第三条通道，**天然需要人参与**，缺 UI 等于缺了通道出口

---

# 第七部分：规划者必须明确拆开的决策点

**【判断】** 以下问题本文不替规划者回答，但规划必须给出答案：

1. **主线身份怎么收口？** 三个名字（根 `helmor@0.46.0` / `@baixu22/workbench` / `@helmor/workbench-ui`）+ 寄生在 Helmor 命名容器里的事实。是抽独立仓库、保留 monorepo 但改叙事与包名、还是别的？这决定合规解法的形态，也是"产品/容器倒挂"的根。
2. **合规解法做到什么程度？** 见 1.5–1.6。最小合规（内联 CSS + 补 NOTICE + 改名）还是彻底切断（连图标层生成 `scripts/gen-icon-layer.mjs` 也拆成主线自己的）？
3. **足迹命门走轻路还是重路？** 见 3.3。这是影响后续所有事的分岔——轻路只改 provider 默认值，重路引入 sidecar。
4. **编排器边界要不要动？** forge 的交付能力（PR/CI）在 non-goals 里，但 merge-guard 已在预测合并、tribunal 已在裁决冲突。边界划在哪？
5. **交互层先落哪一拍？** D3-Q2 的分支动静（设计已完成）vs tribunal 前端入口（通道出口缺失）vs 足迹可视化（依赖决策 3）。
6. **支线什么时候退役、以什么条件退役？** ADR-0011 要求"删除任一目录前须重新核查样式、构建、发布与 CI 引用，并另立决策"。退役条件是否该量化（例如"主线有 N 个真实用户后"）？注意 1.3 的四样东西是退役的实际障碍，不是 `src-tauri` 本身。

---

# 第八部分：证据索引

## 直接核验的关键路径

| 证据 | 路径 |
|---|---|
| 唯一跨目录代码耦合 | `apps/workbench-ui/src/index.css:10` |
| 被耦合的支线主题 | `src/styles/color-theme.css`（815 行） |
| 发布物含主题 token | `packages/workbench/dist/ui/index-BxpBlUQp-r3vak12p.css`（68,323 bytes） |
| 图标层共享生成 | `scripts/gen-icon-layer.mjs:10-11`（输出到两个 app）、`:16`（读根 `reicon-react/index.d.ts`） |
| 图标层生成物已入库 | `apps/workbench-ui/src/components/icon/{index,reicon,compat,types}.ts` |
| UI 嵌入链 | `packages/workbench/scripts/ui-prepare.ts` → `packages/workbench/src/ui/assets.generated.js`（已入库）→ `src/ui/assets.ts:41` |
| 合规要求 | `NOTICE`（Caspian Zhao, Nathan Lian） |
| 包身份 | `packages/workbench/package.json`、`apps/workbench-ui/package.json`、根 `package.json` |
| 依赖提升 | `packages/workbench/node_modules` 仅 `@types`；4 运行时依赖从根解析 |
| 发版链 | `scripts/tag-workbench-release.mjs`、`.github/workflows/release-workbench.yml`、`.github/workflows/ci.yml` |
| 工具链容器 | 根 `package.json`（`postinstall: cd sidecar && bun install`）、`biome.json`、`.husky/pre-commit`、根 `tsconfig.json`（`@/*` → `./src/*`） |
| 产品尺子与 non-goals | `docs/decisions/0010-premise-custody.md` |
| 支线处置 | `docs/decisions/0011-legacy-retention.md`、`docs/decisions/0003-helmor-legacy-freeze.md` |
| 受控试用读数 | `docs/integrity-fixes-closeout-2026-09-16.md` §8（commit `d419223`） |
| 无样本状态 | `docs/fit-ledger.md` |
| 交互设计 | `docs/fable-brief/05-review/D3-Q2-merge-back.md` |
| 冻结基线 | `git rev-list --max-parents=0 HEAD` → `dd87e97`；总 216 commit |

## 主线关键模块（子代理盘点）

`packages/workbench/src/`：`agents/runner.ts`、`chat/claude-session.ts`、`chat/claude-router.ts`、`chat/claude-turn.ts`、`chat/thread-run.ts`、`chat/http-run.ts`、`chat/http-request.ts`、`chat/http-stream.ts`、`chat/thread-repository.ts`、`chat/fork.ts`、`chat/resume-card/`、`chat/evidence.ts`、`supervisor/process.ts`、`supervisor/registry.ts`、`git/index.ts`、`git/refname.ts`、`blackboard/index.ts`、`runtime/index.ts`、`runtime/premises.ts`、`runtime/delivery.ts`、`runtime/merge-guard.ts`、`runtime/seal.ts`、`runtime/rollback.ts`、`scheduler/dispatch.ts`、`scheduler/merge-guard.ts`、`scheduler/tick.ts`、`tribunal/queue.ts`、`verifier/index.ts`、`ui/server.ts`、`ui/chat-routes.ts`、`ui/assets.ts`、`contextgen/generate.ts`、`contextgen/render.ts`、`interactions/doi.ts`、`fs/atomic.ts`、`fs/lockfile.ts`、`paths.ts`、`output.ts`、`types/config.ts`

## 支线关键模块（子代理盘点）

`src-tauri/src/`：`git/ops.rs`、`git/watcher.rs`、`forge/mod.rs`、`forge/provider.rs`、`forge/workspace.rs`、`forge/detect.rs`、`forge/github/{api,context,pull_request,actions,inbox}.rs`、`workspace/lifecycle.rs`、`workspace/branching.rs`、`workspace/files/{editor,changes}.rs`、`workspace/pr_sync.rs`、`agents/catalog.rs`、`agents/streaming/{mod,state,bridges}.rs`、`agents/persistence.rs`、`agents/system_prompt.rs`、`agents/queries.rs`、`agents/provider_capabilities.rs`、`pipeline/{mod,accumulator,collapse}.rs`、`mcp/{mod,catalog,response}.rs`、`models/workspaces.rs`
`src/`：`features/editor/index.tsx`、`features/inspector/sections/changes.tsx`、`features/commit/hooks/use-commit-lifecycle.ts`、`lib/commit-button-prompts.ts`
`sidecar/`：`src/index.ts`、`src/session-manager.ts`、`src/emitter.ts`、`src/request-parser.ts`、`src/abort.ts`、`src/active-turn-registry.ts`、`src/claude/session-manager.ts`、`src/codex/app-server-manager.ts`、`src/cursor/`、`src/kimi/`、`src/opencode-protocol/`、`src/title.ts`、`src/model-catalog.ts`、`scripts/stage-vendor.ts`、`scripts/vendor-platform.ts`、`scripts/build.ts`

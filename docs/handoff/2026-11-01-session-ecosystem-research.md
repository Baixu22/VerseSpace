# 2026-11-01 会话生态调研：dsh-superagent 与「会话生命周期」这条护城河

日期：2026-11-01。对象：`deepseek-ai/dsh-superagent-prototype`（2026-10-31 开源，MIT，TypeScript，当日本轮读取时 4708 star / 439 fork）、Claude Code / Claude Desktop、Codex，以及本仓 Workbench 现状。
性质：**调研与方案评估**，不是竞品实测。竞品结论来自源码与文档阅读（克隆到本机临时目录只读），不是运行结果。

## 1. 一句话结论

**「会话生态」不是护城河，能长期留住人的是「会话里那些被读过的东西还有没有效」。**
DeepSeek 这套做的是**授权与派工**（谁批准的、批到哪、派给谁、干完没），Claude/Codex 做的是**会话可续性**（同一会话能接着跑、上下文不丢）。Workbench 已经有第三条，而且只有它有：**前提账本**——谁读了哪个文件的哪个版本，之后谁改了，读的东西还成不成立。本轮把这条补上了缺的一块：**会话断了这件事本身**。

## 2. dsh-superagent 到底是什么

它的领域模型很小但很硬（`docs/001-domain.md`）：

```
Source ──Trigger──> Thread ──batch──> Eval ──Decision/Mandate──> Ticket ──Assignment──> Executor
                        └──Subscription fan-out──> Ticket ──Channel──> Source
```

| 概念 | 它解决的问题 | 与 Workbench 的关系 |
| --- | --- | --- |
| Source / Trigger | 外部事件流（Feishu、GitHub）的不重放与去重 | Workbench 没有；Workbench 的「事件源」是文件与工具调用 |
| Policy + Gate | 谁有权要工作、要到什么强度（explicit / inferred） | Workbench 没有；ADR-0006/0010 明确拒绝排他写锁 |
| Mandate | 一次批准的范围与依据，可被 Policy 撤销，不随 Ticket 结束而失效 | **无对应**，且**不建议加** |
| Ticket / Assignment | 授权工作单元 / 派给某次执行，可重派、可换 Executor | Workbench 有 workspot/dispatch，但语义不同 |
| Executor Session | 一个 Ticket 一个 worker 会话 + 一个目录 | 对应 Workbench 的 thread |

它最值得抄的不是模型，而是三条纪律：

1. **观察与裁决分离。** Trigger 的 disposition、Decision 的 reason 都是记录；Ticket 状态由自己的域规则推。
2. **存储先于动作。** 「决定之后要做什么」先落盘再执行，失败按 2s→1min 退避重试；只有连续三次失败才在总览报系统问题。
3. **重启有恢复注记。** Assignment 被打断后带着 recovery note 重启，明确告诉 Executor「先去核对目录、git 历史、GitHub 再重复任何外部动作」。

第 3 条正是 Workbench 上一轮**没有**的：我们在 `reconcileRunningOnStartup` 里把 `status` 复位 `idle`，**把「这一轮被切断」这个唯一记录一起抹掉了**。

## 3. 三家各自在护什么

| | Claude Code / Desktop | Codex | dsh-superagent | Workbench（本轮前） | Workbench（本轮后） |
| --- | --- | --- | --- | --- | --- |
| 会话能不能续 | `--resume` / desktop 会话列表，跨设备同步 | `thread/resume` | Session 持久化 + 重启恢复注记 | 有（claudeSessionId / codexSessionId / `hasResumableSession`） | 同左 |
| 上下文是否真继承 | 分叉是「复制历史」，不代表模型继承 | 同左 | Assignment 重派带注记 | 已有明文边界（复制 UI 历史 ≠ 继承上下文） | 同左 |
| **读过的东西还对不对** | 不做 | 不做 | 不做（它的 stale 只指配置并发冲突） | **做**（读集、版本、读集 diff、恢复卡、封印） | 同左 + 会话层 |
| **断了 vs 问了没答** | 不区分 | 不区分 | 用 Report 区分 | **不区分**（复位即抹） | **区分**（`thread.turn_interrupted`） |
| 授权模型 | 无 | 无 | **有**（Mandate） | 无（且刻意不做） | 无 |

结论：**横向功能上，Workbench 打不过任何一家**（没有分发、没有模型、没有桌面端）。纵向深度上（「这份工作现在还能不能被信任」），**只有 Workbench 在认真做，而它此前缺的正是会话这一层。**

## 4. 护城河应该怎么定义（三条，可检验）

不是我发明的口径，是本仓既有 ADR 的自然延伸：

1. **前提（ADR-0010 / ADR-0026）**：读出的事实带版本、带范围、带来源类型；四类事实不互相冒充。
   *检验*：`claim-moat-input-origin` / `claim-moat-consumption` / `claim-moat-portable-evidence`。
2. **延续（ADR-0027，本轮新增）**：会和会断的会话在读数上不同形；中断是观察不是失败；恢复以「之后有没有人替这轮说过话」为判据。
   *检验*：`claim-session-continuity`（12 pass）。
3. **交接（ADR-0020）**：结果可换机复现；过程证据留本机；交接记录是唯一耐久记录。
   *检验*：`check:upload-surface`、`docs/handoff/`。

**这三条的共同形状是「拒绝把沉默当成通过」**——unknown 不算 pass、exit 2 不算 pass、没读数不算 done、投递积压不算会话健康。这才是护城河：不是功能，是**度量纪律**。竞品都能加功能，但改掉「用沉默当绿灯」的习惯很难。

## 5. 为什么不做 dsh-superagent 那套

- **授权模型需要身份体系。** Mandate 的前提是「谁在这个 Source 上是谁」——GitHub login、Feishu open id、bot 白名单。Workbench 是本地单机编辑器，没有身份，硬做只能做出一个假的授权感。
- **派工会把产品变成调度器。** Ticket/Assignment/Executor 一旦进来，就要有并发槽、目录分配、失败重试、暂停处理——这条路的终点是 dsh-superagent 自己，而且它有先发优势。
- **它会稀释前提账本。** 每加一个领域概念，event 就要多一类，投影就要多一层；而 Workbench 的差异点恰恰是**概念少、事实硬**。ADR-0009 早就实测过「提议的成本 > 撤销的成本」，同一逻辑适用于领域概念：**能用一个属性解决的需要，不要加概念。**

## 6. 本轮落地的切片（详见 [ADR-0027](../decisions/0027-session-continuity-projection.md) 与[交接记录](2026-11-01-session-continuity.md)）

一句话：**先把会丢的事实留住，再把它读成一份三态读数。**

```
启动清扫 ──(先)──> thread.turn_interrupted 事件（atMessageCount / 末条消息 / reason）
         └─(后)──> status: running → idle

sessions continuity [thread]
  ├── intact   没有观察到需要人处理的事实（≠ 已证明正确）
  ├── review   有一条具体事实，进 because（+ refs 可核对）
  └── unknown  材料本身不够，进 unknowns
  └── delivery 未投递通知单列（CLI 标 ~），不并入 state
```

**为什么不并入 state**：真实账本实测 30 条会话里 20 条同时带积压——并进去，「会话断了」会被淹掉。这是本轮的实测发现，不是设计洁癖。

## 7. 还没做的（按价值排序，都不在本轮授权内）

| 优先级 | 候选 | 为什么值 | 前置条件 |
| --- | --- | --- | --- |
| 高 | 面板消费延续性读数（恢复卡加一维「这一轮是被切断的」） | 恢复卡已经在渲染分支事实，接一维成本低 | 先定义 `~` 放哪一行，否则重演「多一个红点没人看」 |
| 高 | MCP 第 6 个只读工具 `continuity` | 让 Claude 能在回合中问「我这条会话上次是不是被打断了」 | 新增表面漂移测试；守 ADR-0023 只读边界 |
| 中 | 中断原因细分（`provider-exit` / `user-kill` / `host-crash`） | 现在只有 `host-restarted`，判据够用但不够准 | 需要真实中断样本，不能凭想象加枚举 |
| 中 | 会话侧「前提积压」与「会话断点」的联合视图 | 两者同时出现时，人需要知道先看哪个 | 需要一次真实复合场景 |
| 低（不建议） | 授权 / 派工 / Ticket | 见 §5 | — |

## 8. 复核

```bash
bun packages/workbench/src/index.ts sessions continuity              # 真实账本
bun packages/workbench/src/index.ts --json sessions continuity <id>   # 单条
cd packages/workbench && bun test src/chat/continuity.test.ts --timeout 60000
node scripts/moat/check-scope-adr.mjs --json && node scripts/check-claims.mjs
```

来源（本轮实际读取）：`github.com/deepseek-ai/dsh-superagent-prototype` 的 `docs/000-philosophy.md` … `docs/008-cookbook.md`、`src/core/ports.ts`、`src/core/model.ts`、`src/app/sessions.ts`、`src/app/delivery.ts`、`src/app/notices.ts`；本仓 ADR-0010 / 0017 / 0020 / 0022 / 0023 / 0024 / 0026。

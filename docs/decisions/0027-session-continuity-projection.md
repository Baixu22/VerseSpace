# ADR-0027：会话延续性作为账本的第四个投影

- 状态：已接受（2026-11-01，用户要求：按会话生态方向做纵向增强，整理护城河）
- 补充 ADR-0010 的前提投影与 ADR-0023 的研究原型边界。ADR-0023 的功能冻结只在本文件声明的纵切片内放开；ADR-0024 的退役范围不变。
- 追踪：本轮无任务森林节点（森林是本机 untracked 的编排脚手架），读数登记在 `evidence/readings/claim-session-continuity.json`。

## 问题

「这条会话还能不能被接着做」现在没有单一答案，而且答案会丢。事实分散在三个写者里：

| 写者 | 记了什么 | 缺什么 |
| --- | --- | --- |
| `threads/<id>/meta.json` | 身份（claudeSessionId / codexSessionId）、绑定的 provider/model/endpoint、`status`、分叉血统、晋升 | 没有「这一轮结束了没有」 |
| `threads/<id>/messages.jsonl` | 说过什么 | 说不出「最后一条为什么没有回复」 |
| `events/events.jsonl` | `thread.created/forked/left/restored/switch`、通知投递 | 没有回合被切断这件事本身 |

具体缺口是 `packages/workbench/src/chat/threads.ts` 的启动清扫：宿主进程在回合中途死掉时 `status` 停在 `running`，清扫把它复位 `idle`。**复位是对的，但它抹掉了唯一记录了「这一轮还没结束」的字段**——之后能看到的只剩一条没有回复的人类消息，和「用户问了没等回答」完全同形。于是同一份账本里，「断了」和「问了没答」被压成一种样子。

## 决定

**把会话的生命周期当成第三个事实类，与前提、产物并列，做成只读投影。** 不新增存储，不改 provider 会话，不做自动接管。

1. **先记观察，再复位。** 新增线程事件 `thread.turn_interrupted`（`packages/workbench/src/types/event.ts`）。启动清扫在复位 `status` 之前落一条，带 `atMessageCount` 与末条消息身份；写事件失败只报错、不阻止复位（卡在 running 比少一条观察更糟）。事件类型仍是观察：`validateThreadEvent` 的禁判词表照常生效，中断不带 status/verdict。
2. **投影是新模块 `chat/continuity/`。** `types.ts` 定形状，`derive.ts` 是纯函数（不读时钟、不写盘、不调模型），`read.ts` 把三处写者折成输入。同一批事实只有一种读法。
3. **三态，且理由与缺口分开列。** `intact`（没有观察到需要人处理的事实，**不是**「已证明正确」）、`review`（有一条具体事实需要人看一眼，进 `because`）、`unknown`（推导材料本身不够，进 `unknowns`）。需要人看的事实优先于材料不足。
4. **投递积压单列，不并入 state。** 未投递的前提通知常常是同一个后端在几十条旧会话上的同一个事实；混进 `review` 会把真正的会话断点淹掉（本轮在一个真实的 30 条会话账本上量到 20 条会话同时带积压）。它照常出现在 `delivery` 里，CLI 用 `~` 单独标一维。
5. **恢复的判据是「之后有没有人替这轮说过话」。** 中断之后出现助手消息即视为返回过（`recovered`），记录保留但不再排进待办；没有则排进 `because`，并引用事件 id 供核对。
6. **CLI 面：`workbench sessions continuity [thread]`。** 无参数列全部会话并计数，带线程 id 给详情；`--json` 输出同一份投影。只读——不重跑、不重投、不动线程。

### 判定表

| 观察 | state | 进哪一栏 |
| --- | --- | --- |
| 中断之后没有助手消息 | `review` | `because` + `refs`（事件 id） |
| 末条是人类消息，且没有未恢复的中断解释它 | `review` | `because` |
| `status` 仍是 `running` | `unknown` | `unknowns`（这一轮是否结束没被记录） |
| 本地 CLI 车道有消息但缺 provider 会话 id | `unknown` | `unknowns` |
| HTTP 车道无 provider 会话 id | 不扣分 | 它本来就按消息文本重放，没有上游会话可续 |
| 有未投递前提通知 | 不改 state | `delivery`（CLI 标 `~`） |
| 以上都没有 | `intact` | — |

## 边界：这个切片不做什么

- **不是恢复能力的扩大。** 它只把已有事实读成一份可核对的读数。会话能否真的接着跑，仍由 provider 会话身份与 `reload`/`fork` 的既有规则决定（README「分叉与恢复」一节未改）。
- **不接管、不自动。** 没有自动重跑、自动重投、自动归档或自动修复；不因为 `review` 触发任何动作。
- **不跨 provider 迁移历史。** 车道切换的「复制界面历史 ≠ 模型继承上下文」这条边界继续成立。
- **不接 MCP 与面板。** MCP 仍是五条只读工具，面板本轮不消费这份投影。接它需要新的表面测试与一次产品读数，不在本决定内。
- **不是「会话已通过」的证明。** `intact` 只说明没有观察到需要人处理的事实；它不证明上一轮结果正确、不证明前提仍然有效（那是 ADR-0026 的四类事实），也不证明用户会认可。
- **不声称真人收益。** ADR-0024 的退役不变：非 Windows 实机与真人研究不恢复，本切片的读数是 Windows 本机工程读数。

## 与 dsh-superagent 的位置关系

DeepSeek 的 `dsh-superagent-prototype` 也在做会话生态，但它的重心在**授权与派工**：Source/Trigger/Thread/Eval/Mandate/Ticket/Assignment 一套领域模型，会话只是 Executor 的载体，重启时的恢复注记是它执行层的一个细节。Workbench 的重心在**前提与延续**：谁读了什么、版本变没变、读的东西还在不在。两者不冲突，也不互相取代：

| 问题 | dsh-superagent | Workbench 本切片 |
| --- | --- | --- |
| 这项工作有没有被授权 | 有（Mandate） | 无（不做授权模型） |
| 会话中断后该不该继续 | 由 Assignment 重启 + 恢复注记 | 只回答「有没有一条没被回答的中断」 |
| 读过的文件变了没有 | 不做 | 做（ADR-0010 / ADR-0026） |
| 会话能不能被信任着接手 | 未单列 | 本切片 |

因此本决定的可复用价值不是「又一个会话看板」，而是：**把一个原本会在复位时被抹掉的事实变成账本里的一等观察，并让「断了」与「问了没答」在读数上不再同形。**

## 验收与读数

- 单元与现场用例：`packages/workbench/src/chat/continuity.test.ts`（12 pass / 0 fail，含纯函数判定表、真实临时账本、清扫先记后复位、恢复后不再待办）。
- CLI argv 面：`packages/workbench/src/cli.test.ts` 的 argv 表新增 `sessions continuity` 一行，完整性测试拒绝漏配。
- 类型与风格：`bunx tsc --noEmit` 与 `biome check` 通过。
- 声明：`claim-session-continuity`（`evidence/readings/` 有实际执行退出码与 pass 数）。
- 本机已知噪声：注入代理与沙箱下的 codex/ui 进程类用例会在本机超时（AGENTS.md 记录的环境缺陷），与本切片无关，未计入读数。

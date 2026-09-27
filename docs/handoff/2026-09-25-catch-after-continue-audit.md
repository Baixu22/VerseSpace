# catch 后继续：仓库级错误身份审计表（TF-0261 · 2026-09-25）

> **双标签口径：工程门通过（仅限本地可执行范围）/ 产品证据不足。**
> 分支 `qa-stage-ab-remediation`，改动**仅本地 commit，未 push、未打 tag、未发布**。
> 本报告不含任何用工程测试冒充真实浏览器、真实 provider 或真人数据的结论。

---

## 0. 结论摘要

TF-0261 上一轮只做到「反馈 schema 已落地 + 审计表覆盖本轮命名的路径」，仓库级 sweep 未做
（deviation `TFD-c76055ffad`）。本轮把它做完：

| 项 | 读数 |
| --- | --- |
| 扫描范围 | `packages/workbench/src`（非测试）61 个文件 |
| **实际 catch 站点** | **140**（另有 5 处是文档注释里提到的模式，不计为站点） |
| 覆盖模块 | agents / blackboard / chat / commands / doctor / fs / git / mcp / runtime / scheduler / supervisor / tribunal / ui / watcher / yamlio / index.ts |
| **本轮修掉的真实缺陷** | **4**（全部先红后绿，见 §4） |
| **已定性、未修** | **8**（见 §5，交下一条接力） |
| 新增测试 | 4 条（3 文件），RED 时逐条打出缺陷特征 |

**这轮最重要的发现不是那 4 个修掉的 bug，而是 TF-0256 留下的那句注释是错的**：
它写着「`restore` 用 safeParse，所以不在范围内」，而 `restoreObservationSchema` 的字段**全是可选的**——
`{}` 能通过校验。于是「畸形 body → 执行默认动作 → 写一条审计事实」这个 F-04 缺陷，
在它自称已收口的那一轮之后，仍然活在 4 条写路由上。

**并且 TF-0261 自己的验收第 2 条（「反馈/恢复类 API 用 schema，不再任意 payload 直接写事件」）此前并未达成**：
`resume-note` PATCH 是一个未校验的 `as` 断言，`{"beats":"evil"}` 会原样写进线程 meta。

---

## 1. 范围与方法

- **范围**：`packages/workbench/src` 下的生产文件（排除 `*.test.ts`）。`apps/workbench-ui` 是前端，
  其失败面由浏览器 E2E 承担，不在本表（E2E 本机跑不起来，见 §7）。
- **方法**：先机械清点（`catch (` / `catch {` 站点），再逐站点读上下文判定四列，不靠命名或注释推断。
  清点脚本与原始 dump 留在 `.agent-contexts/forest-status/`（本机 machine-state，不上传）。
- **四列口径**（本节点验收原文）：
  1. **错误是否可见**——有人在 stderr / 返回值 / 持久状态里能看出「这里失败过」吗；
  2. **是否改变状态**——失败之后系统状态变了没有（变了是「显式降级」还是「损坏冒充健康」）；
  3. **是否可重试**——下一次调用/下一 tick 会不会自然再试；
  4. **是否产生事件**——有没有一条持久化审计事实。
- **本表的判定是「这条路径**允许**怎么降级」，不是「代码好看不好看」。允许静默的前提是
  **静默不会把损坏说成健康**；凡违反这条的，就是 §4/§5 里的缺陷。

## 2. 图例

| 原型 | 失败时的行为 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| **P1** | 解析失败→跳过该行/该条（torn 输入视为正常） | 否 | 否 | 否 | 无 |
| **P2** | 读失败→返回空/默认（缺失与损坏同形） | 否 | 否 | 是 | 无 |
| **P3** | 点名后继续（`console.error`） | 是 | 否 | 视调用方 | 无 |
| **P4** | 转成带身份的错（`BlackboardDataError` / 抛出） | 是 | 否 | n/a | 无 |
| **P5** | 幂等忽略（已关的 stdin / 已死的 PID） | 否（无信息量） | 否 | n/a | 无 |
| **P6** | **静默丢弃本可上报/本可重试的失败** | **否** | 否 | 是 | 无 |
| **P7** | 类型化失败状态（计数/标志/lifecycle）并继续 | 是 | **是（显式）** | 是 | 视情况 |
| **P8** | 显式「证明不了」（false/null ≠ 通过） | 是 | 否 | 是 | 无 |
| **P9** | 尽力而为清理（失败无后果） | 否 | 否 | 是 | 无 |
| **P10** | 客户端错误（400/404，不写事件） | 是 | 否 | 是（客户端重发） | 无 |

## 3. 审计表

### 3.1 `git/`（3 个站点 + 11 个 `git()` 调用点）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `git/host-filesystem/probe.ts:79` | 探针期望的失败；记录 `errorCode` 后判 `unsafe`/`indeterminate` | 是 | 否 | 是 | 无 |
| `git/host-filesystem/probe.ts:104` | 探针整体异常 → `verdict: indeterminate` | 是 | 否 | 是 | 无 |
| `git/host-filesystem/probe.ts:121` | 清理重试 3 次后放弃（**刻意不冒泡**） | 否 | 否 | 是 | 无 |

`git()` 本身 never-throws：宿主守卫命中时返回 `{ok:false, stderr:拒绝原因}`（`git/index.ts:31-39`）。
**11 个生产调用点逐条核过**，10 个检查 `ok`/`code`；唯一不检查的是
`git/worktree.ts:144` 的 `worktree prune`——结果被整个丢弃（§5 OPEN-8）。

### 3.2 `scheduler/`（7）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `dispatch/goal.ts:32` | 派发失败告警卡投递失败 → P3 | 是 | 否 | 视调用方 | 无 |
| `dispatch/perform.ts:110` | 分支名拒派告警卡投递失败 → P3 | 是 | 否 | 视调用方 | 无 |
| `dispatch/perform.ts:168` | 分支占用拒派告警卡投递失败 → P3 | 是 | 否 | 视调用方 | 无 |
| `dispatch/perform.ts:201` | 合并预检未完成 → P3 后**继续派发**（预检是建议式，非门禁） | 是 | 否 | 是 | 无 |
| `dispatch/perform.ts:235` | 工位激活写失败 → 回滚 worktree + `restoreIdle` + 结构化失败 | 是 | 是（显式回滚） | 是 | 无 |
| `dispatch/rollback.ts:39` | 状态行回滚失败 → 写 `dispatch_rollback_failed` + 返回 false | 是 | 是（显式） | 是 | `dispatch_rollback_failed` |
| `dispatch/rollback.ts:51` | 上面那条事件自己也写失败 → **丢弃**（核心事实仍由返回值表达） | 部分 | 否 | 是 | 否（写入失败） |

### 3.3 `agents/`（11）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `capture.ts:27` | 队列任务失败 → `recordingError` 暂存，并入最终结果 | 是 | 否 | 是 | 无 |
| `capture.ts:42` | 流某行非 JSON → 跳过（torn line 正常） | 否 | 否 | 否 | 无 |
| `runner.ts:84` | 熔断拒派的裁决卡投递失败 → P3，仍返回拒绝 | 是 | 否 | 视调用方 | 无 |
| `runner.ts:143` | agent 输出日志 append 失败 → **完全静默** | **否** | 否 | 是 | 无 |
| `runner.ts:173` | `capture.finish()` 失败 → 并入 `session.error` + `status: failed` | 是 | 是（显式） | 是 | `agent_finished` |
| `runner.ts:201` | 崩溃熔断卡投递失败 → P3 | 是 | 否 | 视调用方 | 无 |
| `runner.ts:223` | 批处理收尾失败 → P3（`.finally` 释放租约仍然执行） | 是 | 否 | 是 | 无 |
| `session.ts:53` | 读 latest session 失败 → null（**「还没开始」与「损坏」同形**） | 否 | 否 | 是 | 无 |
| `view.ts:26` | 一行不可解析 → 原样截断展示（面向人） | 部分 | 否 | n/a | 无 |
| `view.ts:51` | 同上（内层） | 部分 | 否 | n/a | 无 |
| `view.ts:56` | 日志尚未落盘 → `lastLines` 保持空（注释即身份） | 部分 | 否 | 是 | 无 |

### 3.4 `supervisor/`（8）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `argv.ts:54` | `stat` 失败 → false（P8：不可判定≠存在） | 是 | 否 | 是 | 无 |
| `liveness.ts:122` | `terminate()` 失败 → **丢弃**，随后仍报 `judged_silent` | **否** | 否 | 是 | 无 |
| `registry.ts:26` | `kill(pid,0)` EPERM 视为存活（**正确**） | 是 | 否 | n/a | 无 |
| `registry.ts:48` | 组杀失败 → 退化为单进程杀（P8） | 是 | 否 | 是 | 无 |
| `registry.ts:51` | 单进程杀也失败 → 「already gone」静默 | 否（无信息量） | 否 | n/a | 无 |
| `registry.ts:65` | `readdir` 失败 → `return 0`，等于「没有孤儿」 | **否** | 否 | 是 | 无 |
| `registry.ts:83` | PID 记录不可解析 → 静默删除（原因不留痕） | **否** | 是（删除） | 是 | 无 |
| `registry.ts:114` | PID 注册失败 → P3，**点明**「孤儿回收将看不到它」 | 是 | 否 | 是 | 无 |

### 3.5 `blackboard/`（19）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `checkpoints.ts:38` | 只有 `file not found` 折成 null，其余重抛 | 是 | 否 | n/a | 无 |
| `event-cursor.ts:31` | 游标缺失/过期 → null，下次 append 重建 | 否 | 否 | 是 | 无 |
| `event-cursor.ts:94/97` | 校验读不到 → false（P8） | 是 | 否 | 是 | 无 |
| `event-cursor.ts:106` | 事件文件读不到 → 全零游标 | 否 | 否 | 是 | 无 |
| `event-cursor.ts:122` | 撕裂行占一个物理位置（注释即身份） | 部分 | 否 | n/a | 无 |
| `event-cursor.ts:152` | 最后一行 id 解析失败 → undefined | 是 | 否 | 是 | 无 |
| `events.ts:66` | 撕裂/垃圾行跳过，继续读 | 否 | 否 | 否 | 无 |
| `footprint.ts:70` | 捕获时文件不存在 → `version: null`（P2） | 否 | 否 | 是 | 无 |
| `footprint.ts:93` | 行区间越界 → null（显式「证明不了」） | 是 | 否 | 是 | 无 |
| `footprint.ts:114` | spool 清理失败 → 吞掉（**有判定注释**：无副作用） | 否 | 否 | 是 | 无 |
| `goals.ts:35` | 只有 not found → null，其余重抛 | 是 | 否 | n/a | 无 |
| `interfaces.ts:81` | 同上 | 是 | 否 | n/a | 无 |
| `metrics.ts:172` | 车道文件撕裂 → P3（点名后从面板省略） | 是 | 否 | 是 | 无 |
| `sessions.ts:58` | 足迹撕裂尾行 → 跳过 | 否 | 否 | 否 | 无 |
| `sessions.ts:144` | writer.yaml 读不出来 → **本轮修复**：点名后省略（原为静默） | 是 | 否 | 是 | 无 |
| `sessions.ts:266` | 归属判定缺 claim → P3（既有判定，附理由） | 是 | 否 | 是 | 无 |
| `state.ts:56` | 队列条目解析失败 → **静默从队列消失** | **否** | 否 | 是 | 无 |
| `state.ts:72` | 工位只有 not found → null，其余重抛 | 是 | 否 | n/a | 无 |

### 3.6 `fs/`（9）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `atomic.ts:17` | `safeReaddir`：ENOENT→`[]`，其余重抛 | 是 | 否 | n/a | 无 |
| `atomic.ts:36` | rename 退避重试（EBUSY/EPERM/EACCES/EUNKNOWN） | 是 | 否 | 是 | 无 |
| `atomic.ts:69` | 写失败 → 删临时文件后**重抛** | 是 | 否 | 是 | 无 |
| `atomic.ts:104` | `pathExists` → false（P8） | 是 | 否 | 是 | 无 |
| `lockfile.ts:15` | EPERM 视为存活（正确） | 是 | 否 | n/a | 无 |
| `lockfile.ts:26` | 锁路径 stat 失败 → false | 是 | 否 | 是 | 无 |
| `lockfile.ts:54` | `wx` 失败 → 区分 EEXIST/EPERM 竞争与真权限错 | 是 | 否 | 是 | 无 |
| `lockfile.ts:121` | 半写锁 → 宽限后回收 | 是 | 是（显式） | 是 | 无 |
| `lockfile.ts:146` | 释放竞争 → 视为争用，交调用方重试 | 是 | 否 | 是 | 无 |

### 3.7 `runtime/`（9）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `checkpoint-effects.ts:80` | 应用失败 → `lifecycle: failed` + 移到 failed 区 + 事件 | 是 | 是（显式） | 是 | `checkpoint_apply_failed` |
| `delivery.ts:203` | 投递通道抛错 → `outcome=false`，通知**保持 pending** | 是 | 是（显式） | 是 | 无 |
| `premise-diff.ts:56` | 传统/规范 spool 缺失 → 正常降级路径 | 否 | 否 | 是 | 无 |
| `premise-diff.ts:89` | `git diff --no-index` 退出码 1 就是「有差异」（P8） | 是 | 否 | n/a | 无 |
| `premise-predicate.ts:37/38` | 读不到 → **不可证明**，不是「没变」 | 是 | 否 | 是 | 无 |
| `read-set-diff.ts:89` | 目录性不可证明 → 留在 `unsupported`，不缩小分母 | 是 | 否 | 是 | 无 |
| `rollback.ts:95` | 被删文件无内容可哈希（porcelain 的 D） | 部分 | 否 | n/a | 无 |
| `rollback.ts:163` | 同上（回退前重算） | 部分 | 否 | n/a | 无 |
| `rollback.ts:79`※ | **`git status` 失败未检查 `ok`** → 快照记成「无改动」 | **否** | **是（伪造干净）** | 是 | 无 |

※ `runtime/rollback.ts:79` 是 `git()` 调用点，不是 catch 站点；列在这里因为它是同一审计维度下最重的一条（§5 OPEN-1）。

### 3.8 `chat/`（39）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `claude-ack.ts:14` | notice ack 记账失败 → P3（provider 已接受回合） | 是 | 否 | 是 | 无 |
| `claude-mcp.ts:55` | `statSync` 失败 → 「不在磁盘上」（P8） | 是 | 否 | 是 | 无 |
| `claude-router.ts:26` | 流某行非 JSON → 跳过 | 否 | 否 | 否 | 无 |
| `claude-router.ts:91` | fork 足迹镜像失败 → P3 | 是 | 否 | 是 | 无 |
| `claude-router.ts:102` | 继承观测失败 → P3 | 是 | 否 | 是 | 无 |
| `claude-session.ts:145/151` | 已关的 stdin / 幂等 kill | 否（无信息量） | 否 | n/a | 无 |
| `claude-session.ts:201` | 退出清理失败 → P3 | 是 | 否 | 是 | 无 |
| `claude-session.ts:238` | `agent_liveness` 事件投递失败 → **静默丢弃** | **否** | 否 | 是 | 否（写入失败） |
| `claude-session.ts:257` | 已关的 stdin | 否（无信息量） | 否 | n/a | 无 |
| `claude-turn.ts:73` | stdin 不可写 → **命名**为 pipe-break + emit error | 是 | 是（显式） | 是 | 无 |
| `codex-app-server/session.ts:87` | 子进程已走 → `onStderr` 点名（注释说明为何不抛） | 是 | 否 | 是 | 无 |
| `codex-app-server/session.ts:149` | 某行非 JSON → 跳过 | 否 | 否 | 否 | 无 |
| `codex-app-server/session.ts:235` | `turn/start` 失败 → emit error + `settleTurn()` | 是 | 是（显式） | 是 | 无 |
| `codex-app-server/session.ts:245` | 关闭时 kill 幂等失败 | 否（无信息量） | 否 | n/a | 无 |
| `codex-session.ts:112/116/141` | 幂等关停（stdin / kill / shutdown） | 否（无信息量） | 否 | n/a | 无 |
| `codex-session.ts:139` | 握手失败 → 停 watcher + 清理 + **重抛** | 是 | 是（显式） | 是 | 无 |
| `codex-session.ts:168` | 退出清理失败 → P3 | 是 | 否 | 是 | 无 |
| `codex-session.ts:193` | `get()` 失败 → null（与「线程不存在」同形） | 否 | 否 | 是 | 无 |
| `codex-session.ts:198` | 复位 idle 失败 → P3（点明「会一直停在 running」） | 是 | 否 | 是 | 无 |
| `codex-turn.ts:63` | 回合失败 → emit error | 是 | 是（显式） | 是 | 无 |
| `http-endpoint.ts:10` | URL 非法 → 抛带引导语的错 | 是 | 否 | n/a | 无 |
| `http-run.ts:73` | SSE 数据损坏 → `streamMalformed` + 一条 error，且不外泄 | 是 | 是（显式） | 是 | 无 |
| `http-run.ts:190/197` | 观测/通知确认是附加的，注释说明不得翻转成功回合 | 部分 | 否 | 是 | 无 |
| `http-stream.ts:33` | 单帧非 JSON → 跳过 | 否 | 否 | 否 | 无 |
| `http-stream.ts:60` | shadow 变体整体失败 → `""`（**additive**：失败的备选＝没有备选） | 否 | 否 | 是 | 无 |
| `notice-queue.ts:163` | 旧行非结构化 → 保留为纯文本投递（迁移不丢） | 是 | 否 | 是 | 无 |
| `notice-queue.ts:178` | 只有 ENOENT → `[]`，其余重抛 | 是 | 否 | n/a | 无 |
| `thread-repository.ts:64` | 只有 ENOENT → 空列表，其余 → `BlackboardDataError` | 是 | 否 | n/a | 无 |
| `thread-repository.ts:78` | 单个对话读不出 → **点名 + 进 `unreadable`** | 是 | 否 | 是 | 无 |
| `thread-repository.ts:166` | 队列接力棒吞掉（真实错误由返回的 `next` 交给调用方） | 是 | 否 | 是 | 无 |
| `thread-run.ts:109` | 前提通知 ack 失败 → P3 + 返回 false（下一轮重投） | 是 | 是（显式） | 是 | 无 |
| `thread-run.ts:144` | spawn/收尾失败 → emit error + 复位 idle | 是 | 是（显式） | 是 | 无 |
| `thread-run.ts:148` | 复位前 `get` 失败 → null（P2） | 否 | 否 | 是 | 无 |
| `thread-run.ts:151` | 复位落盘失败 → P3（点明「永远停在 running」） | 是 | 否 | 是 | 无 |
| `thread-run.ts:186` | HTTP 车道回合失败 → emit error（finally 仍收尾） | 是 | 是（显式） | 是 | 无 |

### 3.9 `ui/`（20）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `assets.ts:52` | 非 `ERR_MODULE_NOT_FOUND` 即 P3；缺占位 manifest 是有意的静默 | 是 | 否 | 是 | 无 |
| `assets.ts:110` | 嵌入资源目标消失 → miss（不再流空的 200） | 是 | 否 | 是 | 无 |
| `assets.ts:122` | 磁盘资源消失 → miss → 上层 503 + header | 是 | 否 | 是 | 无 |
| `chat-routes.ts:35` | `decodeURIComponent` 非法 → 400 | 是 | 否 | 是 | 无 |
| `chat-routes.ts:66` | fork 塌缩成 `{}` → **由必填校验兜住** → 400 | 是 | 否 | 是 | 无 |
| `chat-routes.ts:82` | adopt 失败 → 400（带回原因） | 是 | 否 | 是 | 无 |
| `chat-routes.ts:94` | revert 失败 → 400 | 是 | 否 | 是 | 无 |
| `chat-routes.ts:162`※ | resume-action 塌缩成 `{}` → **由必填校验兜住** → 400 | 是 | 否 | 是 | 无 |
| `chat-routes.ts:237` | 流已关后仍要 emit → 丢弃 | 部分 | 否 | n/a | 无 |
| `chat-routes.ts:248` | `controller.close()` 已被对端关 | 否（无信息量） | 否 | n/a | 无 |
| `chat-routes.ts:257` | `chat.run` 失败 → emit error + close | 是 | 显式 | 是 | 无 |
| `evidence-route.ts:17` | ENOENT → 404，其余**重抛** | 是 | 否 | n/a | 无 |
| `json-body.ts:30` | 非 JSON / 非对象 → **400，且不写任何事件** | 是 | 否 | 是（客户端重发） | 无 |
| `reconcile-loop.ts:51` | `reconcilePremises` 失败 → 计数 + 点名 | 是 | 是（显式） | 是 | 无 |
| `reconcile-loop.ts:67` | config 读失败 → 计数 + 明示用默认预算继续 | 是 | 是（显式） | 是 | `config_load_failed` |
| `reconcile-loop.ts:86` | 上面那条事件写失败 → P3（绝不让 tick reject） | 是 | 否 | 是 | 否（写入失败） |
| `reconcile-loop.ts:105` | drain 失败 → 计数 + 点名 | 是 | 是（显式） | 是 | 无 |
| `state.ts:47` | `settle` → `{ok:false,error}` 类型化失败 | 是 | 是（显式） | 是 | 无 |
| `tribunal-routes.ts:46` | 裁决项标识非法 → 400 | 是 | 否 | 是 | 无 |
| `workspace-routes.ts:94` | feedback 走 schema → 400 且不写事件 | 是 | 否 | 是 | 无 |

※ `chat-routes.ts:66/162` 仍是 `.catch(() => ({}))` 塌缩写法，但两条都有必填字段校验，
畸形 body 与 `{}` 同路 → 400，**不会执行默认动作**，因此不是缺陷；它是同一模式的残留，
下一轮若统一到 `jsonObjectBody` 会更可读。

### 3.10 其余模块（13）

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 |
| --- | --- | --- | --- | --- | --- |
| `commands/checkpoint.ts:44` | 工作区不可读 → 无恢复点 checkpoint + 警告 | 是 | 是（显式） | 是 | 无 |
| `commands/premises.ts:82` | 无黑板 → 无意见即返回（hook 默认开启，不能每仓报错） | 是 | 否 | n/a | 无 |
| `commands/premises.ts:106` | 不是 hook payload → 「没什么可判」 | 是 | 否 | n/a | 无 |
| `commands/sessions.ts:149` | 无黑板 → 返回（git hook 路径） | 是 | 否 | n/a | 无 |
| `commands/ui.ts:25` | 打开浏览器失败 → 尽力而为，URL 照打 | 否 | 否 | n/a | 无 |
| `commands/ui.ts:49` | `EADDRINUSE` → 友好错误；其余重抛 | 是 | 否 | n/a | 无 |
| `doctor/checks/adoption.ts:21` | threads/ 读不了 → **error 级 issue**，不当作「没有对话」 | 是 | 是（显式） | 是 | 无 |
| `mcp/server.ts:90` | RPC 内部错 → JSON-RPC 错误响应 | 是 | 否 | 是 | 无 |
| `mcp/server.ts:112` | 请求非 JSON → Parse error 响应并继续 | 是 | 否 | 是 | 无 |
| `tribunal/queue-store.ts:47` | 条目撕裂 → `{name, item:null}` 记入 unreadable | 是 | 否 | 是 | 无 |
| `watcher/index.ts:156` | 周期失败 → `onError` 回调 | 是 | 否 | 是 | 无 |
| `yamlio.ts:18/27` | 读/YAML 失败 → `BlackboardDataError`（带路径） | 是 | 否 | n/a | 无 |
| `index.ts:7` | CLI 顶层 → `emitError` + 退出码 | 是 | 是（显式） | n/a | 无 |
| `test/fixtures.ts:32` | 夹具删除退避重试（仅测试） | 部分 | 否 | 是 | 无 |

---

## 4. 本轮修掉的 4 条（先红后绿）

RED = 把源文件还原成 HEAD（缺陷所在处）后实跑；GREEN = 修复后实跑。命令与读数见 §7。

### FIX-1（F-04 同款，`ui/chat-routes.ts` restore）
`restoreObservationSchema` 的字段**全部可选**（`restore-timing.ts:6-10`），所以
`request.json().catch(() => ({}))` 的 `{}` 能通过校验，随后 `recordRestored` 追加一条
**什么都没观测到的 `thread.restored` 审计事实**并返回 200。
- RED：`Expected: 400, Received: 200`
- GREEN：畸形 body → 400，且事件数不变；合法观测仍落库

### FIX-2（TF-0261 验收第 2 条，`ui/chat-routes.ts` resume-note PATCH）
body 是未校验的 `as` 断言，直接交给 `setResumeNote`；后者执行
`meta.resumeNote.beats = patch.beats` 后 `saveMeta`。于是 `{"beats":"evil"}` 成为**持久化事实**，
恢复卡还会去渲染它。
- RED：畸形 body → 200（并写入 meta）
- GREEN：新增 `resumeNotePatchSchema`（`chat/thread-resume.ts`）；畸形/错类型 → 400，
  **meta 一个字节不变**（测试直接读盘断言，不用第二实例的缓存）；合法 patch 仍生效

### FIX-3（F-04 同款，`ui/tribunal-routes.ts` shelve）
`.catch(() => ({}))` 让「畸形 body」与 UI 真正发的 `{}`（默认推迟）不可区分 —— 截断的请求
**把裁决项推迟了**并答 200。
- RED：畸形 body → 200（`tribunal_shelved` 落账）
- GREEN：畸形 → 400，项仍 pending、事件 0 条；UI 的 `{}` 仍 200

### FIX-4（静默降级，`blackboard/sessions.ts` list）
`readYamlFile(...).catch(() => null)` 让一个读不出来的写者从名册里**无声消失**——写集重叠判定
随之少一个来源，而界面上看不出区别。同文件的 `recentGeneratedPaths`（`:255`）早在
2026-09-13 就按「归属错误必须可见」改成了点名，`list()` 漏了。
- RED：畸形 `writer.yaml` → 名册少一个写者，stderr 为空
- GREEN：名册**照旧省略**（降级可以），但 stderr 点出该写者名（静默不行）

**共用件**：`ui/json-body.ts` —— 把 TF-0256 的 `jsonObjectBody` 从 `chat-routes.ts` 提出来，
让 chat 与 tribunal 两条路由共用同一份严格解析，避免第三份实现再次漂移。

---

## 5. 已定性、未修的 8 条（下一条接力）

按后果排序。**都已在 §3 表内**，这里只给结论与建议修法。

| # | 位置 | 问题 | 为什么没修 |
| --- | --- | --- | --- |
| OPEN-1 | `runtime/rollback.ts:79` | `git status --porcelain` 的 `ok` **没检查**（紧邻的 `rev-parse HEAD` 检查了）。命令失败时 stdout 为空 → 快照记成 `paths: []`，即「工作区干净」——回退点看着存在却什么都恢复不了 | 修它需要真跑 git 才能验证；本机沙箱拒绝 spawn `git`，无法先红后绿。**宁可留缺口也不交付未验证的修复** |
| OPEN-2 | `supervisor/registry.ts:65` | registry 目录读不了 → `return 0`，等价于「没有孤儿要收」；重启后的收养清理静默失效 | 同上（要真进程才能验证收益） |
| OPEN-3 | `supervisor/registry.ts:83` | PID 记录不可解析 → 静默删除，连「删了一条读不懂的记录」都不留痕 | 低危；与 OPEN-2 同轮处理更省事 |
| OPEN-4 | `supervisor/liveness.ts:122` | `terminate()` 失败被丢弃，随后仍报 `judged_silent`——「杀失败」被记成「已按判定终止」 | 需要真子进程验证 |
| OPEN-5 | `agents/runner.ts:143` | agent 输出日志 append 失败**完全静默** → transcript 会静默缺行，而 transcript 正是这条车道的交付物 | 需要真子进程；见 §6 为何不盲改 |
| OPEN-6 | `blackboard/state.ts:56` | 队列条目解析失败 → 静默从队列消失（损坏冒充「没有这条」） | 行为改动影响调度语义，应单独一条节点配测试 |
| OPEN-7 | `git/worktree.ts:144` | 唯一不检查 `git()` 返回值的生产调用点（`worktree prune` 结果被丢弃） | 低危（清理动作），与 OPEN-1 同轮 |
| OPEN-8 | `chat/claude-session.ts:238` | `agent_liveness` 事件投递失败静默丢弃；而 liveness 判定本身是有用户的（stalled/unresponsive 会走 UI），事件是唯一持久记录 | 无测试钩子，需先加可注入的 append seam |

**共同判据**：这 8 条全都是「失败不改变状态，但**失败本身也不可见**」。它们不会立刻损坏数据，
但会让「看起来正常」与「真的正常」再次合流——正是 TF-0252/0253 要防的那件事。

---

## 6. 刻意没做什么、为什么

| 没做 | 为什么 |
| --- | --- |
| **不盲修 OPEN-1…OPEN-8** | 它们的验证都要求真实子进程 / 真实 git；本机沙箱明确拒绝（`uv_spawn EPERM`）。改完 `typecheck` 绿不代表行为对——TX-0256 那一轮已经用「只做了一半、还破坏编译的中间态」演示过这个代价 |
| **不改 `chat-routes.ts:66/162` 的塌缩写法** | 它们有必填校验兜底，不是缺陷。统一到 `jsonObjectBody` 是清理，不是修复；混进本轮会让 diff 说不清「哪些是行为变化」 |
| **不把审计表做成 lint 规则** | 四列结论是**判断**，不是模式匹配；机器能找站点，判「这样降级允不允许」得读上下文。先把清单建起来，再讨论哪几条能机械化 |
| **不动 `apps/workbench-ui`** | 前端失败面由浏览器 E2E 承担，本机起不了 Chromium（§7）；在不能验证的地方改前端是制造假绿 |
| **不 apply 森林提案以外的东西** | 提案只改 TF-0261/TF-0259 状态、追加 evidence、新增 1 条 follow_up 节点；不碰验收门槛与依赖方向 |
| **不 push / 不打 tag / 不发布** | 与本轮其余交接一致：成果只落在本地分支，风险留给维护者拍板 |

## 7. 门禁读数（本机沙箱，逐条标注有效性）

| 门禁 | 读数 | 有效 |
| --- | --- | --- |
| `bun run typecheck` | **exit 0** | ✅ |
| `bun run lint` | **exit 0**，620 文件，无修复项 | ✅ |
| 本轮 4 条新测试 | **RED 4 fail（缺陷特征逐条命中）→ GREEN 15 pass / 0 fail**（3 文件） | ✅ |
| 相关 7 文件成组 | **38 pass / 4 fail**，4 个失败全是 `uv_spawn 'cmd.exe' EPERM` | ✅（失败=环境） |
| `src/ui` + `src/blackboard` 等 26 文件一次跑 | 137 pass / **34 fail**，失败集中在 HTTP suite（401 断言收到 200、响应串台） | ❌ **harness 串台**：同样文件 3–7 个一组时全绿；本机 Bun fetch 连接池跨端口复用导致 |
| `node scripts/upload-surface/classify.test.mjs` | 12 pass / 0 fail | ✅ |
| `node scripts/check-upload-surface.mjs --lists …` | exit 0，上传面 764 文件 / 违规 0 / 待裁决 6 | ✅（用三份 git 清单喂入） |
| Playwright / 三套件全量 | 未跑（Chromium `EPERM`） | ❌ |

**新增本机 caveat（建议补进 AGENTS.md）**：把整个 `src/ui` 和 `src/blackboard` 塞进同一次
`bun test` 时，HTTP suite 会因为 fetch 连接池跨端口复用而互相串台（402 → 收到别的测试的
SSE 响应）。分成 ≤7 个文件的小组跑就干净。这与「注入代理破坏 loopback」**成因不同**：
去掉 `HTTP_PROXY` 之后照样发生。

---

## 8. 森林收口

提案 `TFP-2026-09-25-tf0261-sweep`（**已 apply**，`validate` exit 0）：

- **TF-0261 → done**：验收第 1 条（每条路径四列结论）由 §3 的 140 行覆盖；第 2 条（反馈/恢复类 API 用 schema）
  由 FIX-2/FIX-3 补完。追加 6 条 evidence（清点读数、修复清单、RED/GREEN 读数、门禁读数、新 caveat）。
- **TF-0259 → in_progress**：子节点 TF-0260 done、TF-0261 done，但阶段 B 的验收
  （「每条异常路径都有状态不变量和持久化证据」）因 §5 的 8 条未修而未达成。
- **新增 TF-0269**（`follow_up`，child_of TF-0259）：承载 §5 的 8 条未修项，
  避免它们随「TF-0261 done」一起消失。森林现 269 节点。
- **landing 事实不变**：本轮的 3 个 commit 仍只落在本地未合并分支，`check-landing` 在本机不可测量
  （`TFD-460861548d` / `TFD-0dab4149f2`）。
- 本轮 commit：`1424f03`（路由收口）/ `98f6781`（sessions 可见性）/ `f5d8661`（本报告）。

## 9. 复核命令

```bash
# 1) 缺陷本身：先看 HEAD 上的行为，再看修复后的行为
cd packages/workbench
bun test src/ui/chat-routes.test.ts src/ui/tribunal-routes.test.ts src/blackboard/sessions.test.ts
# 期望 15 pass / 0 fail；把 4 个源文件还原成 HEAD 后应看到 4 fail，且失败信息分别是
#   restore 200 / resume-note 200 / shelve 200 / stderr 里没有写者名

# 2) 成组跑（不要一次塞 26 个文件，会串台）
bun test src/ui/server.test.ts src/ui/chat-routes.test.ts src/ui/tribunal-routes.test.ts \
         src/ui/feedback-route.test.ts src/ui/assets.test.ts src/ui/reconcile-loop.test.ts \
         src/blackboard/sessions.test.ts
# 期望 38 pass / 4 fail（4 个都是 uv_spawn 'cmd.exe' EPERM）

# 3) 门禁
bun run typecheck && bun run lint

# 4) 上传面（本机 node 禁止 spawn，用三份 git 清单喂入）
git ls-files > /tmp/us/tracked.txt
git ls-files --others --exclude-standard > /tmp/us/untracked.txt
git ls-files --others --ignored --exclude-standard > /tmp/us/ignored.txt
node scripts/check-upload-surface.mjs --lists /tmp/us     # 期望 exit 0

# 5) 森林
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py validate --workspace D:/helmor-main
```

**合并本分支前请把本轮读作「工程门通过（本地可执行范围）」，而不是「产品已验收」。**

---

## 10. 2026-09-26 复核：issue #40 与四模块覆盖

本节是**追加复核**，不改动 §0–§9 的任何字句（本仓的记录是 append-only）。目的是回答 issue #40：
`git/`、`scheduler/`、`agents/`、`supervisor/` 这四类路径「未逐条审计」这句话，在 2026-09-26 的树上
是否还成立。

### 10.1 复核命令

```bash
# 1) 当前树的机械清点（先写文件再读，避免 PowerShell 重定向原生命令时的编码错误）
cmd /c "node scripts\audit\catch-sites.mjs --json > .agent-contexts\catch-sites.json"
node scripts/audit/catch-sites.mjs

# 2) 把 §3 落地那个 commit 的源码树取出，用同一份脚本重扫一遍（复核「140」是不是可复现的读数）
git archive --format=tar -o .agent-contexts/doc-tree.tar 843793d packages/workbench/src
tar -xf .agent-contexts/doc-tree.tar -C .agent-contexts/doc-tree
cp scripts/audit/catch-sites.mjs .agent-contexts/doc-tree/scripts/audit/
node .agent-contexts/doc-tree/scripts/audit/catch-sites.mjs --json > .agent-contexts/catch-sites-843793d.json

# 3) 站点→行 映射、漂移、以及「147 那个旧读数是什么规则」
node .agent-contexts/mapping.mjs        # 四模块站点 vs §3.1–§3.4 行
node .agent-contexts/reconcile.mjs      # 140 → 143 的逐文件对账
node .agent-contexts/rule-147.mjs       # 147 = 同一正则「不过滤注释行」时的读数
node .agent-contexts/file-drift.mjs     # 生产 .ts 文件集合的漂移
node .agent-contexts/qa-rows.mjs        # §5 那 12 行里属于四模块的有几行（0）
```

### 10.2 清点读数（实跑）

| 树 | 站点 | 文件 | 仅注释提到 | 命令 |
| --- | --- | --- | --- | --- |
| HEAD（`d0706b3`，分支 `qa-stage-ab-remediation`） | **143** | 61 | **7** | `node scripts/audit/catch-sites.mjs` |
| `843793d`（本表 §3 落地的那次 commit） | **140** | 61 | 5 | 同一脚本，跑在 `git archive 843793d` 取出的树上 |

**§3 的「140」是逐文件可复现的，不是另一套规则。** 把 `.agent-contexts/forest-status/site-counts.txt`
（§3 当时那份 machine-state dump，本机残留）与 `843793d` 的机械扫描逐文件比对：
**61/61 个文件的 file→lines 完全一致，0 处不符**。所以 140 vs 143 这 3 个站点的差额，
**不是清点规则差异，而是 §3 落笔之后代码又长了 3 个站点**（见下表）——这一点与 issue #40 所依据的
「规则不同」印象相反，写在这里以免下一轮再被同一个数字绊住。

| 差额来源 | `843793d` | HEAD | 变化 |
| --- | --- | --- | --- |
| `chat/codex-app-server/session.ts` | 4（87,149,235,245） | 6（97,159,184,243,298,308） | **+2** |
| `supervisor/liveness.ts` | 1（122） | 2（130,136） | **+1** |
| 合计 | 140 | 143 | **+3** |

文件数仍是 61（没有文件从「0 站点」变成「有站点」）；仅 2 个文件站数增加，另有 **6 个文件站数不变、
行号整体位移**（`agents/runner.ts`、`blackboard/state.ts`、`chat/claude-session.ts`、`chat/codex-session.ts`、
`runtime/rollback.ts`、`supervisor/registry.ts`）。生产 `.ts` 文件集合本身只多了 1 个
（`chat/codex-app-server/approval-targets.ts`，265 → 266）——四模块的文件集合完全没变。

**旧读数 147 的正确解释**（§3 之前的 `.agent-contexts/forest-status/catch-inventory.txt`）：
它是**同一个正则 `\bcatch\s*(\(|\{)/`、但把文档注释行也计为站点**时的读数，
且取自比 §3 早 3 个 commit 的树（`0bff98f`，即 deviation 建立时的树）。

| 树 | `catch (` 计注释行 | 同规则不计注释行 | `catch-inventory.txt` |
| --- | --- | --- | --- |
| `0bff98f`（deviation 建立时） | **147**（61/61 文件与 dump 一致） | 143 | 147 ✅ 精确吻合 |
| `1424f03^` / `843793d`（§3 落地时） | 145 | **140** | — |
| HEAD | 150 | **143** | — |

即：147 与 140 的差**不是「两种扫描规则」**，而是「同一规则下、是否把注释行算进去」× 「两棵不同的树」。
`scripts/audit/catch-sites.mjs` 的注释（第 10–13 行）已经采用了 §3 的口径（注释行单列）。

### 10.3 四模块 站点 → 行 映射（当前树）

§3.1–§3.4 共 **29 行**四列结论；当前树四模块共 **30 个站点**。

| 模块 | §3 行数 | HEAD 站点 | 精确命中 | 行号漂移（同一站点，行号变了） | **无对应行** |
| --- | --- | --- | --- | --- | --- |
| `git/` | 3 | 3 | **3**（probe.ts:79,104,121） | 0 | **0** |
| `scheduler/` | 7 | 7 | **7**（goal.ts:32；perform.ts:110,168,201,235；rollback.ts:39,51） | 0 | **0** |
| `agents/` | 11 | 11 | **6**（capture.ts:27,42；session.ts:53；view.ts:26,51,56） | **5**（runner.ts 全部 5 行） | **0**（5 行漂移全部有对应旧行） |
| `supervisor/` | 8 | 9 | **5**（argv.ts:54；registry.ts:26,48,51,65） | **3**（liveness.ts、registry.ts×2） | **1**（`liveness.ts:136`，新增站点） |
| 合计 | 29 | **30** | 21 | 8 | **1** |

逐站点明细（当前树 file:line → 覆盖状态）：

| 当前 file:line | 覆盖 |
| --- | --- |
| `git/host-filesystem/probe.ts:79` / `:104` / `:121` | §3.1 行 1/2/3，精确 |
| `scheduler/dispatch/goal.ts:32` | §3.2 行 1，精确 |
| `scheduler/dispatch/perform.ts:110` / `:168` / `:201` / `:235` | §3.2 行 2/3/4/5，精确 |
| `scheduler/dispatch/rollback.ts:39` / `:51` | §3.2 行 6/7，精确 |
| `agents/capture.ts:27` / `:42` | §3.3 行 1/2，精确 |
| `agents/session.ts:53` | §3.3 行 8，精确 |
| `agents/view.ts:26` / `:51` / `:56` | §3.3 行 9/10/11，精确 |
| `agents/runner.ts:112` | §3.3 行 3（旧 `:84`），**漂移** |
| `agents/runner.ts:49` | §3.3 行 4（旧 `:143`），**漂移 + 行为已变** |
| `agents/runner.ts:199` | §3.3 行 5（旧 `:173`），**漂移** |
| `agents/runner.ts:227` | §3.3 行 6（旧 `:201`），**漂移** |
| `agents/runner.ts:249` | §3.3 行 7（旧 `:223`），**漂移** |
| `supervisor/argv.ts:54` | §3.4 行 1，精确 |
| `supervisor/registry.ts:26` / `:48` / `:51` / `:65` | §3.4 行 3/4/5/6，精确 |
| `supervisor/liveness.ts:130` | §3.4 行 2（旧 `:122`），**漂移 + 行为已变** |
| `supervisor/registry.ts:94` | §3.4 行 7（旧 `:83`），**漂移 + 行为已变** |
| `supervisor/registry.ts:131` | §3.4 行 8（旧 `:114`），**漂移** |
| `supervisor/liveness.ts:136` | **无对应行（新增站点）** |

**结论**：§3 对四模块并非「没做」，而是**做全了、且做在正确的树上**；今天看到的差异是
**§3 落笔之后 `TF-0269` 对 §5 那 8 条未修项的修复**造成的行号位移与一处新分支，
不是覆盖缺失。8 处漂移中有 3 处（`agents/runner.ts:49`、`supervisor/liveness.ts:130`、
`supervisor/registry.ts:94`）不只是行号变了，**结论也从「静默」变成了「点名」**——
正是 §5 OPEN-4 / OPEN-5 / OPEN-2 / OPEN-3 被修掉的结果。

### 10.4 漂移清单

| 旧引用（§3 写的） | 现状 | 漂移类型 | 促成漂移的改动 |
| --- | --- | --- | --- |
| `agents/runner.ts:84` | 同站点在 `agents/runner.ts:112` | 行号位移（结论不变） | 新增 `appendAgentLogLine` 函数（+28 行） |
| `agents/runner.ts:143` | 同站点在 `agents/runner.ts:49`，且已抽出为函数 | **行号位移 + 结论改变**（P6「完全静默」→ P3） | OPEN-5 修复 |
| `agents/runner.ts:173` | 同站点在 `agents/runner.ts:199` | 行号位移（结论不变） | 同上 |
| `agents/runner.ts:201` | 同站点在 `agents/runner.ts:227` | 行号位移（结论不变） | 同上 |
| `agents/runner.ts:223` | 同站点在 `agents/runner.ts:249` | 行号位移（结论不变） | 同上 |
| `supervisor/liveness.ts:122` | 拆成两个站点：`:130`（异步 reject）与 `:136`（同步抛出） | **行号位移 + 结论改变**（P6 → P3）+ **多出一个站点** | OPEN-4 修复（新增 `try/catch`） |
| `supervisor/registry.ts:83` | 同站点在 `supervisor/registry.ts:94` | **行号位移 + 结论改变**（静默删除 → P3） | OPEN-3 修复 |
| `supervisor/registry.ts:114` | 同站点在 `supervisor/registry.ts:131` | 行号位移（结论不变） | OPEN-2 修复的注释块（+23 行） |

**注**：issue #40 的转述写「`supervisor/registry.ts` 现在 6 个站点而文档只列了 5 个」——
**这句话是错的**：§3.4 对 `registry.ts` 列了 **6 行**（`:26/:48/:51/:65/:83/:114`），
`registry.ts` 当前也是 **6 个站点**，站数没变，变的是其中 2 行的行号。
`supervisor/` 模块总数从 8 变 9，唯一的增量是 `liveness.ts:136`。

**`git()` 调用点维度**（§3.1 的第二半）需要一次精度更正。§3.1 写「11 个生产调用点逐条核过，
10 个检查 `ok`/`code`；唯一不检查的是 `git/worktree.ts:144`」。在 `843793d` 上按
「调用点后 12 行内是否出现 `.ok`/`.code`」机械判定，`git/index.ts` 之外的 11 个调用点里**有 2 个**
不检查：`git/merge-tree.ts:24` **和** `runtime/rollback.ts:79`。

- `runtime/rollback.ts:79`（`git status --porcelain`）并不是被 §3 漏掉的 —— 它已作为 §3.7 的
  ※ 行单独记录，并列为 §5 OPEN-1。所以 §3.1 的「唯一」与本表 §3.7 自相矛盾；**矛盾在 §3 内部，
  不在覆盖面上**，本节只记录、不改写 §3.1（append-only）。
- `git/merge-tree.ts:24`（能力探针）**不是缺陷**：它读的是 git 回显的 usage 文本
  （`stdout+stderr` 里有没有 `--write-tree`），退出码在那条路径上没有语义（同 §3.7 的 P8 判据）。
  它是 §3.1 唯一真正没提到的「不检查」点，而它不需要检查。

OPEN-7 已收口：`worktree.ts:149` 现在检查 `pruned.ok`，失败时 `console.error` 点名，
且只有在 `worktree remove` 本身成功时才报 `ok`。当前树 `git/index.ts` 之外的 11 个生产调用点是
`merge-tree.ts:24`、`worktree.ts:71/:144/:149`、`merge-guard/overlap.ts:10`、`merge-guard/preflight.ts:29`、
`rollback.ts:69/:80/:245`、`dispatch/branch.ts:21`、`scheduler/merge-guard.ts:83`，
其中**只有 `merge-tree.ts:24` 不读 `ok`/`code`**（且如上，那不是缺陷）——§3.1 那句话在今天的树上
反而比在 `843793d` 上更接近成立。

### 10.5 之前没有四列结论的站点：补全

口径、词汇与 §2 图例一致（P1–P10，不新增原型）。判定方式是**读当前代码**，不是照抄旧行的名字或注释。

| 位置 | 失败时做什么 | 可见 | 改状态 | 可重试 | 事件 | 原型 |
| --- | --- | --- | --- | --- | --- | --- |
| `agents/runner.ts:49` | `appendFile` 写 transcript 失败 → `console.error` 点明「该行不会出现在 transcript 里」，**不终止本轮**（子进程已在跑，为一次日志写失败杀掉它更糟） | 是 | 否 | 是（下一行再试，不latch） | 无 | **P3** |
| `agents/runner.ts:112` | 熔断拒派的裁决卡投递失败 → `console.error` 点名，仍返回 `{ok:false, reason}` | 是 | 否 | 视调用方（每次拒派重投一次） | 无 | **P3** |
| `agents/runner.ts:199` | `capture.finish()` 抛错 → 折进 `captureError`，并入 `session.error` 且 `status: failed` | 是 | 是（显式） | 是 | `agent_finished` | **P7** |
| `agents/runner.ts:227` | 崩溃熔断卡投递失败 → `console.error` 点名（熔断状态本身已由 `agent_crashloop` 事件落账） | 是 | 否 | 视调用方 | 无（卡投递失败） | **P3** |
| `agents/runner.ts:249` | 批处理收尾链失败 → `console.error`；`.finally` 释放租约仍然执行 | 是 | 否 | 是 | 无 | **P3** |
| `supervisor/liveness.ts:130` | `terminate()` 返回的 Promise reject → `console.error` 点明「子进程可能仍在运行」；判定**仍是** `judged_silent`（决定确实做了，子进程真退出时调用方的退出清理照跑） | 是 | 否 | n/a（硬阈值一次性） | 无 | **P3** |
| `supervisor/liveness.ts:136` | `terminate()` **同步抛出** → 同上点名，判定仍为 `judged_silent`。这是 OPEN-4 修复新增的第二个分支：只处理 rejected Promise 会漏掉同步抛出 | 是 | 否 | n/a | 无 | **P3** |
| `supervisor/registry.ts:94` | PID 记录不可解析 → `console.error` 点明该进程「不会再被收养回收」，随后删除该记录 | 是 | 是（显式删除该记录） | 是 | 无 | **P3** |
| `supervisor/registry.ts:131` | pid 注册失败 → `console.error`，并**点明**「孤儿回收将看不到它」 | 是 | 否 | 是 | 无 | **P3** |

**这 9 条里有 8 条是 §3 旧行的漂移对应物，只有 `supervisor/liveness.ts:136` 是真正新增的站点。**
即便如此，8 条中的 3 条（`agents/runner.ts:49`、`supervisor/liveness.ts:130`、
`supervisor/registry.ts:94`）**必须按新结论读**：§3 当时写的是「完全静默」「丢弃」「静默删除」，
现在三处都点名了。**没有任何一条仍是「损坏冒充健康」的形状** —— 四模块当前的降级都是
「点名后继续」或「显式失败状态」，即 §2 的 P3 / P7。

### 10.6 对 issue #40 的判定：**stale（对四模块而言已过时）**

issue #40 引用的原话与 deviation `TFD-c76055ffad` 的 `reason` 字段逐字一致：

> TF-0261 的验收第 1 条要求「每条 catch 后继续路径」都有四列结论……`git/` 的 never-throwing runner、
> `scheduler/`、`agents/`、`supervisor/` 没有逐条审计。

**判定证据（按时间线，全部可机械复核）**：

| 时刻 | 事实 | 复核方式 |
| --- | --- | --- |
| `2026-09-25T02:04:13.903660Z` | deviation `TFD-c76055ffad` 建立，`status: open`，`reason` 即上面那段话 | `.agent-workbench/task-forest/deviations/deviations.jsonl` |
| `2026-09-25T09:48:05+08:00`（`01:48:05Z`） | deviation 的 evidence commit `0bff98f` —— 当时唯一存在的表是 `docs/handoff/qa-stage-ab-remediation-2026-09-25.md` §5，共 **12 行**（与 deviation 的 `observed_action_or_result` 写的「四列审计表覆盖 12 条路径」一致），其中**属于这四模块的行数为 0**；§5 末尾自己写着「**未覆盖**：`git/` 的 never-throwing runner、`scheduler/`、`agents/`、`supervisor/`」 | `git log -1 0bff98f`；`node .agent-contexts/qa-rows.mjs`（实跑：12 行 / 四模块 0 行） |
| `2026-09-25T14:19:23Z`（`22:19:23+08:00`） | commit `843793d` 落地：§3.1 `git/`（3 行）、§3.2 `scheduler/`（7 行）、§3.3 `agents/`（11 行）、§3.4 `supervisor/`（8 行）——**正好是 deviation 点名的那四个模块** | `git log -1 843793d`；读 §3.1–§3.4 |
| 今天（HEAD `d0706b3`，`843793d` 是 HEAD 的祖先） | 上述 **29 行**在当前树上仍有 **21 行 file:line 精确命中**，另 8 行只是漂移；四模块仅 **1 个**站点没有对应行 | `node .agent-contexts/mapping.mjs` |

所以：

1. **该 claim 在写下的那一刻是真的**（deviation 有 §5 的「未覆盖」一句作证）；
2. **它在 `843793d`（2026-09-25T14:19:23Z，比 deviation 晚约 12 小时 15 分钟）之后就不再成立**；
   转述里「~20 小时」是把 UTC 时间戳 `02:04:13Z` 当成 +08:00 本地时间读的结果（按本地读是
   `2026-09-25T02:04+08:00` = `2026-09-24T18:04Z`，才会得到 ~20 h）。正确间隔是 **12 h 15 m**。
3. **残留缺口只有 `supervisor/liveness.ts:136` 一个站点**，本节 §10.5 已按同一口径补齐。
   因此 issue #40 若按「还有四个模块完全没审计」来读，是 **过时的**；若按「§3 的行号需要随代码刷新」
   来读，那是**真实但轻微**的（8 处行号漂移，本节 §10.4 给全）。

**对 deviation `TFD-c76055ffad` 的建议：标 `superseded`，superseding 记录是 commit `843793d`
（本表 §3.1–§3.4）与本节 §10。** 它的 `reason` 所描述的缺口已被那 29 行四列结论填上，
`recommendation`（「下一轮对 git/、scheduler/、agents/、supervisor/ 做同样的四列审计」）已经执行；
本节的增量只是把漂移刷新并补一个站点，不构成一条新的未完成项。
（备用判定：若森林按「验收条件是否达成」而非「是否被后一条记录取代」来读，`resolved` 也说得通——
两条路的**证据完全相同**，都是 `843793d` 的 29 行 + 本节 §10.5。本仓的 deviation 状态由 Lead 用
`python task_forest.py deviation-status` 落账，本节不代笔。）

### 10.7 本节读数：哪些是实跑，哪些只是读代码

| 结论 | 性质 |
| --- | --- |
| HEAD 清点 143 站点 / 61 文件 / 7 注释（`node scripts/audit/catch-sites.mjs`） | **实跑** |
| `843793d` 清点 140 / 61 / 5（`git archive` + 同一脚本） | **实跑** |
| §3 的 140 与 machine dump 逐文件一致（61/61，0 不符） | **实跑** |
| `147` = 同一正则计注释行、取 `0bff98f` 树（61/61 文件吻合） | **实跑** |
| 140→143 的三个站点差额、6 个文件的位移、生产文件集合 265→266 | **实跑** |
| 四模块 站点→行 映射、8 处漂移、1 个新站点 | **实跑**（脚本比对）+ **读代码**（判定漂移对应关系） |
| §10.5 的 9 条四列结论 | **只是读代码**：沙箱拒绝子进程（`uv_spawn EPERM`），这四条模块的失败路径都要真子进程/真 git 才能驱动，本轮**没有**实跑任何一条 |
| `843793d` 是 HEAD 祖先、各 commit 时间戳、§5 那 8 条 OPEN 在树上的现状 | **实跑**（`git merge-base --is-ancestor` / `git log`） |
| `bun run lint` | **实跑**（见 §10.8） |

### 10.8 本节门禁读数

| 门禁 | 读数 | 有效 |
| --- | --- | --- |
| `bun run lint`（repo root，Biome） | **exit 0** | ✅（Markdown 不在 Biome 范围内，此读数只证明本节未破坏 lint，不证明 Markdown 本身） |
| `bun run typecheck` / `bun test` | 未跑 | ❌（本节**没有**改任何源码或测试；跑了也不覆盖 Markdown） |

**本节只写了一个文件**：`docs/handoff/2026-09-25-catch-after-continue-audit.md`。
没有碰源码、测试、`scripts/`、`AGENTS.md`、ADR 或任务森林。

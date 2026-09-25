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

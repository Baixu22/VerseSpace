# 静默失败的收口：TF-0269 本轮修掉 6 条（2026-09-25）

> **双标签口径：工程门通过（仅限本地可执行范围）/ 产品证据不足。**
> 分支 `qa-stage-ab-remediation`，改动**仅本地 commit，未 push、未打 tag、未发布**。
> 本报告不含任何用工程测试冒充真实浏览器、真实 provider 或真人数据的结论。

---

## 0. 结论摘要

[上一轮的仓库级审计](2026-09-25-catch-after-continue-audit.md) 在 140 个 catch 站点里
定性出 8 条「失败不可见」路径，交给 **TF-0269**。本轮修掉其中 **6 条**，
另外 **2 条需要真子进程**，本机沙箱拒绝创建子进程，因此**不修**（理由见 §5）。

| 项 | 读数 |
| --- | --- |
| 修掉的路径 | **6**（OPEN-1 / 2 / 3 / 4 / 6 / 7） |
| 新增测试 | **9** 条，5 个文件 |
| 先红后绿 | RED **7 fail**（另 2 条是「不许过度修复」的守门用例，两侧都必须过）→ GREEN **9 pass / 0 fail** |
| 新增能力 | `GitRunner` 注入缝：让「git 失败」这一分支在**禁止子进程的宿主上也能被验证** |
| 未修 | **2**（OPEN-5 `agents/runner.ts`、OPEN-8 `chat/claude-session.ts`） |
| 门禁 | typecheck exit 0 · lint exit 0（620 文件）· 上一轮 6 文件组 28 pass / 0 fail（无回归） |

**这一轮最重的一条是 OPEN-1**：`captureCodeRollback` 检查了 `git rev-parse` 的返回值，
却**没检查 `git status`**。命令失败时 stdout 是空的，于是快照被记成 `paths: []`——
一个「看起来工作区是干净的」恢复点。RED 跑出来的正是这个形状：**promise 正常 resolve**
（而不是抛错），调用方拿到一份什么都不用恢复的「安全网」。

---

## 1. 起点

审计表的判定口径是「**降级可以，静默不行**」。这 6 条都属于同一个形状：
失败不改变状态，但失败本身也不可见——于是「看起来正常」与「真的正常」重新合流。
每一条的修法都只动**可见性**，不动降级语义。

## 2. 改了什么（逐条）

### OPEN-1 `runtime/rollback.ts:79` — 快照不再把「读不到」记成「干净」
```ts
const status = await runGit(["status", "--porcelain"], worktreePath);
if (!status.ok) {
  throw new Error(`无法读取工作区状态（${worktreePath}）：…`);
}
```
紧邻的 `rev-parse HEAD` 早就确立了「不可读就抛错，让调用方降级为无恢复点 checkpoint」的约定
（issue #1，2026-09-13）。这里原本不一致：一条抛、一条静默。**改成一致。**
没有快照就明确拒绝，不假装回退。

### OPEN-2 `supervisor/registry.ts:65` — 「没看成」不再等于「没有孤儿」
只有 `ENOENT`（注册表还不存在）才返回 0；其余失败（`ENOTDIR` / `EACCES` / `EBUSY`）
仍然返回 0（启动路径不该因为一次权限抖动而中止），但**点名**。
否则一个连看都没看成的 supervisor 会报告「没有孤儿」，把前任留下的 agent 继续留在机器上。

### OPEN-3 `supervisor/registry.ts:83` — 清理照旧，原因留痕
不可解析的 PID 记录仍然被删（它已经没用了），但「我们不知道这是谁」不再跟着记录一起消失：
一条读不懂的记录意味着一个再也收养不回来的进程。

### OPEN-4 `supervisor/liveness.ts:122` — `terminate` 失败不再被吞
`void Promise.resolve(options.terminate()).catch(() => {})` 换成带日志的 catch。
**并且**补上了同步抛出：`options.terminate()` 同步 throw 时，异常会直接逃出
`setInterval` 回调（RED 跑出了这个未被记录的第二个缺陷）。verdict 仍然是
`judged_silent`——**决定确实做了**，调用方的退出清理也照旧；只是失败被命名。

### OPEN-6 `blackboard/state.ts:56` — 队列条目不再无声少一项
读不出来的条目仍然被省略，但点名。两个后果都不该由「没看见」承担：
那个目标从此不会被派发，而 `enqueue` 的 `seq` 是拿这份列表的**长度**算的——顺序也跟着变。

### OPEN-7 `git/worktree.ts:144` — 全仓最后一处不检查 `git()` 返回值的调用点
`worktree remove` 成功后，`worktree prune` 的结果以前被整个丢弃。现在：移除成功仍然报 `ok`
（checkout 确实没了），但「git 的管理条目没清掉」说出来——留着陈旧 worktree 记录会让
后续 `worktree add` 在同一个路径上失败，而那时已经没人记得是这一步没做干净。

## 3. 注入缝：让「git 失败」在本机可验证

OPEN-1 与 OPEN-7 都只能靠**真 git 失败**才能触发，而本机沙箱拒绝 spawn `git`
（`uv_spawn EPERM`）。若照旧写测试，`git()` 对每个调用都返回 `ok:false`，
两条路径都走不到——测出来的只会是环境。

因此新增 `GitRunner`（`git/index.ts`）：`git()` 的**值形态**。只**解释** git 答案的调用方
把 runner 作为参数收下，默认仍是真 `git()`：

```ts
export async function captureCodeRollback(worktreePath: string, runGit: GitRunner = git)
export async function removeWorktree(projectRoot, worktreePath, options: { force?; runGit?: GitRunner })
```

这不是为测试而测试：ADR-0020 把 `classify.mjs` 做成纯函数，用的就是同一条理由——
**判定必须在禁止子进程的宿主上也能被验证**。`runtime/rollback.ts` 的模块头本来也写着
「由命令层实现，保持本模块可测」。

**注入缝只加在「解释答案」的调用方**，`git()` 本身与其余 9 个调用点不动。

## 4. 测试证据：先红后绿

RED = **只回退行为、保留注入缝**（这样失败原因才是缺陷本身，而不是「测试写不出来」）。

| 用例 | RED | GREEN |
| --- | --- | --- |
| `captureCodeRollback`：status 失败要抛错 | **promise resolve**（产出 `paths: []` 的假快照） | 抛 `无法读取工作区状态` |
| `captureCodeRollback`：状态可读时照常出快照 | pass（守门：不许过度修复） | pass |
| `removeWorktree`：prune 失败要点名 | stderr 为空 | 点名，且 `ok: true` |
| `reapOrphans`：注册表不存在 → 静默 0 | pass（守门：那真的是「没有孤儿」） | pass |
| `reapOrphans`：注册表读不成 → 点名 | stderr 为空 | 点名 |
| `reapOrphans`：坏记录清理留痕 | stderr 为空 | 点名 + 文件确实被清 |
| `watchLiveness`：terminate reject → 点名 | stderr 为空 | 点名，verdict 仍 `judged_silent` |
| `watchLiveness`：terminate 同步抛出 → 点名 | **异常逃出定时器回调**（未捕获） | 点名，不逃逸 |
| `state.queue`：坏条目省略但点名 | stderr 为空 | 点名 |

```
RED   9 tests / 7 fail / 2 pass
GREEN 9 tests / 0 fail / 0 skip   (21 expect)
```

两条 RED 也通过的用例是**故意**的：它们守的是「不要为了可见性而改变正常语义」——
没有注册表就是没有孤儿，状态可读就照常出快照。少了它们，「修好了」与「改坏了」看起来一样。

## 5. 剩下 2 条：不修，理由是本机拿不到有效读数

| # | 位置 | 问题 | 为什么本轮不修 |
| --- | --- | --- | --- |
| OPEN-5 | `agents/runner.ts:143` | agent 输出日志 `appendFile` 失败完全静默——而 transcript 正是这条车道的交付物 | 触发它需要**真跑一个 agent 进程**并把日志路径变成不可写。本机 `uv_spawn` 被拒，写了也验证不了 |
| OPEN-8 | `chat/claude-session.ts:238` | `agent_liveness` 事件投递失败静默丢弃——而该事件是 liveness 判定的唯一持久记录 | 需要**真实 claude 会话**；本机起不来 |

两条的修法都只是「把丢弃换成一个点名的 catch」，改动本身很小——**但「很小」不是「已验证」**。
上一轮接手的那个中间态（只做了一半、还破坏编译）就是这个代价的现场。
**宁可留缺口，也不交付未验证的修复。**

无沙箱环境下的复跑方式：修完后
`bun test src/agents src/chat`，并各补一条反例（不可写日志路径 / 注入的 append 失败）。

## 6. 刻意没做什么、为什么

| 没做 | 为什么 |
| --- | --- |
| **不修 OPEN-5 / OPEN-8** | 见 §5：验证要求真子进程，本机沙箱拒绝 |
| **不给 `git()` 之外的 9 个调用点加注入缝** | 它们已经在检查 `ok`；缝只加在需要验证「失败分支」的地方，不搞全面重构 |
| **不把 6 条修成「抛错」** | 除 OPEN-1 外，其余 5 条的正确行为就是**降级**（返回 0 / 省略条目 / 继续跑）。改语义会打断启动路径与调度，远超本节点的范围 |
| **不动 `console.error` 之外的可见性机制** | 仓库既有标准就是 stderr 点名（`metrics.ts` / `sessions.ts` / `doctor`），本轮沿用同一条口径；要升级成结构化 issue 是另一个决定 |
| **不 push / 不打 tag / 不发布** | 与本轮其余交接一致 |

## 7. 门禁读数

| 门禁 | 读数 | 有效 |
| --- | --- | --- |
| `bun run typecheck` | **exit 0** | ✅ |
| `bun run lint` | **exit 0**，620 文件，无修复项 | ✅ |
| 本轮 9 条新测试（`-t TF-0269`） | RED 7 fail → **GREEN 9 pass / 0 fail** | ✅ |
| `state` + `liveness` + `argv` 三文件全量 | **13 pass / 3 fail**，3 个失败全是 `uv_spawn bun.exe EPERM` | ✅（失败=环境） |
| 上一轮 6 文件组（回归检查） | **28 pass / 0 fail** | ✅ |
| `rollback` / `worktree` / `index.test` 全量 | 未取到有效读数：多数用例要真 git / 真子进程（`EPERM`） | ❌ |
| Playwright / 三套件全量 | 未跑（Chromium `EPERM`） | ❌ |

> 注意：`bun test` 一次塞 26 个文件会串台（上一轮记录的本机 caveat）。本轮的读数都来自
> ≤7 个文件的小组。

## 8. 森林

提案 `TFP-2026-09-25-tf0269-silent-failures`（**已 apply**，`validate` exit 0）：

- **TF-0269 → in_progress**：6/8 条已修并先红后绿；追加 6 条 evidence（逐条修法、
  注入缝的理由、RED/GREEN 读数、门禁读数）。
- **1 条 deviation**（`TFD-200e8fc589`，`acceptance_partially_met`）：
  OPEN-5 / OPEN-8 需要真子进程，本机不可验证，给出无沙箱复跑方式。
- 未改验收门槛、依赖方向与其它节点状态。森林现 269 节点。
- 本轮 commit：`67506c7`（6 条修复 + 注入缝），其后紧跟一条 docs commit（即本报告；
  报告里不写自己的 hash——写了就会随 amend 失效）。
- landing 事实不变：仍只落在本地未合并分支，`check-landing` 在本机不可测量
  （`TFD-460861548d` / `TFD-0dab4149f2`）。

## 9. 复核命令

```bash
cd packages/workbench

# 1) 本轮 9 条：先绿
bun test --timeout 60000 -t "TF-0269" src/runtime/rollback.test.ts src/git/worktree.test.ts \
    src/supervisor/index.test.ts src/supervisor/liveness.test.ts src/blackboard/state.test.ts
# 期望 9 pass / 0 fail / 41 filtered out

# 2) 再红：只回退行为、保留注入缝（把 6 处 if/console.error 换回原来的写法），
#    期望 7 fail，且失败信息分别是
#      rollback  → promise resolved（假快照）
#      worktree  → stderr 为空
#      registry  → stderr 为空 ×2
#      liveness  → stderr 为空 / 同步异常逃逸
#      state     → stderr 为空

# 3) 全量可跑的子集
bun test src/blackboard/state.test.ts src/supervisor/liveness.test.ts src/supervisor/argv.test.ts
# 期望 13 pass / 3 fail（全是 uv_spawn EPERM）

# 4) 回归
bun test src/ui/chat-routes.test.ts src/ui/tribunal-routes.test.ts src/blackboard/sessions.test.ts \
         src/ui/feedback-route.test.ts src/ui/assets.test.ts src/ui/reconcile-loop.test.ts
# 期望 28 pass / 0 fail

# 5) 门禁
cd ../.. && bun run typecheck && bun run lint
```

**合并本分支前请把本轮读作「工程门通过（本地可执行范围）」，而不是「产品已验收」。**

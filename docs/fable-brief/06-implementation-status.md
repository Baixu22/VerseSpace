# Fable 5.1 节点审计：实现状态与诚实边界

更新时间：2026-09-04  
基线：`3cd9f54c445687108494dcc5b3e8f2e3189c3327`  
范围：根据附件中的 Fable 5.1 节点审计，对能在当前 Workbench 代码和本地测试中落地的短板进行修复；不把设计意图、fake provider 或静态能力核对升级为产品验收。

## 结论先行

审计指出的主要问题并不是“少几个 UI”，而是事实边界不清：通知入队曾被当成 provider 已消费、事件没有稳定的跨进程因果位置、恢复读集没有明确的离开基线、线程生命周期事件可能被错误归因，以及锁文件的部分写入可能永久阻塞。上述可在本地闭环验证的部分已经修复。

仍不能诚实地说 Fable 5.1 的完整方案已经成立。真实 Claude 上下文继承、HTTP 工具足迹、14 天日用数据、变体选用/撤销、merge-back/adopt 和 Tauri/Electron 验收都没有当前证据；这些边界被保留为下一阶段工作，而不是用“全绿测试”代替。

## 已修复，并有本地生产路径测试证据

| 审计短板 | 当前修复 | 本地证据 |
| --- | --- | --- |
| 事件 `seq` 只在读取时生成，跨进程会漂移 | `events.jsonl` 写入稳定 `id` 与 `eventSeq`；追加在 PID 锁内分配，旧日志保留兼容视图；外部追加会触发 cursor 重建 | `blackboard/events.test.ts`：并发实例唯一 ID/共享时钟、旧日志和外部追加回归通过 |
| 线程生命周期事件可能把状态机结论混进来 | `thread.*` 事件统一经过 payload 校验；生命周期 source 与世界事实分开；目标参数中的 `threadId` 覆盖调用方 payload | `events.test.ts` 校验拒绝 verdict；`threads.test.ts` 增加目标 `threadId` 不可覆盖测试 |
| 世界上下文可能泄漏会话拓扑 | `contextgen` 生成和渲染前过滤世界事件；线程事件不会写入 agent context | `contextgen/render.test.ts` 泄漏回归通过 |
| fork 的 transcript、agent context、premise 被混写 | `ForkInheritance` 三类事实拆开；fork 时未观测 provider 事实为 `null`，首次真实 provider 轮次后再落观测 | `threads.test.ts` 覆盖尾部 fork 计划、观测落盘和源 transcript 不变 |
| Claude 尾部 fork 没有真实命令计划 | 对可用的尾部 fork 生成 `--resume <source> --fork-session` 计划，并在合成 agent 中检查 argv | fake provider 集成测试通过；只证明命令计划和本地镜像，不证明真实 Claude 运行结果 |
| restore 没有可核对的读集基线 | 离开事件记录 footprint/event 边界；restore-time diff 返回版本、尽力 diff、来源引用和推定写者；缺基线/无版本显式为 unknown/unsupported | `runtime/read-set-diff.test.ts` 4 个场景通过；UI GET 返回 `readSetDiff` |
| 通知 at-least-once 语义不清，queued 被当成 delivered | durable queue 使用稳定 notice ID；`queued` 只表示已写入队列；只有 provider 成功终止帧后的 delivered/ack 事件才清除 pending；同 ID 正文可升级 | `runtime/delivery.test.ts`、`threads.test.ts` 覆盖失败重试、稳定 ID、并发追加、预算截断和 provider ack |
| 通知可能无限膨胀 | notice 有可配置 token budget，先保留路径/版本事实，再截断 diff，并明确省略数 | delivery 回归测试验证预算和零预算行为 |
| Claude tool-use 后崩溃仍可能提前 ack | ack 收紧到 `result.subtype === "success"` 且 `is_error !== true` | threads 回归测试覆盖 tool-use 后崩溃不 ack |
| SSE 截断/错误被当成成功 | 识别完整帧、终止标记、malformed/error/incomplete；不完整流保留通知 | HTTP fake SSE 回归测试通过 |
| UI 切换/恢复统计没有因果埋点 | 增加 `thread.switch`、`thread.restored`、resume action/consumed 事件和 generation 防护；stats 从 `forkOf` 而非 reload 计数推导 | `chat/stats.test.ts` 与 threads/UI route 测试通过 |
| 运行完成状态先于审计事件可见 | agent runner 先持久化 `agent_finished`，再发布 `latest.json=done`，消除读者先看到 done 再读不到事件的竞态 | `agents/runner.test.ts` 通过；全量套件重复验证通过 |
| 损坏/空 PID lock 可能永不接管，或并发删除报错 | 新鲜的部分写入保留为 contention；超过 1 秒且内容/mtime 未变化的残留才可接管；Windows 暂态 `EFAULT`/共享冲突按 contention 重试 | `fs/lockfile.test.ts` 覆盖新鲜空/损坏文件阻塞、过期残留接管、并发互斥 |

## 只有 fake/synthetic 或静态能力证据

这些结果可以证明本地代码路径和数据形状，但不能替代真实 provider 或真实用户证据：

- Claude `--fork-session`：当前只有 fake CLI 的 argv 检查、footprint 镜像和本机 CLI `--help` 能力核对；没有真实 Claude 账户下的生产运行证据。
- 锚点 fork 的 agent transcript：UI 前缀可精确复制，但 Claude 的 fork-session 可能继承整个 provider 会话；“锚点前缀与 provider 上下文完全相同”尚未证明。
- HTTP provider：fake SSE 的成功、截断和错误分支已覆盖；当前实现没有真实工具执行/真实 footprint，因此不能声称 HTTP `footprint.inherited` 已成立。
- 通知投递：测试证明 durable queue、ack 和重试语义；没有真实长期运行 provider 在网络抖动、进程重启下的现场数据。
- restore 首动作：事件模型和统计函数已存在，但测试使用合成 lifecycle 事件；尚无真实用户返回后 scroll-up/git-log 的完整自动埋点样本。
- writer attribution：代码返回的是基于 footprint 的推定写者，不是经过操作系统、CI 或 git provenance 证明的作者。

## 仍被真实运行或 14 天数据阻塞

以下项目刻意没有标记为完成，也没有打开任何 default-on/产品锁：

1. **真实 Claude 继承与前缀裁决**：需要一次受控真实 provider 运行，记录实际 session/context 行为，再决定接受“上下文超集”还是改用重放。
2. **R2′ 的真实覆盖率**：grep/glob、`sed`/`head`/PowerShell `Get-Content` 等命令仍不是完整读集；当前是有限启发式，不能包装成静默安全保证。
3. **L3 fit 门**：仓库没有 `promotion_reverted` 选用/撤销闭环；变体面板仍是只读，不能用该指标判定 L3。
4. **14 天日用门**：当前 stats 会明确返回 `insufficientHistory`；没有有效的分叉频率、兄弟交替和恢复行为时间窗，不能给出 fit/继续结论。
5. **merge-back/adopt**：没有真正的 branch/worktree merge-back、内容合并或 adopt/revert 产品闭环；当前只提供恢复卡、账本差、写集/版本事实的可查询基础。
6. **HTTP 工具和继承读集**：尚无生产工具执行器与可核对 inherited read-set，因此 `footprint.inherited` 不能被扩展解释为 HTTP 已验证。
7. **Tauri/Electron/browser acceptance**：本轮只验证 Workbench package 和 UI bundle；没有桌面运行时验收。
8. **正式 acceptance / `liveReady` / `productApproved` / default-on**：均未宣称、未修改。

## 下一阶段开发边界

下一步应按证据顺序推进，而不是继续扩大树或 L3：

1. 在明确授权和可用凭据下，做一次最小真实 Claude fork probe；保存 argv、provider session id、首轮输出和 footprint 引用，失败也要留下结果。
2. 从该次 probe 起启动真实日用计时；stats 只读，不伪造起点。满 14 天后再评估分叉/恢复/兄弟交替是否值得继续。
3. 若真实使用证明恢复读集有用，再补命令覆盖和更强的 provenance；否则优先删除/休眠未消费的 DOI、树导航和 L3 计划。
4. merge-back 继续保持摘要/指针级、加法式、可撤销；在没有真实 branch/worktree 语义前，不实现内容级自动合并。
5. 任何真实 provider 结论都要与本地 fake 测试分栏记录；任何桌面验收都要单独跑并记录环境、exit code 和未执行前置条件。

## 最终验证记录

以下命令在本轮最后一次代码修改后执行；文档修改不改变这些结果：

| 命令 | 结果 |
| --- | --- |
| `cd packages/workbench; bun test --timeout 60000` | **exit 0**；385 pass，0 fail，58 files，1 snapshot，1345 expect，约 39.99 s |
| `cd packages/workbench; bun test src/agents/runner.test.ts --timeout 60000` | **exit 0**；5 pass，0 fail |
| `cd packages/workbench; bunx tsc --noEmit` | **exit 0** |
| `cd packages/workbench; bunx biome check src` | **exit 0**（无 warning） |
| `cd apps/workbench-ui; bunx tsc --noEmit` | **exit 0** |
| `cd apps/workbench-ui; bun run build` | **exit 0**；Vite 构建成功；仅有既有的 minified chunk >500 kB warning |
| `git diff --check` | **exit 0**；仅输出现有工作树的 CRLF/LF 转换提示 |

未执行：仓库根目录 legacy frontend、sidecar、context-rot、Rust 全套测试，以及 Tauri/Electron/browser E2E；它们不应被本表的 Workbench/UI 结果代替。

工作树仍包含用户已有的未提交修改和未跟踪文件；本轮没有执行 reset、checkout、stash、clean、删除 worktree 或 Task Forest 状态变更。

# README 调用链复核（2026-09-30）

本轮按维护者要求核对真实入口、调用方、持久化与对外表面后完善根 README。基线 HEAD 为 `68ebef5`，已有 README 修改、两张 README 插图和上一轮调查报告均予保留。只修改说明文档；没有修复下面发现的业务缺口、更新证据声明账本、改动任务森林或发布代码。

## 核对方式

先由 `buildProgram()` 的五组注册函数核对 CLI，再沿 runtime/dispatch/verifier、watcher/footprint/premises、chat/notice/provider、UI store/HTTP routes、MCP tools 读取实际调用者。类型、配置、测试名、注释与旧 ADR 不单独当作能力证明。抽查发现注释和行为不一致时，README 以当前行为为准。

验证使用三种方式：现有测试、隔离仓库中的真实 CLI/HTTP/MCP 调用、假 app-server 驱动的真实 Codex 协议与通知链路。第三种没有调用模型，不能称为真实 Codex CLI 或真实模型验收。原始输出、临时脚本与 fixture 按 ADR-0020 保留本机。

## README 补全与修正

| 主题 | 真实调用链 / 依据 | 文档结论 |
| --- | --- | --- |
| 编排与前提检测 | [runtime/index.ts](../../packages/workbench/src/runtime/index.ts)、[watcher/index.ts](../../packages/workbench/src/watcher/index.ts)、[reconcile-loop.ts](../../packages/workbench/src/ui/reconcile-loop.ts) | sync 不调用读集对账；watch 会；UI 周期对账但不启动完整 watcher/自动 runtime |
| 通知时机 | [notice-queue.ts](../../packages/workbench/src/chat/notice-queue.ts)、[thread-run.ts](../../packages/workbench/src/chat/thread-run.ts) | 排入线程文件后，由下一用户回合消费；没有实时打断当前推理，也不会把 batch 写者的 pending 假称送达 |
| 派发与执行 | [dispatch/perform.ts](../../packages/workbench/src/scheduler/dispatch/perform.ts)、[agents/runner.ts](../../packages/workbench/src/agents/runner.ts) | auto/dispatch 创建绑定工位；agent run 另行启动进程 |
| 完成语义 | [verify-checkpoint.ts](../../packages/workbench/src/runtime/verify-checkpoint.ts)、[checkpoint-effects.ts](../../packages/workbench/src/runtime/checkpoint-effects.ts)、[goal-machine.ts](../../packages/workbench/src/automaton/goal-machine.ts) | verified、applied、done 分阶段；退出码、目录与结果分别解释，不声称已 merge |
| 采集来源 | [footprint.ts](../../packages/workbench/src/blackboard/footprint.ts)、[sessions.ts](../../packages/workbench/src/commands/sessions.ts)、[install-hooks.mjs](../../packages/context-rot/scripts/install-hooks.mjs) | CLI 捕获、显式登记、watcher 与 context-rot hook 是不同来源；后者独立日志没有自动导入 Workbench |
| 检测覆盖 | [premises.ts](../../packages/workbench/src/runtime/premises.ts)、[session-view.ts](../../packages/workbench/src/blackboard/session-view.ts)、[durability.ts](../../packages/workbench/src/runtime/durability.ts) | 增加活跃窗口、单路径最后观察、生成物过滤、范围/导出表面启发式及大文件限制 |
| seal | [commands/premises.ts](../../packages/workbench/src/commands/premises.ts)、[seal.ts](../../packages/workbench/src/runtime/seal.ts)、[codex-session.ts](../../packages/workbench/src/chat/codex-session.ts) | pending 路径重叠不等于跨文件依赖验证；不是每次写入前原子重扫；Codex 汇总全写者 pending，且审批回复没有像 Claude hook 一样返回完整原因 |
| HTTP/CLI 参数 | [http-request.ts](../../packages/workbench/src/chat/http-request.ts)、[claude-session.ts](../../packages/workbench/src/chat/claude-session.ts)、[codex-session.ts](../../packages/workbench/src/chat/codex-session.ts) | model/baseUrl 等字段只传 HTTP；CLI 用自身配置；fanout 仅 HTTP，effort 仅 Responses |
| 分叉 | [thread-fork.ts](../../packages/workbench/src/chat/thread-fork.ts)、[thread-inheritance.ts](../../packages/workbench/src/chat/thread-inheritance.ts) | 消息前缀复制不等于 provider 上下文；Claude 还需尾部、可恢复、无当前 live 进程；没有自动 Git worktree |
| 面板能力 | [App.tsx](../../apps/workbench-ui/src/App.tsx)、[workbench-shell.tsx](../../apps/workbench-ui/src/components/chat/workbench-shell.tsx)、[send-slice.ts](../../apps/workbench-ui/src/chat/send-slice.ts) | 当前是聊天界面；单页一个发送中回合；不把未被调用的管理路由写成页面 |
| 恢复/重试 | [restore-view.ts](../../packages/workbench/src/chat/restore-view.ts)、[resume.ts](../../packages/workbench/src/chat/resume.ts)、[thread-lifecycle.ts](../../packages/workbench/src/chat/thread-lifecycle.ts)、[rollback.ts](../../packages/workbench/src/runtime/rollback.ts) | 笔记不额外调用模型；reload 不撤销副作用；代码回退使用记录 HEAD，不是还原未提交正文 |
| 计划模式 | [threads.ts](../../packages/workbench/src/chat/threads.ts)、[claude-session.ts](../../packages/workbench/src/chat/claude-session.ts) | 元数据更新不重建 live CLI；不能宣传跨 provider 即时只读开关 |
| 本地安全 | [server.ts](../../packages/workbench/src/ui/server.ts)、[auth.ts](../../apps/workbench-ui/src/auth.ts) | loopback、主机名检查、bootstrap/token/no CORS；不隔离同机进程，不是公网多用户服务 |
| 存储 | [ThreadRepository](../../packages/workbench/src/chat/thread-repository.ts)、[draft-storage.ts](../../apps/workbench-ui/src/chat/draft-storage.ts) | 编排经 Blackboard，聊天线程另存；部分草稿在浏览器，不再声称所有写入都经过同一原子数据层 |
| hooks | [install-hooks.mjs](../../packages/context-rot/scripts/install-hooks.mjs)、[doctor/checks/config.ts](../../packages/workbench/src/doctor/checks/config.ts) | `.git/hooks` 存在性检查不证明 core.hooksPath 与脚本实际接线；安装器并非通用 linked worktree 解析器 |
| 发行 | 实际 `gh repo view` / `gh release view workbench-v0.4.1` | 仓库 PRIVATE；Release 非 draft、非 prerelease、8 项资产；需要访问权限，不等于公开下载 |

## 隔离实跑

临时 Git 仓库中提交一个 `value.txt` 和读取它的验证脚本，用真实命令依次执行 init、goal add、sync、ws create、dispatch、checkpoint create、sync。没有更改本仓库的分支、Git 索引或工作台状态。

| 观测 | 实测结果 |
| --- | --- |
| dispatch | 成功建立 worktree/context；`agent_started` 事件为 0，证明本路径不自动 spawn |
| 验证成功后的轮次 | 第 1 轮 checkpoint verified / goal in_progress；第 2 轮 applied / in_progress；第 3 轮 applied / done；第 4 轮仍 done |
| 验证失败 | 将 fixture 内容改成验证脚本不接受的值；验证为 failed，而 `sync` 自身 exit 0 |
| 跨文件 seal | `api.ts` 的 stale claim，写 `handler.ts`，实际 `judgeSeal` 返回 blocked=false |
| 大文件变化 | 2,000,001 字节变为 2,000,002 字节且内容改变；两次 version 都为 null；reconcile 通知 0 条 |
| HTTP 认证 | 真实回环 GET /api/state 无 token 为 401；bootstrap 握手后可读取 |
| HTTP 线程动作 | 创建线程、用 fixture 消息作锚点 fork、adopt、revert 均成功；创建 fork 时 transcriptInherited=true，另外两项为 null |
| MCP 子进程 | initialize、tools/list、tools/call 经真实 stdio；exit 0；工具名为 premises/footprints/resume_cards/tribunal/notices |
| Codex 错误通知确认 | 假 app-server 正常握手后发送 error；真实宿主链路输出 error，仍写 1 条 premise_notice_delivered，notices.jsonl 被移除 |

总体探针 exit 0 表示上述**预期观测被复现**，包括负面结果；不表示缺口已修复。

Codex 复现所需的协议最小序列是：响应 initialize；对 thread/start 返回 thread.id；对 turn/start 先响应请求，再发送 `{"method":"error","params":{"error":{"message":"intentional provider error"}}}`。通过 `WORKBENCH_CODEX_COMMAND` 指向仅实现上述序列的本地进程，在配置为 codex 的 `ChatThreads` 上先 `notifySession()` 再 `run()`，检查发出的 error、事件日志和线程通知文件。全链在本机运行，不向模型服务发请求。

大文件复现可直接通过 `hashPathClaim()` 捕获一个大于阈值的文件，以该 claim 调用 `bb.sessions.recordActivity()` 登记已读，修改内容后调用 `reconcilePremises()`。连续 null 版本相等，在大小比较前即跳过。这不是对所有大文件状态转换的结论，例如小文件变成大文件的版本比较不同。

## 本轮门禁

| 检查 | 结果 |
| --- | --- |
| 相关后端测试 | exit 0；160 pass / 0 fail；22 个文件，713 次断言；26.30s |
| UI suite | exit 0；68 pass；18 个文件；10.74s；属于 Vitest/jsdom，不是浏览器验收 |
| lint | exit 0；Biome 检查 659 个文件；未自动修改 |
| README 链接/锚点/结构 | exit 0；根 README 与本记录合计 162 个本地目标、22 个 Markdown 锚点；代码围栏与表格列数无错误 |
| 上传面门禁 | exit 1；469 条相对链接、0 断链；仅有 3 个本轮开始前已存在的 Windows 缓存文件未分类，不是文档断链；未修改策略或删除这些文件来获得绿灯 |

上传面违规位于字面目录 `%SystemDrive%/ProgramData/Microsoft/Windows/Caches/`：`cversions.2.db` 及两个 GUID 命名的 `.db` 缓存。该目录在本轮开始前已出现在 git status 中。门禁将 untracked 也算入候选上传面，因此这是当前工作区的真实失败；不等于这些缓存已经提交或上传。命令：`bun run check:upload-surface --strict-references --json`。另出现两个旧 node_modules 链接目标不存在的 Git 警告，未据此改依赖或产品代码。

文档检查读取 Markdown 标题及链接、解析相对目标并核对内部锚点，另检查围栏闭合与表格列数；不把它当作语义正确性的自动证明。`git diff --check` 同样 exit 0。最后复核另外收紧了三处说法：线程头只代表 lastRun、metrics 生产采集来自批处理、tribunal resolve 不执行建议动作。

后端命令（从 `packages/workbench` 运行，并给回环设置 NO_PROXY）：

```powershell
bun test src/cli.test.ts src/commands/init.test.ts src/commands/doctor.test.ts src/commands/sessions-record.test.ts src/runtime/mvp-flow.test.ts src/runtime/integrity.test.ts src/runtime/delivery.test.ts src/runtime/seal-decided.test.ts src/runtime/read-set-diff.test.ts src/runtime/premises.test.ts src/scheduler/dispatch.test.ts src/scheduler/dispatch-recovery.test.ts src/watcher/watcher.test.ts src/mcp/tools.test.ts src/mcp/server.test.ts src/ui/server.test.ts src/ui/chat-config.test.ts src/ui/evidence-route.test.ts src/chat/fork-inheritance.test.ts src/chat/notice-queue.test.ts src/chat/provider-capabilities.test.ts src/chat/codex-write-capture.test.ts --timeout 60000
```

未执行全量 Workbench/context-rot suite、重新构建、浏览器自动化或真实模型实验；没有刷新 `evidence/readings`。旧读数是否适用由各自注册范围决定，不能把本轮文档复核宣称为完整产品验收。真人研究与非 Windows 执行验证仍按 ADR-0024 永久退役。

README 的保证是本轮列明的入口与能力按证据表述，并公开已发现的缺口；不是对整个代码库不存在未知问题的保证。

## 同日补记：Windows 缓存上传面修复

上文 exit 1 是修复前的真实读数。现已在 `.gitignore` 中精确忽略根目录的 `%SystemDrive%/ProgramData/Microsoft/Windows/Caches/`，并在 `scripts/upload-surface/policy.json` 将同一子树分类为 `machine-state`。三个缓存均未被 Git 跟踪，文件保留本机；没有删除系统文件、忽略所有 `.db` 或关闭未分类检查。

只加忽略规则无法解决此门禁：它同样检查 ignored 文件是否已分类。本次同步处理 Git 候选上传面和策略分类；若缓存被强制纳入上传面，仍按 `useless-uploaded` 拒绝。新增回归还确认相邻目录及普通 `data/application.db` 不会继承这项分类，README 仍为需交付的 outcome。

实测：`bun run test:upload-surface` exit 0（分类 16 项、链接 15 项，合计 31 项，0 失败）；`bun run lint` exit 0；`git check-ignore -v` 确认三个缓存命中该精确规则；`git diff --check` exit 0。`bun run check:upload-surface --strict-references --json` 现为 **exit 0 / clean / 0 违规 / 469 条相对链接 / 0 断链**。两个既有 node_modules 缺失链接的 Git 警告仍存在，不影响本次上传面判定，未扩展修改依赖树。

缓存的创建者没有进程级记录可追溯；字面路径与此前缺失 Windows 环境变量的现场相符，但不据此断言具体进程。本次修复的是这类本机缓存的上传分类和误入库防护，没有修改全局系统环境。

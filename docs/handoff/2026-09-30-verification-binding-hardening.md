# 验证绑定缺口修复与指标措辞纠正（2026-09-30）

接续[首版验证绑定](2026-09-30-verification-binding-slice.md)与[短板调查](2026-09-30-product-gaps-and-moat.md)。
基线 HEAD `68ebef5`，包含此前尚未提交的 #45–#48、README 和首版绑定改动。
本轮范围是四个已复现的验证绑定缺口，以及 `repaired` 的展示措辞；没有实施交接包、通知状态分离或多版本读集。

## 修复与验收含义

| 反例 | 本轮处理 | 自动化检查 |
| --- | --- | --- |
| 验证后删除原本干净的受跟踪文件，旧绑定仍 intact | 删除以 `null` 单独记录，不再丢弃；删除不变可保持有效，恢复文件再次失效 | 真实 Git 目录：删除、删除后不变、恢复 |
| 未跟踪目录内的文件变化漏检 | `git status --untracked-files=all` 展开到文件 | 新目录内文件改动可见；仅 git add 不误失效 |
| 带空格/非 ASCII 路径被跳过 | NUL 分隔的 porcelain v1，不拆引号或箭头；禁用重命名折叠保留两端路径 | 空格、中文、修改、暂存重命名 |
| 检查断言通过后、进程退出前改坏输入，仍完成目标 | 检查前后各采集一次并比较；不同则进入 awaiting_review | 真实子进程改坏输入，检查事实仍 passed，但无有效绑定、目标不完成、后续 sync 不自动重跑 |
| 新采集失败被当成旧记录兼容放行 | 非删除的读取失败使整个采集不可用；新验证保留 verificationBindingIssue，停在 awaiting_review；人工批准也必须能采集 | 不可读/消失路径、非 Git 工作区、批准被拒绝、驳回仍可执行 |
| 重读被展示为“已修补” | CLI 展示“repaired 已重读”，常驻说明不证明版本刷新或验证通过 | 现有通知统计回归与实际 CLI 输出 |

捕获代码在 `runtime/verification-snapshot.ts`，比较与生命周期处理继续在 `runtime/verification-binding.ts`。
`verify-checkpoint.ts` 在一次固定 cwd 中运行检查并采集前后状态，清除上次尝试的绑定，避免重验失败时沿用旧绑定。
检查通过但绑定有问题时，归档仍保留真实 `passed`，另记状态问题与 `verification_awaiting_review` 事件；自动机的待审查提示含原因。
这类检查不自动反复执行，后续由人工审查或新 checkpoint 重验处理。人工批准是新的人工决定，不等于重新运行了自动检查。

旧的无绑定 checkpoint 仍可按原兼容路径推进，不能据此声称历史记录已有当前有效性证明。
`repaired` JSON 键和计数算法保持兼容，此次只收紧其展示与代码注释，不补版本核对或修复正确率。

## 实际执行记录

以下均为本轮 Windows / Bun 1.3.14 实际执行；完整测试覆盖当前合并工作区，包含此前未提交的改动。

| 命令 | 最终读数 |
| --- | --- |
| `bun run test:workbench` | exit 0，1050 pass / 0 fail，164 files，34 snapshots，4607 个断言，140.96 秒 |
| `bun run test:workbench-ui` | exit 0，18 files / 68 tests passed，8.56 秒 |
| `bun run test:context-rot` | exit 0，69 pass / 0 fail，171 个断言 |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7842 -UiPort 5324 -KeepWorkspace` | exit 0，真实 Chromium 14/14 passed，28.8 秒；未调用模型 |
| `bun run typecheck` | exit 0，三个包 |
| `bun run lint` | exit 0，668 files；初次格式问题已修正 |
| `git diff --check` | exit 0 |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言、0 失效，blackboard 正常 |
| `bun run check:upload-surface` | exit 0，849 个上传面文件，违规 0，525 条相对链接、断链 0；仍有两条既有 node_modules 失效链接警告 |
| `bun run check:claims` | exit 1，13 stale / 2 valid / 1 observation；未更新注册读数，不把工作区通过读数冒充已落库证据 |

过程与定向读数：

- 四文件定向回归：exit 0，33 pass / 0 fail，111 个断言。
- 完整后端首轮：exit 1，1046 pass / 4 fail。四个旧测试没有可绑定的 Git HEAD/工位；已补真实仓库条件，MVP 用真实 Git worktree，保持原通过判据。过程中一处测试辅助函数参数顺序错误已修正，MVP 两个用例单独复跑通过。
- 实际 `workbench stats`：exit 0，展示“repaired 已重读”及边界说明。

原始日志留在本机 `.agent-contexts/verification-binding-fix-20260930/`，不上传。
历史调查探针保持原样；它们对旧缺陷的断言不再适合作为修复后通过门禁。

## 保留边界

- 前后状态比较不是原子快照，不能排除先改后还原的 ABA，也不是全仓写锁。
- 仍是 HEAD 与 Git 可见 dirty/untracked 内容的保守绑定。被忽略文件、外部服务、环境变量、完整工具链和用例集合不在本轮覆盖内；不把 exit 0 解释为所有需求已验收。
- 工作区需要可读的 Git HEAD。读取子模块等不支持对象时可能返回未知，不静默当成完整覆盖。
- 仍只在 `verified → applied` 前检查后续变化；不是所有已完成目标的持续有效性监控。
- 没有新依赖、数据库、通用 Shell 解析或后台重试机制。没有重录 claims、修改任务森林、提交、推送或发布。
- 没有真实模型调用；不把确定性测试升级为 Codex 写保护验收。ADR-0024 退役范围不重开。
- 本轮没有执行二进制构建或构建形态验收，不代表已发布产物更新。

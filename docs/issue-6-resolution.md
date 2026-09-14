# Issue #6 修复记录

2026-09-14。对应 [GitHub issue #6](https://github.com/Baixu22/VerseSpace/issues/6) 中的 15 项。
本次核验并补齐已有工作区改动，逐项结果如下。

| 项 | 处理结果 | 代码或验证入口 |
| --- | --- | --- |
| 1. 合并安全网无生产调用 | 共用派发入口执行真实合并预测和稀有写集重叠检查；自动调度、CLI、HTTP 均覆盖。冲突进入裁决队列，预检失败有日志，保持建议性质。 | `scheduler/dispatch.ts`、`scheduler/merge-guard.ts`、`scheduler/dispatch-guard.test.ts` |
| 2. 森林证据过期 | 重写 TF-0128/0131/0138/0150/0154 的当前证据和相关摘要，去掉漂移行号，并同步受修复影响的节点；节点数量、状态和关系均不变。真实 git pull 后的通知链已补证。 | 森林提案 `TFP-issue6-20260914`；`chat/git-pull-notice.test.ts` |
| 3. L1 认可率口径 | 按 issue 允许的口径修正方案处理：主读数为 session-top-k，默认 K=3，分母是过滤后的全部当前候选；覆盖率单列。未新增真人复核，不宣称 80% 门槛已达成。 | TF-0057/0154；`interactions/landmark-set.ts`、`review-stats.ts`、`chat/stats.ts` |
| 4. 送达信号不可见 | composer 上方显示实际送达数量，十秒后收起并支持关闭；后台对话的事件不会显示到当前对话。 | UI `chat/store.ts`、`components/chat/notice-delivered.tsx` 及回归测试 |
| 5. 路由无 UI 入口 | 删除无人消费的 tribunal/wip/metrics HTTP 路由，保留相应 CLI；对话标题栏新增命名入口，消费 promote 路由，失败可重试。 | `ui/server.ts`、`ui/promotion-route.test.ts`；UI `components/chat/promote-thread.tsx` |
| 6. 六项死导出及双实现 | FACTS_PREVIEW_COUNT、resumeDelta、foldAndAssess 接入生产调用；删除 shouldInjectResumeCard、generateAllContexts、evictToolResultContent。预览条数和消息增量由服务端计算下发，UI 不再复制规则。 | `chat/restore-view.ts`、`chat/resume-card/`、`agents/runner.ts` |
| 7. 裁切函数无人执行 | 删除 evictToolResultContent，明确工具输出膨胀告警是收窄输出的建议。 | `tribunal/lane-distress.ts` |
| 8. Rust 本地旁路 | 补充旁路位置、恢复命令和有效性边界；纠正补丁实际在 OUT_DIR 副本执行的说明。原始依赖已在临时目录成功构建，宿主干扰根因仍未定位。 | `AGENTS.md` 的本地环境说明，详见下文 |
| 9. 两套扫描器分叉 | Workbench 复用 context-rot 的扫描实现，仅适配唯一引用报告；共享提取测试归入 context-rot。独立 CLI 继续额外验证符号和包，Node 产物不依赖 Bun 全局对象。CI 对共享源码变更运行两套测试。 | `packages/context-rot/src/`、`rot/scan.ts`、`.github/workflows/ci.yml` |
| 10. 队列假警告 | 正在施工的目标不再入队；同轮转为非 ready 的旧队列条目立即出队。端到端检查确认 doctor 不再报该假警告。 | `automaton/goal-machine.ts`、`runtime/mvp-flow.test.ts` |
| 11. human 读集表述 | 更正为“有手动 CLI 记录入口、无自动人工读取采集入口”；区分前提持有者与变更制造者。 | `docs/tf0167-moat-gate-verdict.md` |
| 12. 运行失败告警缺位 | 派发失败和 agent 崩溃熔断进入裁决队列；重复原因折叠，已有分支名诊断不再重复生成卡片。 | `scheduler/dispatch.ts`、`agents/runner.ts`、`tribunal/envelopes/` |
| 13. 五处空 catch | 写者足迹读取失败、错误后的线程状态复位失败、PID 注册失败均记录日志；保留旧 spool 清理和错误已交还调用方的队列接力 catch，并说明原因。 | `blackboard/footprint.ts`、`blackboard/sessions.ts`、`chat/threads.ts`、`supervisor/index.ts` |
| 14. 测试夹具位置 | automaton 夹具移入测试目录，调用方同步更新。 | `test/automaton-fixtures.ts` |
| 15. Bun 版本分裂 | packageManager、共享 CI 安装动作、Workbench 发布流水线统一为 1.3.14；验证 HTTP 端口复用和非法百分号路径拒收行为。 | `package.json`、`.github/actions/setup-js/action.yml`、`.github/workflows/release-workbench.yml`、`ui/*test.ts` |

表内未带包名前缀的后端路径均相对 `packages/workbench/src/`，UI 路径相对 `apps/workbench-ui/src/`。

已完成的验证：

- 旧前端：1,692 项通过；本地执行仅排除了 `.workbuddy/issue6-start-20260914/` 中的改动备份，保留全部 162 个项目测试文件。
- Workbench：664 项通过，1 份快照通过；包含真实 git、CLI、HTTP、常驻子进程通知链。
- Workbench UI：25 项通过；context-rot：65 项通过；sidecar：418 项通过、1 项平台相关跳过。
- Rust：`cargo test -j 1` 共 1,695 项通过；`cargo clippy -j 1 --all-targets -- -D warnings` 零警告通过。
- 仓库类型检查、Biome、Workbench 原生及 npm 产物构建、context-rot Node 产物构建通过。
- Workbench 两种产物均在独立临时工作区通过 init、doctor、stats 和内嵌 UI HTTP 冒烟测试，运行时不依赖源码目录。
- 当前仓库扫描：346 条引用，失效 0；生成物 2、未确认 24，后两类不冒充已验证有效。
- 任务森林经官方 CLI 应用，validate/export 通过；没有代填 human 事件或变更节点状态。

本机第一次将 Rust 编译与 Workbench 测试并行运行时，出现内存分配失败、进程启动失败及锁/端到端超时。
改为分开执行、Rust 单编译任务后上述检查通过；没有降低断言或更改超时来掩盖失败。

Rust 主仓库的通过结果仍使用原有 cargo registry 旁路。本次另从 Cargo.lock 校验过的 4.15.15 原始归档
建立了临时探针，以 pq-experimental 特性执行原始补丁流程，`cargo check` 在 68 秒内通过。
探针未改 registry 或系统防护设置，也未跳过补丁；它不能替代主仓库移除旁路后的完整验证。
第 8 项的宿主干扰根因和第 3 项的新一轮真人认可复核仍需后续处理。

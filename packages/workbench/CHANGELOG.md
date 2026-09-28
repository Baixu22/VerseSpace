# @baixu22/workbench

## 0.4.1 — 2026-09-26（本地研究原型，尚未公开发行）

- README 对齐当前聊天面板与 CLI 分工，补充安装条件，修正接口存储目录和发布命令的工作目录。
- 按 ADR-0024 永久关闭非 Windows 实机验证与真人研究，保留四平台交叉编译；未验证指标不改记通过。
- 证据门禁校验类型、实际退出码、期望值、最低样本与跨包依赖；历史观测单列。
- Codex 通道明确标为实验性，修正自身前提和 fresh/stale 对照，不宣称真实写保护通过。
- 固定研究范围与复核入口，见 ADR-0023 和研究收尾记录。
- 下列旧审计项描述各自落地时的改动，其中 CI 接线已由 ADR-0021 退役。

审计回补（P0–P4）：把「看起来有保护、实际没有」的地方改成真的能拦住、或真的会报错。

- **封印守卫链修好了（P0-1）**：`.claude/settings.json` 的 PreToolUse hook 原本调 `workbench premises seal`，解析到机器上 2026-08-29 构建的 0.3.0 二进制——那个版本根本没有 `premises` 命令，所以守卫从未触发过一次（账本里 `seal.decided` 事件数为 0）。hook 改为直接调仓库源码，并在隔离账本里实测：命中时 exit 2、`seal.decided` 落盘。
- **`protection.readonlyAreas` 真的拦写（P0-2）**：此前只声明、只校验、`config set` 还打印成功，全仓零消费者。现在经封印点拒绝受保护路径的写入，且**不受 `seal.mode` 影响**（模式管的是前提失效姿态，不是「声明的保护算不算数」）。同时新增 `readonlyBlocks` / `premiseBlocked` 计数，避免只读拒绝冒充护城河读数。
- **`thresholds.checkpointTimeout` 真的生效（P0-2）**：验证超时改为「checkpoint 声明 → 配置 → 模块常量」三级，此前配置值被完全忽略（默认恰好等于 300s，所以漂移被掩盖）。
- **`thresholds.idleNotification` 真的发通知（P0-2）**：有工位在办而事件日志整段静默超过阈值时提醒一次；通知本身是事件，因此不会重复刷屏。
- **`protection.gitHook` / `config.project` 有了消费者（P0-2）**：`doctor` 新增 `git_hook_missing`（error）与 `project_path_mismatch`（warning）。
- **`doctor` 双向失真修正（P0-3）**：扫描器把 `https://…` 折成 `https:/…` 后当成仓库路径（AGENTS.md 的 remote 表贡献了两条误报），scp 形式的 git remote 同样被误报——两处已修；`interface_drift`（契约漂移＝前提失效本身）从 warning 升为 error；退出码首次有测试钉住；`doctor` 接入 `.gitlab-ci.yml` 的 verify 阶段，实测 exit 0。
- **静默吞错改为可见（P2）**：损坏的裁决条目不再从队列里无声消失（CLI/HTTP 报告「N 条无法读取」）；损坏的 lane metrics 不再被读成全零后写回（累计统计不再被销毁，改为抛出）；codex 车道的状态复位失败与 claude 车道同样上报；读不到 `threads/` 目录不再冒充「你没有对话」。
- **测试假阳性（P3）**：MCP 工具的体积上限用例原本跑在空账本上（删掉五处 `truncate()` 仍绿），现在用超限账本并断言截断标记；`protocol.test.ts` 的恒真断言改为断言 pre-turn error 的保留与 JSON 往返；`evidence-route.test.ts` 的 `%ZZ` 分支不再把任何 fetch 失败都当成「已拒收」；`supervisor` 两处静默平台守卫改为可见的 `skipIf`；`resume.ts` 中永远够不到的 `beats.slice(0, 5)` 按死代码删除。
- **结构收口（P4）**：7 个超 300 行的生产文件拆成模块目录（`scheduler/dispatch/`、`git/host-filesystem/`、`chat/codex-app-server/`、`doctor/`、`chat/render-decision/`、`tribunal/envelopes/`、`runtime/merge-guard/`），生产源码超 300 行的文件回到 0；两个只被测试导入的 fixture-replay 驱动移入 `src/test/`，不再进入生产模块图；`rollback.ts` 那条「这是回退的唯一依据」的注释与事实相反（该函数无生产调用方），已改写；`.workbench/workbench.yaml` 的 `agent.command` 改为生效形态，不再由 loader 静默改写；`WORKBENCH_CLAUDE_MCP=on` 允许自定义命令仍接上账本 MCP；阶段 4 的人工门操作指南重新纳入版本控制（ADR-0019 称其长期有效）。
- **森林门禁可复现（P1）**：`node scripts/check-forest-landing.mjs` 把 `check-landing` 的落库检查搬进仓库，并改为对**默认分支**比对（原来只比 HEAD 时间戳，这正是 2026-09-23 阶段 3「代码只在未合并分支、森林却报 done」的成因，`TFD-0dab4149f2`）；无法测量时 exit 2，绝不冒充绿。
- **审计复盘补漏（P5）**：P2 把 `thread-repository.ts` 的「读不到 `threads/` 冒充没有对话」修成可见，却漏了 `doctor/checks/adoption.ts` 里同款的私有翻版——目录读不了 `catch → []`、`meta.json` 损坏 `catch → null`，于是 doctor 这个 CI 闸门在账本损坏时反而放绿。改为复用 `ThreadRepository.listReport()`，目录不可读报 `threads_unreadable`（error）、损坏 meta 报 `thread_meta_unreadable`（error），并加测试钉住损坏 meta 翻红退出码。`sessions-record` 的「没有 .workbench 静默返回」用例此前只调用不断言,补上「resolve 为 undefined 且不顺手建 `.workbench/`」两条断言。`seal` 只在 Claude Code PreToolUse hook 生效、非 hook 写者（git/编辑器/codex 车道）不被封印这一边界写进 AGENTS.md（原先只有 codex 半边记在 ADR-0017）。

## 0.4.0

从「可用」长到「可编排」的一版：账本能力进入对话、第二个可观测 provider 落地、CI 收敛为单通道。

- **账本能力内嵌对话（阶段 2）**：claude 车道在 spawn 时挂上 Workbench 的**只读账本 MCP**（`premises` / `footprints` / `resume_cards` / `tribunal` / `notices`），模型在回合中可自己查前提与足迹；折入模型 prompt 的前提通知作为 `NoticePart` **持久化到对应的 user 轮次**并渲染，模型看见了什么在记录里查得到；裁决队列以 `TribunalBar` 出现在 composer 上方，可直接 resolve / shelve。三处都落在对话内既有形态（消息 part、composer 上方 sidecar、模型工具卡），没有新增独立面板或路由级视图。
- **第二个可观测 provider（阶段 3 / ADR-0017）**：直接监督外部 CLI、在主包内做轻量协议适配，**不复活 sidecar、不 import SDK**——codex 车道监督 `codex app-server` 的 JSON-RPC-on-stdio：权限请求即读写声明并自动接受，用户输入请求自动拒绝以免回合悬挂，协议用保留的真实流夹具建门禁测试。
- **CI 收敛为单通道（阶段 1 / ADR-0018）**：删除 `.github/workflows/ci.yml`、`release-workbench.yml` 与 `.github/actions/setup-js/`，不再使用 gitlab.com 车道；JihuLab（极狐）自托管 runner 成为唯一 CI 通道，verify 与 release 两个 stage 都在 `.gitlab-ci.yml`。重活（typecheck / workbench-test / workbench-ui-test）共用 `resource_group: heavy`，避免 16 GB 主机上互撞；发行链改为 origin 推真实 tag、jihulab 推同树快照 tag（`scripts/win/jihulab-snapshot.sh`）。
- **删除未接线的 `git/stash.ts`**：TF-0202 从支线 Rust 翻译来的结构化 stash 原语（`nothing` / `clean` / `conflict` / `failed` 四种结局）自 2026-09-18 起只有测试覆盖、没有生产调用方；其原定消费者是支线的 move-local 流程，主线没有对应能力，派发走全新 worktree、恢复走按路径 checkout，都到不了"需要 stash"的状态。按 ADR-0011 的删除规则清掉；若将来出现"工位换分支但保留未提交改动"的命令，可从 `9e3f560` 及更早历史取回。
- **文档与社区面**：新增 `CONTRIBUTING.md`、`SECURITY.md`、issue 表单与 PR 模板；ADR-0019 把阶段 4（真人使用窗口）与发行验收明确记录为**常设外部门**，不作为本轮交付——fit 账本的四项护城河判决因此仍停在「证据不足」，这是有意保留的空白。
- **平台覆盖（务必如实理解）**：四个二进制由一台 Windows 主机用 Bun 交叉编译，**只有 windows-x64 跑过完整测试**；linux-x64、macos-arm64、macos-x64 只做了构建，没有在对应平台上执行过。

## 0.3.0

从「能跑」长到「可用」的一版：本地聊天面板成形，前提守护的读数与账本齐备，L1 隐式上下文层的分母口径定稿。

- **本地聊天面板（GUI）**：assistant-ui 聊天前端 MVP 起步，随后补齐规划模式、工具调用渲染与消息操作，成为产品级对话面；抽屉式侧栏与动效收口，并补上真实浏览器 E2E。塔式布局把工位车道、内联派发与复核放进同一屏；复核队列改为「决策优先」（先给论点，再给证据）。
- **建议式并发与裁决**：runtime 增加投递/合并守卫、会话与裁决队列（ADR-0006/0007/0008）。
- **L2 交互层**：分叉、扇出变体、建议与账本、车道清理；会话树生命周期事件与稳定的通知身份。
- **前提守护的读数与证据**：通知与封印决策可度量；双通道恢复卡（叙事 + 仓库事实），恢复时给读集 diff；规则 R10 的分支事实；git 也能对自己的写入做声明。
- **L1 隐式上下文层**：DOI 兴趣模型（衰减重置、双阈值、父级传播）；地标集合的分母从绝对阈值改成**每会话文件级 top-3**（相对选择），并补上地标认可手势、复核队列与 fit 账本；账本按样本量门判定而不是日历窗口（TF-0141/TF-0156/TF-0159）。
- **live 链路去宿主化**：`bun:ffi` 解 DPAPI 凭据 + 宿主无关入口，整条链路零脚本宿主依赖；moyu 长期累积跑支持现场复用与逐轮读数；真实模型 E2E 的超时预算分层。
- **接口注册表改为一条目一文件**（旧版单文件 `registry.yaml` 在首次访问时自动拆分）。
- **审计修复（2026-09-16）**：checkpoint 声明的效果未执行却进入 applied、未收结果的工具调用被写进读/写足迹、同工位并发启动覆盖运行身份、删除锚定接口不影响完成态、损坏注册表被静默丢弃——五类事实语义缺陷全部收口；同时按职责拆分 `chat/`、`ui/`、`supervisor/`、`runtime/`、`cli/` 下的超大模块（生产源码超 300 行的文件由 12 个降到 0）。

测试规模从 109 项增长到 714 项（另有 workbench-ui 27 项、根前端 1692 项）。

## 0.2.0

新增本地 Web GUI：`workbench ui` 在 http://127.0.0.1:7700 提供深色面板（目标 DAG、工位、checkpoint 三区、接口漂移、决策、事件流、doctor 体检 + 一键 Sync，2 秒自动刷新）。前端复用仓库 React 19 + Vite + Tailwind v4 + shadcn/ui 栈（apps/workbench-ui），主题直接引用仓库 color-theme.css；UI 资源构建时内嵌进单文件二进制，也可用 --ui-dir 外部指定（ADR-0005）。

## 0.1.0

首个发行版。《Workbench 实现架构骨架》Phase 1-7 全部落地：

- **Blackboard 数据层**：`.workbench/` 下 YAML + JSONL 存储，原子写（tmp+rename，Windows EPERM 重试）、追加式事件日志、接口注册表 sha256 漂移检查、WorldSnapshot 聚合。
- **Automaton 状态机**：goal / checkpoint / workspot 三个纯函数状态机 + 稳定序 evaluator，无 IO、幂等；接口漂移经版本锚定传播 `stale_done`。
- **Verifier**：test / type-check / build / human-review / skipped 五策略受控子进程执行，超时强杀进程树，失败输出截断归档。
- **Runtime**：snapshot → automaton → 逐条应用 → 调度 → 漂移重锚定 的事件循环，单轮不递归，全程事件审计。
- **Scheduler 与派发**：manual / semi-auto / auto 三策略；dispatch 真实创建 git worktree、激活工位、刷新 `.agent-context.md`。
- **Watcher**：后台监听 + 防抖循环，崩溃自恢复（状态全在文件），单实例锁。
- **doctor**：15 项只读一致性检查，错误退出码 1。
- **CLI**：18 个命令全部真实实现，`--json` / `--quiet` 双输出。

测试：109 个（含真实 git 仓库端到端与容错/并发写入组），Windows 本机全绿。

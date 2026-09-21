# @baixu22/workbench

## Unreleased

- **删除未接线的 `git/stash.ts`**：TF-0202 从支线 Rust 翻译来的结构化 stash 原语（`nothing` / `clean` / `conflict` / `failed` 四种结局）自 2026-09-18 起只有测试覆盖、没有生产调用方；其原定消费者是支线的 move-local 流程，主线没有对应能力，派发走全新 worktree、恢复走按路径 checkout，都到不了"需要 stash"的状态。按 ADR-0011 的删除规则清掉；若将来出现"工位换分支但保留未提交改动"的命令，可从 `9e3f560` 及更早历史取回。

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

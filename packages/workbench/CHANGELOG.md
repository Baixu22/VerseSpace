# @baixu22/workbench

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

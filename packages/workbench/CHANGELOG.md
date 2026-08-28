# @baixu22/workbench

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

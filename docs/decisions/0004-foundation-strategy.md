# ADR-0004：基座策略 = 核心自研 + 组件级借库，不整体 fork

- 状态：已接受
- 日期：2026-08-28

## 背景

调研了可充当基座的开源项目：beads（git-native JSONL 任务图）、claude-task-master（PRD → 依赖任务）、Backlog.md（Markdown 任务文件）、claude-squad / vibe-kanban / conductor（worktree 多代理编排）、spec-kit（spec 驱动流程）。它们各自只覆盖单一切面，没有一个能整体充当 Blackboard + Automaton + Verifier + Workspot 的组合基座；这套组合正是本项目的差异化价值。

## 决策

核心七模块自研；按骨架文档「不造轮子」清单引入组件库。依赖白名单：

| 需求 | 选用 | 引入里程碑 |
| --- | --- | --- |
| CLI 框架 | commander | 里程碑二 |
| YAML 读写 | yaml | 里程碑三 |
| 运行时校验 | zod | 里程碑三 |
| 文件监听 | chokidar | 里程碑九 |
| 终端样式 | picocolors | 里程碑二 |

继续手写：状态机（switch/case）、队列（YAML 数组）、原子写（tmp+rename）、上下文模板（字符串拼接）。不引入：数据库、消息队列、Web 服务器、模板引擎、状态机库、Agent SDK（保持 agent 无关）。

超出白名单的新依赖必须先新增 ADR 说明理由。

## 后果

- 正面：核心逻辑全部可测、可独立替换；依赖面极小，审计成本低。
- 负面：Blackboard/Verifier 等需要自行实现并承担边界问题，由骨架文档约束 + 端到端测试兜底。

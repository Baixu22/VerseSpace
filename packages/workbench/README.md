# @baixu22/workbench

**Workbench** 是一个 CLI + 文件系统状态管理器：为 AI 辅助开发提供项目的元结构管理——目标 DAG、架构决策、接口契约、工位（git worktree）、checkpoint 验证与事件审计。它不依赖任何编辑器、不用数据库，状态全部存放在仓库内的 `.workbench/` 目录（YAML + JSONL），git 可直接追踪、人类可直接阅读。

> 定位：不是 IDE，不是 IDE 插件，也不是 Agent。类比物：git、turborepo、nx——它们管理的是项目的元结构。

## 安装

**方式一：下载单文件二进制**（无需 Bun）——从 [GitHub Releases](https://github.com/Baixu22/VerseSpace/releases) 下载对应平台的 `workbench-*` 可执行文件，放入 PATH。

**方式二：npm 形态**（需要 Bun ≥ 1.3）：

```bash
bunx @baixu22/workbench --help
# 或全局安装
bun install -g @baixu22/workbench
```

## 5 分钟上手

```bash
# 0. 在项目根目录初始化 .workbench/
workbench init

# 1. 添加目标（可带依赖与验收条件）
workbench goal add "实现 Blackboard 数据层" --acceptance "读写往返一致"

# 2. 记录架构决策（append-only，修正靠新决策取代）
workbench decision add "所有写走原子 rename" --rationale "防止并发写损坏"

# 3. 注册接口契约（漂移检测的锚）
workbench interface register contracts/api.md --key core/api

# 4. 创建工位并派发（创建真实 git worktree + 生成上下文）
workbench ws create ws-a --task <goal-id> --branch ws/ws-a
workbench dispatch <goal-id>            # 或 dispatch <goal-id> ws-a

# 5. Agent 在工位 worktree 内开发；完成阶段落 checkpoint
#    （.agent-context.md 已由 workbench 生成，告知 agent 遵守）
workbench checkpoint create --goal <goal-id> --workspot ws-a \
  --assertion "测试全绿" --strategy test

# 6. 跑一轮 runtime：验证 checkpoint → 推进状态 → 传播接口漂移
workbench sync

# 7. 后台监听模式（替代手动 sync）
workbench watch
```

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `init` | 幂等初始化 `.workbench/` 目录 |
| `goal add/list/show/cancel` | 目标 DAG 管理 |
| `decision add` | 追加架构决策（不可改） |
| `interface register/list/check` | 接口注册表与 hash 漂移检查 |
| `ws create/list/reassign/status` | 工位（git worktree 绑定）管理 |
| `checkpoint create/list/review` | 三区 checkpoint（staging/verified/failed） |
| `dispatch <goal> [ws]` | 派发就绪目标到空闲工位 |
| `sync` | 手动跑一轮 Runtime 循环 |
| `watch` | 后台监听，文件变化自动跑循环 |
| `status` / `map` / `log` / `queue` | 状态概览 / DAG 文本图 / 事件流 / 执行队列 |
| `doctor` | 全量一致性体检（错误退出码 1，可作 CI 闸门） |
| `config set <key> <value>` | 修改 `workbench.yaml` |

所有命令支持 `--json`（机器可读）与 `--quiet`。

## 本地面板（GUI）

```bash
workbench ui            # 打开 http://127.0.0.1:7700（自动开浏览器）
workbench ui --port 8080 --ui-dir ./some-dist
```

深色仪表盘：目标 DAG、工位、checkpoint 三区、接口漂移、决策、事件流、doctor 体检，右上角一键 Sync，每 2 秒自动刷新。前端基于仓库 React 19 + Vite + Tailwind + shadcn/ui 栈（`apps/workbench-ui`，开发用 `bun run dev:ui`），构建时资源内嵌进单文件二进制（ADR-0005）。

## `.workbench/` 目录结构

```
.workbench/
├── workbench.yaml            # 配置（调度策略、保护规则、阈值）
├── blackboard/               # 唯一数据层（所有模块经它读写）
│   ├── goals/*.yaml          # 目标（状态机 + 依赖 + 接口锚定）
│   ├── decisions/*.yaml      # 架构决策（append-only）
│   ├── interfaces/registry.yaml
│   └── state/                # 工位、执行队列、已知冲突
├── checkpoints/              # staging / verified / failed 三区
└── events/events.jsonl       # 追加式事件审计日志
```

## 与 Agent 协作

派发时 Workbench 在工位 worktree 内生成 `.agent-context.md`（按工位声明的 `contextNeeds` 组装任务、验收条件、相关决策与接口）。让 Agent 阅读该文件即可——不侵入任何 Agent，利用已有的项目指令机制。调度策略由 `workbench.yaml` 控制：`manual`（默认，人工派发）/ `semi-auto`（提示建议）/ `auto`（自动填充空闲工位，受并发上限约束）。

## 开发

```bash
bun install
bun run test        # cd packages/workbench && bun test
bun run build:all   # 交叉编译四平台二进制到 dist/
```

架构决策记录见仓库 `docs/decisions/`（ADR-0001 至 0004）；实现顺序对应《Workbench 实现架构骨架》Phase 1-7。

## License

MIT

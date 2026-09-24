# 贡献指南

VerseSpace / Workbench 是一个本地优先、写者中立的前提账本。感谢你愿意参与。本文只讲**怎么在本仓库改代码**；产品边界与架构理由见 [ADR 目录](docs/decisions/README.md)，agent 专用约定见 [AGENTS.md](AGENTS.md)。

## 环境

- **Bun 1.3.14**，版本固定在 `package.json` 的 `packageManager` 与 `.gitlab-ci.yml` 的 `BUN_VERSION`。两个版本绑定的行为在升级时必须重测（`fetch` 的连接池跨端口复用、HTTP 层对非法百分号编码的拒绝），见 `packages/workbench/src/ui/server.ts`。
- Node 仅用于少数脚本（`scripts/*.mjs`、`packages/context-rot` 的 hooks）。
- **没有 Rust 车道**：`cargo` / `clippy` / `insta` 不属于本仓库。旧 Tauri 桌面实现已退役（[ADR-0014](docs/decisions/0014-legacy-retirement-gate.md) / [ADR-0015](docs/decisions/0015-legacy-retirement-execution.md)），**不要**重新引入 Tauri、Rust 或 sidecar 进程。

```bash
bun install --frozen-lockfile
```

## 提交前必跑

```bash
bun run typecheck     # tsc --noEmit，三个包
bun run lint          # biome check .
bun run test          # workbench → workbench-ui → context-rot 三套
```

单跑一套：

```bash
bun run test:workbench      # cd packages/workbench && bun test --timeout 60000
bun run test:workbench-ui   # cd apps/workbench-ui && vitest run
bun run test:context-rot    # cd packages/context-rot && bun test --timeout 60000
```

单跑一个文件：

```bash
cd packages/workbench && bun test src/cli.test.ts
cd apps/workbench-ui && bunx vitest run src/App.test.tsx
```

提交时 `lint-staged` 会对暂存的 JS/TS/JSON/CSS 跑 Biome（tab 缩进）。若你改动 `packages/context-rot/**`，**两套测试都要跑**——workbench 的 `doctor` 直接复用该包的扫描器。

### Windows 本机注意事项（不是仓库缺陷）

这些会改变「绿」的含义，容易误判成代码坏了：

- **注入式 HTTP 代理打断回环测试。** 宿主给每个 shell 注入 `HTTP_PROXY` / `HTTPS_PROXY`，Bun 的 `fetch` 连 `127.0.0.1` 也走它，于是所有基于 HTTP 的测试成片失败（`ConnectionRefused`）。跑测试时绕过：
  ```bash
  NO_PROXY="127.0.0.1,localhost,::1" bun test
  ```
- **实时扫描拖住测试收尾。** 新建的 git 仓库目录可能被句柄占住，`rm` 在断言早已通过之后仍报 `EBUSY` 十几秒。孤立的一次收尾 `EBUSY` 属环境问题。
- **重活不要并行。** 16 GB 主机上，全套面板测试与构建同时跑会超时。CI 侧对应 `resource_group: heavy`。
- **Git 的空父目录清理缺陷**会让含斜杠的分支名、`git rm` 目录、remote-tracking ref 出现异常行为。判断依据是**行为**而不是加载了哪个模块，用 `powershell.exe -NoProfile -File scripts/win/check-git-filesystem.ps1` 实测。

## CI

**CI 只有一条通道：JihuLab（jihulab.com，极狐）。** GitHub 承载仓库、PR 与 Release，但**不**承载 CI——`.github/workflows/` 已按 [ADR-0018](docs/decisions/0018-single-ci-channel-jihulab.md) 删除，所以 **PR 上不会出现 GitHub 状态检查**，绿灯要去 <https://jihulab.com/Baixu22/VerseSpace/-/pipelines> 看。

推一个分支：

```bash
git push origin <branch>                                   # GitHub，更新 PR
"C:\Program Files\Git\bin\bash.exe" scripts/win/jihulab-snapshot.sh [ref]   # JihuLab，跑流水线
```

第二条是脚本而不是普通 push，是有意的：本地 `.git` 背着约 2 GB 的 `events.jsonl` 历史，直推会把整份上传；脚本用 `git commit-tree` 造一个**孤儿单提交快照**推到扁平 ref（`main` 与 `feat/*` 在 JihuLab 受保护，拒绝强推）。runner 是本机前台进程，机器必须开机、runner 必须在跑，否则 pipeline 会停在 pending 且没有任何 job。

## 代码组织

1. **一个文件一个职责。** 模块超过约 300 行就拆成 `foo/index.ts` + 若干子文件；`blackboard/`、`chat/`、`scheduler/`、`tribunal/`、`interactions/` 是参考范式。
2. **命令层与领域逻辑分开。** `src/commands/<name>.ts` 只做「解析参数 → 调领域模块 → 格式化输出」，业务逻辑放自己的模块。
3. **`--json` 是契约不是附加项。** 每个子命令都要支持。
4. **append-only 的地方不许改写。** 决策与事件只增不改，修正靠新条目取代。
5. **图标只从 `@/components/icon` 导入**，不要直接用 `reicon-react` 或 `lucide-react`；新图标加进 `scripts/gen-icon-layer.mjs` 后跑 `bun run icons`。
6. **排版用语义 token**（`text-nano` … `text-heading`），不要写 `text-[Npx]`；新增字号 token 必须同时在 `apps/workbench-ui/src/lib/utils.ts` 注册给 tailwind-merge。

## 架构决策与任务森林

- 重大技术决策写进 `docs/decisions/`：一个决策一个文件、编号递增、只增不改；推翻旧决策要新增一条并标注取代关系。**提架构变更前先读现有 ADR。**
- `.agent-workbench/task-forest/` 是「计划了什么、做完什么」的权威；canonical 状态是 `graph/nodes.json` + `graph/edges.json` + `config.json` + `events/events.jsonl`。**不要手改这些文件**，通过 task-forest 工具改。

## 发行

发行由维护者操作，公开形态是**单文件二进制**（`workbench-v*` tag → 四平台交叉编译 → GitHub Release）。npm 形态尚未发布。

```bash
bun run release:tag:workbench            # dry-run，只打印计划
bun run release:tag:workbench --push     # 真正发布：推 tag + 创建公开 Release
```

推 tag 是**真实发布动作**，先确认版本号与 `packages/workbench/CHANGELOG.md`。根目录的 `CHANGELOG.md` 不是这份产品的发布史。四个二进制都由一台 Windows 主机交叉编译，**只有 windows-x64 跑过测试**；macOS / Linux 只做了构建，没有在对应平台上执行过，发行说明里必须如实声明。

## 许可与归属

`@baixu22/workbench` 为 `MIT AND Apache-2.0`。Apache-2.0 §4(d) 要求在分发时提供可读的 `NOTICE`——不要删除 `NOTICE` / `LICENSE` / `LICENSE-APACHE`。

「Helmor」及其 logo 是原作者的商标。Apache-2.0 授权覆盖源码的使用、修改与再分发，但**不**覆盖用该名称或 logo 标识本产品或衍生品。

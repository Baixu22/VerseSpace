# VerseSpace / Workbench

**Workbench 是本地优先、写者中立的前提账本。** 它记录 agent、人和 Git 读写过哪些文件，在已记录的前提失效时给出证据，帮助你恢复对话、检查分支和决定下一步。

状态保存在项目内的 `.workbench/`（YAML + JSONL），不依赖数据库或指定编辑器。CLI 与本地面板读取同一份账本；agent 通过 MCP 与 stdin 获取通知，人通过恢复卡查看变化，需要人工判断的事项进入裁决队列。

## 现状与验证边界（2026-09-27）

本仓库按**工程研究原型**收尾，不是已验收的产品。两类结论必须分开读：**工程门通过（本机可执行范围）** ／ **产品证据不足**（[ADR-0023](docs/decisions/0023-research-prototype-closeout.md)）。

| 维度 | 现状 |
| --- | --- |
| 工程门 | 本机手跑；`lint` / `typecheck` / 三套测试 / `doctor` / 上传面门禁的读数见[本轮交接记录](docs/handoff/2026-09-27-claim-hygiene-round.md) |
| 可复跑证据 | [`evidence/claims.json`](evidence/claims.json) 登记 13 条声明，读数在 `evidence/readings/`；`bun run check:claims` 校验「仪器没变、被测代码没变」，过期即报 stale |
| 产品证据 | **不足**：真人自然使用窗口（issue #32）、非 Windows 平台执行（本机不可达）、Codex 写保护闭环（issue #31）都还没有读数 |
| 发行 | 最新 Release 是 [`workbench-v0.4.0`](https://github.com/Baixu22/VerseSpace/releases)；树上版本 `0.4.1`（[CHANGELOG](packages/workbench/CHANGELOG.md)）**未打 tag、未发布** |
| 平台覆盖 | 只有 **windows-x64** 跑过完整测试套件；其余三个平台目前只有交叉编译产物 |
| CI | **没有 CI**（[ADR-0021](docs/decisions/0021-retire-all-ci-channels.md)）：GitHub Actions 与极狐 JihuLab 通道都已退役，PR 上不会出现任何状态检查，门禁一律本机手跑 |

## 它能做什么

- **前提账本**：记录 agent / 人 / git 对文件的读写足迹，前提失效时给出可追溯的证据与恢复信息。
- **三种界面**：CLI（每个子命令都支持 `--json`）、本地面板（`workbench ui`）、MCP 只读投影（`premises` / `footprints` / `resume_cards` / `tribunal` / `notices` 五个工具）。
- **封印（seal）拦截点**：写者落入已声明的只读区域、或撞上失效前提时拦截并留痕。Claude Code 走 PreToolUse hook；Codex 车道是**实验通道**。

## 它不保证什么

- **足迹覆盖有限，沉默不等于前提全部有效。** 没有结构化路径的读取不在后备解析范围内（[ADR-0023](docs/decisions/0023-research-prototype-closeout.md)）。
- **封印不是仓库级写保护。** Git 与裸编辑器绕过拦截点；对某个命令的负面观测不能泛化到整个 CLI 版本；Codex 通道可能不发审批、目标可能无法归因，封印故障时当前实现放行。
- **不宣称效率收益。** 原型结题不等于已证实生产率提升。

## 快速开始

从 [VerseSpace Releases](https://github.com/Baixu22/VerseSpace/releases) 下载对应平台的 `workbench-*` 单文件可执行程序，放入 PATH 并命名为 `workbench`（Windows 为 `workbench.exe`）。二进制内含运行时与面板，无需另装 Bun。

在要管理的项目目录中运行：

```bash
workbench init
workbench ui
```

`workbench ui` 启动本地面板，默认地址为 `http://127.0.0.1:7700`（`--port` 可换端口，`--no-open` 只起服务）。`workbench --json doctor` 检查账本一致性；只有 `severity: "error"` 的检查会让它非零退出。

完整安装、配置、聊天与 MCP 用法见 [Workbench 使用说明](packages/workbench/README.md)。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [packages/workbench](packages/workbench) | CLI、前提账本、调度与本地 HTTP 服务 |
| [apps/workbench-ui](apps/workbench-ui) | React 本地面板，构建后嵌入 Workbench |
| [packages/context-rot](packages/context-rot) | 独立的指引引用检查器，也是 Workbench doctor 的扫描器 |
| [evidence](evidence) | 声明账本（`claims.json`）与可复跑读数；原始日志按 ADR-0020 留本机 |
| [docs/handoff](docs/handoff) | 每轮交接记录：改了什么、实测读数、刻意没做什么 |
| [docs/decisions](docs/decisions) | ADR：一条决策一个文件、只增不改 |

## 本地开发与门禁

使用仓库固定的 **Bun 1.3.14**（`package.json` 的 `packageManager`），在根目录运行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test        # workbench → workbench-ui → context-rot 三套
bun run dev:ui      # 面板开发服务器，API 代理到本地 workbench ui
```

提交前按仓库自己的门禁清单手跑（**没有任何自动化会替你跑**）：

```bash
bun run lint && bun run typecheck
bun run test:workbench && bun run test:workbench-ui && bun run test:context-rot
bun packages/workbench/src/index.ts doctor
bun run check:upload-surface --strict-references
bun run check:claims
pwsh -NoProfile -File scripts/win/e2e-browser.ps1   # 真实浏览器套件（隔离工作区）
```

构建并验证本机发行物：

```bash
cd packages/workbench
bun run build
bun run test:build
```

`build` 会构建面板，产出本机二进制与需要 Bun 的 JS 包，并复制归属和许可文件；`test:build` 在独立工作区验证两种产物的 CLI、扫描器与内嵌面板。

工程约定（代码组织、命令契约、图标与字号规则）见 [AGENTS.md](AGENTS.md)；贡献流程与 Windows 本机注意事项（注入式代理、子进程限制、Git 主机缺陷）见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 发行

发行是**真实发布动作**，三步且顺序不能换——tag 必须先到 `origin`，因为发布脚本带 `--verify-tag`：

```bash
bun run release:tag:workbench --push
cd packages/workbench && bun run build:all
node scripts/publish-workbench-release.mjs --tag workbench-v<version>
```

发行说明里**必须保留平台覆盖声明**（当前只有 windows-x64 跑过完整测试）。是否切 `0.4.1` 由维护者决定（issue #33），本节只描述确定下来的动作。

## 存量与历史

旧 Helmor 桌面实现已退役：`src/`、`src-tauri/`、`sidecar/` 与外围应用不在当前工作树中，历史代码与旧产品介绍可在提交 `944b9d6` 及更早版本查阅。退役条件、执行与收口分别见 [ADR-0014](docs/decisions/0014-legacy-retirement-gate.md)、[ADR-0015](docs/decisions/0015-legacy-retirement-execution.md)、[ADR-0016](docs/decisions/0016-retirement-closeout.md)。**不要**重新引入 Tauri、Rust/cargo 或 sidecar 进程。

## 许可与归属

Workbench 包为 **MIT，含 Apache-2.0 部分**（SPDX：`MIT AND Apache-2.0`）。具体范围见 [包 NOTICE](packages/workbench/NOTICE)、[MIT 许可](packages/workbench/LICENSE) 和 [Apache-2.0 许可](packages/workbench/LICENSE-APACHE)。根目录的 [LICENSE](LICENSE) 与 [NOTICE](NOTICE) 保留上游许可、版权和商标归属。

“Helmor”及其 logo 是原作者的商标，本产品使用独立名称 VerseSpace / Workbench。安全边界与报告渠道见 [SECURITY.md](SECURITY.md)；问题反馈请提交到 [VerseSpace Issues](https://github.com/Baixu22/VerseSpace/issues)。

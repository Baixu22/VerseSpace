# VerseSpace / Workbench

**Workbench 是本地优先、写者中立的前提账本。** 它记录 agent、人和 Git 读写过哪些文件，在已记录的前提失效时给出证据，帮助你恢复对话、检查分支和决定下一步。

状态保存在项目内的 `.workbench/`（YAML + JSONL），不依赖数据库或指定编辑器。CLI 与本地面板读取同一份账本；agent 通过 MCP 与 stdin 获取通知，人通过恢复卡查看变化，需要人工判断的事项进入裁决队列。足迹覆盖有限，沉默不代表前提全部有效。

## 开始使用

从 [VerseSpace Releases](https://github.com/Baixu22/VerseSpace/releases) 下载对应平台的 `workbench-*` 单文件可执行程序，放入 PATH 并命名为 `workbench`（Windows 为 `workbench.exe`）。二进制内含运行时与面板，无需另装 Bun。

在要管理的项目目录中运行：

```bash
workbench init
workbench ui
```

`workbench ui` 启动本地面板，默认地址为 `http://127.0.0.1:7700`。可用 `workbench ui --no-open` 只启动服务；`workbench --json doctor` 检查账本一致性。

完整安装、配置、聊天与 MCP 用法见 [Workbench 使用说明](packages/workbench/README.md)。当前发行入口是单文件二进制；npm 形态尚未发布。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| [packages/workbench](packages/workbench) | CLI、前提账本、调度与本地 HTTP 服务 |
| [apps/workbench-ui](apps/workbench-ui) | React 本地面板，构建后嵌入 Workbench |
| [packages/context-rot](packages/context-rot) | 独立的指引引用检查器，也是 Workbench doctor 的扫描器 |

## 本地开发

使用仓库固定的 Bun 1.3.14，在根目录运行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build:ui
```

`bun run test` 按顺序执行 Workbench、面板与 context-rot 三套测试。`bun run dev:ui` 启动面板开发服务器，API 代理到本地的 `workbench ui` 服务。

构建并验证本机发行物：

```bash
cd packages/workbench
bun run build
bun run test:build
```

`build` 会构建面板，产出本机二进制与需要 Bun 的 JS 包，并复制归属和许可文件。`test:build` 在独立工作区验证两种产物的 CLI、扫描器与内嵌面板。工程约定见 [AGENTS.md](AGENTS.md)，产品边界见 [ADR-0010](docs/decisions/0010-premise-custody.md)。

## 存量与历史

旧 Helmor 桌面实现已退役。`src/`、`src-tauri/`、`sidecar/` 与外围应用不在当前工作树中；历史代码和旧产品介绍可在提交 `944b9d6` 及更早版本查阅。流协议夹具已迁入 Workbench 包。

退役条件、执行与收口分别见 [ADR-0014](docs/decisions/0014-legacy-retirement-gate.md)、[ADR-0015](docs/decisions/0015-legacy-retirement-execution.md)、[ADR-0016](docs/decisions/0016-retirement-closeout.md)。

## 许可与归属

Workbench 包为 **MIT，含 Apache-2.0 部分**（SPDX：`MIT AND Apache-2.0`）。具体范围见 [包 NOTICE](packages/workbench/NOTICE)、[MIT 许可](packages/workbench/LICENSE) 和 [Apache-2.0 许可](packages/workbench/LICENSE-APACHE)。根目录的 [LICENSE](LICENSE) 与 [NOTICE](NOTICE) 保留上游许可、版权和商标归属。

“Helmor”及其 logo 是原作者的商标，本产品使用独立名称 VerseSpace / Workbench。问题反馈请提交到 [VerseSpace Issues](https://github.com/Baixu22/VerseSpace/issues)。

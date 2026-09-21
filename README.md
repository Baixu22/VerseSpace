> **本仓库是一个 monorepo，产品是 VerseSpace / Workbench——写者中立的前提账本。** agent 走 R2 + stdin 通知，人走 R2′ + 恢复卡，无法回答的问题进入裁决队列。
>
> **产品在 `packages/workbench`（CLI + 文件系统状态层）与 `apps/workbench-ui`（本地面板）。**
> `src/`、`src-tauri/`、`sidecar/` 与 `apps/marketing`、`apps/registry` 是**已退役的存量实现**：
> 已于 2026-09-21 从工作树删除，只在 git 历史里可读（见
> [ADR-0014](docs/decisions/0014-legacy-retirement-gate.md) 退役闸门与
> [ADR-0015](docs/decisions/0015-legacy-retirement-execution.md) 执行记录；可读于
> commit `944b9d6` 及更早）。它们不再向 Workbench 提供任何代码级依赖。
>
> 使用入口见 [Workbench README](packages/workbench/README.md)；工程边界（前提守护的取舍尺子）
> 见 [ADR-0010](docs/decisions/0010-premise-custody.md)；身份、合规与存量退役条件见
> [ADR-0013](docs/decisions/0013-workbench-identity-and-compliance.md)。
>
> 以下 Helmor 桌面说明是**退役产品的历史资料**，仅为存档保留——它描述的代码已不在本仓库工作树中。

<h1 align="center">Helmor</h1>

<p align="center">
  The local-first workbench for orchestrating coding agents.
</p>

<p align="center">
  <a href="https://github.com/dohooo/helmor/releases"><img src="https://img.shields.io/github/v/release/dohooo/helmor?style=flat&label=Release&color=0A7CFF" alt="Latest release" /></a>
  <a href="https://discord.gg/ukyyuNfnDp"><img src="https://img.shields.io/discord/1499667625267957920?style=flat&logo=discord&label=Discord&color=5865F2" alt="Discord" /></a>
  <a href="https://docs.helmor.ai"><img src="https://app.dosu.dev/api/images/badge?h=20&message=Docs" alt="Docs" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-3DA639" alt="License: Apache 2.0" /></a>
</p>

*(产品截图此前由 `src/assets/` 承载，该目录随退役一并删除，见 ADR-0015。)*

> AI made coding faster.
>
> Helmor is about finishing the rest of the loop —
> orchestrating, reviewing, testing, merging, and actually shipping software.

Helmor runs many coding agents in parallel, each in its own isolated git
workspace — conversation, diffs, editor, terminals, and one-click PR actions
in one window. Everything lives locally under `~/helmor/`.

## Features

- **Isolated workspaces** — one git worktree and branch per task; agents never step on each other.
- **Bring your own agents** — Claude Code, Codex, Cursor, OpenCode, and Kimi Code; your logins, API keys, and custom providers.
- **Review without leaving** — diffs, Monaco editor, and terminals beside the conversation.
- **Ship from one button** — create PR/MR, merge, fix CI, resolve conflicts, stacked PRs; GitHub and GitLab.
- **Terminal Mode** — run prompts in the agent's native TUI, or resume a GUI chat in the terminal.
- **Quick panel** — ⇧⌥Space opens a floating window to start a workspace and chat from anywhere.
- **Scriptable** — `helmor` CLI and MCP server; your terminal or another agent can drive Helmor.
- **Skills** — install from onboarding or **Settings → Helmor Components**; browse with `/` in the composer.
- **Mobile companion** *(experimental)* — Cloudflare tunnel to your desktop; start tasks from your phone's browser.

*More on the way — Slack & GitHub context, plan mode, and agent-driven orchestration.*

## How it works

```mermaid
flowchart LR
  A[Add a repository] --> B[Create a workspace]
  B --> C[Prompt an agent]
  C --> D[Review and ship]
  D -.->|repeat in parallel| B
```

1. **Add a repository** — link a local clone, or clone from a URL.
2. **Create a workspace** — fresh git worktree and branch under `~/helmor/workspaces/`.
3. **Prompt an agent** — describe the task and move on while it runs.
4. **Review and ship** — read the diff, run tests, create and merge the PR.

## Get started

[**Download Helmor →**](https://github.com/dohooo/helmor/releases)

macOS (Apple Silicon & Intel) · Windows (x64)

[**Read the docs →**](https://docs.helmor.ai)

On first launch, connect GitHub or GitLab and sign in to your first agent. Agent
CLIs are bundled — nothing else to install.

## CLI

Install from **Settings → Experimental → Command Line Tool**. Works against the
same local database as the app — even while it is running.

```bash
helmor repo add /path/to/repo
helmor workspace new --repo myapp
helmor workspace list
helmor send --workspace myapp/feature-x "Add a test for the parser edge case."
helmor workspace status myapp/feature-x
helmor workspace run-action myapp/feature-x   # create PR, merge, fix CI, …
helmor mcp                                    # MCP server over stdio
```

Workspaces use `repo-name/directory-name` shorthand. Every command supports
`--json`. Run `helmor --help` for the full reference.

**Example — an agent ships a fix:**

```bash
helmor workspace new --repo myapp --name fix-auth
helmor send --workspace myapp/fix-auth "Add tests for the token refresh path."
helmor workspace status myapp/fix-auth
helmor workspace run-action myapp/fix-auth
```

## Contributing

Architecture, commands, and test layout live in **[AGENTS.md](AGENTS.md)**.
To get started locally: `bun install`, then `bun run test` (three suites) or
`bun run dev:ui` for the dashboard.

Or —

Open Helmor, Import Helmor, Ask Helmor:

> _"How do I contribute to Helmor?"_

That's the guide.

## Community

- [Discord](https://discord.gg/ukyyuNfnDp) — questions, feedback, release chat
- [GitHub Issues](https://github.com/dohooo/helmor/issues) — bugs and feature requests
- Or use the feedback button at the bottom of Helmor's sidebar

## License

[Apache 2.0](./LICENSE)

> **⚠️ 已退役，保留为记录——这不是本仓库的功能说明。**
>
> 本目录是**旧 Helmor 桌面应用**（Tauri v2 + Rust + SQLite）的用户指南。Helmor 已于
> 2026-09-21 退役并从工作树删除，见 [ADR-0014](../decisions/0014-legacy-retirement-gate.md)、
> [ADR-0015](../decisions/0015-legacy-retirement-execution.md)、
> [ADR-0016](../decisions/0016-retirement-closeout.md)。
>
> 文中提到的安装包（DMG / NSIS）、`~/helmor/logs/`、**Settings → Accounts**、内嵌终端、
> Monaco 编辑器、workspace / stacked PR 等**在本仓库中都不存在**；安装页的下载链接指向的是
> **上游仓库 `dohooo/helmor`**，不是本仓库的发行物。
>
> **为什么留着**：它是「旧产品对用户承诺了什么」的一手记录，被吸收叙事引用
> （见 [fable-brief/03](../fable-brief/03-deep-state-appendix.md)）。删掉它，这份记录就只剩
> git 历史可查。本仓库当前的功能与用法见根 [README](../../README.md) 与
> [packages/workbench/README](../../packages/workbench/README.md)。

# Helmor User Guide

Helmor is a local-first desktop app for running many coding agents in
parallel, each in its own isolated git workspace — with everything you need to
review, test, and ship their work in one window.

New here? Start with the [Introduction](get-started/introduction.md), then
follow [Your first workspace](get-started/your-first-workspace.md).

## Get Started

| Page | What it covers |
| --- | --- |
| [Introduction](get-started/introduction.md) | What Helmor is, the core ideas, and a tour of the window |
| [Install](get-started/install.md) | Download, first-launch setup, updates, and the CLI |
| [Your first workspace](get-started/your-first-workspace.md) | From adding a repository to merging your first agent-written PR |
| [Configure your project](get-started/configure-your-project.md) | `helmor.json`: setup, run, and archive scripts; repository settings |

## Concepts

| Page | What it covers |
| --- | --- |
| [Workspaces](concepts/workspaces.md) | Git worktrees, workspace modes, lifecycle, archive and restore |
| [Agents & models](concepts/agents-and-models.md) | Claude Code, Codex, Cursor, OpenCode — auth, models, effort, modes |
| [Sessions](concepts/sessions.md) | Session tabs, streaming, steering, queueing, context usage |
| [Parallel agents](concepts/parallel-agents.md) | Running many workspaces at once without losing the thread |
| [Stacked PRs](concepts/stacked-prs.md) | Building dependent changes as a stack of workspaces |

## Reference

| Page | What it covers |
| --- | --- |
| [Composer](reference/composer.md) | Everything the prompt input can do |
| [Review & ship](reference/review-and-ship.md) | The inspector: changes, diffs, git actions, terminals, run scripts |
| [Editor](reference/editor.md) | The built-in Monaco file editor |
| [Settings](reference/settings.md) | Every settings panel, explained |
| [Keyboard shortcuts](reference/keyboard-shortcuts.md) | The full shortcut map |
| [CLI & MCP](reference/cli-and-mcp.md) | Driving Helmor from the terminal or from other agents |

## Security

| Page | What it covers |
| --- | --- |
| [Privacy](security/privacy.md) | What stays local, what leaves your machine, and where data lives |

## Troubleshooting

| Page | What it covers |
| --- | --- |
| [FAQ](troubleshooting/faq.md) | Short answers to common questions |
| [Troubleshooting](troubleshooting/troubleshooting.md) | Logs, auth issues, sync conflicts, and recovery steps |

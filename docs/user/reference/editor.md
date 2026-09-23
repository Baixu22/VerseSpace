> **⚠️ 已退役**：本页是**旧 Helmor 桌面应用**的用户指南（该应用已按 [ADR-0015](../../decisions/0015-legacy-retirement-execution.md) 从工作树删除），**不是本仓库的功能说明**，文中提到的功能在本仓库均不存在。见[本目录说明](../README.md)。

# Editor

Helmor includes a real code editor — Monaco, the engine inside VS Code — so
small fixes don't require leaving the app.

## Opening files

- Click a file in the inspector's **Changes** tree to open its diff, then
  press **⌘E** to switch from diff to edit mode (and back).
- **⌘T** (while the editor is focused) opens a file picker for anything in
  the workspace.

## Working in the editor

- Tabs across the top, one per open file (**⌘W** closes the active one).
- Full syntax highlighting, search, and the editing behavior you expect from
  VS Code's editor component.
- A breadcrumb shows the file's path — click to copy.
- Edits save into the workspace's worktree like any other change, so they show
  up in the Changes tree and in the next commit.

## Diff mode vs. edit mode

| Mode | What you see | Use it for |
| --- | --- | --- |
| **Diff** | Before/after, side-by-side or unified, read-only | Reviewing agent output |
| **Edit** | The live file, editable | Quick fixes, tweaking a line the agent almost got right |

**⌘E** toggles between them.

## Prefer your own editor?

**⌘O** opens the workspace in your external editor of choice (configurable),
and right-click → *Reveal in Finder* gets you to the directory. The worktree
is a plain checkout — any tool can work on it; Helmor picks up external
changes automatically.

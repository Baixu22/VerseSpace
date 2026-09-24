# CLAUDE.md

This repository keeps its agent guidance in **one** place: [`AGENTS.md`](./AGENTS.md). Read that
first — it covers the commands, the three-package architecture, the conventions, and the Windows
host caveats that change what "green" means locally.

@AGENTS.md

---

## Claude Code integration

Two integration points are specific to this repo. Both are optional; neither is required to build
or test.

### 1. Read-only ledger access over MCP

`workbench mcp` speaks MCP on stdio and exposes **five read-only tools** — `premises`,
`footprints`, `resume_cards`, `tribunal`, `notices`. The tools read the ledger and never expose
orchestration actions; responses are truncated to ≤2000 characters each so they cannot eat the
model's context. The working directory needs a `.workbench/` (run `workbench init`).

```jsonc
// .mcp.json at the project root
{
  "mcpServers": {
    "workbench": {
      "command": "bun",
      "args": ["packages/workbench/src/index.ts", "mcp"]
    }
  }
}
```

With the single-file binary installed, use `"command": "workbench"` and `"args": ["mcp"]`. Or
register it at user level:

```bash
claude mcp add workbench -- bun /abs/path/to/packages/workbench/src/index.ts mcp
```

### 2. Footprint capture and the seal hook

```bash
node packages/context-rot/scripts/install-hooks.mjs [repo]   # --uninstall to remove
```

This copies `hooks/footprint.mjs` to `<repo>/.claude/hooks/footprint.mjs`, merges two agent hooks
into `<repo>/.claude/settings.json` (**preserving existing config**), and installs three git hooks
(`post-merge` / `post-checkout` / `post-rewrite`) that register merge/rebase/checkout changes to
the `git` writer. The same `.claude/settings.json` is loaded by Claude Code and by Cursor with
third-party skills enabled, so one config serves both hosts.

`workbench premises seal` is the **PreToolUse** hook built on top of that: it is the one place the
runtime interrupts a writer. It reads a PreToolUse payload on stdin (or `--target`), and exit `2`
blocks the call and feeds the evidence back to the model. Every decision — block, warn and pass
alike — is recorded as a `seal.decided` event. `seal.mode` in `.workbench/workbench.yaml` picks the posture
(`block` | `warn` | `off`); no mode is silent.

---

## A note on this file

Until 2026-09-21 this file was an independent, hand-maintained copy of `AGENTS.md`, and it had
drifted — it still instructed agents to use the Tauri MCP bridge, `cargo clippy` and `cargo insta`
long after the legacy desktop app those tools belonged to was retired. It is now a pointer plus
the Claude-specific extras above. **If you add general repository guidance, add it to
`AGENTS.md`, not here.**

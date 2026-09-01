---
"context-rot": patch
---

首次发布 context-rot：

- **doctor CLI**：一条命令检测 AGENTS.md / CLAUDE.md / .cursorrules 中已失效的代码引用（路径 / 包名 / 符号三类断言），退出码 0/1/2，可直接进 CI。
- **足迹采集 hooks**：`context-rot install-hooks` 一条命令接入 Claude Code / Cursor 双宿主的 PostToolUse hooks，把确定性读写足迹追加到 `.context-rot/footprints.jsonl`。只观测、绝不阻塞。
- 零运行时依赖，Node >= 18。

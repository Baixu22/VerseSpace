# `.agent-contexts/` 归档口径

本目录是每轮 agent 工作留下的**证据与草稿**的存放点。它不是仓库的正式文档区——正式结论写进 `docs/` 与 task-forest 节点 evidence，本目录只保留**可复算材料**与**过程草稿**。

## 什么进版本控制（精选证据）

- 小型、可复算的证据文件：受控试用脚本、探针输入、evidence 快照（如 `tf0190-trial/`）。
- 与 docs / task-forest 节点 evidence 互相引用、需要长期可查的材料。

规则：**只有被 docs 或节点 evidence 引用的材料才提交**；引用方负责说明它是什么。

## 什么留在本机（被 .gitignore 排除）

- 原始日志、探针 dump、live-model E2E 现场（`.workbench` 黑板、临时 git 仓库、agent transcript）。
- 会话草稿目录、提案草稿（已应用的副本在 `.agent-workbench/task-forest/proposals/`）。
- 审计/修复轮的原始 fixtures 与日志（复核后的摘要进 docs/）。

这些内容体积大、属机器状态，不进版本控制；审读后的人类可读结论在 `docs/` 报告与 task-forest 节点 evidence 里。

## 权威口径

- 精确的忽略模式见仓库根 `.gitignore`（搜索 `agent-contexts` 段落）。
- 每个阶段/轮次的运行记录见 `docs/absorption-progress-*.md` 与任务森林节点 evidence。
- 适用原则（2026-09-19 固化为 TF-0220）：**原始数据本地留，精选读数入库**。
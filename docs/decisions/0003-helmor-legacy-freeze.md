# ADR-0003：Helmor 存量处置 = MVP 期间冻结，v0.1.0 后再评估退役

- 状态：已接受
- 日期：2026-08-28

## 背景

VerseSpace 以 Helmor 代码库为起点（无上游 git 历史，冻结基线为首个提交），目标是演进为 Workbench 全新架构。一次性重写或删除存量会让 MVP 不可交付，且丢失行为参考。

## 决策

- MVP 期间 `src/`、`src-tauri/`、`sidecar/` 冻结：不做功能性改动，仅允许必要修复。
- 存量代码作为行为规格长期保留：helmor-cli 的命令组织（args/output 分层、`--json`/`--quiet` 双输出、退出码约定）与 `src-tauri/src/git/ops.rs` 的 worktree 生命周期，分别是 Workbench CLI 层与 Workspot 层的行为参考。
- Workbench 达到 v0.1.0 后，再评估存量的退役/迁移路径并新增 ADR。

## 后果

- 正面：风险可控、随时可回退；两套可对照的行为参考在手。
- 负面：仓库内并存两套架构，CI 必须按路径过滤避免互相无谓触发。

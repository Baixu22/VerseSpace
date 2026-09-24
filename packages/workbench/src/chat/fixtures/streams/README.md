# 流协议夹具来源

这里的 30 个 JSONL 文件来自 Helmor 的 `src-tauri/tests/fixtures/streams/`，
于 2026-09-21 按 ADR-0015 迁入 Workbench；文件内容未改变。
原路径可在提交 `944b9d6` 及更早版本查阅。

Copyright 2026 Caspian Zhao, Nathan Lian。原夹具按 Apache-2.0 保留，
许可及归属见本包的 `LICENSE-APACHE` 与 `NOTICE`。

消费情况：`claude/`（19 个）由 `claude-fixtures.test.ts` 全量回放，
`codex/`（11 个）由 `codex-fixtures.test.ts` 全量回放。

ADR-0015 同批迁入的另外 19 个（cursor 7 / kimi 3 / opencode 9）**没有任何消费者**，
已移出 `src/` 到 `packages/workbench/fixtures/streams/`——原因与去留判断见那里的 README。

这些文件仅用于源码参考与测试，不嵌入发行二进制或 npm 包。

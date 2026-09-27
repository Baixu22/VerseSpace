# 流协议夹具来源

这里的 30 个 JSONL 文件来自 Helmor 的 `src-tauri/tests/fixtures/streams/`，
于 2026-09-21 按 ADR-0015 迁入 Workbench；文件内容未改变。
原路径可在提交 `944b9d6` 及更早版本查阅。

Copyright 2026 Caspian Zhao, Nathan Lian。原夹具按 Apache-2.0 保留，
许可及归属见本包的 `LICENSE-APACHE` 与 `NOTICE`。

消费情况：`claude/`（19 个）由 `claude-fixtures.test.ts` 全量回放，
`codex/`（12 个）由 `codex-fixtures.test.ts` 全量回放。

ADR-0015 同批迁入的另外 19 个（cursor 7 / kimi 3 / opencode 9）**没有任何消费者**，
已移出 `src/` 到 `packages/workbench/fixtures/streams/`——原因与去留判断见那里的 README。

这些文件仅用于源码参考与测试，不嵌入发行二进制或 npm 包。

## 2026-09-27 追加：第 12 个 codex 夹具不是迁入的

`codex/write-turn-0.158.jsonl` 不属于上面那 30 个。它是 2026-09-27 用真实
codex `0.158.0-alpha.2.1`（隔离 `CODEX_HOME`、模型 `glm-5.3-flash`、read-only 沙箱 +
on-request 审批）抓到的**写回合**，按本目录既有口径只把采集机路径换成
`$DUMMY_REPO` / `$CODEX_HOME` 占位符；它只保留 render 决策表已建模的通知形状
（未建模的 6 类由测试单独钉住）。同回合的 5 次真实写审批 params 原样放在
`../approvals/apply-patch-0.158.json`。写侧读数、recipe 与诚实边界见
[`docs/handoff/2026-09-27-codex-write-capture.md`](../../../../../../docs/handoff/2026-09-27-codex-write-capture.md)。

## 2026-09-27 第二次：`fileChange` 夹具，以及它为什么不在 `streams/` 下

同日的 6 变体重复实验否掉了上一条的「写侧结构性缺席」：变体 01/06 发出了原生
`fileChange` item。两条的原始帧沉淀在 `../approvals/file-change-0.158.json`
（`items` = app-server 原始 `{method, params}`，`requests` = 随后的
`item/fileChange/requestApproval`）。它**故意不放在 `codex/` 下**：`fileChange` 在
`codex-render-decision.ts` 的 `ITEM_DECISIONS` 里还没有决策，放进这里会打破本目录
「每个夹具零 undecided」的门禁。关联机制、实现与边界见
[`docs/handoff/2026-09-27-codex-filechange-seal.md`](../../../../../../docs/handoff/2026-09-27-codex-filechange-seal.md)
与 ADR-0017 的第二次 2026-09-27 补记。

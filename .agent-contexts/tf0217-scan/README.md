# TF-0217 残留代码扫描报告（2026-09-19）

## 结论

1. **L3（TF-0099/0100/0101）残留已清除**：唯一的残留是 `packages/workbench/src/chat/resume-card/index.ts` 的 `buildResumeCard` 输入 `promotionReverted`（R7「已撤销」注释分支）——它只有测试 `resume-card.test.ts` 设置、没有任何生产调用方（对应废弃节点 evidence 的「promotion_reverted 无任何生产者定义」）。已连同 R7 测试一并删除。
2. **旧 merge-back stub 已不存在**：`thread.merged_back` 只剩 `blackboard/events.test.ts` 的回归测试（断言该类型被正确拒绝），这是正确的防回归行为，不是残留。
3. **主线未引用导出（ts-prune 扫描）**：
   - 工具：`bunx ts-prune --project tsconfig.json`（packages/workbench），原始输出见 `workbench-ts-prune.txt`。
   - 扫描命中多数为 **`(used in module)`**（仅模块内部使用的导出符号）或**有意保留的公共 API**（如 `TribunalFolded`/`TribunalItemState` 是 issue #4 契约面预留导出；`DEFAULT_NOTICE_TOKEN_BUDGET`、`FLOOD_LIMIT` 等是 re-export）。这类不是「可删除的死代码」。
   - 真正无任何引用的死导出：**`mcp/protocol.ts` 的 `JsonRpcNotification`**（从未被引用，通知在 server.ts 里按无 id 的 `JsonRpcRequest` 处理）——已删除。
   - 附带修复：`mcp/protocol.ts` 里 `JsonRpcRequest` 的 `id?` 已足以表达通知（无 id 即通知），协议注释已澄清。

## 门禁

- workbench 全量 **858 pass / 0 fail**（128 文件；较 859 少 1 条 = 被删的 R7 测试）
- `bun run typecheck`（workbench 包）exit 0
- resume-card / resume / events / mcp 相关测试 55 pass / 0 fail
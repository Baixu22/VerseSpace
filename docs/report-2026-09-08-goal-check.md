# 阶段 D：WRITE 目标达成即收尾（goalCheck）修复并验证（2026-09-08）

TF-0135 / TF-0155 本轮针对 live-agent「6 次工具循环上限」的复发失败（taQpyN 现场）做最小 patch，并在 step-3.7-flash 上验证 S1-S6b 全通过；S6c 撞到了与 patch 无关的模型输出契约问题。

## 失败现场复核

taQpyN（cohere/north-mini-code:free，第二账号）：S6 分叉子线程 b06cd1b0 连续 6 次 finishReason=tool_calls 后硬停。alpha.ts 实际已是 `v4 on branch`（S6 目标文件状态达成），但 live-agent 只认"模型最后一轮不调工具"作为回合收尾信号。提示词与磁盘一致性无 bug，是模型在简单 WRITE 指令下持续自我验证的行为边界。

## Patch：WRITE 目标达成即收尾

新增 `packages/workbench/scripts/e2e/live-agent-goals.ts`（57 行）：
- `goalFromUserText(text)`：从 user 文本中解析 `WRITE src/…\n<expected>\n__END_WRITE__` 指令，返回 `{path, expected}`，否则返回 null。
- `goalMet(root, goal)`：用与 `executeLiveTool` 相同的 src/ 相对路径规则读文件对比字节；文件不存在/读取失败返回 false 而不是 throw，让循环保持运行直到自然收尾。

修改 `packages/workbench/scripts/e2e/live-agent.ts`：
- 新增 `turnGoal` 局部变量，每个 user 消息回合开头解析一次。
- Write 工具调用返回成功后立即检查 `goalMet`；达成则置 `finished = true` 并同时跳出 tool_call 内层循环与 hop 外层循环。
- 不加延时、不修改系统 prompt、不改调用方：非 WRITE 指令回合（development、复核、conversation）走原路径，行为完全不变。

新增 `live-agent-goals.test.ts` 4 个用例：
- 解析正常 WRITE 指令（含路径与期望内容）
- 拒绝非 src/ 路径与无 WRITE 指令的文本
- goalMet 三种状态（缺文件 / 内容不等 / 字节级相等）
- 多行 WRITE 内容保留换行对比

## 验证

- `cd packages/workbench && bun x tsc --noEmit` 通过。
- `bun test --timeout 60000` → **610 pass / 0 fail**（98 文件、2332 断言、97.90 秒），含新增 4 个 goal 用例。

## 真实现场

| 现场 | 模型/渠道 | 走到 | 卡点 | 结论 |
| --- | --- | --- | --- | --- |
| `pMO7YD` | cohere/north-mini-code:free（第二账号） | S1 | HTTP 429（当日额度耗尽） | patch 与现场无关 |
| `uDo27W` | step-3.7-flash（hcnsec 代理） | S6c | 模型在 S6c 路分叉提示下返回 finish=stop 且空 content | patch 无关，模型输出契约边界 |

`uDo27W` 是 patch 之后的现场：S6 子线程 ec505ee7 只用 5 次调用就收尾（之前 cohere 用了 6 次撞上限），alpha.ts 正确写入 `v4 on branch`；证明 patch 在 WRITE 指令回合能识别磁盘目标达成并提前结束循环。

完整快照：uDo27W SHA256 `a78d555cdb6327335ad63c9e1bd8780ea53d6fde02bff7e6bddff489620b8e39`；taQpyN SHA256 `2fe1c64ac7e180e254845f0f7ad81c04d30455ec3ff37177d55faab842755b0e`。

## 候选

候选 `TFP-2026-09-08-goal-check` 为 TF-0135 与 TF-0155 追加 patch 证据并更新接力提示；不改状态、进度、依赖或验收门槛。

## 接力

- step-3.7-flash 是当前唯一在 50 秒预算内走完 S1-S6b 的模型（S6 用了 patch 的目标路径提前收尾，节省了至少一轮工具循环）。
- cohere 第二账号当日晚些重置后可再复跑，配合 patch 预期能把 S6 从"撞循环上限"变成"磁盘达成即收"。
- S6c 三路家族折叠 + step-3.7-flash 的空 finish=stop 是新观察到的模型行为边界；下轮可重跑同模型看是否复现，或在 scenario 的 S6c prompt 里强化"必须有正文或 tool_calls"的输出要求（改动 scenario 是另一条接力线）。

# 阶段 D：live 租户累积把三项工程判决和护城河四门跑齐（2026-09-08）

senseaudio-s2-flash 不再只跑一次性隔离现场。本轮把 `scripts/e2e/run.ts` 接上 `--live`，在持久黑板 `workbench-e2e-live-tenant` 上累积 12 轮（8 成功 / 4 失败），再对同一黑板补 live-development + live-fork。结果：**判决一恢复卡、判决二前提检测、判决三阶段 C 均为 supported；护城河 A/B/C/D 全 present，benchmark 闸门开。判决四 L3 仍 insufficient-evidence**——`verdicts.ts` 要求 `--evidence-kind natural` 且观察跨度 ≥ 14 天，live-model 脚本不能也不该把 L3 推过门。

账本：[fit-ledger-2026-09-08-live-tenant.md](./fit-ledger-2026-09-08-live-tenant.md)。快照：[`.agent-contexts/live-tenant-2026-09-08/evidence.json`](../.agent-contexts/live-tenant-2026-09-08/evidence.json)。

## 脚本改动（为了能累积，而不是改门槛）

1. **`run.ts --live`**：同一持久工作区反复跑 22 步集成；agent 切到 `live-agent.ts`，账本 `--evidence-kind live-model`。无密钥时闭门失败（`run-live-flag.test.ts`）。
2. **授权标记白名单**（`live-auth.ts`）：`isolated-live-model-fixture` 与 `tenant-live-model-accumulation` 都合法。第一轮 8/8 全挂，就是租户标记被 live-agent 拒掉。
3. **READSPAN 强制进足迹**（`live-agent-goals.ts` `applyReadSpan`）：模型常把 `READSPAN src/notes.md 1 3` 做成全文 Read，S5 就把 span 外追加误报成失效前提。执行器按用户指令给 Read 补 `offset/limit`，与 fake-agent 对齐。
4. **HTTP 500 纳入有界重试**：senseaudio 偶发 500，原先只重试 408/429/502/503/504。

`tsc --noEmit` 通过；相关 live 测试 16 pass / 0 fail。

## 租户黑板读数（development + fork 之后）

| 项 | 值 |
| --- | --- |
| t0 | 49 线程 / 51 写者 |
| 样本窗 | restores 28/3、noticeOutcomes 64/5、sealDecisions 15/3，satisfied |
| 恢复卡 | consumed/restores = 0.429 ≥ 0.3，resumeActions = 23 |
| 前提检测 | delivered 29，dismissed=0，ignored=0，unknown=0 |
| 阶段 C | forks=24，真实继承（context ∧ premise）= 3 |
| L3 | observation.days ≈ 0.009，kind=live-model → insufficient-evidence |
| 护城河 | A=64、B=1、C=13、D=0.123，闸门开 |

12 轮里失败 4 次：早期授权错误已修；之后是渠道 HTTP 500 与 S7b 一次 JSON 解析失败。成功轮次足够把 A 从 38 推过 50，并把阶段 C 的继承观测从 0 推到 3。

## 明确不能打破的阻塞

- **TF-0099 / TF-0100 / TF-0101 继续 blocked。** L3 的代码路径把 `scripted` 和 `live-model` 一律判 insufficient-evidence。这是纪律，不是漏跑。
- **恢复卡 supported 不等于人类认可。** 账本 action 原文：工程场景中的消费不等于自然用户认可或耗时改善。
- **跨现场仍然不能拼接。** 本账本只引用这一块 live-tenant 黑板。

## 接力

1. 日常工程采样走 `bun scripts/e2e/run.ts --live --rounds N --workspace <tenant>`，不要再开一次性隔离现场凑护城河。
2. L3 只在有真实日用、能诚实声明 `--evidence-kind natural`、且跨度满 14 天时复评。在那之前不要开工衍生产物。
3. S7b 的偶发 `SyntaxError: Failed to parse JSON` 仍是渠道噪声；500 已重试，这条解析失败还没做成有界重试。

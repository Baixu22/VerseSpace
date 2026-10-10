# 前提通知管线 · 真实流量读数（2026-10-10）

本读数沉积的是"读侧建议式并发"管线在**一次真实账本**上的实际触发计数，作为
`benchmark-premises.ts` 合成契约基准的**正收益补充**：前者证明检测器契约，本读数证明
管线在真实并发使用中确实跑起来、且投递带真实读集可观测性。

## 仪器

`scripts/verify/measure-premise-notices.ts` —— 只读 `.workbench/events/events.jsonl` 与
各线程 `notices.jsonl`，统计事件类型计数与交付可观测性，不写任何状态、不证明正确性结论。

可对任意真实账本重跑：`bun scripts/verify/measure-premise-notices.ts --json --ledger <dir>`。

## 读数（本地 `.workbench/`，2026-08-30 → 2026-09-29 捕获）

| 维度 | 值 |
| --- | --- |
| events.jsonl 总行数 | 5063 |
| `premise_stale`（被检测到的失效前提） | 128 |
| `premise_notice_queued`（已排队通知） | 80 |
| `premise_notice_delivered`（已投递） | 14 |
| `premise_notice_outcome`（投递后结果） | 128 |
| 交付 `readObservability=footprint`（带真实读集） | 14 |
| 线程失效通知（含 observed→current 版本 diff） | 45 |
| 收到失效通知的线程数 | 20 |

## 这说明什么 / 不说明什么

- **说明**：在真实多写者使用里，读侧失效检测与建议式通知链路确实在跑——128 次失效被
  检出、80 次进入通知队列、14 次带 `footprint` 读集可观测性完成投递；聊天线程侧有 45 条
  带版本 diff 的失效通知落到 20 个真实线程。这与 ADR-0006/0010 的设计意图一致，是
  **真实流量证据**而非合成断言。
- **不说明**：不证明"通知被正确修补"（outcome 全部是 `queued`，本仪器不读修补结果）；
  不代表真实用户精度、LLM 修补效果或总体加速；样本是单一本地账本，非多用户统计。
- 这与 `claim-codex-write-unsealed` 的诚实边界一致：**只沉可复现、可归因的数字**，
  不把"管线在跑"包装成"并发更安全"。

## 门禁状态

登记于 `evidence/claims.json` 的 `claim-premise-notice-realtraffic`，类 `L1`。
`evidence/claims.json` 自身是被大量声明引用的 `subject_path`，因此本读数在其登记提交
之后若再次改动注册表会被标 `stale-subject` —— 这是门禁的预期行为，重新 `--run` 登记即可。

# 阶段 D：senseaudio-s2-flash 全链路 43/43 响应全成功 + schema 补丁落位（2026-09-08）

`senseaudio-s2-flash`（OpenAI 兼容代理，base `https://api.senseaudio.cn/v1`，vllm-0.26.0 后端）首次走通 live E2E 完整链路：**22/22 集成 + development 12/12（首轮 11/12→末轮 12/12）+ fork 三路分支模型复核 verdict 全 pass**。43 次请求尝试**全部 response，0 次 empty-stop / http-error / invalid-response / length 截断**。SHA256：`e6de6c00`（live-report）、`6e83a9b8`（live-integration）、`23d0cd02`（live-development）、`f6b4759a`（live-validation）。证据快照 [`.agent-contexts/senseaudio-2026-09-08/`](../.agent-contexts/senseaudio-2026-09-08/)，账本 [fit-ledger-2026-09-08-senseaudio.md](./fit-ledger-2026-09-08-senseaudio.md)。

## 本轮发现并落位的渠道差异补丁

senseaudio 在 `tool_calls` 回合**省略 `message.content` 字段本身**，而不是像 OpenRouter 那样发 `"content": null`。`live-provider.ts` 的 zod schema 只接受 `string | null`，遇 undefined 抛 `invalid-response`，第一轮 14:59Z 在 S6c 三路分叉 branch-1 motif 读取回合命中。

补丁（`packages/workbench/scripts/e2e/live-provider.ts`）：

```ts
const replySchemaRaw = z.object({
    role: z.literal("assistant"),
    // Some OpenAI-compatible proxies (e.g. senseaudio vllm) omit `content`
    // entirely on tool_calls turns instead of emitting null. Treat missing as null
    // so downstream history persistence stays within LiveMessage shape.
    content: z.string().nullable().optional(),
    tool_calls: [...],
});
const replySchema = replySchemaRaw.transform((m) => ({
    ...m,
    content: m.content ?? null,
}));
```

设计原则与 empty-stop 补丁一致：**宽容 OpenAI 兼容代理的兼容性差**，schema 收敛为一条规则（缺省 = null），让下游 LiveMessage history 持久化继续满足类型断言；不改变 OpenRouter 那条路的形状判定。

新增一个回归测试（`scripts/e2e/live-provider.test.ts` 的第 6 个用例）：

- `tool_calls turns that omit content entirely are normalized to null content`：模拟 senseaudio 应答（无 `content` 字段，含 `tool_calls`），期望 schema 接受、且 `reply.content === null`。

## 复跑复核（第二轮 15:14-15:32Z）

| 阶段 | 结果 |
| --- | --- |
| S0-S6b 集成 | ✓ 22 步全过 |
| S6c 三路家族折叠 | ✓ 过 |
| S7 封印 + S7b 复读 + S8 兴趣 + S8b 地标 + S9 保留 + S10 stats + S11 fit | ✓ 全过 |
| 读取旧实现建立前提 | ✓ |
| 模型自主修复 endpoint 兼容问题 | ✓ |
| 独立验收驱动多轮纠正 | ✓ （首轮 11/12 因 tail curly quote 未过 → 模型自查第二轮 12/12） |
| fork 分支 1（完整 endpoint + 重复斜杠） | ✓ verdict=pass（3 findings） |
| fork 分支 2（反代前缀 + query + fragment） | ✓ verdict=pass（3 findings） |
| fork 分支 3（非法 URL + scheme + 嵌入凭据） | ✓ verdict=pass（3 findings） |
| 模型响应 / 请求尝试 | **43 / 43** |

## 样本窗与 stats（cSJhox 黑板，两层）

S11 在 22 步集成结束时拍官方快照；development + fork 之后同一黑板继续累加。跨现场不能拼接，同现场可以。

| 层 | t0 | restores | noticeOutcomes | sealDecisions | 窗口 |
| --- | --- | --- | --- | --- | --- |
| S11 集成结束 | 4 线程 / 6 写者 | 2/3 | 6/5 | 1/3 | 未齐（缺 restores、seal） |
| development + fork 之后 | 9 线程 / 11 写者 | 7/3 | 8/5 | 6/3 | satisfied |

- **stats（S11 / live-report）**：noticeOutcomeRows=6、restores=2、sealDecisions=1、sealBlocked=1、sealReviewsCorrect=1、overlaps=14、notified=6。
- **finishReason 分布**：tool_calls=26、stop=17、length=0、empty=0。
- **attempts outcome**：43 response / 0 empty-stop / 0 http-error / 0 invalid-response。
- **护城河（post-fork 账本）**：A=8/50 校准表行；B=1 premise_stale（git 删除后对已读人）✓；C=4 seal block + 复核正确 ✓；D=0.304 notifiedRatio（30.4%，刚越出 10–30% 区间，present=false）。

fit 账本 live-model source 下四判决（post-fork）：
- 判决一 `resume-card`：**not-supported**（保留现状，需更多自然使用）。
- 判决二 `premise-detection`：**supported**（noticeOutcomes.agent.delivered=4 达阈值）。
- 判决三 `stage-c`：**supported**（forks.total=5/5、真实继承观测 ≥ 1）。
- 判决四 `l3`：**insufficient-evidence**（保留 TF-0099..TF-0101 阻塞）。

## 观测到的新边界

1. **senseaudio 的空 stop 倾向比 OpenRouter step-3.7-flash 低**：上轮 QHLCDW 在 22 步集成里就撞 1 次空 stop（在 S6c），本轮全程 0 次 empty-stop。空 stop 重试补丁仍然必要，但该渠道没触发。**上游渠道行为差异是稳定的工程信号，不是噪声**。
2. **development 独立验收首轮 11/12**：`尾部弯引号` 用例失败（`https://openrouter.ai/api/v1/chat/completions”` 被错误处理为 `...%E2%80%9D/chat/completions`）。模型第二轮自查通过 12/12。这是**真实自纠错能力**：不靠 executor 提示，模型在复核阶段主动发现并修复。此类偶发 unicode 边界条件在 base-url requirements.txt 里也许该单列（与上轮 full-chain 接力建议一致），但本轮模型已在第二轮自我修复。
3. **D 护城河 notifiedRatio 30.4% 距上限 30% 一步之遥**：可能跟 fork 分支注入多轮复核 prompt、或 senseaudio 在长 prompt 下的 notified 倾向有关。不是回归，只是本轮未落在 [10%,30%) 区间。

## 接力

1. 该渠道可作为长期主力跑 live E2E：比 step-3.7-flash 更稳（0 empty-stop）、不比它慢（8 会话 43 次请求总耗时约 18 分钟，含人工 / git / 封印等措施）。
2. 若想继续压榨稳定性，可给 `live-agent.ts` 的 system prompt 把"输出契约：每个回合必须返回正文或 tool_calls"改为"每个回合必须返回正文或 tool_calls，**tool_calls 回合请明确给 `content` 字段为 null**"——但这又为一条渠道差异写死 prompt 规则，**不推荐**，README 级注记已够。
3. 长期：把 senseaudio 的 vllm system_fingerprint（`vllm-0.26.0-tp2-238f92b1`）记到 OpenAI 兼容代理兼容矩阵里，或加进 `docs/run-live.md`（如存在），供后续选择渠道时对照。

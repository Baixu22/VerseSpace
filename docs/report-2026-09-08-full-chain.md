# 阶段 D：完整真实诺真链 22/22 + development 12/12 + fork 三路全过（2026-09-08）

step-3.7-flash（hcnsec 渠道）本轮 **pyHJXU 现场 47 次响应全成功**，首次跑通完整链路：22/22 集成、development 12/12 独立验收、live-fork 三路分支模型复核 verdict 全 pass、源线程串扰检查过。SHA256：`1679f4f5ac3d6f235e3372da0609fd61f4b8af1c5adef57d0a8262ff7e648dec`。

## 本轮两个新补丁

1. **`live-provider.ts` `max_tokens` 2048 → 4096**。此前 step-3.7-flash 在 development writer 的「按需求修复+解释设计」回合连 4096 token 都不够（ypgXZe、hmNqfE 撞 length 意外 response，QHLCDW fork revisit 撞 length），上限过低会让模型把「读懂需求 + 写完整修复 + 解释」分不完，导致活一次成功、死一次 stop/length。
2. **`live-development.ts` 纠正 prompt 改为要求「最小定点修改」**。原文「重新读取需求与实现」会让模型返回完整新版本与设计文档，撞 max_tokens 上限；改为「先用 Read + 只修最小必要处 + Write 保存 + 一句话说明」。

两补丁逻辑：抬高上限改物理边界，改 prompt 也压 token 用量。两者结合，第一次把「12/12 独立验收」「一次失败 → 纠正 → 通过」真实闭环拿到了模型侧完成证据。

## pyHJXU 现场数据（live 模型账本）

- **22/22 集成**：S1-S11 全过（集成步骤数组 steps[].ok 全 true）
- **development 12/12**：第一轮 11/12（唯一失败：尾部弯引号 `"` 未在 `「」『』` 清单之外补 `“ ”`）；第二轮经「最小定点修改」prompt 纠正后 12/12 pass、0 failures。两轮独立验收落盘 `runs/live-validation.json`。
- **modelReview verdict=pass**：7 findings 复核通过；**读者旧前提失效 → 恢复 → 复读 → 复核** 完整链条走通。
- **live-fork 三路持久分叉**：
  - branch-1.review.json verdict=pass（5 findings，完整 endpoint / 重复斜杠）
  - branch-2.review.json verdict=pass（4 findings，反向代理前缀 / query / fragment）
  - branch-3.review.json verdict=pass（4 findings，非法 URL / scheme / 凭据）
  - `sourceTranscriptUnchanged: true`（兄弟线程 messages 与源线程字节级一致）
  - `inheritance: provider-history-and-premise`
- **calls=47, attempts=47**：47/47 全成功。copies、HTTP 状态、finish_reason 与 tokenizer 用量全程记录。
- **样本窗**（fit-ledger 对租户黑板）：restores 2/3、校准 6/5、封印 1/3；t0 已启动 4 线程 6 写者。
- **stats**：restores=2、sealDecisions=1、sealBlocked=1、sealReviewsCorrect=1、noticeOutcomeRows=6、overlaps=13、notified=6、restoreToMessage 中位 2731ms（恢复卡）、8ms（无卡）、exceeds20Percent=true。

## 回归与复核

- `cd packages/workbench && bun x tsc --noEmit` 通过。
- `bun test --timeout 60000` → **612 pass / 0 fail**（98 文件、2336 断言、91.98s），包含此前补的 goalCheck（live-agent-goals.test.ts）、CONTRACT_SUFFIX（family-notice.test.ts）、empty-stop retry（live-provider.test.ts 2 例）。
- `bun x biome check` 3 个变更文件均通过。

## 接力

1. **关键边界已标记**:hcnsec 代理渠道为 step-3.7-flash 单次请求提供 max_tokens=4096 预算已足够 development 普通回合；若改回 2048 会重新不可靠。同时「最小定点修改」提示词具象化了「不要重写整个文件不要设计文档」的边界，后续加 development case 或更复杂的代码任务时应沿用这一方向。
2. **样本窗仍然不充分**：restores 2/3 与 sealDecisions 1/3 需要同一现场下更多的自然模型活动才能达标。当前 ok=true 是链路性胜利，但样本门槛需要更多现场跑次并积累。
3. **后续可加跑**：同一 prompt 再跑一次，看 sampleWindow 是否积累到 restores 3、sealDecisions 3+（尽管跨现场不能合并，但看本现场是否能在同黑板下积累通过阈值）。也可用 step-3.7-flash 以外的模型（如 Qwen3.8-27B、DeepSeek-V4-Flash）试。

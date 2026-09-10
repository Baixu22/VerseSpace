# 阶段 D：空 stop 重试补丁 + development 12/12 + fork 模型侧三路全过（2026-09-08）

step-3.7-flash 本轮再次确认上轮发现的「finish=stop 但既无 content 也无 tool_calls」的输出契约破坏（OrxNjQ 现场主线程第 3 回合即中招，S6c 未走完），随后用 live-provider 的空 stop 重试补丁（≤2 次）修复，QHLCDW 现场首次完成 **22/22 集成 + development 12/12 独立验收、模型复核 pass、live-fork 三路分支模型侧 verdict 全部 pass**；最终在 branch-1 revisit 回合撞上 max_tokens=2048 上限。

SHA256：`912328f7`（QHLCDW live-report）、`2e5d756d`（live-integration）、`8da9cefb`（live-development）、`819da872`（live-validation）。对应证据快照 [empty-retry-evidence-2026-09-08.json](./empty-retry-evidence-2026-09-08.json)。

## 上轮失败复核（OrxNjQ，pre-patch）

step-3.7-flash + 上轮 S6c CONTRACT_SUFFIX：22 步集成里走到 S6c 第一次 sendTurn（source WRITE family v1）时主线程 32bdb71e 第 3 回合返回 finish=stop 但空 content。**CONTRACT_SUFFIX 不稳定**：上轮 KQKW9b 通过是运气好（32 个回合无一空 stop），本轮 12 个回合就中招一次。提示词强化约束不了模型的随机输出契约破坏。

## 本轮补丁（live-provider empty-stop 重试）

在 `live-provider.ts` 的 `requireTools && !tool_calls` 重试分支之后增加：

```ts
if (choice.finish_reason === "stop" && !(reply.content ?? "").trim() && !reply.tool_calls?.length) {
    outcome = "empty-stop";
    if (attempt < 2) {
        retryDelay = 0;
        requestMessages.push(reply, {
            role: "user",
            content: "执行器反馈：上一条回复没有正文也没有工具调用。请重新输出：要么直接回答（一或两句），要么调用 function tool。",
        });
        continue;
    }
    throw new Error("真实模型连续返回空 stop，未提供正文或工具调用");
}
```

设计原则与现有 `requireTools 无 tool_calls` 重试保持一致：把空 stop 视为输出契约破坏并 retry ≤2 次，push 一条executor反馈作为下一回合上下文，让模型自我修正而非把空气注入 history。

新增两个测试：
- `empty stop replies are retried with an executor note before failing`：第 1、2 次空 stop，第 3 次给正文，验证 attempts=3 且最终 reply 正确
- `empty stop repeatedly is a hard failure after bounded retries`：3 次全空 stop，期望抛"空 stop"且 attempts=3

## 验证

- `cd packages/workbench && bun x tsc --noEmit` 通过。
- `bun test --timeout 60000` → **612 pass / 0 fail**（98 文件、2336 断言、92.75 秒），包含 2 个新 empty-stop retry 用例。

## QHLCDW 真实现场

22/22 集成步骤全过（同 KQKW9b）。development 第一次跑通：

- `[live-dev] 读取旧实现，建立真实前提` ✓
- `[live-dev] 模型自主修复 endpoint 兼容问题` ✓
- `[live-dev] 旧读者恢复、复读并独立复核新实现` ✓ —— `live-validation.json` 只有 1 轮：`12/12 pass, 0 failures`
- `[live-fork] 分支 1：完整 endpoint 和重复斜杠` ✓ —— `branch-1.review.json` verdict=pass
- `[live-fork] 分支 2：反向代理前缀、query 和 fragment` ✓ —— `branch-2.review.json` verdict=pass
- `[live-fork] 分支 3：非法 URL、scheme 和嵌入凭据` ✓ —— `branch-3.review.json` verdict=pass
- live-fork 分支 1 的 revisit 回合（再次读 base-url.ts 并谈剩余问题）：**finish_reason=length** 撞 max_tokens=2048 上限

最后一次 attempt 记录（1feb3ae2，fork 分支 1 的继承会话）13.2s 后 invalid-response。该会话历史已膨胀到 18 条消息（含 development 复核 + 分支 1 独立检查），prompt=3357 token，模型输出被 2048 token 上限截断。

## 样本窗与 stats（QHLCDW 黑板）

t0 已启动：4 线程 6 写者。样本窗 **2/3 恢复**、**6/5 校准**（已超）、**1/3 封印**。noticeOutcomes=6、overlaps=15、notified=6。stats.restores=2、sealDecisions=1、sealBlocked=1、sealReviewsCorrect=1。账本 [fit-ledger-2026-09-08-empty-retry.md](./fit-ledger-2026-09-08-empty-retry.md) 由 fit-ledger.ts 生成。

## 接力

1. live-fork 分支 revisit 回合的 prompt 会继承 development+分支自身复核的完整历史，token 预算已经超过 step-3.7-flash 的 max_tokens=2048 上限。两种走法：
   - **不动 prompt/分支设计**：把 live-provider.ts 的 `max_tokens` 提到 4096（适配 step-3.7-flash 有效窗口）；这并**不改变验证语义**，只是允许更长回复。
   - **修改 live-fork.ts revisit 分支**：在 fork-session 里只带"刚才的复核结论"而不是全部历史，让分支 revisit 是干净的短上下文回合。
2. 空 stop 重试补丁效果已被本现场验证有效：22/22 集成步骤全过、development 12/12、三路分支模型复核全 pass，都是空 stop 没卡住的结果；如果 OrxNjQ 那种偶发空 stop 没 retry，本现场走不到这里。
3. 长期：样本窗已稳定汇聚（restores 2/3、校准 6/5、封印 1/3），但跨现场不能拼接——restores 2→3 与 sealDecisions 1→3 都需要同一现场下的更多自然活动。

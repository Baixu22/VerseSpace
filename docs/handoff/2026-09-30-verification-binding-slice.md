# 验证时效性切片：checkpoint 验证绑定（2026-09-30）

> 同日后续：本记录保留首版实现与当时读数。删除/未跟踪目录/特殊路径漏检、验证期间变化及新采集失败的处理，已由[后续修复记录](2026-09-30-verification-binding-hardening.md)接续；下文的 best-effort 放行描述不再适用于新验证。

本轮在短板/护城河调查（[2026-09-30-product-gaps-and-moat.md](2026-09-30-product-gaps-and-moat.md)）
之后，落实其第 8 节「阶段一」的第一条：**验证证据绑定到实际代码状态**。这是
「可重验交接包」方向的第一个纵向切片，只动 checkpoint 生命周期链路，不动聊天、
seal、投递与 provider 通道。

基线 `68ebef5` 加本轮全部未提交改动（含上一轮 #45–#48 修复）。本轮未提交、未推送、
未发布；未改任务森林；未调用编码模型。

## 动机（来自本机实测，不是假设）

同日探针（[moat-probes](2026-09-30-moat-probes.ts) 第 5 组）复现：隔离工作区里
检查子进程第一次通过；随后把被测文件改坏，继续 `runOnce` 两轮，checkpoint 仍
`applied`、归档结果仍 `passed`、目标仍 `done`；而用同一命令重跑检查是 `failed`。
即：**「验证通过」被当成永久事实，之后代码再变也不会重新确认。**

## 实现

| 站点 | 变更 |
| --- | --- |
| `types/checkpoint.ts` | 新增 `verificationBinding`（HEAD + 改动文件 hash）、`verificationInvalidatedAt/Reason`；全部可选，旧 checkpoint 解析不受影响 |
| `runtime/verification-binding.ts`（新） | 采集绑定、比较谓词（`checkVerificationBinding`）、工作区路径解析、退回重验（`invalidateVerification`）；比较逻辑可用注入 `GitRunner` 在无 git 子进程宿主复算 |
| `runtime/verify-checkpoint.ts` | 验证 `passed` 时采集并写入绑定 |
| `runtime/apply.ts` | `verified → applied` 之前重新比较；过期则退回 `staging` 而不是应用 |
| `runtime/review.ts` | 人工审查通过同样绑定批准时的代码状态 |

判定规则：无绑定 → `unbound`（保持旧行为，不阻塞）；工作区当前不可读 → 过期；
HEAD 变化 → 过期；绑定时的改动文件内容变化或已删除 → 过期；验证后新增未覆盖的
改动 → 过期。只判「证据是否仍指向同一状态」，不判语义相关性——保守方向是重验。

三个设计决定：

1. **排除账本自身写入。** 首次测试立刻暴露：runtime 每轮都会写 `.workbench/`
   （锁、事件、spool），若计入则每个 checkpoint 下一轮必然过期。绑定比较忽略
   worktree 内的 workbench 状态目录（`workbenchPrefixIn`）。
2. **best-effort 采集。** 工作区不可读（非 Git、workspot 缺失）时不编造绑定，
   照旧推进——不用一个新失败换掉旧静默；但绑定存在而当前不可读时判过期，不静默
   当 intact。
3. **失效读数保留为历史。** 退回重验写 `verification_invalidated` 事件与两个
   `verificationInvalidated*` 字段；重验通过后刷新绑定但不清除失效记录。

退回的 checkpoint 落回 staging/draft，下一轮 automaton 自动 `request_verification`
重跑同一检查命令；目标不会完成，因为没有 `applied`。旧 checkpoint（无绑定）行为
与本改动前完全一致。

## 实测读数

| 命令 | 读数 |
| --- | --- |
| `bun test src/runtime/verification-binding.test.ts` | exit 0，10 pass / 0 fail（7 条注入式谓词 + 3 条端到端） |
| `bun run typecheck` | exit 0，三个包 |
| `bun run test:workbench` | exit 0，**1044 pass / 0 fail**，34 snapshots（本改动前基线 1034 pass；+10 为本轮新用例） |
| `bun run lint` | exit 0，665 files（首轮 4 条格式化/导入序错误已 `lint:fix`，复跑干净） |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言，0 失效 |
| `bun run check:upload-surface` | exit 0，842 个文件、违规 0、518 条相对链接断链 0（含本记录与调查报告） |

端到端用例覆盖三条路径：

1. 验证通过且代码未变 → 正常 applied → done（回归保护，证明没把正常链路堵死）；
2. 验证后改动被测文件 → 退回 staging/draft、写 1 条 `verification_invalidated`、
   通知措辞含「验证已过期」、目标停在 `in_progress`；下一轮重跑检查（此时真的失败）
   进入 `failed` 区；
3. 退回后修复代码 → 第二轮验证通过并重新绑定，最终 done，且旧失效读数保留。

## 明确没做的

- **没有**改「送达 vs 待重验」、多段读取折叠、跨文件影响等本报告的其余短板；
  它们各自需要独立设计与验收（报告 §8 阶段二/三）。
- **没有**声称语义级验证等价：同内容不同顺序、同时长的 ABA、生成物/环境输入
  都不在比较范围；命令身份与作用范围（跑了多少用例）仍由声明与输出决定。
- **没有**重录声明账本读数。`check:claims` 仍报 13 条 stale：其失效判定按
  **工作区**计算（`git diff <subject_sha>` 含未提交改动），本工作区尚未提交，
  重录读数无法变为有效。这与上一轮 #45–#48 的状态相同，等落库后按
  `record-reading.mjs --run` 重取。**不把重录用作让门禁变绿的手段。**
- **没有**跑全仓三套测试的另外两套、浏览器 E2E、构建与真实模型；上表只列实际执行。
- 旧行为探针（`2026-09-30-moat-probes.ts` 第 5 组）现在会断言失败——这正是预期：
  它记录的是修复前行为。按调查报告 §10.2 约定保留旧记录，本记录作为新验收。

## 复核命令

```bash
NO_PROXY="127.0.0.1,localhost,::1" bun test ./packages/workbench/src/runtime/verification-binding.test.ts --timeout 60000
bun run typecheck && bun run lint
NO_PROXY="127.0.0.1,localhost,::1" bun run test:workbench
bun packages/workbench/src/index.ts doctor
bun run check:upload-surface
```

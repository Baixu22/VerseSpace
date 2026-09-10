# 接力：L1 认可率加来源门，S7b 解析噪声收口，两个定位风险核验（2026-09-10）

本轮没有新的模型样本：本机没有 `E2E_LLM_*` 环境变量，也没有 `%LOCALAPPDATA%/HelmorWorkbench/credentials/openrouter.dpapi`，Claude CLI 处于未登录状态。所有数字都来自已有的 live 租户黑板 `workbench-e2e-live-tenant`（events.jsonl 1255 行，sha256 前缀 `bcb53b29c5b81af5`）和单元测试。

## 一、账本纠偏：L1 认可率不能由脚本手势推动

2026-09-09 的 landmark-coverage 会话把 `stats.landmarkReviews.current.endorsedShare` 从 0.152 推到 0.75，并把「L1 由 weak 升 partial，距 aligned 仅 5pp，剩下的推升路径是多轮 endorse 叠加」写进了 TF-0135 / TF-0136 / TF-0137 的 next_action。

这个读数没有信息量：`scripts/e2e/landmark-coverage.ts` 以 `ENDORSE_PROBABILITY = 0.75` 随机 endorse 或 reject，认可率只会收敛到这个常数。今天复跑读数为 0.739（46 个地标，45 个已复核，34 个认可）。TF-0136 的执行提示（「不把模型评审或脚本手势冒称人工认可」）和 TF-0154 的证据栏（「该确定性负载只验证通道与负样本，不能证明真实用户 80% 认可」）早已写明这一点；账本却仍按 0.5 / 0.8 阈值给 TF-0154 行判了 `partial`。

**修法**与 L3 的处理一致：来源声明决定哪些结论允许被推动。

- `scripts/fit-ledger/metrics.ts`：`Probe` 新增 `requires?: "natural"`，TF-0154 标记为人类认可类指标；`EVIDENCE_KINDS` 词表移到这里，`verdicts.ts` 复用。
- `scripts/fit-ledger/ledger.ts`：`buildRows(scope, ctx, evidenceKind = "unknown")`。`requires: natural` 的指标在非 natural 来源下值照常显示，fit 停在 `unknown`，依据栏写明「不构成用户认可」。不带来源参数的调用视同 unknown，不默认放行。
- `scripts/fit-ledger/render.ts`：L1 段在非 natural 来源下追加一段说明。
- `scripts/e2e/landmark-coverage.ts`：头注改写，明确它验证的是覆盖率与折叠规则，不是 L1 的 fit。

规则由测试钉住：`ledger.test.ts` 新增一例（35/47 在 unknown / scripted / live-model 三种来源下都是 `unknown`，同一批数字在 natural 下是 `partial`；校准表等非人类指标不受影响），`review-stats.test.ts` 两例改为在 natural 下断言折叠算式，并加了三种来源的门检查。

重跑 live 租户账本的变化只有一行：

| | 2026-09-09 账本 | 2026-09-10 账本 |
| --- | --- | --- |
| TF-0154 fit | `partial`（0.75） | `unknown`（值 0.739 照常显示） |
| fit 分布 | aligned 3 · partial 16 · unknown 8 | aligned 3 · partial 15 · unknown 9 |
| 四项判决 | 1/2/3 supported，L3 insufficient-evidence | 不变 |
| 护城河 A/B/C/D | 70 / 1 / 14 / 0.127，闸门开 | 不变 |

`docs/fit-ledger.md` 现在指向 live 租户（此前指向一次性现场 `mUMXLa`）；本轮快照另存为 `docs/fit-ledger-2026-09-10-l1-source-gate.md`。

**推论**：L1 验收（地标集合 80% 用户认可）在没有真实用户复核之前不可判。工程侧对它已无待办；再跑 landmark-coverage 只能验证通道，不能推 fit。

## 二、S7b 残余噪声：200 但正文不是 JSON

2026-09-08 live 租户 12 轮里有两轮（16:43、16:48）在 S7b 死于 `SyntaxError: Failed to parse JSON`：网关返回 HTTP 200，正文却不是 JSON。`attempts.jsonl` 里对应两条 `status: 200, outcome: "invalid-response"`。HTTP 5xx 早有有界重试，这一类没有。

`scripts/e2e/live-provider.ts` 现在先取 `response.text()` 再解析；解析失败记为 `invalid-json`，最多重试两次、退避 1 秒，第三次失败抛错并只报尝试次数，正文永不回显（网关页面可能带反射头或标记）。此时尚未执行任何工具调用，重试与 5xx 同样安全。两项回归：一次坏正文后恢复，attempts 记 `invalid-json → response`；三次坏正文后失败关闭且错误里不含正文。

## 三、两个定位风险的核验（TF-0111 / TF-0112）

按 TF-0135 的提示分别核验，不批量收口。

**TF-0111 本地优先使收费不可能**。节点要求「以开源 hook／库形态出货，不做 $20/月的本地二进制」。仓库现状：`packages/workbench/package.json` 声明 MIT；README 的两种安装方式（GitHub Releases 单文件二进制、`bunx @baixu22/workbench`）都免费；全仓库没有任何定价、付费或团队版面；npm 发布已按用户决定跳过（TF-0119，提交 25682da）。`docs/positioning-v5.md` §11.2 已把形态定为「开源 hook / 库，一条命令安装」。风险按既定形态收敛；若日后重启变现，节点要求里的两条路径（团队面、被工作区玩家收购）仍有效，须新开节点评估。

**TF-0112 叙事位已被厂商占据**。节点要求「不把『会话间通知』当作宣传说辞，只当作机制」「对外用 context rot 与 stale premise，强调确定性检测而非自愿消息」。仓库现状：根 README 与 Workbench README 只描述机制（「记录 agent、人和 git 读写过哪些文件，在已记录的前提失效时给出证据」），没有「在你发现之前警告」式的宣传；`apps/marketing` 是存量 Helmor 站点，不涉及会话通知；`packages/context-rot` 以 context rot 为旗号且「只抓确定性的死引用」「只记确定性」；ADR-0010 的 non-goals 表明确不建 agent 消息总线；实际通道是足迹与变更的确定性交集产生 `premise_stale`，与 Claude Code 由模型自愿调用 `SendMessage` 的机制在代码层面就不同。风险按既定叙事收敛。

## 四、验证

- `bun run test`（`--timeout 60000`）：**622 pass / 0 fail**（101 文件，2393 断言）。本轮新增 3 例。第一次裸跑 `bun test` 时 `interactions.test.ts` 的 1 MB 规模用例在默认 5 秒超时下失败，用包脚本的 60 秒超时通过，单跑三次均通过；这是已知的本机 FS 慢（TF-0114），不是回归。
- `bunx tsc --noEmit`：workbench 与 workbench-ui 均通过。
- Biome：`packages/workbench/scripts/e2e` 下 11 个文件此前未格式化、3 处 import 顺序错误、1 个未用 import，已一并修正；现全部干净。
- `apps/workbench-ui` vitest：20 pass（未改 UI 代码，仅确认基线）。
- task-forest `validate` 通过，HTML 已导出。

## 五、工作树状态与接力

工作树里有约 180 个未提交文件，横跨 2026-09-07 至今的多个会话：阶段 D 脚本与账本、`apps/workbench-ui` 的整体前端重构（抽屉侧栏、Radix 焦点管理、Playwright E2E）、本轮改动。本轮**没有提交**；建议把前端重构与阶段 D 分成两笔提交落库，否则 TF-0144 的「代码领先森林」闸门形同虚设。

下一位接力者：

1. 阶段 D 工程侧没有待办。剩余全部是自然使用问题：L1 认可率、恢复卡的人类耗时效果。这两项只能等 `--evidence-kind natural` 的现场，不要再用脚本推。
2. 日常采样仍走 `bun scripts/e2e/run.ts --live --rounds N`，需要 `E2E_LLM_KEY` / `E2E_LLM_MODEL`；本机目前没有凭据。
3. UI 的真实流式回复验收仍被 Claude CLI 未登录挡住（2026-09-09 前端 E2E 已记录）。

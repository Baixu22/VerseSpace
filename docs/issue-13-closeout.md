# Issue #13 收尾：fit 账本 9 行 unknown 的分类处置

2026-09-15。对照 issue #13 的三条验收标准与 2026-09-15 收尾扫描报告 §五 R4。

## 收口的是什么

扫描报告的结论是：按账本纪律这 9 行 `unknown` 是**诚实的**，但对产品叙事是硬约束——
**不能把 unknown 当 validated 讲**。issue #13 的目的不是把这 9 行推成 `aligned`
（那会违反纪律 2），而是把 `unknown` 这个词在对外叙事里的边界写清楚。

关键约束：**账本是生成的，不是手写的**。`docs/fit-ledger.md` 的头部写着
「本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，
每周重跑覆盖一次。不要手工编辑」。所以三条验收标准全部落在生成器里
（`scripts/fit-ledger/`），而不是落在 markdown 上——手写的分类没有来源，
下一次重跑就会被覆盖。

## 落库内容

### 1. 分类声明（验收标准 ①）

`ledger.ts` 的 `Row` 新增 `unknownClass` 字段，由 `buildRows` 推导：

- **结构性 unknown**（`structural`）：`record` 类节点（决策/实验/修复）。
  纪律 2 规定它们无 stats 或事件可引、恒为 unknown——**这是纪律本身，不是缺口**。
- **证据缺口 unknown**（`evidence-gap`）：`component` 类节点有可观测指标，
  但样本不足（`insufficient-history`）或来源不是自然使用（`requires: natural`）。

渲染时 fit 列从 `` `unknown` `` 变成 `` `unknown`（结构性） `` 或
`` `unknown`（证据缺口） ``。分类是**推导出来的**：账本每周重跑覆盖，
手写分类会丢，只有推导能活过重跑。

推导结果与 issue 的 A 类 7 行**逐条一致**：TF-0138 / TF-0140 / TF-0144 /
TF-0153 / TF-0136 / TF-0137 / TF-0155。B 类的 TF-0142 与 TF-0154 也落在
`evidence-gap`，各自带处置结论。

### 2. B 类两行的处置结论（验收标准 ②）

探针（`metrics.ts` 的 `PROBES`）新增可选的 `disposition` 字段，只在 fit 停在
unknown 时携带，渲染成行内的「；处置：…」：

| 节点 | 处置 | 落地方式 |
| --- | --- | --- |
| **TF-0142** | fixture 通道语义测试验证 `unknownBy.unobservable` 计数路径活着；不在 live 现场造样本 | 新增 `notice-outcome.test.ts` 用例：造一条走不可观测通道的投递，沿 label → fold → stats 三段验证计数 |
| **TF-0154** | 依赖 issue #12 的 J3 条件②（真实使用者参与复核）；不靠多跑脚本拉读数 | 只标依赖，不改读数路径。0.333 是 live-model 来源，收敛到的是脚本认可概率，不是用户认可 |

**TF-0142 的处置为什么是测试而不是数据**：当前值 0 是好消息（没有通知走过
被显式排除的通道），但**样本为 0 分不出「降级语义被执行了」和「计数路径断了」**。
去 live 现场造样本会把通道语义测试记成使用数据——issue 明确禁止。所以处置是
在 fixture 里造一条投递，验证计数路径活着，且 fixture 只存在于测试进程的
临时黑板（`makeTempWorkbench`，用完 `rm -rf`），**不进任何 live 现场**。

新测试覆盖的三段（此前只有 label 一段有 unobservable 用例）：

1. `labelNoticeOutcomes` → `outcome: unknown`, `unknownReason: unobservable`（已有）
2. `foldNoticeOutcomes` → `agent.unknownBy.unobservable === 1`，且不准算成 `ignored`（**新增**）
3. `collectChatStats`（真实黑板读写路径） → `stats.noticeOutcomes.agent.unknownBy.unobservable === 1`（**新增**）

第 2 段此前是**真缺口**：`foldNoticeOutcomes` 把 `unknownReason` 折进 `unknownBy`
的那行代码（`notice-outcome.ts:348-350`）没有任何测试覆盖——账本读的那个计数器
本身没人验证过它活着。

### 3. 叙事纪律（验收标准 ③）

`render.ts` 的纪律段在两条证据纪律之后追加一条：

> **`unknown` 不得在对外材料中被表述为 `validated` 或已验证。**
> 它既不是「通过」也不是「失败」，而是「这行还没有可引用的证据」。

这条纪律也写在生成器里，所以它随账本一起重跑，不会变成一份孤立的手写说明。

## 验证记录

| 验证 | 结果 |
| --- | --- |
| `scripts/fit-ledger/ledger.test.ts` + `src/runtime/notice-outcome.test.ts` | **30 pass / 0 fail**（原 28 + 新增 2：unknown 分类推导、不可观测通道计数路径） |
| `packages/workbench` 全套 | **692 pass / 0 fail / 1 snapshot / 2677 expect / 106 文件**（基线 690 → +2） |
| `bunx tsc --noEmit` | **exit 0** |
| `bunx biome check` | **clean** |
| 分类推导 vs issue 的 A 类清单 | 逐条一致（7 行 structural），TF-0142 / TF-0154 落 evidence-gap 且带处置 |
| 生成器实跑 | `bun run scripts/fit-ledger.ts` 的 fit 列输出 `unknown（结构性）` 与 `unknown（证据缺口）`，处置渲染进行内 |

## 2026-09-16：已交付账本的分类补录

原始临时黑板已不存在，不能用另一个现场重算后冒充旧读数。本轮按当前 `PROBES` 对已提交的历史账本执行确定性的分类补录：7 行标为结构性 unknown，TF-0142/TF-0154 标为证据缺口并写入已有处置结论，同时加入禁止把 unknown 称为已验证的纪律。

逐行核对并保持节点、状态、fit 值、可观测指标及 measured 值不变；生成时间和数据源仍为 2026-09-10 快照。文件头明确说明原始现场缺失，未把补分类当成重新采样。

补录脚本及前后 SHA256、数值不变断言位于 `.agent-contexts/audit-errors-2026-09-16/run-20260915T222636Z/annotate-fit-ledger.ts` 和 `ledger-annotation.json`。未来真实重跑仍使用已经具备分类逻辑的生成器。

## 验收标准对照

| issue #13 验收标准 | 状态 |
| --- | --- |
| ① A 类 7 行在账本上被标成结构性 unknown，附书面复核指针 | ✅ `buildRows` 推导 `unknownClass: structural`，fit 列渲染 `unknown（结构性）`；复核指路沿用既有 `trace`，7 行逐条一致 |
| ② B 类两行各有明确处置结论 | ✅ TF-0142：fixture 通道语义测试（label → fold → stats 三段，新增 2 项）；TF-0154：标为依赖 #12 的 J3 条件②，不追读数 |
| ③ 叙事纪律：unknown 不得被表述为 validated 或已验证 | ✅ 写进 `render.ts` 的纪律段，随账本重跑 |

**未决（不影响本 issue）**：TF-0154 的 unknown 只能由 issue #12 的 J3 条件②
（真实使用者参与复核）解开；TF-0167 §F5 已否决受控实验路线，本 issue 不复活它。
`docs/fit-ledger.md` 已补齐分类，历史数值未重算；新的自然使用结论仍需相应证据。

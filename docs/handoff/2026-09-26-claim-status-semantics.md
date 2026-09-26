# 状态语义与历史节点定性（第四轮阶段 B · 2026-09-26）

> **双标签口径：本机实测通过 / 产品证据仍缺。**
> 分支 `qa-stage-ab-remediation`，改动仅本地 commit，未 push。

---

## 0. 结论摘要

阶段 A 建了账本，但没回答**「没有读数的 done 算什么」**。阶段 B 回答了，并把 47 个
「done 但 evidence 为空」的历史节点逐条定性。

| 读数 | 值 |
| --- | --- |
| `done` 且 `evidence` 为空 | **0**（此前 47） |
| 47 条定性结果 | covered **38** · file **5** · local **2** · review **1** · deprecated **1** |
| 森林状态分布 | done 257 · deprecated 12 · proposed 9 · in_progress 2 · **review_needed 1** |

## 1. 语义（ADR-0022）

1. **`done` 必须指向读数**，读数分两级：**直接读数**（仪器实际执行了该交付物）与
   **覆盖读数**（读数的 `subject_paths` 覆盖交付物路径，但仪器**没有**复算原始验收）。
   覆盖读数必须在 evidence 里**写出「间接」**并点名 claim id——写不出这句话的就不是覆盖读数。
2. **没有读数覆盖的交付物 → `review_needed`**（landed-unknown：代码在，没人量过）；
   **交付物已不存在 → `deprecated`**。不新增状态值：森林 CLI 的合法集里已有
   `review_needed`，语义正好是「需要人看一眼」。
3. **仪器退役的读数（L3）只能当观测**，不能充当 `done` 的证据——直接承接 ADR-0021 的代价。
4. **读数 stale ≠ 节点未完成**：门禁报红是要人**重取读数**，不是回退状态。

## 2. 47 条怎么定性的（判定表沉淀，不是批量改状态）

判定表本身在 [`scripts/audit/node-evidence.mjs`](../../scripts/audit/node-evidence.mjs)：
`node → 覆盖它的 claim + 路径`，或「为什么没有 claim」。因此**「47 条各自是什么结论」是可复核、
可重跑的**，而不是一次性的批量编辑。

| 分类 | 条数 | 依据 |
| --- | --- | --- |
| **covered** | 38 | 交付物是仍在的模块（scheduler / automaton / blackboard / types / contextgen / verifier / watcher / fs / commands / ui …），由 `claim-workbench-suite` 与 `claim-ui-suite` 的有效读数覆盖。**每条 evidence 都写明这是间接证据**——证明交付物仍在且被测，不是本节点原始验收的直接复算。 |
| **file** | 5 | TF-0002 / 0013 / 0014 / 0015 / 0016（技术决策类）：证据是仍在的 ADR、`package.json`、目录结构；复核方式是**读文件**，不是跑仪器。 |
| **local** | 2 | TF-0017（git 远端）、TF-0067（自举的 `.workbench/` 台账）：**本机状态，换机不可复算**，只作观测。 |
| **review** | 1 | **TF-0022「biome 与 CI 车道接入」→ `review_needed`**：biome 半边仍在且 `lint` exit 0，但 **CI 半边已随 ADR-0021 退役**，交付物一半不存在——需人决定拆节点还是标 deprecated。 |
| **deprecated** | 1 | **TF-0103「修复 ci.yml 的 15 处 tab 缩进」**：`.gitlab-ci.yml` 已删除，交付物不存在。 |

**两处必须点出的诚实性**：

- 38 条 covered **不是**「这 38 个节点的验收都被复算过了」。它们只证明**交付物还在、并且被
  测试覆盖**。原始验收的复算需要每个节点各自的仪器，那不在本轮范围内。
- `review_needed` 从 0 变成 1、`deprecated` 从 11 变成 12——**森林的「未完成」读数是如实上升的**，
  不是退步。ADR-0022 把这一点写进了代价。

## 3. 账本同步扩充

新增两条声明并取读数：`claim-lint`（biome exit 0 / 0 error）与 `claim-typecheck`
（三包 `tsc --noEmit` exit 0）。账本现在 **10 条声明 / 10 条读数**。

## 4. 这一轮**没有**解决什么

- **38 条 covered 仍是间接证据**：没有一条历史节点的原始验收被直接复算。
- **产品证据三类**（Codex 真实写侧 / 非 Windows 发布物 / 真人窗口）仍未开始——阶段 C，
  卡在外部条件上。
- **D 类（已退役 CI 的读数）按指示 pass**，仍是账本里的空白。
- **文档与森林里仍有大量散文数字没有登记**：本轮登记的是「门禁 + 审计仪器」这一层，
  不是全部声明。

## 5. 复核命令

```bash
node scripts/audit/node-evidence.mjs    # 期望：covered 38 / file 5 / local 2 / review 1 / deprecated 1
bun run check:claims                    # 期望 10/10 valid · exit 0
node scripts/claims/ledger.test.mjs     # 期望 10 pass / 0 fail
```

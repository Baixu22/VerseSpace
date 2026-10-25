# ADR-0026：输入来源、产物来源与目标适用性的四种事实

- 状态：已接受（2026-10-25，用户授权「接力节点开发，保证尽可能最瘦约束」）
- 补充 ADR-0010 的前提投影与 ADR-0025 的声明验证范围。ADR-0023 的功能冻结只在本文件声明的纵切片内放开；ADR-0024 的退役范围保持不变。
- 追踪：任务森林 TF-0282 / TF-0283 / TF-0284（提案 `TFP-2026-10-25-moat-depth`）。

## 问题与决定

前提账本现在同时记录几种不同的「我见过这个文件」：CLI 工具调用带来的路径、capture 时刻算出的内容哈希、调用者写下的 checkpoint 输入清单、检查通过后的产物绑定、以及目标 ref 上的 blob 比对。它们都落在同一个 `FootprintUsed` / `Checkpoint` 形状里，读起来像一回事，实际能证明的东西差得很远。把它们混用，就会出现「重读一次就算已知最新」「同一份输入就算目标已适用」这类假通过。

本决定只做一件有界的事：**把四类事实分开命名、分开签发、分开失效**，并规定强结论的前置条件。它不新增通用依赖图，不推断因果，也不扩大封印覆盖。

| 事实 | 谁能签发 | 不能证明什么 |
| --- | --- | --- |
| Observed input | 工具调用本身（`Read` / `Grep` / `Glob` / `LS` 的结构化路径，有限 `cat` 后备），配合采集时刻的内容版本 | 不能证明工具实际返回的字节等于采集到的版本；超大文件只有 size；目录读取、截断输出与未归因命令维持未知 |
| Declared origin | 调用者在 checkpoint 上显式写下的 `artifact.inputs`（`source: "declared"`） | 不是自动发现，也不是因果；结构与先读后写只算候选，不能升级为「产物由这些输入产生」 |
| Verified artifact | 一次声明范围检查的真实退出与报告（用例集合完全一致、`passed`、`evidence.status = satisfied`、`authority = command`），绑定到具体工位与输入哈希 | 不证明产物的语义正确性，不证明覆盖了未声明的输入，也不跨工位继承 |
| Target applicability | 目标 ref 解析出的 commit/tree 与逐个声明输入 blob 的比对（`inputsMatch`） | 说明「目标上这些输入字节相同」，不说明合并结果已构建、已检查或已通过 |

### 1. 四类事实的现有落点

- **Observed input**：`packages/workbench/src/blackboard/footprint.ts` 的 `extractFootprint` 从工具调用取出路径与行范围，`hashPathClaim` 在采集时对文件或行段取哈希（超过 2 MB 只记 size，≤64 KB 的 volatile 读取另存 spool）。因此当前的 `version` 是**采集时刻的采样版本**，不是「工具返回内容的原文凭据」。这个差别写在这里，不被读作已经解决；把两者绑定起来是后续节点的事。
- **Declared origin**：`packages/workbench/src/types/artifact-evidence.ts` 的 `artifactDeclarationSchema`。`inputs` 至少一条，`source` 固定为 `declared`，无默认推断。
- **Verified artifact**：`packages/workbench/src/artifacts/status.ts`。只有 `lifecycle` 已结束、`verificationResult.status = passed`、`evidence.status = satisfied` 且 `context.authority = command` 才允许进入 `current`，其余保持 `pending` / `failed` / `unknown`。检查报告的形状见 `packages/workbench/src/types/verification-evidence.ts`：用例集合必须完全一致，零用例、子集、重复名与未更新报告都不签发范围满足。
- **Target applicability**：`packages/workbench/src/artifacts/snapshot.ts`。`target` 记录 ref / commit / tree，并用 `git rev-parse <commit>:<path>` 与 `git hash-object` 逐条比对声明输入；`artifactSnapshotDifference` 把 ref 推进、工位变化与任一输入版本变化都判为「不能沿用」。

### 2. 强结论的前置条件

任何一条强结论（`current`、`inputs-match`、`已核对`）都必须写明它属于上表哪一种事实，以及支撑它的版本、事件序号与检查结果。缺任一项即降级为未知，不允许用相邻事实补齐：

- 读操作（重读、补采样、确认通知）不产生新的 Observed input，也不改写产物的 Declared origin。
- 旧日志没有新字段时按弱证据读取，不回填成强证据，不把 `fs-sample` 提升为 `tool-observed`。
- 同一工位内容相同，不能代替「目标主线当前可用」。

### 3. 消费边界

保证范围只覆盖 Workbench 管理的验收消费：声明范围的 checkpoint 检查、`artifact` 重验与恢复卡上的 `current` / `stale` 判定。范围外：裸编辑器、Git 直接操作、无审批写入、未知目标与无法归因的路径；这些既不被拦截，也不被计为已保护。Codex 通道继续按 ADR-0023 记为实验性。

默认仍是建议式并发（ADR-0006 / ADR-0010）：本决定不把账本变成排他写锁，也不做全仓写保护、自动语义合并或隐藏推理的因果推断。

### 4. 保留项

- 既有退役决定全部保留：ADR-0024 的非 Windows 实机验证与真人研究不恢复；ADR-0021 的本地门禁方式不变。
- ADR-0025 的「只保存哈希、不保存配置值」「重验生成新 checkpoint、不重放 effects」继续有效。
- 旧来源、旧事件与已 retired 的森林节点不重写。

## 验收与边界

本决定自身的验收是文档可核对：ADR、决策索引与 README 的 ADR 范围一致，四种事实与消费边界都有明文。检查器为 `scripts/moat/check-scope-adr.mjs`，读数登记在 `claim-moat-baseline`。

它**不**证明下列任何一项，也不因本文件通过而自动开工：第二阶段起的实现节点保持 `proposed`，只有阶段一的独立 judge 指出强朴素方案确实覆盖不到缺口时，才按各自读数推进；判据调整必须先于实现。若阶段一判定「现有方案已满足本轮要求」，后续节点继续停在 `proposed`，不得因任务已列出而扩展。

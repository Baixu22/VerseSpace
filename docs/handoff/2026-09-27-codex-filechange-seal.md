# 原生 `fileChange` 写与封印关联（TF-0263 后续 · 2026-09-27）

> **结论：ADR-0017 上一条补记（2026-09-27 第一次）的「写侧结构性缺席」是错的，
> 已由本节取代。** 同日的 6 变体重复实验里，变体 01 与 06 都发出了原生
> `fileChange` item；变体 01 与那一次抓取是**同一个模型、同一个 profile、同一个
> 提示词**——所以原来那个「零原生写 item」是**回合间的方差**，不是结构。
> 写目标在 item 的 `changes[].path` 上，审批只带 `params.itemId`；本次把这条关联
> 实现出来，原生写审批因此真的会咨询封印。
>
> 仍有边界：6 个回合、4 个模型；shell + `apply_patch` 那条写路径（`commandActions`
> 全是 `unknown`、无 `path`）**今天仍然不可归因**。§6 列出它**不**证明什么。

---

## 0. 哪些读数是真实运行，哪些只是读代码

ADR-0020 要求把这两类分开写。

| 层 | 内容 | 谁产生的 |
| --- | --- | --- |
| **A. 真实运行（模型调用）** | 6 变体重复实验的 raw dump（`.agent-contexts/codex-matrix/<label>.jsonl`）与普查 `matrix.json` | 本轮之前的 Lead，2026-09-27；**本报告作者没有重跑任何模型调用** |
| **B. 对 A 的产物重新分析** | 两条 `fileChange` 变体的有序事件、审批 params 形状、`itemId` 关联、fixture 的逐字抽取 | 本报告作者，读 A 层 dump |
| **C. 真实运行（本仓库测试）** | `bun test`：关联前/后对照、假 app-server 端到端（封印拿到真实路径 → 回 `cancel`）、`src/chat` 全量 327 项 | 本报告作者，2026-09-27 |
| **D. 代码 / 类型 / 格式门禁** | `bun run typecheck`、`bun run lint` | 本报告作者，2026-09-27 |

**没有**做的事：没有起模型服务、没有跑 `scripts/**` 下的探针、没有重跑 codex。
A 层是**复用** Lead 留在磁盘上的产物，不是本轮复算的。

## 1. 否证：6 变体普查

同一 recipe（codex `0.158.0-alpha.2.1`、隔离 `CODEX_HOME`、本地网关 `wb_verify`、
`read-only` 沙箱、`approval_policy = "on-request"`）下重复 6 条。来源
`.agent-contexts/codex-matrix/matrix.json`（本地未跟踪 scratch）：

| 变体 | 模型 / 沙箱 / 提示词 | items | 审批 |
| --- | --- | --- | --- |
| 01 | glm-5.3-flash / read-only / apply_patch | `commandExecution` 6、**`fileChange` 2** | 3 × `commandExecution`(unknown) + **1 × `fileChange`(kind write)** |
| 02 | glm-5.3 / read-only / apply_patch | `commandExecution` 12 | 3 × unknown |
| 03 | deepseek-v4.1-flash / read-only | `commandExecution` 6 | 无（写没落地） |
| 04 | sn-kimi-k3 / read-only | `commandExecution` 18 | 5 × unknown |
| 05 | glm-5.3 / workspace-write | 只有 `userMessage` 2（**没有可用回合**） | 无 |
| 06 | glm-5.3-flash / read-only / **新建文件** | **`fileChange` 2** | **1 × `fileChange`(kind write)** |

被否掉的那句（ADR-0017 第一次补记）：

> 「在这条车道上，写侧夹具门禁不是**尚未收集**，而是对本次抓取的模型 / profile /
> 回合**结构性缺席**——真实写回合不产生 `fileChange` / `applyPatch` / `fileRead` item。」

否证它的**正是它自己的配置**：变体 01 = glm-5.3-flash + read-only +
apply_patch 提示词，与第一次抓取逐项相同，而它发了 2 个 `fileChange` item。
一次观测支持的是一次读数，不是「结构性」。变体 05 不构成任何一方证据：它连回合
都没产生（`matrix.json` 里 `itemTypes` 只有 `userMessage: 2`）。

## 2. 机制（B 层，逐字）

变体 06 的有序事件（`06-glm53flash-readonly-create.jsonl` 第 71/73/76 行）：

```
item/started    id=call_49ea214b036846fcafa94549
                item={"type":"fileChange","id":"call_49ea214b036846fcafa94549",
                      "changes":[{"path":"…\\06-glm53flash-readonly-create-ws\\src\\notes.md",
                                 "kind":{"type":"add"},"diff":"hello\n"}],
                      "status":"inProgress"}
item/fileChange/requestApproval   id=0
                params={"threadId":…,"turnId":…,"itemId":"call_49ea214b036846fcafa94549",
                        "startedAtMs":…,"reason":null,"grantRoot":null}   ← params 里没有任何 path
item/completed  id=call_49ea214b036846fcafa94549   … same, "status":"completed"
```

变体 01 是同一形状（`01-glm53flash-readonly-patch.jsonl` 第 234/236/239 行），差别只有
`"kind":{"type":"update","move_path":null}` 与目标 `…\\01-glm53flash-readonly-patch-ws\\src\\target.ts`。

**读法**：路径在 **item** 上（`changes[].path`），审批靠 `params.itemId` 指回它，
审批 params 自己**一个 path 字段都没有**。这解释了旧代码的现象：`approvalTargets`
对 `item/fileChange/requestApproval` 早就返回 `kind: "write"`（方法判定），却
`paths: []`（params 里确实没有可收集的东西）——于是 `session.ts` 的封印闸门
`kind === "write" && paths.length > 0` 永不成立，原生写落在陈旧前提上却不受封印约束。

## 3. 沉淀的夹具

`packages/workbench/src/chat/fixtures/approvals/file-change-0.158.json`（127 行）：
两条变体的原始 `{method, params}` 帧（`items`）与随后的审批请求（`requests`），
`$comment` 写明出处。路径按现有 **approvals** 夹具的口径原样保留（
`apply-patch-0.158.json` 同款做法）。

**为什么不进 `streams/codex/`**：那里的门禁（`codex-fixtures.test.ts`）要求每个
`*.jsonl` 零 undecided，而 `fileChange` 在 `codex-render-decision.ts` 的
`ITEM_DECISIONS` 里**还没有决策**——加决策不在本次写入范围。审批请求本来也不属于
`type`-tagged 流（它是 server→client 请求，不经过 `normalizeNotification`）。
所以这两条证据放在 `approvals/` 的原始形态里，undecided 覆盖缺口由 ADR-0017 与
本报告记名，没有被静默吸收。

## 4. 实现

| 文件 | 改动 |
| --- | --- |
| `codex-app-server/file-change-paths.ts`（新） | 纯函数 `fileChangeItemPaths(event)` 读出 `{ itemId, turnId, paths }`；`FileChangePathIndex` = **按回合**、**有上限**（64）的 `itemId → paths` |
| `codex-app-server/session.ts` | 通知分支 `fileChanges.note(event)`（在 router 之前）；终端帧 `turn/completed` / `error` 清空；应答审批时 `fileChanges.pathsFor(params.itemId)` 作为第三参数传入；`kind === "unknown"` 的审批现在打印一条「无法判定读/写，未咨询封印」 |
| `codex-app-server/approval-targets.ts` | 新增**可选**第三参数 `itemPaths`，只对 `item/fileChange/requestApproval` 生效。保持无状态、纯、保守；`commandExecution` 判定一字未改 |
| `codex-write-capture.test.ts` | 更正文件头（写侧不再是「结构性缺席」）、把「零原生写 item」收窄为该夹具的读数、新增关联前/后对照 + 索引边界 + 假 app-server 端到端 |
| `codex-app-server/approval-targets.test.ts` | 新增第三参数的三个用例（含真实夹具） |

效果：原生写审批现在满足 `kind === "write" && paths.length > 0`，封印被咨询；
阻断时回 `cancel`（0.158 的 `availableDecisions` 没有 `decline`）。

**已证 vs. 推理**：
- **已证（C 层，真实 `bun test`）**：假 app-server 按真实顺序发「无法分类的命令审批 →
  `fileChange` item → 该 item 的审批」，封印**被咨询恰好一次**、拿到
  `<tmp>/src/target.ts`、回合回复是 `cancel`；命令审批仍是默认 `accept`，并打印
  诊断。这条走的是真 `session.ts`（`spawnSupervised` 起子进程，非纯函数模拟）。
- **已证（C 层）**：真实夹具上「不关联 → `paths: []`，关联 → 真实路径」。
- **推理（D 层）**：`codex-session.ts` 的 `sealApproval` 会对这些路径逐条
  `decideSeal`——那一段本次没有跑真实模型验证（见 §6）。

## 5. 门禁命令与读数（真实运行）

```
cd packages/workbench && bun test src/chat/codex-write-capture.test.ts \
    src/chat/codex-fixtures.test.ts src/chat/codex-app-server/approval-targets.test.ts
→ 19 pass / 0 fail, 13 snapshots, 255 expect() calls

cd packages/workbench && bun test src/chat
→ 327 pass / 0 fail, 33 snapshots, 1810 expect() calls, 47 files

bun run typecheck   → exit 0
bun run lint        → exit 0
```

## 6. 诚实边界（不证明什么）

- **不证明原生 `fileChange` 是唯一的写路径**。shell + `apply_patch` 那条路
  （`commandActions[].type === "unknown"`、无 `path`、写目标只在散文 `reason` 里）
  今天仍然不可归因、仍然只拿默认 `accept`。ADR-0023「对某个命令的负面观测不能
  泛化」对**正反两个方向**都成立：否掉「缺席」不等于证明「只有这一种」。
- **样本量**：6 个回合、4 个模型、一个 CLI 版本（`0.158.0-alpha.2.1`）、一个
  本地网关 profile。没有跨 `sandbox_mode` / `approval_policy` 的对照。
- **没有跑真实模型验证封印阻断落地**。端到端证据用的是假 app-server，验证的是
  **车道侧的关联与应答**，不是「真实 codex 收到 cancel 后确实没写」。
- **`kind === "unknown"` 的新诊断不声称那是写**：它只说「判不出读/写、未咨询封印」。
  想真正归因那条路需要解析 patch/命令串，本次**故意没做**（见 §7）。
- **渲染层仍未建模 `fileChange`**：`codex-render-decision.ts` 的 `ITEM_DECISIONS`
  还没有它，真实流里的 `fileChange` item 仍会以 `undecided` 被 `codex-turn.ts` 报警。

## 7. 故意没做的事

1. **没给 `codex-render-decision.ts` 加 `fileChange` 决策**——不在本次写入范围。
   后果：新夹具只能以原始形态放在 `approvals/`，不能进 `streams/codex/` 的
   零-undecided 门禁。
2. **没让 shell 写审批变得可归因**——那要从命令串 / patch 体里解析写目标，属于
   猜测；它今天仍有散文 `reason`（`Do you want to allow apply_patch to modify
   src/target.ts…`）但这不是机器可读字段。留作后续。
3. **没把 `fileChange` item 变成写足迹**（`codex-footprint.ts` 的 `WRITE_ACTIONS`
   分支 / `codex-router.ts` 的 `recordActivity`）——本次只做审批归因与封印关联；
   让原生写进账本是一条独立的、需要自己读数的改动。
4. **没有提交、没有推送、没有建分支**；没有改动 `docs/decisions/0023-*.md`、
   `scripts/**`、`AGENTS.md`、`package.json`、`.agent-workbench/**`。

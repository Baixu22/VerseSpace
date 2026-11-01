# 2026-11-01 会话生态完整性：任务森林规划（第五轮）

对象：VerseSpace / Workbench，基线 `482ac04`（本轮规划落树，未改产品代码）。
提案：`TFP-2026-11-01-session-ecosystem`（已应用，`proposal-apply` 通过，`validate` 通过）。
根节点：**TF-0314「第五轮：会话生态完整性」**（`global_task`，`in_progress 35%`）。

> 任务森林本身是**本机 untracked** 的编排脚手架（AGENTS.md / ADR-0022）。这份记录是它在
> 上传面上的可复核摘要：节点树、判据、依赖与「刻意不做」，不含森林数据本身。

## 1. 为什么是这一轮

用户看到 DeepSeek `dsh-superagent-prototype` 开源后，要求按「会话生态完整性」做纵向增强并整理护城河。
调研结论（[会话生态调研](2026-11-01-session-ecosystem-research.md)）是：对方做的是**授权与派工**
（Mandate / Ticket / Assignment），Claude/Codex 做的是**会话可续性**，而 Workbench 唯一独有且别人
没做的是**前提是否仍然成立**。本轮把这条补上缺的一块：**会话这一层**。

已落地的第一刀见 [会话延续性切片](2026-11-01-session-continuity.md) 与
[ADR-0027](../decisions/0027-session-continuity-projection.md)。

## 2. 节点树（21 个新节点）

```
TF-0314 第五轮：会话生态完整性                        [in_progress 35%]
├── TF-0315 阶段一：中断观察与延续性读数（已落地）      [done]
│   └── TF-0316 把回合中断记录成观察并把延续性读成三态  [done]
│       ├── TF-0317 清扫先落 thread.turn_interrupted   [done]
│       ├── TF-0318 chat/continuity 只读投影           [done]
│       ├── TF-0319 sessions continuity CLI 面         [done]
│       └── TF-0320 ADR-0027 / 声明 / 交接记录         [done]
├── TF-0321 阶段二：把延续性接进既有表面               [proposed]
│   ├── TF-0322 恢复卡呈现「被切断且没有回复」         [proposed]
│   │   ├── TF-0323 行语义与 ~ 积压行的取舍判据        [proposed]
│   │   ├── TF-0324 restore-view / resume-card 接入    [proposed]
│   │   └── TF-0325 UI 渲染 + 展示观测扩展             [proposed]
│   └── TF-0326 MCP 增加第六只读工具 continuity        [proposed]
│       ├── TF-0327 工具契约、截断预算与只读边界       [proposed]
│       └── TF-0328 表面漂移测试与工具目录一致性       [proposed]
├── TF-0329 阶段三：中断语义细分与联合判读             [proposed]
│   ├── TF-0330 中断原因细分                           [proposed]
│   └── TF-0331 断点 × 前提积压的联合判读视图          [proposed]
├── TF-0332 风险：方向被扩成授权/派工平台              [proposed]
├── TF-0333 7 条声明在本机不可测，需可 spawn 环境重取  [proposed]
└── TF-0334 provider 会话身份缺失时的可核对性          [proposed]
```

## 3. 阶段设计的三条理由

1. **先留住事实，再读数，最后接手表面。** 阶段一先解决「复位即抹」这个数据丢失；没有这一步，
   后面任何表面都只是在渲染一个残缺事实。
2. **判据先于实现。** TF-0323（行语义与 `~` 取舍）排在 TF-0324/TF-0325 之前且是它们的阻塞依赖。
   实测 30 条会话里 20 条带未投递积压——不先定判据，恢复卡会退化成红点墙。
3. **三个阶段串行，阶段内并行。** `TF-0321 depends_on TF-0315`、`TF-0329 depends_on TF-0321`；
   阶段二里恢复卡那条与 MCP 那条互不阻塞，可并行开工。

## 4. 各阶段验收判据（可核对）

| 节点 | 判据 |
| --- | --- |
| TF-0315（done） | `claim-session-continuity` valid，12 pass / 0 fail；真实账本 8 条需人看 / 20 条仅带积压 |
| TF-0321 | 同一线程在 CLI / 恢复卡 / MCP 三处 state 一致率 100%（夹具断言）；intact 会话零新增渲染 |
| TF-0322–0325 | intact 零新增行；review 恰多一行且 refs 可溯源；已恢复的中断不占注意力 |
| TF-0326–0328 | 工具契约是三态读数与 delivery 的子集；工具目录测试断言 6 条且逐条可调用 |
| TF-0329–0331 | 每个中断原因 ≥1 次真实观测 + 测试；无法归类记 unknown；四类组合各有用例 |
| TF-0332（风险） | 本轮及后续一轮未引入任何授权/派工概念 |
| TF-0333 | `check-claims` 的 stale 集合 7 → 0，或逐条写明不可测原因 |
| TF-0334 | 每类 unknown 能回指具体事件或字段 |

## 5. 刻意不做（写进非目标，不是遗漏）

- 不复活 Tauri / Rust / sidecar / CI / 非 Windows 实机 / 真人研究（ADR-0021 / 0024）。
- **不做 Mandate / Ticket / Assignment 授权与派工**（TF-0332 就是这条风险的载体）。
- 不做全仓写保护、自动语义合并、隐藏推理的因果推断。
- **不做自动重跑 / 自动重投 / 自动归档 / 自动修复**；`review` 不触发任何动作。
- 不把未投递通知并入会话 state（它是全局积压，并入会淹掉真正的断点）。
- 不改 `reload` / `fork` / 跨 provider 既有语义，不宣称「精确会话回滚」。
- 不以工程读数宣称生产率提升或市场护城河成立。

## 6. 依赖与顺序

```
TF-0315 → TF-0321 → TF-0329          （阶段串行）
TF-0323 → TF-0324 → TF-0325          （判据 → 服务端 → UI）
TF-0327 → TF-0328                    （契约 → 表面测试）
TF-0327 depends_on TF-0318           （契约复用三态读数）
TF-0331 depends_on TF-0322           （联合判读要在恢复卡上落地）
TF-0333 depends_on TF-0316           （这 7 条因本轮改动被测路径而失效）
```

## 7. 估时是区间，不是承诺

TF-0314 合计记 30 小时（`estimated_total_minutes: 1800`），但剩余按 4–15 小时记——
阶段一已完成，阶段二/三的多数工作取决于面板与 MCP 的表面契约先落到什么程度。
开工时应按现场证据更新，不把规划区间当已发生耗时。

## 8. 复核

```bash
# 森林（本机，untracked）
python "C:\Users\27933\.workbuddy\skills\task-forest\scripts\task_forest.py" \
  show TF-0314 --workspace D:\helmor-main
python "C:\Users\27933\.workbuddy\skills\task-forest\scripts\task_forest.py" \
  todo --workspace D:\helmor-main
node scripts/check-forest-landing.mjs        # 本仓权威落地门（exit 0 才干净）

# 阶段一已落地的读数
bun test packages/workbench/src/chat/continuity.test.ts --timeout 60000
node scripts/check-claims.mjs
```

**落地状态**：本轮只写森林节点，没有改产品源码；`check-forest-landing` 在 `482ac04` 上 exit 0。
节点树的开工程度以 `todo` 输出为准：TF-0316–TF-0320 已 `done`，其余 `proposed`，
其中 TF-0324 / TF-0325 / TF-0328 / TF-0329 / TF-0331 因依赖未满足显示 `blocked`（这是依赖解析，不是失败）。

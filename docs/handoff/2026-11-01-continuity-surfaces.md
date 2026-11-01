# 2026-11-01 延续性接入既有表面（ADR-0028，TF-0321 阶段二）

对象：VerseSpace / Workbench，基线 `257746f`。
前置：[会话延续性切片](2026-11-01-session-continuity.md)（ADR-0027）与
[会话生态规划](2026-11-01-session-ecosystem-plan.md)（TF-0314）。
本记录对应森林节点 TF-0321 / TF-0322 / TF-0323 / TF-0324 / TF-0325 / TF-0326 / TF-0327 / TF-0328。

## 1. 结论（先看三条）

1. **补完了 ADR-0027 明确留下的那一步**：延续性原来只住在 CLI 里，模型在回合中问不到、人在面板上看不到。现在 CLI / MCP 第六工具 / 恢复卡三处读**同一份投影**（`chat/continuity`），没有任何一处另算一遍。
2. **面板的取舍有判据，不是「多一个红点」。** 判据写成可执行代码（`chat/resume-card/continuity.ts`），被卡片测试直接引用：健康零新增、断点恰一行且钉在折叠之外、已恢复的中断不进卡片、积压只作头部一个计数。真实账本上 20/30 条会话带积压——这条判据就是防红点墙的。
3. **工具目录从「五」变成「六」是可测的**：新增表面漂移测试断言目录恰 6 条、逐条可调用、调用前后账本事件数不变；另有一份刻意硬编码的第二读法（`artifacts/projection.test.ts`）与它互相钉住。

## 2. 改了什么

| 文件 | 改动 |
| --- | --- |
| `packages/workbench/src/mcp/tools.ts` → `mcp/tools/` | 298 行单文件按仓库规则拆成模块目录：`types.ts`（形状与截断预算）、每工具一文件、`index.ts`（唯一目录表 + `MCP_TOOL_NAMES`）。六条工具的 name/description/schema/体积预算只在一处出现 |
| `mcp/tools/continuity.ts` | 第六个只读工具：三态读数 + `delivery` + `refs` 的子集；0/1/多条线程；线程不存在给可读错误；整段过 `truncate` |
| `mcp/tools/surface.test.ts` | **新增**表面漂移测试：6 条、顺序由 `MCP_TOOL_NAMES` 决定、描述含「只读」、逐条可调用、调用不写账本 |
| `chat/resume-card/continuity.ts` | **新增**卡片行判据（纯函数）：`continuityCardRows` → 行 + 头部积压计数 |
| `chat/resume-card/types.ts`、`index.ts` | `FactRow.source` 增加 `interruption`；`ResumeCardView.pinnedFacts`；`buildResumeCard` 接受 `continuityFacts` 并把断点行钉在事实区最前 |
| `chat/restore-view.ts` | 并行读账本（事件/通知只读一遍），把延续性投影折进卡片 + 下发 `continuityDelivery` |
| `chat/continuity/read.ts` | `readSessionContinuity` 接受调用方已读到的 `{ events, pending }`，一次 GET 不读两遍账本 |
| `chat/evidence.ts` | 证据接口支持 `event:<id>` 前缀（断点行的 refs 用它，一眼看出是事件引用） |
| `chat/thread-resume.ts`、`ui/chat-routes.ts`、`chat/branch-engagement.ts` | 展示观测从 `branchRows` 扩展为兼容的通用 `rows`，`branchRows` 保留为派生子集；旧客户端仍可只发 `branchRows` |
| `apps/workbench-ui/src/components/chat/resume-card*.tsx` | 断点行渲染（带 `resume-continuity-row` 标记）、`pinnedFacts` 不参与折叠、积压只作头部 `~ N` 徽标、展示观察按恢复边界去重并覆盖两类行 |
| `apps/workbench-ui/src/chat/{store,store-types,resume-types,refresh-thread,resume-slice}.ts` | `continuityDelivery` 状态与下发、`pinnedFacts?`/`interruption` 类型 |
| `packages/workbench/src/artifacts/projection.test.ts` | 工具目录硬编码清单增加 `continuity`（第二读法） |
| `docs/decisions/0028-continuity-surface-integration.md` | **新增** ADR（含行判据表与不做的事） |
| `docs/decisions/README.md`、`README.md`、`packages/workbench/README.md` | 索引行、ADR 范围 0001–0028、工具数 6、拆包后的路径 |
| `evidence/claims.json`、`evidence/readings/claim-continuity-surfaces.json` | 新声明与读数（`--run` 真跑） |

## 3. 证据读数（本机实测，Windows / bun 1.3.14 / node v24.22.1）

| 命令 | 结果 |
| --- | --- |
| `bun run lint` | exit 0（829 files，仅 1 条 info） |
| `bun run typecheck` | exit 0（三个包） |
| `bun test src/chat/resume-card/continuity.test.ts` | **12 pass / 0 fail** |
| `bun test src/mcp/tools src/mcp/tools.test.ts` | **13 + 7 pass / 0 fail**（目录 6 条、逐条可调用、截断、continuity 三形态） |
| `bun test src/artifacts/projection.test.ts` | **5 pass / 0 fail**（三处表面一致） |
| `bun test src/chat` 相关（restore-view / resume-card / continuity） | 36 pass / 0 fail |
| `bun run test:workbench` | **1273 pass / 1 fail**（该条见下，非本切片） |
| `bun run test:workbench-ui` | **78 pass / 0 fail**（20 files） |
| `bun run test:context-rot` | 69 pass / 0 fail |
| `bun run test:gates` | 52 pass / 0 fail |
| `bun packages/workbench/src/index.ts doctor` | exit 0（118 条架构断言，0 失效） |
| `node scripts/moat/check-scope-adr.mjs` | `clean`（15 项 / 0 failures）；其自身负向测试 5 pass |
| `node scripts/check-upload-surface.mjs` | 0 违规（上传面 1049 文件，断链 0） |

**真实账本四面对照**（临时工作区 `D:\tmp\wb-continuity-*`，`workbench init` 后造两条会话：一条 status 停在 `running`、一条有问有答）：

```
重启清扫：reconcileRunningOnStartup() → 1（先落 thread.turn_interrupted，再复位 idle）
CLI:       ! 被切断的会话 … 中断（host-restarted，1 条消息），之后没有助手回复
           - 正常收尾的会话
CLI --json: state=review · refs=["e-f7015477023122c4"] · delivery.pendingNotices=0
MCP 列表:  共 2 条会话：无待办观察 1 · 需要人看一眼 1 · 有未投递通知 0
MCP 详情:  中断：…（host-restarted，1 条消息）· 之后没有回复；可核对：e-f7015477023122c4
恢复卡:    pinned=1 · rows=[{source:"interruption", refs:["event:e-f7015477023122c4"]}] · 健康会话 card=null
```

四处读数一致；健康会话在卡片上**不渲染**（`card: null`），符合「健康不占空间」。

**哪些读数在本机无效、为什么**（不是本切片引入）：

- `test:workbench` 第一轮整体跑出 8 条失败。其中 **3 条是本切片引入的真实漂移**：`CLI, read-only MCP and real restore HTTP agree for current/stale/unknown` 硬编码了五条工具清单——已修（清单加 `continuity`）并单独跑绿（5 pass / 0 fail）。另 5 条（claude 静默挂死、codex 车道端到端、空闲关闭、前提通知折入 codex prompt、回合中压缩）是 AGENTS.md 记录的 spawn 类用例在整套并行下的超时。
- 在修好那 3 条、并跑完全部提交后，再完整重跑一次：**1273 pass / 1 fail**。唯一一条是 `spawnSupervised > pid registry records a running process and reapOrphans kills it`（supervisor 测试，需要 spawn 一个 sleeper 子进程，本切片没有改动 `src/supervisor/**`——`git diff 257746f -- packages/workbench/src/supervisor packages/workbench/src/fs` 为空）。
- **测量方式（不是假设）**：这类用例单独跑时全绿——那 3 个文件 13 pass / 0 fail，`src/supervisor` 连跑 3 次都是 23 pass / 0 fail。同样的命令、同样的结果，说明是整套并行时的负载抖动。没有把任何一条写成「通过」。
- 没有跑：Playwright 浏览器套件、`bun run build:all`、`test:build`、真机 provider E2E（ADR-0024 与 AGENTS.md 的既有边界）。

## 4. 刻意没做什么

- **没新增判据。** 三态与「中断之后有无助手回复」仍是 ADR-0027 那一条；本切片只把它搬到两个表面，`derive.ts` 未改判定逻辑。
- **没做自动动作。** 没有重跑、重投、归档、修复；`review` 不触发任何调用。卡片上那一行只是事实。
- **没把积压并进 state。** 只在卡片头部给一个计数，且卡片本来不渲染时它也不出现。
- **没引入授权/派工概念**（TF-0332）：没有 Mandate / Ticket / Assignment。
- **没改 `reload` / `fork` / 跨 provider 语义**；没复活 Tauri / Rust / sidecar / CI。
- **没声称会话正确或真人收益**：`intact` 只说明没观察到需要人处理的事实。

## 5. 下一步与遗留风险

1. **TF-0329 / TF-0330 / TF-0331（阶段三）仍 `proposed`**：中断原因细分（provider-exit / user-kill / host-crash）与「断点 × 前提积压」联合判读视图。当前 `reason` 只有生产者写入的 `host-restarted`，其它取值尚无真实观测——按判据应记 `unknown` 而不是就近归类。
2. **TF-0332（风险）**：本轮及后续一轮不得引入授权/派工概念。本切片未引入。
3. **TF-0333**：`check-claims` 的 stale 集合收敛到 7 条，全部是本机**不可测**的：`claim-workbench-suite`（整套并行下有 1 条 spawn 类抖动，无法把 1273/1 写成 fail=0）、`claim-browser-e2e`（Playwright）、`claim-built-shapes`（需完整 build）、4 条 `codex-*`（需 codex 车道）。本轮新增声明 `claim-continuity-surfaces` 与其余 28 条已 `--run` 真跑并通过。
4. **TF-0334**：provider 会话身份缺失时 `unknown` 只能回指「缺 claude/codex session id」这条事实，不能推断原因。
5. **面板上的断点行没有真人读数**：谁看、看不看、看完做什么，仍未有观测（ADR-0024 不恢复真人研究）。

## 6. 复核命令（复制即跑）

```bash
# 本切片
cd packages/workbench && bun test src/chat/resume-card/continuity.test.ts --timeout 60000
cd packages/workbench && bun test src/mcp/tools src/mcp/tools.test.ts --timeout 60000
cd packages/workbench && bun test src/artifacts/projection.test.ts --timeout 60000
cd apps/workbench-ui && bunx vitest run src/components/chat/resume-card.test.tsx

# 门禁
bun run lint && bun run typecheck && bun run test:gates
node scripts/moat/check-scope-adr.mjs --json
node scripts/check-upload-surface.mjs
bun packages/workbench/src/index.ts doctor

# 真实账本四面（在任何已初始化的工作区里）
bun packages/workbench/src/index.ts sessions continuity
bun packages/workbench/src/index.ts --json sessions continuity <threadId>

# 声明
node scripts/check-claims.mjs
```
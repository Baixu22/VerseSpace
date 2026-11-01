# 2026-11-01 中断原因与断点×积压联合判读（ADR-0029，阶段三）

对象：VerseSpace / Workbench，基线 `1460efb`。
前序：[会话延续性切片](2026-11-01-session-continuity.md)（ADR-0027）、
[延续性接入表面](2026-11-01-continuity-surfaces.md)（ADR-0028）。
本记录对应森林节点 TF-0329 / TF-0330 / TF-0331 / TF-0332 / TF-0334。

## 1. 结论（先看三条）

1. **不猜原因。** 账本里能区分「宿主被杀 / 崩溃 / 重启」的字段不存在：启动清扫看到的只有 `status === "running"`。所以 `reason` 只保留 `host-restarted`（生产者的位置）与 `unknown`（没记录），**没有**加入 `provider-exit` / `user-kill` / `host-crash`——加了就是把猜测写成事实。
2. **修掉一个真假阳性。** 用户自己按停的那一轮，此前与「被切断」完全同形（末条是人类消息、没有回复），于是「我停了它」被读成「需要你处理」。现在 `cancel` 落一条 `thread.turn_cancelled`，投影据此把它排除出待办。真实账本上验证过：主动停 = 无待办观察；问了没答 = 需要人看一眼。
3. **断点与积压有明确顺序，但不合并成分数。** `priority` 三态（`break-first` / `backlog-only` / `neither`）只依赖已有的两维事实；CLI、MCP、恢复卡三处同源。

## 2. 改了什么

| 文件 | 改动 |
| --- | --- |
| `packages/workbench/src/types/event.ts` | 新增线程事件 `thread.turn_cancelled`（观察类，禁判词表照常生效） |
| `packages/workbench/src/chat/thread-lifecycle.ts` | `cancel` 改为可 `await`：确实有在跑的回合时落 `thread.turn_cancelled`（`source: "user"` / `atMessageCount` / 末条消息身份），没有则不写；写失败只报错不影响 abort |
| `packages/workbench/src/chat/threads.ts` | `cancel` 返回 `Promise<boolean>`（是否真的停了东西） |
| `packages/workbench/src/chat/continuity/types.ts` | `ContinuityCancellation`；`ContinuityPriority`；`ContinuityUnknown { text, pointer }` + `unknownLine()`；`ContinuityInterruption.userStopped` |
| `packages/workbench/src/chat/continuity/read.ts` | 一次收集两类观察（`turn_interrupted` / `turn_cancelled`），中断带 `userStopped`；原始事件只过滤一次 |
| `packages/workbench/src/chat/continuity/derive.ts` | 用户主动停不进 `because`；末条人类消息若被终止观察解释也不再报；`priority` 三态；每条 unknown 带 pointer |
| `packages/workbench/src/commands/session-continuity.ts` | 详情打印「联合判读」「用户终止」；unknown 带可核对指针；列表汇总加两维计数 |
| `packages/workbench/src/mcp/tools/continuity.ts` | 同上（MCP 面） |
| `packages/workbench/src/chat/resume-card/continuity.ts` | `ContinuityCardProjection.priority` |
| `packages/workbench/src/chat/restore-view.ts` | `continuityDelivery` 增加 `priority` |
| `apps/workbench-ui/src/chat/{store-types,refresh-thread}.ts` | 承接 `priority`（旧载荷缺省 `neither`） |
| `apps/workbench-ui/src/components/chat/resume-card.tsx` | 积压徽标按联合判读换措辞（仍只占头部一个计数） |
| `packages/workbench/src/chat/continuity.test.ts` | 现场用例：`cancel` 落观察、无在跑回合不写、投影排除、对照组仍 review |
| `packages/workbench/src/chat/continuity/derive.test.ts` | **新增** 15 条：原因取值、userStopped、四组合判读、unknown 指针 |
| `packages/workbench/src/chat/resume-card/continuity.test.ts` | 四组合的卡片判据 |
| `docs/decisions/0029-interruption-cause-and-joint-reading.md` | **新增** ADR |
| `docs/decisions/README.md`、`README.md`、`packages/workbench/README.md` | 索引行、ADR 范围 0001–0029、MCP 工具描述 |

## 3. 证据读数（本机实测，Windows / bun 1.3.14 / node v24.22.1）

| 命令 | 结果 |
| --- | --- |
| `bun run lint` | exit 0（831 files，仅 1 条 info） |
| `bun run typecheck` | exit 0（三个包） |
| `bun test src/chat/continuity/derive.test.ts` | **15 pass / 0 fail** |
| `bun test src/chat/continuity.test.ts` | **13 pass / 0 fail** |
| `bun test src/chat/resume-card/continuity.test.ts` | **13 pass / 0 fail** |
| `bun test src/mcp/tools src/mcp/tools.test.ts` | 13 pass / 0 fail |
| `bun run test:workbench` | **1285 pass / 1 fail**（该条见下，非本切片） |
| `bun run test:workbench-ui` | **78 pass / 0 fail**（20 files） |
| `bun run test:gates` | 52 pass / 0 fail |
| `node scripts/moat/check-scope-adr.mjs` | `clean`（15 项） |
| `node scripts/check-upload-surface.mjs` | 0 违规 |

**真实账本读数**（临时工作区，同一进程里造两种会话）：

```
用户主动停下（cancel 一个有在跑的回合）
  MCP: - <id> - 无待办观察 用户主动停下
       详情：联合判读：无待办 / 用户终止：…（当时 1 条消息）/ 可核对：e-…
问了没答（没有终止观察）
  MCP: - <id> ! 需要人看一眼 问了没答 · 回合在 … 中断（host-restarted，0 条消息），之后没有助手回复
       详情：联合判读：先看断点
CLI 汇总：共 4 条会话：… 其中先看断点 2 · 只有投递积压 0 · 无待办 2
```

两种会话在四个面（CLI / CLI `--json` / MCP / 恢复卡）读数一致。

**哪些读数在本机无效、为什么**：

- `test:workbench` 整体跑出 1 条失败：`spawnSupervised > pid registry records a running process and reapOrphans kills it`（supervisor 用例，需要 spawn sleeper 子进程）。本切片未改动 `src/supervisor/**`。**测量方式**：该目录单独连跑 2 次都是 **23 pass / 0 fail**，说明是整套并行时的负载抖动，不是回归。没有写成通过。
- 未跑：Playwright 浏览器套件、`bun run build:all`、`test:build`、真机 provider E2E（ADR-0024 与 AGENTS.md 既有边界）。

## 4. 刻意没做什么

- **没加 `provider-exit` / `user-kill` / `host-crash` 枚举。** 账本没有能区分它们的字段；TF-0330 的前置条件（先有可绑定事件的真实信号）没满足，就不加。
- **没推断因果。** 不写「模型变慢导致超时」这类结论。
- **没改取消语义。** `cancel` 仍是 abort / 树杀，只多了一条观测；`remove` / `reload` 里的调用改成 `await` 只为让观测落盘先于下游读取。
- **没把两维合并成分数**，也没引入加权健康分。
- **没引入授权/派工概念**（TF-0332）：全仓无 Mandate / Ticket / Assignment（`grep` 只有两处无关的词）。
- **没复活 Tauri / Rust / sidecar / CI**，也没恢复非 Windows 实机或真人研究（ADR-0024）。

## 5. 下一步与遗留风险

1. **原因细分的真实样本仍为 0**：本机真实账本 `thread.turn_interrupted` 事件数为 0（测量：对 `.workbench/events/events.jsonl` 统计）。要细分原因，必须先让宿主真的在回合中途死掉并留下样本；在那之前 `unknown` 是诚实的答案。
2. **TF-0333**：`check-claims` 的 stale 集合从 7 条降到 **5 条**——本轮实测发现其中两条其实能测：
   - `claim-built-shapes`：`bun run build && bun run test:build` 实跑 exit 0（native + js 两种形态都通过），已 `--run` 记录。
   - `claim-browser-e2e`：`pwsh -NoProfile -File scripts/win/e2e-browser.ps1`。第一次跑 15 条全失败，原因是 **Playwright 浏览器构建缺失**（`browserType.launch: Executable doesn't exist at …chromium_headless_shell-1223`），`bunx playwright install chromium` 装上后重跑 **15 passed**，已 `--run` 记录。

   剩下 5 条**逐条**说明为什么本机不能给出合规读数：

   | 声明 | 本机实测 | 为什么不能记录 |
   | --- | --- | --- |
   | `claim-workbench-suite` | 整套并行跑：**1285 pass / 1 fail**；`src/supervisor` 单独连跑 2 次：**23 pass / 0 fail** | 声明 `expected.fail = 0`。唯一失败是 `spawnSupervised > pid registry…` 这条 spawn 类用例在整套并行下的抖动，本机拿不到稳定的 fail=0，就不写 |
   | `claim-codex-native-approval-control` | 未跑 | 本机 `codex --version` = **0.165.0-alpha.1.2**；该声明的读数是在 **0.164.0-alpha.11.1** + 专用隔离 profile（`.agent-contexts/all-nodes-relay-2026-10-26/codex-profile-approval`）上取的。换版本重跑会悄悄改变声明衡量的对象 |
   | `claim-codex-readonly-approval-control` | 未跑 | 同上（版本与 profile 绑定） |
   | `claim-codex-native-seal-current-gap` | 未跑 | 同上；且它判的是「**应当**未封印」的反向对照，换版本后要么变成另一种结论、要么无法复现 |
   | `claim-codex-live-lifecycle` | 未跑 | 同上 |

   这 5 条仍是 `stale`，**没有用 0 代替**，也没有为了让门禁变绿而放宽判据。
3. **面板上没有真人读数**：断点行与联合判读谁看、看完做什么，仍无观测（ADR-0024 不恢复真人研究）。
4. **`cancel` 的 await 化**：`remove` / `reload` 现在会等终止观察落盘（毫秒级）。如果将来发现取消变慢，先量再改——不要为了快把观测改回 fire-and-forget，那会让「按停」重新变成不可核对。

## 6. 复核命令（复制即跑）

```bash
cd packages/workbench && bun test src/chat/continuity/derive.test.ts --timeout 60000
cd packages/workbench && bun test src/chat/continuity.test.ts --timeout 60000
cd packages/workbench && bun test src/chat/resume-card/continuity.test.ts --timeout 60000
cd packages/workbench && bun test src/mcp/tools src/mcp/tools.test.ts --timeout 60000

bun run lint && bun run typecheck && bun run test:gates
node scripts/moat/check-scope-adr.mjs --json
node scripts/check-upload-surface.mjs
bun packages/workbench/src/index.ts doctor

# 真实账本
bun packages/workbench/src/index.ts sessions continuity
bun packages/workbench/src/index.ts sessions continuity <threadId>
node scripts/check-claims.mjs
```
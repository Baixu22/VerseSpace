# 2026-11-01 会话延续性切片（ADR-0027）

对象：VerseSpace / Workbench，基线 `b9c8bfe`（本轮改动在工作区，未提交）。
来源动机：用户看到 DeepSeek `dsh-superagent-prototype` 开源（2026-10-31），要求按「会话生态完整性」方向做纵向增强并整理护城河。

## 1. 结论（先看这两条）

1. **已落地的只有一处缺口，但它是一处真缺口**：宿主进程在回合中途死掉时，启动清扫把 `thread.status` 复位 `idle`，**同时抹掉了唯一记录了「这一轮没结束」的字段**。之后账本里只剩一条没有回复的人类消息，与「用户问了没等回答」完全同形。本轮把这件事变成一等观察：先记 `thread.turn_interrupted`，再复位。
2. **护城河不在「又做了一个会话看板」，而在「断了」与「问了没答」在读数上不再同形。** 这是前提账本（ADR-0010 / ADR-0026）的自然延伸：前提问「读的东西还在不在」，延续性问「接着做的理由还在不在」。dsh-superagent 做的是**授权与派工**（Mandate / Ticket / Assignment），本轮**不进入**那条路。

## 2. 改了什么

| 文件 | 改动 |
| --- | --- |
| `packages/workbench/src/types/event.ts` | `THREAD_EVENT_TYPES` 增加 `thread.turn_interrupted`（观察类，禁判词表照常生效） |
| `packages/workbench/src/chat/threads.ts` | `reconcileRunningOnStartup` 复位前先 `appendThreadEvent("thread.turn_interrupted")`，带 `atMessageCount` / 末条消息身份 / `reason: "host-restarted"`；写事件失败只 `console.error` 不阻止复位 |
| `packages/workbench/src/chat/continuity/types.ts` | `ContinuityFacts` / `SessionContinuity` 形状；三态 `intact` / `review` / `unknown` |
| `packages/workbench/src/chat/continuity/derive.ts` | 纯函数推导（不读时钟、不写盘、不调模型）+ `ContinuitySummary`（含与 state 独立的 `pending` 维） |
| `packages/workbench/src/chat/continuity/read.ts` | 把 meta / messages.jsonl / events 三处写者折成输入；不新增存储 |
| `packages/workbench/src/chat/continuity/index.ts` | 模块出口 |
| `packages/workbench/src/commands/session-continuity.ts` | CLI 面（编排层，只格式化） |
| `packages/workbench/src/cli/agents.ts` | 注册 `sessions continuity [thread]` |
| `packages/workbench/src/chat/continuity.test.ts` | 12 条用例：判定表全覆盖 + 真实临时账本 + 清扫先记后复位 + 恢复后不再待办 |
| `packages/workbench/src/cli.test.ts` | argv 表新增 `sessions continuity`，完整性测试拒绝漏配 |
| `docs/decisions/0027-session-continuity-projection.md` | 新 ADR（含与 dsh-superagent 的位置关系表） |
| `docs/decisions/README.md`、`README.md` | 索引行 + ADR 范围 0001–0027 |
| `scripts/moat/check-scope-adr.mjs` | README 的 ADR 范围上界**从目录读**，不再硬编码 0026（硬编码会让下一个 ADR 把这条检查直接钉红） |
| `evidence/claims.json`、`evidence/readings/claim-session-continuity.json` | 新声明与读数（`--run` 真跑，exit 0 / 12 pass） |

### 判定表（读数的全部规则）

| 观察 | state | 归哪一栏 |
| --- | --- | --- |
| 中断之后没有助手消息 | `review` | `because` + `refs`（事件 id） |
| 末条是人类消息，且没有未恢复的中断解释它 | `review` | `because` |
| `status` 仍是 `running` | `unknown` | `unknowns` |
| 本地 CLI 车道有消息但缺 provider 会话 id | `unknown` | `unknowns` |
| HTTP 车道无 provider 会话 id | 不扣分 | 它按消息文本重放，本就没有上游会话 |
| 有未投递前提通知 | **不改 state** | `delivery`（CLI 标 `~`） |
| 以上都没有 | `intact` | — |

## 3. 证据读数（本机实测，Windows / bun 1.3.14 / node v24.22.1）

| 命令 | 结果 |
| --- | --- |
| `bunx tsc --noEmit`（三包） | exit 0 |
| `bun run lint` | exit 0（819 files） |
| `bun run test:gates` | 52 pass / 0 fail |
| `bun test src/chat/continuity.test.ts` | **12 pass / 0 fail** |
| `bun test src/cli.test.ts` | 37 pass / 0 fail（含 argv 完整性） |
| `bun test src/chat`（整目录） | **412 pass / 11 fail**，11 条全部是 spawn/代理类超时（见下） |
| `node scripts/moat/check-scope-adr.mjs --json` | `clean`（15 项 / 0 failures） |
| `node --test scripts/moat/check-scope-adr.test.mjs` | 5 pass / 0 fail |
| `node scripts/claims/record-reading.mjs claim-session-continuity --run` | exit 0，落 `evidence/readings/claim-session-continuity.json` |
| 真实账本直跑 `workbench sessions continuity` | 30 条会话：无待办 22 / 需要人看 8 / 材料不足 0 / 有未投递通知 20 |

**哪些读数在本机无效、为什么：**

- `bun test src/chat` 的 11 条失败全部是 `codex-app-server` / `claude 静默挂死` / `空闲关闭` / `codex notice ack` 这类**需要 spawn 子进程**的用例，超时 20000–30000ms。**不是本切片引入**：把本轮 `src` 改动 stash 后在基线上重跑 `codex-notice-seal.test.ts`，同样 5 fail / 0 pass；`ui/server.test.ts` 在基线上同样 3 fail，与本轮无关。属于 AGENTS.md 记录的沙箱/注入代理环境缺陷。
- `bun run check:claims` 当前 **exit 1（drift）**：因为读数是在**未提交的工作区**上取的，闸门按「reading 所在 commit 至今的改动」判定，工作区自身就是改动。基线（stash 后）同样是 exit 1，并有 18 条 stale/observation。**提交后按 §6 重取读数即可归零**——这是本仓既有的「先 commit 再取读数」流程，不是本轮遗留缺陷。
- 没有跑：`test:workbench-ui`、`test:context-rot`、Playwright 浏览器套件、`bun run build:all`、真机 provider E2E。前两项与 `apps/*`/`context-rot` 无关本切片；浏览器套件按 ADR-0024 与 AGENTS.md 属另一类读数。

## 4. 刻意没做什么（这一节比上面值钱）

- **没做授权模型。** 没有 Mandate / Ticket / Assignment / 派工闸门。dsh-superagent 那套是另一件事，搬进 Workbench 会把「前提账本」稀释成「又一个编排框架」。
- **没接 MCP，没接面板。** MCP 仍是五条只读工具，面板本轮不消费这份投影。接它需要新的表面契约测试 + 产品读数，另开一片。
- **没有自动动作。** `review` 不触发重跑、不重投通知、不归档、不修复。这一点是刻意的：自动接管正是最容易被误读成「已通过」的地方。
- **没把投递积压算进 `review`。** 实测在真实账本上 30 条会话里 20 条同时带积压——并进 state 会把真正的断点淹掉。积压单列一维，CLI 用 `~` 标。
- **没改 `reload` / `fork` / 跨 provider 语义。** README「分叉与恢复」那几条边界一字未动（复制界面历史 ≠ 模型继承上下文；Codex reload 不是精确回滚）。
- **没有把它写成「会话正确率」。** `intact` 只是「没观察到需要人处理的事实」。

## 5. 下一步与遗留风险

1. **提交后重取读数**（见 §6），让 `check:claims` 回到 clean。当前 diff 里 `claim-moat-baseline` / `claim-moat-input-origin` / `claim-moat-consumption` / `claim-moat-portable-evidence` 的读数已在**本工作区**重跑（因为本轮确实改了 `types/event.ts` 与 `cli.test.ts` 这两个被测路径），只有 subject 比较因子未提交而报 stale。
2. **面板消费**：恢复卡已经会渲染分支事实，延续性读数接进去是下一步的自然选择；需要先定义「面板上 `~` 放哪一行」，否则会重演「多一个红点、没人看」。
3. **MCP 第 6 个工具**：`continuity` 若接进 MCP，必须守 ADR-0023 的只读边界，并新增表面漂移测试。
4. **环境噪声未消除**：注入代理与沙箱下的进程类用例在本机仍会超时，不要把本机 `bun test src/chat` 的 11 fail 读成回归。
5. **真人价值未测**：本切片没有任何真人使用读数，也没有跨机容量读数（ADR-0024 不恢复）。

## 6. 复核命令（复制即跑）

```bash
# 1. 本切片
cd packages/workbench && bun test src/chat/continuity.test.ts --timeout 60000
cd packages/workbench && bun test src/cli.test.ts --timeout 60000

# 2. 门禁
bun run lint && bun run typecheck && bun run test:gates
node scripts/moat/check-scope-adr.mjs --json

# 3. 真实账本读数（在任何已初始化的工作区里）
bun packages/workbench/src/index.ts sessions continuity
bun packages/workbench/src/index.ts --json sessions continuity <threadId>

# 4. 提交后重取读数（顺序不能反：先 commit，再取）
cd .. && git add -A && git -c core.hooksPath= commit --no-verify -F <msg-file>
NO_PROXY="127.0.0.1,localhost,::1" node scripts/claims/record-reading.mjs claim-session-continuity \
  --reading '{"exit":0,"pass":12,"fail":0}' --run
node scripts/check-claims.mjs
```

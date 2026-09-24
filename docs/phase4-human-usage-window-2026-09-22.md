# 阶段 4：真实人类使用窗口操作指南（2026-09-22）

- 森林节点：TF-0251（阶段 4），目标 TF-0232
- 前置：阶段 3 已落地（codex 车道端到端可用，ADR-0017）；阶段 2 已把账本能力内嵌对话（PR #29）
- 状态：**不是本轮交付**（ADR-0019 将 TF-0251 转为常设外部门）。下面仍是将来真人窗口的路径。codex 车道不会产生 `seal.decided`。读数不能由脚本或 agent 代跑

## 为什么这一步不能自动化

fit 账本的四项护城河判决（`workbench stats --json` 的 `seal` / `landmarkReviews.current` /
`lifecycle.resumeCardCircuit` / `threads.footprintCoverage`）里，`landmarkReviews.current` 走
**human 口径**：只有真人的认可手势才会动这个分子（`stats.ts:200`，`denominator: "session-top-k"`，
`"human"`）。代理自审单独占 `steward` 一格，绝不并入 current。

这与已固化的来源纪律一致（[[workbench-fit-ledger-source-discipline]]）：脚本化手势永远不计入 L1，
L1 只在自然证据下移动。因此我把窗口做到端到端可用，但 `seal.decisions ≥ 1` 与恢复卡消费这两个
读数，必须由一次真实的人类使用产生。**agent 代跑会污染账本，等于把判据本身作废。**

## 一次窗口需要产生什么

| 读数 | 来源事件 | 如何自然产生 |
| --- | --- | --- |
| `seal.decisions ≥ 1`（且至少一次正确的 block） | `seal.decided`（`seal-counts.ts`） | 写操作必须经过已安装的 Claude Code PreToolUse hook（`workbench premises seal`）。codex 车道只自动接受权限，不调用 seal |
| 恢复卡消费 | `thread.resume_note_consumed` / `resumeCardCircuit`（`stats.ts:183`） | 离开一条线程、隔一段时间回来、消费它的恢复卡 |
| 人类地标认可 | 落笔过滤后的 landmark review（`review-stats.ts`） | 真人在会话里对某个改动落笔认可 |
| 足迹覆盖 | `sessions.footprint`（每线程） | 可观测车道的真实回合。codex 的读足迹来自 `commandActions[].path`；写动作没有夹具，不能当成已经保证 |

## 前置配置（一次性）

1. **装 codex CLI 并登录**（走 codex 自身会话，不需要 `OPENAI_API_KEY`）：
   ```bash
   codex --version            # 确认在 PATH 上
   codex login                # 或按 codex 文档完成登录
   ```
   若二进制不在默认名下，用 `WORKBENCH_CODEX_COMMAND` 指到它，例如
   `export WORKBENCH_CODEX_COMMAND="/abs/path/to/codex app-server -c notify=[]"`。

2. **把 provider 切到 codex**（`.workbench/workbench.yaml`）：
   ```yaml
   chat:
     provider: codex
   ```
   或用 CLI：`workbench config set chat.provider codex`（若已提供该子命令），
   否则直接编辑 yaml。默认仍是 claude，切过去只影响对话车道，不改账本结构。
   切到 codex 只能产生足迹，不能产生 seal。要 `seal.decided`，写操作必须发生在已安装 hook 的 Claude Code 里。

3. **装 seal hook**（PreToolUse 命门，唯一的运行时拦截点）：
   ```bash
   node packages/context-rot/scripts/install-hooks.mjs .
   ```
   确认 `.workbench/workbench.yaml` 里 `seal.mode: block`（默认）。`off` 只是不拦截，
   仍会记录 `seal.decided`；要产生「正确的 block」读数需要 `block` 或 `warn`。

## 跑一次窗口（真人操作）

以下每一步都由**你本人**在 `workbench ui` 或 CLI 里操作，不要让 agent 代跑：

1. `workbench ui` 打开面板，新建一条对话线程（provider = codex）。
2. 让 codex 读一个真实文件（例如"读 `packages/workbench/src/cli.ts` 并说明它注册了哪些命令组"）。
   这一步在账本里留下该文件的读足迹——面板的证据面或 MCP `footprints` 工具应能看到。
3. **在你之外改动那个文件**：换一个编辑器/终端，真实修改并保存 `cli.ts`（哪怕加一行注释）。
   这让第 2 步的读前提失效——`workbench premises pending` 应出现一条待投递通知。
4. **不要让 codex 写这个文件来制造 seal。** codex 对 `requestApproval` 一律 accept，
   不调用 `decideSeal`。回到 **Claude Code**（hook 已安装）再写那个文件。
   PreToolUse 跑 `workbench premises seal`，命中失效前提才产生 `seal.decided: block`。
5. **离开这条线程**（切到另一条，或 `workbench` 里 leave），隔一段时间**回来**，
   面板会呈现恢复卡；**消费它**（按恢复卡里的动作继续）。这产生 `thread.resume_note_consumed`。
6. 对本轮某个你**认可**的改动落笔认可（在面板的复核入口）。这动 `landmarkReviews.current`。

## 验收读数

窗口跑完后：

```bash
workbench stats --json | jq '{seal: .seal, resumeCards: .lifecycle.resumeCardCircuit, \
  resumeConsumed: .lifecycle.resumeNotesConsumed, landmarkHuman: .landmarkReviews.current, \
  footprintCoverage: .threads.footprintCoverage}'
```

达标条件（TF-0251）：

- `seal.decisions ≥ 1` 且 `seal.blocked ≥ 1`（出现过至少一次正确的 block）
- `resumeConsumed ≥ 1`（恢复卡被真实消费过）
- `landmarkReviews.current` 分母非空（有真人认可样本进入）
- `footprintCoverage > 0`（codex 线程留下了读写足迹）

也可核对同一批事实。CLI：`workbench premises pending`（看仍在等投递的失效前提）。
只读 MCP 工具（`workbench mcp`，见 CLAUDE.md）：`footprints`（看 codex 线程的读写声明）、
`premises`、`notices`（看通知投递结局）、`resume_cards`、`tribunal`。

## 收口

- 达标后，把 `workbench stats --json` 的相关读数与操作时间记进任务森林 TF-0251 的证据，
  由真人确认后再把该节点从 ready-for-human 收 done。
- 未达标不改判据阈值、不用脚本补数：判据的价值就在于它只认自然使用。

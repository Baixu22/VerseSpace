# 监控与验收报告：22 轮真实模型采样 + L1 分母修正（2026-09-11）

> 现场：`%TEMP%\workbench-e2e-live-tenant`（租户黑板）· 模型：`senseaudio-s2-flash`（`https://api.senseaudio.cn/v1`）
> 机读产物：`docs/fit-ledger.md`、`docs/fit-monitor.md`、租户 `runs/monitor-series.jsonl`、租户 `runs/history.jsonl`

## 1. 本批做了什么

| 序号 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 用 SenseAudio S2 Flash 继续累积真实采样（第 18–22 轮） | 5/5 轮全绿，累计 22 轮、失败 0 |
| 2 | 把监控做成可复跑的采样器（`scripts/fit-monitor.ts` + `monitor.ps1`） | 3 条样本入库，告警 5 条，其中 1 条真问题被抓出并修掉 |
| 3 | 修正 L1 的分母契约（投影回退表 → DOI>10 真地标） | 见第 4 节；回归用例两条改写并通过 |
| 4 | 给出 L1 的人评快速通道（复核队列，人只需回答 ≤5 条） | `scripts/e2e/landmark-review-queue.ts` |
| 5 | 按验收逐条核验五个 in_progress 节点 | 四个收口（TF-0120/0135/0136/0137）+ 要求节点 TF-0085 确认；TF-0057 只剩 AC3 的人评 |
| 6 | 给监控发现的标定问题立节点 | TF-0156（proposed）+ 标定扫描脚本 `landmark-calibration-sweep.ts` |

## 2. 本轮读数（22 轮批次）

| 项 | 实测 | 判据 | 结果 |
| --- | --- | --- | --- |
| t0 已开始 | 89 线程 / 95 写者 | > 0 | 是 |
| 样本窗口 | restores 48 / noticeOutcomes 127 / sealDecisions 25 | ≥ 3 / 5 / 3 | 齐 |
| 护城河 A 校准表行数 | 127 | ≥ 50 | 齐 |
| 护城河 B git/人的失效通知 | 1 | ≥ 1 | 齐 |
| 护城河 C 真实会话 seal block | 23（复核正确 19） | ≥ 1 | 齐 |
| 护城河 D notified / overlaps | 0.159（183 / 1150） | 10–30% | in-band |
| 判决一 恢复卡 | `supported`（consumed/restored = 22/48 = 0.4583、resumeActions 46、首动作 21/21 为恢复卡） | ≥ 0.3 且 > 0 | 通过 |
| 判决二 前提检测 | `supported`（agent 侧 dismissed/ignored = 0；L2 抑制 320、去重 647） | ≤ 0.5 / ≤ 0.1 | 通过 |
| 判决三 阶段 C | `supported`（44/89 线程分叉、真实继承 ≥ 1） | fork ≥ 5 且继承成立 | 通过 |
| 判决四 L3 | `insufficient-evidence`（结构性命中为零 → 已砍） | 有判据可满足 | 砍留已定 |
| fit 分布 | aligned 3 · partial 15 · weak 0 · misaligned 0 · unknown 9 | unknown 下降且可解释 | 通过 |
| 事件跨度 | 2.05 天 | 14 天为长期观察 | 见偏差 |

## 3. 监控抓到的三个问题与处置

1. **报告正文与机读账本不一致**（`report-prose-drift`，warn）。2026-09-10 的验收报告正文写「aligned 3 · partial 16 · unknown 6」，与快照表的「aligned 3 · partial 15 · unknown 9」不符；TF-0137 的证据里也抄了这串错数字。
   **处置**：更正报告正文并留更正说明（不再重写历史结论）；TF-0137 的证据文本按快照改写并加更正条；本批提案已应用。复跑监控后该告警消失。
2. **恢复卡耗时的 298× 是脚本手势**（`restore-latency`，warn）。E2E 的恢复步骤先断言恢复卡再发消息，差值来自脚本而不是人。
   **处置**：保持告警（它是"卡变重了"的工程信号），但在监控报告里注明本项由脚本驱动、不构成人类耗时证据，不推任何 fit。
3. **L1 的 0.739 是脚本常数，而且分母取错了集合**（`natural-pending` + 第 4 节）。
   **处置**：分母契约修正（代码 + 回归用例 + 偏差记录），把 0.8 判据从"结构性不可达"变成"可测量、待人回答"，并把粒度/覆盖问题立成 TF-0156。

## 4. L1 的完整链条：从 0.739 到 5 条真地标

**缺陷**：`currentLandmarkAcceptance` 用 `projectLandmarks` 的投影列表当地标集合，而该投影在没有真地标时会回退到可见集 top-N（`project.ts` 自己的注释写着「回退池里的可见目录不是地标」）。

**实测影响**（修前，租户）：分母 113 条中 108 条（96%）来自 27 个"一个真地标都没有"的写者；56/111（50%）是 `.` / `src` 这类容器。即使人把每个文件级地标都认可、把每个容器都否决，上限也只有 55/111 = 0.495 < 0.8 —— 这条判据当时**不可能被满足**，而它同时把"这个写者其实没有地标"藏了起来。

**修正**：分母改为 `computeDoi` 的 `landmarks`（DOI>10，出处 `positioning-v6.md` §11），新增 `interestFromEvents().landmarkHandles` 承载；投影仍用于显示。回归用例改写为钉住新语义：被显示但不是地标 → 不进分母；无地标写者 `total=0 / share=null`（不再借历史点赞通过验收）。

**修后读数**（租户）：地标 5 条 —— `src/alpha.ts`、`src/beta.ts`（各 DOI 32.2、编辑 21 次）、`git-main` 的 `.` 与 `src`、`editor-1` 的 `src/beta.ts`；已复核 3、认可 2、拒绝 1 → `endorsedShare` 0.4、`reviewedCoverage` 0.6。其中 3 条结论来自脚本手势，按纪律不计 fit；**待人群答 2 条**。

**人评通道**（脚本不可替代）：

```bash
cd packages/workbench
bun scripts/e2e/landmark-review-queue.ts --workspace "$env:TEMP\workbench-e2e-live-tenant"                # 看队列（5 条）
bun scripts/e2e/landmark-review-queue.ts --workspace "..." --template answers.json                       # 生成模板
# 把 verdict 填成 endorse / reject 后：
bun scripts/e2e/landmark-review-queue.ts --workspace "..." --apply answers.json                          # 回填 + 新读数
```

**暴露出的下一个问题**（TF-0156）：真地标里 2/5 是容器；标定扫描显示容器占比与阈值无关（floor=10 → 40%、floor=6 → 70%、floor=4 → 50%、edit=4&floor=6 → 54%），因为容器的高分来自 DOI 的父级传播；同时 95 个写者里只有 2 个产出地标（floor=4 时 20 个）。所以要让"核心进集合"得动粒度与覆盖，不是动阈值。

## 5. 节点收口与偏差

| 节点 | 结论 | 关键证据 |
| --- | --- | --- |
| TF-0120 里程碑 | done | 六条验收逐条对上子里程碑与判决（见节点 evidence） |
| TF-0085 要求 L0 | done | 22 轮里新增通道全部在对话之上/之下，首条消息前无新增步骤；ADR-0008 的"交互层只做加法" |
| TF-0135 阶段 D | done | ①基线与数据 ②L3 已延后并砍 ③unknown 20 → 9 且全部可解释 |
| TF-0136 判决门 | done | 判决一/二/三 supported、判决四 insufficient-evidence 并已砍 |
| TF-0137 账本 | done | 护城河四数字齐备非零、闸门开、分布更正 |
| TF-0154 地标通道 | done（证据更正） | 分母契约修正 + 回归用例 |
| TF-0057 总目标 | **in_progress（只剩 AC3 的人评）** | AC1/AC2 工程侧证据已齐；AC3 = 队列里那 2 条 |
| TF-0156 地标粒度与覆盖 | proposed（新） | 标定扫描 + 租户构成 |

偏差记录两条（`deviations/deviations.jsonl`）：

- `measurement_contract_error`：L1 分母曾取投影回退表。
- `schedule_rebase`：TF-0135/0136/0137 的"两周 / 第 30 天"按 TF-0141 判例改以样本量门判定，日期不伪造。

## 6. 复现命令

```bash
# 真实采样（默认 SenseAudio，凭据走 DPAPI）
packages/workbench/scripts/e2e/run-live.ps1 -Rounds 5          # 或 cd 租户后 bun scripts/e2e/run.ts --live --rounds 5

# 监控（采样 + 告警 + 趋势；--fail-on high 时告警会让退出码非 0）
packages/workbench/scripts/e2e/monitor.ps1 -Rounds 0 -Out docs/fit-monitor.md

# 账本（必须 cd 到租户，或传 --blackboard，否则会读到仓库自己的黑板）
cd "$env:TEMP\workbench-e2e-live-tenant"
bun D:\helmor-main\packages\workbench\scripts\fit-ledger.ts --evidence-kind live-model --scope D:\helmor-main

# 标定扫描
bun D:\helmor-main\packages\workbench\scripts\e2e\landmark-calibration-sweep.ts --workspace "$env:TEMP\workbench-e2e-live-tenant"
```

## 7. 还剩什么

1. **L1 的 2 条人评**（TF-0057 AC3）：人回答后 `--apply`，判据 ≥ 0.8 即可收口；当前 0.4 里含 3 条脚本结论，人重新回答会覆盖它们。
2. **TF-0156 地标粒度与覆盖**：按扫描数字定粒度规则（文件级）与覆盖目标，再改常量与投影，补测试。
3. **TF-0157 本机套件的两类红**（本轮做回归核验时发现，已立节点）：`bun test src/interactions src/chat src/cli scripts/fit-ledger scripts/fit-monitor` 得到 204 pass / 10 fail——fork 继承（TF-0131）4 例、追溯式分叉（TF-0093）1 例、通知通道（TF-0142）5 例；全量 `bun test` 还会停留（CPU 20 分钟不增长）。已确认与本次 L1 改动无关（revert 后同样失败）且与沙箱无关（测试进程内带管道 spawn 成功）。2026-09-07 报告里的"全量 569 pass / 0 fail"与今天之间的差异需要归因。
4. **长期观察**（不阻塞工程）：14 天日历窗口 2026-09-22 到期后复跑一次账本；恢复卡的人类耗时仍需 `--evidence-kind natural` 的现场。

> 本报告的"全绿"只指本轮实际跑过的范围：22 轮真实采样 5/5 全绿、`bun test src/interactions` 39 用例全绿、`bun test scripts/fit-monitor` 13 用例全绿、`bunx tsc --noEmit` 退出 0。第 3 条列出的 10 例红在此之前就是红的，未计入本轮读数。

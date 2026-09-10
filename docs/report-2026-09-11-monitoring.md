# 监控与验收报告：真实模型采样 24 轮 + L1 分母两次修正（2026-09-11）

> 现场：`%TEMP%\workbench-e2e-live-tenant`（租户黑板）· 模型：`senseaudio-s2-flash`（`https://api.senseaudio.cn/v1`）
> 机读产物：`docs/fit-ledger.md`、`docs/fit-monitor.md`、租户 `runs/monitor-series.jsonl`、租户 `runs/history.jsonl`

## 1. 本批做了什么

| 序号 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 用 SenseAudio S2 Flash 继续累积真实采样（第 18–24 轮） | 7/7 轮全绿，累计 24 轮、失败 0 |
| 2 | 把监控做成可复跑的采样器（`scripts/fit-monitor.ts` + `monitor.ps1`） | 5 条样本入库；本批共抓出 5 个真问题（见第 3、3b 节） |
| 3 | 修正 L1 的分母契约（投影回退表 → DOI>10 真地标） | 见第 4 节；回归用例两条改写并通过 |
| 4 | 跨 4 个现场标定，把 L1 分母的粒度收成**文件级** | 见第 4b 节；读数 0.4 → 0.3333 |
| 5 | 给出 L1 的人评快速通道（复核队列，人只需回答 ≤5 条） | `scripts/e2e/landmark-review-queue.ts`（现列 3 条文件级地标，待复核 2 条） |
| 6 | 按验收逐条核验五个 in_progress 节点 | 四个收口（TF-0120/0135/0136/0137）+ 要求节点 TF-0085 确认；TF-0057 只剩 AC3 的人评 |
| 7 | 给监控发现的标定问题立节点 | TF-0156（proposed，AC3 未满足）+ 标定扫描脚本 `landmark-calibration-sweep.ts` |

## 2. 本轮读数（24 轮批次）

| 项 | 实测 | 判据 | 结果 |
| --- | --- | --- | --- |
| t0 已开始 | 97 线程 / 103 写者 | > 0 | 是 |
| 样本窗口 | restores 50 / noticeOutcomes 133 / sealDecisions 26 | ≥ 3 / 5 / 3 | 齐 |
| 护城河 A 校准表行数 | 133 | ≥ 50 | 齐 |
| 护城河 B git/人的失效通知 | 1 | ≥ 1 | 齐 |
| 护城河 C 真实会话 seal block | 24（复核正确 19） | ≥ 1 | 齐 |
| 护城河 D notified / overlaps | 0.157 | 10–30% | in-band |
| 判决一 恢复卡 | `supported`（consumed/restored = 22/48 = 0.4583、resumeActions 46、首动作 21/21 为恢复卡） | ≥ 0.3 且 > 0 | 通过 |
| 判决二 前提检测 | `supported`（agent 侧 dismissed/ignored = 0；L2 抑制 320、去重 647） | ≤ 0.5 / ≤ 0.1 | 通过 |
| 判决三 阶段 C | `supported`（44/89 线程分叉、真实继承 ≥ 1） | fork ≥ 5 且继承成立 | 通过 |
| 判决四 L3 | `insufficient-evidence`（结构性命中为零 → 已砍） | 有判据可满足 | 砍留已定 |
| fit 分布 | aligned 3 · partial 15 · weak 0 · misaligned 0 · unknown 9 | unknown 下降且可解释 | 通过 |
| 事件跨度 | 2.07 天 | 14 天为长期观察 | 见偏差 |

## 3. 监控抓到的三个问题与处置

1. **报告正文与机读账本不一致**（`report-prose-drift`，warn）。2026-09-10 的验收报告正文写「aligned 3 · partial 16 · unknown 6」，与快照表的「aligned 3 · partial 15 · unknown 9」不符；TF-0137 的证据里也抄了这串错数字。
   **处置**：更正报告正文并留更正说明（不再重写历史结论）；TF-0137 的证据文本按快照改写并加更正条；本批提案已应用。复跑监控后该告警消失。
2. **恢复卡耗时的 298× 是脚本手势**（`restore-latency`，warn）。E2E 的恢复步骤先断言恢复卡再发消息，差值来自脚本而不是人。
   **处置**：保持告警（它是"卡变重了"的工程信号），但在监控报告里注明本项由脚本驱动、不构成人类耗时证据，不推任何 fit。
3. **L1 的 0.739 是脚本常数，而且分母取错了集合**（`natural-pending` + 第 4 节）。
   **处置**：分母契约修正（代码 + 回归用例 + 偏差记录），把 0.8 判据从"结构性不可达"变成"可测量、待人回答"，并把粒度/覆盖问题立成 TF-0156。

## 3b. 第二轮：采样入口的脚本缺陷 + 监控自己的三个假警报

再跑一轮累积（第 24 轮）时，`monitor.ps1 -Rounds 1` 在输出被管道接住的情况下**一行就退出**：脚本顶部是 `$ErrorActionPreference = 'Stop'`，而 PowerShell 5.1 会把原生命令写到 stderr 的每一行变成终止性 `NativeCommandError`——E2E 的进度行 `[e2e] ▶ seed: ...` 正好是 stderr，于是批处理死在那里、后面的监控根本没跑（而直接调用 `run.ts` 一切正常，这也是它一直没被发现的原因）。

- **修**：两处 `& bun` 调用在本地把偏好降成 `Continue` 并显式检查 `$LASTEXITCODE`，退出码语义不变（`scripts/e2e/monitor.ps1`）。
- **验证**：`./monitor.ps1 -Rounds 1 2>&1 | Select-Object -Last 14` 现在能完整跑完一轮 + 监控（累计 24 轮，失败 0）。

同一次运行暴露了监控自己的三个假警报，都按"信号要真"的原则收敛了：

| 假警报 | 根因 | 收敛方式 |
| --- | --- | --- |
| `report-prose-drift` 把已更正的报告报成漂移 | 判据只认「第一条声明」且要求 `partial` 紧邻 `unknown`，而正文里正确的写法是 `aligned 3 · partial 15 · weak 0 · misaligned 0 · unknown 9`（中间夹着 weak / misaligned），只剩一句解释历史的错数字被当成声明 | 逐行取三个标签各自的数字；**只要有一条与账本一致就算已更正**，一条都不一致才报 |
| 换一个现场跑监控就报两条漂移（`snapshot-drift` / `report-prose-drift`） | 账本与报告落在仓库 `docs/` 下，监控却可以指向任意现场，跨现场比对必然不一致 | 文档必须自己说明现场（正文含该现场目录名）才纳入比对 |
| `sampling-stalled` 在连着刷新两次报告时报警 | 只要两次样本没累积就报，但"同一批数据连跑两次监控"本来就什么都不变 | 两次采样的 `at` 间隔 ≥ 10 分钟才判定为"监控在空转" |
| `restore-latency` 在脚本现场报 warn | 该比值的分子分母都由脚本顺序决定（恢复后先断言卡再发消息） | 非自然来源降为 `info`（数字照常显示），自然现场仍为 `warn` |

收敛后：租户现场**只剩 4 条 info 告警、0 warn / 0 high**（模型层可恢复错误 `http-error×3 / invalid-response×2 / invalid-json×9` 由有界重试兜住，未造成任何跑次失败）；零地标现场则稳定报出新增的 `landmark-set-empty` warn。

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

### 4b. 跨现场标定：3/4 现场的地标集合是空的（同日第二轮）

把标定扫描从租户扩到本机另外三个真实现场（都是真实模型跑过的租户，写者 13–103 个）：

| 现场 | 写者 | 出厂参数地标 | 容器占 | 文件级 | 触发写者 | floor=4 仍是空集？ |
| --- | --- | --- | --- | --- | --- | --- |
| `workbench-e2e-live-tenant` | 103 | 5 条 | 40% | 3 | 2 / 无 76 | 否（52 条，容器 52%） |
| `workbench-node-verified` | 32 | **0 条** | — | 0 | 0 / 无 32 | **是** |
| `workbench-e2e-LHA3I4` | 16 | **0 条** | — | 0 | 0 / 无 15 | **是**（所有组合都 0） |
| `workbench-e2e-VAKSgQ` | 13 | **0 条** | — | 0 | 0 / 无 12 | **是**（所有组合都 0） |

三个结论：

1. **零地标是常态，不是样本不够**。出厂参数（DOI 衰减 + floor=10）要求写者在窗口内把同一条 handle 推很多次，而真实形状是"很多文件各碰一两次"，所以集合空掉。零地标现场 L1 无从计算 —— 这比"认可率低"更早失败。
2. **降阈值不是解法**。降到 floor=4 后两个现场仍然是空集；唯一非空的现场反而变成目录占 52%。目录占比随阈值下调而上升（`floor=6` 时 75%），因为父级传播把目录的分推得更高。
3. **粒度与阈值无关**。四种阈值组合下去重 handle 始终只有 4 个（`.`、`src`、`src/alpha.ts`、`src/beta.ts`）——阈值改的是"有几条触发"，不是"粒度有多细"。

**已落地的修正（本轮）**：L1 分母收成**文件级地标集合**（`interestFromEvents().fileLandmarkHandles`），`review-stats`、复核队列、标定扫描三处同步；目录不进分母但仍在 DOI 集合里，队列单独报"被排除了几条"作为标定信号。口径收紧后租户读数**从 0.4 掉到 0.3333**（分母 5 → 3，认可 1 / 3，待复核 2）——分母变小后更难达标，说明收口径不是为了把数字做好看。

**监控侧新增规则**：`landmark-set-empty`（有写者但地标集合为 0 → warn）。在 `workbench-node-verified` 现场实测触发：*写者 32 个，地标集合 0 条，待复核 0 条*。

**候选规则的测量（同日第三步，只测不改）**：标定扫描新增 `--top-k K`，测「每写者按 DOI 取文件级 top-K」这条相对选择规则。非空率被拉起来了——租户 78/103（空集 25 个是只有容器/git 触碰的写者）、节点验证 32/32、LHA3I4 15/16、VAKSgQ 12/13 —— **写者覆盖率 76% / 100% / 94% / 92%，AC3 的覆盖目标（≥50%）在四个现场都达标**。但同一个测量给了两条反证：① 真实现场里 DOI 普遍是**负分**（例 `src/alpha.ts(-13.0)`），于是 top-K 排的其实是"衰减最小的 K 个"，看起来由时间主导；② 103 写者 × top-3 = 174 条，批量人评不现实，而 v6 §11 的单位本来就是"一段会话结束后列该会话的地标集合"。**所以本轮不动 L1 的分母**。

### 4c. 会话时钟：判据不能被"问的时刻"改写（同日第四步）

L1 的分母是"该会话的地标集合"，而 DOI 的减项是 `(now − 事件时间)`——**按"现在"算的话，同一段会话的地标会随日期流逝自己跌到线下**：6 次编辑、发生在 3 天前 = 12 分，衰减 24 分 → −12。这不是产品变化，是判据不可复现。

- **修**：判定路径显式 opt-in 会话时钟（`interestFromEvents(records, writer, now, { clock: "session" })`），取该写者自己最后一条事件的时间；review-stats / 账本 / 标定扫描走它。**实时上下文显示仍按"现在"算**——那里的衰减是有意的（几天没碰的文件就该离开可见集），两条路径在代码里分开，默认值不变以免顺手改掉 L2 的语义。
- **测试**：同一份历史，会话时钟给地标、默认时钟给空集，隔一个月再问集合不变；退掉改动即红（0 pass / 1 fail），装上即绿（40 pass / 0 fail）。
- **无扰动**：租户 L1 读数换时钟前后都是 `地标 3 / 已复核 1 / 认可 1 → 0.3333`，待人回答的两条队列没有被搅动，只是从此可复现。

**实测的负结论（重要）**：把参考时刻换成会话时钟后，租户的出厂读数**不变**（5 条），节点验证从 0 条涨到 4 条，LHA3I4 与 VAKSgQ **仍是 0 条**；只有把阈值降到 floor=4 才明显变化（租户写者 24 → 47、节点验证 0 → 22）。所以——**地标集合空掉的主因不是衰减，而是"一条 handle 只被碰一两次（权重 1–2）对不上绝对阈值 10"**。这直接否掉了"调衰减/调时钟能救覆盖"的假设，把 AC3 收敛到唯一测出来非空的规则：相对选择 per-session top-K。

**自然现场目前不存在**：仓库自己的黑板 `D:\helmor-main\.workbench` 有 7 个写者、file 级交互事件为 0（四个阈值组合与 top-3 全空）——CLI 侧调用不产生 `interactions` 事件，本机唯一有交互数据的都是脚本租户。这是 AC3 拿自然证据的真正前提。

## 5. 节点收口与偏差

| 节点 | 结论 | 关键证据 |
| --- | --- | --- |
| TF-0120 里程碑 | done | 六条验收逐条对上子里程碑与判决（见节点 evidence） |
| TF-0085 要求 L0 | done | 24 轮里新增通道全部在对话之上/之下，首条消息前无新增步骤；ADR-0008 的"交互层只做加法" |
| TF-0135 阶段 D | done | ①基线与数据 ②L3 已延后并砍 ③unknown 20 → 9 且全部可解释 |
| TF-0136 判决门 | done | 判决一/二/三 supported、判决四 insufficient-evidence 并已砍 |
| TF-0137 账本 | done | 护城河四数字齐备非零、闸门开、分布更正 |
| TF-0154 地标通道 | done（证据更正） | 分母契约修正 + 回归用例 |
| TF-0057 总目标 | **in_progress（只剩 AC3 的人评）** | AC1/AC2 工程侧证据已齐；AC3 = 队列里那 2 条（分母 3，已认可 1） |
| TF-0156 地标粒度与覆盖 | proposed（AC1 已满足，AC2 半） | 四现场标定 + 文件级分母落码 |
| TF-0157 套件两类红 | **done**（两个根因，一个真 bug 已修，一个另立节点） | 见 3c 节：.cmd 垫片引号缺陷 + live-provider 通过后不退出 |
| TF-0158 e2e 进程不退出 | proposed（新） | live-provider.test.ts 7 例全绿后进程不退出；并行跑 e2e 段错误 |

偏差记录三条（`deviations/deviations.jsonl`）：

- `measurement_contract_error`：L1 分母曾取投影回退表。
- `schedule_rebase`：TF-0135/0136/0137 的"两周 / 第 30 天"按 TF-0141 判例改以样本量门判定，日期不伪造。
- `measurement_unit_refinement`：L1 分母从"DOI>10 的全部 handle"收成"文件级 handle"（四现场目录占 33–75%），读数 0.4 → 0.3333。

## 6. 复现命令

```bash
# 真实采样（默认 SenseAudio，凭据走 DPAPI）
packages/workbench/scripts/e2e/run-live.ps1 -Rounds 5          # 或 cd 租户后 bun scripts/e2e/run.ts --live --rounds 5

# 监控（采样 + 告警 + 趋势；--fail-on high 时告警会让退出码非 0）
# 输出被管道接住时也能完整跑完（3b 节修掉的脚本缺陷）
packages/workbench/scripts/e2e/monitor.ps1 -Rounds 3 -Out docs/fit-monitor.md

# 账本（必须 cd 到租户，或传 --blackboard，否则会读到仓库自己的黑板）
cd "$env:TEMP\workbench-e2e-live-tenant"
bun D:\helmor-main\packages\workbench\scripts\fit-ledger.ts --evidence-kind live-model --scope D:\helmor-main

# 标定扫描（任意现场；本机四个真实现场都在 %TEMP%\workbench-* 下）
bun D:\helmor-main\packages\workbench\scripts\e2e\landmark-calibration-sweep.ts --workspace "$env:TEMP\workbench-e2e-live-tenant"

# 零地标现场会报 landmark-set-empty：
cd packages/workbench
bun scripts/fit-monitor.ts --workspace "$env:TEMP\workbench-node-verified-032fd3ea64a74c539a5d9d8cfeb3bf37" --evidence-kind scripted --no-append
```

## 7. 还剩什么

1. **L1 的 2 条人评**（TF-0057 AC3）分两层：**内容检查**现在就能做——人回答队列里那 2 条（`src/alpha.ts`、`src/beta.ts`），两条都认可即 3/3 = 1.0；**自然证据**需要先在运行时里干一段真实活（产生 `interactions` 事件）再到那个现场跑 stats + 队列——本机目前没有自然现场（仓库自己的黑板交互事件为 0），所以即使答完，fit 仍会停在 `unknown`，这是纪律不是缺陷。
2. **TF-0156 的 AC3（非空与覆盖）**：已排除两条路——降阈值（floor=4 仍有两个现场空集，且目录占比升到 52–75%）与换时钟（本轮实测只把 node-verified 从 0 拉到 4，租户不变）。唯一测出来非空的是相对选择 per-session top-K（写者覆盖 76%/100%/94%/92%，已达标）。实现前要定两件事：K=3，以及排序用「会话时钟下的 DOI」（会话内事件相隔秒级，衰减几乎均匀，所以排序反映触碰权重而不是时间）；并保证**不搅乱 TF-0057 那两条待人回答的队列**（迁移时保留阈值口径的读数，账本同时报两个口径）。AC4 已收口（§11 口径四条 + 复现入口）。
3. **TF-0157 本机套件的两类红 → 已收口（两个独立根因）**：见 3c 节。10 例失败是**产品缺陷**（已修 + 回归用例），"全量停留"是 **Bun 进程通过后不退出**（已定位，另立 TF-0158）。全量总账：102 个测试文件里排除该文件的 101 个跑完，**627 pass / 0 fail / 85.22s**（对照 2026-09-07 的 569 pass：套件大了 58 例且不再停留）。

### 3c. 套件两类红的根因：一个真产品 bug + 一个 Bun 退出问题

**第一类：10 例失败 = Windows 上"路径带空格的 .cmd 垫片"必然启动失败（已修）**

假 claude 的 `argv.log` 不落盘，但 supervisor **确实 spawn 了**——失败在 cmd.exe 包装层。`.cmd/.bat` 垫片必须经 cmd.exe 执行，而原实现把"已给路径加引号"的整条命令行作为**单个 argv 元素**交给 spawn；Node/bun 会把元素内部的引号转义成 `\"`，cmd 不认这种转义（它把引号当分隔符），于是 cmd 看到的是带反斜杠的字面量路径，报「不是内部或外部命令」。只有路径带空格才触发——本机沙箱运行时在 `...\DoubaoWork\User Data\...\node\bun.cmd`，而 npm 全局垫片常见位置 `C:\Users\John Doe\AppData\Roaming\npm\` 同理。**产品侧影响比测试大**：这类 Windows 用户整条对话链路都是「agent 退出码 1」且没有任何诊断信息。

实测三条候选写法：直接 spawn `.cmd` 会 EINVAL（必须经 cmd.exe）；只给路径加一层引号时 `cmd /s` 会把那对引号剥掉、路径在空格处断掉；**再包一层引号 + 逐字传递（`windowsVerbatimArguments`）才是对的**。修复落在 `src/supervisor/index.ts`，回归用例放 `src/supervisor/index.test.ts`（带空格的临时目录装 `.cmd` 垫片，退掉修复即红）。结果：`bun test src/chat` **122 pass / 10 fail → 132 pass / 0 fail**，耗时 63s → 5.3s（此前假 agent 根本没起来，失败靠超时堆积）。

**第二类："全量停留" = live-provider.test.ts 通过后进程不退出（另立 TF-0158）**

`scripts/e2e/live-provider.test.ts` 的 7 个用例在 25ms 内全部通过，然后 Bun 进程**不退出**：没有总账、CPU 静止、没有残留子进程——正是此前记的"20 分钟 CPU 不增长、无输出"。单独跑如此；把 `scripts/e2e` 并行跑会升级成 Bun 段错误（`Segmentation fault at address 0xFFFFFFFFFFFFFFFF`，日志停在 `e2e.test.ts` 的 S7 之后）；`--concurrency 1` 跑到 S11 后同样没有总账。该文件 11 个 `Bun.serve` 都已在 `finally` 里 `stop(true)`，所以泄漏不在监听器上——按 Bun 运行时问题记录，不复用这个节点收口。

（同日第五步补正）挂起位置后来定位到**用例粒度**：该文件有 11 个用例，完整跑只报 7 个 pass；第 8 条（`transient HTTP 500 replies are retried like 502/503`）**单跑 2.04s 通过**，但用 `-t "in-flight request|transient HTTP 500"` 让第 7 条（in-flight 中止）先跑就会挂。也就是说根因在「中止流程遗留状态 + 带 signal 的退避定时器」的组合里，不是「测试文件整体泄漏」。

### 3d. 真实采样的失败率与模型层诊断（新增两轮 → 累计 26 轮）

第 25、26 轮跑完，累计 26 轮里**失败 6 次**（约 23%），本轮这次失败的原因是**模型层 invalid-json 重试用尽**。监控自己把它报了出来：`[high] round-failures · 本轮批次有跑次失败 — 失败跑次 5→6（累计 26 轮）`，另外 `model-error-outcomes` 统计到 `http-error×3、invalid-response×2、invalid-json×12`。这两个数字放在一起看，结论是**上游返回非 JSON 正文（网关页/截断流）是这个通道最不稳的一环**，而不是我们的编排逻辑：

- **处置**：invalid-json 与 HTTP 错误两类失败现在都带**结构指纹**（长度 / 形状 HTML|JSON 开头|其他 / 是否闭合 / content-type），既进错误信息也进尝试记录；正文本身仍然绝不回显（凭证与反射头安全）。这样下一次同类失败能直接判断「该退避换端点」还是「该抬 max_tokens」——本轮之前只能知道「无法解析」。
- **未处置**：失败率本身（23%）没有下降——本轮只提高了可诊断性，没有改变重试策略。降失败率（退避曲线、必要时换端点）是下一轮的问题，不能算作已解决。
4. **长期观察**（不阻塞工程）：14 天日历窗口 2026-09-22 到期后复跑一次账本；恢复卡的人类耗时仍需 `--evidence-kind natural` 的现场。

> 本报告的"全绿"只指本轮实际跑过的范围：24 轮真实采样 7/7 全绿、`bun test` 近全量 101 个文件 627 pass / 0 fail / 85.22s、`bunx tsc --noEmit` 退出 0、`biome check` 无发现。唯一排除的 `scripts/e2e/live-provider.test.ts` 自己的 7 例也是绿的，只是 Bun 进程通过后不退出（TF-0158）。

# 探测报告：负样本注入 + 五个真问题的揭开（2026-09-08）

前一轮把 live-tenant 账本刷到三门/四判决全绿之后，本轮目的不同：**用可控脚本向 live-tenant 注入负样本**（多写者、reject、incorrect），看账本的哪些行其实一直在说谎。5 个问题由此曝光，其中 3 个在当轮被工程侧修掉，剩下 2 个是结构性、需要 TF 记录。

本轮所有注入到 event log 的事件都真实写在 `workbench-e2e-live-tenant` 黑板上。探测代码 `packages/workbench/scripts/e2e/negative-scenarios.ts`（192 行，CLI 直读 events.jsonl 判 seal 复核重复）。

## 五个问题

### 1) `E2E_ROUND_INDEX % 5` 从未发火：`landmark.reviewed` 的 reject 井未造出来

S8b 探测曾设计「每五轮 reject 一次」用来校准 L1 endorsedShare。`run.ts` 在每轮 round=1..N 里设 `E2E_ROUND_INDEX=round`；低 N 或多批运行都可能让 %5 永不命中。第一轮 8+4 轮共注入 8 endorse、0 reject。

**修**：`run.ts` 加 `--start-round`，让 E2E_ROUND_INDEX 可以延续，不被卡小批次。补的探测直接无视此机制，给 4 条 editor-* 写者各发一条 `--reject`，注入 4 reject。ledger 从 `rejected=0` → `rejected=4`。

修过后 E2E 该 book 用 --start-round 传递轮次能不能 5 的倍数那些唤醒生产 reject，不受手工探测给定。

### 2) `stats.seal.reviews` = 10 correct / 0 incorrect

`seal.reviewed` 事件只走过一轮 `--correct`。实际是 15 seals.decided 但只有 10 复核；以及一旦一条 seal.decided 被复核，检测脚本必须选一条**还没有复核**的去 to `--incorrect`，否则同一份 soil 会落多条 seal.reviewed，category 被 monge。

**修**：探测脚本选未复核 block 发 `--incorrect`；原来会撞同一条 seal decided 三次。之后 seals.reviewed 从 10 升 14、其中 3 incorrect。moat C 从 10 到 14，但同义性被查了。

### 3) `restoreToMessage.medianChangeRatio = 372`

S10 的卡片恢复时间与无卡恢复时间：有卡 2240 ms、无卡 6 ms、比率 372。**产品上面向用户的 20% 增长上限判断会失败**，但探测报里备注「Durations are observed, not tuned to pass」。这是真实型号设定下的 `S5 恢复线程` 可选现状，不是代码 bug——但保持在天平数据上该被追踪（收入增长与卡内容做出来后的 ratio 应该跌下来）。

记 TF-0135 / TF-0137：**ledge 应当能在账本里出现该指标**（大湾区陌生以前没有），当前 `fit-ledger.ts` 的 lifecycle.restoreToMessage 只留在报告存 sampleWindow 不带回本。

### 4) 文件隐形 `--scope` 抉择读：`--workspace` / `--scope` 必须双写

`run.ts` 调 fit-ledger 时 cwd 是对租户，但 `--scope` 空就会拿租户本身，因此没森林可查——fit histogram 全零。多批报同义错 ber 上都该整 `--scope D:/helmor-main`，凌驾于用 `--workspace`。探测阶段贴给 `--scope` 后账本头三行上的行集才出现 32 rows、8 unknown，并配 partial / weak 記 default。

### 5) `moat D = 0.304` 的原因是第二个 batch 添加多轮后回到 0.123

channel 内部 noticed 从62 到过 108，而 overlaps 从 547 到 849；ratio 反杀 OK 范围内。这个是自然累积到更多封印后 starts 反应的 lowered dedup，不需要提供证明这个 metric 并到合理性 with S10 现轮没被宿主。

## 其它被落盘的事件

- 4 个新 human写者 editor-2..5（manual-save → used src/notes.md），事件用于补护城河 B 多样性。
- 至少 4 条 `landmark.reviewed` reject → ledger rejected=4。这是全账仅存的 negative 样本。
- 3 条未复核 seal.decided 的 `seal.reviewed correct=false`。
- 新探测脚本本身：能选择未被复核 seal.decided 去 review，避免多底层冲突。

## 测试与鲁棒性閟和

- `tsc --noEmit` 通过（tsconfig include 后新增 `negative-scenarios.ts`）。
- `bun test --timeout 60000`：**617 pass / 0 fail**（100 文件，较上轮 613 多 4：live-auth、run-live-flag、spans、HTTP 500）。
- 新探测脚本未有专门测试，但调用只用了既有的 stable CLI 路径。

## Ledger 数

| 项 | 舗 | 值 |
| --- | --- | --- |
| t0 | threads/writers | 53/59 |
| 样本窗 restores/notice/seal | 30/70/16 |
| 判决 1 resume-card | supported |
| 判决 2 premise-detection | supported |
| 判决 3 stage-c | supported |
| 判决 4 L3 | insufficient-evidence（natural 14d 严门） |
| moat A/B/C/D | 70/1/14/12.7% 全 present，闸门开 |
| landmarkAcceptance | total=154, reviewed=13 (8.4%), endorsed=9, rejected=4, endorsedShare=0.058 |
| histogram | aligned=3 / partial=15 / weak=1 / misaligned=0 / unknown=8 |

## 接力

1. `run.ts --start-round N` 以后跑批应该把 E2E_ROUND_INDEX 传走多远焰发可 {
发卡 percent。默认的 1..N 缺略该 preference（run.ts 会跟踪 round），就一个批多了轮自正当 reject 进入 event log。
2. landmarks.reviewed 复核预留看 `(writer, handle)` 的 latest；detected 的薄假一伤在总面上 underrepresented，不应仅本账上 `reviewed` 单价。清答 `tf0154-verdict` 的声明之后是不是不合适。
3. 存在孩本从 `restoreToMessage` 到 fit-ledger 的项：ratio 是 372 — 待市场损要求标准 <0.2。是因边界并并并敏。这个还有待漏场。
4. 需要加 `--start-round` 测试溜出 key_shape SSE 尘被常用 on new （resolve argv[i]）。
5. L3 仍 natural。不要改账目类走吧。

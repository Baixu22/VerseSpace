# 9 条 open issue 收口交接（2026-09-27）

> **双标签口径：工程门通过（本机可执行范围）/ 产品证据不足。**
> 改动**仅本地 commit，未 push、未打 tag、未发布**。
> 本记录不把工程测试冒充真实浏览器、真实 provider 或真人数据；哪些读数是实跑、哪些只是读代码，逐条标注。

本记录写于 **2026-09-27 00:xx（+08:00）**，承接 2026-09-26 的收尾轮。本轮另外两份新增记录
（[ADR-0023](../decisions/0023-research-prototype-closeout.md) 的补记、[断链检查记录](2026-09-26-upload-surface-links.md)）
沿用 **2026-09-26** 的轮次日期，不是笔误。

---

## 0. 结论摘要

起手时仓库有 **9 条 open issue**（#31 / #32 / #33 / #35 / #36 / #37 / #38 / #39 / #40）。

| issue | 性质 | 本轮去向 |
| --- | --- | --- |
| #36 | 工程缺口（声明宽于实现） | **修好**：删掉 2 个无生产者的 `PromotionSignal` 变体 + 编译期形状钉 |
| #37 | 门禁盲区 | **修好**：上传面门禁新增相对链接解析；首次真跑抓到 1 条真断链并修掉 |
| #38 | 治理（外部 CLI 判据） | **修好**：外部 CLI 与仓内脚本都改为默认分支可达性判据；权威归属写进 AGENTS.md |
| #39 | 治理（偏差账本卫生） | **修好**：50 条偏差全部有有效状态、未结 0；CLI 新增 `deviation-status` / `deviations` |
| #40 | 审计（声称四模块未审计） | **判定为过时**：四模块早已审计（`843793d`），本轮补 1 个新站点与 8 处行号漂移 |
| #35 | 森林账目缺口 | **收口**：11 个未收口节点逐条定去向（4 done / 1 in_progress / 2 blocked / 4 deprecated） |
| #31 | 真功能缺口，依赖外部条件 | **保持 open**：写足迹零验证的现状**经复核仍然成立**；卡在真实 codex 会话 |
| #32 | 外部门（真人使用窗口） | **保持 open**：来源纪律禁止代理代跑，判据不因工程动作移动 |
| #33 | 外部门 + 发布决策 | **保持 open**：tag / Release 是真实发布动作，待维护者决策 |

**一句话**：能由工程动作收口的 5 条（#35–#40）都收了；依赖真实会话或真人使用的 3 条（#31/#32/#33）
明确留在外部门，并逐条给出「还缺什么资源」。

---

## 1. 改了什么（按 issue 列 file:line）

### #36 —— `promote.ts` 声明 5 种晋升信号，2 种无生产者

- `packages/workbench/src/chat/promote.ts:34-37` —— `PromotionSignal` 联合从 5 个变体删到 3 个
  （`turns-crossed` / `next-day-resume` / `second-fork`）；删掉 `repeated-test-failure` 与 `commit`。
  函数体**一个字节没动**，`collectSignals` / `evaluatePromotion` / `promotionPatch` 行为不变；
  `opts.extraSignals` 保留（`second-fork` 仍从这条路进来）。注释里的两条「由足迹侧喂入」一并删除。
- `packages/workbench/src/chat/promote.test.ts:29-82` —— 新增编译期形状钉
  （`Equal`/`Expect` 断言 `PromotionSignal["kind"]` 恰为那三个字符串）+ 两条运行时用例。
  **负向对照实测**：把 `| { kind: "commit"; ref: string }` 加回去 → `bunx tsc` 报
  `TS2344: Type 'false' does not satisfy the constraint 'true'`，exit 2。
- `docs/fable-brief/03-deep-state-appendix.md:46,104`、`docs/fable-brief/00-final-prompt.md:50`、
  `docs/fable-brief/01-context-and-constraints.md:31` —— 四处**当时仍把缺口写成现状**的散文加日期补记。
  历史散文一律保留原文（append-only），补记声明取代关系。

### #37 —— 上传面门禁测不到断链

- `scripts/upload-surface/links.mjs`（新，223 行）—— 抽取 + 解析。
- `scripts/upload-surface/report.mjs`（新，104 行）—— 把渲染从门禁里提出去，门禁回到「测量 + 裁决」。
  输出**逐字节相同**（`fc /b` 比对过文本与 JSON）。
- `scripts/upload-surface/links.test.mjs`（新，338 行）—— 15 条用例，含**真仓基线**（断链必须为 0，
  且至少解析出 200 条，防止解析器自己坏掉之后报绿）。
- `scripts/check-upload-surface.mjs:1-380` —— 接入新检查，新违规码 `broken-relative-link`；
  `--json` 只做加法（新增 `relativeLinks`）。
- `package.json:23` —— `test:upload-surface` 同时跑 classify 与 links 两套。
- `docs/decisions/0023-research-prototype-closeout.md:28-39` —— 「已知盲区」那段**保留原文**，
  在其后追加补记：盲区现在被直接测量。同处写明仍不覆盖的类别（引用式链接、HTML `<a>`、
  带空格未加 `<>`、非 `.md`、锚点存在性、**大小写**）。
- `docs/handoff/2026-09-26-upload-surface-links.md`（新）—— 断链检查交接记录。
- `.github/pull_request_template.md:22` —— **首次真跑抓到的那条真断链**：从 `.github/` 解析
  `docs/decisions/0018-…md` 会落到 `.github/docs/…`（404）。改为 `../docs/decisions/…`。
- `docs/handoff/README.md:34-39` —— 自查清单补上新违规码（原清单只列了旧的四个）。

### #38 —— 外部 `check-landing` 仍按时间戳判定

- `C:\Users\27933\.workbuddy\skills\task-forest\scripts\task_forest.py`（**仓库外**，本轮前已备份到
  `.agent-contexts/backup/task_forest.py.orig`）：
  - `cmd_check_landing` 整段重写：删掉 `updated_at > HEAD 提交时间` 的判据，改为
    （1）HEAD 不得领先默认分支；（2）未合并分支不得携带非记账文件；
    （3）done 节点证据里能解析成**真实提交**的 token 必须 `git merge-base --is-ancestor` 默认分支。
    解析不出提交的节点列为**无法归因**（不判漂移）；不属于任何分支的提交列为**孤立提交**
    （极狐镜像的 fresh-orphan 快照即此类，不判漂移）。
  - `--json` 载荷只做加法：新增 `default_branch` / `problems` / `notes` / `orphan_count` /
    `unattributed_count`；`suspect_count` / `suspects` 保留。
- `scripts/check-forest-landing.mjs:1-200` —— **仓内那份（AGENTS.md 现在声明为权威）原本也带同一条
  时间戳判据**，本轮一并删除，改成同一套可达性判据 + `gitExit()` 辅助函数。修之前它在本轮
  apply 森林提案后立刻报「4 个 done 节点晚于 HEAD 提交」——正是 `TFD-6b47ba440e` 记的假阳性。
- `AGENTS.md:431-447` —— 写明分工：**仓内脚本是本仓的权威落库门禁**；外部 CLI 的判据已改；
  并写明偏差状态字段与 `deviation-status` 命令。

### #39 —— 偏差账本卫生

- `task_forest.py`（仓库外）新增两个子命令：
  - `deviation-status <id> --status open|resolved|superseded|accepted [--superseded-by …] [--reason …]`
    —— **只改目标那一行**，其余行按原始文本写回；状态写进条目自身的
    `status_at` / `status_actor` / `status_reason` / `superseded_by`。
  - `deviations [--status …] [--json]` —— 列出账本与未结数。
  - `validate` 现在每次打印 `偏差账本：N 条 · 未结 M 条（其中无 status 字段 K 条）`；
    **缺失 status 按未结计**（一条没写状态的偏差不能被读成「已结」）。
- `.agent-workbench/task-forest/deviations/deviations.jsonl` —— 50 条全部写入有效状态：
  **40 resolved · 7 accepted · 3 superseded · 0 open · 0 缺 status**。
  逐条依据（含 `superseded_by`）在 `.agent-contexts/deviation-statuses.json`（本机 scratch）。
- `.agent-workbench/task-forest/proposals/drafts/README.md`（新）—— 逐份写明 5 份陈旧草案的去向。
  `l1-commit-gate-proposal.json` 自身 `status: applied`，**不是草案**，已移到 `proposals/`；
  其余 4 份从未 `proposal-save`（无 `proposal_id`，按 CLI 语义根本不可能被 apply），
  目标节点全部已 done，保留在 `drafts/` 并逐条写明理由（`SKILL.md:77` 指定 `drafts/` 就是退役位）。

### #35 —— 森林与 ADR-0023 收尾决策对账

- 提案 `TFP-2026-09-27-adr0023-closeout-reconcile`（**已保存并已 apply**，`validate` exit 0）。
  11 个未收口节点的去向，依据只有 ADR-0023 已写明的交付边界与各节点自己的验收原文：

  | 节点 | 去向 | 依据 |
  | --- | --- | --- |
  | TF-0272（第四轮：声明—证据对齐） | **done** | 5 条验收达成；阶段 C 由 ADR-0023 判为范围外，残量由 TF-0280/0281 承载 |
  | TF-0263（codex 写侧是否接 seal） | **done** | 用户选 A 并已实现；README/AGENTS/面板均标注实验通道 |
  | TF-0252（第三轮 global_task） | **done** | 阶段 A 出口已记录；ADR-0023 即它要求的 C/D 决定 |
  | TF-0253（风险：绿灯被误读） | **done** | 双标签口径已落成明文 |
  | TF-0266（版本/CHANGELOG/tag/Release） | **in_progress** | 版本与 CHANGELOG 已完成；tag/Release 待 #33 决策 |
  | TF-0262（阶段 C：Codex 真实写侧验收） | **blocked** | 实验定义与仪器已就绪，缺真实 codex 会话（#31） |
  | TF-0264（采集真实 Codex 写侧会话） | **blocked** | 同上；探针已写好但未运行 |
  | TF-0265（阶段 D：发布与跨平台一致性） | **deprecated** | ADR-0023：公开发行是独立后续工作 |
  | TF-0267（阶段 E：真人价值窗口） | **deprecated** | ADR-0019/0023：常设人工门 |
  | TF-0280 / TF-0281（产品证据配方与资源） | **deprecated** | 从未交付，且三类证据均被 ADR-0023 判为独立后续工作 |

  森林现状：**261 done · 17 deprecated · 2 blocked · 1 in_progress**，`proposed` 归零。
- 4 条已解决的偏差（`TFD-d9b41cf3f8` / `TFD-b1b366c832` / `TFD-460861548d` / `TFD-200e8fc589`）
  用 `deviation-status` 写成 `resolved`，依据写在各条 `status_reason` 里，**没有**另开新条目冒充取代。
- `todos/todos.json`（`proposal-apply` 派生重建）与节点状态重新一致：11 条里只剩
  TF-0266 / TF-0262 / TF-0264 仍在待办列表，与 in_progress + blocked 相符。

### #40 —— 四模块 catch 审计

- `docs/handoff/2026-09-25-catch-after-continue-audit.md:394-603` —— **追加** §10（§0–§9 一字未改）。
  判定：issue #40 的「四模块完全没审计」**过时**。证据链：
  - `843793d` 落地时四模块就有 29 行四列结论（§3.1–§3.4），比 deviation 建立晚 **12 h 15 m**
    （不是转述里的「~20 小时」——那是把 UTC 时间戳当本地时间读）；
  - 当前树四模块 30 个站点：**21 个 file:line 精确命中**，8 个仅行号漂移，**只有 1 个新站点**
    （`supervisor/liveness.ts:136`，OPEN-4 修复新增的同步抛出分支）无对应行，已在 §10.5 补齐；
  - 140 vs 143 的差额**不是规则差异**：`843793d` 的树用同一脚本重扫仍是 140，
    多出的 3 个是代码后来长的（`chat/codex-app-server/session.ts` +2、`supervisor/liveness.ts` +1）；
  - 旧读数 147 也解释清楚了：同一正则**把注释行算进去**时的读数，且取自更早的树。
- 偏差 `TFD-c76055ffad` → `superseded`，`superseded_by` 指 `843793d` §3 + 本表 §10。

---

## 2. 门禁读数（全部为实跑）

**环境说明（重要）**：本轮的读数是**在 `danger-full-access` 下取的**——本会话中途放宽了文件/进程策略，
node 与 bun 因此可以创建子进程。AGENTS.md 记的「agent 沙箱拒绝创建子进程」在 `workspace-write` 下
**仍然成立**；同一批套件在那个模式下会退化（本记录不主张那些失败是回归，也不主张现在的绿与它们矛盾）。

| 门禁 | 读数 | exit |
| --- | --- | --- |
| `bun run typecheck` | 三个包 `tsc --noEmit` 全过 | **0** |
| `bun run lint` | `Checked 652 files. No fixes applied.` | **0** |
| `bun run test:workbench` | **1016 pass / 0 fail**，158 文件，137.48 s | **0** |
| `bun run test:workbench-ui` | **68 pass / 0 fail**，18 文件，14.31 s | **0** |
| `bun run test:context-rot` | **69 pass / 0 fail**，6 文件，2.77 s | **0** |
| `bun packages/workbench/src/index.ts doctor` | 117 条架构断言 / **0 失效**；blackboard 一切正常 | **0** |
| `node scripts/check-upload-surface.mjs --strict-references` | 上传面已定性，双向无违规：违规 0 · 已裁决引用 6 · **相对链接 0 断链**（文件/链接计数随仓内文件数变化，写本记录时是 813 文件 / 302 条；**判据是 exit 0 与违规 0，不是这两个数**） | **0** |
| `bun run test:upload-surface` | classify **15 pass** + links **15 pass**，0 fail | **0** |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1` | **14 passed / 0 skipped / 0 failed**，38.8 s | **0** |
| `cd packages/workbench && bun run build && bun run test:build` | 原生与 JS 两种形态冒烟全过（`initialized/doctor/stats/headlessUi/bundledUi` 全 true） | **0** |
| `bun packages/workbench/scripts/benchmark-premises.ts --json` | **11 / 11** 场景通过（合成负载契约，**不代表真实用户精度**） | **0** |
| `node scripts/check-forest-landing.mjs` | **有漂移（预期，见下）**：HEAD 领先 `main`，且分支 `qa-stage-ab-remediation` 有代码文件未并入 `main`；另 1 条孤立提交、187 条无法归因（只报读数） | **1** |
| `node scripts/check-claims.mjs` | 13 条声明全部一致（重取读数后） | **0** |
| 外部 CLI `validate` | 校验通过；偏差账本 50 条 · 未结 0 | **0** |
| 外部 CLI `check-landing` | **有漂移（预期，与上一条同因）**：同样报 HEAD 领先 `main` + 代码文件未并入 `main`；1 条孤立提交读数（TF-0255 的 `ad53345`） | **1** |

### 两个落库门禁为什么是红的（这是**正确**读数，不是回归）

本轮的全部提交（`6650109` 加三个读数/文档提交 `4da1254` / `b5ddedf` / `d315052`）都落在
`qa-stage-ab-remediation` 上，`main` 仍在 `d0706b3`。两个落库门禁因此都报
「HEAD 领先默认分支 + 分支有代码未并入」——这正是 `TFD-0dab4149f2` 记的那一类缺口，
也是本轮 #38 把判据从时间戳改成可达性之后**第一次真的抓到它**：

- **旧判据抓不到**：时间戳规则问「有没有 done 节点比 HEAD 新」。本轮提交是最新的东西，
  所有 done 节点都比它旧，所以旧规则会报 **clean**——而代码确实没在 `main` 上。
- **新判据抓到了**：可达性规则问「HEAD 与未合并分支上有没有代码不在默认分支上」，答案是有。

所以这两行红字是**判据修好了的证据**，不是本轮引入的缺陷。要让它们转绿，需要把
`qa-stage-ab-remediation` 并入 `main`（或本机 fast-forward `main`）——**本轮没有做**，
因为用户批准的是「本地 commit，不 push」，而合并到权威分支是维护者的动作。

相应地：**`TFD-460861548d` 记的「done 节点只在分支上」在 `d0706b3` 时已闭合，但本轮改动的
源码文件又处在了同一形态**（具体数量随本分支后续提交变化；判据是「未并入 `main` 的文件数 > 0」，
不是一个固定数字）。按 ADR-0022 的口径，本轮成果应读作**「分支上完成」而不是「已落库」**。

**本机仍然拿不到的读数**（不假装拿到）：

- 任何**非 Windows 平台**上的执行读数 —— 宿主没有可用执行面（WSL2 需管理员改
  `hypervisorlaunchtype` + 重启；无 docker/podman/qemu）。偏差 `TFD-07ee49b62f` 保持 `accepted`。
- **真人自然使用**产生的读数 —— 来源纪律禁止脚本/代理代跑（issue #32）。
- **真实 codex 写侧会话** —— 本机没有 codex、没有可用凭据（issue #31）。

### 一处需要留意的读数含义

`check-landing` 报的 **1 条孤立提交**是 TF-0255 的证据提交 `ad53345`——它是极狐镜像的
fresh-orphan 快照（`snapshot: VerseSpace @ 0366f13 - jihulab CI mirror (no history)`），
**不属于任何分支**。按新判据它只报读数、不判漂移。但这条读数值得下一轮留意：TF-0255 的
验收第 2 条（「CI 在隔离 workspace 运行浏览器 suite」）是在一条**已被 ADR-0021 退役**的通道上达成的。
它不在 #35 点名的 11 个节点里（当时是 done），所以本轮**没有**改它的状态——留给维护者判断是否需要重述。

---

## 3. 刻意没做什么、为什么

| 没做 | 为什么 |
| --- | --- |
| **没有删除** `proposals/drafts/` 下那 4 份陈旧草案 | issue 给的是「清掉**或**写明为何保留」。`SKILL.md:77` 已把 `drafts/` 指定为退役位；森林是 append-only 的审计材料，删掉只会丢掉可对照的原始提案体。改为写 `drafts/README.md` 逐份说明。 |
| **没有把 41 条历史偏差一刀切成 resolved** | 逐条判过：有 `correction` 字段的 22 条按 `resolved`；环境/宿主限制与有意延期的 7 条按 `accepted`；被后续条目或 ADR 取代的 3 条按 `superseded`；其余按条目自述。每条都有 `status_reason` 说明依据。 |
| **没有动 `TF-0255` 的状态** | 它不是 #35 点名的节点，且它的缺口（CI 通道已退役）需要维护者判断是重述验收还是重取读数。本轮只把读数留在 §2。 |
| **没有给 #36 的两个信号接线** | 用户明确选「删掉」。接线（git watcher → commit、verifier → repeated-test-failure）要各自先红后绿，且属功能扩展，与 ADR-0023「冻结功能扩展」冲突。 |
| **没有为 `.github/pull_request_template.md` 的陈旧 CI 段落动手** | 该文件第 22 行以下仍写「请贴 JihuLab 流水线链接」，而 ADR-0021 已退役全部 CI 通道。本轮只修了那条**断链**（门禁要求）；段落措辞是工作流决策，留待维护者。 |
| **没有在 `docs/` 根新增文件** | 新文档一律进 `docs/handoff/`（ADR-0020：`docs/` 根的新文件会让上传面门禁失败）。 |
| **没有 push / 打 tag / 发布** | 与既有一致：成果只落在本地分支。发布是真实动作，见 issue #33。 |
| **没有把本轮的森林变更当成工程交付物** | 森林是 untracked 的本机脚手架；上传面门禁不覆盖它，克隆者也不需要它。 |

---

## 4. 下一步与遗留风险

1. **把 `qa-stage-ab-remediation` 并入 `main`**（或本机 fast-forward）。这是让两个落库门禁转绿的
   唯一动作，也是本轮 10 个代码文件从「分支上完成」变成「已落库」的唯一路径。本轮没做：
   合并是维护者动作，用户只批准了本地 commit。
2. **#31（唯一的真功能缺口）**：本记录写完之后，**真实 codex 采集已经跑通**——本机其实装了 codex
   （`CODEX_CLI_PATH` → `codex-cli 0.158.0-alpha.2.1`），原来「缺资源」那条不成立。结论因此比
   本记录初稿更锐利：真实写回合**不产生** `fileChange` / `applyPatch` / `fileRead` item，
   `commandActions[].type` 是 `unknown` 且**没有 `path`**，5 次真实写审批的
   `approvalTargets().kind` 全是 `unknown`（不是 `write`）——所以写这半条通道对本次抓取的
   模型 / profile / 回合是**结构性缺席**，不是「还没采」。第 12 个流夹具 +
   `codex-write-capture.test.ts` 把这些读数逐条钉住；codex 以后若开始发写 item，门禁会失败并
   提示重做结论。详见 [codex 写侧采集记录](2026-09-27-codex-write-capture.md) 与 ADR-0017 的
   2026-09-27 补记。
3. **#33（发布决策）**：版本 0.4.1 与 CHANGELOG 已就绪，打包路径已修并 dry-run 验证。
   真发版按 AGENTS.md「Releases」三步走（tag 先到 origin → `build:all` → publish）。
   平台覆盖声明（只有 windows-x64 跑过完整测试）必须保留。
4. **#32（真人窗口）**：判据不因工程动作移动。守卫已修好（`seal.decided` 已有读数），
   但**这些读数不是自然人产生的**，不构成 fit 账本判据。
5. **TF-0255 的验收第 2 条**：其 CI 通道已被 ADR-0021 退役，建议下一轮决定是重述验收
   （改成 `scripts/win/e2e-browser.ps1` 的本机读数）还是重取。
6. **`docs/handoff/README.md` 之外的旧报告**里仍可能有过期表述（本轮只在 #36 点名的四处加了补记）。
   下一轮若继续做「声明—证据对齐」，可用 `bun packages/workbench/src/index.ts doctor` 与
   `bun run check:upload-surface` 先扫一遍。

---

## 5. 复核命令

```bash
# 工程门（本机；不需要 CI）
bun run typecheck && bun run lint
bun run test:workbench && bun run test:workbench-ui && bun run test:context-rot
bun packages/workbench/src/index.ts doctor
bun run check:upload-surface --strict-references
bun run test:upload-surface
bun run check:claims
node scripts/check-forest-landing.mjs
pwsh -NoProfile -File scripts/win/e2e-browser.ps1

# 森林（外部 CLI，仓库外）
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py validate --workspace D:/helmor-main
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py check-landing --workspace D:/helmor-main
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py deviations --workspace D:/helmor-main
```

**合并本分支前请把本轮读作「工程门通过（本机可执行范围）」，而不是「产品已验收」。**

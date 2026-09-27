# 声明卫生轮：修掉 4 处 CI 陈文、查清并修掉 `path: ""`、更正一条过读的端到端声明（2026-09-27）

> **双标签口径：工程门通过（本机可执行范围）／产品证据仍不足。**
> 改动只落在本地分支 `chore/claim-hygiene-20260927`，**未 push、未合并、未打 tag**。
> 本记录不把工程测试冒充真实浏览器之外的任何东西；哪些读数是实跑、哪些本机拿不到，逐条标注。

本轮承接[上一轮 9 条 issue 收口记录](2026-09-27-issue-closeout.md) §4「下一步与遗留风险」里
**能在本机做完**的部分。**不含 issue #31**（用户明确排除）。

---

## 0. 结论摘要

| 事项 | 去向 |
| --- | --- |
| 4 处仍在宣称已退役 CI 通道的文本 | **修掉**（`CONTRIBUTING.md` ×2、PR 模板、issue 模板 `config.yml`） |
| 真实 codex 回合里那条 `path: ""` 的封印判定 | **查清并修掉**：`cwd` 被当成了写目标 |
| 最新交接记录里「原生 `fileChange` 审批抵达 `decideSeal`」 | **更正为不成立**：同一次 run 的原始 rollout 显示该回合**零** `fileChange` item |
| 森林两处与事实不符的记账（TF-0262「本机没有 codex」、TF-0255 仪器已退役） | **追加补记**（提案 `TFP-1480504d28`，已 apply；`validate` exit 0；两个节点状态未改） |
| 根 `README.md` | 重写为**结构化现状文档**（新增「现状与验证边界」表与「不保证什么」一节） |
| 因本轮改动失效的读数 | **9 条全部重取**，每条都由记录器执行仪器本身（`--run`），不接受手填退出码 |

**一句话**：本轮没有新功能，只把「仓库自己在说的事」与「仓库实际能证明的事」对齐；
唯一的行为改动是 `approval-targets` 不再把命令的运行目录当成写目标。

---

## 1. 改了什么（按文件列 file:line）

### 1.1 四处仍在宣称一条已退役 CI 通道的文本

| 位置 | 原文问题 | 改成 |
| --- | --- | --- |
| `CONTRIBUTING.md:7` | 「版本固定在 `package.json` 的 `packageManager` 与 **`.gitlab-ci.yml` 的 `BUN_VERSION`**」——该文件已按 [ADR-0021](../decisions/0021-retire-all-ci-channels.md) 删除，且与同文件 `CONTRIBUTING.md:54`「本仓库不配置任何 CI」自相矛盾 | 只留 `packageManager`，并注明它是全仓唯一一处声明 |
| `CONTRIBUTING.md:49` | 「CI 侧对应 `resource_group: heavy`」——通道已退役 | 写成历史事实：没有 CI 就没有排队机制，重活只能自己串行 |
| `.github/pull_request_template.md:20-35` | `## CI` 一节要求「贴 JihuLab 流水线链接，否则等于没跑过 CI」——流水线已不存在，且会**主动误导**贡献者 | 改成 `## 门禁读数`：不配置 CI、PR 上没有状态检查、没有链接可贴；列出本机门禁命令并要求贴 exit code |
| `.github/ISSUE_TEMPLATE/config.yml:8` | 贡献指南入口写「CI 通道（JihuLab）」 | 「本仓库不配置 CI」 |

这四处**不可能再有证据**——被指的东西已经删除。它们不在 `doctor` 的扫描面里（该扫描器看的是
`AGENTS.md` / `CLAUDE.md` 与 `docs/`），所以此前一直没被门禁抓到。

### 1.2 `path: ""`：根因、证据链与修复

**问题**（上一轮自己记下的未查明项，见 [codex 封印端到端记录 §2](2026-09-27-codex-seal-e2e.md)）：
read-only 的 `own-fresh` 里有一条 `{path:"", decision:"pass"}` 的封印判定，来源不明。

**根因**：真实 `commandExecution` 审批的 params **带 `cwd`**
（夹具 `packages/workbench/src/chat/fixtures/approvals/command-execution-0.158.json:13`），
而 `approval-targets.ts` 的 `PATH_FIELDS` 把它当成候选目标。于是同一条审批给出两个「路径」：
`cwd`（= codex 的工作目录 = 本实验的 projectRoot）与命令串里的重定向目标。`session.ts`
对两者各调一次 `decideSeal`，而 `normalizeTarget(projectRoot, projectRoot)` 恰好是 **`""`**。
两条判定与记录里的 `[{path:"",…},{path:"src/target.ts",…}]` 一一对应。

**改动**：

- `packages/workbench/src/chat/codex-app-server/approval-targets.ts:28-45` —— `PATH_FIELDS`
  移除 `"cwd"`，并写明理由（它是命令的运行目录，不是写目标）。
- `packages/workbench/src/chat/codex-app-server/approval-targets.test.ts:61-97` —— 新增用例
  `the REAL 0.158 fixture: the command's cwd is not a write target`。
- `packages/workbench/src/chat/codex-write-capture.test.ts:314-318` —— 更正注释
  （原来写「paths 里只有 PATH_FIELDS 抓到的 cwd」，现在 paths 为空；结论不变）。

**先红后绿（实跑）**：

- 红：把 `"cwd"` 加回 `PATH_FIELDS` → `1 fail / 9 pass`，失败信息
  `received: ["C:\\Users\\27933\\AppData\\Local\\Temp\\wb-codex-capture", "src/target.ts"]`。
- 绿：移除后 `10 pass / 0 fail`。

### 1.3 更正一条过读的端到端声明

[codex 封印端到端记录](2026-09-27-codex-seal-e2e.md) §1B/§2 把 read-only `own-fresh` 里的
`src/target.ts` 读成「原生 `fileChange` 审批经 PR #43 的关联抵达 `decideSeal`」。
**该记录已追加 §5 补记更正（上面 §0–§4 一字未改）**，依据是**同一次 run 自己的原始 rollout**：

- `.agent-contexts/codex-seal-ro/sessions/2026/09/27/rollout-2026-09-27T14-48-06-01a0e19e-f71b-7340-add3-7450b6405a26.jsonl`
  （本机未跟踪 scratch）逐条解析出的 item：读回合 `UserMessage` / `Reasoning` / `AgentMessage` /
  1 × `CommandExecution`（`Get-Content -LiteralPath src/target.ts`）；写回合 `UserMessage` /
  `Reasoning` / `AgentMessage` / 2 × `CommandExecution`（`… -Command "echo '// written by codex'
  >> src/target.ts"`）。**`FileChange` item 数 = 0。**
- 没有 item，`fileChanges.pathsFor(itemId)` 只能是 `[]`，`fileChange` 那条路**不可能**成立；
  那次封印调用只能来自命令串重定向解析（PR #43 之前就有的代码）。

**后果**：`fileChange` 的 `itemId` 关联目前仍只有**假 app-server 端到端**与夹具级证据，
没有真实回合证据。issue #31 的剩余缺口因此比上一轮写得更宽一点：既要一次同时满足
「会发审批」与「能建立失效前提」的 run，也要那次 run **真的发出 `fileChange` item 及其审批**。

### 1.4 森林记账（提案 `TFP-1480504d28`，已 apply）

- **TF-0262** 追加更正：`「本机没有 codex，也没有可用凭据」` 已被证伪——本机装有
  codex-cli `0.158.0-alpha.2.1`，真实读写回合与 6 变体实验都已跑通；本轮复核本机网关
  `http://127.0.0.1:3065/v1/models` → **HTTP 200**。阻塞条件因此不是「缺资源」。状态保持
  `blocked`（仍依赖外部模型服务与回合方差），未擅自改状态。
- **TF-0255** 追加补记：验收第 2 条的仪器（`.gitlab-ci.yml` + 极狐 runner）已按 ADR-0021 退役，
  证据提交 `ad53345` 是**不属于任何分支的孤立快照**；本条应读作「当时达成、今天不可复跑」。
  维护者二选一：重述为 `scripts/win/e2e-browser.ps1` 的本机读数，或重取。状态保持 `done`。
- `validate` → **校验通过**；偏差账本 50 条 · **未结 0**（缺失 status 0 条）。

### 1.5 根 `README.md` 重写

新增 **「现状与验证边界（2026-09-27）」** 表（工程门 / 可复跑证据 / 产品证据 / 发行 / 平台覆盖 /
CI）、**「它能做什么」** 与 **「它不保证什么」** 两节，并补全本机门禁命令（含 `check:claims`、
`e2e-browser.ps1`）。所有相对链接在提交前逐一核实存在；本文件新增的链接也被上传面门禁实测
（首次真跑抓到 2 条断链，正是本记录当时尚不存在——见 §2 的读数说明）。

---

## 2. 证据读数（全部为实跑）

**环境**：Windows 本机，DSH 文件策略 `danger-full-access`（子进程可用），`NO_PROXY=127.0.0.1,localhost,::1`。
AGENTS.md 记的「agent 沙箱拒绝创建子进程」在 `workspace-write` 下仍然成立；本轮读数**不是**在那个模式下取的。

**读数所在提交**：代码与文档改动提交 `deb9ef3`（读数文件里各自记着 `subject_sha`）。

| 仪器 | 读数 | exit |
| --- | --- | --- |
| `bun run lint` | `Checked 656 files in 447ms. No fixes applied.` | **0** |
| `bun run typecheck` | 三个包 `tsc --noEmit` 全过 | **0** |
| `bun run test:workbench` | **1027 pass / 0 fail**，159 文件，126.0 s | **0** |
| `bun run test:workbench-ui` | 68 pass / 0 fail（**本轮未改动该包**，读数沿用 `claim-ui-suite`，仍 `valid`） | — |
| `bun run test:context-rot` | 69 pass / 0 fail（同上，仍 `valid`） | — |
| `bun packages/workbench/src/index.ts doctor` | 117 条架构断言 · **0 条失效**；blackboard 正常 | **0** |
| `node scripts/check-upload-surface.mjs --strict-references` | 上传面 **822** 文件 · **违规 0** · 相对链接 326 条 / **断链 0** | **0** |
| `pwsh -NoProfile -File scripts/win/e2e-browser.ps1` | **14 passed / 0 failed / 0 skipped**（29.6 s，隔离工作区 + 真 Vite + 真后端） | **0** |
| `cd packages/workbench && bun run build && bun run test:build` | 原生与 JS 两种形态 `initialized/doctor/stats/headlessUi/bundledUi` 全 `true` | **0** |
| `node scripts/audit/catch-sites.mjs --json` | 61 文件 / 143 站点 | **0** |
| `bun packages/workbench/scripts/benchmark-premises.ts --json` | **11 / 11** 场景（合成负载契约，**不代表真实用户精度**） | **0** |
| `node scripts/check-claims.mjs` | 13 条声明 · 12 `valid` + 1 条明示的 L3 历史观测 · **0 stale** | **0** |
| `node scripts/check-forest-landing.mjs` | **有漂移（预期）**：HEAD 领先 `main`，本轮文件尚未并入 `main` | **1** |
| 外部 CLI `validate` | 校验通过；偏差账本 50 条 · 未结 0 | **0** |

### 两条需要点名的读数说明

1. **`test:workbench` 的第一次全量跑是 1026 pass / 1 fail**，唯一失败是
   `spawnSupervised > pid registry records a running process and reapOrphans kills it`。
   该文件单独重跑 **3 次全部 10 pass / 0 fail**，与本次改动无因果关系（本次只动了
   `approval-targets.ts` 这个纯函数与一句测试注释），判为**全量跑下的进程时序抖动**。
   记录器随后重跑全量得到 **1027 pass / 0 fail**，读数即来自那一次；两次读数都写在这里，不隐藏。
2. **上传面门禁在本轮中途真的抓到过 2 条断链**——正是本记录与 §1.3 补记当时引用的
   `docs/handoff/2026-09-27-claim-hygiene-round.md` 还不存在。文件写完后重跑即 **0 断链**。
   这条读数是「门禁不是形式主义」的现场证据，保留在案。

### 本机仍然拿不到的读数（不假装拿到）

- **非 Windows 平台执行**：`bcdedit /set hypervisorlaunchtype auto` 已设，但本轮实测
  `HypervisorPresent = False`、上次启动 **2026-09-23**、`Ubuntu-22.04` 仍 `Stopped`
  ——**改动要重启才生效**，所以 Linux 冒烟仍未取到（issue #33 的三行命令已备好）。
- **真人自然使用**读数：来源纪律禁止脚本/代理代跑（issue #32）。
- **真实 codex 的写保护闭环**：仍缺一次同时满足「会发审批」「能建立失效前提」「真的发出
  `fileChange` item」的真实 run（issue #31）。

---

## 3. 刻意没做什么

| 没做 | 为什么 |
| --- | --- |
| **没有改 TF-0255 的状态，也没有替维护者重述它的验收** | 重述验收是判据变更，属维护者决定。本轮只追加补记，把两个选项与依据写清楚。 |
| **没有把 TF-0262 从 `blocked` 改成 `in_progress`** | 本机确实可跑，但仍依赖外部模型服务与回合方差。是否改状态留给维护者，证据里写明了这句。 |
| **没有动 `docs/handoff/2026-09-27-codex-seal-e2e.md` 的正文** | 交接记录是 append-only 的时点读数；更正以 §5 补记的形式追加，原段落保留。 |
| **没有改 `codex-render-decision.ts` 的 `ITEM_DECISIONS`** | `fileChange` 等 6 类未建模形状需要各自的渲染决策，属功能改动，与 ADR-0023 的冻结边界冲突；已由 `codex-write-capture.test.ts` 的门禁钉住为**已知缺口**。 |
| **没有让 `fileChange` item 变成写足迹** | 同上：让原生写进账本是一条需要自己读数的独立改动。 |
| **没有 push / 合并 `main` / 打 tag / 发版** | 合并与发布是维护者动作。落库门禁因此报红，这是**正确读数**（见 §2）。 |
| **没有改 `packages/workbench/README.md` 等其它 README** | 用户本轮指定的范围是**根 `README.md`**。 |
| **没有在 `docs/` 根新增文件** | ADR-0020：`docs/` 根的新文件会让上传面门禁失败；新记录一律进 `docs/handoff/`。 |

---

## 4. 下一步与遗留风险

1. **把 `chore/claim-hygiene-20260927` 并入 `main`**（或本机 fast-forward）。这是让两个落库门禁
   转绿的唯一动作，也是本轮 3 个源码/测试文件与 6 个文档从「分支上完成」变成「已落库」的唯一路径。
   本轮没做：合并是维护者动作。
2. **重启一次机器**，然后按 issue #33 的三行命令取 Linux 冒烟读数（`wsl -d Ubuntu-22.04 -- …`），
   并把读数补进偏差 `TFD-07ee49b62f` 与发行说明。在此之前发行说明里的「只有 windows-x64
   跑过完整测试」必须保留。
3. **TF-0255 的验收第 2 条**：维护者二选一（重述为本机读数 / 重取）。
4. **#31 的剩余缺口**已按 §1.3 更正：需要一次真实回合**真的发出 `fileChange` item 及其审批**；
   本机网关实测可达（HTTP 200），缺的是那次 run，以及运行所需的密钥。
5. **`fileChange` 的渲染决策与写足迹**仍是已知缺口（`codex-write-capture.test.ts` 钉着）。
6. **`test:workbench` 里那条进程时序抖动**（`supervisor/index.test.ts`）本轮只记录，未修；
   若再次在全量跑里出现，值得单独查。

---

## 5. 复核命令

```bash
# 本轮的门禁（全部本机手跑；本仓库没有 CI）
bun run lint && bun run typecheck
bun run test:workbench && bun run test:workbench-ui && bun run test:context-rot
bun packages/workbench/src/index.ts doctor
node scripts/check-upload-surface.mjs --strict-references
node scripts/check-claims.mjs
node scripts/check-forest-landing.mjs
pwsh -NoProfile -File scripts/win/e2e-browser.ps1

# 行为改动的最小复核（本轮的 cwd 修复）
cd packages/workbench && bun test src/chat/codex-app-server/approval-targets.test.ts

# 森林（外部 CLI，仓库外）
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py validate --workspace D:/helmor-main
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py check-landing --workspace D:/helmor-main
```

**读本轮时请读作「工程门通过（本机可执行范围）」，而不是「产品已验收」。**

---

## 6. 补记（2026-09-27 晚）：分支已并入 `main`，两个落库门禁转绿

**本段是追加记录；上面 §0–§5 一字未改。** §2 表格里那行 `check-forest-landing` 的
「有漂移（预期）：HEAD 领先 `main`」以及 §4 第 1 条「本轮没做合并」，记录的都是
**本记录落笔时**的真实状态。之后维护者授权合并，本轮成果因此从**「分支上完成」**
变成**「已落库」**：

- 合并方式：`main` 的 tip 是 PR 合并提交 `c875588`，不是本分支的祖先，`--ff-only`
  不成立，故用本地 merge commit（与本仓 PR 合并的形状一致）。合并提交 **`45f9aea`**；
  **未 push**——判据是「`main` 领先 `origin/main` 的提交数 **> 0**」，不是一个固定数字
  （本补记之后还会有读数提交，数会变；要读数就现取：`git rev-list --count origin/main..main`）。
- `node scripts/check-forest-landing.mjs` → **exit 0 · 默认分支 `main` · 无漂移**
  （备注仍是：1 条孤立提交 `TF-0255:ad53345`、187 条无法归因——两者都只报读数、不判漂移）。
- 外部 CLI `check-landing` → **exit 0 · 落库漂移读数 0 项 · 工作区未提交改动 0 项**。
- `node scripts/check-claims.mjs` → **13 条一致（0 stale）· exit 0**——合并只改树的可达性、
  不改树的内容，所以 9 条读数的 `subject_sha` 仍然有效。

### 6.1 合并后重取的两条读数

本补记本身是 `docs/**` 的改动，按仓库自己的失效规则会让 `claim-doctor-clean` 与
`claim-upload-surface-clean` 立刻 stale。已按规程重取（记录器执行仪器本身）：

| 声明 | 读数 | exit |
| --- | --- | --- |
| `claim-doctor-clean` | `exit 0` · `stale 0`（117 条架构断言 · 0 失效） | **0** |
| `claim-upload-surface-clean` | `exit 0` · `violations 0`（822 文件 · 相对链接 326 条 / 断链 0） | **0** |

重取后 `check:claims` 仍为 **13 条一致 · exit 0**。

### 6.2 合并后仍然开着的（不因合并消失）

1. **`TF-0255` 验收第 2 条**的两选一（重述为 `scripts/win/e2e-browser.ps1` 的本机读数 / 重取）
   ——森林补记里已写明选项与依据。
2. **重启一次机器**后取 Linux 冒烟读数（issue #33；本轮实测 `HypervisorPresent = False`，
   `bcdedit` 改动尚未生效）。
3. issue **#31**（需要一次真的发出 `fileChange` item 及其审批的真实回合）与 **#32**（真人窗口）。
4. **推 `main`（4 个提交）**与是否发 `workbench-v0.4.1`——都是真实发布动作。

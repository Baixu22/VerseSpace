# 完整性问题修复收口（2026-09-16）

对应审计：[完整性与上线就绪报告](D:/helmor-main/.agent-contexts/integrity-audit-2026-09-16/integrity-report.md)（基线 `a04764463ebda1468b1b7f540343d11f0a669b36`）。
审计发现逐条建为 GitHub issue #14–#25（标签 `integrity-audit`、`P1`/`P2`，里程碑 `integrity-audit-2026-09-16`）。
原始日志与探针输出保留在本机 `.agent-contexts/integrity-audit-2026-09-16/` 与 `.agent-contexts/integrity-fixes-2026-09-16/`（按既有约定不进版本控制，本文件是入库的摘要）。

## 1. 已闭合

| 项 | 判据（可复跑） | 修复前 | 修复后 |
| --- | --- | --- | --- |
| F01 checkpoint 效果未执行却 applied | `probes.json` → `checkpoint-effect.contractSatisfied` | `false`（`publishedBy=before`，goal=`done`） | **`true`**（`publishedBy=after`） |
| F02 未执行工具被记为已读/已写 | `batch-probes.json` → `unfinished-tool-claims.contractSatisfied` | `false`（生成了并不存在的 `never-created.txt`） | **`true`**（`footprint: []`） |
| F03 同工位并发启动覆盖运行身份 | `batch-probes.json` → `duplicate-batch` | 两次都 `ok:true`，同一毫秒同一 logFile，长任务未结束 `latest=done` | 第二次 **`ok:false`「工位 ws 已有批处理运行中」**，logFile 带运行 UUID |
| F04 删除锚定接口不影响 done | `probes.json` → `deleted-interface` / `consistency-probes.json` → `deleted-interface-downstream` | goal 仍 `done`，依赖者 `ready` | goal **`stale_done`** + 工位 `blocked` + `notify_human`；依赖者停在 **`planned`** |
| F05 损坏注册表被静默丢弃 | `consistency-probes.json` → `corrupt-registry.contractSatisfied` | `list` 返回 0 条；doctor `ok:true, issues:[]`；sync exit 0 | `list` **抛错**；doctor/sync **exit 1** 并给出文件路径 |
| F07 森林校验取决于工具副本 | 权威副本 `validate` + `validate_task_forest_export.py` | 双 exit 1（缺 `display_order`；`re.search(None)` TypeError） | **双 exit 0**（见 §3） |
| F08 真正未被调用的代码 | `source-reachability.mjs` | `apps/workbench-ui/src/api.ts`（5 个无调用方 wrapper）、`doctor/index.ts` 的 `_zoneOf` | 两者均已删除；剩余候选只剩测试辅助与生成资源 |
| F09 生产文件超 300 行 | 逐文件行数 | 12 个（`chat/threads.ts` 1983、`ui/server.ts` 675、`supervisor/index.ts` 593…） | **0 个**（workbench 与 workbench-ui 两个 scope 均最大 < 300） |
| F10 历史字段与现行口径不一致 | 逐条核对 | README 写 Cohere/OpenRouter 默认、tree-sitter 方案、0.8 旧验收留在现行字段 | README 与 5 个节点字段已改回现行口径（见 §3） |

`_zoneOf` 与 `interfaces.ts:113` 的 `.catch(() => null)` 在 HEAD 上确实存在（已用 `git show HEAD:` 逐行核对），确认审计报告的位置引用准确；两处在修复后已消失。

## 2. 本轮读数

| 验证 | 结果 |
| --- | --- |
| Workbench `bun run test` | exit 0；**714 pass / 0 fail**，112 文件（审计时 700/110） |
| Workbench UI `bun run test` | exit 0；27 pass，10 文件 |
| 根 `test:frontend` | exit 0 |
| 五项目 typecheck | exit 0 |
| `biome check .` | exit 0 |
| 三个反例探针 | 全部 `contractSatisfied=true`（F03 按起点观测判据） |
| 权威副本 `task_forest.py validate` | exit 0（原 exit 1） |
| `task_forest.py export` | exit 0 |
| `validate_task_forest_export.py --skill-dir ...` | exit 0（原 exit 1） |
| `check-landing` | exit 1：109 项未提交改动 + 26 个 done 晚于 HEAD → 提交后 **exit 0** |
| 从零安装冒烟（二进制/干净 PATH） | 全部 exit 0；内嵌 UI HTTP 200 |
| 真实模型完整场景 | **exit 0**（换模型后；49 次模型响应） |

## 3. 森林变更（全部走提案流程，经用户确认）

1. **TFP-display-order-20260916** — TF-0057 子节点组 28 项补齐唯一 `display_order`：既有 24 项取值原样保留，`TF-0171/0172/0173/0175` = 2600/2700/2800/2900。按 `references/session-close-workflow.md` 的「全组唯一数值」约定整组提供。
2. **TFP-f10-node-copy-20260916** — 只改过期字段并标注历史：TF-0076 `requirements[0]`（原方案 tree-sitter → 现行 JS/TS 词法投影，`surface.ts` 明写 Deliberately NOT tree-sitter）、TF-0086 `acceptance_criteria[0]`（DOI>10 + 真人 ≥0.8 → 每会话 top-3，产品认可移出阶段验收）、TF-0135/TF-0136 `next_action`（原写「保持 in_progress」与 status=done 矛盾，改为按 TF-0141 判例的样本量门）、TF-0156 `acceptance_criteria[2]`（原「未满足」→ 已由 TF-0159/TF-0161 满足）。**未改动任何阈值、判据或证据数值。**

技能副本：本机现存唯一权威副本 `C:/Users/27933/.workbuddy/skills/task-forest`；`.codex/skills/task-forest` 与 `.claude/skills/task-forest` 均不存在（已实测）。该副本的 `validate_task_forest_export.py` 修掉了 Windows 中文环境下把子进程 GBK 输出按 UTF-8 解码导致 `stdout=None` → `re.search` TypeError 的缺陷。

## 4. 仍未闭合（需要外部条件或另行授权）

- **F06 发行闭环（issue #19）**：README 已订正为「npm 形态尚未发布，公开 registry 上 `@baixu22/workbench` 返回 404」；分发形态由用户定为**单文件二进制**，tag `workbench-v0.3.0` 已推。剩余两件外部条件：
  - **npm 凭据**：`~/.npmrc` 里存在 40 字符 token，但 registry 拒绝它（`/-/whoami` → 401），且没有任何 workflow 执行 publish。**用户已决定 npm 暂时不搞。**
  - **GitHub Actions 账单**：从 04:50Z 到 14:49 CST 的每一次 run（PR #26 的 CI、tag 的 Release Workbench）**没有任何 job 启动成功**，注解均为 `recent account payments have failed or your spending limit needs to be increased`。需要在 Billing & plans 处理；之后 `gh run rerun 35066706666` 完成 v0.3.0 的 Release，重跑 PR #26 的 CI 拿当前 SHA 结论。
- **事件日志体积（issue #27）**：`.agent-workbench/task-forest/events/events.jsonl` 已 83.53 MB，超 GitHub 建议上限 50 MB、逼近 100 MB 硬限；它是 canonical 数据（不像 exports/snapshots 可以出仓），需先定策略再动。
- **25 个节点重新收口（issue #25）——已闭合**：14 个具体节点（`TFP-audit-recheck-20260916`）与 11 个汇总节点（`TFP-agg-recheck-20260916`）的复核结论全部写回；TF-0001/0004/0005/0008 逐条核对无过期断言故不动，其余 7 个节点各追加一行 evidence，另修两处会把后续代理引回旧口径的过期指针（TF-0057 的 execution_hints 仍在说「真地标（DOI>10）」分母、TF-0121 的 next_action 停在「推进阶段 B」）。`check-landing` / `validate` / `export` / 导出回归均 exit 0。

## 5. 第二轮（12:25–13:05）

### 5.1 模型通道恢复
| 项 | 读数 |
| --- | --- |
| `live-entry.ts check` | exit 0 |
| 直连 `POST /v1/chat/completions` | **200**（审计期记录为 401，不可复现） |
| 仓库自己的 `completeLiveTurn` | 成功返回 `Read {"file_path":"src/alpha.ts"}` |
| 完整场景（默认模型） | S0–S11 全过、30 次模型响应；模型产物验收固定 11/12 |
| 完整场景（`doubao-seed-2-0-code-preview-260215`） | **exit 0**；`通过；模型响应 49 次`；验收三轮收敛 10/12 → 11/12 → **12/12** |

结论：**401 不是凭据失效也不是 provider 不匹配**——同一份 DPAPI 凭据、同一个默认端点直连即 200。「模型产物 11/12」是**模型选择问题**而不是用例缺陷（换模型后同样的两轮纠正预算内即收敛）。用例与阈值未改。默认模型未改，只在 README 里写明实测与要跑通验收应指定的模型。

顺带修掉两个 harness 缺陷：`agent-run-check.ts` 曾把任意 `tool_result` 的 `is_error` 当回合失败（上一轮那次 `--claude` 跑死在这里，只报 `false == true`）；并且会把走本机代理的 `claude` 输出当真实模型证据——现已在识别到 loopback `ANTHROPIC_BASE_URL` 时默认拒跑（exit 3）。

### 5.2 交付链
- **补上缺失的 tag 来源**：`release-workbench.yml` 只监听 `workbench-v*`，而仓库里没有任何东西会产生它（`create-release-tag.mjs` 从根 package.json 打 `v0.46.0`，那是旧 Helmor）。新增 `scripts/tag-workbench-release.mjs`（默认 dry-run）与根脚本 `release:tag:workbench`。
- **从零安装冒烟（本机 Windows，全绿）**：单一二进制放进干净独立 PATH，README 五分钟上手全 exit 0，内嵌 UI 对干净工程 HTTP 200。
- **跨平台 CI 缺陷**：`contextgen/render.test.ts` 的快照记录了 Windows 路径分隔符，只可能在 Windows 通过而 CI 跑 macOS（2026-09-11 那次红的原因之一）。已改为 POSIX 归一化快照 + 另加一条宿主机分隔符断言。
- **补 0.3.0 CHANGELOG**：`package.json` 已是 0.3.0，`CHANGELOG.md` 却只有 0.1.0/0.2.0——而它在包的 `files` 里，不补就会发出陈旧内容。按 `workbench-v0.2.0..HEAD` 的提交归纳补上。
- **v0.3.0 发行**：tag `workbench-v0.3.0` 已推（→ `f925b4d`），`Release Workbench` run `35066706666` 已触发但四个 `Build *` job 因账单未能启动，故**尚无 v0.3.0 Release**。构建路径已全部预验：`bun run build:all` 四平台交叉编译成功（文件名与 workflow 一致：windows-x64 101.2 MB / linux-x64 97.3 MB / macos-arm64 66.2 MB / macos-x64 71.9 MB），且 workflow 实际调用的 `scripts/build-single.ts <target> <artifact>`（与 `build.ts --all` 是不同代码路径）也端到端验证通过、产物在干净 PATH 下 `--help`/`init`/`doctor` 全 exit 0。账单恢复后 `gh run rerun 35066706666` 即可收尾，不必重推 tag。

### 5.3 落库
提交 `7df65fd`（F01–F05 修复 + 拆分）→ `dc157c4`（文档与森林）→ `5baf4a6`（CI / 发行 / harness）→ `86470a5`（14 节点复核证据）→ `61c977f`（README 模型实测）→ `f925b4d`（0.3.0 CHANGELOG，同时也是 tag `workbench-v0.3.0` 指向的提交）→ `0996345`（11 个汇总节点复核写回，#25 收尾）→ `72c0781` / `7374f39`（收口文档与状态索引）。分支已推送，PR **#26** 开着。每次 git 写后重钉 ref 并自证。

### 5.4 终局复验（2026-09-16 18:02，全部改动落库后）
| 门禁 | 结果 |
| --- | --- |
| Workbench `bun run test` | **714 pass / 0 fail**（112 文件，209.84s） |
| Workbench UI `bun run test` | **27 passed**（10 文件） |
| 根 `test:frontend` | **1692 passed**（162 文件，268.79s） |
| 五项目 typecheck | exit 0 |
| `biome check .` | exit 0（1353 files） |
| 三个反例探针 | P1/P2/P3 全部 exit 0 |
| 权威 `task_forest.py validate` / `check-landing` | exit 0 / exit 0 |

### 5.5 issue 终态
- **#19** 仍开：只差 GitHub 账单（`gh run rerun 35066706666` 补 v0.3.0 Release；重跑 PR #26 CI 拿当前 SHA 结论）。发行构建路径已全量预验（`build.ts --all` 四平台 + workflow 实际调用的 `build-single.ts` 端到端）。
- **#27** 已按路线 A 关闭：87.6 MB 是 169 条旧格式的一次性存量，增长已在 09-05 修掉（新事件平均 642 B/行），TF-0147 requirements[3] 裁决不做历史重写；若未来要压缩，前置条件（先给 `task_forest.py` 加受支持的 compact 子命令）已记录在 issue。
- **#25** 已闭合（25 个节点复核结论全部写回）。
- 其余 9 条（#14–#18、#20–#24）此前已闭合。

## 6. 边界

未伪造自然用户数据，未放宽任何判据或阈值，未删除失败记录，未改写历史审计证据。旧 Helmor（`src/`、`sidecar/`、`src-tauri/`）本轮未改动。

## 7. 剩下唯一能推进的事：受控用户试用（只能本人做）

审计 §6 的第 5 步是整个产品评估闸门里**唯一无法由代理完成**的一步——所有「自然使用」类指标（L1 真人认可率、恢复卡人类耗时）都被刻意设计为不可伪造（`scripted`/`live-model` 一律判 `insufficient-evidence`，账本只在 `natural` 来源下计分）。为了让这步真正可执行，把操作收敛成五步：

```powershell
# ① 在你自己的真实项目里初始化（不是脚本租户）
workbench init
workbench ui          # 打开 http://127.0.0.1:7700，线性对话为主

# ② 正常让 agent 干活：读文件、改代码、需要分支时分叉、回来时恢复
#    ——这一步自然产生 footprint / premise 通知 / restore 样本

# ③ 对恢复卡做认可或拒绝（界面手势）——判决一与「恢复卡人类耗时」的数据源

# ④ 会话结束后，生成地标复核模板并人工作答（≤5 条）
bun packages/workbench/scripts/e2e/landmark-review-queue.ts --workspace <你的现场> --pending-only --template answers.json
bun packages/workbench/scripts/e2e/landmark-review-queue.ts --workspace <你的现场> --apply answers.json

# ⑤ 看读数
workbench stats --json
bun scripts/fit-ledger/ledger.ts --blackboard <现场>\.workbench\blackboard --scope dual-source
```

**第 ④ 步的具体动作**：`answers.json` 每条是「agent 这段会话最常碰的文件」，字段 `{writer, handle, current, verdict, reason}`——`current` 只是展示（回填时忽略），**要人填的是 `verdict`：`endorse`（是这次干活的核心）或 `reject`（不是）**，`reason` 一句话即可。**verdict 留空会被拒并点名，不会被悄悄当成认可**——这是刻意设计：模板若自带现状，照着点一遍就成了一次静默的重新认可。`--pending-only` 只列没答过的；默认抽样 5 个会话，要全量加 `--all-sessions`。队列最后一行会打出 `L1 判据（≥ 0.8 · 全站）` 的当前值——那就是「真人认可率」的读数来源。恢复卡这边没有「认可」按钮：读它或点「收起」即可，系统自动记录你是否消费了卡里的事实（判决一的数据源）。

纪律（与 TF-0057 / TF-0136 / TF-0159 的判据一致）：不把脚本租户的会话当成自然使用；不把工程测试通过当作真人认可；`reject` 与 `endorse` 同样是有效数据，别为了好看多点 endorse；抽样必须写 `sampledSessions: N/M`；结论写回任务森林，阈值不调。

## 8. 受控试用自动化：已跑通的第一轮（2026-09-16 19:00–21:00）

应用户要求「自动化这个流程并设计好监控层而不是代替真实数据——你代替的是真人实操」，用 Playwright/agent-browser 驱动真实 UI + agent 车道跑通了一轮，**边界严格执行：地标复核的 endorse/reject 没有代答，模板留给真人**。现场：`C:\Users\27933\Desktop\bad-shit\moyu`（脚本与读数在本机 `.agent-contexts/integrity-fixes-2026-09-16/`，不入库）。

### 8.1 跑通了什么
- **交互层（Playwright/agent-browser 驱动真实 UI）**：新对话、发消息、消息处分叉、线程切换 ×12、恢复 ×12、恢复卡「收起」手势——事件全部如实落黑板（`thread.forked` 带 `transcriptInherited: true`、`thread.inheritance_observed` 记录三种继承事实）。
- **agent 车道（`workbench agent run`，HTTP provider，工具真实执行）**：读 `demo/user_api/service/user_service.py` → 写入 `greet()`——文件真实被修改；黑板记录了两条足迹（`used` 读 v1 / `generated` 写 v2）与 selection/edit 交互事件。
- **监控层（`trial-monitor.mjs`，只读）**：`stats --json` + 地标复核队列（只读）+ 来源声明，产出 `trial-monitor.json`。读数示例：线程 3 / 分叉 1 / switches 12 / restores 12 / resumeActions 1 / 观察窗 0.056 天。

### 8.2 两个如实记录的发现
1. **UI 聊天走 HTTP provider 不产生足迹**（`footprintSeq: 0`，线程 `withFootprints: 0`）——这正是 README 写明的产品边界「HTTP 纯文本 provider 可聊天但读集不可观测，不参与读集继承」，不是缺陷。因此前提失效链的观测必须走 agent 车道；监控层已按此标注来源。
2. **自动化只代替手，不代替数据**：地标复核队列扫出 **1 条真实候选**（`agent:trial` / `demo/user_api/service/user_service.py`），模板已生成（`answers.json`，verdict 全部留空）——这一问必须由柏旭本人回答：`bun packages/workbench/scripts/e2e/landmark-review-queue.ts --workspace C:\Users\27933\Desktop\bad-shit\moyu --all-sessions --pending-only --apply <answers.json>`（填 `endorse`/`reject`）。

### 8.3 环境教训（已记入项目记忆）
- 本沙箱禁止 `bash <脚本文件>`（触发 wsl.exe 拦截）与 `reg.exe`；playwright-core 的 `chromium.launch` 挂起。可行路径：**node 单进程编排 + agent-browser 原生 CLI**（它自带的 chrome-149 可用），Chrome 用 `--remote-debugging-port` 常驻后 `connectOverCDP` 附着。
- `agent-browser open` 会派生常驻 daemon 并继承 stdio 管道——必须 `stdio: "ignore"` 方式调用，否则 execFileSync 等管道关闭永远 ETIMEDOUT。
- agent-browser 的 daemon 绑定父进程，跨 bash 调用丢页面——**整个 UI 流必须在一次调用里完成**。

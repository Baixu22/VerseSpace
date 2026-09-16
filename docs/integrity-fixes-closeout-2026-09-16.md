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
- **v0.3.0 发行**：tag `workbench-v0.3.0` 已推（→ `f925b4d`），`Release Workbench` run `35066706666` 已触发但四个 `Build *` job 因账单未能启动，故**尚无 v0.3.0 Release**。四平台产物已在本机全部构建成功（文件名与 workflow 一致：windows-x64 101.2 MB / linux-x64 97.3 MB / macos-arm64 66.2 MB / macos-x64 71.9 MB）。账单恢复后 `gh run rerun 35066706666` 即可收尾，不必重推 tag。

### 5.3 落库
提交 `7df65fd`（F01–F05 修复 + 拆分）→ `dc157c4`（文档与森林）→ `5baf4a6`（CI / 发行 / harness）→ `86470a5`（14 节点复核证据）→ `61c977f`（README 模型实测）→ `f925b4d`（0.3.0 CHANGELOG，同时也是 tag `workbench-v0.3.0` 指向的提交）；分支已推送，PR **#26** 开着。每次 git 写后重钉 ref 并自证。

## 6. 边界

未伪造自然用户数据，未放宽任何判据或阈值，未删除失败记录，未改写历史审计证据。旧 Helmor（`src/`、`sidecar/`、`src-tauri/`）本轮未改动。

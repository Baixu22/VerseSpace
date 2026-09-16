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
| Workbench `bun run test` | exit 0；**713 pass / 0 fail**，112 文件，243.14 秒（审计时 700/110） |
| Workbench UI `bun run test` | exit 0；27 pass，10 文件 |
| 五项目 typecheck | exit 0 |
| 三个反例探针 | 全部 `contractSatisfied=true`（F03 按起点观测判据） |
| 权威副本 `task_forest.py validate` | exit 0（原 exit 1） |
| `task_forest.py export` | exit 0 |
| `validate_task_forest_export.py --skill-dir ...` | exit 0（原 exit 1） |
| `check-landing` | exit 1：109 项未提交改动 + 26 个 done 晚于 HEAD（提交后复跑即转 0） |

## 3. 森林变更（全部走提案流程，经用户确认）

1. **TFP-display-order-20260916** — TF-0057 子节点组 28 项补齐唯一 `display_order`：既有 24 项取值原样保留，`TF-0171/0172/0173/0175` = 2600/2700/2800/2900。按 `references/session-close-workflow.md` 的「全组唯一数值」约定整组提供。
2. **TFP-f10-node-copy-20260916** — 只改过期字段并标注历史：TF-0076 `requirements[0]`（原方案 tree-sitter → 现行 JS/TS 词法投影，`surface.ts` 明写 Deliberately NOT tree-sitter）、TF-0086 `acceptance_criteria[0]`（DOI>10 + 真人 ≥0.8 → 每会话 top-3，产品认可移出阶段验收）、TF-0135/TF-0136 `next_action`（原写「保持 in_progress」与 status=done 矛盾，改为按 TF-0141 判例的样本量门）、TF-0156 `acceptance_criteria[2]`（原「未满足」→ 已由 TF-0159/TF-0161 满足）。**未改动任何阈值、判据或证据数值。**

技能副本：本机现存唯一权威副本 `C:/Users/27933/.workbuddy/skills/task-forest`；`.codex/skills/task-forest` 与 `.claude/skills/task-forest` 均不存在（已实测）。该副本的 `validate_task_forest_export.py` 修掉了 Windows 中文环境下把子进程 GBK 输出按 UTF-8 解码导致 `stdout=None` → `re.search` TypeError 的缺陷。

## 4. 仍未闭合（需要外部条件或另行授权）

- **F06 发行闭环**：README 已订正为「npm 形态尚未发布，公开 registry 上 `@baixu22/workbench` 返回 404」，但发布动作本身未执行，也未取得当前 SHA 的 CI 结果。分发形态需要用户决定（npm 包 vs GitHub 二进制）。
- **真实模型通道**：审计期脚本默认端点返回 HTTP 401；本轮改用本机 claude-code 登录态跑了一次真实批处理读写验证，agent 回合 exit 0 但脚本断言未过（6.8 秒内完成，疑似未产生预期足迹）。尚未定论，没有替换密钥、没有把失败当通过。
- **25 个节点重新收口**：F01–F10 的工程判据已绿，但节点字段写回与 `check-landing` 转 0 是后续动作（issue #25）。

## 5. 边界

未伪造自然用户数据，未放宽任何判据或阈值，未删除失败记录，未改写历史审计证据。旧 Helmor（`src/`、`sidecar/`、`src-tauri/`）本轮未改动。

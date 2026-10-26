# 四节点接力实施与验收（2026-10-26）

受测对象为 Workbench `0.5.0` 源码候选。本轮落实检查入口、确定的冗余清理和 Codex
真实写侧验收；没有打 tag、创建 Release、发布 npm 或扩大 ADR-0024 的退役范围。
原始日志、RPC、profile 和现场保存在本机 `.agent-contexts/all-nodes-relay-2026-10-26/`，
注册读数的仪器、命令、输入范围与摘要保存在 `evidence/`。

## 检查接线与清理

TF-0312 扩展现有三包严格 TypeScript 入口，纳入活动工具、配置、hooks 测试和 E2E。
24 份原漏检活动文件逐项进入实际 `tsc --listFilesOnly` 输出；历史文件
`docs/handoff/2026-09-30-moat-probes.ts` 保留为旧行为对照。严格设置继续启用，未用
`any` 或文件跳过消除诊断。原 22 个诊断通过对象类型检查、异常代码收窄和测试记录存在性
断言解决。UI 的常规 Vitest 入口固定一个 worker；根命令增加串行 `test:gates`。

接线后的首次 Workbench 全套为 1241 pass / 1 fail，跨进程追加遇到锁文件 `EPERM`。
锁创建与后续存在性检查之间可能发生释放；补充的回归在修复前失败，修复后通过。
现在独占创建会有界重试短暂分享冲突，持续权限错误仍抛出，锁互斥与陈旧锁接管保持。
该阶段完整复跑为 1243 pass / 0 fail、204 文件、34 snapshots、5575 expect、358.06 秒。

TF-0313 重新扫描生产、测试和重导出消费者后，完成以下清理：

| 对象 | 最终处置 |
| --- | --- |
| `hashLines`、`HTTP_PROVIDERS` | 无调用者，移除声明和相关重导出 |
| `captureContextRollback` | 移除旧帮助函数及两个专用测试；实际注册表快照仍由 `checkpoint-effects.ts` 采集 |
| `isTransientStreamError` | 移除函数、专用正则与两条专用断言；保留按失败类别判断重试的生产策略和测试 |
| `cacheHitRatio` | 移除帮助函数、重导出及专用断言；保留协议解析、usage 归并与上限测试 |
| 15 个无引用领域类型别名 | 删除别名，保留相邻正在执行的 Zod schema |
| `AppIconProps` / `AppIcon` | 从 generator 移除再生成，删除不再生成的类型文件；39 个图标名称和 glyph 映射保持 |
| 四张无引用旧图 | 精确删除 `readme-hero-refined.png`、`readme-hero.png`、`readme-premise-ledger.png`、`readme-workspot-workflow.png`，当前树减少 3,228,134 bytes |

类型别名包括 TribunalFolded、TribunalItemState、ArtifactManifestBody、AcceptanceCriteria、
Artifact、BlackboardEffects、UnblockEntry、Registry、WorkspotBinding、ContextNeeds、
CheckpointZone、WriterStatus、QueueFile、ConflictsFile 和 ResumeNotePatch。

保留当前 `readme-hero-flat.png`、三张恢复卡证据图、五个 HTTP-only 入口、ThreadSidecar、
三个 footprint 分发副本、Claude/Codex 有消费者的流夹具、Cursor/Kimi/OpenCode 协议样本、
兼容迁移、ALL_PROVIDERS_OFFERED、resetHostFilesystemProbe、FORBIDDEN_CARD_PHRASES 和
构建 assets manifest。没有新增直接依赖，没有删除本地工作树、现场、个人技能或历史 Git。
图片 bytes 只表示当前树变化，不表示历史体积缩减。

## Codex 真实写侧与生命周期

TF-0264 使用真实 Codex CLI **0.164.0-alpha.11.1**、隔离 `CODEX_HOME`、本机匹配的
`ccs-404/deepseek-v4.1-flash` Responses provider、显式 freeform 原生工具和 `on-request`。
RPC tap 只属于可选验收工具，逐行转发真实 CLI，不替代 app-server、不模拟模型，不接入
产品运行链。每轮的 `threadId` / `turnId` / `itemId`、请求和响应、`commandActions[].path`、
generated footprint、seal、最终线程状态均可在本机原始证据中关联。

| Codex 沙箱 / Workbench 条件 | 原生写落盘 | live seal | 写足迹 | 冻结控制 | 线程终态 |
| --- | --- | --- | --- | --- | --- |
| danger-full-access，own-fresh | 是 | 0 | 1 | pass | idle |
| danger-full-access，own-stale | 是 | 0 | 1 | block | idle |
| read-only，own-fresh | 是 | 1 pass | 1 | pass | idle |
| read-only，own-stale | 否 | 1 block | 0 | block | idle |
| read-only，新鲜前提且声明 `src` 为只读 | 否 | 1 readonly_area block | 0 | block | idle |

以上写回合 `readDuringWrite` 均为 0。没有把模型重读、patch 上下文不匹配或 Codex 自身
拒写当成 seal 成功。只读区的拒绝单独命名，没有混作失效前提命中。

生命周期仪运行真实读取后，分别在真实 `turn/started` 后结束底层 Codex 进程，以及调用
Workbench `cancel` 结束监督进程树。两次均留下一个错误，实际进程退出且线程回到 idle；
随后各自重启 app-server 并 `thread/resume`，进程 PID 改变、Codex 会话 ID 保持，读取
成功并留下归因足迹。五项检查通过，三次读取可归因。这里的取消是当前 Workbench 的
进程终止机制，不声称已实现 `turn/interrupt` 的协议取消终态。

TF-0262 的两条验收路径据此都有明确结果：有审批的有限路径可关联封印；无审批的路径
已证明不受保护。**Codex 保持 experimental/limited，未增加仓库级写保护保证。**
warning、thread/readState/changed、thread/goal/cleared 等未建模通知仍在 stderr 明确
报告；本轮没有用这几类通知证明功能或扩大协议覆盖。

可复现的可选仪器：

```powershell
# 使用自己的匹配 provider 配置与非默认模型，密钥只通过环境变量传入。
# 两个隔离 CODEX_HOME 保持同一模型与 on-request；分别设置
# sandbox_mode = "danger-full-access" 或 "read-only"。
$env:WB_CODEX_BIN = '<真实 codex.exe 的绝对路径>'
$env:CODEX_HOME = '<隔离 profile 的绝对路径>'
$env:WB_VERIFY_TRACE_DIR = '<本轮独立的本地原始证据目录>'
$env:WORKBENCH_CODEX_COMMAND = '"<bun.exe>" "<repo>/packages/workbench/scripts/verify/codex-rpc-tap.mjs" app-server -c notify=[] -c model_providers.<provider>.apply_patch_tool_type=freeform'
bun packages/workbench/scripts/verify/codex-native-pair.ts
bun packages/workbench/scripts/verify/codex-native-pair.ts --expect-unsealed
bun packages/workbench/scripts/verify/codex-native-pair.ts --readonly-area
bun packages/workbench/scripts/verify/codex-lifecycle.ts
```

`codex-native-pair` 的正常判据要求实际读前提、同写者与路径、一条 seal、预期写足迹及
idle 终态；只读对照还要求 live `readonly_area` 分类。读回合、来源或模型不能测量时，
不记通过。danger-full-access 的普通成对仪为 exit 1；注册负向读数使用 `--expect-unsealed`，
仅当两轮都实际完成、native 写落盘、有写足迹、无 seal 且冻结控制匹配时 exit 0。
它仍报告写保护 `passed=0`，与保护通过分开；任何不能测量的子回合使成对仪 exit 2。

## 最终门禁与落地

最终读数正在通过 `scripts/claims/record-reading.mjs --run` 采集；完成后本段记录实际
exit、数量、源码提交、构建资产、浏览器现场与任务提案状态。当前没有以旧读数替代本轮
最终验收，也没有把仍待确认的提案写作已应用。

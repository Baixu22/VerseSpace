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

`replay.ts` 的异常代码类型收窄使观察程序字节摘要改变，受控重放校验据此拒绝旧
`observerSha256`。仅在 `replay-plan-freeze.json` 记录该观察程序的新摘要；planDigest、
场景、裁判、朴素/旧适配器五份冻结文件、基线 tree、分组、预算与预期值均未改变。
两个冻结校验继续通过，声明范围触及该摘要文件的读数按门禁规则重新取得。

接线后的首次 Workbench 全套为 1241 pass / 1 fail，跨进程追加遇到锁文件 `EPERM`。
锁创建与后续存在性检查之间可能发生释放；补充的回归在修复前失败，修复后通过。
现在独占创建会有界重试短暂分享冲突，持续权限错误仍抛出，锁互斥与陈旧锁接管保持。
该阶段完整复跑为 1243 pass / 0 fail、204 文件、34 snapshots、5575 expect、358.06 秒。

最终取证的第一轮全套为 1241 pass / 1 fail、204 文件、34 snapshots、5585 expect、
342.45 秒；失败在 UI 取消用例的延迟 stdin fallback 写入已经关闭的管道，触发 EPIPE。
记录器拒绝这轮读数。监督层现在在发送、退出和错误路径清除 fallback 定时器，取消开始后
拒绝新的 stdin 写入。独立真实子进程回归在旧代码测得取消后仍尝试写入一次，修复后为零；
监督层与 UI 路由 25 项通过、0 失败，严格类型检查通过。最终全套另在修复后的源码重录。

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

清理提交实际为 26 个文件，1 行新增、181 行删除，净减 180 行。真实流量计数器本轮重数
原捕获账本得到 22 个不同 footprint 写者和 10,705 个累计写者实例；两者保持独立，
不沿用先前读数中错误的 footprintWriters=10,722。

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

产品源码受测提交为 `0c537e67eb66e5a31eb7d6fa22bc5e303cea9d6e`。登记由
`scripts/claims/record-reading.mjs --run` 实际执行各声明仪器；本机汇总再对原始输出、
注册字段和 raw digest 逐项复核。新增交接与读数提交不改变该产品源码。

| 读数 | 本轮实际结果 |
| --- | --- |
| Workbench 完整套件 | 1243 pass / 0 fail，205 文件，34 snapshots，5589 expect，310.35 秒 |
| dashboard 常规入口 | 75 pass / 0 fail，20 文件，单 worker，37.88 秒 |
| context-rot | 69 pass / 0 fail，6 文件，171 expect |
| 严格 typecheck | exit 0；24/24 原漏检活动文件已纳入，1 份历史探针保留 |
| 五组根门禁自测 | 5 文件，52 pass / 0 fail / 0 skip |
| upload surface 自测 | 两组实际合计 31 pass / 0 fail |
| Windows Chromium | 15 pass / 0 fail / 0 skip，42.1 秒 |
| 产物契约子套件 | 输入来源 49、产物来源 9、消费 59、固定副本 29、便携证据 47，均 0 fail |
| 冻结受控对照 | 18 例、7 组，增强零安全错误/unknown，进程失败与超时为零 |
| 四次不变消费 | `repeat-consume`：朴素检查 4 次，增强检查 1 次 |
| 合成成本 | 3 尺度，1 预热 + 5 样本，无预算超限或安全违规；三个尺度均无总时间净收益 |
| Codex 全权限负向读数 | measured=true，写保护 passed=0；实际不受保护 unsealed=2/2，负向仪 exit 0 |
| Codex 原生审批对照 | 正常/失效前提 2/2，只读区 1/1；对应仪器均 exit 0 |
| Codex 生命周期 | measured=true，5/5，3 次读取可归因，exit 0 |

浏览器现场保留在本机 `D:/tmp/workbench-e2e-586b052b`；current/stale/unknown 的截图
由同一 UI 源码生成，既有[恢复卡记录](2026-10-25-resume-artifact-card.md)继续保留。
检查只覆盖 Windows 执行；非 Windows 执机与自然真人研究维持 ADR-0024 的 deprecated。

接力汇总遇到两处口径错误，原输出均保留。本地汇总原本对所有场景取最大检查次数，
因此把 `no-edit-recheck` 的两次显式重验错算进不变消费；已改为只读取冻结
`repeat-consume`，其 4→1 与注册读数及原始摘要一致。消费子套件本轮实际 59 项，
旧值 57 被汇总拒绝后重新实际执行并登记为 59；没有改场景、预期值或裁判。

本轮最终仓库门禁另登记 `claim-root-gates`、`claim-doctor-clean`、`claim-lint`、
`claim-upload-surface-clean` 和 `claim-forest-landing`。前四项实际 exit 0：根自测 52/0/0，
doctor 118 条架构断言中 0 条失效，lint 无 error，严格上传面 0 违规。结果以对应
`evidence/readings/` 文件的 instrument_exit、受测提交和 raw digest 为准；
claims 实际为 30 valid、3 historical observation、0 problems，任何 exit 2 均不作通过。
森林的仓内权威落地门读取本地默认分支 main；它与外部 CLI 的远端拓扑检查分别量测。
`git fetch origin` 实际 exit 0，`342ba59` 上外部 `check-landing` 实际 exit 1：HEAD 的
6 个提交尚不可达 origin/main，并因此报告 main 的代码差异；该次还看到 4 份待提交读数。
维护者确认后，9 个接力提交已通过普通 `git push origin main` 推送，刷新 origin 后
HEAD 与 origin/main 同为 `e9d6a117a4c80c728e05648f5efb640c9dfff480`。外部
`check-landing` 实际 exit 0：dirty_count=0、problem_count=0；据此再应用结案提案。
后续提交只补本交接及其受影响的仓库门禁读数，继续普通推送并复核最终远端一致性。
历史归档孤立提交与未归因节点仍是该 CLI 的 notes，不记成新回归。本轮不发布版本。

## 构建资产

四平台编译与 Windows native/Bun JS 两形态隔离冒烟均已实际通过，覆盖 init、doctor、
stats、headless UI 和 bundled UI。首次冒烟误用默认 `workbench.exe` 而失败；改为显式
指定本轮 `workbench-windows-x64.exe` 后重录成功，失败原输出仍留本地。

| 资产 | bytes | SHA256 |
| --- | ---: | --- |
| `workbench-windows-x64.exe` | 101491712 | `5b0241b99b57f227298312b5149c4bd35d387ff8e12360d693713a1fafabc696` |
| `workbench-linux-x64` | 97601664 | `ec719dbec57d6af658714127edabdba3c8509e7f965688f3c119bc10a94b03b9` |
| `workbench-macos-arm64` | 66484322 | `f6fbc52ec4ebb806739eb9b7fac040c15b7e9f41be658c73db49ff313476b6e4` |
| `workbench-macos-x64` | 72187984 | `46486c77d8b3fed8e5ec6f64892dc7015db9fe02adebeef925044918defb09fd` |
| `workbench.js` | 1703279 | `8a410946a21227dc55d28a9b0dfc5202c29515c1c6878b1663070b3965dd0bb0` |

Windows、Linux、macOS 文件头分别为 PE、ELF、Mach-O；只有 Windows 资产有执行证据。资产保存在
本机 dist，本轮没有上传资产或创建 tag/Release/npm 发布。早先候选收口记录的旧摘要
保留为当时读数，不代表本轮资产。

## 森林结案结果

2026-10-26 维护者明确确认推送与结案。外部落地复核通过后，CLI 实际应用提案
`TFP-2026-10-26-all-nodes-closeout`，exit 0。TF-0312、TF-0313、TF-0264、TF-0262
均为 done；各 evidence 数量为 4、5、23、6，完整保留原证据数组、父子关系与验收条件。

canonical 森林实际共 313 节点：296 done、17 deprecated、0 开放；`todo --json` 返回
空数组，validate exit 0，51 条历史偏差均已结案。17 个退役节点保持退役，Codex 的
experimental/limited 边界保持。HTML 由应用后的 canonical 状态重新导出；任务森林、
提案、原始日志与现场均留本地，仅交接与注册读数进入仓库。

## 独立复验与收尾（2026-10-26 第二轮）

维护者随后要求“做好收尾并尝试完整卫生处理、修改提交、合并”。在 `main` /
`origin/main` 同为 `04d976e`、原始读数与森林未改写的前提下，本轮重新实跑了一次仓库门禁；
原始输出保存在本机 `.agent-contexts/all-nodes-relay-final/`。

| 复跑项 | 本轮读数 |
| --- | --- |
| `lint` | exit 0；812 文件，仅 1 条既有 info |
| `typecheck` | exit 0；三包严格 TypeScript |
| Workbench | 1243 pass / 0 fail，205 文件，34 snapshots，5589 expect |
| dashboard | 20 文件、75 tests 全通过 |
| context-rot | 69 pass / 0 fail，6 文件，171 expect |
| 根门禁自测 | 52 pass / 0 fail / 0 skip |
| `doctor` | exit 0；118 条架构断言 0 失效 |
| Windows Chromium | 15 pass / 0 fail / 0 skip |
| upload surface | 0 违规、541 条相对链接 0 断链；自测 16 + 15 全通过 |
| native + Bun JS | native 与 JS 两形态均通过 init、doctor、stats、headless UI、bundled UI |

这次复跑**不替换** `evidence/readings/` 中的注册读数，也不把 3 条 Codex 历史 observation
升级为当前通过；它只证明在本轮 HEAD 上，现有已登记的工作仍可复现。复跑后 `check:claims`
仍为 30 valid、3 historical observation、0 problems，`check-forest-landing` 与外部
`check-landing` 均为 exit 0。

同步检查到两类可整理存量：除 `main` 外仅 `chore/phase1-closeout-20260921` 含 1 个未合入
提交（森林/文档记账），其余 34 个远程任务分支均已包含于 `main`；`D:\tmp` 下 5 个
`workbench-e2e-*` 为已结束的隔离现场。历史孤立提交、未归因节点、任务森林与原始证据
不因“卫生处理”而删除。

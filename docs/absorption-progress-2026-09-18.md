# 吸收计划执行进展（2026-09-18）

TF-0176「主线收口与支线吸收」的执行记录。规划背景见
[`helmor-absorption-deep-exploration-2026-09-17.md`](helmor-absorption-deep-exploration-2026-09-17.md)；
逐节点验收读数在任务森林的节点 evidence 里（`workbench` 的 task-forest 导出可读），
本文只是**给人读的摘要**——原始提案副本与探针输出留在 `.agent-contexts/`（不进版本控制）。

本轮从「工作区里躺着上一轮未落库的成果」开始：TF-0191 的实现与 TF-0183/0188/0191 的森林状态
都已做完但没有提交。先验证（四套门禁全绿）再落库，然后继续阶段 5 的开发。

阶段 5 的七个节点（0202–0208）在本轮全部完成；其中 TF-0208 先经一轮纯侦察，
把节点标题与实际缺口对齐后才开工。

## 交付

| 节点 | 交付 | 提交 |
| --- | --- | --- |
| TF-0191 | 线程头标注可观测性：`ThreadMeta.lastRun{provider,readObservability,at}` 每轮记录；HTTP 车道明示「读集不可观测、不参与前提继承」，可观测线程不加标签 | `3ffec6c` |
| TF-0188 / TF-0183 | 改名后发版链静态核查 + 本地镜像构建干跑（远程 `workflow_dispatch` 仍受 Actions 账单阻塞，偏差记在节点里） | `3ffec6c` |
| TF-0202 | `git/worktree.ts`（worktree 清单 / 分支持有者 / 移除 / 路径同一性）+ `git/stash.ts`（结构化 stash 结局）；派发前预检分支占用，结构化拒绝 `branch_in_use` | `b1a49c8` + `b3533ca` |
| TF-0192 | README「两条聊天车道的观测能力」对照表与选择建议；设置面板在读集不可观测的车道上当场说明后果 | `f08267b` + `4aacc19` |
| TF-0203 | 派发三段式（状态行 → worktree → 激活）+ 双向回滚；`runOnce` 每轮开头恢复被中断的派发；doctor 点名 `interrupted_dispatch` | `7bf4d5d` + `00ff246` |
| TF-0204 | `chat/provider-capabilities.ts` 单一能力表；四处能力判断改读表；后端把能力带给 UI，面板按能力标注 | `2718a30` + `4b65770` |
| TF-0205 | `supervisor/liveness.ts`：15s 心跳 / 45s 软阈值 / 135s 判死 + EPIPE 与「对端真的走了」严格区分；静默不再无声挂死 | `f7c69c5` + `57e31a4` |
| TF-0207 | 回合 id 预分配：回合一开就广播助手消息 id，流式事件与持久化消息共用它，客户端免二次匹配 | `8b12d56` + `f812a1e` |
| TF-0208 | 合并预检结论封闭化：`MergePreflight` 四臂（clear / conflicts / unsupported / unresolved）+ `git/merge-tree.ts` 能力探测；「git 拒绝回答」不再被读成「合并干净」 | `cb1e266` + `da3618f` |
| TF-0206 | Claude 纯渲染归约 + `delta/parts/done` 协议 + read/search/只读 shell 折叠组；19 个真实 fixture 回放与 Workbench UI send/reload 共用 reducer | `d20205a` + `492dfdb` + `94dfd92` |
| TF-0190 | 受控试用取证：UI claude 车道真实回合产生足迹（`withFootprints=1`），HTTP 对照组为 0；可复算脚本与证据在 `.agent-contexts/tf0190-trial/` | 本轮（见下） |
| TF-0198 | 渲染门与熔断：`resume-card/circuit.ts` 熔断器投影（dismiss 率 >50% 分支行降 L0 指针，可自恢复）+ `mergeBranchFactRows` 渲染门（≥3 分支折叠一行，refs 并集保留）+ dismiss 清注入队列（`clearNotices` + `dismissResumeCard`，路由返回即队列已空）+ `stats.lifecycle.resumeCardCircuit` 与渲染共用同一读法 | 本轮（见下） |
| TF-0199 | 前端 resume-card 升级 + 展开/点击埋点：分支行折叠面收敛为「指针 + 一行结构摘要」，展开区给全部 L1 行 + 「由足迹拼接」标注；新白名单事件 `thread.resume_card_shown`（渲染分母，按恢复边界去重）+ `resume_action` 带 `label` 行标签；`stats.lifecycle.branchEngagement` 读出展开/被点比例（`branch-engagement.ts` 折叠，与熔断器同窗配对） | 本轮（见下） |

## 验收读数（本轮实跑）

| 验收 | 读数 |
| --- | --- |
| TF-0202 ①git/ 从 0 测试到有覆盖 | 新增 11 例（临时仓库夹具：清单解析含 detached、建立与移除、拒删项目根、stash 三种结局） |
| TF-0202 ②两工位抢同一分支 | 3 例：第二个被结构化拒绝且不留下 half-built worktree、自己持有不误拒、空闲零拒绝记录 |
| TF-0203 ①崩溃后 doctor 无孤儿 | 5 例：恢复并留事件、恢复幂等、doctor 恢复前报/恢复后不报、两条回滚路径（断言写状态序列 `initializing → idle` / `initializing → active → idle`） |
| TF-0204 ①能力表覆盖 | 5 例：四 provider × 五字段矩阵写全值、表与 schema 集合一致、可观测性由能力推导、`requiresApiKey ↔ channel` 不变量、投影不泄密钥 |
| TF-0205 ①双信号区分结局 | 6 例：真子进程退出走 `exited`；管道损坏报 `pipe_broken` 且不判死；软/硬阈值各只报一次；事件重置静默窗口 |
| TF-0207 ①id 一致 | 后端 1 例（工具调用/结果/文本三条路径 + `messages.jsonl` 落盘核对）、UI 1 例（占位 → 真 id → delta 命中 → done 不多出一条） |
| TF-0208 ①「没有结论」不得伪装成「干净」 | 对照实验（同一批真实 git 输出喂旧/新两种读法）：`ref 不存在` 与 `零提交仓库 HEAD` 旧读法都判 CLEAR，新读法判 UNRESOLVED；`干净` 与 `真冲突` 两行读数不变（无回归） |
| TF-0208 ②能力缺失时不误解析 | 老式 trivial `merge-tree` 的输出（`<mode> <oid> <stage>\t<path>`）在旧读法下把 git 对象哈希当成冲突路径，新读法判 UNRESOLVED |
| TF-0206 ①真实 fixture 回放 | 19 个 `src-tauri/tests/fixtures/streams/claude/*.jsonl`、763 个事件、28 个 text delta；显式 render decision 的 `undecided=0`，最终 parts 与持久化 done 形状一致 |
| TF-0206 ②IPC 量化 | 每个流增量比较（不是用户键盘输入）：baseline **206,320 B** → `delta + finalized parts + done` **126,212 B**，节省 **80,108 B**，降幅 **38.83%** |
| TF-0190 ①claude 车道非零足迹 | 受控试用（`.agent-contexts/tf0190-trial/ui-lane-trial.ts`，复用 `scripts/e2e` driver）：真实 claude CLI 在临时 git 仓库完成「Read×2 + Write×1」的 UI 回合，工具调用 Read×2 / Write×1；`stats --json` → `threads.withFootprints=1`（total=1，footprintCoverage=1），`.workbench/events` 落 2 条 footprint 事件 |
| TF-0190 ②HTTP 对照组仍为 0 | 同一提示词走 HTTP 车道（provider=openai-chat，DPAPI 凭据 senseaudio-s2-flash）：回合正常完成、tool-call part 0 个；`stats --json` → `threads.withFootprints=0`（对照通过，确认 HTTP 读集不可观测是产品边界而非缺陷） |
| TF-0198 ①dismiss 后注入队列空 | 通知 ×2 入队 → `resume-note/dismiss` → 通知文件被撤（ENOENT）+ `resume_card_dismissed` 观测落事件 + 空队列再 dismiss 不报错；清的是未投递部分（已投递在投递时已被 ack 移除），符合 D3-Q2「未投递时完全撤」 |
| TF-0198 ②熔断记录且可恢复 | 3 次 dismiss-only 恢复 → `stats.lifecycle.resumeCardCircuit` state=open / dismissRate=1（渲染面同步降 L0 指针行：链接与溯源保留、L1 细节撤下）；3 次消费后 → closed 且 L1 回来。7 例单测覆盖：无样本 rate=null、样本不足不熔断、50% 开区间、消费过不算负样本、消费不护短、switch 关窗、滑动窗口 |
| TF-0198 渲染门 ≥3 合并 | 2 分支 → 2 行不变；3 分支 → 1 行折叠（`分支 · 3 个分支有动静`），逐分支写集足迹 ref 在并集、合并行不带单一 branch 链接、stale 文件行独立渲染 |
| TF-0199 展示/埋点链路 | 渲染带分支行的卡片 → `resume-card/shown` 落 `thread.resume_card_shown`（branchRows 行标签）；同一卡片对象重渲染/StrictMode 双跑不重复计数；分支行折叠面只露首行 + 「还有 N 行」，展开出全部 L1 行 + 「由足迹拼接」；展开与查看分支手势带 `branch:<id>` 标签 |
| TF-0199 ①比例可从 stats 读出 | shown 落事件 → 同窗展开 → `stats --json` 的 `lifecycle.branchEngagement`：branchRowsShown=1 / engaged=1 / ratio=1。折叠 7 例单测：无渲染 ratio=null、未消费 ratio=0（「人们很少回头」可测）、切走后动作不算数、跨线程隔离、同窗重复渲染去重、末尾未关窗结算 |
| 全量/聚焦门禁 | workbench **885 pass / 0 fail**（131 文件）；workbench-ui **55 pass / 0 fail**（恢复卡 8 例）；typecheck 五包 0 错；Biome 408 files 0 错 |
| 森林门禁 | 权威副本 `C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py` 的 `validate` / `export` / `check-landing` 均 exit 0；`check-landing` 读出 2 项 done 晚于 HEAD（TF-0201、TF-0206），因本轮改动尚未提交，属预期读数（提交后应收敛）。此前记录的「已安装 CLI 未提供 `check-landing` 子命令」系找错路径，已按实测更正；误导来源（`report-2026-08-29.md` 里 `.agents/skills/.../task_forest.py` 这个不存在的缩写路径，实为 `C:/Users/27933/.workbuddy/skills/...`）已一并修正，同类过期指针不再引后来者偏离 |

## 节点终态与进度口径

- 阶段 1（合规与身份）：**done**（TF-0183，含 0184–0188）。
- 阶段 2（足迹命门轻路）：**done**。TF-0191（UI 诚实标注）、TF-0192（README/设置面板）、TF-0190（claude 车道足迹验证）三项全部完成。
  2026-09-19 受控试用取证闭合：claude 车道 `withFootprints=1`、HTTP 对照组 `0`，验收两项判据均满足。
- 阶段 3（自用观察窗）：**规格修订（日历窗 → 样本配额窗），随时可重启**。2026-09-19 曾记录 t0 基线
  （restores=140、resumeActions=1、withFootprints=0，快照 `docs/fit-ledger-2026-09-19-phase3-t0.md`）；
  同日用户确认「高强度使用代替长周期使用」：TF-0194 改为样本配额窗（≥30 次带卡恢复、≥5 次消费动作
  含 ≥2 次 dismiss，来源声明 n=1 高强度窗），TF-0195 的依赖边 TFE-0315 降级为 related_to
  （见偏差 `observation_window_rescoped`）。
- 阶段 5（纯 TS 可靠性吸收）：**done 100%**。0202–0208 全部 done；0206 以独立一轮完成 Claude 归约、折叠、增量协议和 UI 消费。
- 阶段 6（MCP server）：**done 100%**。TF-0210（stdio JSON-RPC 2.0 骨架）、TF-0211（五条只读工具 + 体积控制）、TF-0212（Claude Code 接入验证 + README）全部完成；`workbench mcp` 已被 Claude Code 实际连接（✔ Connected），零新依赖。
- 阶段 7（容器耦合清零与删码）：**done 100%**。TF-0220（杂物治理）、TF-0214（postinstall 去 sidecar）、TF-0215（pre-commit 分车道）、TF-0216（图标生成参数化）、TF-0217（L3 残留清除）、TF-0218（删除 apps/marketing 与 apps/registry）、TF-0219（退役闸门 ADR-0014）全部完成；四项容器耦合清零（ADR-0014 决策 2），`apps/` 下只剩 workbench-ui。
- 阶段 4（D3-Q2 分支动静）：**TF-0196/0197/0198/0199 全部 done，剩 TF-0200 与风险观察 TF-0223**。
  TF-0196 补齐 TF-0132 废止缺口（checkpoint 会话链接 + merged_back 白名单）；TF-0197 落地分支 L1 结构摘要
  （账本差/写集/接口Δ/merge-guard 预测/Verifier 状态/失效前提数，refs 全溯源，R3 措辞互斥，空分支零痕迹）；
  TF-0198 落地渲染门与熔断（≥3 分支折叠一行、dismiss 清注入队列、dismiss 率 >50% 降 L0 且可恢复）；
  TF-0199 落地前端升级与展开/点击埋点（`stats.lifecycle.branchEngagement` 出展开/被点比例）。
  风险节点 TF-0223（「dismiss 率 >50% 被降回 L0」）的缓解已内建：降级是设计内出口，是否触发由阶段 3
  配额窗的真实数据回答——配额窗开跑后 branchEngagement 与 resumeCardCircuit 两个读数都有了。
- TF-0176 总进度 **84.4%**。口径：分母 = 七个阶段里程碑估时之和（480+360+120+1200+1500+600+900
  = 5,160 分钟），分子 = 已完成具体任务的估时和（3,335 + 阶段 4 前置的 600 + TF-0198 的 180 +
  TF-0199 的 240 = 4,355），即 4,355 / 5,160 = 84.4%。这是 2026-09-17
  建立的口径，
  与叶子求和（4,655）不同，改动它就会让历史读数失去可比性。

## 偏差与未闭合

- `unwired_export`：TF-0202 交付的 stash 原语目前只有测试覆盖、没有生产调用方（支线 Rust 侧服务于
  move-local 通路，主线还没有）。按契约面导出并注释，接上时机是 TF-0203 之后的 move-local 通路；
  TF-0217 的「未引用导出」清理需要排除本项。
- `acceptance_judgement_narrowed`：TF-0204 的验收「grep `provider ===` 字面量比较为 0」按字面
  不可达——`http-request` / `http-stream` / `http-run` 里的 6 处比较是**线协议**选择（发哪种报文、
  怎么解析 SSE），不是能力判断。判据收窄为「能力判断里的字面量比较为 0」，理由写在
  `http-request.ts` 的文件头注释里。
- `spec_title_imprecise`：TF-0208 的标题原写「merge-guard 吸收 forge 模式」（暗示移植），侦察实测显示真实工作是
  **修主线已存在的缺陷**——旧代码把 `merge-tree` 的 `code=1` 一律当冲突答案，「git 拒绝回答」（ref 不存在、
  零提交仓库里的 `HEAD`）因此被读成「合并干净」。标题里「merge 方式协商」在主线字面不可达（全仓 `git merge`
  0 处，主线只预测合并、从不执行合并），`Unauthenticated` 在主线无对应物。标题已按实测修正。
- `fit_ledger_scope`：TF-0190 的 requirement「记录到 `docs/fit-ledger.md`」按字面不可达——fit 账本的 scope 根是
  TF-0120 产品树（`scripts/fit-ledger/ledger.ts loadScope(workspace, "TF-0120")`），吸收计划（TF-0176）节点不在
  账本行集内；且账本纪律 2「测试通过不算使用」要求受控试用（scripted）不把 fit 推离 `unknown`。验收读数因此记录在
  本文档与任务森林节点 evidence，未手改自动生成的 `docs/fit-ledger.md`（其头部明令「不要手工编辑」）。
- `observation_window_rescoped`：TF-0194 的「一周」只是标题措辞，验收从未含日历判据；唯一使用者是运行者
  本人（n=1），不存在总体代表性问题，要的是事件密度不是日历跨度；且精确展开率埋点本身是 TF-0199 的
  交付物，「阶段 4 等阶段 3 基线」依赖部分循环。2026-09-19 用户确认：日历窗 → 样本配额窗（≥30 次带卡
  恢复、≥5 次消费动作含 ≥2 次 dismiss，fit-ledger 行声明 n=1 高强度窗；dismiss 计为熔断器一等信号，
  配额目标开窗前登记防需求效应），TFE-0315（TF-0195 depends_on TF-0194）降级为 related_to（TFE-0348）。
  TF-0136 判决四的 14 天自然使用门留在判决里记录，不并入观察窗；判决一的 ≥0.3 门不为配额凑数。
- 本机提交链尚未推送远端（远端 main 落后于这条 feat 分支）。npm 发布与 GitHub Actions 仍受账单阻塞。

## 下一轮候选

阶段 5、阶段 6、阶段 7 已全部结项。吸收计划（TF-0176）剩两块：**阶段 3（自用观察窗）**已改规格为样本配额窗
（t0 基线保留在 `docs/fit-ledger-2026-09-19-phase3-t0.md`，按 TF-0194 修订协议开窗、先登记配额），
**阶段 4（D3-Q2 分支动静）**只剩 TF-0200（adopt「以分支为主线」手势：拓扑操作、改身份不改内容、快照可逆）
与风险观察 TF-0223（熔断是否真的触发，由配额窗数据回答）。渲染门、熔断、前端升级与展开/点击埋点均已落地——
开窗即有完整读数（branchEngagement / resumeCardCircuit）。后续开发轮继续用主线 UI claude 车道跑，
dismiss/消费事件持续喂给熔断器与配额窗。存量删除（src/src-tauri/sidecar）条件已满足，
按 ADR-0014 决策 3 留待独立执行轮。

阶段 4 前置的可复算材料：`packages/workbench/src/chat/resume-card/l1-summary.ts`（+ 7 例测试）、
`.agent-contexts/tf0217-scan/`（ts-prune 报告 + 结论）、`.agent-contexts/tf0190-trial/`（各阶段落库提案副本）。

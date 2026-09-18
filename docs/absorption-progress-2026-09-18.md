# 吸收计划执行进展（2026-09-18）

TF-0176「主线收口与支线吸收」的执行记录。规划背景见
[`helmor-absorption-deep-exploration-2026-09-17.md`](helmor-absorption-deep-exploration-2026-09-17.md)；
逐节点验收读数在任务森林的节点 evidence 里（`workbench` 的 task-forest 导出可读），
本文只是**给人读的摘要**——原始提案副本与探针输出留在 `.agent-contexts/`（不进版本控制）。

本轮从「工作区里躺着上一轮未落库的成果」开始：TF-0191 的实现与 TF-0183/0188/0191 的森林状态
都已做完但没有提交。先验证（四套门禁全绿）再落库，然后继续阶段 5 的开发。

## 交付

| 节点 | 交付 | 提交 |
| --- | --- | --- |
| TF-0191 | 线程头标注可观测性：`ThreadMeta.lastRun{provider,readObservability,at}` 每轮记录；HTTP 车道明示「读集不可观测、不参与前提继承」，可观测线程不加标签 | `3ffec6c` |
| TF-0188 / TF-0183 | 改名后发版链静态核查 + 本地镜像构建干跑（远程 `workflow_dispatch` 仍受 Actions 账单阻塞，偏差记在节点里） | `3ffec6c` |
| TF-0202 | `git/worktree.ts`（worktree 清单 / 分支持有者 / 移除 / 路径同一性）+ `git/stash.ts`（结构化 stash 结局）；派发前预检分支占用，结构化拒绝 `branch_in_use` | `b1a49c8` + `b3533ca` |
| TF-0192 | README「两条聊天车道的观测能力」对照表与选择建议；设置面板在读集不可观测的车道上当场说明后果 | `f08267b` + `4aacc19` |
| TF-0203 | 派发三段式（状态行 → worktree → 激活）+ 双向回滚；`runOnce` 每轮开头恢复被中断的派发；doctor 点名 `interrupted_dispatch` | `7bf4d5d` + `00ff246` |
| TF-0204 | `chat/provider-capabilities.ts` 单一能力表；四处能力判断改读表；后端把能力带给 UI，面板按能力标注 | `2718a30` + `4b65770` |

## 验收读数（本轮实跑）

| 验收 | 读数 |
| --- | --- |
| TF-0202 ①git/ 从 0 测试到有覆盖 | 新增 11 例（临时仓库夹具：清单解析含 detached、建立与移除、拒删项目根、stash 三种结局） |
| TF-0202 ②两工位抢同一分支 | 3 例：第二个被结构化拒绝且不留下 half-built worktree、自己持有不误拒、空闲零拒绝记录 |
| TF-0203 ①崩溃后 doctor 无孤儿 | 5 例：恢复并留事件、恢复幂等、doctor 恢复前报/恢复后不报、两条回滚路径（断言写状态序列 `initializing → idle` / `initializing → active → idle`） |
| TF-0204 ①能力表覆盖 | 5 例：四 provider × 五字段矩阵写全值、表与 schema 集合一致、可观测性由能力推导、`requiresApiKey ↔ channel` 不变量、投影不泄密钥 |
| 全量门禁 | workbench **739 pass / 0 fail**（116 文件）；workbench-ui **33 passed**（11 文件）；根 / workbench / workbench-ui typecheck 全 0；biome 全仓 0 |
| 森林门禁 | validate / export / 导出回归 / check-landing 全 0（每轮提交后复跑，`done 且晚于 HEAD` 的节点数为 0） |

## 节点终态与进度口径

- 阶段 1（合规与身份）：**done**（TF-0183，含 0184–0188）。
- 阶段 2（足迹命门轻路）：**in_progress**。TF-0191、TF-0192 已 done；**TF-0190 转 blocked**——
  它要的是「有 claude 凭据的环境」这个外部条件，本机（含受控试用机）都没有，留 `proposed`
  只会让它在每轮扫描里假装可开工。阶段 2 的验收（非零 `withFootprints` 与 HTTP 对照组）在拿到
  凭据前无法取证，所以里程碑不结项。
- 阶段 5（纯 TS 可靠性吸收）：**in_progress 50.3%**。0202 / 0203 / 0204 已 done，剩 0205–0208。
- TF-0176 总进度 **24.7%**。口径：分母 = 七个阶段里程碑估时之和（480+360+120+1200+1500+600+900
  = 5,160 分钟），分子 = 已完成具体任务的估时和（1,275）。这是 2026-09-17 建立的口径，
  与叶子求和（4,655）不同，改动它就会让历史读数失去可比性。

## 偏差与未闭合

- `unwired_export`：TF-0202 交付的 stash 原语目前只有测试覆盖、没有生产调用方（支线 Rust 侧服务于
  move-local 通路，主线还没有）。按契约面导出并注释，接上时机是 TF-0203 之后的 move-local 通路；
  TF-0217 的「未引用导出」清理需要排除本项。
- `acceptance_judgement_narrowed`：TF-0204 的验收「grep `provider ===` 字面量比较为 0」按字面
  不可达——`http-request` / `http-stream` / `http-run` 里的 6 处比较是**线协议**选择（发哪种报文、
  怎么解析 SSE），不是能力判断。判据收窄为「能力判断里的字面量比较为 0」，理由写在
  `http-request.ts` 的文件头注释里。
- 本机提交链尚未推送远端（远端 main 落后于这条 feat 分支）。npm 发布与 GitHub Actions 仍受账单阻塞。

## 下一轮候选

阶段 5 剩 TF-0205（supervisor 存活心跳接收端）、TF-0206（claude-router 折叠与增量）、
TF-0207（turn id 预分配）、TF-0208（merge-guard 吸收 forge 模式）；阶段 6（MCP server）与
阶段 7（容器耦合清零与删码）不依赖外部条件，全是本机可做的纯代码工作。

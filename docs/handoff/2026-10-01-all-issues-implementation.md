# 开放 issues 修复候选（2026-10-01）

范围为本轮开始时 GitHub 的 14 个开放项：#31、#45–#57（#49 是总表）。起点 `68ebef5`，包括此前多轮未提交修复；保留原有 README、图像和上传政策工作，不把它们归为本次新增实现。ADR-0025 限定新增能力，ADR-0024 的退役范围保持不变。本文是实现和实跑记录，不表示已发行或所有 issue 已关闭。

## 实现对应关系

| Issue | 本地结果 |
| --- | --- |
| #45 | Codex 成功终态才确认通知；error / failed / interrupted 保留待投递队列。 |
| #46 | 生产封印读取本写者当前有效性；其他写者和历史待送通知不误封，已送达也不等于已解决。 |
| #47 | 大文件使用既有 size 回退；大小变化可检测，连续不同大小的变化不被去重吞掉。 |
| #48 | 规划开关旁常驻提示只在新 CLI 进程生效，标签不宣称即时生效；浏览器回归覆盖。 |
| #50 | Vitest JSON 报告记录声明集合、实际名称/状态、计数、hash 与退出码；缺失、损坏、旧报告、零用例、子集、重名、跳过均不能满足范围。显式配置/检查脚本/锁文件 hash 与执行运行时绑定，旧无报告结果保留范围未知。 |
| #51 | checkpoint 声明单产物与输入；输入变化产生独立当前状态。新重验入口生成新证据，不撤销 applied 历史、不重复执行旧 effects；CLI JSON、MCP 与恢复卡可继续处理。 |
| #52 | 保存原始 repo/cwd/输入/产物版本、本次执行工位与目标 ref/tree；目标推进单独失效。同内容暂存/提交保持声明文件语义；旧工位重验不把不同目标输入标为匹配。目标输入匹配也不等于合并结果已验收。 |
| #53 | 新增成功送达窗口的 reread / observedNewVersion / artifactModified / scopeVerified 证据，分别保留 unknown；旧版本重读、无意义写入不升级为新版本或验证。保留旧 repaired 算法与历史。 |
| #54 | 读取 JSON 与恢复卡展示 content-hash / size-only / unknown。用同尺寸大文件、快照淘汰、多版本范围和未知工具保留对照；接受同尺寸盲区，不冒充检测成功。 |
| #55 | 新增可复跑合成 JSONL 成本仪器；去掉恢复查询一次重复足迹读取，追加日志与完整重放仍为事实来源，没有引入缓存索引或数据库。 |
| #56 | 本轮 GLM 默认预算完整 live 已实跑通过，见下文；历史失败保持原记录。 |
| #31 | 原生 fileChange add/update 夹具已走渲染与成功落账；失败/declined/未知状态不产生写证据。真实当前 CLI 是否产生可归因审批仍须看独立实验，不能由夹具升级为完整写保护。 |
| #57 / #49 | 构建、注册读数和候选落库正在独立收口；不把工作区通过称为远端 main 或旧发行物通过。 |

## 单产物验收与限制

隔离 Git 仓库运行真实检查子进程：api v1 → v2 导致 consumer 检查失败；复读输入仍待重验；改成兼容实现后通过，api v3 的新重验无需再改产物也通过。无关文件变化不使声明产物失效。原 applied checkpoint 与应用事件不重放，goal 的历史 done 保留。真实 Git worktree 验证旧工位保持 v1、main 推进到 v2 时独立目标失效；在旧工位再次通过仍标记 target inputs-differ。显式检查脚本的 hash 改变使证据失效。

依赖是调用者声明，不推导任意传递依赖。检查脚本、配置和锁文件应放进 evidence.inputs；漏声明的环境、外部服务、provider 内部记忆和原子快照不在保证内。结构/读取顺序仍只是候选，未升级为因果。缺工位、文件或目标身份保留 unknown。

## JSONL 测量（Windows x64 / Bun 1.3.14）

仪器：`bun packages/workbench/scripts/benchmark-ledger.ts`。AMD Ryzen 7 7745HX，16 个逻辑核、约 16.3 GB 物理内存；该机还有其他进程，结果不是隔离硬件基准。每操作首次打开 Blackboard 的读数加 7 次热重复；“冷”不表示清空了操作系统缓存。逻辑 JSONL 读取量由 API 计数，含计数用 stat 的开销；不声称物理磁盘 IO 或瞬时峰值内存。

最终仪器修正了并发 byte 计数的 read-before-await 竞争；早期 byte 数废弃，仅下表使用修正后读数。时间是单轮分布，不能据此推断所有机器提速比例。

| 日志条数 / 片段数 | 当前前提 median / p95 ms | reconcile median / p95 ms | seal median / p95 ms | restore median / p95 ms | restore 逻辑读取 MB |
| --- | --- | --- | --- | --- | --- |
| 1,000 / 8 | 4.75 / 6.42 | 11.46 / 12.07 | 11.80 / 13.55 | 8.55 / 10.01 | 1.03 |
| 10,000 / 64 | 40.61 / 43.61 | 63.96 / 70.11 | 60.48 / 63.35 | 78.69 / 82.99 | 10.29 |
| 50,000 / 256 | 358.73 / 366.43 | 500.20 / 511.61 | 442.35 / 463.00 | 561.82 / 611.02 | 51.96 |

5 万条下已有可见线性成本；本轮只消除已证重复读取。没有足够部署规模或延迟预算依据引入持久增量投影；更高规模仍未验证，不能称无瓶颈。三个规模均验证截断末行不丢弃此前读集，重开 Blackboard 后结果一致，坏行原文保留。没有靠删旧前提换取性能。

## GLM 默认预算真实完整运行

使用维护者提供的本机 Responses 端点与 glm-5.3-flash。凭据仅通过隐藏输入进入临时启动进程环境，不在仓库、命令参数或本报告中。第一次 Windows PowerShell 启动因把 Bun 的 stderr 提示当异常而退出，尚未形成模型读数；改用 PowerShell 7 启动同一命令。

`bun run test:live` 完整运行 **exit 0**，38 次工具驱动模型响应、38 次请求尝试。集成阶段、独立产物检查、旧读者恢复/复读/复核、三个持久分支均完成。请求仍是默认 120 秒，没有用此前 180 秒专项替代。原始现场为本机 `workbench-e2e-ae47XX`，原始报告/日志保持本地；响应数不含独立 HTTP SSE 回合，不能当计费总请求数。

这只是本次模型/配置组合通过，不覆盖自然使用、真人收益或原生 Codex 写保护；9 月 30 日两次默认失败和一次扩展预算专项记录不改写。

## 通道矩阵

| 通道/样本 | 读取/变更 | 失败与重投 | 证据层级 |
| --- | --- | --- | --- |
| stream-json 工具适配器 + GLM Responses | 本轮完整现场通过 | 旧失败保持，模型新运行完成 | 真实 HTTP 模型、脚本驱动工具 |
| Workbench 原生 Responses SSE | 本轮集成阶段通过 | 传输 idleTimeout 有真实 HTTP 延迟回归 | 真实 HTTP；没有 CLI 工具观测保证 |
| Codex fake app-server | 同写者/跨写者封印回归通过 | error/failed/interrupted 保留通知，成功重试确认 | 受控真实子进程，不是模型证据 |
| Codex 保留原生 fileChange 样本 | add/update 帧成功落账，零 undecided | declined/failed 不落账 | 既有真实样本回放 + 当前本地测试 |
| 当前真实 Codex CLI + GLM | 独立 own-fresh / own-stale，结果另列 | 没有故意制造当前真实 provider 失败样本 | 真实 CLI；无审批不能推断封印通过 |

## 本地验证进展

定向：范围验证 28/28；产物/MCP/CLI 43/43；Codex 相关 16/16；强度/片段/行为证据相关通过。首次完整 workbench 为 1091 pass / 1 fail，唯一失败是新增 revalidate 没加入 argv 覆盖表，已补并通过定向测试；最终全量读数和构建读数在后续收口节记录。

UI 18 files / 68 passed；context-rot 69 pass / 0 fail；doctor 118 条断言、0 失效；上传门禁 exit 0，534 条相对链接、0 断链（当时文件集）。类型检查中的新 argv 用例 RegExp 类型已修正后通过。未运行非 Windows 执行或真人研究。

原始过程证据位于本机 `.agent-contexts/all-issues-20261001/`，不上传。任务森林未修改。发布版本、tag、Release 资产没有改动。

## 固定候选与真实 Codex 结论

源码先保存为 `da64f8c`；注册器实际重跑 workbench：1093 pass / 0 fail、176 files、34 snapshots、4829 个断言，160.40 秒。Windows Chromium 为 14/14、28.8 秒。干净工作树从该提交安装 frozen lockfile 并构建：native 与 JS 两种形态的 init / doctor / stats / headless UI / bundled UI 均通过。构建刷新了跟踪的 UI 资产清单，单独保存为 `2d2765d`，随后在该候选完整重跑 workbench 仍为 1093/0。

登记基准读数时注册器正确拒绝旧声明的固定 11 场景预期：当前仪器已有 14 场景。`c812a24` 将声明集合明确扩为 14（包含大文件变大、未变、同尺寸改写三个对照），没有缩小范围或手签旧结果。其后的注册读数必须重新执行匹配的仪器。

原生 Codex 使用隔离 CODEX_HOME 与用户指定 GLM 服务，完成两组 own-fresh / own-stale（第二组显式 Windows elevated sandbox、high effort），四个实验进程均 exit 0（仅表示测得读数）。两组结果相同：fresh 无失效前提，写入落盘，但 writeFootprints=0、sealEvents=0；stale 有 1 条本写者失效前提、写入未落盘，但 sealEvents=0，冻结控制判 block。

第二组轨迹确认模型实际用 shell 调用本机 apply_patch 包装器，而不是原生 fileChange。fresh 在包装器/PowerShell 引号失败后升级 shell 执行才写成；stale 因 CLI 只读沙箱拒写而停止。**不能把 CLI 沙箱拒写归因于 Workbench 封印**，也不能把 fresh 落盘写成原生写足迹通过。已停止重复调用，不无上限抽样。#31 仍缺真实、可归因的 native 审批对照；其历史 L1 “stale 仍落盘”声明也没有在这两组中复现，旧读数保持 stale，不篡改成绿灯。

根工作区原有 README、两张图像、上传政策和调研文档独立保留。验收副本为干净源码候选，任务森林不复制；因此森林落地门禁在该副本按约定 exit 2（不能测量），不伪装通过。两类非绿项（原生 Codex 实验、个人森林落地）与代码测试/构建结果分别报告。

干净副本还发现两个交付问题：森林门禁把 detached HEAD 的 `(no branch)` 当作分支 ref，已用 Git `for-each-ref` 列出真实 refs 并用真实 detached 临时仓库回归；无森林时仍按约定 exit 2。上传链接测试发现 17 条本机存在、克隆后缺失的引用。修复所需的既有短板调查和探针附件补入候选；8 份仅本机保留的历史文档改引用其最后已发布版本 `799f89c` 的永久链接（逐个 git cat-file 验证存在，提交可从 origin/main 到达）。只修复 ADR 的引用 URL，保留原决定和叙述，没有把旧文档重新上传或改写历史结论。

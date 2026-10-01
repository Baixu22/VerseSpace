# Issues #45–#48 本地修复与 #31 复核

2026-09-30，Windows / Bun 1.3.14。基线 `68ebef587e08d0bfab1e3d52b75b7680da81dbde` 加本轮工作区改动。
已有 README、上传面策略和图像等未提交改动保留；本记录不把它们归为本轮修复。
本轮未提交、推送、合并或关闭 GitHub issues；以下是本地工程读数。

## 修复范围

| Issue | 结果与边界 |
| --- | --- |
| [#45](https://github.com/Baixu22/VerseSpace/issues/45) | `runCodexTurn` 仅在收到 completed 终态且无错误时返回成功，调用方据此确认通知。provider error、failed、interrupted 保留队列，成功重试后才写送达事件。不能把 startTurn 正常返回当成功。 |
| [#46](https://github.com/Baixu22/VerseSpace/issues/46) | Codex 封印入口按当前 writerId 过滤 pending claims。受控子进程实测其他写者的失效前提不阻断当前写者；当前写者的前提仍阻断。 |
| [#47](https://github.com/Baixu22/VerseSpace/issues/47) | 采用 A：复用已有 size，不增加捕获开销。两条检查路径统一投影为 `size:N` 版本，通知身份和去重也使用它，连续不同大小的变化分别可见。恢复检查把有 size 的大文件纳入 comparable；无 hash 且无 size 的历史 claim 仍 unsupported。同尺寸改写仍无法检测，不能把大小相等解释为内容相等。 |
| [#48](https://github.com/Baixu22/VerseSpace/issues/48) | 采用文案方案：开关旁常驻说明仅在下次新启动的 Claude CLI 进程生效，下一回合可能复用当前进程。选中标签改为“规划已选”，避免暗示已生效；不改变进程恢复语义。 |

回归用例位于 `codex-notice-seal.test.ts`、`large-file-premises.test.ts`，浏览器既有规划开关用例增加文案检查。

## 实际执行

| 命令 | 读数 |
| --- | --- |
| 8 个相关测试文件的 `bun test` | exit 0，53 pass / 0 fail |
| `bun run lint` | exit 0，662 files，随后新增浏览器断言的单文件 Biome 检查也 exit 0 |
| `bun run typecheck` | exit 0，三个包 |
| `bun run test:workbench` | exit 0，1034 pass / 0 fail，34 snapshots |
| `bun run test:workbench-ui` | exit 0，18 files / 68 tests passed |
| `bun run test:context-rot` | exit 0，69 pass / 0 fail |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言，0 失效，8 条生成物引用排除；blackboard 正常 |
| `bun packages/workbench/scripts/benchmark-premises.ts --json` | exit 0，14/14；新增大文件变大、未变、同尺寸改写三个场景 |
| `bun run check:upload-surface` | exit 0，违规 0、断链 0；存在两条旧 node_modules 链接告警，不是 gate 违规 |

基准大文件三场景通知量分别为 1、0、0；单次检测耗时 27.52、6.98、2.69 ms。
这是合成契约读数，不是真实模型精度、修补效果或性能统计。
基准脚本不支持 `--help`，最初探测返回 exit 1；随后按源码声明参数执行上述正式测量。

浏览器首轮 exit 1，13 pass / 1 fail：规划按钮旧选择器仅匹配“规划中”，切换后找不到新标签。
已同步选择器并补上常驻边界提示检查；全量重跑 **exit 0，14/14 passed（32.8s）**。
使用 `pwsh -NoProfile -File scripts/win/e2e-browser.ps1 -ApiPort 7820 -UiPort 5298 -KeepWorkspace`，真实 Chromium、Vite 和隔离后端；未调用模型。
原始日志留在本机 `.agent-contexts/issue-batch-20260930/`，不上传。

## #31 为什么仍未验收

已读取 issue 最新评论及 [9 月 27 日实验记录](2026-09-27-codex-seal-e2e.md)、[原生审批关联记录](2026-09-27-codex-filechange-seal.md)。
历史“完全无样本、seal 未接线”已被取代：保留了真实 `fileChange` 样本，审批可经 itemId 找到路径并调用 seal。
本轮重新执行了相关夹具和假 app-server 门禁，但没有重新调用真实模型。

仍缺一次同时具备可观测目标读取、失效前提和写审批的真实 stale run；原生 `fileChange` 的完整写足迹落账也仍是已知覆盖缺口。
本轮只检查配置是否存在，未读取或输出凭据：`WB_VERIFY_LLM_KEY`、`WORKBENCH_CODEX_COMMAND` 均未配置。
因此没有调用付费模型，不能关闭 [#31](https://github.com/Baixu22/VerseSpace/issues/31)，也不能把本轮 #46 的受控测试升级为真实 Codex 写保护通过。
ADR-0023 的实验通道限制不变；ADR-0024 退役的非 Windows 执行与真人研究不作为补验条件。

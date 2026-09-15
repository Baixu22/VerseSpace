# 审计错误修复与验证 · 2026-09-16

验收基线 HEAD：`da24a6187b6ee5f4df12620750993587ea700632`。范围是 9 月 15 日收口审计及 issue #9–#13；用户已授权完成正式收口和提交。

[可公开核验的精简证据](audit-errors-evidence-2026-09-16.json)包含各门禁的实际结果、13 个相关代码文件的 SHA256、原始日志 SHA256 和真实模型响应记录。原始临时现场保留在本机。

工程实现已提交为 `283580516c7a0fd0cd7477f6d61f98a119dc2ea3`，提交钩子通过。之后应用收口提案，将 TF-0174/TF-0175 转为 done；任务森林 validate、HTML 导出与导出回归通过。源码哈希与完整验收时一致。

## 审计项处置

| 项目 | 本轮结果 |
| --- | --- |
| #9 GUI 准入记录 | ADR 订正为 27 条路由，修正 CLI 名称、GUI 独有会话操作、批处理取消能力与可回放性描述；正式节点 TF-0174 已完成 |
| #10 argv 执行回归 | 前序实现已在当前树中；32 项 CLI 用例与完整 Workbench 套件复验通过 |
| #11 真实 agent run | 修复状态和足迹缺陷；3 个真实会话、8 次模型调用、前提失效→通知→复读修复通过 |
| #12 产品评估重启记录 | 三项可核验判据、新开节点约束及 #7/#8 关系均已明确；自然使用指标保持未验证 |
| #13 unknown 分类 | 已交付账本补齐 7 条结构性、2 条证据缺口分类及处置；历史读数、fit 值和来源保持不变 |

## 本轮代码修复

新旧默认配置都补齐 Claude stream-json 所需的 `--verbose`。runner 同时检查模型结果与进程退出码；模型报错不会再写为 done。runner 与聊天通道逐个采集工具块，失败工具不记成成功读写；批处理的相对路径按工位目录解析。足迹持久化失败会结束为 failed。supervisor 可接收 argv 数组，保留引号、空格和多行输入。

新增测试先复现错误再转绿。真实模型验证独立检查原始流、会话终态、文件内容、足迹版本及事件；启动成功本身不算运行通过。

## 验证记录

所有日志位于 `.agent-contexts/audit-errors-2026-09-16/run-20260915T222636Z/`。

| 验证 | 实际结果 | 日志 |
| --- | --- | --- |
| Workbench 全量 | exit 0；700 pass，110 文件，1 快照 | workbench-full.log |
| 主前端全量 | exit 0；1,692 pass，162 文件 | frontend-full.log |
| sidecar 全量 | exit 0；418 pass，1 个既有平台相关 skip | sidecar-full.log |
| Workbench UI 全量 | exit 0；27 pass，10 文件 | workbench-ui-full.log |
| context-rot 全量 | exit 0；65 pass，6 文件 | context-rot-full.log |
| 五项目 typecheck | exit 0；全部通过 | typecheck-final.log |
| Biome | exit 0；1,284 文件，无修复项 | biome-final.log |
| Rust 全量 | exit 0；1,695 pass，15 个目标，0 ignored | rust-full.log |
| Clippy / Rust 格式 | 均 exit 0；Clippy 全 targets 零警告 | clippy-final.log |
| Workbench UI + 原生/JS 构建 | exit 0；14 个嵌入资源，清单已刷新 | workbench-build.log |
| 原生/JS 产物独立冒烟 | exit 0；两者 init/doctor/stats/无头 UI/嵌入资源均通过 | workbench-built-smoke.log |
| context-rot Node 产物 | exit 0；构建及 hooks 同步完成 | context-build.log |
| 当前黑板 doctor | exit 0；blackboard.ok=true，issues=[]，0 失效路径 | doctor-final.json |
| 指引文件引用扫描 | exit 0；350 引用，325 有效、2 生成物、23 未确认、0 失效 | context-repo-final.json |
| 真实模型批处理 | exit 0；3 会话、8 次调用、5 条足迹，闭环通过 | live-agent-run-fresh.log |
| 历史账本补录 | 7+2 分类；逐行指标与数值不变 | ledger-annotation.json |
| 任务森林 | 两份本轮提案已应用，TF-0174/TF-0175 为 done；validate、export 和导出回归均通过 | 正式提案、graph/nodes.json 及 HTML |

真实现场报告为 `agent-run-live-sW9dur/report.json`。通知由验证宿主转发至下一次批处理 prompt；这是实际交付，不代表常驻批处理推送能力。写者均为 agent，不构造 human 样本。

旧测试凭据的 HTTP 401 和本机 Claude 代理未完成工具任务的失败现场保留；只有新通道的通过现场计入结论。新凭据未写入报告、源码或旧凭据文件。

当前证据证明本地工程范围，不代替远端 CI 或自然用户认可。TF-0173 的历史堆损坏归因仍受原始转储缺失限制；该历史取证项不以本轮测试通过结案。

六套测试合计 **4,597 pass、1 skip、0 fail**。Vite 构建成功，仍有主 chunk 大于 500 kB 的提示（本次约 1.09 MB）；Clippy 与 Biome 没有警告/错误。未扩大本次审计范围去调整 UI 分包。

最终森林为 175 节点：166 done、8 deprecated、1 blocked。唯一 blocked 是 TF-0173 的历史取证事项；自然用户评估的重启条件与未验证指标保持原边界。

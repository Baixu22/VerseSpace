# TF-0291：收到的工具事件覆盖与未知范围

每轮捕获结束追加一条 `input_coverage` 观察，复用 Blackboard 事件账本。
分母只限于运行时收到的候选文件工具事件：Claude Read/Grep/Glob/LS 及 Shell 工具，
Codex commandExecution。Shell 是候选，不证明发生了读取；其无路径或未建模结果保持未知。
非文件工具不在分母，不能据此盘点所有真实文件操作或模型使用情况。

有效工具 id 的重复事件只计一次；匿名候选逐项计数，缺身份无法关联成功结果时保持未完成。
分别保存候选/成功/失败/未完成事件数、有可归因内容的事件数、路径凭据强度与内容/采样关联。
事件与路径的单位分开。tool-observed 不要求当前采样相同，different/unknown 单独记录；
因此输入覆盖不是正确性、修复率或当前前提有效性。

零候选、HTTP unobservable、旧日志缺摘要及无效摘要均没有可计算的覆盖比值，不写 100%。
失败或未完成不落成功足迹；覆盖观察独立落盘，不写入产物世界裁决。
旧日志不回填强证据。查询只读取最近已记录轮次，明确 `latest-recorded-turn` 和事件 refs。

CLI `sessions show --json`、批量 agent view、MCP footprints/resume_cards 与恢复信息调用
同一个覆盖投影。MCP 仍受体积上限约束；读取不写事件。前端呈现由 TF-0310 接续。
没有新增依赖、数据库、看板或通用 Shell 解析器。通知 repaired/准确率统计保持原有口径。

## 本轮 Windows 实测

Bun 1.3.14，Node v24.22.1，loopback 走 NO_PROXY；未调用外部模型服务。

- 聚焦覆盖与生产入口：13 pass / 0 fail，4 文件，982 ms，exit 0。
  含真实 CLI JSON、真实 loopback HTTP、匿名候选、零样本/旧日志、路径强度、批量失败/未完成，
  MCP/恢复一致性以及保留协议经过 Claude/Codex router 的重复结果计数。
- 完整 Workbench：1190 pass / 0 fail，191 文件，34 snapshots，173.48 s，exit 0；
  独立进程状态的墙钟 173.628 s。
- 三包 typecheck、lint、五文件冻结校验、严格上传面：exit 0；lint 保留一条既有 info。
- 在完整套件后补齐 MCP 空足迹分支的同一截断上限；对应 MCP 与覆盖回归另跑并核对。

直接证据归属 `claim-moat-input-origin`：记录器在实现提交之后实际执行包含 schema、
捕获与覆盖的聚焦命令，再登记读数。全局其他声明可能过期，最终收口仍须逐项刷新。
日志、进程状态和森林留本机；只上传可重放源代码、测试和本交接。

## 重放

```bash
bun test packages/workbench/src/blackboard/input-coverage.test.ts packages/workbench/src/blackboard/input-coverage-surfaces.test.ts packages/workbench/src/chat/input-capture.test.ts packages/workbench/src/chat/tool-footprints.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

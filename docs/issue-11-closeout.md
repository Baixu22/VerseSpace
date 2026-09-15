# Issue #11：真实 agent run 验证

2026-09-16。使用生产入口 `packages/workbench/src/index.ts`，经独立 CLI 进程执行 `workbench agent run`。模型为 SenseAudio `senseaudio-s2-flash`，通过既有 live actor 适配成 stream-json；模型实际调用 Read/Write，未使用确定性替身。

## 本次结果

真实场景退出 **0**：3 个批处理会话、8 次模型调用、5 条足迹事件，3 对 agent_started/agent_finished。首次读取与写入完成后，第二个真实模型会话改变文件；检测到 1 条失效前提，转发 1 条通知，第三个会话重新读取并修复输出，再次核验已无该读者的失效前提。

现场与报告：

- `.agent-contexts/audit-errors-2026-09-16/run-20260915T222636Z/agent-run-live-sW9dur/report.json`
- 同现场 `.workbench/agents/`：生产 runner 的会话状态和原始模型流。
- 同现场 `.workbench/live-agent/`：3 份模型会话转录及调用/尝试记录。
- 同现场黑板：writer 均为 `kind=agent`，没有 human 样本。

报告保留每条 CLI 命令的退出码、模型会话 ID、used/generated 的路径与版本，以及前提链路的计数。判断成功同时检查终态、模型 result 和磁盘内容，不把启动返回的 `ok: true` 当成任务完成。

本次通知由验证宿主通过下一次批处理的 prompt 转发，并在该回合成功后确认送达；没有声称批处理具备常驻推送通道。批处理状态位于 agents/，不会自动创建 GUI 的 chat thread。工程场景与自然使用、真人认可保持分开。

## 修复与回归

- 新配置及精确匹配旧默认值的配置自动使用 `claude -p --verbose --output-format stream-json`；自定义命令保留。
- runner 同时检查模型 result 与进程退出码，防止 `is_error` 或错误 subtype 被标为 done。
- runner 和聊天通道逐个采集同一事件中的工具调用，拒绝的工具不产生成功足迹；批处理相对路径按工位目录解析。
- 足迹落盘错误结束为 failed，不留下未处理的 Promise 拒绝。
- supervisor 支持原生 argv 数组，避免验证命令在空格、引号及多行 prompt 上重新拆词。

`src/agents/capture.test.ts` 与 `src/chat/tool-footprints.test.ts` 已先复现失败，再验证修复；完整结果汇总于本轮审计收口报告。

## 复跑

在 `packages/workbench` 下执行，凭据通过进程环境或既有 DPAPI 存储读取：

```powershell
bun run scripts/e2e/agent-run-check.ts --run-live --out <证据输出目录>
```

环境字段为 `E2E_LLM_KEY`、`E2E_LLM_MODEL`、`E2E_LLM_BASE_URL`。脚本每次创建新的隔离目录；未显式传 `--run-live` 时拒绝运行。也支持 `--claude` 使用本机 CLI，但须核验实际通道和输出。

本次密钥仅由安全输入传入验证进程，没有更改旧凭据文件。旧凭据的 HTTP 401 与本机代理返回无效工具参数的失败现场保留，不计入以上通过结果。

任务森林正式节点 TF-0175 已创建并引用本次验证。可公开核验的精简证据见 [审计证据](audit-errors-evidence-2026-09-16.json)，包含模型响应 ID、会话/足迹、门禁结果、代码和原始日志的 SHA256；原始临时现场留在本机。

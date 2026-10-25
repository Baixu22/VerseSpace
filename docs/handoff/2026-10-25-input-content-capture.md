# TF-0290：成功工具结果与输入内容凭据

Claude 聊天、批量 agent 和 Codex router 现在在成功工具结果到达后生成输入凭据。
调用时只保留路径候选；采集时完整文件 hash 与工具返回内容 hash 分开，竞争时不会
把返回 v1 误记成采集文件 v2。该关系复用 TF-0289 的 `tool-observed` / `different` / `unknown`。
不声称模型使用了返回内容，也不扩大封印或所有 Shell 工具的观察范围。

## 支持范围与保守边界

- Claude Read 只接受已有保留样本的结构：单个结果、`tool_use_result.file` 路径/内容/行数，
  逐行编号的原文与结构化内容完全一致。offset/limit 要实际覆盖其行范围；缺字段、多结果歧义、
  截断、目录和搜索输出均未知。批量捕获按工位解析相对路径，重复调用/结果不会重新采样。
- Codex 只绑定保留的单文件 `cat` 形状，要求 completed、exitCode 0 和完整 aggregatedOutput，
  同时核对结构化 read action 和命令路径。支持保留的 zsh/bash/sh `-lc` 包装；不接受 flags、
  管道、多路径、通配符、变量展开或复合命令。未建模 Get-Content 仍不算内容观察。
  读取路径相对命令 cwd 解析。Claude Bash 同样只接受有界的单文件 cat。
- `utf8-lines-v1` 只把 CRLF 规范为 LF；其他文本和末尾 LF 全部保留。原文摘要不做该规范化，
  完整文件版本仍按原始字节计算。行段内容先规范化再选取，避免末行残留 CR。
- 文件一次读取的同一 buffer 提供完整 hash、行段 hash 和 spool，并记录读取前后 size/mtime/ctime
  是否稳定；这不是原子快照保证。文件缺失或采样不可核对时，返回凭据的版本关联未知。
  超过 2 MB 继续 size-only，同尺寸改写不可测；目录、明显截断/过大返回不会升级为内容观察。
- 未知、无效或错配返回不能抹掉较早的已测前提。真实可核对重读仍可刷新输入；不改产物来源。

采样 IO 从 `footprint.ts` 提取为 `footprint-sample.ts`，原导出入口兼容。没有新增运行时依赖、
数据库、sidecar、通用 Shell parser 或 UI。

## Windows 实测与失败修正

Bun 1.3.14，Node v24.22.1，NO_PROXY 包含 loopback；没有运行模型服务或真人研究。

- 保留 Claude/Codex 协议样本经生产 router/capture 重放，实际写 v1 后改为 v2：返回摘要保持 v1，
  binding 为 different，重复事件只落一次。部分读取与 CRLF、缺字段、目录、多路径、失败、
  大文件及旧前提保留均有反例。直接读数 `claim-moat-input-origin` 执行 42 项聚焦检查。
- 完整 Workbench 固定版本：1183 pass / 0 fail，189 文件，34 snapshots，191.89 s，exit 0；
  独立进程墙钟 192.110 s。
- 三包 typecheck、lint、五文件冻结校验、严格上传面：exit 0；lint 有一条既有 info。
- 第一轮完整测试 1182 pass / 1 fail，运行中仍修改生产代码，不能作为最终版本读数。
  第二轮固定版本 1182 pass / 1 fail：旧分支继承 fake Read 只返回 `facts`，却期望刷新前提。
  将 fixture 改为真实读文件并输出保留的结构化协议，原“可信重读只继承最新记录”断言保持不变。
  未知返回保留旧前提的独立反例仍通过。上述原始日志与状态文件留本机。

记录器在实现提交后实际执行，再登记 `claim-moat-input-origin`。本节点合并不代表覆盖分母、
产物来源选择、固定副本验收或受控净收益已完成；分别由 TF-0291 起后续节点承担。

## 重放

```bash
bun test packages/workbench/src/blackboard/input-origin.test.ts packages/workbench/src/blackboard/sessions.test.ts packages/workbench/src/runtime/read-fragments.test.ts packages/workbench/src/chat/input-capture.test.ts packages/workbench/src/chat/input-capture-boundaries.test.ts packages/workbench/src/chat/fork-inheritance.test.ts packages/workbench/src/agents/capture.test.ts packages/workbench/src/chat/tool-footprints.test.ts packages/workbench/src/chat/codex-native-write.test.ts packages/workbench/src/chat/codex-footprint.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

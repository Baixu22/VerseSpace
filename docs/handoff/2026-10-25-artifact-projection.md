# TF-0303：三个入口共用有限产物事实

CLI `checkpoint list --artifact-view --writer <writer-or-thread> --json`、已有只读 MCP
`resume_cards { threadId, view: "artifacts" }` 与恢复 GET 的 `artifactReviews` 字段使用
同一个派生投影。旧 checkpoint list 的区域输出和 MCP 默认恢复卡文字保留，五个
MCP 工具未增加写入口。分支 L1 文字摘要也读取同一投影，不另算产物有效性。

每项保留来源强度、当前输入状态、最近检查结果/范围/权限、当前产物状态、目标状态、
原检查和当前目标 commit、重验命令及 refs。发送者清单的摘要/来源主张另列 handoff，
不覆盖本机来源。即使历史范围检查通过，当前 stale 或 unknown 仍分别显示。

投影 JSON 上限为 2000 字符，最多预选 20 条详细行；空间不足的行明确计入 omitted。
五种状态计数和总量在完整评价后计算，不因展示截断改变。输入版本/改变路径最多
预览三条，另保留输入总量、改变总量与 previewTruncated。长说明仅截断展示。
这是产物投影的体积限制，不是整个线程消息历史的容量保证。

查询、展开和生成复制命令不改 checkpoint 或有效性事件。非普通标识符在复制命令中
按 Windows PowerShell 单引号规则引用；命令不会自动执行。空旧线程有显式零项投影，
旧无完整验证绑定的 checkpoint 保持 unknown，不把历史 passed 显示成当前有效。

## Windows 实测

同一个真实 Git/Node 文件工位分别量测 current、跨文件改动 stale 和旧绑定 unknown；
逐字段比对 CLI、只读 MCP JSON 和真实恢复 HTTP，包括来源、输入、检查、目标和 refs。
核对各次查询前后 checkpoint 与事件完全一致。100 条五状态展示上限对照是构造数据，
不是 100 个工位容量验收；本节点没有浏览器截图，界面由 TF-0310 继续验证。

- 初次独立三入口测试：3 pass / 0 fail，26.68 s。
- 相关回归初次把三种状态聚合在同一用例，触及 60 秒测试上限：24 pass / 1 fail，
  210.64 s。拆为三个独立状态用例，保留同样的三入口核对与原超时上限。
- 修正后相关回归：27 pass / 0 fail，5 文件，49.43 s，exit 0。
- 最终完整 Workbench：1239 pass / 0 fail，203 文件，34 snapshots，500.18 s，exit 0；
  独立进程墙钟 500.558 s。
- 三包 typecheck、lint、冻结五文件校验、严格上传面：exit 0；lint 保留一条既有 info。
- 提交后由记录器实跑三入口/清单/接收/CLI 共 47 个测试，同时刷新受本轮类型与状态
  变化影响的副本/目标直接读数，不借旧读数冒充本轮验收。

直接读数沿 claim-moat-portable-evidence 登记；原始输出、工位和森林留本机。
没有外部模型或真人测量，整体目标尚未收口。

```bash
bun test packages/workbench/src/artifacts/projection.test.ts packages/workbench/src/artifacts/artifacts.test.ts packages/workbench/src/mcp/tools.test.ts packages/workbench/src/chat/resume-card/l1-summary.test.ts packages/workbench/src/ui/chat-routes.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

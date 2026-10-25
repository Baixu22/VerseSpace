# TF-0301：版本化单产物证据清单

`checkpoint export <id> --output <new-file> --json` 导出该来源链的最近检查。
文件只含清单；JSON 输出另含复算的范围评估。输出文件必须新建，不覆盖已有文件。
查看及导出不写 checkpoint 或有效性事件。

清单 schemaVersion 为 1，SHA256 digest 覆盖其余全部字段。对象键按排序序列化；数组
保留声明顺序。清单含产物及当前检查输入 digest、所选历史读取的内容/返回 digest、
选择范围、写者/事件身份摘要、完整声明文件副本、脚本/配置路径、用例集合/报告摘要、
运行器、源 HEAD、原目标检查与当前目标事实。原来源和最近检查分别记录。

绝对目录、原始返回文本、命令、断言正文、配置值、凭据及 effects 都不导出。工位、
checkpoint、写者和事件身份只携带摘要。路径必须为规范相对文件路径，控制字符、
驱动器、ADS、回溯及含糊路径被拒绝。导出与解码上限均为 1 MB；超限不能作为支持的清单。

解码校验版本、必要字段、严格字段集合与内容 digest；不支持、缺项、损坏或超限均
返回 unknown。范围评估另核对产物/输入与副本清单、报告用例与计数、真实自动检查及
当前状态、历史来源、目标 ref/commit/tree/声明范围和候选检查绑定。退出成功但缺范围、
来源或目标依据仍为 insufficient。相同输入仅记 inputs-match，未冒充合并结果。

此清单没有签名或发送者认证。bound-scope-evidence 表示导出字段满足有限声明检查，
不是接收方的执行授权，也不是 SLSA/in-toto 认证；接收方须校验对象并执行自己的本机
策略。独立接收与统一投影仍由 TF-0302/0303 继续，未在本节点宣称完成。

## Windows 实测

本地 Git 与真实 Node 固定副本，没有外部模型或自然人研究。

- 真实导出、CLI、新建文件规则、读取不写账本、源身份/报告绑定、敏感值哨兵、稳定
  序列化、损坏/重算摘要、弱来源、缺范围、未知目标和规范路径对照均通过。
- 初次完整回归发现新增 export 未登记到现有 CLI 参数覆盖表；补上真实 operand 用例，
  同时补齐导出端体积上限后重新执行。失败读数保留本机，未记为通过。
- 修正后清单与 CLI：38 pass / 0 fail，2 文件，19.77 s，exit 0。
- 最终完整 Workbench：1230 pass / 0 fail，201 文件，34 snapshots，433.01 s，exit 0；
  独立进程墙钟 433.730 s。初次完整回归为 1228 pass / 1 fail，379.67 s，exit 1。
- 三包 typecheck、lint、冻结五文件校验与严格上传面：exit 0；lint 保留一条既有 info。

直接读数 claim-moat-portable-evidence 由实现提交后的记录器实跑。全局历史读数仍待
TF-0308/0311 实际刷新；原始日志、临时工位和森林留本机。

```bash
bun test packages/workbench/src/artifacts/manifest.test.ts packages/workbench/src/cli.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

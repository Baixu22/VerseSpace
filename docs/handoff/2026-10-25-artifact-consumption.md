# TF-0295：声明产物验收消费

Runtime 在应用声明产物的 effects 前，复核最新检查 ID、声明输入清单、产物 digest、
报告用例/摘要、原工位采样，以及显式选择的历史足迹凭据。重读或线程已看手势不授权验收。
缺来源、弱/未知凭据、失效文件或不完整报告会留下 `artifact_use_rejected` 原因与 refs，
原 effects 不推进，目标不完成。拒绝状态不在后续 tick 中重复自动尝试。

`checkpoint consume <root-id> --evidence <latest-checkpoint-id>` 允许在成功重验后显式验收。
重验本身不执行 effects；consume 使用原 checkpoint 的效果并只消费一次。旧检查 ID、
不匹配声明和重复消费均拒绝。普通编辑修补仍可进行。

新产物快照绑定声明摘要 `declarationHash`，声明变化即使文件内容不变也会失效。
所选历史输入还与原始足迹再次核对，不能只改保存的来源字段冒充另一份输入。
旧记录没有新摘要时保留较弱兼容语义；没有 inputRecords 的范围检查凭据标为
`legacy-declared-scope`，不升级成历史工具来源证明。

消费凭据在第一个效果写入之前落盘，记录 `started`、检查 ID、manifest、产物和报告摘要。
全部效果结束才记录 `applied`。中断或效果失败保留恢复信息，不重放原 effects；后来重验通过
也不把原效果失败升级为已完成。原消费记录和已应用效果不能因重复请求重新执行。
沿用 acquireRunLock 和现有应用模块，没有新增仓库写锁、数据库或副作用重放器。

本节点只保护 Workbench 管理的验收消费。文件核对与效果应用之间仍没有全仓原子性，
验证过程的 ABA/固定执行对象由 TF-0298 的固定副本模式接续；裸编辑器、Git、未归因写入
仍不在写保护范围内。

## 本轮 Windows 读数

Bun 1.3.14，Node v24.22.1，loopback 使用 NO_PROXY。

- 消费、中断与声明反例：9 pass / 0 fail，3 文件，25.67 s，exit 0。
  包含真实 Runtime effects、过期/弱/未知拒绝、报告损坏、最新重验后的真实 CLI consume、
  重复消费、故障注入和 started 状态恢复、改来源选择与改凭据反例。
- 兼容修正与消费聚焦检查：12 pass / 0 fail，4 文件，16.98 s，exit 0。
- 首轮完整 Workbench：1205 pass / 1 fail，225.80 s。失败项把新绑定删掉 inputRecords 后
  当作旧记录；实际属于声明变化，应为 stale。保留该拒绝断言，再用没有 declarationHash
  的历史绑定验证弱兼容，未放宽生产判据。
- 最终固定版本完整 Workbench：1206 pass / 0 fail，196 文件，34 snapshots，247.48 s，
  exit 0；独立进程墙钟 247.714 s。
- 三包 typecheck、lint、五文件冻结校验：exit 0。lint 保留一条既有 info。
- 严格上传面在交接创建后运行；未调整分类策略。

直接读数 `claim-moat-consumption` 在实现提交后由记录器实际执行并登记。
日志、状态文件与森林留本机；全局读数刷新、固定副本与可携带证据仍未收口。

```bash
bun test packages/workbench/src/artifacts/use-guard.test.ts packages/workbench/src/artifacts/use-interruption.test.ts packages/workbench/src/artifacts/use-manifest.test.ts packages/workbench/src/cli.test.ts packages/workbench/src/runtime/integrity.test.ts packages/workbench/src/automaton/checkpoint-machine.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

# TF-0299：目标输入与候选检查分别记录

固定离线文件模式对目标采集完整声明集合的 Git blob：输入、产物、脚本和配置。
目标只在集合外推进时保留有限范围的旧检查，另报 `outside-declared-range` 与当前
commit；相关文件改变须重验。旧的全工作区检查仍按目标 tree 保守失效。目标不能读取
时明确 unknown，不把相同输入 hash 升级为目标已验证。

`checkpoint revalidate <id> --workspot <id> --target-ref <ref> --target-candidate`
显式检查目标基线上的候选工位。要求固定文件模式、工位 HEAD 等于目标 commit，真实
副本检查完整通过，执行期间目标未推进。检查记录绑定工位、目录、候选 HEAD、目标
commit/tree 和副本 manifest。只有该绑定仍适用才报 `target-checked`；这是声明范围
内候选的执行事实，不代表最终 ref 已合入，也不提供自动语义合并。

来源工位、原目标检查和当前 ref 分别保留。范围外两次推进各自追加有效性事实；读取
不写账本，重复 reconcile 不重复追加。检查 manifest、HEAD 或目录遭修改会失效。

本轮只测 Windows、本地 Git/worktree 与真实 Node 子进程；没有外部模型或真人测量。

- 新目标事实：6 pass / 0 fail，63.04 s；候选推进与身份篡改：1 pass / 0 fail，21.84 s。
- 完整 Workbench：1226 pass / 0 fail，200 文件，34 snapshots，356.73 s，exit 0；
  独立进程墙钟 357.075 s。
- 三包 typecheck、lint、冻结五文件校验：exit 0；lint 保留一条既有 info。
- 事件计数测试初次把已有重验记录漏算，期望 2 实际 3；修为原计数 +2，并逐项核对新
  commit 及重复 reconcile 零新增，修正后重新通过。

直接读数 `claim-moat-verification-copy` 在实现提交后由记录器实跑；包含副本与目标
检查共 29 个测试。原始输出、森林与工位留本机。全局历史读数仍待最终阶段实际刷新。

```bash
bun test packages/workbench/src/verifier/isolated-files.test.ts packages/workbench/src/verifier/isolated-runtime.test.ts packages/workbench/src/verifier/verifier.test.ts packages/workbench/src/artifacts/target-facts.test.ts packages/workbench/src/artifacts/target-check.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

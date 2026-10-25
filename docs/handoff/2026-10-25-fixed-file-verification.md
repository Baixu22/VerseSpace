# TF-0298：有限离线检查的固定文件副本

声明范围可选 `fixedFiles: { mode: "node-offline-files-v1", script, complete: true }`。
该模式要求单产物、显式输入/脚本/配置文件及 Vitest JSON 报告，不能附带任意 command。
Workbench 将声明文件复制到自身 checkpoint objects 目录，使用真实 Node 子进程检查副本。
运行器版本、可执行文件摘要、bootstrap 摘要、逐文件 hash/字节数、复制和执行耗时、报告摘要
保存在 checkpoint 的 verificationResult.object。执行副本清理后仍保留归档报告和内容清单。

只接受可信的离线脚本：Node 权限限制读取声明副本、写入报告，不允许子进程和原文件写入；
模块钩子限制可加载的内建模块与本地声明模块，移除全局 fetch/WebSocket。它不作为运行恶意
JavaScript 的安全沙箱，不保证声明方已经列出所有语义依赖，也不声明源工作区原子快照。
环境仅带固定模式标志和必要的 Windows 运行时变量，不继承模型密钥、代理或 NODE_OPTIONS。

上限为 128 个文件、20 MB 复制内容、10 MB 报告、最多 60 秒执行。缺依赖、无法解析运行器、
复制期间文件变化、越界访问或超复制预算返回 needs_human/不能测量，不回退到活工作区执行。
执行超时仍为 timeout。Node 运行器要求 24 或更新，当前只测 Windows Node v24.22.1。

副本结果与源工位当前适用性独立：源文件在检查期间变成 v2，副本仍检查实际复制的 v1；
回到源工位时必须重新核对完整声明集合、每个 hash、工位和运行器。变化不能继承 current。
源文件暂改后恢复 v1 时，检查仍属于固定 v1 对象，不因端点相同而签发期间的 v2。
归档报告被修改或清单缺声明文件也会失效。消费入口核对本次归档报告，不借用源目录旧报告。

复用现有 supervisor、报告校验、Blackboard 和 Runtime；没有新依赖、数据库或 sidecar。
本节点未收口目标候选执行、可携带证据或净收益，分别由后续节点验证。

## 本轮 Windows 实测

Bun 1.3.14，Node v24.22.1；工程夹具和真实本地子进程，没有外部模型或真人测量。

- 副本执行、源文件竞争/ABA、未声明模块/文件、网络模块、子进程模块、输入写入、Runtime
  绑定/消费、归档报告、清单缺项、超时、复制预算及旧 verifier 回归：22 pass / 0 fail，
  3 文件，15.21 s，exit 0。
- 完整 Workbench：1219 pass / 0 fail，198 文件，34 snapshots，292.82 s，exit 0；
  独立进程墙钟 293.440 s。
- 三包 typecheck、lint、五文件冻结校验：exit 0。lint 保留一条既有 info。
- 严格上传面在交接创建后运行；不调整分类策略。

直接读数 claim-moat-verification-copy 在实现提交后由记录器实跑并登记。
原始日志、临时副本与森林留本机；全局旧读数仍需在最终收口逐项刷新。

```bash
bun test packages/workbench/src/verifier/isolated-files.test.ts packages/workbench/src/verifier/isolated-runtime.test.ts packages/workbench/src/verifier/verifier.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

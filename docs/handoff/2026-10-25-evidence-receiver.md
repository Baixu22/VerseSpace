# TF-0302：独立工位核对与自己的重验

`checkpoint receive <manifest-file> --checkpoint <local-id> --workspot <id>`
`--report <relative-path> [--revalidate] --json` 使用接收方已经声明的 checkpoint 策略。
显式工位将清单的相对根映射到该目录；本节点限同一 Windows 仓库中不同隔离工位、
相同相对文件名，不提供任意逐文件重命名或跨仓身份替换。

核对先校验清单版本、字段和 digest，复算来源/范围要求，再比对本机策略的产物、
输入、配置、脚本、报告路径及用例集合。只接受现有可信离线固定文件策略；清单中的
任何命令或附加可执行字段均不执行。实际文件字节与 hash、提供的报告/用例/计数、
目标 commit/tree/完整声明 blob 集合、Node 和 bootstrap 均重新量测。

纯核对的 matched 只表示此刻文件、报告及目标相符，未执行本机检查，也不授权效果。
文件、报告或目标变化另报 revalidation-required；不能读文件/报告/目标或运行器时
unknown（CLI exit 2）。声明不兼容为 rejected。查询不写 checkpoint 或有效性事实。

显式 --revalidate 沿原重验路径新建证据 checkpoint，使用本机已有策略，记录实际
result/exitCode/objectHash/reportHash。通过且仍 current 才显示 locally-checked；
真实失败/超时另报 failed（CLI exit 1），不能测量仍 unknown。核对后本机声明或工位
目录切换会在 run lock 内拒绝，不把前一目录的核对带到新目录。

外部清单原样保存在新 checkpoint.artifactHandoff，原来源与目标身份摘要不改写。
本机 artifactInputOrigin 独立保留；发送者没有签名，其来源只是携带的主张，不能
覆盖本机工具足迹或授予产物消费。新证据的 effects 为空，原 checkpoint 及原效果
不重放。后续普通重验仍保留这一外部来源记录。

## Windows 实测

使用真实 Git detached worktree、Node 固定副本和 CLI；没有外部模型或真人测量。

- 两工位内容映射、纯查询零账本写入、本机声明/目录切换拒绝、真实新检查、双方来源
  保留、原效果零重放、输入/产物/脚本/配置/报告/目标变更、未知和失败证据都有对照。
- 首次接收夹具把工位目录当作 captureReturnedInput 的项目根，导致相对足迹归错目录；
  核对生产 batch/Codex 捕获均使用 bb.projectRoot + 工位解析路径后，夹具采用同样方式。
  初次还有一处变量错误，均修正后重跑，失败日志保留本机。
- 最终聚焦：42 pass / 0 fail，3 文件，46.87 s，exit 0。
- 完整 Workbench：1234 pass / 0 fail，202 文件，34 snapshots，441.95 s，exit 0；
  独立进程墙钟 442.224 s。
- 三包 typecheck、lint、冻结校验、严格上传面：exit 0；lint 保留一条既有 info。

直接读数继续使用 claim-moat-portable-evidence；不扩大声明族。原始日志、报告、工位
和森林留本机，全局历史声明的重新量测仍待最终节点。

```bash
bun test packages/workbench/src/artifacts/manifest.test.ts packages/workbench/src/artifacts/receive.test.ts packages/workbench/src/cli.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

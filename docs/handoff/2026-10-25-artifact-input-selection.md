# TF-0293：显式选择产物创建时的读取记录

`checkpoint create --input-records <json-file>` 接受显式选择数组：每项有 `path`、
`writerId`、`footprintSeq`，同一行同路径多范围时还需 `selector`。
路径须在原工位与声明的 `--input` 中；不存在、重复、跨写者身份错配或含糊选择保留 unknown。
解析历史原始足迹，不用当前 read-set 的最新版本替换旧记录，不推断先读后写为因果。

新增 `artifactInputOrigin` 保存所选 path/selector、原路径、写者/执行者、足迹与事件序号、
采样版本、返回内容摘要和证据来源强度。创建时的文件采样继续单独存于 `artifactOrigin`，
并标注 `sampling: checkpoint-file-sample`，不伪装成历史工具内容。
CLI JSON 与 ArtifactReview 分别返回这些事实。

旧 checkpoint 不要求新字段，旧日志强度未知；没有显式选择时不自动选取读取。
重验保留原所选记录与原采样，不回填成较新的输入。直接 API 保存后首次验证也会完成显式选择，
重验不重新选择。所选输入的完整性仍由声明方负责。

本节点只交付选择和保存事实，不以 `selected` 证明内容可靠、依赖完整或产物当前可用。
来源/最新验证与消费约束分别由 TF-0294/0295 接续；没有扩展数据库、依赖图或 UI。

## Windows 本轮实测

Bun 1.3.14，Node v24.22.1，loopback 使用 NO_PROXY。

- 新增直接检查：3 pass / 0 fail，2.25 s，exit 0。冻结 late-origin 场景实际写 v1、再改 v2，
  晚建 checkpoint 和后续复读不替换 v1；同路径双范围能选择且歧义/无效记录保持 unknown；
  真实 checkpoint CLI 创建与单产物重验保留历史来源，旧记录强度未知。
- 选择检查与既有产物生命周期回归：6 pass / 0 fail；既有三项涵盖跨文件失效、目标推进、
  不改代码重验及 effects 不重放。登记后记录器会重新实跑最终版本。
- 完整 Workbench：1193 pass / 0 fail，192 文件，34 snapshots，228.09 s，exit 0；
  独立进程墙钟 228.344 s。
- 三包 typecheck、lint、五文件冻结校验：exit 0。lint 保留一条既有 info。
- 严格上传面 gate 在交接完成后运行；没有调整分类策略。

直接读数为 `claim-moat-artifact-origin`，在实现提交之后用记录器 `--run` 生成。
原始日志、森林和临时输入文件留本机。没有真实模型或自然使用收益测量。

## 重放

```bash
bun test packages/workbench/src/artifacts/input-origin.test.ts packages/workbench/src/artifacts/artifacts.test.ts --timeout 60000
bun run test:workbench
bun run typecheck
bun run lint
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
bun run check:upload-surface
```

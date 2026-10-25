# TF-0285：受测版本与已有能力基线

工程门与来源清单；无真人收益或本轮模型实验。冻结点是开始开发时的干净主线
`a7197bacd7159e704278a0dd5cf2233952d4e0fe`，与当时 `origin/main` 相同。
后续增强版本按各节点的提交记录识别，不能覆盖这个旧主线对照。

## 版本与执行环境

- Windows；Bun `1.3.14`，Node `v24.22.1`，Git `2.51.0.windows.1`。
- 原生 CLI 工具版本：Codex `0.164.0-alpha.11.1`，Claude Code `2.1.310`。
  这里只执行版本查询，未调用模型；强朴素组使用无模型的独立文件检查与重新运行检查。
- 发行标签 `workbench-v0.4.1` 解析为 `28f72d618ce85a93bf19ee7c46b6cb30a4a47ea7`；
  GitHub Release 的 Windows 资产 digest 是
  `sha256:cab4fd36940dd2f214aa50ae378a992abaa476d5721d79c342f94c1cb0c99c31`。
  本轮只查询标签和资产元数据，没有下载或执行旧二进制；其历史读数不能覆盖新源码。
- 所有本轮 HTTP/浏览器进程用 `NO_PROXY=127.0.0.1,localhost,::1`。

## 已有能力与增量

| 冻结源码 | 可复用能力 | 后续增量 |
| --- | --- | --- |
| `packages/workbench/src/blackboard/footprint.ts` / `hashPathClaim` | 文件/行段采样、路径归一与小文件 spool | TF-0289/0290 区分实际返回内容与采样，不能把现有 hash 当作返回凭据 |
| `packages/workbench/src/blackboard/session-types.ts` / `FootprintUsed` | 足迹与读取片段 | TF-0291 明确覆盖分母和未知原因 |
| `packages/workbench/src/types/artifact-evidence.ts` / `artifactDeclarationSchema` | 显式单产物与文件输入 | TF-0293 选择写者的确切历史读取记录，解决晚登记来源 |
| `packages/workbench/src/artifacts/status.ts` / `listArtifactReviews` | 输入失效与最新检查分离；current 不代表合并结果 | TF-0294/0295 独立来源有效性及消费前检查 |
| `packages/workbench/src/artifacts/revalidate.ts` / `revalidateArtifact` | 新 checkpoint、保留历史、不重放 effects | TF-0298 固定离线验证内容，TF-0301/0302 接收方独立重验 |
| `packages/workbench/src/artifacts/snapshot.ts` / `captureArtifactSnapshot` | 仓库/工位/目标 commit/tree 与显式输入 blob 对比 | TF-0299 区分输入相同与候选检查，不能重复实现 inputsMatch |
| `packages/workbench/src/verifier/evidence-report.ts` / `collectVerificationEvidence` | Vitest JSON 的完整非空用例集合及报告更新检查 | TF-0286 独立 oracle，TF-0306 对照；不另建测试框架 |

## 本轮读数与历史边界

冻结主线上实际执行：

| 命令 | 结果 | 耗时 | exit |
| --- | --- | --- | --- |
| `bun test packages/workbench/src/blackboard/footprint.test.ts packages/workbench/src/artifacts/artifacts.test.ts packages/workbench/src/verifier/evidence-report.test.ts --timeout 60000` | 11 pass / 0 fail，3 文件；含真实子进程、跨文件失效、复读未修、跨工位与真实 Vitest reporter | 21.89 s | 0 |
| `node scripts/check-claims.mjs --json` | 20 claims，15 valid、2 observation、3 stale-subject | 未单独计时 | 1 |
| `node scripts/check-forest-landing.mjs --json` | clean，默认分支 main；历史孤立提交/未归因节点只报注记 | 未单独计时 | 0 |
| `bun run lint`（初始树） | 3 个既有格式错误，1 info | 1.206 s | 1 |

三条 stale 是 `claim-lint`、`claim-browser-e2e`、`claim-codex-native-seal`。
其余 valid 只是账本对已有记录的有效性判定，本轮没有重跑那些仪器，不能搬用历史套件计数。
三个格式错误仅由 Biome 格式化修复，未改策略、期望值或行为；修后 lint exit 0。
Codex 两个旧阻塞节点 TF-0262/0264 保持原状态。

来源清单直接检查器：`node packages/workbench/scripts/verify/moat-baseline.mjs`。
它从冻结提交读取源码 blob，并核对交接清单与发行标签身份；不依赖未来 HEAD。
注册读数为 `claim-moat-source-baseline`；原始输出保留本机。

## 接力条件

先完成 TF-0286：至少八类独立真值场景、强朴素对照、保留样本与冻结成本预算。
只有它指出新增实现的缺口，才进入阶段二。当前源码已经处理的跨文件失效、报告检查、
重验不重放 effects 和目标输入对比，应直接复用，不能重复开发。

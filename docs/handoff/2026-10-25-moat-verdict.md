# TF-0308：护城河声明的有限裁决

本节点只裁决 `claim-moat-*` 声明族，不把全局 claims 状态改写为通过。汇总仪
`scripts/verify/moat-verdict.mjs` 调用真实 `check:claims --json`，要求声明族集合
恰好为九条，并逐条读取 `evidence/readings/` 的 subject、实际 instrument exit、
raw digest 与数字读数。当前九条全部为 `valid`，0 缺失、0 stale、0 observation。

| 声明 | 当前读数 | 能证明的边界 |
| --- | --- | --- |
| `claim-moat-baseline` | 5 tests / 0 fail | ADR-0026 与 README/索引的声明范围一致 |
| `claim-moat-source-baseline` | 7 files | 冻结源码能力清单可由 Git 身份独立复算 |
| `claim-moat-oracle` | 16 cases / 3 tests；naive 0 错，旧主线 1 false-current + 2 source errors | 冻结真值可重放，旧主线差异可归因 |
| `claim-moat-controlled-comparison` | 18 cases × 7 组；成本 1 预热 + 5 样本 × 3 尺度 | 增强组零错误；成本调用与总体时间分开裁决 |
| `claim-moat-input-origin` | 49 pass / 0 fail | 返回内容、文件采样、工具观察与 unknown 的边界 |
| `claim-moat-artifact-origin` | 9 pass / 0 fail | 原输入/产物来源、效果与后续有效性事实分开 |
| `claim-moat-consumption` | 57 pass / 0 fail | 消费门、固定副本、目标范围与 effects 授权边界 |
| `claim-moat-verification-copy` | 29 pass / 0 fail | 固定副本、目标候选和重验记录的实际路径 |
| `claim-moat-portable-evidence` | 47 pass / 0 fail | 清单、接收方复核和 CLI/MCP/恢复的同一有限投影 |

记录器重新执行了本轮受实现变化影响的四条仪器：ADR 基线 5 tests、输入来源 49
tests、产物来源 9 tests、消费门 57 tests，均为 exit 0 / 0 fail。其余五条仍然
`valid`，因为其 instrument 与 subject 在各自读数后没有变化；不能把较早 subject
误写成本轮重新执行。

## 已经证明

- 返回给写者的内容可以携带内容摘要与工具观察身份；文件采样、弱来源、缺失和歧义
  输入保持 unknown，不冒充完整工具足迹。
- 产物来源、声明输入、固定副本范围、验证报告与当前有效性分开保存；检查期间对源
  文件的临时推进不会穿透固定副本。
- 消费门会拒绝未验证、已消费、来源不完整和检查依据已失效的记录。四次内容不变的
  消费只请求一次完整检查，而不是每次重跑。
- 本机目标只在其声明文件范围内取得有限结论；范围外推进仍可能使普通保守检查失效。
- 便携清单不携带 cwd、命令或 effects；接收方核对实际文件、报告和目标，并使用本机
  策略重新验证。发送方来源只是主张，不授权效果。
- 在同一冻结 18 例中，增强链路达到 0 false-current、0 false-reject、0 来源错配、
  0 unknown；冻结旧主线测得 1 false-current 与 4 来源/采样错配。没有修改 judge
  真值来获得这个结果。
- 四次不变消费的完整检查次数从强朴素的 4 降到 1；这是可复算的调用次数收益。

## 尚未证明

- 没有总体时间净收益。1k/10k/50k 三尺度中，增强 median 为 5092.126 / 8467.101 /
  6573.739 ms，均高于同一朴素分布的 238.779 ms；固定规则裁决三尺度全部
  `no-net-time-benefit`。
- 当前冻结场景没有单独证明消费门或目标范围指纹相对消融的额外错误收益：两个消融
  组在该样本集为零差异。它们仍由聚焦测试覆盖，但不能把覆盖读数的收益写成本场景
  的新增收益。
- `unobserved` 是有意的 unknown-control。judge 中 unknown=0 表示该案例预期得到空
  观察，不表示所有工具/写者都被观察。
- 没有真实模型对照、token/cost、真人效率、市场护城河、跨机容量或自然工作流收益。
  这些字段保持未测，不用 0 或“repaired”代替。

## 不能测量与已退役

- Windows 是本轮唯一的执行证据。四个交编二进制仍应保留和披露，但非 Windows 实机
  执行与自然真人研究按 ADR-0024 永久退役；退役不是 pass。
- 历史 `claim-codex-write-unsealed` / `claim-codex-write-seal-gap` 仍是旧范围
  observation，不升级为当前密封保证。
- 合成 1k/10k/50k ledger 是已测工作量，不是容量上限，也不证明索引/数据库方案。

`node scripts/verify/moat-verdict.mjs` 当前 exit 0：9/9 moat claims valid。完整
`check:claims` 仍 exit 1，并报告 17 条非 moat/通用声明 stale；它们来自此前代码与
文档推进，不能在本节写成 pass，留给 TF-0311 在最终源码状态上逐条重跑。TF-0308
只把有当前直接读数的 moat 主张登记为已证。

## 复核

```bash
node scripts/verify/moat-verdict.mjs --output evidence/raw/moat-verdict-tf0308.json
node scripts/check-claims.mjs
```
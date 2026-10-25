# TF-0306：强朴素、旧主线与增强链路受控重放

本节点在 Windows 本机、单仓、显式文件输入和单产物边界内重放 18 个冻结案例。
新增组定义在生产实现之后、首次新对照之前冻结，因此它是可比对照的计划冻结，
不是实现前预登记。原五文件 `cases.json`、`check.cjs`、`judge.mjs`、`naive.mjs`、
`workbench.ts` 继续由 `freeze.json` 固定，本轮没有修改。

fixture SHA256 为 `d10eeba5e28ab9ea689d23f1d60fbff342eed1d42730302df80fe4de07e36515`，
judge SHA256 为 `1d578185d88bc50cb31be033c6a376107b15ad44ba3e841078ebfa04ea572d57`。
旧主线从冻结提交 `a7197bacd7159e704278a0dd5cf2233952d4e0fe` 的源码归档加载；
规划起点 `391fd5` 的源码树与冻结源码树同为
`debffa2e78769d1aa1c879375bc50a3db7c96272`。新 replay plan 的 SHA256 为
`14032d3b06c7a1f8cfc7c264c8b187f112ec7e4edb215525ab19b52e1ef8edff`，同时绑定
四个观察器文件摘要。

judge 只读取冻结案例并比较观察值，不导入生产有效性函数。每个组/案例在独立 Node
子进程中执行，单例硬上限 60 秒；输出保存 expected、observed、真实 exit、墙钟和
timeout 标记。增强观察调用当前生产的输入捕获、固定副本、重验、run lock 内消费门
和产物状态投影。这里的“消费”是对实际消费门授权路径的调用核对，没有应用
checkpoint 的 effects；effects 的成功路径由既有 Runtime 测试另外证明。

## 全部对照

最终重放为 18 例 × 7 组 = 126 个单例子进程。全部实际 exit 为 0，无超时、无仪器
失败；独立 judge 汇总 exit 0，独立进程墙钟 205.868 秒。

| 组 | 错误接受 | 误拒绝 | 来源错配 | unknown | 重复检查预算差异 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 冻结强朴素 | 0 | 0 | 0 | 0 | 1：四次消费检查 4 次，预算 1 |
| 冻结旧主线 | 1 | 0 | 4 | 0 | 0 |
| 增强生产链路 | 0 | 0 | 0 | 0 | 0 |
| without-return-origin | 0 | 0 | 4 | 0 | 0 |
| without-fixed-copy | 1 | 0 | 0 | 0 | 0 |
| without-use-guard | 0 | 0 | 0 | 0 | 0 |
| without-target-range | 0 | 0 | 0 | 0 | 0 |

旧主线保留 5 个错误：`late-origin` 的来源错配、`capture-race` 的采样错配、`aba`
错误接受，以及保留组合 `held-late-race` 的来源与采样两项错配。冻结强朴素组安全
结果为零错误，但在 `repeat-consume` 中实际执行四次检查，超过实现前固定的
“四次不变消费至多一次检查”预算。增强组在该案例只记录一次 `request_verification`。

`without-return-origin` 重现四项来源错配；`without-fixed-copy` 重现 `aba` 错误
接受。当前冻结场景中，`without-use-guard` 与 `without-target-range` 没有产生额外
错误，因此本节点不把消费门或目标范围指纹登记为已测出的相对收益。它们由其他
聚焦测试覆盖，不能借用本表宣称本场景内的增益。

`unobserved` 是有意的 unknown-control，使用旧 declared-scope，judge 的
unknown=0 只表示本案例的预期空观察被满足，不能据此宣称工具覆盖完整。冻结旧组和
朴素适配器没有提供所有新观察字段，报告不虚构它们的消费查询、捕获读取或复制成本；
这些数字只对提供对应观察的当前生产/消融组解释。

提交前完整 Workbench 回归为 1239 pass / 0 fail，203 文件、34 snapshots、5567 次
expect、459.22 s，exit 0；独立进程墙钟 459.643 s。三包 typecheck、全仓 lint、两套
冻结校验、3 个 judge 测试和严格上传面门禁均 exit 0；lint 只保留
`scripts/verify/measure-premise-notices.ts:145` 的既有 info，没有新增告警。
没有调用真实模型，因此 token 与费用保持 `null`/未测，不填写 0，也不使用
“repaired”或净收益措辞。朴素组超出检查次数预算是工程成本差异，不是模型或真人
生产力结果；增强组耗时没有降低时也不能宣称净收益。原始 JSON、文本日志与临时工位
留本机，不进入上传面。

## 复核

```bash
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
node packages/workbench/scripts/verify/artifact-use/check-replay-freeze.mjs
node --test packages/workbench/scripts/verify/artifact-use/judge.test.mjs
bun packages/workbench/scripts/verify/artifact-use/replay.ts --final --output evidence/raw/claim-moat-controlled-comparison.json
```
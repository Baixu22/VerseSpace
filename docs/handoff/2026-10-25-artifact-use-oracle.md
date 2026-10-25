# TF-0286：独立真值、强朴素对照与冻结预算

工程受控重放，使用真实 Windows 子进程；工具内容与外部写者由确定性 fixture 模拟。
没有调用真实模型，也不证明真人收益、市场护城河或全仓写保护。

## 冻结对象

18 例、11 类场景，其中 16 例公开开发对照、2 例保留组合样本。
包含跨文件失效、返回后采样竞争、晚登记来源、复读未修、报告子集/零用例/损坏、
目标推进、验证 ABA、无需改代码重验、未知来源和四次相同消费；另有来源、采样、复读的正常对照。
每例明确输入、产物、消费动作、工具可见性、外部写者与预期事实。
生产实现尚未改动；保留组合样本不进入生产开发重放，只在最终独立验收启用。

`packages/workbench/fixtures/artifact-use/freeze.json` 冻结 fixture、检查程序、judge、
朴素实现与旧 Workbench 观察适配器五个摘要。禁止为了刷绿更改这些文件。
fixture SHA256：`d10eeba5e28ab9ea689d23f1d60fbff342eed1d42730302df80fe4de07e36515`。
judge SHA256：`1d578185d88bc50cb31be033c6a376107b15ad44ba3e841078ebfa04ea572d57`。

judge 的预期只来自 fixture，不调用生产有效性函数；生产函数只生成观察值。
缺行、重复行直接失败；未知单独计数，不计正确保护；错误接受、误拒绝与来源错配分开。
三个 judge 测试包括实际原生对照、故意扰动结果以及未知/缺行/重复行反例。

## 对照与本轮实测

强朴素组使用原生文件 IO：保存实际读到的字节，固定文件副本，消费时真实重跑完整检查，
独立核对报告的非空用例集合与计数。它没有调用 Workbench 的判定。
旧 Workbench 组从冻结提交 `a7197bacd7159e704278a0dd5cf2233952d4e0fe` 的 git archive
加载生产源码；未来主线推进后仍能重放相同旧代码。依赖使用同机安装的依赖，Bun 固定为 1.3.14。

| 组 | 已测例 | 错误接受 | 误拒绝 | 来源错配 | 未知 | 重复消费检查次数 |
| --- | --- | --- | --- | --- | --- | --- |
| 强朴素方案 | 16 | 0 | 0 | 0 | 0 | 4 |
| 冻结旧 Workbench | 16 | 1 | 0 | 2 | 0 | 1 |

旧组的三项差异：晚登记产物来源用了 v2 而非写者的 v1；返回 v1 后采样成 v2；
检查期间暂时把输入改成 v2 后恢复 v1，报告通过被错误投影成 current。
跨文件失效、复读不能修复、报告检查、目标推进和正常重验已有正确行为，继续复用。
这里的未知控制预期本身就是缺观察，不代表工具覆盖完整。

命令 `bun packages/workbench/scripts/verify/artifact-use/run.ts --frozen-baseline` 实测耗时
24.740 s，exit 0。exit 0 表示基线量到了，**不表示旧 Workbench 全绿**。
`node --test packages/workbench/scripts/verify/artifact-use/judge.test.mjs` 为 3 pass / 0 fail，
5.116 s，exit 0；lint/typecheck exit 0。原始 JSON 和工作副本留本机。
直接注册读数为 `claim-moat-oracle`。

## 实现前成本口径与裁决

安全/来源错误上限为 0。单例硬预算 60 s；后续计时 1 次预热、5 次采样，报告中位数、范围、
字节开销和实际执行次数。四次内容不变的消费只应需要一次已完成检查；这个预算来自
**旧 Workbench 已有的复用能力**，并非要求提高未知吞吐。耗时没有事后可调整的刷绿阈值，
总耗时没有降低就不能宣称净收益。预算写在冻结 fixture，不能在实现后放宽。

阶段一裁决：**缩减后继续**。强朴素组已经解决安全问题，但每次消费都重跑；
旧主线已能复用检查，却在三项来源/时间场景中丢失真实性。
后续采用同样的简单字节凭据和固定副本，填平三个真实缺口，并核对可携带的来源与消费事实。
不添加新依赖、数据库、任意 Shell 解析器、全仓锁、自动因果图或新看板。
最终仍须独立重放保留样本和量测总成本，不能先宣布护城河收益。

## 复核

```bash
node packages/workbench/scripts/verify/artifact-use/check-freeze.mjs
node --test packages/workbench/scripts/verify/artifact-use/judge.test.mjs
bun packages/workbench/scripts/verify/artifact-use/run.ts --frozen-baseline
```

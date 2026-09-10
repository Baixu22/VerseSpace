# 阶段 D 接力：七现场多模型完整链路尝试（2026-09-08）

TF-0135 / TF-0137 / TF-0155 本轮在用户提供的第二个 OpenRouter 账号与一个 newapi 代理渠道上重新尝试完整诺真链。free-models-per-day 不再是绝对阻塞：新账号下 cohere/north-mini-code:free 复现了上轮 22/22 集成通过，development 复核超时同上轮；其余三个免费 OpenRouter 模型与两个代理模型各卡一处，没有一组完成整轮。

## 凭据与边界

- 新 OpenRouter 凭据从命令行环境变量注入（`E2E_LLM_KEY`），未写入仓库外 DPAPI，未持久化。原 DPAPI 凭据保持在额度耗尽状态，未修改。
- newapi 渠道 `https://api.hcnsec.cn` 凭据同样只在命令行注入。该渠道提供 14 个模型，本轮探测 `auto`（路由 poolside/laguna-s-2.1-free）、`glm-5.3-flash`（40 秒无响应放弃）、`DeepSeek-V4-Flash`（30 秒无响应放弃）与 `sensenova-6.8-flash-lite`。
- 所有现场均为全新隔离工作区，SHA256 与详细计数见 [证据快照](./multi-model-evidence-2026-09-08.json)。

## 七现场矩阵

| 现场后缀 | 模型/渠道 | 成功响应 | 尝试 | 卡点 | 失败分类 |
| --- | --- | ---: | ---: | --- | --- |
| `soAvFB` | cohere/north-mini-code:free | 26 | 27 | development 复核回合超时（40.3s 后 aborted） | 模型反应边界，同上轮 |
| `bMxGgm` | nvidia/nemotron-3-ultra-550b-a55b:free | 1 | 2 | S1 第二次请求 25.7s+ 累计超 50s | 模型单次回话过慢 |
| `uyQQeO` | poolside/laguna-s-2.1:free | 0 | 3 | S1 HTTP 429 三次终止 | 上游限流 |
| `DvOpnP` | nvidia/nemotron-3.5-lightning:free | 7 | 8 | S6 阶段 50s 整轮预算耗尽 | 整轮预算不够 |
| `cCquMs` | inclusionai/ling-3.0-flash-fin:free | 4 | 5 | S6c 模型空回复且未执行截断工具 | 模型输出契约违规 |
| `eFcdJq` | hcnsec:auto（路由 laguna-s-2.1-free） | 0 | 1 | S1 第一次请求挂起 50.0s aborted | 渠道/模型过慢 |
| `xg57Mu` | hcnsec:sensenova-6.8-flash-lite | 8 | 8 | S6 子分支写达到 6 次工具循环上限 | 模型工具循环 |

只有 `soAvFB` 现场走完 22/22 集成并生成 `runs/live-integration.json`，其余六个现场都死在集成阶段。

## soAvFB 现场（cohere 新账号）

t0 已启动：stats.threads=4、writers=6。样本窗 **恢复 2/3、校准 7/5（已超）、封印 1/3**。noticeOutcomes 7 行、overlaps 33、notified 7。26 次工具驱动模型请求、27 次尝试（1 次 aborted）、usage.cost 合计 0。development 复核阶段第二次 reader 回合 40.3 秒 aborted，与上轮 `nzbavy` 失败模式一致，复现 Cohere 免费模型在复核回合的稳定性边界。模型未进入独立 URL 验收与持久分叉步骤。

## 检查

- `cd packages/workbench && bun x tsc --noEmit` 通过。
- `cd packages/workbench && bun test --timeout 60000` 606 pass / 0 fail（97 文件、2320 断言、97.76 秒）。本轮初跑一次出现 1 个 flaky fail（605/606），立即重跑 606/606 全过；不改代码。

## 候选

候选 `TFP-2026-09-08-multi-model-relay` 只为 TF-0135、TF-0137、TF-0155 追加本轮七现场证据并更新接力提示；不更改状态、进度、依赖或验收门槛，不覆盖历史候选。

## 接力

- cohere/north-mini-code:free 仍是当前唯一能在 50 秒预算内完成 22/22 集成的模型；development 复核超时复现性已是两轮连续证据。
- 下一次复跑优先继续 cohere 新账号，目标：(a) 把 restores 从 2 提到 3；(b) 把 sealDecisions 从 1 提到 3；(c) 若 development 复核超时第三次复现，将其视为该模型的稳定边界证据，由用户决定是否上调整轮预算或换付费模型。
- hcnsec 渠道探测结论：auto/glm/DeepSeek-V4 当前都超过 50 秒预算，只有 sensenova-6.8-flash-lite 能到 S6，但工具循环上限是另一个独立边界。
- 长期真实使用与对外 benchmark 各沿用原样本门槛，不通过加跑免费模型来抬读数。

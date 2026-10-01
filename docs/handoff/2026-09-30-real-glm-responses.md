# GLM Responses 真实测试与额外修正（2026-09-30）

用户提供并授权本轮使用本机 `http://127.0.0.1:3065/v1/responses`、`glm-5.3-flash` 和匹配凭据。
凭据通过隐藏输入进入临时启动进程的环境，不写仓库配置、命令参数或报告。所有模型文件操作发生在脚本创建的隔离工作区，独立运行模型产物的子进程不继承凭据。

基线 HEAD `68ebef5` 加当前未提交工作区。本轮调用了真实 HTTP 模型服务，不是 fake-agent 单测；同时保留测试脚本驱动的动作边界。

## 先修协议接入

原 live 驱动固定拼 `/chat/completions`，无法直接使用用户给的完整 Responses 地址。
新增小型 `live-wire.ts`，复用产品 URL 归一化，按完整 `/responses` 端点选择协议；转换 function_call / function_call_output，保留 call_id 与 reasoning 输出的历史回放，只接受 completed 输出，不执行截断或失败的工具调用。
普通基址和完整 Chat Completions 地址继续兼容。原生 HTTP 流式验收也跟随选择 Responses；报告不再把任意配置服务一律写成 OpenRouter。

初次真实探针：HTTP 200、JSON `status=completed`、返回模型 `glm-5.3-flash`，输出包含 reasoning/message；记录用量 50 input / 42 output / 92 total tokens。
该探针只证明这次端点请求成功，不作为整套产品验收。

## 两次默认预算完整运行

| 运行 | 已完成 | 最终结果 |
| --- | --- | --- |
| 首轮 | 集成阶段 S0–S11（含真实原生 Responses SSE）；模型产物独立 12/12，一次通过 | exit 1。旧读者复核期间页面消息连接意外关闭；记录到 24 次工具驱动模型响应。开发尾段与最终分叉未完成 |
| 修复后第二轮 | 集成阶段 S0–S11；模型产物独立检查从 11/12 经一次模型纠正到 12/12 | exit 1。旧读者复核收到明确模型 TimeoutError；27 次工具驱动模型响应、28 条请求尝试记录。默认每请求 120 秒仍未完成该复核 |

上述响应数来自 live-agent 的记录，不包含独立原生 HTTP 流式回合和最初探针，也不等于服务端计费请求总数。首轮中断时仍有未结算请求，不能凭日志断言完整网络请求数。
两次 `runs/live-report.json` 与已完成的 `runs/live-integration.json` 均保留，失败不洗成通过。

## 真实失败带出的产品修复

消息流沿用了 Bun 全局 120 秒 idleTimeout，会与模型回合的超时竞争，提前以 socket reset 隐藏终态。
缩短空闲窗口的真实 HTTP 回归重现了同样的 `ECONNRESET`：1 秒配置下，2.2 秒短样本未触发，延长静默到 6.2 秒后约 4 秒触发，说明不能忽略计时器粒度。

产品现在只对已授权、正常返回的 NDJSON 消息响应使用 Bun 原生逐请求 `timeout(request, 0)`；普通请求仍保持 120 秒空闲上限。模型/进程自身的超时、用户取消和终态处理保留。
同一回归修复后成功收到完整 done。第二轮真实运行也由 socket reset 变为可见的模型 TimeoutError，未把超时伪装成成功。

另修正 live 开发验收：原来仅以 `blocked=false` 判断复读已解除失效，但连续命中降为 warn 也不阻断。现在必须同时满足 `blocked=false`、`hit=false`、`decision=pass`；专门回归拒绝 warn 和仍命中的 pass。

## 对真实模型产物的验证绑定复核

把首轮真实模型产生的 `base-url.ts` 复制进另一临时工作区，使用原独立 12 项检查命令走真实 checkpoint Runtime：

1. 产物独立 12/12，checkpoint passed，执行目录与命令绑定存在。
2. 控制器在副本中引入回归，下一轮退回 draft 并记录一次 verification_invalidated。
3. 再验证失败，goal 保持 in_progress。

这是“真实模型产物 + 脚本化后续变更”的机制验收，不是新增模型调用，也没有修改原始模型产物。

## 补充预算专项

为区分模型延迟与产品断链，补跑开发/分叉专项：每请求 180 秒、每回合 600 秒、进程无响应阈值 210 秒，只通过本轮子进程环境设置，未修改产品默认值。
其结果单独记录在 `live-supplement-180s.json`，不能升级成默认预算完整测试通过。

**专项实际结果：exit 0。** 记录 19 次真实工具驱动模型响应；开发产物独立 12/12，模型复核 pass。
复读后 seal 为 `decision=pass / hit=false / blocked=false / downgraded=false`，已按收紧后的判据通过。
三条持久分叉均观测到 provider 历史与读集继承，返回首个分支再次读取通过，源线程消息保持不变，已验收实现未被分支修改。
这完成了扩展预算的开发与分叉专项；默认 120 秒的两次完整运行仍是 exit 1。
专项 trace 汇总为 95,660 input / 16,339 output tokens，最长成功请求 77.018 秒，均来自返回模型为 `glm-5.3-flash` 的 Responses 记录。
因此不能据此断言“提高到 180 秒本身导致成功”或该模型恒需超过 120 秒；这里只确认该预算配置下这次专项完成。该 token 数不是本轮所有探针/失败运行的消费总额。

## 本地工程回归

| 命令 | 本轮真实读数 |
| --- | --- |
| 相关 live 协议测试 | exit 0，15 pass / 0 fail，80 个断言 |
| HTTP 空闲超时与严格 seal 判据回归 | exit 0，2 pass / 0 fail |
| `bun run test:workbench` | exit 0，1073 pass / 0 fail，170 files，34 snapshots，4702 个断言，156.91 秒 |
| `bun run test:workbench-ui` | exit 0，18 files / 68 tests passed，10.57 秒 |
| `bun run test:context-rot` | exit 0，69 pass / 0 fail，171 个断言 |
| `bun run typecheck` / `bun run lint` | 均 exit 0；Biome 678 files |
| `bun packages/workbench/src/index.ts doctor` | exit 0，118 条断言、0 失效，blackboard 正常 |
| Windows 浏览器回归（ApiPort 7850 / UiPort 5332） | exit 0，真实 Chromium 14/14，30.9 秒 |
| `bun run check:upload-surface` | exit 0，862 个上传面文件、违规 0；533 条相对链接、断链 0；两条既有 node_modules 链接警告保留 |
| `bun run check:claims` | exit 1，13 stale / 2 valid / 1 observation；未重录注册读数 |

原始日志、失败现场和专项读数留在本机 `.agent-contexts/live-glm-responses-20260930/` 及隔离工作区，不上传密钥、原始模型历史或运行站点。

## 结论边界

真实模型通过 stream-json 测试适配器执行文件工具，另有 Workbench 原生 HTTP Responses 回合；这不是实际 Claude/Codex CLI 的写保护验收，不能因此关闭 #31。
恢复、人工/git 写者和场景推进由控制器安排，不代表自然使用或生产率研究。未重开 ADR-0024 退役范围。
没有提交、推送、发布、改任务森林或重录 claims；未执行二进制构建验收。

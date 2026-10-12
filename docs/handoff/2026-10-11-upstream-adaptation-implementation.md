# 上游模型适配与协议切换：开源调研与落地（2026-10-11）

承接 [上一轮调研](2026-10-11-upstream-protocol-adaptation-research.md)。本轮做两件事：
（1）实地调研开源项目的处理方式；（2）把其中可直接借鉴的部分落到 HTTP 通道。

**标签**：工程门（本机单测与类型检查）。**产品证据：无**。没有接入真实 provider，所有“降级成功”
与“切换成功”的结论都来自假 provider 的脚本化测试，不代表线上行为。

## 1. 调研：开源项目怎么做

| 项目 | 做法 | 对我们的启发 |
| --- | --- | --- |
| [LiteLLM](https://docs.litellm.ai/docs/completion/prompt_caching) | `drop_params` 丢弃不支持的参数；按部署 `additional_drop_params` 声明；`num_retries`、`allowed_fails`/`cooldown_time`；`fallbacks` 与 `context_window_fallbacks`、`content_policy_fallbacks` 分开 | 推理模型拒绝 `temperature`、`max_tokens`→`max_completion_tokens` 是高频问题。**但 drop 只对模型表里登记为不支持的参数生效**：Azure 上 gpt-5.5 拒绝非默认 temperature 时 `drop_params` 失效，只能按部署声明（[#33171](https://github.com/BerriAI/litellm/issues/33171)）。→ 我们做了“声明 + 从报错学习”，并且**按 endpoint 作用域**隔离 |
| [claude-code-router / musistudio/llms](https://github.com/musistudio/claude-code-router/blob/main/blog/en/maybe-we-can-do-more-with-the-route.md) | 以 OpenAI 格式为基底，每个协议一个 Transformer 做双向转换；Provider 有序 fallback；凭据池对 401/403/429 冷却；每请求记录路由与 token | 有序 fallback 与“每个目标用自己的协议重新编码”。它的 Transformer 中间表示是我们**暂未实现**的部分 |
| [Portkey Gateway](https://portkey.ai/docs/api-reference/inference-api/config-object) | `retry.attempts` + `on_status_codes`；fallback 目标列表；loadbalance | 重试与切换应由状态码分类驱动。它的文档也反复强调：只配 500 不够，429 与 502/503 才是真实故障 |
| [OpenRouter sticky routing](https://openrouter.ai/docs/guides/best-practices/prompt-caching) | `session_id` / `prompt_cache_key` 作为粘性键；闲置 10 分钟过期；fallback 会丢失缓存；手动 `provider.order` 覆盖粘性 | 同一会话应使用稳定的缓存键。跨端点粘性我们当前是单进程单用户，不需要 |
| [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | 把 CLI 订阅包装成 OpenAI/Gemini/Claude/Codex 兼容端点；多账号轮询与故障转移 | 证明“协议互译 + 账号池”是成熟路线。OAuth 接入超出本轮范围 |
| 多个 issue（[securo #884](https://github.com/securo-finance/securo/issues/884)、[vellum #42421](https://github.com/vellum-ai/vellum-assistant/issues/42421)、[GoModel #894](https://github.com/ENTERPILOT/GoModel/pull/894)） | Gemini 3 的 `thoughtSignature` 在 OpenAI 兼容路径丢失，第二轮工具调用 400 | 不透明字段必须原样回放。本轮**不涉及工具调用**，所以暂不处理，但这是 Gemini 接入的前置条件 |

**共同结论**：成熟项目的适配几乎都落在三层：**声明式能力表**、**从错误信息学习**、**按状态码分类的重试/切换**。
我们的历史消息目前是纯文本，因此跨协议切换在本轮是安全的；一旦引入工具或推理块，就必须先做中间表示。

## 2. 落地改动

| 文件 | 改动 |
| --- | --- |
| `packages/workbench/src/chat/model-adaptation.ts`（新） | 声明式规则：OpenAI 推理模型丢弃 `temperature`/`top_p`，Chat 上 `max_tokens`→`max_completion_tokens`。从 400 报错学习被拒参数，按 provider+model+baseUrl 作用域记忆。只允许改 `ADAPTABLE_PARAMS` 白名单内的参数；Anthropic 的 `max_tokens` 不可改 |
| `packages/workbench/src/chat/upstream-policy.ts`（新） | 纯函数决策表：可重试（无应答/408/425/429/5xx，瞬时流错误）→ 同目标重试（指数退避+抖动，尊重 Retry-After，上限 10 秒）→ 切换；401/403 → 切换；400 仅在适配生效时重试；其他 4xx 直接失败；**已有输出后永不重试、永不切换**。`runWithFailover` 编排器不做 I/O，便于测试 |
| `packages/workbench/src/chat/http-run.ts` | 改为：每个目标独立构造请求（各自协议、模型、端点、密钥）；单次尝试不直接对外报错，由编排器决定；备用目标的 Shadow 变体只随成功的那次尝试挂出；失败时汇总全部尝试原因 |
| `packages/workbench/src/chat/http-request.ts` | 新增 `cacheKey`：OpenAI Chat/Responses 发送 `prompt_cache_key`（线程 ID）；Anthropic 发送顶层 `cache_control: {type:"ephemeral"}`（自动缓存）。提取各协议默认值 `HTTP_PROVIDER_DEFAULTS` |
| `packages/workbench/src/chat/credentials.ts` | 备用目标密钥：自身 `apiKey` 优先；仅同 provider 时沿用主密钥。**环境变量密钥绝不发给其他厂商**。UI 返回的备用目标只显示 `hasKey`，不返回密钥 |
| `packages/workbench/src/chat/thread-run.ts` | `lastRun.provider` 记录真正应答的 provider，而非配置里的主 provider |
| `packages/workbench/src/types/config.ts` | `chat.fallbacks`（最多 4 个，仅 HTTP 三协议）与 `chat.maxAttempts`（1–4，默认 2），均为可选字段 |

**切换策略**：主目标先按 `maxAttempts` 重试，仍是可重试错误或遇到 401/403，才依次切到备用目标。
备用目标按自己的协议重新编码请求（历史为纯文本，无需转换不透明字段）。切换只发生在首个输出字节之前。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `bunx tsc --noEmit`（packages/workbench） | exit 0 |
| `bunx biome check <改动文件> --config-path=./biome.json` | 无错误（已用 `--write` 修复格式） |
| `bun test`（全量，packages/workbench） | 1125 通过 / 1 失败 |
| 失败项 | `src/watcher/watcher.test.ts` 的 `startWatcher > converges on boot…`，5 秒超时。**在基线（stash 掉本轮改动）上同样偶发失败**（4 次中 1 次），与本轮无关 |
| 新增测试 | `model-adaptation.test.ts`（9）、`upstream-policy.test.ts`（14）、`http-failover.test.ts`（5，真实 `Bun.serve` 假 provider 端到端）、`http-request.test.ts`（3）、`fallback-config.test.ts`（2） |

端到端测试覆盖：主目标 503 两次后切到 Anthropic 且回答正确、`lastRun` 记录为 anthropic；400 拒绝 `max_tokens` 后改名重试，**下一轮直接成功**；同线程请求带稳定的 `prompt_cache_key`；不可适配的 400 只报一次且不切换；环境变量密钥不会发给另一厂商。

## 4. 刻意没做的事

- **Gemini**：未接入。需要先解决 `thoughtSignature` 的回放，见上表 issue。
- **中间表示（IR）**：未引入。当前历史是纯文本，引入 IR 会扩大改动面；等工具调用与推理块进入 HTTP 通道时再做。
- **UI**：备用目标与 `maxAttempts` 只能通过配置文件或 PATCH `/api/config/chat` 设置，设置界面未改。
- **切换提示**：发生切换时只在控制台打印 `console.warn`，**界面上没有可见提示**。这是下一步的首要项，否则用户看不出回答来自哪一家。
- **学习结果不持久化**：适配记忆只在进程内有效，重启后会重新学习一次。
- **usage 解析**：仍未读取 `cached_tokens`，因此**缓存命中率仍无法观测**。本轮只是发出了缓存键，效果未测。

## 5. 下一步建议

1. 界面展示“已切换到 X”，并在线程里保存每轮的实际 provider 与切换次数。
2. 解析各协议 usage（`cached_tokens` / `cache_read_input_tokens`），写入线程统计，用真实数据验证缓存键是否生效。
3. 学习结果落盘（按 endpoint 指纹），减少重启后的首次失败。
4. 引入 IR，并为 Gemini 做原生 generateContent 适配，同时回放 `thoughtSignature`。

## 6. 复核命令

```bash
cd packages/workbench
bunx tsc --noEmit
bun test src/chat/model-adaptation src/chat/upstream-policy src/chat/http-failover src/chat/http-request src/chat/fallback-config src/chat/credentials src/chat/http-endpoint
```

# 上游协议层适配调研（2026-10-11）

> 性质：简单调研，用于确定方向，不是设计定稿，也不改动任何运行代码。
> 范围：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages、Gemini 四类对话协议；
> 第一优化点为缓存命中率；第二优化点为会话粘性与会话中切换模型时的协议适配。

## 0. 结论先行

1. **现状的主要缺口**：HTTP 车道（`openai-chat` / `openai-responses` / `anthropic`）把整段历史压成
   `{role, content}` 纯文本重发，不携带工具调用、推理块、图片，也不解析 usage、不设置任何缓存字段。
   **Gemini 目前完全不在支持列表中。**
2. **成熟做法**：内部使用一份规范化中间表示（canonical IR），每个协议各写一套编解码器（codec），
   而不是 N×N 两两互转；所有 provider 返回的"不透明字段"（推理签名、加密推理、工具调用签名）原样保存、
   原样回放；无法映射的特性显式降级或报错，不静默丢弃。
3. **缓存命中率**：四家机制差异很大（自动前缀缓存 / 显式断点 / 隐式+显式混合），**共同前提是“稳定前缀在前、变化内容在后”**。
   当前实现在这点上基本是对的（通知注入只改最后一条 user 消息），但缺少两件事：没有缓存观测，Anthropic 路径没有任何缓存标记。
4. **会话粘性**：缓存只在同一 provider、同一端点、同一模型上有效；会话中切换 provider 必然冷启动，
   并且上一家的推理签名、`previous_response_id`、`encrypted_content` 通常无法带到下一家。
   建议把"切换 provider"当作显式的**会话交接（hand-off）**事件处理，而不是静默改协议。

---

## 1. 现状（本仓库，只读核对）

| 项 | 现状 | 位置 |
| --- | --- | --- |
| provider 枚举 | `claude`、`codex`（本地 CLI）+ `openai-chat`、`openai-responses`、`anthropic`（HTTP）；**无 Gemini** | `packages/workbench/src/types/config.ts`、`chat/provider-capabilities.ts` |
| 请求体构造 | 三个分支各自拼 body；消息统一来自 `history()`，只取 `role` 与 `text` | `chat/http-request.ts`、`chat/http-run.ts` |
| 历史消息 | 只保留非空文本，丢弃工具调用/结果、推理块、附件 | `chat/http-run.ts` 的 `history()` |
| Responses 分支 | 用 `input` 数组重发纯文本，未用 `previous_response_id`，未显式设置 `store`，未请求 `reasoning.encrypted_content` | `chat/http-request.ts` |
| system 提示 | HTTP 请求体中**没有**独立的 system / instructions 字段 | `chat/http-request.ts` |
| 缓存相关字段 | **无**：没有 `prompt_cache_key`、没有 Anthropic `cache_control`、没有 Gemini 缓存 | 全仓库检索无结果 |
| usage 解析 | HTTP 车道不解析 usage 事件，无 `cached_tokens` 观测 | `chat/http-stream.ts`、`chat/http-run.ts` |
| provider 归属 | provider 是**全局配置**；线程的不同轮次可能换过 provider，已在 `ThreadLastRun` 中逐轮记录 | `chat/thread-types.ts`（`lastRun`） |
| 会话状态 | HTTP 车道每轮全量重发历史，服务端无状态 | `chat/http-run.ts` |

**两个值得注意的正面事实：**
- `promptWithNotices` 只改写最后一条 user 消息，前缀保持稳定，对缓存友好。
- `ThreadLastRun` 已经逐轮记录 provider 与可观测性，是做会话绑定与缓存统计的现成挂点。

---

## 2. 四类协议的结构差异与成熟处理

### 2.1 结构对照

| 维度 | OpenAI Chat Completions | OpenAI Responses | Anthropic Messages | Gemini (generateContent) |
| --- | --- | --- | --- | --- |
| 系统指令 | `messages` 中的 `system` / `developer` 角色 | 顶层 `instructions`（不随 `previous_response_id` 继承，需每次重发） | 顶层 `system` 字段 | 顶层 `systemInstruction` |
| 消息容器 | `messages[]` | `input[]`（message / function_call / function_call_output / reasoning 等条目） | `messages[]`，`content` 为 block 数组 | `contents[]`，角色为 `user` / `model`，内容为 `parts[]` |
| 工具调用 | `tool_calls[]` + `role: tool` 结果消息 | `function_call` 条目 + `function_call_output`（按 `call_id` 配对） | `tool_use` / `tool_result` 块 | `functionCall` / `functionResponse` part |
| 推理 | 无标准字段（各家扩展各异） | `reasoning` 条目；可用 `include: ["reasoning.encrypted_content"]` 取加密推理，`store: false` 下回放 | `thinking` 块，带 `signature` | Gemini 3 等思考模型在 `functionCall` part 上返回 `thoughtSignature`，**回放缺失会 400** |
| 服务端状态 | 无（需全量重发） | 可选：`store: true` + `previous_response_id` 或 Conversations API | 无 | 有 `previous_interaction_id`（Interactions API，见下） |
| 默认存储 | 默认不存储 | **默认存储**（迁移时最容易踩的坑） | 无服务端会话 | 依接口而定 |

> 注：Google 官方缓存页当前把 Interactions API 标为推荐接口，generateContent 仍在文档中。
> 来源：[Gemini API 上下文缓存文档](https://ai.google.dev/gemini-api/docs/caching)。

### 2.2 成熟处理措施

**(a) 规范化中间表示 + 每协议 codec。** 内部用一份统一结构表示：system、消息、文本块、工具调用、工具结果、推理块、
不透明元数据。每个协议写 encode / decode 各一份。好处是新增协议只需一套编解码，而不是与其他三家两两互转。
LiteLLM、Vercel AI SDK、OpenRouter 等网关大多是这种 hub 形态（本文未逐个核对其内部实现，此处为行业通行做法）。

**(b) 不透明字段原样保存、原样回放。** 这是目前失败率最高的一类问题。
- Gemini 3 的 `thoughtSignature`：OpenAI 兼容端点的 `extra_content.google.thought_signature` 如果在协议转换中丢失，
  第二轮工具调用会直接报 400 "Function call is missing a thought_signature"。已有多个开源项目在 2026 年仍在修这个问题，例如
  [securo #884](https://github.com/securo-finance/securo/issues/884)、
  [vellum-assistant #42421](https://github.com/vellum-ai/vellum-assistant/issues/42421)，
  以及 [GoModel #894](https://github.com/ENTERPILOT/GoModel/pull/894) 的修复思路（把签名放在与 Google 官方兼容端点相同的字段里，回放时原样放回对应的 functionCall part）。
- Responses 的 `reasoning` 条目需要整条回放（含 `encrypted_content`），拆掉只保留文本会导致推理连续性丢失。
  OpenAI 的说明见 [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)。
- Anthropic 的 `thinking` 块带 `signature`，应整块回放，不要改写文本。

**(c) 能力矩阵 + 显式降级。** 同一条会话里，某个 provider 支持而另一个不支持的特性（内置工具、结构化输出、图片、推理块），
要么在请求前检测并报错，要么降级后**记录下来告诉用户**。不要静默丢弃。仓库已有 `provider-capabilities.ts`，可沿用同样的思路扩展字段。

**(d) 同协议直通。** 客户端协议与上游协议相同时，尽量不经过 IR，直接透传，减少失真。

**(e) 错误与流式事件归一化。** 四家的 SSE 事件结构完全不同（Responses 是 typed events，Anthropic 是 content_block 系列，
Chat 是 `choices[].delta`，Gemini 是 candidates 流）。当前 `http-stream.ts` 已经按协议分支解析文本增量，方向正确，但只覆盖文本，
需要扩展到工具调用增量与 usage。

**(f) 真实录制回放测试。** 把各家真实响应录成 fixture，用于回归。仓库已有 `chat/fixtures/streams/` 的做法，可复用。

### 2.3 Gemini 的接入建议

- **方案 A：走 Google 的 OpenAI 兼容端点**（`https://generativelanguage.googleapis.com/v1beta/openai`）。
  接入快，但必须确认 `extra_content` 中的签名被完整捕获与回放，否则工具调用会在第二轮失败。
- **方案 B：原生 generateContent 适配器**。字段映射更完整，签名控制权在自己手里。工作量更大。

建议先做方案 A 并用 Gemini 3 类模型跑一个两轮工具调用的端到端用例，再决定是否上方案 B。

---

## 3. 第一优化点：缓存命中率

### 3.1 四家机制对照

| 维度 | OpenAI | Anthropic | Gemini |
| --- | --- | --- | --- |
| 启用方式 | 自动（前缀匹配） | 显式 `cache_control` 断点（最多 4 个），或顶层自动缓存 | 2.5 及以上默认开启隐式缓存；另有显式 `cachedContents` 资源 |
| 最小长度 | 1024 tokens | 依模型，常见为 1024 | 官方表：Gemini 2.5 Flash / 2.5 Pro 为 2048；3.x Flash 与 3.1 Pro Preview 为 4096 |
| 读取折扣 | 约 90% | 读取 0.1×，写入 1.25×（5 分钟）或 2×（1 小时） | 读取约 90%（隐式无存储费）；显式缓存按小时收存储费 |
| TTL | 未公开固定值（经验约 5–10 分钟） | 默认 5 分钟，读取时续期；可选 1 小时 | 显式缓存默认 1 小时，可设置 |
| 观测字段 | `usage.prompt_tokens_details.cached_tokens`（Responses 为 `input_tokens_details`） | `cache_creation_input_tokens`、`cache_read_input_tokens` | `usage.total_cached_tokens` |
| 路由相关 | 可设 `prompt_cache_key` 提高同前缀请求的命中；超过约 15 次/分钟同键请求时部分会 miss（Azure 文档） | 缓存按 workspace 隔离 | 隐式缓存依赖相近时间内的相似前缀 |

**来源**：
- OpenAI：[Azure OpenAI 提示缓存文档](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)、[OpenRouter 缓存指南](https://openrouter.ai/docs/guides/best-practices/prompt-caching)。
  GPT-5.5 及更早版本的缓存命中按 128 token 递增；GPT-5.6 起取消该取整，且缓存写入按 1.25× 计费。
- Anthropic：[Claude 提示缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。
  文档明确：最多 4 个断点；默认 5 分钟；1 小时 TTL 为 2× 写入价；缓存按组织与 workspace 隔离。
- Gemini：[Gemini API 上下文缓存文档（官方）](https://ai.google.dev/gemini-api/docs/caching)。
  **注意**：第三方文章给出的最小 token 数（1024 / 4096 等）互相矛盾，以官方表为准。

### 3.2 通用原则

1. **稳定前缀在前，变化内容在后。** 顺序应为：system / instructions → 工具定义 → 长期上下文 → 历史 → 本轮输入。
2. **前缀必须逐字节一致。** 时间戳、随机 ID、工具列表顺序变化，都会使缓存失效。
3. **历史压缩要成块进行。** 从中间删消息会破坏前缀；压缩应只改动尾部，或按固定边界整块替换。
4. **Anthropic 需要显式标记。** 没有 `cache_control` 就没有缓存。
5. **缓存写入有成本。** Anthropic 的 1.25× 写入价、OpenAI GPT-5.6 起的 1.25× 写入价，意味着只发一次的长提示开启缓存反而更贵。
   应允许按请求关闭。
6. **观测先行。** 不记录 cached tokens，就无法判断优化是否有效。

### 3.3 对本仓库的具体含义

| 当前状态 | 影响 | 建议 |
| --- | --- | --- |
| HTTP 请求没有 system / instructions | 前缀只剩历史，没有可复用的稳定头部 | 把固定指令与工具定义放在最前，并保持字节稳定 |
| Anthropic 请求无 `cache_control` | 缓存完全未启用 | 先用顶层自动缓存做最小改动；再视需要改为显式断点 |
| OpenAI 请求无 `prompt_cache_key` | 依赖默认路由，同线程请求可能分散到不同缓存 | 以线程 ID 派生稳定 key |
| 不解析 usage | 无命中率数据 | 解析各家 usage，写入线程统计（`lastRun` 或 stats） |
| 通知注入只改最后一条 user 消息 | 前缀稳定 | 保持这一约束，并加测试锁定 |

---

## 4. 第二优化点：会话粘性与会话中切换模型

### 4.1 问题拆解

会话中途切换 provider（例如 Claude → GPT）会同时发生四件事：

1. **缓存冷启动**：不同 provider 的缓存互不共享，本轮要付写入成本。
2. **不透明状态失效**：上一家的 `thinking.signature`、`encrypted_content`、`thoughtSignature` 对下一家无意义，甚至会报错。
3. **服务端状态断链**：`previous_response_id` 只在产生它的那套 Responses 环境内有效。
4. **能力差异暴露**：例如内置工具、推理块的可见性在不同协议间不对等。

### 4.2 行业通行做法：会话粘性（sticky routing）

OpenRouter 的做法可以作为参考：
- 以 `session_id`（或 `x-session-id` 头，或 `prompt_cache_key`）作为粘性键，后续请求路由回同一上游端点。
- 粘性在首次成功请求后即生效，不必等到观测到缓存命中。
- 闲置约 10 分钟后过期，每次成功请求续期。
- 若上游出错，缓存不更新，下一次请求允许重新路由。
- 一旦设置了手动 provider 顺序，粘性会被覆盖。

来源：[OpenRouter Prompt Caching 文档](https://openrouter.ai/docs/guides/best-practices/prompt-caching)、
[OpenRouter 博客：Prompt Caching + Sticky Routing](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/)。

### 4.3 建议的会话绑定模型

在线程元数据中增加一条"绑定记录"，而不是只有全局配置：

```
binding = {
  provider,          // openai-chat | openai-responses | anthropic | gemini
  model,
  endpointFingerprint, // baseUrl 的哈希，不存明文
  cacheKey,          // 稳定的 prompt_cache_key，通常由线程 ID 派生
  lastResponseId?,   // 仅 Responses 且 store=true 时存在
  boundAt, switchedFrom?
}
```

- 同一线程默认沿用绑定；全局设置变更不自动迁移已有线程。
- 切换是**显式事件**：用户切换时弹出提示，说明缓存将冷启动、哪些不透明状态会被丢弃。

### 4.4 切换时的协议适配策略

| 切换类型 | 可保留 | 必须处理 | 建议 |
| --- | --- | --- | --- |
| 同协议、同端点、换模型 | 历史、缓存前缀（同模型才命中） | 模型能力差异 | 直接沿用，提示缓存模型不同 |
| 同协议族、不同端点（如 chat 兼容网关） | 可见文本、工具调用 | 不透明字段、缓存 | 经 IR 转换，丢弃不透明字段 |
| 跨协议（如 Claude → GPT-Responses） | 可见文本、工具结果 | `thinking` / `reasoning` 块、`previous_response_id`、Responses 内置工具 | 经 IR 重编码；不可映射的内容降级为文本并记录；建议**分叉为新线程** |
| 切到不支持某特性的协议 | 其余内容 | 该特性 | 请求前报错，或明确告知已降级 |

仓库已有线程分叉能力（`thread-fork.ts`），跨协议切换可以优先考虑"分叉 + 交接摘要"，比在原线程里硬做协议转换更可控。

---

## 5. 建议的分阶段路线

| 阶段 | 内容 | 目的 |
| --- | --- | --- |
| P0 观测 | 解析 4 家 usage；按轮记录 provider、model、cached / cache_write / 输入 tokens | 有数字才能判断优化是否生效 |
| P0 缓存 | Anthropic 加自动缓存；OpenAI 加稳定 `prompt_cache_key`；固定指令与工具定义前置并加字节稳定性测试 | 最小改动拿到第一批收益 |
| P1 协议 | 引入 IR；补齐工具调用与推理块的编解码与回放；Gemini 方案 A 加两轮工具调用用例 | 支撑多协议与会话切换的正确性 |
| P1 会话 | 线程绑定记录；切换事件与提示；跨协议切换默认分叉 | 降低切换带来的质量与成本损失 |
| P2 深化 | Gemini 原生 generateContent；Responses 的 `previous_response_id` 与 `store` 策略；显式缓存的 TTL 与清理 | 按需扩展 |

---

## 6. 需要你确认的问题

1. **隐私与存储**：是否允许 Responses 在服务端存储会话（`store: true`）？若不允许，就只能走无状态加密推理路线，缓存与推理连续性会受影响。
2. **Gemini 接入方式**：优先 OpenAI 兼容端点（快），还是原生 generateContent（可控）？
3. **跨协议切换的默认行为**：倾向"原线程内转换"还是"自动分叉为新线程"？
4. **成本取向**：Anthropic 的 1 小时 TTL（2× 写入）与 5 分钟 TTL 之间，是否愿意为长会话多付写入成本？

---

## 7. 不确定与待验证

- 本文中 Anthropic 与 Gemini 的最小 token 数、TTL 数值以各家官方文档为准；第三方文章的数字存在不一致，未全部核对。
- Gemini 2.5 以上隐式缓存的实际命中率依赖请求节奏，需要在本仓库的真实会话中测量，不能只看文档。
- 跨 provider 的思考签名能否在另一家被接受，目前只有 Gemini 相关的公开 issue 可以佐证，Claude 的 `thinking.signature` 跨模型行为需要实测。
- 本仓库目前没有任何真实 provider 的缓存数据，本文所有收益数字都是**文档层面的理论值**。

---

## 参考来源

1. [Azure OpenAI 提示缓存（prompt_cache_key、断点、cached_tokens）](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)
2. [OpenRouter 提示缓存与粘性路由](https://openrouter.ai/docs/guides/best-practices/prompt-caching)
3. [OpenRouter 博客：Prompt Caching + Sticky Routing](https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/)
4. [LiteLLM Prompt Caching 文档](https://docs.litellm.ai/docs/completion/prompt_caching)
5. [Anthropic Claude 提示缓存（官方）](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
6. [Gemini API 上下文缓存（官方）](https://ai.google.dev/gemini-api/docs/caching)
7. [OpenAI：迁移到 Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
8. [Gemini 思考签名在 OpenAI 兼容路径丢失的案例：securo #884](https://github.com/securo-finance/securo/issues/884)
9. [Gemini 思考签名在 OpenAI 兼容路径丢失的案例：vellum-assistant #42421](https://github.com/vellum-ai/vellum-assistant/issues/42421)
10. [GoModel PR #894：保留 Gemini thought signature 的修复思路](https://github.com/ENTERPILOT/GoModel/pull/894)

# 上游稳定性与快速切换（阶段二）

范围：HTTP 通道。协议为 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
Gemini 不在本次范围内（见「未决问题」）。

## 改了什么

| 模块 | 变化 |
| --- | --- |
| `chat/protocols/` | 新增。每个协议一个编解码器：请求体、端点、请求头、流式帧解析。HTTP 通道只与统一的帧类型打交道。 |
| `protocols/errors.ts` | 新增。错误分类：文本优先于状态码（429 的 `insufficient_quota` 归为 quota，而不是 rate）。 |
| `protocols/types.ts` | usage 归一化：`promptTokens` 始终是含缓存的总提示量，命中率 = `cachedTokens / promptTokens`。 |
| `upstream-policy.ts` | 动作由错误类别决定（见下表）。新增 `TargetHealth`：目标连续两次被放弃后冷却 60 秒，冷却目标排到队尾（不删除）。 |
| `http-run.ts` | 首包与空闲超时（默认 90 秒，可由 `chat.timeoutMs` 配置）；超时计为 `timeout`，可重试后切换。记录尝试次数、切换来源、usage。 |
| `http-stream.ts` | 影子请求与主请求共用同一编解码器。`consumeSse` 增加 `onChunk` 回调以驱动空闲计时。 |
| `model-adaptation.ts` | 新增可适配参数 `stream_options`。 |
| `http-request.ts` | 请求构造委托给编解码器。 |
| `thread-types.ts` / `thread-run.ts` | `lastRun` 记录 `attempts`、`switchedFrom`、`usage`。 |
| `types/config.ts` | 新增可选 `chat.timeoutMs`（1 秒至 10 分钟）。 |

## 错误类别与动作

| 类别 | 动作 |
| --- | --- |
| bad_request | 参数可以改变时适配一次；否则失败 |
| rate / overloaded / server / timeout / network / stream | 同一目标退避重试，耗尽后切换 |
| quota / auth / model_missing / context_overflow | 立即切换（同一目标重试无意义） |
| content_filter / malformed | 失败，不切换（换目标不会改变结果） |

约束不变：一旦有任何输出已送达用户，本轮不再重试、不再切换。

## 缓存观测

- OpenAI Chat：请求带 `stream_options.include_usage`，从末尾块读取 `prompt_tokens_details.cached_tokens`。
- OpenAI Responses：从 `response.completed` 读取 `input_tokens_details.cached_tokens`。
- Anthropic：`input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 合并为 `promptTokens`。

usage 只在上游真正返回提示量时才记录；缺失则不记录，不做猜测。

## 测试

- `protocols/protocols.test.ts`：各协议解析、usage 合并、错误分类。
- `upstream-stability.test.ts`：目标冷却与恢复、配额即时切换、内容过滤不切换、真实上游超时后切换到备用、OpenAI usage 写入线程记录。
- `upstream-policy.test.ts`：决策表。404 现在归为 model_missing，会切换目标。
- `bun test src/chat`：396 通过。全量 workbench：1159 通过，1 个 `startWatcher` 偶发超时（见下）。
- 前端：typecheck 通过，vitest 68 通过。

## 已知限制

- 熔断状态只在进程内存中，重启即清空，不跨实例共享。
- 模型适配学到的参数同样只在内存中。
- UI 还不显示切换提示，`lastRun` 的新字段也还未展示。
- 缓存节省目前仍是理论值：仓库里没有真实线上数据。

## 既有的偶发失败（非本次引入）

`src/watcher/watcher.test.ts` 的 `startWatcher > converges on boot, reacts to goal writes, and settles` 在基线提交 `a40f7ee` 上隔离运行 5 次失败 2 次，与本次改动无关。该用例不依赖 chat 层。

## 未决问题（阶段一，未被用户回答，未做假设）

1. 是否允许 Responses 服务端存储（`store:true`）？本次未改动默认行为。
2. Gemini 走 OpenAI 兼容端点还是原生 generateContent？本次未实现 Gemini。
3. 跨协议切换：在线程内转换，还是自动分叉？本次未实现跨协议会话迁移。
4. 是否接受 Anthropic 1 小时 TTL 的写入溢价（长会话）？本次未启用 1 小时 TTL。

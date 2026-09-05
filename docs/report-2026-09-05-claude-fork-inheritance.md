# Claude 上下文继承三问实验（TF-0140）

- 日期：2026-09-05
- 目的：给 `--fork-session` 的继承语义一次真实运行时裁决，替掉「假设 + fake CLI 证据」。
  结论只决定 TF-0131（分支读集继承）的形态，本节点成败皆 done。
- 复现脚本：`packages/workbench/scripts/measure-fork-inheritance.ts`
  - `bun run scripts/measure-fork-inheritance.ts`（默认 `--scan`，只读历史会话）
  - `bun run scripts/measure-fork-inheritance.ts --live`（真跑一次 fork）
- 环境：Windows 11、`claude` 2.1.251（`AppData/Roaming/npm/claude`）、
  `~/.claude/projects/` 下 **33 个源 → fork 配对**、跨 5 个项目。
  统计默认排除本脚本 `--live` 自己造的 scratch 会话（否则每跑一次 live 分母就漂一格），
  `--include-probe` 可保留它们。

---

## 结论先行

1. **Q1 成立。** `claude -p --input-format stream-json --session-id <uuid>` 铸出的会话，
   可以被 `--resume <uuid> --fork-session` 接上；fork **铸新 session id**，不复用原 id。
   两次实测：`e4f0b338…` → `4a25b411…`、`0e50eedf…` → `c604c3d6…`。
   `threads.ts:1141` 拼的命令行是对的。
2. **Q3 成立，且是三问里最强的一条证据。** fork 把源会话的消息**逐字复刻**到新会话文件：
   `uuid`／`parentUuid` 链原样保留，只改写 `sessionId`。33/33 配对的共享前缀里
   `tool_use` / `tool_result` id 序列**完全一致**（合计 9733 条，单个配对最多 768 条）。
   **`tool_use_id` 命名空间不重置 → 按 `tool_use_id` 建的足迹可以和 fork 后的会话 join。**
3. **Q2 这个代理指标本身不成立**，且本机无法补测（见下）。`cache_read_input_tokens`
   是缓存时序产物，不是继承语义的判据。
4. 对 TF-0131 的裁决：走「**继承成立**」那条分支 —— TF-0131 退化为
   「fork 时复制 footprint 并标 `inherited: true`」，约一天工作量。
   判据从 Q1+Q2 改成 **Q1+Q3**：Q2 本来是「fork 是否真带着源上下文」的代理，
   而 Q3 用文件级事实直接回答了同一个问题，比代理更强。

---

## 方法

fork 的磁盘签名是「**逐字前缀 + 不同 sessionId**」：

- 同一 `sessionId` 内的 rewind／编辑**不新建**会话文件 → 不会误入样本；
- 压缩写的是 summary 消息而**不是**逐字前缀 → 也不会误入样本。

`--scan` 按「首条消息 uuid 相同」聚成家族，再在家族内按 mtime 给每个 fork 找
共享前缀最长的更早兄弟作最近祖先，在共享前缀上比对 tool id 序列。
`--live` 用和 `threads.ts` 逐字一致的命令行真跑一次，读回两个会话文件做同样的比对。

---

## Q1 · resume + fork-session 能否接上 stream-json 会话

`--live` 实测（本机 claude 未登录，见 Q2 一节）：

```
源 session id（--session-id 铸出）: 0e50eedf-f3b1-4c74-92fa-27bc8895c0f9
fork session id（init 行回报）    : c604c3d6-b119-4487-8195-8fd48c688441
```

resume **没有**报 `no conversation found`，`system/init` 行回报了一个新 id。
关键时序：`init` 行在**任何 API 调用之前**发出，会话文件也在第一次调用之前落盘，
所以 **Q1 与 Q3 在未登录的机器上同样可测**，只有 Q2 需要真实计费轮次。

## Q3 · 前缀复刻与 tool_use_id 命名空间

最有说服力的样本来自本仓库自己（`D--helmor-main`）：

| 项 | 值 |
| --- | --- |
| 源 → fork | `dd77a534…` → `d0abd4f4…` |
| 逐字共享前缀 | 406 条消息 |
| 共享前缀内 tool id | 306 条，**序列完全一致** |
| 源／fork 各自的分叉后尾巴 | 40 条 / 63 条 |

全量：**33/33 配对 tool id 序列逐字一致**，其中 31/33 确实含工具调用
（2 个配对的分叉点早于第一次工具调用，前缀里天然 0 条）。
样本里可见 `toolu_bdrk_01VsvfSCvYbB4KdWULaskWmo` 这类 id 在源与 fork 两侧同序出现。

意义：`footprint.inherited` 需要的 join key **不用另发明**。`tool_use_id` 过 fork
不变，`ForkAgentPlan.sourceFootprintSeq` 可以是一个真实的切点，而不是名义字段。

局限：33 个配对是按**磁盘签名**判定为 fork 形状的，未逐个追溯它们当初是不是由
`--fork-session` 产生。`--live` 已确认 `--fork-session` 会产出同一签名，
这对结论足够；但不能反推「所有同签名文件都来自 `--fork-session`」。

## Q2 · 前缀 KV 命中：代理指标不成立

两件事分开说。

**一、这台机器测不了新样本。** 桌面宿主把 provider 认证接管了：
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`、`CLAUDE_CODE_HOST_AUTH_ENV_VAR=ANTHROPIC_AUTH_TOKEN`，
而 `ANTHROPIC_AUTH_TOKEN` **不在子进程环境里**，`~/.claude/.credentials.json` 也不存在。
子进程 `claude` 一律 `authentication_failed` / `Not logged in · Please run /login`。
`--live` 因此把 Q2 明确标成 `unmeasured`，不拿零值冒充观测。

**二、就算能测，这个指标也不该当判据。** 历史样本已经自证：

| 分叉首轮 | 配对数 |
| --- | --- |
| `cacheRead > 0` | 10 / 33 |
| `cacheRead = 0` | 21 / 33（其余 2 个配对无分叉后 assistant 轮） |

按「源末轮 → 分叉首轮」的间隔切开看，**间隔 ≤ 5 分钟（即缓存 TTL 内）的 11 个配对里，
命中 5 个、未命中 6 个**；而未命中的那些普遍带着大额 `cacheCreate`
（例如 `72cb3058…` → `cf9119ce…`，间隔 2.9min，`cacheRead=0` 但 `cacheCreate=197678`），
即前缀是**重新写缓存**而不是读缓存。反过来也有间隔 156.8 分钟仍 `cacheRead>0` 的配对。

也就是说 `cacheRead` 由缓存 TTL、路由和计费后端共同决定：本仓库那个配对整场
`cacheRead`／`cacheCreate` 全为 0、全部计入 `input_tokens`（`toolu_bdrk_*` 前缀，
说明走的是 Bedrock），根本没有缓存字段可读。**同一个继承语义能给出完全不同的数字，
所以它不是继承语义的判据。**

---

## 对下游节点的影响

- **TF-0131（分支读集继承与诚实开关）**：按 TF-0140 的验收，走「继承成立」分支 ——
  fork 时复制 footprint 并标 `inherited: true`，约一天工作量；join key 用 `tool_use_id`。
  仍需保留诚实开关：只有走 `--fork-session` 这条路径才置 `agentContextInherited=true`，
  HTTP 路径无工具调用、足迹恒为空集，不得据此声称继承成功。
- **TF-0138（ADR：前提守护架构与产品边界）**：依赖解除，可以把「继承以文件级
  逐字复刻为准，不以 cache 数字为准」写成边界。
- **不受影响**：Q2 的不可测是宿主认证形态导致的，与 Workbench 代码无关；
  若日后在已登录机器上跑，`--live` 会自动改口径。

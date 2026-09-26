# Codex 验证前的前置条件与环境测试（TF-0281 · 2026-09-26）

> **状态：环境测试通过 / 真实写侧验收未开始。**
> 本文件只记录「跑真实 codex 需要什么条件、这些条件现在满足没有」，不宣称任何 F-03 结论。

---

## 1. 需要哪个第三方模型（回答「前置条件」）

**`glm-5.3-flash`**（用户给定），走既有网关：

| 项 | 值 |
| --- | --- |
| 端点 | `http://127.0.0.1:3065/v1`（`wire_api = "responses"`） |
| 模型 | `glm-5.3-flash` |
| 密钥 | **只经环境变量** `WB_VERIFY_LLM_KEY`，不落任何文件 |

**为什么必须是这个写法**：网关 `/v1/models` 目录里有 12 个模型，其中 glm 系有五个
（`glm-5.3` / `glm-5.3-flash` / `glm-5-3` / `glm-5-3-flash` / `sn-glm-5-3-flash`）。
**只有带点的 `glm-5.3-flash` 与 `glm-5.3` 标着 `supports_tool_call: true`**，其余为 false——
codex 必须能调用工具，所以带连字符的变体不能用。

## 2. 为什么必须做隔离（不能用默认模型）

本机 `~/.codex/config.toml` 的默认是：

```toml
model_provider = "custom"
model = "grok-4.7"
base_url = "http://127.0.0.1:15721/v1"
```

所以**直接跑 codex 会用 grok-4.7**。验收要求非默认模型，因此验证跑在一个**独立的
`CODEX_HOME`**（`<repo>/.agent-contexts/codex-verify`，untracked），配置来自仓库里沉淀的
模板 [`scripts/verify/codex-gateway.toml`](../../scripts/verify/codex-gateway.toml)。
宿主默认配置**一行未改**。

## 3. 环境测试结果（实测）

```
OpenAI Codex v0.158.0-alpha.2
model: glm-5.3-flash          ← 不是默认的 grok-4.7
provider: wb_verify
session id: 01a0dcee-6fae-7863-b21b-2a60f6f59a94
exit=0
```

**工具调用验证**（这一步最重要，因为 codex 车道的写侧全靠它）：

```jsonc
{"type":"item.completed","item":{"id":"item_1","type":"command_execution",
 "command":"\"D:\\software\\PowerShell\\pwsh-dir\\pwsh.exe\" -Command 'echo PROBE-OK > probe.txt'",
 "exit_code":0,"status":"completed"}}
```

文件真的落盘：`probe.txt` = `PROBE-OK`。**模型发起了工具调用并成功执行。**

## 4. 三条前置条件缺口（都已定位，两条已解决）

### 4.1 codex 在 Windows 上默认 read-only，会自己挡住写入 —— 必须显式放开

实测：即使 `--sandbox workspace-write`，codex 仍报 `sandbox: read-only`，写入被
`blocked by policy` 挡下。

```jsonc
ERROR codex_core::tools::router: exec_command failed:
  Rejected("... -Command 'echo PROBE-OK > probe.txt' rejected: blocked by policy")
```

**这对 F-03 是致命的**：如果 codex 自己的沙箱就是挡住写入的那个，那么「写被封印了」
与「写被 codex 挡了」**无法区分**，验收会得出假结论。所以验证 profile 必须是：

```toml
sandbox_mode = "danger-full-access"
[windows]
sandbox = "elevated"
```

放开后同一命令 `exit_code: 0`、文件写入成功——**写入能力来自 codex，不是来自 seal**，
只有这样后续的 stale premise / readonly 阻断才归因得到 seal 身上。

### 4.2 仓库没有钉 codex 版本

本机有两个版本：`0.130.0-alpha.5`（`bin\codex.exe`）与 **`0.158.0-alpha.2`**
（`bin\d23520d1e41bfb24\codex.exe`，桌面应用也用它）。仓库里没有任何地方记录验证过哪个
版本，而 app-server 协议随版本变化。本次取 **0.158.0-alpha.2**，并记在此处作为本轮口径。

### 4.3 codex 不认识 `glm-5.3-flash` 的元数据

```
warning: Model metadata for `glm-5.3-flash` not found.
         Defaulting to fallback metadata; this can degrade performance and cause issues.
```

宿主默认配置用 `model_catalog_json = "cc-switch-model-catalog.json"` 解决同类问题。本轮先用
fallback（功能正常），若要更稳可给验证 profile 补一份 catalog。

## 5. 车道怎么接（已确认的契约）

- `packages/workbench/src/chat/codex-app-server/protocol.ts`：
  `CODEX_COMMAND_DEFAULT = "codex app-server -c notify=[]"`，可被
  **`WORKBENCH_CODEX_COMMAND`** 覆盖。**车道不传模型**——模型完全由 `CODEX_HOME` 决定。
- **`codex` 不在 PATH 上**（本机实测 `Get-Command codex` 找不到）。所以真实验证时必须给
  `WORKBENCH_CODEX_COMMAND` 绝对路径，并给子进程同一个 `CODEX_HOME`。
- 现有集成测试 `codex-liveness.integration.test.ts` 用的是 **stub 脚本**
  （`process.execPath` + 固定脚本），**从未跑过真实 codex CLI**——这正是 ADR-0017 记下的空缺。

## 6. 一次自己造成的意外（已清理）

第一次测试时用了 `$home` 作变量名——**`$HOME` 在 PowerShell 里是只读的**，赋值失败，
于是配置被写到了 `C:\Users\27933\config.toml`（宿主家目录），隔离也没真生效。
**已删除该文件并改用 `$codexHome` 重做**，重做后隔离与模型选择均正确。

## 7. 下一步（等你点头）

真实写侧验证要跑的是：在临时工作区建 `.workbench/` → 造一条 stale premise →
用 `WORKBENCH_CODEX_COMMAND` 拉起真实 codex（我们的模型）→ 让它写那个文件 →
观察 seal 是否介入。**预期结论按产品文档是「不介入」**（AGENTS.md：seal 只在 Claude Code
的 PreToolUse hook 上），但这是必须用真实 codex 证明或推翻的——本轮到此为止，
没有下这个结论。

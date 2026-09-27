# codex 封印端到端实验：真实 `fileChange` 审批抵达 `decideSeal`（2026-09-27）

> **双标签口径：工程门通过（本机可执行范围）/ 产品证据仍不足。**
> 本记录只说到读数支持的那一步：**不**宣称「codex 写保护已闭环」。

## 0. 这一轮要回答什么

PR #43 修掉了一个具体缺陷：`item/fileChange/requestApproval` 的 params 里**没有 path**
（只有 `threadId` / `turnId` / `itemId` / `startedAtMs` / `reason` / `grantRoot`），
所以 `approvalTargets` 的 `paths` 恒为空、`session.ts` 的封印闸门
（`kind === "write" && paths.length > 0`）永不成立——**原生写从来不会被咨询封印**。
修法是按 `params.itemId` 关联先前那条 `fileChange` item 的 `changes[].path`。

假 app-server 的端到端测试证明了控制流，但**真实 codex 那一侧没有任何读数**。本轮补上。

- 仪器：`packages/workbench/scripts/verify/codex-write-seal.ts`（`--case own-fresh` / `own-stale`）。
  它驱动的是**真实车道**（`ChatThreads` + `provider: "codex"` → `codex-app-server/session.ts`），
  不是裸 app-server 探针——所以 PR #43 的接线在它的执行路径上。
- profile：`scripts/verify/codex-gateway.toml`（`glm-5.3-flash` @ `http://127.0.0.1:3065/v1`，
  `wire_api = "responses"`，`approval_policy = "on-request"`），`sandbox_mode` 各跑一种。
- `CODEX_HOME` 隔离在 `.agent-contexts/codex-seal`（full-access）与 `.agent-contexts/codex-seal-ro`（read-only）。

## 1. 读数

### A. `sandbox_mode = "danger-full-access"`

| case | exit | measured | writeLanded | sealEventsAfterCodex | controlDecision |
| --- | --- | --- | --- | --- | --- |
| `own-fresh` | **2** | false | false | 0 | — |
| `own-stale` | **0** | true | **true** | **0** | **block** |

`own-stale` 的 `reason` 是空串，即**观测完成**：建立 1 条失效前提，写入**确实落盘**
（`contentAfter` 里出现 `// written by codex`），而**封印事件 0 条**；对照（冻结同一写者与同一组前提）
的判决是 **`block`**。

**但这不能读成「封印失败」。** stderr 里**没有任何审批诊断**——说明这个 profile 下
**codex 根本没有发审批请求**（权限全开时无需询问），拦截点压根没触发：旧实现与新实现都无从介入。
这与 2026-09-26 的旧观测同因，也正是 ADR-0023 写下的那句「CLI 可能不发审批」。

### B. `sandbox_mode = "read-only"`

| case | exit | measured | sealDecisions |
| --- | --- | --- | --- |
| `own-fresh` | **0** | true | `[{path:"",decision:"pass"}, {path:"src/target.ts",decision:"pass"}]`，`controlDecision: "pass"` |
| `own-stale` | **2** | false | —— `reason`: 「真实读回合没有目标文件足迹，无法测量封印因果」 |

### 把 A 与 B 合起来看，才是本轮的结论

在**会发审批**的 profile（B）下，真实 codex 回合的审批**确实抵达了 `decideSeal`，而且带的是真实目标路径
`src/target.ts`**。修复前这条路径的 `paths` 恒为空，闸门不成立，`decideSeal` **一次都不会被调用**。
这就是本轮拿到的端到端证据。

## 2. 证明了什么、没证明什么

**已证明（真实模型 + 真实车道）：**

1. 原生 `fileChange` 审批在真实回合里会发生（B 的 `own-fresh` 有 `sealDecisions` 记录）；
2. 经 PR #43 的关联后，它把**真实目标路径**交给了 `decideSeal`；
3. 前提新鲜时 `decideSeal` 判 `pass`，回合正常收尾（`controlDecision: "pass"`）。

**没有证明（下一位接力者请注意）：**

- **「stale 前提下封印会挡住真实 codex 写」仍未证明。** B 的 `own-stale` 返回 exit 2
  （read 回合没建立目标足迹 → 前提与读数都没立起来），A 的 `own-stale` 虽然 `measured: true`
  但拦截点没触发（无审批）。缺的是**同时满足**「会发审批」与「能建立目标读足迹 / 失效前提」的**一次** run。
- **一个未查明项**：B 的 `own-fresh` 里有一条 `path: ""` 的封印判定。本记录不下结论——
  它可能是仪器自身的对照/基线调用（`codex-seal-baseline.ts`），也可能是别的来源。
  **下一轮应查清**，而不是当成已知。

## 3. 复核命令（复制即可跑）

```powershell
# 会发审批的 profile（B）
Copy-Item scripts\verify\codex-gateway.toml .agent-contexts\codex-seal-ro\config.toml -Force
# 把 sandbox_mode 改成 read-only 后：
$env:CODEX_HOME          = "D:\helmor-main\.agent-contexts\codex-seal-ro"
$env:WORKBENCH_CODEX_COMMAND = '"C:\Users\27933\.codex\plugins\.plugin-appserver\codex.exe" app-server -c notify=[]'
$env:WB_VERIFY_LLM_KEY   = "<gateway key>"
cd D:\helmor-main
bun packages/workbench/scripts/verify/codex-write-seal.ts --case own-fresh --json
bun packages/workbench/scripts/verify/codex-write-seal.ts --case own-stale --json
```

`exit 0` 只说明**观测完成**，不等于写保护成立；`exit 2` 是**无法测量**，永远不读成通过。

## 4. 这条读数对 issue #31 的意义

#31 的完成判据里，「采集真实 codex 会话 / 沉淀夹具 / 补写侧门禁」都已达成；
剩下的一条——**写保护是否真的生效**——现在有了前半段证据（封印被真实回合调用、拿到真实路径），
但**最后一步（stale 前提下真的挡住）仍未实测**。所以本 issue 保持 open，理由从
「写侧没有样本」变成了**「缺一次同时满足两个前置的真实 run」**——这是一个更窄、也更可执行的缺口。

# Codex 写侧封印缺口的对照读数（issue #31 · 2026-09-27）

> **结论：Codex 写侧不在封印保护内——这是实测，不是推断。**
> 在 `own-stale`（前提失效）案例中，真实 codex 的写入**落盘了**，而 `decideSeal`
> 在事件日志里**一次都没被咨询**（`sealEventsAfterCodex = 0`）；同一写者、同一目标
> 的冻结对照调用 `decideSeal` 得到 **`block`**。若封印接在这条车道上，该写应当被挡。

## 0. 哪些读数是真实运行

| 层 | 内容 | 来源 |
| --- | --- | --- |
| **A. 真实运行（模型调用）** | `codex-write-seal.ts --case own-stale/own-fresh` 两轮完整实验 | 本轮现场实跑（用户提供的网关密钥，只经 `WB_VERIFY_LLM_KEY`） |
| **B. 对 A 的对照** | `decideSeal` 冻结对照（`controlDecision`） | 同一实验内置 |
| **C. 跑测 / 读代码** | 足迹解析、引号尾缀修复 | `bun test src/chat/codex-footprint.test.ts` |

密钥未写入本文件或任何提交（ADR-0020 凭据纪律）。

## 1. 实验矩阵（同一 profile、同一提示）

隔离 `CODEX_HOME` = `.agent-contexts/codex-verify`（`glm-5.3-flash`，
`sandbox_mode = danger-full-access` + `[windows] sandbox = elevated`，
`approval_policy = on-request`）。

| 案例 | staleClaims | writeLanded | sealEventsAfterCodex | controlDecision |
| --- | --- | --- | --- | --- |
| **own-fresh** | 0 | **true** | **0** | `pass` |
| **own-stale** | **1** | **true** | **0** | **`block`** |

判读：

1. 两个案例写入都落地 → 写入能力来自 codex，不是封印放行。
2. 两个案例封印都是 0 次介入 → 这条车道根本没走到 `decideSeal`。
3. 对照在 stale 时判 `block`、fresh 时判 `pass` → 封印谓词本身工作正常，
   问题在**归因/接线**，不在谓词。

这与 ADR-0023 的边界声明一致（Codex 为实验通道、写侧保护不完整），但此前只有
2026-09-26 的历史观测（`claim-codex-write-unsealed`，L3，已退役定义）；本次是
**own-stale 对照加入后的新定义下的 L1 读数**。

## 2. 本轮顺带修掉的足迹缺陷（先红后绿）

**现象**：`sealBaseline` 报「真实读回合没有目标文件足迹」，尽管模型确实在读
`src/target.ts`。

**真因（两个，都修了）**：

1. **引号尾缀**（`codex-footprint.ts` 的 `catPaths`）：pwsh 启动的
   `cat src/target.ts` 到达解析器时是 `cat src/target.ts"'`，旧的
   `replace(/^"|"$/g,"")` 只剥双引号，声明变成 `src/target.ts"'`，
   与 `normalizeTarget` 后的 `src/target.ts` 永远对不上——读足迹静默消失。
   现改为剥两端任意引号组合；回归测试
   `codex-footprint.test.ts`「shell-wrapper quote tails never become part of
   the path claim」钉住。
2. **仪器提示不稳**：`danger-full-access` 下模型偏好 `Get-Content` / `type`，
   而足迹通道的兼容边界只解析 `cat <path>`（见
   `codex-footprint.test.ts` 的 explicit compatibility boundary）。
   `codex-write-seal.ts` 的读提示改为强制 `cat`，使仪器可复算。

**未修、已记录**：`Get-Content` / `type` 仍不在足迹兼容边界内——Windows
模型的常见读法会留下零足迹。扩大解析面是产品决策，留给维护者。

## 3. 复现

```powershell
$env:WB_VERIFY_LLM_KEY = "<网关密钥，只经环境变量>"
$env:WB_CODEX_BIN = "<codex.exe 绝对路径>"
$env:WORKBENCH_CODEX_COMMAND = '"<codex.exe>" app-server -c notify=[]'
$env:CODEX_HOME = "D:\helmor-main\.agent-contexts\codex-verify"
bun packages/workbench/scripts/verify/codex-write-seal.ts --case own-stale --json
bun packages/workbench/scripts/verify/codex-write-seal.ts --case own-fresh --json
```

声明与读数：`evidence/claims.json` 的 `claim-codex-write-seal-gap`。

## 4. 这证明什么、不证明什么

**证明**：在本机、本模型（glm-5.3-flash）、本 codex 构建、本实验定义下，
Codex 写侧的 stale-premise 写入**不会**被封印拦截，而封印谓词在同一现场会
判 block。

**不证明**：其他模型/profile/回合形状上的结论；`fileChange` 原生写路径的
封印行为（已有另一组夹具与测试，见 `codex-write-capture.test.ts`）；readonly
area 拒绝；失败/取消/进程重启四类会话（TF-0264 仍未覆盖全五类）。

# 真实 codex 的写不受封印保护（F-03 / TF-0264 · 2026-09-26）

> **结论：用真实 codex CLI 证明——stale premise 上的写入落盘了，封印 0 次介入；
> 而同一个 `decideSeal` 对同一条前提会 block。**
> 这不是文档推断，是一次带对照的可复算实验。**但只测了「写」这一类**，其余四类见 §5。

---

## 1. 实验结果（`bun packages/workbench/scripts/verify/codex-write-seal.ts --json`）

```json
{
  "measured": true,
  "staleClaims": 1,
  "codexCommand": "\"...\\codex.exe\" app-server -c notify=[]",
  "turnEvents": ["user", "turn_started", "delta", "...", "done"],
  "writeLanded": true,
  "contentBefore": "export const target = 2;\n",
  "contentAfter":  "export const target = 2;\n// written by codex\r\n",
  "sealEventsAfterCodex": 0,
  "controlDecision": "block",
  "sealEventsAfterControl": 1
}
```

| 读数 | 值 | 含义 |
| --- | --- | --- |
| `staleClaims` | **1** | 前提确实 stale——否则「没被封印」可能只是因为没什么好封印的 |
| `writeLanded` | **true** | 真实 codex 把那行写进了文件 |
| `sealEventsAfterCodex` | **0** | codex 这条写路径上，封印一次都没被咨询过 |
| `controlDecision` | **block** | **对照**：同一个 `decideSeal`（Claude Code hook 调的就是它）对同一条前提判 block |
| `sealEventsAfterControl` | **1** | 并且留下了 `seal.decided` 事件 |

**对照是结论成立的关键**：没有它，「没被封印」无法与「前提本来就不 stale」区分。
现在两者都排除了：前提 stale（1 条 pending），封印有效（block + 事件落账），
而 codex 的车道根本没走到封印。

## 2. 静态证据（与实验互相印证）

`decideSeal` 在**生产代码里只有一个调用点**：

```
packages/workbench/src/commands/premises.ts:124   ← 即 `workbench premises seal`
```

封印 hook 只接在一个地方——`.claude/settings.json` 的 **PreToolUse**，
matcher 为 `Write|Edit|MultiEdit|NotebookEdit`，命令是
`bun "$CLAUDE_PROJECT_DIR/packages/workbench/src/index.ts" premises seal`。

而 `packages/workbench/src/chat/codex-app-server/protocol.ts:30` 自己写着：

> This does not consult seal. `decideSeal` runs only from `workbench premises seal`
> (the Claude Code PreToolUse hook).

**静态与动态一致**：codex 车道不经过封印，因为它压根不在 hook 的matcher 覆盖范围内。

## 3. 为什么这件事重要

ADR-0017 把 codex 的 approval 设计成**自动接受**，并明确「permission requests are
auto-accepted and do not call seal」。所以这不是实现 bug，而是**已声明的产品限制**——
但在此轮之前，它只有文档陈述，没有真实 codex 的证据。现在有了，而且顺带把
「不能只靠默认模型测」的理由也坐实了：

- 用的是隔离 `CODEX_HOME` + 网关模型 `glm-5.3-flash`（**不是宿主的 grok-4.7**）；
- codex 自己的沙箱必须先放开（`danger-full-access` + `[windows] sandbox="elevated"`），
  否则写入会被 **codex** 挡下，实验就无法区分「seal 挡的」和「codex 挡的」。

## 4. 顺带发现：真实 codex 有 4 类流事件车道没建模

车道在 stderr 上报：

```
[chat] codex 线程 <id> 有未建模的流事件类型：
  warning, item/reasoning/summaryPartAdded,
  item/reasoning/summaryTextDelta, item/commandExecution/outputDelta
```

这是**版本漂移**：仓库里没有任何地方钉 codex 版本，而现有集成测试用 stub（照旧协议造），
所以 4 类新事件从来没被任何测试覆盖。本轮跑的是 `0.158.0-alpha.2`。
**本轮只记录，未修**——修它属于车道适配，不在「写侧封印」这条验收里。

## 5. 这一轮**没有**测什么（不要读成已验证）

TF-0264 原本要求五类真实会话，本轮只做了「写」这一类：

| 类别 | 状态 |
| --- | --- |
| 正常写 | ✅ 已测（`writeLanded: true`） |
| stale premise 归因 | ✅ 已测（0 次封印 + 对照 block） |
| **readonly area** | ❌ **未测**（`protection.readonlyAreas` 同样只在封印点生效，但没有真实验证） |
| approval 请求 | ❌ 未测（ADR-0017 说自动接受） |
| 失败 / 取消 / 进程重启 | ❌ 未测 |

## 6. 复核命令

```bash
# 需要环境：CODEX_HOME=<隔离目录>、WORKBENCH_CODEX_COMMAND=<codex 绝对路径> app-server -c notify=[]、
#          WB_VERIFY_LLM_KEY=<key>（只经环境变量）、NO_PROXY=127.0.0.1,localhost,::1
bun packages/workbench/scripts/verify/codex-write-seal.ts --json   # 期望 writeLanded=true, sealEventsAfterCodex=0, controlDecision=block
bun run check:claims                                              # claim-codex-write-unsealed
```

## 7. 现在轮到你决策（TF-0263）

证据齐了，问题变成一个产品选择：

- **A. 把 codex 写侧接进封印**（让 codex 的写也走 `decideSeal`）——成本是改车道，
  收益是写安全闭环覆盖到第二条写入路径。
- **B. 保持 auto-accept，但把它标成显著产品限制**——成本近乎零，代价是「封印只在
  Claude Code 车道上有效」必须写在用户看得见的地方，而不是只写在 AGENTS.md 里。

在你定之前，本轮不下结论、不动车道。

---

## 8. 更正：我先前把「复现不了」归错因了（2026-09-26 同日）

第一次运行成功后，后续几次全部失败于：

```
ENOENT: no such file or directory, uv_spawn 'C:/Users/.../bin/d23520d1e41bfb24/codex.exe'
```

我当时**断言**这是 `packages/workbench/src/supervisor/argv.ts:120` 的缺陷——它故意把绝对路径的
反斜杠换成前向斜杠（注释称 bun 的 uv_spawn 会弄坏反斜杠路径），而我判断 uv_spawn 不接受
`C:/...` 形式。

**这个判断是错的，而且我当时没有做对照。** 补做的矩阵探针（2 个 exe × 文件斜杠 × cwd 斜杠 ×
环境，共 16 组）给出：

| exe | 结果 |
| --- | --- |
| `C:\Windows\System32\where.exe` | **8/8 全过**——含文件前向斜杠的 4 组 |
| `…\bin\d23520d1e41bfb24\codex.exe` | **8/8 全失败**——含最普通的「反斜杠 + 继承环境」 |

前向斜杠显然不是变量。真正的原因是：**那个目录已经不存在了**——Codex 桌面应用当天 17:09
轮换了运行时目录（`bin/` 下新出现 `0ddb895c950eaeba` 与 `faa963e871dd422c`），
**我写死在验证配方里的路径中途失效了**。

改用稳定位置（`~/.codex/plugins/.plugin-appserver/codex.exe`）后实验**可复现**，
读数已恢复（`claim-codex-write-unsealed` valid，exit 0）。**结论本身不变**——
它本来就是同一次实验得到的。

### 真正的缺陷（已修）

探针暴露的是另一个问题：`resolveWindowsExecutable` 对**绝对路径不做存在性检查**（原第 62-64 行
「absolute — use as-is」），于是一个失效的配置以裸 `uv_spawn ENOENT` 冒出来——错误信息里
有路径、却没有「这个路径没了」这句话，而调用方自己的「命令未找到」根本轮不到出场。

修法：绝对路径也走 `fileExists`，不存在则返回 `null`（走「命令未找到」）。
回归测试在 `packages/workbench/src/supervisor/argv.test.ts`，**先红后绿**：
撤掉修复时 `expect(received).toBeNull()` 失败（收到的是原样路径），恢复后 2 pass / 0 fail。

**教训**（与本轮主题同构）：我给出的「缺陷归因」也是一条声明，它同样需要对照。
一个 16 组的探针就把它推翻了——**没有对照的归因，和没有读数的 done 是同一种东西。**


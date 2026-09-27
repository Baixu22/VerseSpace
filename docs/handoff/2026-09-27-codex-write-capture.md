# 真实 codex 写回合的写侧证据（issue #31 · 2026-09-27）

> **结论：抓到了一个真实写回合——文件确实被改动，但整条流里没有一个原生写 item，
> 审批的 `commandActions` 全部是 `type: "unknown"` 且没有 `path`。因此 issue #31 设想的
> 「写侧夹具门禁」在这条车道上不是「还没收集到夹具」，而是对本次抓取的
> 模型 / profile / 回合**结构性缺席**。**
>
> 这只覆盖**一次抓取（一个模型、一个 profile、一个回合）**。ADR-0023
> 「对某个命令的负面观测不能泛化到整个 CLI 版本」同样适用于此：§6 列出它**不**证明什么。

---

## 0. 哪些读数是真实运行，哪些只是读代码

ADR-0020 要求把这两类分开写。本报告的来源分三层：

| 层 | 内容 | 谁产生的 |
| --- | --- | --- |
| **A. 真实运行（模型调用）** | `danger-full-access` 对照（0 审批）、`read-only` 审批抓取、写回合的 raw dump（432 行 / 144,671 B） | 本轮之前的 Lead，2026-09-27；**本报告作者没有重跑任何模型调用** |
| **B. 对 A 的产物重新分析** | item 类型普查、`commandActions` 普查、审批 params 形状、写是否落地 | 本报告作者，读 `.agent-contexts/codex-raw-dump.jsonl`（磁盘上的真实抓取） |
| **C. 跑测试 / 读代码** | 纯函数 `extractCodexFootprint` / `approvalTargets` / `decideServerRequest` / `reduceCodexRenderEvent` 的实际输出；`codex-router.ts`、`codex-turn.ts`、`session.ts` 的控制流 | 本报告作者，`bun test` + 读源码 |

**没有**做的事：没有重跑 codex、没有起模型服务、没有跑 `scripts/**` 下的探针。
因此 §2 里凡是标 A 的读数都是**复用**的，不是本轮复算的。

## 1. Recipe（A 层是怎么跑出来的）

```powershell
# 隔离 CODEX_HOME + 本地网关 profile（.agent-contexts/codex-verify/config.toml）：
#   model = "glm-5.3-flash" / model_provider = "wb_verify"
#   [model_providers.wb_verify] base_url = "http://127.0.0.1:3065/v1"
#                              wire_api = "responses" / env_key = "WB_VERIFY_LLM_KEY"
#   sandbox_mode = "read-only" / approval_policy = "on-request" / [windows] sandbox = "elevated"
$env:CODEX_HOME = "D:\helmor-main\.agent-contexts\codex-verify"
$env:WB_VERIFY_LLM_KEY = "<key>"          # 只经环境变量，不落文件
$env:WB_CODEX_BIN = "<codex.exe>"          # codex-cli 0.158.0-alpha.2.1
node .agent-contexts/codex-raw-dump.mjs    # → .agent-contexts/codex-raw-dump.jsonl
```

`.agent-contexts/codex-raw-dump.mjs`（本机 scratch）做的事：在 `%TEMP%\wb-codex-raw\src\target.ts`
里写入 `export const target = 1;`，`spawn` 隔离 `CODEX_HOME` 下的 `codex app-server -c notify=[]`
（`cwd` = 该临时目录），握手 → `thread/start` → `turn/start`，**逐行原样记录每个
server→client 消息**，并把每个 server 请求都回 `{ "decision": "accept" }`。

提示词（dump 第 9 行原样）：

```
Edit src/target.ts using your apply_patch file-editing tool (do NOT use the shell):
change 'export const target = 1;' to 'export const target = 2;'.
```

> ⚠️ **一个必须说清的细节**：dump 里那 5 个审批是**探针脚本**（`codex-raw-dump.mjs` 第 58 行）
> 用 `accept` 答的，不是 workbench 车道答的。dump 只记录 stdout，**不含**我们发出的应答
> （全文件 0 次 `"decision"`）。所以「车道会怎么答」是 §5 的**代码读数**，不是 A 层观测。

## 2. 原始读数

### 2.1 full access 对照：没有审批可抓（A）

Lead 的读数：`packages/workbench/scripts/verify/codex-approval-capture.ts --json` 在
`sandbox_mode = "danger-full-access"` 下 → 回合完成、`captured: []`
（**0 个 server→client 请求**，没有可审批的东西）。
磁盘上留下三份探针输出：`.agent-contexts/codex-capture.json` 与 `codex-capture2.json`
都是 `captured: []`；`codex-capture3.json` 的 `captured` 长度为 1（read-only，见 §2.2）。
**本报告作者只复核了这三份 JSON 的内容，没有复核它们各自对应的 `sandbox_mode`**——
「哪一份是 full-access」采信 Lead 的记录。可以确认的推论是：写审批只在沙箱**不允许**写时
才出现，这解释了为什么 §2.3 的写审批是在 read-only profile 下逼出来的。

### 2.2 read-only：抓到真实审批（A）

Lead 的读数：同探针 + `sandbox_mode = "read-only"` → exit 0，抓到真实审批请求。
磁盘上的 `.agent-contexts/codex-capture3.json`（**本报告作者复核过内容**）显示
`captured` 长度 1、`reason: "turn/completed"`，内容是
`item/commandExecution/requestApproval`，
`kind: "command"`，命令是 `pwsh.exe -NoProfile -Command "echo '// probe' >> src/target.ts"`，
`commandActions: [{ type: "unknown", command: "echo '// probe' >> src/target.ts" }]`，
`availableDecisions: ["accept", {acceptWithExecpolicyAmendment}, "cancel"]`（**没有 `decline`**）。
这与既存夹具 `src/chat/fixtures/approvals/command-execution-0.158.json` 的形状一致——
那个夹具 `$comment` 里的 recipe（「read-only 沙箱 + on-request 审批逼出来的」）**可复现**。

### 2.3 写回合的 item 类型普查（A 抓取 + B 统计）

`.agent-contexts/codex-raw-dump.jsonl`：432 行、144,671 B，`turn/completed` 收尾，`status: "completed"`。

| item 类型 | 次数 |
| --- | --- |
| `commandExecution` | 22 |
| `agentMessage` | 16 |
| `reasoning` | 16 |
| `userMessage` | 2 |
| `fileChange` | **0** |
| `applyPatch` | **0** |
| `fileRead` | **0** |

`commandActions` 普查（22 个 commandExecution item，每个恰好 1 个 action）：

| action `type` | 次数 | 带 `path`？ |
| --- | --- | --- |
| `read` | 8 | 是（结构化绝对路径，如 `…\wb-codex-raw\src\target.ts`） |
| `unknown` | 14 | **否**（只有 `type` + `command`） |
| `edit` / `write` / `applyPatch` / `createFile` | **0** | — |

**写确实落地了**（这是「不是没写，而是写了却看不见」的关键对照）：

- 成功那次：`exitCode: 0`、`aggregatedOutput: "Success. Updated the following files:\nM src/target.ts\n"`；
- 回合末尾的读回命令输出 `export const target = 2;`（原文件是 `1`）；
- 模型自己最后说：`Updated \`src/target.ts:1\` to \`export const target = 2;\` using \`apply_patch\`.`。

**模型是绕 shell 写的**（所以写永远不会变成原生写 item）：它依次尝试
`pwsh.exe -Command 'apply_patch *** Begin Patch…'`（ParserError，exit 1）、
`pwsh.exe -Command "apply_patch @'…'@"`（Invalid patch，exit 1），
最后用 `$patch = @'…'@` + `& '…\.codex\plugins\.plugin-appserver\codex.exe' --codex-run-as-apply-patch "'$patch'"`
成功——成功那次的命令串里**连 `apply_patch` 这个 token 都没有**。

### 2.4 审批 params 的形状（A + B）

5 次 `item/commandExecution/requestApproval`（`id` 0–4），**每一次**：

```json
{
  "kind": "command",
  "itemId": "call_563216262c4c49e79b56bc5a",
  "reason": "Do you want to allow apply_patch to modify src/target.ts in the read-only workspace?",
  "command": "\"D:\\\\software\\\\PowerShell\\\\pwsh-dir\\\\pwsh.exe\" -Command 'apply_patch *** Begin Patch\n*** Update File: src/target.ts\n@@\n-export const target = 1;\n+export const target = 2;\n*** End Patch'",
  "cwd": "C:\\Users\\27933\\AppData\\Local\\Temp\\wb-codex-raw",
  "commandActions": [
    { "type": "unknown", "command": "apply_patch *** Begin Patch\n*** Update File: src/target.ts\n@@\n-export const target = 1;\n+export const target = 2;\n*** End Patch" }
  ],
  "proposedExecpolicyAmendment": ["D:\\software\\PowerShell\\pwsh-dir\\pwsh.exe", "-Command", "apply_patch …"],
  "availableDecisions": ["accept", { "acceptWithExecpolicyAmendment": { … } }, "cancel"]
}
```

**写目标 `src/target.ts` 只出现在散文 `reason` 里**；`commandActions[0]` 没有 `path`。
5 次只在 shell 引号写法上不同（`'…'` / `"…"` / `@'…'@` 两种变体）。

### 2.5 真实 0.158 写回合里，render 表没有决策的形状（A + B）

| 形状 | dump 里的次数 | `resolveCodexRenderDecision` |
| --- | --- | --- |
| `item/commandExecution/outputDelta` | 82 | 无决策 → `undecided` |
| `item/reasoning/summaryTextDelta` | 71 | 无决策 → `undecided` |
| `item/reasoning/summaryPartAdded` | 8 | 无决策 → `undecided` |
| `serverRequest/resolved` | 5 | 无决策 → `undecided` |
| `warning` | 1 | 无决策 → `undecided` |
| `remoteControl/status/changed` | 1 | 无决策 → `undecided` |

后果（代码读数，C 层）：`codex-router.ts:38-40` 把它们记进 `undecidedEventTypes`，
`codex-turn.ts:73-77` 在回合结束时 `console.warn` 一次清单；**回合本身照常收尾**，
不是 error，也不是 exit 2。这 6 类**不是 item 类型**，所以与 §2.3 的「零写 item」不冲突，
也不触发 ADR-0017 那句「未建模的 item 类型会以 `undecided` 报警」。

## 3. 落了哪些夹具（B/C 层产出，随本轮入库）

| 文件 | 行数 / 字节 | 内容 |
| --- | --- | --- |
| `packages/workbench/src/chat/fixtures/streams/codex/write-turn-0.158.jsonl` | 58 行 / 20,009 B | 真实写回合的**归一化通知流**（`{...params, type}`，与 `normalizeNotification` 同形）。含：真实提示词、读回证据（`target = 2`）、3 次 apply_patch 的 `commandExecution` item（`unknown` action、无 `path`）、成功那次的 `exitCode: 0`、以及零写 item。 |
| `packages/workbench/src/chat/fixtures/approvals/apply-patch-0.158.json` | 196 行 / 8,610 B | 同回合 **5 次真实写审批 params 原样**（`{requests: [{method, id, params}]}`），保留本机绝对路径——与既存 `command-execution-0.158.json` 同口径。 |
| `packages/workbench/src/chat/codex-write-capture.test.ts` | 新增测试文件 | 写侧门禁，见 §4。 |

**夹具是怎么生成的（可复核）**：不是手抄，而是从 `codex-raw-dump.jsonl` 按行号选取 →
JSON.parse → 去掉 envelope 的 `emittedAtMs`（`normalizeNotification` 也会去掉）→
只把采集机的两处路径换成既有夹具同款占位符（`C:\Users\27933\AppData\Local\Temp\wb-codex-raw`
→ `$DUMMY_REPO`；rollout 路径 → `$CODEX_HOME/sessions/…`）→ 重新序列化。
**没有新增字段、没有改数值**。选取的行号是 4、7、8、9、10、11、21、22、23–37、38、39、42、
76、82、163、169、377、383、402、405、408、409–427、428、431、432，外加 `{"type":"end"}`。

**刻意没进夹具的两类东西**：
1. **审批请求本身**。它是 server→client **请求**（带 `id`、`method`、`params`），
   `session.ts` 在 `id !== undefined && method` 分支就答掉了，**从不**走
   `normalizeNotification`。把它塞进 `type`-tagged 的流夹具会**发明一个线上不存在的形状**，
   而且它会是一个 `undecided` 事件，破坏「每个保留夹具零 undecided」这条既存门禁。
   它因此落在 `fixtures/approvals/`——这正是既存 0.158 审批夹具的既定位置。
2. **§2.5 的 6 类未建模通知**（`outputDelta` 等）。它们同样是 `undecided`，
   进不了 `streams/codex/`；改为在测试里以 dump 原样参数逐条钉住。

**夹具格式不允许注释行**：11 个保留 codex 流夹具**没有一个**带 header/comment 行
（每行都会被 `JSON.parse` 且必须拿到 render 决策），所以新夹具也没有——
出处写在测试文件头、本报告与审批夹具的 `$comment` 里。

## 4. 门禁断言了什么（C 层，`bun test src/chat/codex-write-capture.test.ts`）

1. **零原生写 item**：item 类型集合恰为 `{agentMessage, commandExecution, reasoning, userMessage}`；
   `fileChange` / `applyPatch` / `fileRead` 显式断言为空——**codex 哪天开始发写 item，
   这条会失败**，结论必须重做。
2. **零写 `commandAction`**：`edit` / `write` / `applyPatch` / `createFile` 显式断言为空；
   非读动作**没有任何 `path`**。同时断言读侧仍然被结构化归因（`read` + `path`），
   证明这些「零」不是因为整条通道坏了。
3. **写落地但归因不出**：夹具里存在读回 `export const target = 2;` 与成功写
   （`Success. Updated the following files` / `exitCode 0`）；`snapshot.footprints` 的
   `used` 有读路径、`generated` **全空**；3 次 apply_patch item 调
   `extractCodexFootprint` 全部返回 `null`（`commandActions` 无 `path`，
   `cat <path>` 回退也解析不出东西）。
4. **审批不可归因**：5 个真实审批全部 `item/commandExecution/requestApproval` + `kind: "command"`；
   每个 `commandActions[].type === "unknown"` 且**无 `path`**；写目标只在散文 `reason` 里；
   `approvalTargets(...)` 返回 `kind: "unknown"`（不是 `"write"`）且 `paths` 里没有写目标。
5. **未建模形状仍是 undecided**：§2.5 的 6 类逐条断言 `decision === "undecided"` 且 key 正确。
6. 既存门禁加强而非削弱：`codex-fixtures.test.ts` 的夹具数 11 → 12，新夹具同样通过
   「零 undecided + 投影一致」，快照为纯新增。

## 5. 现在被**证明**的 / 仍然**无法证明**的

**证明（A/B/C 三层合成，范围 = 本次模型 + profile + 回合）**

- 真实写回合可以**只**由 shell 命令构成：文件被改动，但流里没有 `fileChange` /
  `applyPatch` / `fileRead` item，也没有写类型 `commandAction`。
- 因此 `codex-footprint.ts` 的 `WRITE_ACTIONS` 分支在这个真实样本上**没有输入**，
  `codex-router.ts` 的 `settleCommandFootprint` 只会落读足迹；
  「写侧夹具门禁」在这里是结构性缺席，不是收集缺口。
- 真实写审批的 `commandActions[].type === "unknown"` 且无 `path`：**写目标在机器可读字段里不存在**。
- 由此（C 层代码读数）：`session.ts` 的封印闸门 `target.kind === "write" && paths.length > 0`
  对这 5 个真实审批**全部为假**，连「写审批无法归因到路径」的 stderr 提示
  （`session.ts:250-254`，同样要求 `kind === "write"`）也不会打印；
  实际发出的应答是 `decideServerRequest` 的默认 `{ kind: "approval", decision: "accept" }`。
  这与 ADR-0023 / ADR-0017 的「seal 不在这条车道上」一致，但**原因更具体**：
  不是「不解析 params」，而是**解析了却判不出写**。
- 真实写回合还带 6 类 render 表没有决策的通知；车道把它们记为 `undecided` 并在回合末
  `console.warn`，回合照常收尾（不是 error，不是 exit 2）。

**无法证明（不要外推）**

- 不能证明 codex 在任何情况下都不发原生写 item。原生 `apply_patch` **工具**是否可用、
  `sandbox_mode` / `approval_policy` / 模型能力都会改变模型是否绕 shell。本次唯一的
  反例线索是：模型自己的 reasoning 里写着「No dedicated apply_patch namespace」——
  在**这个 profile** 下它没有原生工具可用。
- 不能证明「写审批永远不可归因」。`approvalTargets` 对**重定向型**命令
  （`echo … >> src/target.ts`，即既存 `command-execution-0.158.json`）判 `kind: "write"`
  并抓到目标——那条路径是有门禁的（`approval-targets.test.ts`）。不可归因的是
  **apply_patch 型**命令。
- 不能证明车道对**真实审批**的实际应答行为（dump 只有 stdout；A 层观测里应答是探针发的）。
  §5 那一条是纯函数 + 控制流读数。
- 不能证明 `undecided` 的 6 类形状在别的 codex 版本仍然未建模。
- 不能证明除「写」以外的交互面（`turn/steer`、`skills/list` …）的现状。

## 6. 诚实边界（ADR-0023 的不泛化规则）

一次抓取 = **一个模型（`glm-5.3-flash`）、一个 profile（隔离 `CODEX_HOME`，read-only +
on-request，`[windows] sandbox = "elevated"`）、一个回合**。ADR-0023 明确写着
「对某个命令的负面观测不能泛化到整个 CLI 版本」——本节结论同样只能写成
「**在这条车道上、对这个 profile**，写侧是结构性缺席」，
不能写成「codex 不发写 item」。要推翻它，只需要一次反例：**任何**一次真实 codex 回合里
出现 `fileChange` / `applyPatch` / `fileRead` item，或 `commandActions[].type` 出现写类型
（或带 `path` 的写动作）。门禁会因此变红。

## 7. 复核命令（复制粘贴即可跑，不需要本机 scratch）

```bash
cd packages/workbench
bun test src/chat/codex-write-capture.test.ts     # 写侧门禁（本报告 §4）
bun test src/chat/codex-fixtures.test.ts          # 12 个流夹具的 render 决策门禁
cd ../..
bun run typecheck && bun run lint
```

重跑 A 层（会**真的调用模型**，需要网关与密钥；不要在 CI 或无人值守时跑）：

```powershell
$env:CODEX_HOME = "<repo>\.agent-contexts\codex-verify"
$env:WB_VERIFY_LLM_KEY = "<key>"
$env:WB_CODEX_BIN = "<codex.exe>"           # 0.158.0-alpha.2.1
node .agent-contexts/codex-raw-dump.mjs     # 逐行记录 server→client 消息
```

## 8. 刻意没做什么

- **没有重跑任何模型调用**：issue #31 的原始证据已在磁盘上，重跑只会引入不可复算的噪声。
- **没有把审批请求塞进流夹具**（理由见 §3）。
- **没有改 `codex-footprint.ts` / `codex-router.ts` / `session.ts`**：本轮只取证与钉读数。
  §5 发现的两个可改进点（`approvalTargets` 对 `unknown` 型写审批既不咨询封印也不出声；
  `unknown` 成功写的 `aggregatedOutput` 里有 `M src/target.ts`）是**下一轮**的候选，
  不混进本轮。
- **没有动 `docs/decisions/0023-*.md`**（另一条工作流拥有它）。
- **没有更新 `docs/decisions/README.md`**：它的状态列记的是**决策级取代关系**，
  而本轮的 ADR-0017 补记是**测量记录**，没有取代任何决策。是否需要在那里加一句，
  留给 Lead 判断（该文件不在本轮的写入范围里）。

---

## 补记（2026-09-27 晚）：本记录的「结构性缺席」结论已被证伪

本文（第一次抓取的记录）在开头、§6.2 与 §7 里把结论写成「写侧门禁**结构性缺席**」。
同日晚些时候的 **6 变体重复实验**推翻了它，理由很直接：

- 变体 01 是**同一个模型（glm-5.3-flash）、同一个 profile、同一条 prompt** 的重复，
  它发出了 **2 个 `fileChange` item** 与 **1 个 `item/fileChange/requestApproval`**（`kind: write`）；
  变体 06（新建文件 prompt）同样。
- 因此本记录读到的「整条流里没有任何原生写 item」是**那一个回合**的忠实读数，
  但由它推出的「所以结构性缺席」**不成立**——那是回合间方差。

§6 自己写的证伪条件（「任何一次真实 codex 回合里出现 `fileChange` item，门禁会因此变红」）
已经满足——**这就是那次变红**。本记录其余内容仍然成立、一字未改：写确实落盘、那一次抓取里
确实没有原生写 item、5 次写审批确实不可归因、`commandActions` 侧确实没有写类型、
`danger-full-access` 对照确实 0 个请求。被否掉的只有「一次观测 → 结构性」这一步。

更正后的机制（路径在 item 的 `changes[].path` 上、靠 `itemId` 关联）与修复见
[codex fileChange 封印关联记录](2026-09-27-codex-filechange-seal.md)。

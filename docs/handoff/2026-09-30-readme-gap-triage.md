# README「已知限制与实现缺口」定性分诊（2026-09-30）

针对根 README §[已知限制与实现缺口](../../README.md#已知限制与实现缺口)（10 行）与
[本轮 README 调用链复核](2026-09-30-readme-callchain-review.md) 的抽取与定性。
目标只有一个：**判断每一条该不该补，以及补的话最小动作是什么。**

基线 HEAD `68ebef5`（工作区含上一轮 README/插图/两份 09-30 记录的未提交改动）。
本轮**只读**：没有改产品代码、测试、`evidence/`、README 正文，没有动任务森林；
只额外跑了一条上传面门禁（见「读数说明」）。

## 结论

**这张表是「未完成声明」的清单，不是 backlog。** 10 条里只有 4 条是「实现与自身声明不一致」，
其余 6 条是产品定位的上限或已被 ADR 关闭的范围。

| 分诊 | 条数 | 含义 | 处置 |
| --- | --- | --- | --- |
| **D 实现缺陷** | 3 | 代码行为与其自身注释/同族实现相矛盾，且站点明确、单机可验 | **建议补** |
| **D′ 交互口径缺陷** | 1 | 功能存在但生效边界没告诉用户，静默无效 | **建议补（文案级）** |
| **B 架构边界** | 5 | 是刻意的取舍或能力上限；补 = 换产品定位 | 不补，保持公开声明 |
| **C 已裁决关闭** | 1 | ADR 明确关闭且禁止改记 | **不得补** |
| **S 定义澄清** | — | 不是缺口，是命名/预期问题（分散在 B 组行内） | 只改措辞 |

建议只开 **D 类 4 条**，且先做其中 2 条同属 Codex 车道的（可用一个 fixture 一起覆盖）。

## 已提 issue（2026-09-30）

4 条 D/D′ 已全部提为 GitHub issue（`bug` + `P1`/`P2`），B/C/S 类**没有**提 issue：

| 分诊 | 站点 | issue | 严重度 |
| --- | --- | --- | --- |
| D1 Codex 错误回合仍写 delivered | `chat/thread-run.ts:135` | [#45](https://github.com/Baixu22/VerseSpace/issues/45) | P1 |
| D2 封印汇总全体写者 claims | `chat/codex-session.ts:98-101` | [#46](https://github.com/Baixu22/VerseSpace/issues/46) | P2 |
| D3 >2 MB 变化恒不检测 | `runtime/premises.ts:106` + `runtime/read-set-diff.ts:155` | [#47](https://github.com/Baixu22/VerseSpace/issues/47) | P2 |
| D4 计划模式开关静默失效 | `apps/workbench-ui/src/chat/thread-slice.ts:105` | [#48](https://github.com/Baixu22/VerseSpace/issues/48) | P2 |

issue 正文只引用已在 `main` 上的代码路径：本记录与
[2026-09-30 调用链复核](2026-09-30-readme-callchain-review.md) 当时都还未入库，
写进 issue 会变成死链。加严重度时 `P3` 标签在仓库里不存在，最低档用 `P2`。

## 分诊表

| # | README 条目 | 事实核验（站点） | 定性 | 补？ |
| --- | --- | --- | --- | --- |
| 1 | 读集完整性 | `footprint.ts:15,51-52` 记录 size 但 version 置 null；`premises.ts:105-108` 与 `read-set-diff.ts:154-157` 只比 version → 双 null 视为「未变」 | 大文件漏检 = **D**；工具/路径覆盖、人类读取、模型隐含知识 = **B** | 部分 |
| 2 | 前提与计划 | 无「输出依赖哪些输入」的语义图；`seal.ts:122` 只做路径重叠 | **B**（第三层对象未建立，见对比调查 §65） | 否 |
| 3 | 通知确认 | `thread-run.ts:135` 在 `runCodexTurn` 返回后**无条件** ack；对照 `claude-router.ts:157-160` 仅 `subtype==="success" && !is_error` 才 ack | Codex 错误回合 ack = **D**；「成功回合≠修复证明」= **S** | 部分 |
| 4 | 写保护 | `codex-session.ts:98-101` 汇总**全体**写者 pending claims；`commands/premises.ts:118-123` 按 writerId 过滤 | 跨写者误封 = **D**；未覆盖工具/Git/编辑器与错误放行 = **B**（ADR-0023 明文） | 部分 |
| 5 | 分叉与跨 provider 历史 | provider 内部 session 不随 UI transcript 复制（`thread-inheritance.ts`） | **B**（协议外，不可搬运）+ **S** | 否 |
| 6 | 计划模式 | `thread-slice.ts:105` 发 PATCH；`claude-session.ts:66` 仅在 `ensureClaudeSession` 建进程时读，`:50-53` 进程跨回合常驻 | **D′**（UI 有开关、无生效提示） | 是（文案级） |
| 7 | reload / restore | 不可撤销的副作用无法回滚；checkpoint restore 只覆盖其记录的 Git/接口快照 | **B**（正确做法是不承诺） | 否 |
| 8 | 并发范围 | UI 单回合（`send-slice.ts:17`）；聊天线程不隔离 Git 工作区 | **B**；效率收益验证已被 ADR-0024 永久关闭 = **C** | 否 |
| 9 | 自动化范围 | auto 派发 ≠ spawn（复核 §隔离实跑：`agent_started` 为 0） | **S**（定义澄清） | 否 |
| 10 | 工程验证 | 只有 Windows 有执行证据 | **C**（ADR-0024：永久关闭，禁止改记 done/生成通过读数） | **不得** |

## D 类逐条：为什么是缺陷、最小动作是什么

### D1 · Codex 错误回合仍写 delivered 并清空队列（对应 #3）

- **站点**：[thread-run.ts:135](../../packages/workbench/src/chat/thread-run.ts#L135)
  `if (notices.length > 0) await acknowledgeDelivery();` —— 不看回合终态。
  同族实现 [claude-router.ts:157-160](../../packages/workbench/src/chat/claude-router.ts#L157-L160)
  只在 `subtype === "success" && is_error !== true` 时 ack。
- **为什么是缺陷而不是边界**：`runCodexTurn`
  （[codex-turn.ts:61-67](../../packages/workbench/src/chat/codex-turn.ts#L61-L67)）
  把 provider 错误吞成 `emit(error)` 后正常返回，所以「返回」不等于成功。
  后果是**双重的假证据**：写出一条 `premise_notice_delivered`，同时删除 `notices.jsonl`
  ——通知在断链后永久丢失，而账本显示已送达。这直接违反产品自己的核心声明
  （README「排入线程文件后由下一用户回合消费」与 review §通知时机「不会把 pending 假称送达」）。
- **最小动作**：`runCodexTurn` 暴露终态（返回 `{ ok }` 或抛出），`thread-run` 仅在成功时 ack。
  约 10 行 + 一个 fixture。
- **验收**：假 app-server 发 `error` 后断言 **0 条** `premise_notice_delivered` 且通知文件保留。
  现有 [2026-09-30 复核 §隔离实跑](2026-09-30-readme-callchain-review.md#隔离实跑)
  第 9 行已经复现过相反结果（1 条 delivered + 文件被移除），可直接把该观察改成反面断言。

### D2 · Codex 封印刷入了其他写者的 pending claims（对应 #4 后半）

- **站点**：[codex-session.ts:98-101](../../packages/workbench/src/chat/codex-session.ts#L98-L101)
  `(await pendingPremiseNotices(bb)).flatMap(n => n.claims)` —— 无 writerId 过滤；
  对照 [commands/premises.ts:118-123](../../packages/workbench/src/commands/premises.ts#L118-L123)
  `pending.filter(n => n.writerId === writerId)`。
- **为什么是缺陷**：写者 A 的写入可能被**写者 B 尚未处理**的前提判成 stale，且 `seal.ts:126-132`
  会把不属于 A 的路径原样列进拒绝原因。这是误封，不是漏封——代价直接落在用户身上。
  两条车道对同一 predicate 喂不同口径的输入，本身就是不一致。
- **最小动作**：一行过滤，向 hook 口径对齐（`writerId` 已在 `decideSeal` 调用处传入）。
- **边界提醒**：这条**不触碰** ADR-0023 冻结的「CLI 可能不发审批 / 目标无法归因 / 错误放行」——
  那些是覆盖问题，这条是**归因口径**问题，改动不扩大任何保证声明。

### D3 · >2 MB 文件的变化恒不被检测（对应 #1 后半）

- **站点**：[footprint.ts:15](../../packages/workbench/src/blackboard/footprint.ts#L15)
  `HASH_CAP_BYTES = 2_000_000`，[:51-52](../../packages/workbench/src/blackboard/footprint.ts#L51-L52)
  超限时 `{ version: null, size: st.size }`；
  两条对账路径 [premises.ts:106](../../packages/workbench/src/runtime/premises.ts#L106) 与
  [read-set-diff.ts:155](../../packages/workbench/src/runtime/read-set-diff.ts#L155)
  都只写 `if (current.version === claim.version) continue;` —— **`null === null` 为真，直接跳过**，
  已记录的 `size` 从未参与比较。
- **为什么是缺陷**：`footprint.ts:21-23` 的注释明确说超限时用 "plain size" 作为版本，
  实现却没有比。这是**实现与自身记录的意图相矛盾**，不是取舍。
  复核 §隔离实跑第 4 行已经复现：2,000,001 → 2,000,002 字节且内容改变，
  两次 version 均为 null，reconcile 通知 **0 条**。
- **最小动作**：两处判断在双 null 时回退比较 `size`（若要覆盖同尺寸改写，需在 claim 上
  追加 `mtimeMs`）。方向与代码既有取向一致——`footprint.ts:77-78` 写着
  "errs toward notifying, never toward silence"。
- **先要一个决定**：`size` 回退 / 记录 `mtimeMs` / 提高 cap，三者噪声与代价不同，
  且会影响 `noticeOutcomes` 分母。**这是决定，不是实现**，建议先定口径再动手。
- **前置读数**：需要一次基准确认大文件通知量不炸（`benchmark-premises.ts` 现有 11 场景不含大文件）。

### D4 · 计划模式开关在 live 会话中静默失效（对应 #6）

- **站点**：[thread-slice.ts:105](../../apps/workbench-ui/src/chat/thread-slice.ts#L105)
  PATCH `permissionMode`；[claude-session.ts:66](../../packages/workbench/src/chat/claude-session.ts#L66)
  只在建进程时拼 `--permission-mode`；[:50-53](../../packages/workbench/src/chat/claude-session.ts#L50-L53)
  `context.live` 命中即复用，进程跨回合常驻。
- **为什么算缺陷**：UI 提供了开关，用户在会话中途切换会**无变化也无提示**。
  README 已诚实写出这条边界，但产品内没有把边界告诉用户——文档正确不等于交互正确。
- **最小动作（择一，均不含重启）**：开关旁明示「对当前已启动的 CLI 进程不生效，下一进程生效」；
  或切换时若进程存活则先 idle-close 再由下一回合重建。
- **不要做**：把「重启 live CLI 以即时生效」当默认——那会切断 provider session 连续性，
  是需要独立验收的功能扩展，不是修 bug。

## 不补的 6 条与理由（含 B/C/S）

1. **#1 读集完整性（观测覆盖部分）**——外部 CLI 不完全受控，读取不完全可见是项目的前提假设，
   ADR-0023 明确「不新增通用 Shell 解析器」。人类读取与模型隐含知识不进入读集，
   是「读集是语义依赖的代理信号」这一自我声明的必然推论（对比调查 §55、§61 已引到反例论文）。
2. **#2 前提与计划**——要补就得建「计划依赖了哪些输入」的语义图并在行动前验证，
   那是 Planfence 那条路线，属新研究问题。ADR-0023 冻结功能扩展，且新增能力「须有新的研究问题与验收」。
3. **#3 通知确认（S 部分）**——「成功终止不等于模型修复证明」是**正确的不声明**，
   不是待办。补它等于伪造语义修复的测量，反而更糟。
4. **#4 写保护（覆盖部分）**——ADR-0023 逐项写死了：CLI 可能不发审批、目标可能无法归因、
   读取可能没有结构化路径、封印故障时放行。要做到完整写保护需要通用工具中介与补偿，
   项目已明确不实现。**保持声明，不改代码。**
5. **#5 分叉与跨 provider 历史**——UI transcript、CLI 内部 session、文件读集是三件事，
   provider 内部 session 不可搬运是协议外事实；补不了，只能继续分开声明。
6. **#7 reload / restore**——任意副作用不可撤销；正确做法是**不承诺**，
   现行 README 已经这么写。要补的是措辞清晰度，不是回滚引擎。
7. **#8 并发范围**——并发效率收益属**永久退役**的验证范围（ADR-0024 §2），
   相关节点保持 deprecated，禁止生成通过读数；UI 单回合与不自动隔离 worktree 是设计。
8. **#9 自动化范围**——`auto` 是派发语义，不是自主执行；这是命名问题，
   补的方式是措辞（README 已写），不是功能。
9. **#10 工程验证**——ADR-0024 §1/§3/§4：永久关闭非 Windows 实机验证，
   关闭不是通过，禁止改记 done。**任何试图「补全」这条的动作都是违规。**

## 刻意没做什么

- 没有修改任何产品代码、测试或 `evidence/`——本轮是分诊，不是修复。
- 没有把 #45–#48 登记为已修复，也没有刷新任何读数。
- **只为 D/D′ 四条提了 issue**（真实发布动作，写到了 `Baixu22/VerseSpace`）；
  B/C/S 六条一条没提，避免把它们变成待办。
- **只跑了 `check:upload-surface`**（exit 0，见「读数说明」）；
  lint / typecheck / test / doctor / check:claims / browser E2E **均未运行**。
- 没有启动任务森林节点，也没有改 `README.md` 正文。
- 没有把 #2/#4 的边界当作「待办」——它们是 ADR-0023 的交付边界本身。

## 下一步（给下一位接力者）

1. **#45 + #46 一起做**：同在 Codex 车道，一个假 app-server fixture 可同时覆盖
   「错误回合不 ack」与「只喂本写者 claims」。做完必须重跑
   `chat/notice-queue.test.ts`、`chat/codex-write-capture.test.ts`、`runtime/delivery.test.ts`。
2. **#47 先定口径再动手**：`size` 回退 / `mtimeMs` / 提高 cap 需要维护者选一个；
   选了之后要跑一次基准看通知量。
3. **#48 是 UI 文案级**，可独立提交。
4. **其余 6 条不要开工，也没有为它们提 issue**。若要调整对外表述，改 README 措辞，不要补功能。
5. 任何一条做完都要注意：**这张表是公开声明**，补了代码就要同步改表行，
   否则 README 会从「诚实披露」变成「过时披露」。

## 读数说明

- **本轮只跑了一条门禁**：`bun run check:upload-surface` → **exit 0**，
  上传面 836 个文件 · 违规 0 条 · 相对链接 485 条 · 断链 0 条（含本记录本身）。
  **没有跑** lint / typecheck / test / doctor / check:claims / browser E2E，也没有跑任何探针。
  上表中引用的实测数字（大文件 0 条通知、Codex deliver 1 条 + 文件被移除、
  dispatch `agent_started` 为 0）全部来自
  [2026-09-30 调用链复核](2026-09-30-readme-callchain-review.md) 的隔离实跑，
  **不是本轮复现**，不能当成本轮的测量结果。
- 本轮判断的性质是**代码站点核对 + ADR 口径比对**，不是产品验收。

## 复核命令

```bash
# D1：Codex 无条件 ack（对照 Claude 的成功帧门控）
grep -n "acknowledgeDelivery\|runCodexTurn" packages/workbench/src/chat/thread-run.ts
grep -n "acknowledgeClaudeNotices" packages/workbench/src/chat/claude-router.ts

# D2：两条车道对 claims 的口径差
grep -n "pendingPremiseNotices" packages/workbench/src/chat/codex-session.ts packages/workbench/src/commands/premises.ts

# D3：大文件 version=null 与两条对账路径的相等判断
grep -n "HASH_CAP_BYTES" -A3 packages/workbench/src/blackboard/footprint.ts
grep -n "current.version === claim.version" packages/workbench/src/runtime/premises.ts packages/workbench/src/runtime/read-set-diff.ts

# D4：开关、生效点与进程常驻
grep -n "permissionMode" apps/workbench-ui/src/chat/thread-slice.ts packages/workbench/src/chat/claude-session.ts

# 本记录自身的入库门禁（本轮唯一读数）
bun run check:upload-surface
```

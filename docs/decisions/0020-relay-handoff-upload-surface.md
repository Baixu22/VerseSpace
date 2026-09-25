# ADR-0020：接力交接的上传面定性（只上传结果性产物，且换机可复现）

- 状态：已接受（2026-09-25，用户指示「给开发内容定性，也就是只有结果性产物才上传，并且能够在别的用户机器上复现的内容，避免出现上传无用和有用未传的情况」）
- 森林节点：待建（本轮以 proposal 提交，见 `.agent-workbench/task-forest/proposals/`）
- 相关：[ADR-0018](0018-single-ci-channel-jihulab.md)（CI 单一通道）、[ADR-0019](0019-phase4-and-release-acceptance-as-external-gates.md)（外部门）
- 落地：`scripts/upload-surface/policy.json`、`scripts/check-upload-surface.mjs`、`docs/handoff/README.md`

## 背景

仓库早就有一条口径（TF-0220，写在 `.agent-contexts/README.md`）：**原始数据本地留，精选读数入库**。它有两个弱点，本轮都实测到了：

1. **口径是散文，不是判据。** 「精选」没有可执行定义，只能靠人记得。
2. **执行靠逐文件白名单。** `docs/*` 整体忽略，再一条条 `!` 回来。白名单会漂移——而漂移是静默的。

2026-09-25 本轮接手的起点就是一个已经发生的漂移：`docs/qa-stage-ab-remediation-2026-09-25.md`（上一轮的**交接报告**）被 `.gitignore:172` 的 `/docs/*` 排除、且从未提交。上一轮 6 个 commit 都在本地分支上，`main` 停在 `45f0a9b`；而**唯一能让下一个操作者在另一台机器上接着干的那份文件，恰恰没有上传**。同时 `.agent-contexts/README.md`（口径本身）也没有被跟踪——口径自己没进上传面。

这就是用户说的两个方向的错误：**有用未传**。反向的**无用已传**在历史上同样发生过——`.agent-workbench/task-forest/events/events.jsonl` 曾被跟踪到 83 MB，GitHub 每次推送都报 `GH001`。

## 判据

一个开发产物**可以**进入上传面，当且仅当同时满足两条：

1. **结果性**：它是本轮结论的载体，而不是产生结论的过程记录。判据是问「删掉它，本轮的主张还能不能被复核」——能，则它是过程；不能，则它是结果。
2. **换机可复现**：另一个用户在干净克隆上，仅凭上传物就能复算或复核该结论。至少要有一条可执行命令、或一份能独立读懂的读数。

**反例（留本机）**：原始日志、探针 dump、E2E 现场（黑板 + 临时 git 仓库 + transcript）、会话草稿、按日期的过程报告、依赖树、构建产物、密钥。
**正例（上传）**：源码、测试、配置、ADR、用户文档、交接记录、门禁脚本与策略本身。

## 决策

**把定性写成机器可读的策略，并用一个双向门禁来执行它。**

1. **四个类别**（`scripts/upload-surface/policy.json` 的 `classes`）：

   | 类别 | 上传 | 含义 |
   | --- | --- | --- |
   | `outcome` | ✅ | 结果性产物：本轮结论的载体 |
   | `curated-evidence` | ✅ | 精选可复算证据：体量小、且被 docs 或节点 evidence 引用 |
   | `process-evidence` | ❌ | 过程证据：换机不可复算 |
   | `machine-state` | ❌ | 机器状态与构建产物：可由命令重建 |
   | `unclassified` | ❌ | 策略未覆盖——**沉默不是决定**，门禁会报违规 |

2. **规则按 first-match-wins 求值**：越具体的规则越靠前，`defaultClass` 是 `unclassified`。任何没被规则覆盖的路径都会变成一条待裁决的违规，而不是悄悄留在本机。

3. **`docs/handoff/` 是接力交接记录的唯一入库位，按目录白名单。** 这是本轮唯一的结构性改动：目录白名单不会逐文件漂移，写进去就自动上传。旧的逐文件白名单正是让上一轮交接报告掉出去的原因。

4. **双向门禁**（`bun run check:upload-surface`，exit 0 干净 / 1 有违规 / 2 无法测量）：

   | 违规码 | 方向 | 含义 |
   | --- | --- | --- |
   | `useful-not-uploaded` | 有用未传 | 类别要求上传，却被 `.gitignore` 排除 |
   | `useless-uploaded` | 无用已传 | 类别要求留本机，却在上传面内 |
   | `unclassified` | 未定性 | 没有规则覆盖，没人做过决定 |
   | `oversize-uploaded` | 超限已传 | 单文件超过 `sizeLimitBytes`（默认 10 MiB）且无例外 |

5. **`referenced-but-local` 是待裁决信号，不是自动违规。** 已入库文档指向本机文档时，读者换机会跟到空指针；但补救不是机械的（有时该提升目标，有时该改掉引用）。所以默认报为「待裁决」，`--strict-references` 才把它当违规。

6. **冻结清单 `legacy-local-docs.json`** 记录 2026-09-25 之前就已存在、按 TF-0220 口径留本机的按日期文档。它**只应缩小**；新增条目必须在评审 diff 里可见。清单由 `--emit-inventory` 重新生成——生成是显式动作，diff 就是评审。

## 与既有口径的关系

本 ADR **收紧**而非取代 TF-0220 与 `.agent-contexts/README.md`：

- 「原始数据本地留」不变，但现在**必须由策略显式覆盖**，否则门禁报 `unclassified`。
- 「精选读数入库」不变，但现在「精选」被写成类别与规则，而不是散文。
- `.agent-contexts/` 整体仍是本机（`process-evidence`）；要提升某份材料，走 `curated-evidence` 规则或写进 `docs/handoff/`。

## 代价与已知限制

- **门禁的 git 探针在本机沙箱下不可用。** DSH 沙箱拒绝 node 创建子进程（`spawnSync git EPERM`），门禁会以 exit 2 报「无法测量」——**不会**退化成绿色。此时用 `--lists <dir>` 喂入三份清单（见脚本头部注释）。这是本机 caveat，不是产品缺陷。
- **`unclassified` 会带来一次性摩擦。** 每次新增一个未被规则覆盖的路径，门禁都会红一次，直到有人显式归类。这是有意的：那正是「有用未传」发生的地方。
- **冻结清单是 74 条人工接受的例外。** 它记录的是历史决定，不是「这些文件不重要」。清单里哪些其实是结论性产物、应该提升到 `docs/handoff/`，需要逐条裁决（见本轮报告 §5）。
- **体量上限 10 MiB 是防线不是目标。** 当前上传面最大文件 192 KB；上限设在这里是为了让 83 MB 级的误入立刻变红。
- **`referenced-but-local` 目前有 6 条待裁决**，默认不阻塞门禁。在全部裁决完之前，不得把它读作「引用关系已核对」。

## 复核

- **触发重估**：上传面出现新的顶层目录；或 `docs/` 的组织方式改变（例如引入 `docs/local-only/`）；或冻结清单连续两轮只增不减。
- **收紧路径**：把 6 条 `referenced-but-local` 逐条裁决完，然后给 CI 的门禁 job 加 `--strict-references`。
- **放宽路径**：若某类文件确实需要上传而不符合本 ADR 的判据，新增规则并在本 ADR 追加一段说明理由——不要改 `defaultClass`。

# 接力交接的上传面定性（2026-09-25）

> **双标签口径：工程门通过（仅限本地可执行范围）/ 产品证据不足。**
> 分支 `qa-stage-ab-remediation`，本轮改动**仅本地提交，未 push、未打 tag、未发布**。
> 本报告不含任何用工程测试冒充真实浏览器、真实 provider 或真人数据的结论。

---

## 0. 结论摘要

用户本轮指示：**「给开发内容定性——只有结果性产物才上传，并且能够在别的用户机器上复现的内容，避免出现上传无用和有用未传的情况」**。

本轮把「接力交接」本身做成机制，而不是再写一条散文口径：

| 产物 | 作用 |
| --- | --- |
| [ADR-0020](../decisions/0020-relay-handoff-upload-surface.md) | 判据（结果性 + 换机可复现）与四类别的权威 |
| `scripts/upload-surface/policy.json` | 定性的单一权威：32 条规则、78 个 glob、first-match-wins、`defaultClass=unclassified` |
| `scripts/upload-surface/classify.mjs` | **纯函数**分类器（不 spawn、不读盘），因此在本机沙箱下仍可被验证 |
| `scripts/check-upload-surface.mjs` | 双向门禁，exit 0 干净 / 1 违规 / **2 无法测量** |
| `.gitignore` 的 `!/docs/handoff/` | 交接记录改为**目录级白名单**，从结构上消除逐文件漂移 |

**本轮的起点是实测到的、已经发生的两个「有用未传」**——不是假设：

1. `docs/qa-stage-ab-remediation-2026-09-25.md`（**上一轮的交接报告**）被 `.gitignore:172` 的 `/docs/*` 排除，`git ls-files` 显示从未跟踪。上一轮 6 个 commit 都在本地分支上，而**唯一能让下一个操作者换台机器接着干的那份文件，恰恰没有上传**。
2. `.agent-contexts/README.md`（TF-0220 的归档口径**本身**）同样未跟踪——口径自己没进上传面。

---

## 1. 起点：口径的两个弱点

仓库早有一条口径（TF-0220）：**原始数据本地留，精选读数入库**。它有两个弱点，本轮都实测到了：

- **它是散文，不是判据。**「精选」没有可执行定义，只能靠人记得。
- **执行靠逐文件白名单。** `docs/*` 整体忽略，再一条条 `!` 回来。白名单会漂移——而漂移是**静默的**。

反向的**无用已传**在历史上同样发生过：`.agent-workbench/task-forest/events/events.jsonl` 曾被跟踪到 83 MB，GitHub 每次推送都报 `GH001`（`MEMORY.md` 记录）。

---

## 2. 定性：判据与四类别

**判据**：一个产物可以上传，当且仅当同时满足

1. **结果性** —— 删掉它，本轮的主张还能不能被复核？能，则它是过程；不能，则它是结果。
2. **换机可复现** —— 另一个用户在干净克隆上，仅凭上传物就能复算或复核该结论。

**四类别**（`policy.json` 的 `classes`）：

| 类别 | 上传 | 含义 |
| --- | --- | --- |
| `outcome` | ✅ | 源码、测试、配置、ADR、交接记录、门禁自身 |
| `curated-evidence` | ✅ | 体量小、且被 docs 或节点 evidence 引用的输入/快照 |
| `process-evidence` | ❌ | 原始日志、探针 dump、E2E 现场、会话草稿、按日期的过程报告 |
| `machine-state` | ❌ | 依赖树、dist、黑板、森林、worktree、导出物、密钥 |
| `unclassified` | ❌ | **沉默不是决定**——门禁会把它报成违规 |

**双向不变量**（门禁的四类硬违规）：

| 违规码 | 方向 |
| --- | --- |
| `useful-not-uploaded` | 类别要求上传，却被 `.gitignore` 排除（**有用未传**） |
| `useless-uploaded` | 类别要求留本机，却在上传面内（**无用已传**） |
| `unclassified` | 没有规则覆盖，没人做过决定 |
| `oversize-uploaded` | 单文件超过 `sizeLimitBytes`（10 MiB）且无例外 |

`referenced-but-local`（已入库文档指向本机文档）默认是**待裁决信号**而非违规——补救不是机械的（有时该提升目标，有时该改掉引用），`--strict-references` 才把它当违规。

---

## 3. 改了什么

| 文件 | 改动 |
| --- | --- |
| [docs/decisions/0020-relay-handoff-upload-surface.md](../decisions/0020-relay-handoff-upload-surface.md) | 新增 ADR：判据、四类别、双向不变量、代价与复核 |
| [docs/decisions/README.md:28](../decisions/README.md#L28) | ADR 索引追加 0020 行 |
| `scripts/upload-surface/policy.json` | 新增：32 条规则 / 78 个 glob / 5 个类别 |
| `scripts/upload-surface/classify.mjs` | 新增：纯分类器（glob 编译、first-match-wins、`evaluate()`） |
| `scripts/upload-surface/policy-loader.mjs` | 新增：规则 + 冻结清单的唯一合并点（CLI 与测试共用，避免两份实现漂移） |
| `scripts/upload-surface/legacy-local-docs.json` | 新增：73 条冻结清单，**只应缩小** |
| `scripts/upload-surface/classify.test.mjs` | 新增：12 条测试 |
| [scripts/check-upload-surface.mjs](../../scripts/check-upload-surface.mjs) | 新增：门禁 CLI，含 `--lists` / `--json` / `--strict-references` / `--emit-inventory` |
| [.gitignore:183](../../.gitignore#L183) | 新增 `!/docs/handoff/`（目录级白名单）+ 说明注释 |
| [package.json:22-23](../../package.json#L22-L23) | 新增 `check:upload-surface` / `test:upload-surface` |
| .gitlab-ci.yml:221-230（该文件已按 ADR-0021 删除，链接不再可跟） | 新增 `upload-surface` job（verify 阶段，含 `docs/**` 路径过滤） |
| `docs/handoff/README.md` | 新增：交接记录的口径与模板 |
| `docs/handoff/qa-stage-ab-remediation-2026-09-25.md` | **移动**：上一轮交接报告从 `docs/` 移入入库位（内容未改） |
| `docs/engineering-defect-localization-and-qa-plan-2026-09-24.md` | **纳入上传面**：上一轮任务书早已在 `.gitignore` 白名单里，但从未提交 |

`.gitignore` 的 `docs/` 段落现在把 `handoff/` 列为跟踪目录，并写明「After adding a doc, run `bun run check:upload-surface`」。

---

## 4. 测试证据：先红后绿

### 4.1 实现层（注入缺陷）

| 阶段 | 读数 |
| --- | --- |
| **RED**：把 `globToRegExp` 还原成有缺陷的 `raw.replace(/\/\*\*$/, "")` | `tests 12 / pass 3 / fail 9`，exit 1 |
| **GREEN**：恢复 `raw.endsWith("/") ? raw + "**" : ...` | `tests 12 / pass 12 / fail 0`，exit 0 |

缺陷的性质值得记下来：`docs/handoff/**` 一度编译成 `^docs/handoff$`，**只匹配目录本身、不匹配目录里的任何文件**。如果没有这条断言，门禁会永远把交接报告报成 `unclassified`，而且不会有人知道为什么。

### 4.2 真实树（本轮的实际缺陷）

| 阶段 | 读数 |
| --- | --- |
| **RED**：把交接报告排除出冻结清单 | 上传面 754 · 本机遗留 200934 · **违规 1 条**（`unclassified` = `docs/qa-stage-ab-remediation-2026-09-25.md`）· exit **1** |
| **GREEN**：移入 `docs/handoff/` + 目录白名单 | 上传面 759 → 最终 **763** · 本机遗留 **200935** · **违规 0 条** · exit **0** |

### 4.3 无法测量时必须报红

| 场景 | 读数 |
| --- | --- |
| 本机沙箱（node 无法创建子进程，`spawnSync git EPERM`）下不带 `--lists` | 报「无法测量：git 探针失败」· exit **2** |

**没有退化成绿色**——这是本门禁最重要的一条性质，与 `check-forest-landing.mjs` 的 exit 2 规则一致。

---

## 5. 双向 sweep 读数

最终读数（`--json`，本机以 `--lists` 喂入 git 清单）：

```
status: clean
uploaded: 763      ignored: 200935      violations: 0      referenceNotes: 6
byClass: outcome 760 · curated-evidence 3 · process-evidence 5872 · machine-state 195063
```

**「无用已传」方向：0 条。** 当前 763 个上传面文件全部落在 `outcome` 或 `curated-evidence`，最大文件 192 KB（`bun.lock`），无超限。

**「有用未传」方向：本轮修掉 3 条**（上一轮交接报告、口径文件所在的 `docs/` 空白、白名单却未提交的任务书），**另有 6 条待裁决**：

| 本机文档 | 被哪个已入库文件引用 |
| --- | --- |
| `docs/positioning-v5.md` | `docs/fable-brief/00-final-prompt.md` |
| `docs/live-model-evidence-2026-09-07.json` | `docs/fit-ledger.md` |
| `docs/report-2026-09-05-claude-fork-inheritance.md` | `docs/fit-ledger.md` |
| `docs/report-2026-09-07-live-model.md` | `docs/fit-ledger.md` |
| `docs/tf0136-l3-cut-verdict.md` | `docs/fit-ledger.md` |
| `docs/tf0136-verdict.md` | `docs/fit-ledger.md` |

**这 6 条需要维护者逐条决定**：提升目标（纳入上传面）还是改掉引用（已入库文档不再把本机材料当作承重引用）。**在裁决完之前，不得把这 6 条读作「引用关系已核对」。**

其中 `docs/live-model-evidence-2026-09-07.json` 是原始证据 dump，按 TF-0220 口径**不该**上传；`docs/tf0136-verdict.md` 一类的裁决结论则相反。所以门禁把它做成信号而不是自动违规——这是有意的取舍，不是遗漏。

---

## 6. 刻意没做什么、为什么

| 没做 | 为什么 |
| --- | --- |
| **不裁决那 6 条 `referenced-but-local`** | 补救不是机械的；涉及「哪些历史结论该出仓」的产品判断，应由维护者拍板 |
| **不把 73 条冻结清单当「不重要」处理** | 它们是 2026-09-25 之前的历史决定。清单只应缩小，新增条目必须在评审 diff 里可见 |
| **不改 `defaultClass` 以让门禁变绿** | 把兜底改成 `outcome` 会让「没人做过决定」重新变成静默通过——那正是本 ADR 要消灭的东西 |
| **不为通过门禁而放宽类别** | 同上 |
| **不跑三套件 / Playwright 并声称全绿** | 本机沙箱拒绝创建子进程（`uv_spawn EPERM`），三套件与浏览器拿不到有效读数；`typecheck`/`lint` 不受影响，已实跑 |
| **未在流水线上验证 `upload-surface` job** | 本轮不 push，CI 无法触发。job 的 YAML 已按既有 job 的形状写，但**未经流水线验证** |
| **不 push、不打 tag、不发布** | 用户本轮明确授权「只本地 commit，不 push」 |
| **任何破坏性 git** | 未用 `reset --hard` / `clean -f` / 强推 / 删分支；未改 git config |
| **不 apply 森林提案** | `proposal-save` 只写待确认提案；apply 需要用户确认（森林纪律） |

---

## 7. 下一步与遗留风险

1. **6 条 `referenced-but-local` 待裁决（主要缺口）。** 裁决完后给 CI 的门禁 job 加 `--strict-references`，把信号升级成门禁。收紧路径写在 ADR-0020「复核」一节。
2. **`upload-surface` CI job 未经流水线验证。** 下次 push 到 JihuLab 时应确认它按 `.paths.upload_surface` 触发，并在 docs-only push 上真的跑起来。
3. **门禁的 git 探针在本机沙箱不可用。** 本轮所有真实树读数都是用 `--lists` 喂入清单得到的；**内置 git 探针路径在本机未被执行过**。在无沙箱 shell 里跑一次 `bun run check:upload-surface`（不带 `--lists`）才能验证该路径。
4. **`node --test` 在本机不可用**（每个测试文件 spawn 一个子进程 → EPERM）。因此 npm script 直接执行测试文件，让 `node:test` 在进程内运行。若将来改用 `--test`，本机将无法验证。
5. **冻结清单是 73 条人工接受的例外。** 其中哪些其实是结论性产物、应提升到 `docs/handoff/`，需要逐条裁决。ADR-0020 已把它列为「连续两轮只增不减」的复核触发条件。
6. **上一轮的其余遗留未推进**：TF-0255（浏览器门禁 + CI 接线）、TF-0261（仓库级审计 sweep）状态不变。
7. **产品证据仍为零**：真实浏览器、真实 provider 写侧、当前发布物、真人 fit 四类证据本轮均未推进。

---

## 8. 森林

- `proposal-save` 一条提案：**`TFP-2026-09-25-upload-surface`**，状态 `proposed`（**未 apply**），1 条 `add_node`：节点 `接力交接的上传面定性：只上传结果性产物且换机可复现（ADR-0020）`，status=`done`、progress=100，附 9 条 evidence。
- `validate` exit 0。**`proposal-apply` 未执行**——按森林纪律，应用待确认的提案需要用户拍板。
- 未改任何既有节点的状态、进度、依赖或验收门槛。

---

## 9. 复核命令

```bash
# 1) 门禁自身（纯函数，任何有 node 的机器都能跑）
node scripts/upload-surface/classify.test.mjs      # 期望 12 pass / 0 fail

# 2) 双向门禁。无沙箱 shell 里直接跑内置 git 探针：
bun run check:upload-surface                        # 期望 exit 0

# 3) 本机若禁止 node 创建子进程（本沙箱就是这样），用三份清单喂入：
git ls-files                                    > /tmp/us/tracked.txt
git ls-files --others --exclude-standard        > /tmp/us/untracked.txt
git ls-files --others --ignored --exclude-standard > /tmp/us/ignored.txt
node scripts/check-upload-surface.mjs --lists /tmp/us   # 期望 exit 0；6 条待裁决会打印出来

# 4) 交叉验证：把某份本机文档当成「该传的」看门禁是否报红
#    （临时把一条 docs/handoff/** 规则去掉，或在 docs/handoff/ 里放一个被忽略的文件）
bun run lint                                        # 期望 exit 0
bun run typecheck                                   # 期望 exit 0

# 5) 森林
python C:/Users/27933/.workbuddy/skills/task-forest/scripts/task_forest.py \
  validate --workspace D:/helmor-main               # 期望 exit 0
```

**合并本分支前请把本轮读作「工程门通过（本地可执行范围）」，而不是「产品已验收」。**

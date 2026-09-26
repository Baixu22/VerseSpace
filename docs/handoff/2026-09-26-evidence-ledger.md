# 证据账本与失效门禁（第四轮阶段 A · 2026-09-26）

> **双标签口径：本机实测通过 / 产品证据仍缺。**
> 分支 `qa-stage-ab-remediation`，改动仅本地 commit，未 push。
> 本报告不含「用散文替代读数」的结论——每条数字都能指回一条可复算的命令。

---

## 0. 结论摘要

第三轮把**验收控制面**修好了（红灯能出现），但**声明本身没有沉淀纪律**：审计表的「140 个
catch 站点」只有本机脚本能算，三套件读数只活在交接报告的散文里，47 个 done 节点没有任何
证据。本轮建立**证据账本 + 失效门禁**，核心不变量是：

> **仪器内容变了，或 `subject_paths` 里有任何改动晚于读数的提交 → 读数立刻 stale。**

这就是这个仓库自己的「前提失效」概念，第一次用在他自己的声明上。

| 产物 | 作用 |
| --- | --- |
| `evidence/claims.json` | 声明注册表：每条声明点名仪器、覆盖路径、读数必须携带的数字形状 |
| `evidence/readings/<id>.json` | 读数：`instrument_sha256` / `subject_sha` / `environment` / `reading` / `raw_digest` / `reproduce` |
| `evidence/raw/`（gitignored） | 原始输出：ADR-0020 的 process-evidence，本机留，只有哈希入库 |
| `scripts/claims/ledger.mjs` | **纯函数**评估器（不读盘、不 spawn），因此在本机沙箱下也能验证 |
| `scripts/claims/record-reading.mjs` | 记录读数：与门禁共用同一个 `instrumentKey`，避免两份实现漂移 |
| `scripts/check-claims.mjs` | 门禁：**0 一致 / 1 有失效 / 2 无法测量**（exit 2 永不当作通过） |
| `scripts/audit/catch-sites.mjs` | 沉淀的审计仪器：「140 站点」现在任何人可复算 |

**读数：门禁 8/8 valid、exit 0；账本测试 10/10。**

## 1. 我自己的第一版有两个过度/不足失效的 bug，都实测到了

写门禁的过程中，机制本身抓出了我自己的两个错——这正是它该干的事：

**bug 1（不足失效）：只比提交，看不见工作区。**
第一版用 `git diff <sha>..HEAD`。实测：往 `packages/workbench/src/index.ts` 加一行，
门禁**仍然全绿**——而未提交的改动正是开发者大部分时间的状态。
修法：改成 `git diff <sha>`（工作区 vs 那次读数的提交），同时覆盖已提交与未提交。
修后实测：改 `packages/workbench/src/index.ts` → 恰好 3 条覆盖它的声明报 `stale-subject`
（catch-sites / workbench-suite / browser-e2e），其余 5 条不受影响。

**bug 2（过度失效）：把所有读数并成一个变更集。**
第二版按 subject_sha 算变更，但把**所有**读数的结果并成一个列表套给每条声明——于是今天
取的读数会被**它之前**发生的改动判成 stale（实测：刚重取的 `claim-upload-surface-clean`
仍报 stale，而差异其实是更早的提交造成的）。
修法：`changedSinceBySha`，每条声明只跟自己那次读数的提交比；新增测试钉住。

**还有一个死循环**：`claim-upload-surface-clean` 的 subject 合理地覆盖 `evidence/**`，
而读数文件就在里面——提交读数会让它自己失效。判据：**读数是对树的记录，不是树的输入**，
所以 `evidence/readings/**` 与 `evidence/raw/**` 从变更集里排除；`evidence/claims.json`
仍然计入（它确实是输入）。

## 2. 第一批读数（8 条声明，全部 valid）

| 声明 | 仪器 | 读数 |
| --- | --- | --- |
| catch 站点清点 | `node scripts/audit/catch-sites.mjs` | **141 站点 / 61 文件** |
| 账本门禁自测 | `node scripts/claims/ledger.test.mjs` | 10 pass / 0 fail |
| workbench 套件 | `bun run test:workbench` | **1004 pass / 0 fail**（155 文件 / 143.3s） |
| dashboard 套件 | `bun run test:workbench-ui` | 67 pass / 0 fail（18 文件） |
| context-rot 套件 | `bun run test:context-rot` | 69 pass / 0 fail |
| doctor | `bun packages/workbench/src/index.ts doctor` | exit 0 · 113 断言 / **0 失效** |
| 上传面门禁 | `bun run check:upload-surface` | exit 0 · 违规 0 |
| 浏览器 E2E | `pwsh -NoProfile -File scripts/win/e2e-browser.ps1` | **14 passed / 0 skipped / 0 failed** |

**一处数字变了，而且是应该变的**：审计表（2026-09-25）记的是 **140 站点**，现在复算是
**141**。差异来自那之后的两轮修复本身（新增 `ui/json-body.ts` 的解析 catch、
`supervisor/liveness.ts` 的 terminate try/catch，以及若干被替换掉的静默 catch）。
审计表按「修正是新条目」保留原样——**它的 140 是当时的读数，不是现在的**。

## 3. 这一轮**没有**解决什么

- **47 个空证据 done 节点**仍然空着（阶段 B / TF-0279）。
- **状态语义未定**：`done` 是否必须有读数、`landed-unknown` 怎么用（阶段 B / TF-0278）。
- **产品证据三类**（Codex 真实写侧 / 非 Windows 发布物 / 真人窗口）仍未开始，它们卡在
  外部条件上（阶段 C / TF-0281）。
- **D 类（已退役 CI 的读数）按你的指示暂时 pass**——它现在是账本里的一条空白，不是被
  解决了。
- 门禁目前只覆盖 8 条声明；文档与森林里还有大量散文数字没有登记。**登记本身是下一步的
  工作量，不是已经完成的。**

## 4. 复核命令

```bash
node scripts/claims/ledger.test.mjs        # 期望 10 pass / 0 fail
node scripts/check-claims.mjs              # 期望 8/8 valid · exit 0
bun run check:claims                       # 同上（package.json 入口）
bun run audit:catch-sites                  # 期望 141 站点 / 61 文件

# 证明失效规则真的会咬：改一行被测代码，相关读数立刻 stale
echo "// probe" >> packages/workbench/src/index.ts
node scripts/check-claims.mjs              # 期望 exit 1，3 条 stale-subject
git checkout -- packages/workbench/src/index.ts
node scripts/check-claims.mjs              # 期望 exit 0
```

> **2026-09-26 收尾更正：命令不变，期望值已漂移。** 本文 §2 的表和上面这几行「期望」是当时的读数；收尾后账本从 8 条长到 **13 条**（12 valid + 1 条 L3 历史观测），账本自测 **14 pass / 0 fail**，catch 站点 **143 / 61 文件**，workbench 套件 **1014 pass / 0 fail**，dashboard **68 pass**，doctor **117 条断言**（本文写的 113 是当时的计数口径）。复核以 `evidence/readings/` 与 [收尾记录](2026-09-26-research-closeout.md) 为准。

# 权限放开后的真实读数：三套件全绿 + 浏览器 E2E 真跑（2026-09-25）

> **双标签口径：工程门通过（这一轮是**本机有效读数**）/ 产品证据仍不足。**
> 分支 `qa-stage-ab-remediation`，改动**仅本地 commit，未 push、未打 tag、未发布**。
> 本轮不含真实 provider 写侧与真人数据——那两类证据仍然为零。

---

## 0. 结论摘要

本轮的前提变了：DSH 文件策略从 `workspace-write` 变成 `danger-full-access` 之后，
**子进程限制解除**（`uv_spawn EPERM` 消失）。此前每一轮报告都写着
「本机沙箱拒绝创建子进程，三套件拿不到有效读数」——现在第一次实测。

| 门禁 | 之前（标注为无效） | 现在（有效） |
| --- | --- | --- |
| `test:workbench` | 854 pass / **135 fail** | **1002 pass / 0 fail**（154 文件 / 142.6s / 33 snapshots / 4301 expect） |
| `test:workbench-ui` | **启动即失败**，0 个测试跑起来 | **67 pass / 0 fail**（18 文件 / 10.7s） |
| `test:context-rot` | 53 pass / **15 fail** | **68 pass / 0 fail**（6 文件 / 2.0s） |
| `bun run typecheck` | exit 0 | exit 0 |
| `bun run lint` | exit 0（620 文件） | exit 0（620 文件，无修复项） |
| `bun packages/workbench/src/index.ts doctor` | 未取到 | **exit 0**（context rot 109 条断言 / 0 条失效；blackboard 一切正常） |
| `check:upload-surface` | 只能用 `--lists` 喂清单 | **exit 0**（内置 git 探针路径**首次被真实执行**；中途因为 E2E 现场被报红 7 条，见 §3，补 glob 后回到 exit 0） |
| Playwright 浏览器 E2E | Chromium `EPERM` | **13 passed / 1 skipped / 0 failed**（14 tests / 33.7s） |
| `scripts/check-forest-landing.mjs` | **exit 2 无法测量** | **exit 1 drift**：HEAD 领先 main 15 commit、**43 个代码文件未并入 main** |

**两条结论：**

1. **之前那 135 + 15 个失败确实是环境噪声。** 每一条的归因（`uv_spawn` 被拒）现在都被
   实测证实——同一份代码、同一次会话里，三套件全绿。这不是「失败被修好了」，是
   **同一个东西第一次被正确测量**。
2. **落库缺口第一次被真正测出来。** 不再是「无法测量」，而是 `drift` +
   具体文件数。这正是 `TFD-0dab4149f2` 说的那个盲区——现在它有读数了。

**合计有效读数：1137 pass / 0 fail / 0 归因不明的失败。**

## 1. 逐条读数与命令

```bash
# 三套件（去掉注入代理，loopback 才走得通）
Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY   # PowerShell
bun run test:workbench        # 1002 pass / 0 fail / 154 files / 142.60s
bun run test:workbench-ui     # 67 pass / 0 fail / 18 files / 10.68s
bun run test:context-rot      # 68 pass / 0 fail / 6 files / 2.02s

# 静态门禁与 doctor
bun run typecheck             # exit 0
bun run lint                  # exit 0，620 文件
bun packages/workbench/src/index.ts doctor   # exit 0

# 两个自建门禁
bun run check:upload-surface  # exit 0（上传面 768 / 违规 0 / 待裁决 6）——内置探针首次真实执行
node scripts/check-forest-landing.mjs   # exit 1 drift（HEAD 领先 15 commit / 43 个代码文件）

# 真实浏览器
bun packages/workbench/src/index.ts ui --port 7700 --no-open   # 后端
bun run dev:ui                                                  # Vite（5188 → 代理 /api 到 7700）
cd apps/workbench-ui && bun run test:e2e                        # 13 passed / 1 skipped / 0 failed
```

**注意 `check-forest-landing` 的 exit 1 是"有漂移"，不是"跑不起来"**——
上一轮的清单里专门标过这个坑（python 版 CLI 的 `check-landing` 在本机报
`WinError 5` 且退出码也是 1，两者含义完全不同）。现在 node 版给出的是**真读数**。

## 2. TF-0255 验收第 3 条：静默 skip → fail with reason

**这一条此前做不了**：改完没浏览器可跑，等于交付未验证的改动。
现在能跑，于是做了，并且在真实浏览器上取到 RED 与 GREEN 两侧。

改动（`apps/workbench-ui/e2e/ui.spec.ts`）：

| 位置 | 之前 | 现在 |
| --- | --- | --- |
| `ui.spec.ts:76`（规划模式） | `test.skip(!candidate, "Requires a local conversation in default or plan mode.")` | `expect(candidate, "…（缺前置数据：fail with reason，不静默 skip）").toBeDefined()` |
| `ui.spec.ts:161`（草稿停放/恢复） | `test.skip((await rows.count()) < 2, "Requires two existing local conversations.")` | 先等 `/api/chat/threads` 的响应，再断言未归档会话 ≥ 2，并带同一条理由 |

第二条顺带修了一个**测量缺陷**：原来先 `expect(rows.first()).toBeVisible()` 再数行数——
空工作区会在可见性断言上超时失败，而不是给出"缺两个会话"这条理由。先问 API 再断言，
失败信息才指向真正的原因。

**真实浏览器 RED / GREEN：**

| 场景 | 读数 |
| --- | --- |
| **GREEN**：仓库工作区（前置数据齐） | **13 passed / 1 skipped / 0 failed**（34.0s） |
| **RED**：空工作区（`workbench init` 出来的干净 ledger，后端 `cwd` 指向它） | **2 failed / 11 passed / 1 skipped**——两条失败**带着理由**：`Requires a local conversation in default or plan mode（缺前置数据：fail with reason，不静默 skip）`、`Requires two existing local conversations（…）` |

RED 的两条失败还各自留下了截图与 trace（`test-results/`，gitignored 的本机产物）——
也就是说**"没跑成"这件事现在是可复现、可追查的**，而不是报告里一个安静的 `-`。

**仍然保留的 1 个 skip** 是 `dropdown.spec.ts:76` 的 opt-in 用例
（需 `WORKBENCH_E2E_CONFIG_SANDBOX=1` 指向隔离工作区），`e2e/README.md:32` 写明了它为什么
默认关闭。这是**明确允许清单**，不是静默 skip——TF-0252 的成功指标原文就是
「skipped=0 或有明确允许清单」。

## 3. 门禁自己抓到的第一个真问题：嵌套包的 E2E 现场

Playwright 第一次真跑完，`check:upload-surface` **立刻报红**：7 条 `useful-not-uploaded` ——
`apps/workbench-ui/test-results/` 下的截图、`trace.zip`、`error-context.md`、`.last-run.json`。

规则**其实存在**（`policy.json` 里那条 process-evidence），但它的 globs 是**根锚定**的：
`test-results/**` 匹配不到嵌套包里的同名目录。E2E 跑在 `apps/workbench-ui` 下，
所以第一个真实 Chromium 运行就把这条写窄了的规则照了出来。

| 项 | 内容 |
| --- | --- |
| 修法 | globs 补 `**/test-results/**`、`**/playwright-report/**`、`**/test-results-*/**` 变体 |
| 钉住 | `scripts/upload-surface/classify.test.mjs` 新增一条用例：嵌套包的 E2E 现场必须是 process-evidence（本地留） |
| 读数 | 分类器测试 **13 pass / 0 fail**（原 12）；门禁回到 **exit 0**（上传面 769 / 违规 0） |

**这条值得单独记下来**，因为它说明门禁不是装饰：它抓到的不是"文件忘了 ignore"，
而是"策略规则写对了、glob 写窄了"。而 ADR-0020 那一轮已经犯过一次同形状的错——
`docs/handoff/**` 一度编译成 `^docs/handoff$`，只匹配目录本身、不匹配目录里的文件
（`2026-09-25-upload-surface-round.md` §4.1 记过）。**同一个形状第二次出现**，
而且两次都是"门禁自己抓到的"——这正是它存在的理由。

## 4. TF-0255 还差什么

| 验收条 | 状态 |
| --- | --- |
| 1. 断言从共享 provider 能力数据推导 | ✅ 上一轮完成（`providers.ts` 单一来源） |
| 2. CI 在隔离 workspace 中运行浏览器 suite | ❌ **未做**：`.gitlab-ci.yml` 还没有 e2e job。现在能做的部分变多了——起后端 + Vite + Playwright 的**命令序列已在本机实测通过**，不再是"没人验证过的草稿"；剩下的是把它接进 JihuLab 流水线（需要 push 才能验证） |
| 3. 报告区分 passed/failed/skipped，缺前置数据 fail with reason | ✅ **本轮完成**（§2 的 RED/GREEN） |
| 4. 至少覆盖设置 / 草稿切换恢复 / 计划模式 / 窄屏布局 / Codex 选择持久化 | ⚠️ 前四项在默认运行里全覆盖；**Codex/provider 选择持久化**仍只在 opt-in 用例里，默认不跑 |

所以 **TF-0255 仍是 in_progress**，但阻塞它的东西从「本机跑不了浏览器」变成了
「CI 接线 + 把第 5 项纳入默认运行」——都是下一轮在无沙箱环境下可做的工程动作。

## 5. 这一轮没有做的事

| 没做 | 为什么 |
| --- | --- |
| **不 push / 不合并 / 不发版** | 落库是维护者的动作；`check-forest-landing` 现在给出的是 `drift` 读数，收口步骤见 [落库收口清单](2026-09-25-closeout-checklist.md) |
| **不顺手把 e2e 接进 CI** | 命令序列已验证，但 job 本身只有在 JihuLab 上跑过一次才算验证；本轮不 push，接进去也没人跑过它 |
| **不改 opt-in 用例为默认** | 它需要一个初始化成 `openai-responses` + `high` 的隔离工作区，属于"测试环境搭建"而非"断言修复"，单独一轮做更清楚 |
| **不重跑 TF-0269 的 OPEN-5 / OPEN-8** | 权限放开后"需要真子进程"这个理由**部分失效**了，但那两条真正要的是**一个真实 agent / claude 会话**。下一轮应先重新评估，而不是直接照旧标记为不可验证 |
| **不删 `test-results/`** | 它是 gitignored 的本机产物（ADR-0020 的 machine-state），是 RED 的证据 |

## 6. 森林

见 §6 的提案：

- **TF-0252**：追加本轮完整门禁读数；并写明 `TFD-b1b366c832`（"三套件在本机不可测量"）的
  前提**已被实测推翻**——按仓库"修正是新条目"的约定，这里记录取代，不重写旧记录。
- **TF-0255**：追加第 3 条的 RED/GREEN 与"还差 2 项"；保持 `in_progress`。
- **TF-0269**：追加一条"权限放开后理由变化"的说明（OPEN-5/OPEN-8 的阻塞从
  "不能创建子进程"变成"需要一个真实会话"），保持 `in_progress`。
- **TF-0268**：追加 §3 的 glob 缺陷（规则存在但写窄了、门禁自己抓到、补测试钉住）——
  它属于该节点建的门禁本身，不是新工作。

## 7. 复核命令

```bash
# 1) 三套件（本机现在能跑出有效读数）
bun run test:workbench && bun run test:workbench-ui && bun run test:context-rot
# 期望 1002 / 67 / 68，全 0 fail

# 2) 两个自建门禁
bun run check:upload-surface              # 期望 exit 0
node scripts/check-forest-landing.mjs     # 期望 exit 1（drift：15 commit / 43 代码文件）

# 3) 浏览器 E2E：GREEN
bun packages/workbench/src/index.ts ui --port 7700 --no-open &
bun run dev:ui &
cd apps/workbench-ui && bun run test:e2e   # 期望 13 passed / 1 skipped / 0 failed

# 4) 浏览器 E2E：RED（fail with reason）——把后端换到空工作区
mkdir /tmp/wb-e2e-empty && cd /tmp/wb-e2e-empty && bun <repo>/packages/workbench/src/index.ts init
bun <repo>/packages/workbench/src/index.ts ui --port 7700 --no-open   # 在这个 cwd 下
cd <repo>/apps/workbench-ui && bun run test:e2e
# 期望 2 failed（带"缺前置数据"理由）/ 11 passed / 1 skipped
```

**合并本分支前请把本轮读作「工程门通过（本机有效读数）」，而不是「产品已验收」。**
产品证据（真实 provider 写侧、真人使用、当前发布物）仍然为零。

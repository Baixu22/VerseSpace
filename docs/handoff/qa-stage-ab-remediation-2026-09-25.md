# 阶段 A+B 整改交接报告（2026-09-25）

> **双标签口径：工程门通过（仅限本地可执行范围）/ 产品证据不足。**
> 分支 `qa-stage-ab-remediation`（无斜杠），6 个 commit，**未 push、未打 tag、未发布**。
> 本报告不含任何用工程测试冒充真实浏览器、真实 provider 或真人数据的结论。
>
> **2026-09-26 引用订正**：本报告从 `docs/` 移入 `docs/handoff/`（入库位）时，正文里的 `../packages/`、`../apps/` 相对链接没有跟着改深度，24 条全部指向不存在的 `docs/packages/…`。现统一改为 `../../`，目标均已存在；正文其余内容一字未动。上传面门禁只检查「指向本机专用文档」，测不到这类断链——这是它的已知盲区，见 ADR-0023。

---

## 0. 结论摘要

本轮接力了一份**被中断的上一轮未提交中间态**（当时 `typecheck` 失败、6 个 TS2304），把它补完整，
并按 TF-0255 / 0256 / 0257 / 0258 / 0260 / 0261 逐个收口：

| 节点 | 结果 | 说明 |
| --- | --- | --- |
| TF-0256（F-04 写 API 严格 JSON） | ✅ 完成 | 共享严格解析器；4 条路由 malformed → 400 且无副作用，先红后绿 |
| TF-0257（F-05 资源损坏不冒充健康） | ✅ 完成 | 503 + 机器可读标记；manifest 损坏/文件缺失/fallback 测试，先红后绿 |
| TF-0258（F-07 测试分类） | ✅ 完成 | 路由单测标为 API contract test；三类报告写入 e2e/README |
| TF-0260（F-06 config 读取失败身份） | ✅ 完成 | 独立计数 + 一次性事件 + `/api/state` 容错；真实损坏 YAML 现场，先红后绿 |
| TF-0261（错误身份审计表 + schema） | ⚠️ 部分 | feedback 改 schema（先红后绿）；审计表覆盖本轮命名路径，**仓库级 sweep 未做完** |
| TF-0255（F-01 浏览器门禁 + provider 断言） | ⚠️ 部分 | 断言已从共享来源推导；**浏览器执行与 CI 接线被本机沙箱阻断** |

**工程门（本地可执行范围）通过；产品证据不足** —— 真实浏览器、真实 provider 写侧、当前发布物、
真人 fit 四类证据本轮均未推进。

---

## 1. 起点：接手的中间态

任务书声明的基线是「工作树仅有那份 docs 规划未跟踪」，实际有 3 个已修改受控文件 + 4 个未跟踪源码/测试，
且 `bun run typecheck` 失败。证据链（详见 git 历史与本报告 §3）：

- 森林子树建于 2026-09-25 01:08，源码改动 mtime 为 **02:58–03:09**，之后从未提交；
- `server.ts` 引入了 `reconcileStats`，但 15s 定时器仍是旧代码（引用已删除的 `reconcileFailures`），
  新写的 `runReconcileTick` 被导入却从未调用 —— **TF-0260 的修复只做了一半，且破坏编译**。

我的处置：**接管而不是重做**。继承的 chat-routes / assets 改动经复核自洽、保留；
server.ts 的断点补完；lint 格式修掉。接管前的完整证据留存在 git 之前的停止报告版本中（已被本文件取代）。

---

## 2. 本轮改了什么（按节点，file:line）

### TF-0256（F-04）— commit `13adf58`
- [chat-routes.ts:20-33](../../packages/workbench/src/ui/chat-routes.ts#L20-L33) 新增 `jsonObjectBody`：非法 JSON 或非对象 → 400。
- 收窄到四条路由：create [:45-49](../../packages/workbench/src/ui/chat-routes.ts#L45-L49)、
  switch [:129-137](../../packages/workbench/src/ui/chat-routes.ts#L129-L137)、
  resume-note/consume [:152-163](../../packages/workbench/src/ui/chat-routes.ts#L152-L163)、
  resume-card/shown [:169-179](../../packages/workbench/src/ui/chat-routes.ts#L169-L179)。
- `fork`/`resume-action` 有必填校验、`restore` 用 `safeParse`，**按规划不动**。
- 未知字段的明确行为是「忽略」而非 400（zod 风格的宽松对象）；这是有意的，但未单独断言。

### TF-0257（F-05）— commit `3276440`
- [assets.ts:52-62](../../packages/workbench/src/ui/assets.ts#L52-L62) 只有非 `ERR_MODULE_NOT_FOUND` 才报错（缺占位 manifest 是源码态正常情况）。
- [assets.ts:105-112](../../packages/workbench/src/ui/assets.ts#L105-L112) manifest 指向的文件消失 → miss，不再流空的 200。
- [server.ts:105-113](../../packages/workbench/src/ui/server.ts#L105-L113) fallback 改 **503** + `x-workbench-ui-assets: missing`。
  （该片段与 TF-0260 同在 server.ts，按 commit 归到 `de1bbf9`。）

### TF-0258（F-07）— commit `85b47c7`
- [server.test.ts:1-17](../../packages/workbench/src/ui/server.test.ts#L1-L17) 加分类头：这是 route contract，不是产品面；
  `describe` 改名 `ui server HTTP contract`。
- [dispatch-guard.test.ts:10-18](../../packages/workbench/src/scheduler/dispatch-guard.test.ts#L10-L18) 给 `dispatchHttp` 加契约说明。
- [e2e/README.md:3-19](../../apps/workbench-ui/e2e/README.md#L3-L19) 写明三类报告各自证明什么。**不改运行时行为。**

### TF-0260（F-06）— commit `de1bbf9`
- 新增 [reconcile-loop.ts](../../packages/workbench/src/ui/reconcile-loop.ts)：`configLoadFailures` / `lastConfigError` 独立身份、
  「错误文本变化才写一条 `config_load_failed`」、按显式 `DEFAULT_NOTICE_TOKEN_BUDGET=300` 继续 drain（**fail-open 且留证**）。
- [server.ts:131-138](../../packages/workbench/src/ui/server.ts#L131-L138) 定时器改为 `runReconcileTick`；
  [:24-36](../../packages/workbench/src/ui/server.ts#L24-L36) 允许测试注入 tick 间隔；
  [:78-82](../../packages/workbench/src/ui/server.ts#L78-L82) `/api/state` 暴露两个新字段。
- [state.ts:42-56](../../packages/workbench/src/ui/state.ts#L42-L56) 新增 `settle`：config / doctor 读取失败变成数据
  （[:125-134](../../packages/workbench/src/ui/state.ts#L125-L134) `configError` / `doctor.error`），
  而不是让整个 `/api/state` 500。
- [reconcile-loop.ts:86-97](../../packages/workbench/src/ui/reconcile-loop.ts#L86-L97) `config_load_failed` 事件写入失败不再让 tick reject
  （这是 RED 阶段暴露出来的真实缺口）。

### TF-0261 — commit `0bff98f`（部分）
- [workspace-routes.ts:20-26](../../packages/workbench/src/ui/workspace-routes.ts#L20-L26) 新增 `feedbackSchema`；
  [:92-107](../../packages/workbench/src/ui/workspace-routes.ts#L92-L107) 校验后再写事件。
  之前是 `payload: body` 原样落库 —— **任意 payload 直接写审计事实**。

### TF-0255（F-01）— commit `1fde1f7`（部分）
- 新增 [providers.ts](../../apps/workbench-ui/src/chat/providers.ts)：provider 表成为组件与 e2e 的单一来源，
  并带编译期守卫（新增 provider 而面板未提供 → 类型错误）。
- [settings-fields.tsx:4](../../apps/workbench-ui/src/components/chat/settings-fields.tsx#L4) 改为引用共享表。
- [dropdown.spec.ts:2](../../apps/workbench-ui/e2e/dropdown.spec.ts#L2)、
  [:35](../../apps/workbench-ui/e2e/dropdown.spec.ts#L35) 断言改为 `toHaveCount(PROVIDERS.length)`，不再写死 4（也不写死 5）。

---

## 3. 测试证据：先红后绿

| 修复 | RED（实跑） | GREEN（实跑） |
| --- | --- | --- |
| TF-0256 create 严格解析 | 还原旧 `.catch(() => ({}))` → `Expected: 400, Received: 200`，1 fail | 8 pass / 0 fail |
| TF-0257 fallback 503 | 还原 200 fallback → `Expected: 503, Received: 200`，1 fail | 8 pass / 0 fail |
| TF-0260 `/api/state` 容错 | 让 `settle` 重新抛出 → `BlackboardDataError: invalid YAML`，1 fail | 5 pass / 0 fail |
| TF-0260 append 守卫 | 由 RED 阶段的 `ENOENT ... events.jsonl.cursor` 暴露（清理与写入竞态） | 连续 3 次 5 pass / 0 fail |
| TF-0261 feedback schema | 还原旧 body → 3 fail，其中审计日志出现 `+ "evil": "payload"` | 3 pass / 0 fail |

新增测试文件：`chat-routes.test.ts`、`assets.test.ts`、`reconcile-loop.test.ts`（继承）、
`feedback-route.test.ts`（本轮）。

**本轮可有效执行的相关测试合计：20 pass / 0 fail / 0 skip（6 个文件，109 expect）。**
最后确认：`git diff HEAD` 为空，工作树与提交逐字节一致。

---

## 4. 验证闸读数（精确数字，区分有效/无效）

| 门禁 | 读数 | 有效性 |
| --- | --- | --- |
| `bun run typecheck` | **exit 0** | ✅ 有效 |
| `bun run lint` | **exit 0**，613 文件，无修复项 | ✅ 有效 |
| `bun run test:workbench` | 854 pass / **135 fail** / 989 tests / 154 files / **32.48s**，skipped=0 | ❌ **本沙箱下无效** |
| `bun run test:workbench-ui` | **启动即失败**：`spawn EPERM`（Vite `windowsSafeRealPathSync` → `exec`） | ❌ **无效**（0 个测试跑起来） |
| `bun run test:context-rot` | 53 pass / **15 fail** / 68 tests / 6 files / 0.958s | ❌ **本沙箱下无效** |
| 相关可执行测试（6 文件） | **20 pass / 0 fail** | ✅ 有效 |
| Playwright `test --list` | **14 tests in 2 files**，含改动后的 dropdown.spec.ts | ✅ 有效（只证明能加载） |
| Playwright 真实执行 | **Chromium 无法启动**：`EPERM uv_spawn chrome-headless-shell.exe` | ❌ 被阻断 |

### 4.1 「无效」是测量出来的，不是猜的

- 沙箱拒绝创建子进程：`EPERM: operation not permitted, uv_spawn 'git'`（`git/index.ts:41`）。
- 对 `test:workbench` 原始输出做 JUnit + 文本关联分析：168 个内联失败块中 **147 个**在错误上下文里
  带明确的 spawn 拒绝；其余 21 个全部是 chat 车道测试（同样驱动真实 CLI 子进程），未逐个归因。
- 继承的 diff 只碰 UI 文件，不可能影响 `spawnSupervised` / `runVerification` / worktree / verifier 套件。
- 我用 `danger-full-access` 重试过 `test:workbench` 两次（120s、420s），**均因无人批准而超时**，
  没有拿到有效读数。没有第三次重试。

**因此：135 / 15 个 fail 是环境噪声，不是回归；但也因此本机没有拿到「三套件全绿」的读数。**

---

## 5. TF-0261 错误身份审计表

四列：**错误是否可见 / 是否改变状态 / 是否可重试 / 是否产生事件**。

| 生产路径 | 是否可见 | 是否改变状态 | 是否可重试 | 是否产生事件 |
| --- | --- | --- | --- | --- |
| `reconcilePremises` 抛错（reconcile-loop.ts:50-58） | 是：console.error + `reconcileFailures` + `/api/state.reconcile.lastError` | 否：tick 继续 | 是：下一 tick | 否 |
| `config.load` 抛错（reconcile-loop.ts:64-87） | 是：console.error + `configLoadFailures` + `lastConfigError` + `/api/state` | **是（显式）**：改用 `DEFAULT_NOTICE_TOKEN_BUDGET=300` 继续 drain | 是：每 tick 重读 | **是**：`config_load_failed`，每个不同错误文本一条 |
| `config_load_failed` 事件写入失败（:86-97） | 是：console.error | 否 | 是：下一 tick（同错误文本不再重复写，已知取舍） | 否（写入本身失败） |
| `drainPremiseQueue` 抛错（:100-110） | 是：console.error + `reconcileFailures` + `lastError` | 否 | 是：下一 tick | 否 |
| `loadEmbeddedFiles` 导入失败（assets.ts:52-62） | 是：非 `ERR_MODULE_NOT_FOUND` 时 console.error（缺占位 manifest 是有意的静默） | 是：返回 `{}`，退化到 disk/none | 是：每次 resolve 重新 import | 否 |
| embedded manifest 目标文件消失（assets.ts:105-112） | 是：miss → 上层 503 + header | 否 | 是 | 否 |
| 无任何 UI 资源可服务（server.ts:105-113） | 是：503 + `x-workbench-ui-assets: missing` | 否 | 是 | 否 |
| `collectState` 的 config 读取失败（state.ts:42-56,125-134） | 是：`configError` + `reconcile.configLoadFailures` | 是：`config=null`（不假装有配置） | 是：每次请求重读 | 否 |
| doctor 失败（state.ts:126-128） | 是：`doctor.ok=false` + `doctor.error` | 否 | 是 | 否 |
| malformed / 非对象 body（chat-routes.ts:20-33） | 是：400 + JSON error | 否：短路，不写事件 | 是：客户端重发 | 否 |
| feedback schema 失败（workspace-routes.ts:92-101） | 是：400 + reason | 否 | 是 | 否 |
| `chat.reconcileRunningOnStartup()`（server.ts:45） | 是：无 catch，启动直接失败 | 否 | 是：重启 | 否 |

**未覆盖**：`git/` 的 never-throwing runner、`scheduler/`、`agents/`、`supervisor/` 等路径未在本轮逐条审计 ——
这是 TF-0261 的仓库级 sweep，尚未完成（见 §7）。

---

## 6. 刻意没做什么、为什么

| 没做 | 为什么 |
| --- | --- |
| **F-02 发布 / TF-0266**：`release:tag`、打 tag、CHANGELOG 定版、jihulab 快照 | 不可逆且需维护者拍板；本轮连版本号与 CHANGELOG 草稿也没准备，避免制造「已发布」假信号 |
| **F-03 Codex 写侧 / TF-0264** | 本机 codex 不在 PATH；是否接 seal 是维护者的产品决策（TF-0263），保持 `proposed` |
| **阶段 E / TF-0267（真人价值窗口）** | 常设外部门，工程动作不移动其判据 |
| **push 到 origin / jihulab** | 任务书禁止；分支与 commit 全部留在本地 |
| **任何破坏性 git** | 未用 `reset --hard` / `clean -f` / 强推 / 删分支；未改 git config |
| **改 `.gitlab-ci.yml` 接入 test:e2e** | 无法在本机验证流水线；按任务书「可草拟但注明未经流水线验证」，我选择**不草拟**，因为 CI 里的 Playwright 安装+后端启动需要真实 runner 验证，草稿会变成无人验证的假接线 |
| **给 TF-0255 补 UI 单测** | Vitest 在本沙箱下无法启动（`spawn EPERM`），写了也无法验证；宁可留缺口也不交付未验证的测试 |

---

## 7. 下一步与遗留风险

1. **TF-0255 的浏览器执行与 CI 接线仍未完成（主要缺口）**：
   断言已从共享来源推导且 spec 能被 Playwright 加载（14 tests listed），但
   **Chromium 无法在本 agent 沙箱启动**，`.gitlab-ci.yml` 未改。
   下一步：在无沙箱 shell 里 `cd apps/workbench-ui && bun run test:e2e`（需先起
   `bun packages/workbench/src/index.ts ui --port 7700 --no-open` 与 `bun run dev:ui`），
   然后把 test:e2e 接进 JihuLab 的隔离 workspace。
2. **TF-0255 的 skip 清理未做**：`ui.spec.ts:76`、`:161` 的条件 `test.skip` 仍在，
   「缺前置数据 fail with reason」与「Codex 选择持久化」两项未实现。
3. **TF-0261 的仓库级 sweep 未完成**：审计表只覆盖本轮命名与本轮触碰的路径；
   `git/`、`scheduler/`、`agents/`、`supervisor/` 未逐条审计。
4. **本机环境新 caveat（建议补进 AGENTS.md）**：本 agent 沙箱拒绝创建子进程，
   导致三套件与浏览器都无法产生有效读数。这与已知的「注入代理破坏 loopback」是**不同成因**，
   不要互相归因；`check-git-filesystem.ps1` 也因此不可判读（它报的 exit 1 是
   `git.exe Access is denied`，**不是**宿主损坏）。
5. **三套件未在本机取到全绿读数**：任何依赖「三套件全绿」的结论都必须先在无沙箱环境复跑。
6. **产品证据仍然为零**：真实浏览器、真实 provider 写侧、当前发布物、真人 fit 四类证据未变。

---

## 8. 森林收口

两次提案，均已 `proposal-apply --yes`：

| 提案 | 内容 |
| --- | --- |
| `TFP-qa-stage-ab-remediation-2026-09-25` | TF-0256/0257/0258/0260 → `done`（progress=1）+ 追加 evidence；3 条 deviation |
| `TFP-qa-stage-ab-landing-caveat-2026-09-25` | 1 条 deviation：done 只在本地分支、landing 不可测量 |

- **done**：TF-0256（evidence 6 条）、TF-0257（7 条）、TF-0258（5 条）、TF-0260（7 条）。
- **deviation（4 条，全部 open）**：
  1. TF-0255 — 断言已落地；浏览器执行 + CI 接线被沙箱阻断（`acceptance_unreachable_on_host`）。
  2. TF-0261 — feedback schema 已落地；审计表仅覆盖命名路径（`acceptance_partially_met`）。
  3. TF-0252 — 三套件在本机沙箱不可测量（`verification_gate_unmeasurable_on_host`）。
  4. TF-0252 + 4 个 done — done 只在 `qa-stage-ab-remediation`，main 仍停在 `45f0a9b`
     （`landing_branch_only_unverified`）。
- `validate` exit 0；`export` 写出 `.agent-workbench/task-forest/exports/task-forest.html`。
- **`check-landing` 未取到读数**：CLI 报 `WinError 5`（沙箱拒绝访问），
  `node scripts/check-forest-landing.mjs` 报「无法测量：spawnSync git EPERM」。
  **合并前请把这 4 个 done 读作「分支上完成」，而不是「已落库」** ——
  这正是森林已记录的盲区 `TFD-0dab4149f2`。
- 未新增计划节点、未重构森林结构；未改 TF-0263 / TF-0264 / TF-0266 / TF-0267 的状态。

---

## 9. 复核命令（无沙箱 shell）

```bash
git log --oneline -n 7                      # 期望看到 6 个本轮 commit
bun run typecheck                           # 期望 exit 0
bun run lint                                # 期望 exit 0
bun run test:workbench                      # 本机沙箱外应可全绿
bun run test:workbench-ui
bun run test:context-rot
cd apps/workbench-ui && bun run test:e2e    # 需先起 backend + vite
python C:/Users/27933/.claude/skills/task-forest/scripts/task_forest.py check-landing --workspace D:/helmor-main
node scripts/check-forest-landing.mjs       # 期望 exit 0；合并本分支后才会干净
```

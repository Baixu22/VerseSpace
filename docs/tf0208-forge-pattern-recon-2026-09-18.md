# TF-0208 侦察：forge 模式在主线里能落成什么

日期：2026-09-18
节点原文：`merge-guard 吸收 forge 模式：Resolution 预检枚举（Ready/Unavailable/Unauthenticated）+ merge 方式协商`
状态：**只做了侦察，未开工**（节点 `acceptance_criteria` 与 `requirements` 均为空，必须先定义"需要什么"）

---

## 0. 结论摘要

1. **功能层不可吸收，也不需要**：主线 `packages/workbench` 里 forge / GitHub / GitLab **零匹配**（3 个 grep 命中全是误报）。节点自己的 `non_goals` 已写死"创建 PR、修 CI、inbox"。
2. **"Resolution 预检枚举"可吸收 —— 但性质是"修主线已存在的缺陷"，不是"抄支线的模式"**。实测抓到两处真缺陷（§4），主线现在把 **"预检没有结论" 读成 "预检结论是无冲突"**。
3. **"merge 方式协商" 字面不可吸收**：主线**从不执行合并**（全仓 `git merge` 0 处，10 处 merge 提及全是 `merge-tree` 预测或注释）。没有"合并动作"就没有可协商的方式。只能取它的**模式**（先探能力、再选路）。
4. **节点标题有两处与实测不符**，建议按 §6 重新表述；但**不建议改 `estimated_total_minutes`（120）**，因为工作量确实小。
5. 探索文档第七部分第 4 问（编排器边界）**本节点不触发** —— 它不新增任何交付能力。

---

## 1. 支线 forge 的真实体量（先破除"要吸收 12535 行"的误读）

`src-tauri/src/forge/` = **33 个 .rs 文件 / 12,535 行**。但按"能不能吸收"切开：

| 组成 | 行数 | 判定 |
|---|---|---|
| `inbox.rs` × 2（GitHub/GitLab PR·issue 搜索） | 3,185 | **明确不吸收**（探索文档 §4.4 + 节点 non_goals） |
| `accounts.rs` × 3（多账号 / per-spawn TOKEN / 惰性登出） | 2,379 | **明确不吸收**（主线无远程身份） |
| `actions.rs`（CI 状态） | 941 | non_goals |
| `detect.rs`（六层 provider 探测链） | 470 | 明确不吸收（§4.4） |
| **`github/context.rs` + `gitlab/context.rs`** | **881（7%）** | **← 模式在这里** |
| 其余（api / remote / branch / types / workspace / avatar …） | ~4,679 | 功能支撑，不吸收 |

**结论：可吸收的模式占目录的 7%，且这 7% 里真正要抄的是"结构"而不是"代码"。**
若按目录体量估工作量会严重高估；按"结构"估则 120 分钟是合理的，甚至宽松。

---

## 2. 那个模式到底是什么（用读数说，不用形容词）

支线的结构，量出来的形状是：

| 文件 | 行数 | `Resolution::` 出现 | 早退（`return Ok(...Resolution)` / `bail`） |
|---|---|---|---|
| `github/context.rs`（构造者） | 464 | 16 | **5** |
| `github/mod.rs`（消费者） | 226 | 11 | **0** |
| `gitlab/context.rs`（构造者） | 417 | 16 | **5** |
| `gitlab/mod.rs`（消费者） | 397 | 11 | **0** |

读法：
- **5 个"为什么打不通"的判定**（没有 remote / 不是 GitHub 仓库 / 没有当前分支 / 未绑定账号 / 尚未初始化）**全部收敛进一个 resolver**；
- **4 个消费入口、11 个匹配臂、0 个早退** —— 消费者只做 `resolve → match → 映射成状态形状`，不做判断；
- 枚举每臂**自带原因**（`Unavailable(&'static str)` 携带说明），上层只负责把它搬进 `ForgeActionStatus`。

**这就是"把'为什么打不通'变成类型而非散布早返回"的字面含义。** 注意：枚举本身只有约 40 行。值钱的是**收敛与映射这个结构**，抄代码抄不到。

---

## 3. 逐项判定

### 3.1 Resolution 预检枚举 → **可吸收**，且主线已有真实缺口

主线的对应物 = `runtime/merge-guard.ts` 的 `MergePrediction`：

```ts
export interface MergePrediction {
  a: string;
  b: string;
  conflicting: string[];   // ← 空数组同时表示「确实无冲突」和「没拿到结论」
  error?: string;          // ← 自由文本，消费者只能 if (error !== undefined) 打印
}
```

对照支线的两条性质，主线各缺一条：
- **缺"结论"与"无结论"的区分**：`conflicting: []` 是二义的（§4）。
- **缺"返回值"**：`guardBeforeDispatch()` 返回 `Promise<void>`，结论只流向事件与通知，**没有任何调用方能拿到它**。

### 3.2 merge 方式协商 → **字面不可吸收**，只能取"能力探测"这一层

支线的 `AllowedMergeMethods::pick()`（`github/pull_request.rs:67-101`）逻辑是：
先查仓库允许哪些合并方式（merge / squash / rebase），再从**允许的集合**里挑，
避免 GitHub API 的 `mergeMethod` **默认 MERGE** 在"禁用 merge commit"的仓库上失败。

**主线没有对应物**：`packages/workbench/src` 全仓 `git merge` **0 处**。
10 处 merge 相关提及全部是 `merge-tree`（预测）或注释。**主线只预测合并，从不执行合并。**

所以：
- 方式三选一（MERGE/SQUASH/REBASE）→ **不吸收**（没有可协商的动作）；
- 模式内核"**不要假设默认参数可用，先问对方允许什么**" → **可吸收**，主线的对应物是 **`git merge-tree --write-tree` 的能力假设**（§4.2）。

---

## 4. 实测证据（本次最硬的产出）

方法：临时仓库夹具，直接跑真实 `git`，再把输出喂给**逐字移植的** `parseMergeTree`（`packages/workbench/src/runtime/merge-guard.ts:57`）。
环境：`git version 2.51.0.windows.1`。
可复算脚本：`.workbuddy/_probe_mergetree.py`、`.workbuddy/_probe_mergetree2.py`（`.workbuddy/` 已 ignore）。

### 4.1 主表

| 场景 | 真实 git 返回 | 主线 `predictConflicts` 的解读 | 判定 |
|---|---|---|---|
| 干净合并 | `code=0` | `conflicting=[]` | ✅ 正确 |
| 真冲突（改同一行） | `code=1`，stdout 第 2 段有路径 | `conflicting=['a.txt']` | ✅ 正确 |
| **ref 不存在** | **`code=1`，stdout 空，stderr=`merge-tree: nope - not something we can merge`** | **`conflicting=[]`** | ❌ **"没结论"被读成"干净"** |
| **零提交仓库 `HEAD HEAD`** | **`code=1`，stdout 空，stderr=`merge-tree: HEAD - not something we can merge`** | **`conflicting=[]`** | ❌ **同上，且生产路径可达** |
| 老式 `merge-tree a b`（无 `--write-tree`） | `code=1`，输出为 `mode oid stage\tpath` 三行 | **三行全被当作"冲突文件路径"** | ❌ **假阳性：把 git 对象哈希当文件名** |
| 非 git 仓库 | `code=128` | `error?:` 自由文本 | ✅ 但只是文本，不可分支 |
| 未知选项 | `code=129` | `error?:` 自由文本（含整段 usage） | ⚠️ 同上 |

### 4.2 两条缺陷的性质

**缺陷 A：`code=1` 承担了两种互斥语义。**
`git merge-tree` 的 `code=1` 既表示 **"他们冲突"（有结论）**，也表示 **"git 拒绝回答"（无结论）**。
主线在 `merge-guard.ts:175` 把 `0` 和 `1` 一起视为"是答案"：

```ts
if (result.code !== 0 && result.code !== 1) {  // 只有非 0/1 才算 git 出错
  return { a, b, conflicting: [], error: ... };
}
return { a, b, conflicting: parseMergeTree(result.stdout, result.code) };
```

于是 `code=1 + stdout=""` 走到 `parseMergeTree`，返回 `[]`，被解释为**"合并干净"**。
**这正是 merge-guard 文件头最自豪的那条不变量（`Zero false positives by construction`）的反面：这里产出的是一个"零冲突"的假承诺。**

**缺陷 B：能力假设没有出口。**
主线假设 `--write-tree` 一定可用。实测老式调用（git < 2.38 的行为，或将来有人改动参数）返回的三行
`100644 <oid> 1\tpath` 会被 `parseMergeTree` 逐行收成"冲突路径"，**把对象哈希当文件名报给用户**。
现实概率说明（不夸大）：`--write-tree` 需要 git ≥ 2.38（2022-10 发布），本机 2.51，**版本风险低**；
但**"没有能力探测"这个结构缺口是真的**，且它和缺陷 A 是同一种病：**没有"我答不了"这条出口**。

### 4.3 生产路径可达性（缺陷 A 不是理论问题）

`scheduler/merge-guard.ts:40-42`：

```ts
if (result?.ok) refs.add(`refs/heads/${branch}`);
else if (branch === incoming.branch) refs.add("HEAD");   // ← 分支还没建时用 HEAD
else await notify(`工位分支 ${branch} 不存在或无效，无法完成合并预检`, "warning");
```

- **首次派发**时分支尚未创建 → 走 `refs.add("HEAD")`；
- 而 `createWorktree` 的注释明确要求"仓库至少有一个 commit"——**零提交仓库是已知可出现的场景**；
- 该场景下 `git merge-tree HEAD HEAD` 实测返回 `code=1 + 空 stdout` → **主线报告"合并干净"**。
- 另有 TOCTOU 窗口：`rev-parse` 通过后、`merge-tree` 执行前，分支被删/改名（并发工位操作）→ 同样落到"干净"。

### 4.4 现有测试为什么没抓到

`runtime/merge-guard.test.ts:50-53`：

```ts
test("退出码非 0/1 是 git 出错，不是冲突", () => {
  // 调用方负责看 code；这里只保证不会把错误输出当成路径
  expect(parseMergeTree("fatal: not a valid ref\n", 128)).toEqual([]);
});
```

- 用的是 `code=**128**`，而实测真实 git 对无效 ref 返回 **`1`**；
- 用的是 `"fatal: not a valid ref"`，而实测真实 stderr 是 `merge-tree: <ref> - not something we can merge`（**且走 stderr，不走 stdout**）；
- **测试假造了一个现实中不存在的 `(code, stdout)` 组合**，真实组合（`1` + 空 stdout + stderr 有内容）因此无人覆盖。

这条测试的注释"调用方负责看 code"恰好说明设计意图——**但调用方 `predictConflicts` 看的正是 code，且在 `code=1` 时认为"这是冲突答案"**。

---

## 5. 建议的边界

### 做
1. **`MergePrediction` 的 `error?: string` → 封闭枚举**，每臂自带原因、可分支处理（对齐支线"把原因变成类型"）。
2. **让 `[]` 只表示"确实无冲突"**：引入显式的"无结论"状态，把 `code=1 + 空 stdout`、能力缺失、ref 失效区分开。
3. **能力探测**（对应 §3.2 的"协商"内核）：`--write-tree` 不可用时明说不可用，**不解析输出**。
4. **`guardBeforeDispatch` 返回结论**（现为 `Promise<void>`），使 dispatch 能据此决定是否投裁决卡（现在是每对冲突/重叠都无条件投）。
5. 修 `merge-guard.test.ts:50` 那条**与真实 git 行为不符的 fixture**（改为真实组合）。

### 不做
- 不新增入口点、命令、UI 面（无真实消费者的层不建）
- 不碰 PR / CI / inbox / 多账号 / provider 探测链
- 不引入远程身份或凭据概念（主线没有，硬造一个 `Unauthenticated` 对应物是编造）
- 不真合并、不做语义合并（沿用主线既有 non-goals）

### 三臂映射的诚实结论
支线四臂 `Ready / Initializing / Unavailable / Unauthenticated`（**节点标题漏写了 `Initializing`**）中：
- `Ready` → 主线"有结论" ✅ 有对应
- `Unavailable(reason)` → 主线"能力/输入不可用" ✅ 有对应（即缺陷 A/B）
- `Initializing` → 主线有同类概念（workspot `initializing`、两阶段派发）⚠️ **但不在 merge-guard 这条链上**
- `Unauthenticated` → **主线无对应物**，不应硬造

**所以本地化后的枚举不是三臂照搬，而是按主线真实成因重新划分**（有结论 / 环境不支持 / 输入失效 / 部分对未完成）。

---

## 6. 节点表述建议

| 项 | 现状 | 建议 |
|---|---|---|
| title | `merge-guard 吸收 forge 模式：Resolution 预检枚举（Ready/Unavailable/Unauthenticated）+ merge 方式协商` | 去掉 `Unauthenticated`、把"merge 方式协商"改为"预检能力探测"，并说明真实性质是**修结论表达**：`merge-guard 预检结论封闭化：区分「有结论/无结论」，补 merge-tree 能力探测` |
| acceptance_criteria | 空 | 取 §5 的 1–5 转成可验证断言 |
| non_goals | `创建 PR、修 CI、inbox` | 保留，并补 `不真合并`、`不引入远程身份` |
| est. minutes | 120 | **不改**（工作量与估时相符） |

> 一条来自本次的判据：**节点标题是当初的猜测，不是判据**。标题与实测冲突时，改标题，别改证据。

---

## 7. 从本案例看"Helmor 吸收该怎么进行"（方法论）

本次侦察给探索文档 §4.3 那条准则（"模式该吸收，功能不该吸收"）补了五条可操作的做法：

1. **先切开目录体量再估工作**：forge 12,535 行里可吸收的只有 881 行（7%）。"吸收某模块"的工作量应由**结构**估，不该由目录行数估。
2. **模式的载体是调用方的形态，不是被调用的代码**：枚举本体约 40 行；值钱的是"5 处早退 → 1 个 resolver → 4 个入口 0 早退"。**要抄的是这个结构，代码本身抄不来。**
3. **落地前先问"主线有那个被管理的对象吗"**：`merge 方式协商` 管理的是"远程仓库允许的合并方式"，主线**没有远程仓库、也没有合并动作**，模式因此落空。这一步问不问，决定了会不会做出一个空的抽象。
4. **抄之前先给主线做对照实验**：只读代码会得出"主线没问题"（注释写着 zero false positives）。**实测才暴露 `code=1` 的二义**。很可能你要抄的模式，正好是主线已有的缺陷——**这时任务是"修 bug"，不是"移植"。**
5. **模式落地时按主线的真实成因重新划分枚举，不要照搬支线的臂**：支线四臂里有一臂（`Unauthenticated`）主线没有对应物，硬造就是编造。

---

## 8. 未决

- **编排器边界**（探索文档第七部分第 4 问）：本节点不需要回答 —— 它不新增交付能力，只把已有预测层的结论表达改好。若将来要做 PR/CI，那个问题才必须答。
- **是否要把 TF-0208 的落点从 "merge-guard" 扩到 doctor / tribunal**：目前只找到 merge-guard 这一处真实消费链（`guardBeforeDispatch` → notify → tribunal envelope）。`doctor` 侧暂无"合并预检能不能做"的体检项，**不建议为它造需求**。

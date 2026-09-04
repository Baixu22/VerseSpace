# D2 · Q1 统一抽象:三支柱是一层还是三视图?

## 判断

**可以统一,但统一的对象是"日志"而不是"语义"。** 精确表述:一条 append-only 日志、一个 `seq` 因果钟、**两类事实**(世界事实 / 会话事实)、**三个投影**(前提失效、决策拓扑、DOI 显著性)。三个投影可以都从同一条流折叠出来,前提是遵守一个方向性不变量:**世界投影只折叠世界事件;会话事件可以引用世界事件,世界事件永不引用会话事件。** 这条不变量就是 TF-0118 的新家——"a thread is not a lane"从存储边界变成投影过滤器。

为什么不是"三视图各自一套流":因为三支柱合流点(H1/H2/H5)全部是跨界 join(线程读集 × 世界写者;离开笔记 × 仓库漂移;分支写集 × 源线程前提)。join 需要同一个因果钟。现有 footprint 双写("two stores, one truth")已经承认了这一点——只是 fork/leave/restore 三个断层没跟上。

为什么不是"一层":因为两类事实的**非单调性所在位置不同**。世界事实的非单调性在"状态"(前提是否成立、构建是否绿)——R3 已把它交给 Verifier;会话事实的非单调性在"注意力"(DOI 随时间衰减、分支被放弃)。两者都可以通过"事件只记观测、状态只在投影"化为单调日志,但它们的**衰减函数不同**(前提:随世界变化;DOI:随时间与生命周期),不能共用一个投影。

## 单调性判据

每个字段过一遍:"后到的事实会推翻它吗?"
- 会推翻 ⇒ 它是**状态**,禁止入事件,只能在投影里算。
- 不会推翻 ⇒ 它是**观测**,可以入事件。

这与 R3 是同一句话:"agent 自称完成"是状态声明,不是观测;Verifier 的 exit code 是观测。

## 统一事件原语(最小 schema,【你的假设】,字段名为提案)

```yaml
seq: 4711                 # 行号 = 因果钟。单调:构造上不可变
ts: "2026-09-03T14:02:11Z" # 追加时刻,仅供展示。单调:是(记的是追加时刻,不是事实时刻)
source: sessions          # 现有域集合 + 新增 sessions/git;闭合枚举。单调:是
kind: thread.forked       # source 内闭合枚举。单调:是
actor:                    # 谁产生了这次观测
  type: thread | workspot | human | external | system | verifier
  id: "t-8f2a"
subject:                  # 观测关于什么;能内容寻址的必须内容寻址
  - {type: path, path: "src/auth.ts", hash: "…", span: [40, 88]}
  - {type: thread, id: "t-8f2a", at_message: "m-…"}
refs: [4102, 4690]        # 因果引用,只能指向更小的 seq。单调:是(不变量 refs[i] < seq)
evidence:                 # 只放哈希 / exit code / 计数 —— 可机器复核的量
  hash: "…"
payload: {…}              # kind 专属;禁止任何"状态"字段(见下表)
about_ts: "…"             # 仅回填事件携带:事实发生的原时刻;排序永远只看 seq
```

**schema 级 R3 强制**:`source: sessions` 与 `actor.type: thread` 的事件,payload 中不允许出现 `status`、`done`、`verified`、`passed` 一类字段——不是靠约定,是靠校验。只有 `source: tribunal|runtime` 且 `actor.type: verifier` 的事件能携带 `verdict`。这样统一日志不会让"线程说测试过了"混成"完成"。

## 一等事件:fork / leave / restore / merge-back(及配套)

| kind | actor | payload(全部为观测) | 单调性检查 | 撤销形态(R12) |
| --- | --- | --- | --- | --- |
| `thread.forked` | human | `{child, parent, at_message, declaration: ForkDeclaration 字面量}` | 分叉发生过——永真 | 无需撤(子线程可归档,归档是另一个事件) |
| `footprint.inherited` | thread(child) | `{refs: [父线程 ≤ at_message 的 footprint seq 列表]}`,不复制内容 | "子线程的上下文包含这些读/写"——永真;**前提条件**:子 agent 确实继承了模型上下文(D0 盲区) | 无需撤 |
| `thread.left` | system | `{thread, last_seq_seen, note: {beats: [{kind, text, evidence: {hash|ref}}], note_hash}}` | "离开时刻起草器输出了这些"——永真;笔记是否**仍真**是投影问题(H2) | 无需撤 |
| `thread.restored` | system | `{thread, mode: conversation|code|both, since_seq, observed: {stale_premise_refs: [...], new_event_count}}` | 返回时刻的观测——永真 | 无需撤 |
| `thread.parked` | human | `{thread, snapshot_ref: 文件路径+hash}` | 永真;**同时修复 T7**(停放快照落盘) | 无需撤 |
| `thread.merged_back` | system(由 restore 触发)或 human | `{from: child, into: parent, level: pointer|summary, facts: {ledger_diff_refs, generated_refs, iface_delta_refs, merge_guard_ref, verifier_ref|null}}` | 回注事件发生过——永真;**facts 全是 refs**,不含叙事 | `thread.merge_back_dismissed {refs:[merged_back seq]}`——一次手势;渲染层隐藏,日志不删 |
| `thread.adopted` | human | `{thread: child, supersedes: parent}` | "以分支为主线"——永真 | `thread.adoption_reverted` |
| `seal.decided` | system | `{tool_call, result: pass|blocked, drift_refs}` | 永真;**T6 的边界从此有审计**(现状:封印不持久化) | 无需撤 |
| `promote.signal` | git-watcher / verifier | `{kind: commit|repeated_test_failure, refs}` | 永真;**T4 的生产者**(现状:形状已定义无生产者) | 无需撤 |
| `variant.generated` / `variant.promoted` | system / signal | 现有扇出与晋升 | 永真 | `variant.promotion_reverted` |
| `footprint.*`, `premise_stale`, `iface.drift`, `merge_guard.*`, `tribunal.*` | 现有 | 不动 | 已是观测 | — |

**撤销即事件**:一切 undo 追加一条 `*_dismissed/_reverted` 事件并引用原事件。日志永不删行(seq = 行号,删行即毁钟)。这与"撤销作负样本:误报率 0%,暴露 92% 严重问题"【文献引用】直接接轨——负样本是免费的。

## 不变量清单

| # | 不变量 | 保护什么 |
| --- | --- | --- |
| I1 | 事件只记观测;任何"当前是否…"只能是投影 | CALM/R3;merge 时永不需要冲突解决 |
| I2 | `refs[i] < seq`;排序只看 `seq`,永不看 `ts`/`about_ts` | 因果钟完整 |
| I3 | 世界投影(前提、merge-guard、CAS、WIP、tribunal)只折叠 `source ∈ {runtime, scheduler, agents, tribunal, premise, git}` 的事件 | TF-0118;R10(调度永不看线程拓扑) |
| I4 | 会话事件可 `refs` 世界事件;世界事件的 `refs` 永不指向 `source: sessions` | 方向性;防止"线程说了什么"渗入世界真相 |
| I5 | `source: sessions` 事件 payload 无完成/状态类字段(schema 校验) | R3 |
| I6 | 事件 payload 不含消息正文,只含 hash/ref;正文留在 chat 私有 messages.jsonl | R1 防火墙:世界日志里没有任何文本可供"识别结构" |
| I7 | 每条会渲染给人的事实必须有 `refs` 或 `evidence`;无证据不渲染 | R9;InkSync"验证界面胜过探索界面" |
| I8 | 撤销是追加事件,不是删行 | R12 + 负样本 |
| I9 | 投影是纯函数 `fold(log, now)`;`meta.forkOf`/`meta.forks` 等派生缓存可随时由日志重建 | R11(零数据库:日志即真相,缓存可丢) |

## 与 TF-0118("a thread is not a lane")的关系

TF-0118 在现状里是**存储层的排除**(chat 足迹记但不计入车道计量)。统一后它变成 I3:WIP/CONWIP/tribunal 投影的**过滤条件**。三点后果:
1. 线程仍不消耗 CONWIP 令牌、不进裁决队列——调度语义一字未变。
2. 线程作为**写者**(R1 写者登记)与**读者**(R2 前提)的身份不变——那本来就是世界投影里的 `actor.type: thread` 的 footprint 事件,不是会话事件。
3. 新增的会话事件(fork/leave/restore/merge-back)对世界投影**不可见**。H1 因此必须用 `footprint.inherited`(世界事件)实现,而不是让 premises.ts 去读 `thread.forked`——否则 I4 破,前提投影开始依赖对话拓扑,就是编排器的第一步(R10)。

## 能否同时表达全部已建行为(对照)

| 已建行为 | 事件表达 |
| --- | --- |
| 追溯式分叉、源线程逐字节不动 | `thread.forked`;源线程 messages.jsonl 无写 |
| ForkDeclaration 字面量 `true` 编译期锁死 | 进 payload.declaration;schema 校验同值 |
| 恢复笔记 3–5 拍 + 离开签名 + "你不在时多了 N 条" | `thread.left.note` + `thread.restored.observed.new_event_count` |
| 切换清场 / 停放 | `thread.parked{snapshot_ref}`(顺手落盘,T7) |
| 扇出 generate-N-show-1 + 信号晋升 + 安静账本 | `variant.*`;账本 = 对 `variant.promoted`/`suggestion.*` 的投影 |
| 前提三层判定 + 投递 + 轮间注入 | `premise_stale`(现有)+ 投递可记 `delivery.sent{refs}`(便于 D4 洪泛检测) |
| 封印点 | `seal.decided`(新增记录,行为不变) |
| merge-guard 预测 + 重叠账本 | 现有;merge-back 用 `refs` 引用 |
| WIP L=λW、CONWIP、tribunal | 投影;I3 过滤 |
| DOI(零消费) | `interactions.*`(现有 6 字段模型——需要补充字段)折叠;衰减在投影里用 `now` 算 |

R4:无事件阻断任何人(seal 除外,且现在可审计)。R7:全部追加;渲染层"无分歧不渲染"由投影决定。

## 迁移路径(R11:不引入数据库)

1. **加 kind,不改行**:events.jsonl 追加新 `source: sessions` 事件;旧读者遇未知 kind 跳过(需要补充:现有读者是否对未知 kind 抛错)。
2. **回填**:脚本遍历线程 `meta.forkOf` → 追加 `thread.forked{about_ts, backfilled: true}`。新 seq、旧事实,I2 不破。
3. **fork 处理器**:一次 POST 追加 `thread.forked` + `footprint.inherited`——**在此之前先验证 D0 盲区**(子 agent 是否继承上下文);若不继承,`footprint.inherited` 是谎言,不能写。
4. **离开/返回处理器**:在现有起草与计数处各追加一条事件。
5. **投影**:`tree = fold(thread.*)`;`premise` 不变,只加 `refs` 展开;`doi = fold(interactions.*, now)`。
6. **`meta.forkOf` 保留为缓存**,文档标注"可由日志重建"(I9)。
7. **未做的**:不压缩日志(seq = 行号,压缩即毁钟;若体量成问题走 epoch 文件,见 D4 失败 8)。

需要补充:events.jsonl 的多进程追加互斥机制(chat HTTP 层、watcher、CLI 同时写)——现状已双写,机制应已存在,新事件复用即可。

## 不能统一的东西(精确边界)

- **两个衰减函数**:前提投影按世界变化失效;DOI 投影按时间/生命周期衰减(Mylyn 常数"对任务生命周期盲"是投影参数问题,不是日志问题)。共用日志,不共用投影。
- **两个通知预算**:tribunal(ISA-18.2,5/15/30/50)与 chat 投递(现无队列,T5)必须各有预算;统一日志不等于统一队列(D4 失败 3)。
- **文本**:永不进 events.jsonl(I6)。恢复笔记若含文本拍,只有 `evidence` 与 `note_hash` 进日志,正文留会话侧。

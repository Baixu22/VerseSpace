# Fable 5.1 Briefing · Part 1 附录 — 机器层深查、能力地图与定位演进(第二轮,2026-09-02)

> 定位:补充 01,不替代。与 01 一起构成可缓存前缀。所有事实来自本轮对未精读模块的逐文件清查(runtime/tribunal/scheduler/verifier/automaton/rot/doctor/contextgen/agents/supervisor/blackboard/CLI/GUI/e2e/遗留文档/git log)。
> 对 01 的两处**修正**:①"三条事件流"精确化为**两条流 + 一个派生源**(§2);②"机器层有未接线部分"修正为**零未接线**(§3)。

---

## 1. 机器层全景(每格都通了电)

| 模块 | 一句话 | 关键不变量/设计引用 |
| --- | --- | --- |
| runtime/index.ts | runOnce 组合器:锁→快照→评估→施加→重锚→调度→裁决过期 | 四不变量:exclusive(pid 锁,竞争报 busy 不许竞速)/ idempotent / re-entrant(只对入口快照判定)/ observable |
| runtime/seal.ts (TF-0078) | **全系统唯一允许打断写者的点**:Claude PreToolUse hook,写进已知漂移区域则 exit 2 + 证据进 stderr | "这不是打断——基于已失效的前提写下去,事后返工的代价远高于现在停一下";封印**不持久化**,hook 时从当前 stale 声明重算 |
| runtime/surface.ts (TF-0076) | 导出面哈希(Gradle 编译规避同款);刻意**不用 tree-sitter** | "一个投影 bug 意味着 ~1000 倍过通知,通道第一天就死"——拿不准就返回 null(当作变了) |
| runtime/rollback.ts (TF-0098) | 廉价可逆的主安全网;代码(git checkout)与上下文(blackboard KV)两条回退分开 | "三个动作必须是三个有明确标签的不同动作(Cursor 最持久的投诉)";"没有快照就明确拒绝,不假装回退" |
| runtime/durability.ts (TF-0074) | 耐久分层:node_modules/vendor/dist 不可推翻任何人前提,只有 volatile(源码)进前提检查 | 纯精度收益、零召回损失、O(1) |
| runtime/premises.ts (R2) | 三层判定:耐久层→span 重定位(git diff hunk)→导出面;跨进程去重 | "往精度错,不往召回错";"沉默是这里最贵的错误" |
| tribunal/ (R3) | ISA-18.2 裁决队列:五道定性门(异常/后果/可行动/相关/唯一)+ 5/15/30/50 目标分布 + NEWS2 三红(auth/force-push/secret 直升 critical) | 洪泛窗口 10 条/10min,速率 6/h;FLOOD_LIMIT 注释:"人类容量 ~1 条/10 分钟持续,~12/小时封顶";**无推送通道**(pull-only,CLI 尾部+GUI) |
| scheduler/ | tick 纯函数(manual/semi-auto/auto 三策略)+ dispatch(CONWIP 准入在创建任何东西**之前**——拒绝不留半成品 worktree) | maxConcurrentWorkspots(默认 2)是 auto 配对上限;CONWIP 是独立派生准入,两者都须过 |
| verifier/ | checkpoint 验证器,在 worktree 内跑 test/type-check/build,按 exit code 判定 | 输出封顶(档案 2 万字/缓冲 1MB)防喷涌进程;**没有"封印区"概念**(封印只在 seal.ts) |
| automaton/ | goal/workspot/checkpoint 三个纯函数状态机,无 IO、确定性、幂等 | "依赖只被 done 满足;stale_done/cancelled 刻意阻断下游(锚坏了,衍生品作废),浮出为告警而非静默就绪" |
| rot/ (TF-0104) | context-rot doctor:扫 CLAUDE.md/AGENTS.md/.cursorrules 里的路径引用,数多少已失效 | "这是获客钩子,不是护城河"——`npx @baixu22/workbench doctor` 对任意 checkout 出一个数字(npm 包 TF-0119 的卖点) |
| doctor/ | 两个医生共用一个命令:rot(无 .workbench 也可跑)+ 黑板一致性巡检(17 种 check,只报告不修复) | "acquisition hook first, and the blackboard consistency sweep second" |
| contextgen/ | 按 workspot.contextNeeds 编译 `.agent-context.md`(决策/接口/事件/冲突;空段整体省略) | 数据层生成,不推断——"empty sections are omitted entirely so the agent never sees placeholder noise" |
| agents/runner.ts | headless 批跑:crash-loop 熔断(60s 内 3 次异常退出)+ 车道困境检测(连续失败/工具膨胀>0.4/缓存命中率骤降→evict/禁压缩)+ 足迹第二条采集通道 | 挂起时建议:"从文件系统笔记 + git diff 重播种后再派发" |
| agents/usage.ts | 每轮 UsageSample(绝对 token/缓存命中/压缩次数)——**拒绝百分比** | "竞品全员显示 73% 已用——那告诉你离墙多近,却不说墙是什么做的" |
| supervisor/ | 一切 agent 相关 spawn 的唯一通道:argv 数组/树杀/pid 注册表(重启后收割孤儿)/crash 熔断/stdin 门控(Windows cmd shim 吞首写的解法) | "killing the direct child alone orphans cmd.exe shims" |
| blackboard/ | 全部状态唯一通道;文件即实体(goals/decisions/tribunal/queue/metrics 各一 YAML;会话=footprint.jsonl+spool;checkpoints 三区) | "Two stores, one truth":footprint.jsonl 原始活动 + 同步投影进 events.jsonl(PROV 形),跨写者视图=对单一日志的 fold |

## 2. 事件流真相(精确版)

存在**两条物理流 + 一条刻意冗余**:
1. `.workbench/events/events.jsonl` —— 唯一共享日志(seq=行号,即因果时钟)。source 域已含:runtime/scheduler/agents/tribunal/sessions(footprint)/interactions/premise/restore。
2. `.workbench/threads/<id>/messages.jsonl`(+ meta.json + notices.jsonl)—— chat 私有,只在 `premise_notice_delivered` 时向 events.jsonl 发一条。
3. `sessions/<writer>/footprint.jsonl` —— 写者原始活动,**刻意**双写进 1("two stores, one truth")。

**correction**:interactions(L1)不是独立文件——它是由足迹**派生**的 `source:"interactions"` 事件,与 footprint 共用同一 seq 时钟(sessions.recordActivity 里派生,注释:"L1 (TF-0087): 与足迹共用同一条 events.jsonl 与同一个 seq 时钟")。

**确认**:fork/leave/restore/reload **没有任何一等事件类型**(0 处);fork 只动 `meta.forks` 与 `forkOf`,messages.jsonl "一个字节不动";唯一相邻的是 checkpoint 回滚的 `restore/undo` 事件。

## 3. 接线状态(本轮清查的核心结论)

- **机器层零未接线**:runtime/tribunal/scheduler/verifier/automaton/rot/doctor/contextgen/agents/supervisor/blackboard 每个都有 CLI 命令、runtime 周期或 UI 端点到达。
- **唯二"形状已定义、无生产者"**:promote 的 `repeated-test-failure` 与 `commit` 两个晋升信号("由足迹侧喂入,本层只定义形状")。
- **DOI 层是零下游消费者的纯库**:`computeDoi`/`projectLandmarks` 在 interactions/ 目录之外**无任何 import**——无 CLI 命令、无 server 路由、无 GUI 组件。事件在记(机器侧自动记),但没有任何东西读。
- **人类交互信号不存在**:types.ts 原话"人类侧:未来由前端交互层(v6)直接上报";GUI 零上报;watcher 把人肉文件编辑记为 origin:"human" 的 edit 事件(最接近的替代)。
- **TF-0118 刻意边界**:metrics.ts 拒绝把 chat 线程当车道("a thread is not a lane——metering it here would mix non-lane keys")。chat 的用量/足迹在记,但不进车道体系。

## 4. 能力地图:CLI 与 GUI 各自能/不能

**CLI(37 条命令,`--json` 全局)**:goal/decision/interface/sessions/premises(pending+seal)/tribunal(list/show/shelve/resolve/stats)/wip/metrics/ws/checkpoint(含 restore 的 `--code|--context|--both` 三标签互斥)/dispatch/queue/status/map/log/sync/watch/doctor/ui/config。**没有任何 tree/fork/thread 命令**——chat 整个活在 ui server 的 HTTP 面(`/api/chat/threads[/:id][/messages|cancel|reload|promote|fork|leave|resume-note]`)。

**GUI(web,暗色优先,嵌入二进制)**:有——每条消息 hover 出"分叉"(零仪式)、备选只读面板("没有任何选择界面")、恢复笔记条、决策账本、停放条、建议条、plan 批准卡、fork 8 秒通知条。**没有**——DOI/地标任何 UI;树视图(服务器返回平铺列表,`forks` 计数从未被渲染,`promote` 端点 GUI 从不调用);variants 不可选;BranchPicker 是死 UI;**drafts/parked 是客户端 zustand 态,不持久化**(切浏览器即丢);用户消息不可编辑;无登录界面(每次运行随机 token 握手)。

## 5. 定位演进史(v1→v6:承诺了什么、扔了什么)

| 版本 | 命题 | 结局 |
| --- | --- | --- |
| v1 | "任务制赢过会话制" | 被用户与自查驳回("总成本账只算监督税,忽略设计时税;为 5% 场景设计却声称普适") |
| v2 | 半修正 | 过渡 |
| v3(已接受) | **任务主权层**:"对话即引擎,任务即身份证,治理即副产品";"Claude Code 卖引擎,Workbench 卖任务身份证+行驶记录仪+登记系统";"我们做对话的户籍系统" | 现行骨架 |
| v4 | 并发安全层("任务即事务,运行时即并发控制器";扇出公式 FO=(NT+IT)/IT) | **已被取代**(v5 推翻"两个 agent"框架) |
| v5(提案,运行时定调) | **前提守护者**:"N=1 个 agent,N≥2 个写者"(写者=编辑器/git pull/CI/过去的自己);"主要对手是时间,不是另一个 agent";三层阶梯(免协调→通知→裁决);"产品必须可证明地不是编排器" | R1–R4 按此实施 |
| v6(提案,交互层) | **交互层**:"对话是输入面。执行是结构的来源。仓库是结构的裁判。用户永远不画图" | L1/L2 已建,L3 未动 |

**跨版本不变的核**:对话不可推翻;不做 a2a/multi-agent 协议;不做手动 DAG;结构不许有前置成本。
**被扔掉的**:tasks-beat-sessions、分级告警、阻断式并发、编排叙事、四提供商广度(收敛到 claude CLI)、塔台 GUI 作为第一界面(降为可选视图;v0.3.0 的 "workspot lanes" 是车道隐喻的残留)。

## 6. 遗产与身份断裂(展望的背景板)

- **Legacy Helmor 对用户的承诺**(docs/user/,仍在服役):"**agents are fast, you are the bottleneck**";fan out/rotate/ship 三拍;侧栏=控制塔;状态车道(kanban);stacked PRs;"In practice the limit is your review bandwidth, not the machine. A good starting shape: two or three substantive tasks."
- **仓库根 README 仍在卖这个旧愿景**(orchestrating coding agents/one button ship/mobile companion),与 Workbench 定位(非编排器)是**两套身份**。退役决策挂在 TF-0055(proposed)。
- **v6 §8 的"明确不做"清单**(每条带证据,是现成的反约束):画布/空间界面(零留存胜利;Kosmik 8 年后关停)、结构识别器(Ink & Switch 三次后"总体怀疑能否可靠")、让用户命名/分类分叉(Aquanet:人靠位置和复制,从不靠有类型链接)、每周回顾摘要("人们很少回头";GTD 零实证)、自动任务边界检测(Bardram 退回人工信号)、要求先声明任务、DAG 编辑器、生成式 UI(50.8% 胜/41.1% 负,掷硬币)。

## 7. v6 精华直引(模糊问题簇的证据底座)

- **C2**:破坏性自适应 15:1 惹恼比;"准确率是错的轴,破坏性才是";纯加法式在 79% 准确率时快于静态。
- **C3**:GPT-5 自动路由 7%→24%——"3 倍差距纯由'要求选一次'造成";反向:系统主动自适应输给用户可控的"可适配"。
- **C4**:"一个 28% 错误的产物带来了可测量的生产率提升,因为没有任何东西依赖它正确,也没有人需要批准它"(Mylyn,唯一带 p 值的胜利:p=0.003,84.17% 选择落在正 DOI 元素)。
- **C5/L3 杀手证据**:规格挖掘 90–99% 误报;LLM 解冲突与开发者一致率 55–59%;ALLOY 推导结构输给手写(9/12 vs 10/12),只赢认知负荷;METR 慢 19% 自觉快 20%;**Letta 纯文件系统 74.0% 打败 Mem0 结构化抽取 68.5%——"抽取销毁了信息"**。
- **L3 四条件**:N=2 才推导(两条轨迹的差=泛化本身,"把推断问题变成集合运算");重放验证不用阅读验证(验证成本 O(所有未来输入)→O(1));泛化逐字面量可拒绝(`{{feature_branch}}`);保留轨迹、产物只是有损索引("产物错了就回退到证据,而不是调试一份摘要")。
- **v6 §10 的诚实**:"从对话追溯出结构,几乎没有实证文献……若要建 L3,你是走在证据前面。这是本文档中风险最高的一层,也是最该最后建、最容易砍掉的一层。"
- **L1 DOI 公式**:interest 累加 − 自上次触碰衰减;**重置技巧**(衰减到负的元素一碰即正,不必从 −N 爬回);DOI>0 可见、>10 地标;生命周期自适应常数(年轻=慢衰减宽搜索,成熟=快衰减窄搜索——修 Mylyn"对任务生命周期盲"的洞);父级指数传播。**已实现于 doi.ts,常数与公式一致。**
- **恢复/离开的证据**(§7 机制表):Leroy & Glomb(离开时起草降低注意力残留,且自动线索组成功率是自记组两倍);TaskSnap(清场占一半效果:4.81 vs 6.10 分钟,无关产物 1.21 vs 20.28);挂起工作"仅仅看得见就是起作用的提醒"(可见度 <25% 返回时间显著更长);InkSync(验证界面胜过探索界面:错误编辑 −44%,审计抓 73%);撤销作负样本(误报率 0%,暴露 92% 严重问题)。

## 8. 环境与杂项

- e2e/ 是 legacy Tauri 应用的 Playwright(WebKit,IME/侧栏/流式叠压),**workbench-ui 无 e2e**。
- `worktrees/ws-s0/` 是 workbench 自己创建的真实 git worktree(含生成的 .agent-context.md)——自举的实物证据。
- `.workbuddy/`、`.agent-kernel/` 是外部 AI 助手在此仓库留下的运行态记忆/checkpoint(gitignore 已加);与产品无关但解释了仓库里的多 agent 痕迹。
- `measure-ask-costs.ts`/`measure-bc.ts` 是 ADR-0009 的实证来源;后者内嵌本机 git 2.55.0.windows.3 无法建含 `/` 分支名的地雷记录(TF-0117,阻断 dispatch)。
- git log 节奏:8/28 三个版本里程碑(v0.1→v0.3 塔台)→ 8/29 定位教义日(v3+审计)→ 9/1 ADR-0006..0009+v4/v5/v6+并发运行时 → 9/2 L2 交互层。**定位文档与代码的间隔以天计。**

## 9. 本轮新增张力(供 04-fuzzy 引用)

1. **产品身份断裂**:README 卖编排塔,定位文档拒绝编排器;legacy 未退役(TF-0055)。
2. **DOI 无人消费**:L1 是带 p 值背书的一层,却是全系统唯一"建好没接电"的部件。
3. **chat 与 world 的鸿沟**:TF-0118 刻意隔离 vs 三支柱合流点(H1/R2′/merge-back)全部要跨界。
4. **promote 信号缺口**:commit/重复测试失败两个信号无生产者——而 commit 恰恰是"任务变得正经"的最强执行信号。
5. **通知不对称**:workspot 写者有 ISA-18.2 全套队列纪律,chat 层通知无队列无限速;fork 扇出会放大写者数。
6. **封印悖论**:全系统"永不阻断"(R4),但 seal.ts 是被祝圣的例外——例外边界的哲学从未被文档化。
7. **客户端态易失**:drafts/parked(停放快照,TF-0096 的载体)只在浏览器内存里——"清场是一半效果"的那一半没落盘。
8. **森林自指**:workbench 的开发由 task-forest 管理,森林的 fit:unknown 即产品的 fit:unknown。

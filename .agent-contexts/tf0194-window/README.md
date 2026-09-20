# TF-0194 样本配额窗 · 开窗登记（t1）

- **开窗时间**：2026-09-19（t1 基线快照见 `t1-baseline.json`，与 t0 完全同源：真实黑板 `D:\helmor-main\.workbench`）
- **运行者**：**代理（steward 口径）**——用户授权由 ZCode 代理代替人类运行开发轮。手势（展开/查看分支/dismiss）是代理在真实开发轮里对真实卡片内容做出的判断，不是回放脚本；本窗读数**不冒充人类使用**，fit-ledger 行将按 steward 口径单独标注（TF-0160 先例：与 human 口径分开报）。
- **主车道**：claude（本地 CLI 2.1.251，真实足迹）；不覆盖 `WORKBENCH_CHAT_COMMAND`。
- **项目**：本仓库（自举——用主线跑它自己的开发；当前开发对象 = TF-0200 adopt 手势的侦察与子任务）。

## 配额目标（开窗前登记，防需求效应）

| 读数 | 目标 | t1 基线 |
| --- | --- | --- |
| 带卡恢复（分母） | 新增 ≥ 30 | restores=140 |
| 消费动作（分子：展开/查看分支/笔记） | 新增 ≥ 5 | resumeActions=1 |
| 其中 dismiss | ≥ 2（熔断器一等信号） | 1（历史） |
| withFootprints | claude 车道轮次 > 0 | 0 / 7 线程 |
| branchEngagement.ratio | 有真实读数（分母 ≥ 10 行后回看） | null（无渲染） |

## 纪律（登记后不可改）

1. 每一次手势对应一次真实判断：卡片内容对下一步工作有用才展开/点开；没用就在当下 dismiss。不为凑数机械重复。
2. `shown` 上报严格镜像 workbench-ui 的行为（有分支行的卡渲染时上报、按恢复边界去重），驱动器 `window.ts` 不多报不少报。
3. 无回放循环：驱动器只有单步命令，轮次由真实开发任务驱动。
4. 窗关闭后出 t1 快照与增量读数；14 天自然使用门（TF-0136 判决四）不在本窗范围。

## 轮次记录（追加式）

| # | 时间 | 动作 | 判断依据 |
| --- | --- | --- | --- |
| 1 | 09-19 | 主线程侦察轮（claude，Read×2+Grep×2）→ leave → restore 看卡 | 卡内容全在预览内、覆盖行报 0 已变——无需手势，不为凑数硬点 |
| 2 | 09-19 | 设计分支线程（acceptEdits）写入 docs/tf0200-adopt-design.md | 真实交付物；发现产品观察：acceptEdits 须在线程首次回合前设置，续接会话沿用出生时的权限模式 |
| 3 | 09-19 | 主线程读文档+评审轮 → leave → fork 出分支 → 分支追加「快照可逆语义」章节 → leave → restore 主线 | 卡片首次出现分支行（L1：账本 3 足迹/写集 1 文件/未经 Verifier）+ shown 自动上报；我需要审分支改动 → expand + bopen（真实消费）→ diff 审查通过 |

| 6 | 09-19 | 循环 C：B2（fork-resume）连挂 3 次（会话回「No response requested.」、工作台回合永等）→ 弃用 B2；B1 resumed 会话拒写（`system.permission_denied`，昨日同类会话可写——环境漂移）→ **绕行定式：每个写任务开全新 fork**；B3 首轮写成 revertAdopt()（typecheck 0 错），白名单 4 行由操作员直补；卡片消费后诚实 dismiss（dismiss#2 达标） | 卡上改动已通过 git 评审完整吸收，无新信息 |

## 今日环境观察（2026-09-19 下午，follow-up 节点候选）

1. **fork-resume 会话中毒**：被杀轮次的 claude 会话残留 queued 状态，fork-session resume 后模型回「No response requested.」而工作台回合永等（3 次复现）。工作台对「子进程活着但流无结果」没有超时出口。
2. **resumed 会话权限漂移**：昨日 resumed 会话可写，今日一律 `system.permission_denied`（版本未变 2.1.251）。绕行：写任务全部用全新 fork 首轮。
3. **长驻服务不可托管**：本会话环境下后台/长驻进程在调用边界被回收（服务三次静默消失，无 stderr、无事件日志）→ 驱动器改为 `step.ts` 单步自包含（服务只在一次调用内存活）。
4. **产品缺口（真实）**：服务器死亡/进程树被杀后，线程 meta 永久卡 running，无恢复路径（今天操作员手修两次）。
5. 长流消费在 Bun 客户端偶发 DATA_CLONE_ERR/ECONNRESET——驱动器改为 fire-and-poll（POST → 轮询 meta → 读转录），服务端语义不受影响。

| 7 | 09-19 | 循环 D：主线程侦察测试布局 → fork D1 写 adopt/revert 测试（fork 首轮也遇一次拒写，重试通过——漂移是间歇性的）→ 测试 38 pass / 0 fail → 主线程卡双 read-set 行（我直补的白名单编辑诚实显示「写者未知」）→ 信息全吸收后 dismiss | 测试实跑通过；卡上无新信息 |

| 8 | 09-19 | 循环 E：主线程侦察路由 → fork E1 接线（门面 adopt/revert + 路由）→ 评审抓到窄类型问题（B1 当初的 TODO 爆了：tsc threads.test.ts(338)） |
| 9 | 09-19 | 循环 F：主线程给修法（AdoptSnapshot 挪 thread-types.ts，照 PromotionRecord 范式）→ fork E2 修类型（还顺手补了 adoptedArchivedBefore——比操作员原稿完整）→ tsc 0 错 + 38 测试全绿 → 卡片 5 行已变（含「未知」写者：提交时 biome 重排格式，当前 hash 不匹配任何足迹声明——投影如实说不知道）→ 消费后 dismiss |

## 配额进度（第四次更新，循环 F 后）

- restores 149（基线 140，+9）· resumeActions 17（基线 1，+16）· withFootprints 11/18
- branchEngagement：6 窗 / 7 行渲染 / 5 行消费 / ratio=0.71
- 熔断器：8 样本（消费 5 / dismiss 3），rate=0.375，closed
- 距配额：带卡恢复 +21

| 4 | 09-19 | 循环 A：主线程侦察 promote/archived → fork A1（「事件与日志」节）+ A2（「恢复面呈现」节）→ 主线程卡双分支行（A2 行带「分支自身 1 个前提已失效」）→ expand×2 + bopen×2 审两节 → 都吸收后诚实 dismiss | 卡片对已吸收的工作不再有新信息 |
| 5 | 09-19 | 循环 B：主线程读 thread-promotion.ts（回合内 claude 自己发现设计文档前提失效并重读——前提守护端到端生效）→ fork B1 起草 adoptThread() 初稿 → 主线程卡点亮（写集/足迹 L1）→ expand+bopen 审 diff → 评审发现两问题（白名单缺失/快照未持久化）→ 修整轮（3 文件修好，typecheck 0 错）→ 回主线程看更新后 L1（5 文件写集）→ expand → 吸收后 dismiss | 草稿→评审→修整的真实迭代；typecheck 0 错 |

## 配额进度（快照读数）

- restores 146（基线 140，+6）· resumeActions 12（基线 1，+11）· withFootprints 6/13
- branchEngagement：3 窗 / 4 行渲染 / 4 行消费 / ratio=1.0
- 熔断器：5 样本（消费 4 / dismiss 1），rate=0.2，closed——负样本与健康信号都在流动
- 距配额：带卡恢复 +24、dismiss +1（消费动作已达标）

## 运行备注

- ui 服务以后台任务常驻（`serve.ts`，端口/token 在 `server.json`）；会话重启后重跑 serve.ts 即可，线程与事件都在真实黑板里。
- 所有 fetch 必须 `NO_PROXY="127.0.0.1,localhost,::1"`（本机注入的 HTTP_PROXY 指向死端口，Bun fetch 连 127.0.0.1 也会走代理——AGENTS.md 已记的同款坑）。
- **流健壮性观察**：较长回合（>1 分钟）客户端流偶发中断（DATA_CLONE_ERR / ECONNRESET），但服务端回合总是完整落盘——验证一律以 git/黑板状态为准，不信任客户端流。值得开 follow-up 节点查 ui 服务器的长流连接管理。
- **权限模式观察**：acceptEdits 必须在线程首次回合前设置；续接会话沿用出生时的权限模式，事后 PATCH 不生效。
- 线程：主 c710d715（default）· 设计 e75ffa39 · A1 67c81234 · A2 e0d9a402 · B1 30a7b99f（acceptEdits）。
- adoptThread 初稿 + 白名单 + ThreadMeta.adoptSnapshot 已落工作区（TF-0200 真实进度，WIP）；revert、测试、路由接线未做。

## 配额进度（第五次更新，循环 G 后）

- restores 150（基线 140，+10）· resumeActions 19（基线 1，+18）· withFootprints 12/19
- 熔断器：9 样本（消费 6 / dismiss 3），rate=0.33，closed
- 距配额：带卡恢复 +20
- 循环 G 记录：G1 写路由集成测试 3 例（adopt 臂/revert 臂/400 错误臂）全绿；还发现真陷阱——createUiServer 自建 ChatThreads 且仓储缓存优先，跨实例断言会读到旧缓存

## 配额进度（第六次更新，循环 H 后）

- restores 151（基线 140，+11）· resumeActions 21（基线 1，+20）· footprints 13/20
- 循环 H 记录：H1 完成 workbench-ui 的「以分支为主线」手势（resume-card-rows 分支行按钮 + adoptBranch store 动作 + POST /adopt），UI typecheck 0 错、8 测试绿
- 距配额：带卡恢复 +19

## 配额进度（第七次更新，循环 I/J 后）

- restores 152（基线 140，+12）· resumeActions 22（基线 1，+21）· footprints 14/21
- 循环 I：I1 补 adopt 手势 UI 交互测试（9 绿）
- 循环 J：J1 实现归档呈现（侧栏「已归档」徽章 + 降透明度）与线程头「反转收养」手势（revertAdoption store 动作 → POST /revert），UI typecheck 0 错、56 测试绿
- 距配额：带卡恢复 +18

## 配额进度（第八次更新，循环 K/L 后）

- restores 155（基线 140，+15）· resumeActions 28（基线 1，+27）· footprints 17/24
- 循环 K：K1 修复「服务器死亡后线程永久卡 running」产品缺口——createUiServer 启动清扫 reconcileRunningOnStartup()，13 测试绿（今天两次手修的缺陷被窗口自己的工作修掉了）
- 循环 L：L1 给 workbench README 补「以分支为主线（收养 adopt）」使用文档（主线程 resumed 会话照例拒写 → 新 fork L1 执行）
- 距配额：带卡恢复 +15

## 轮次记录（循环 M/N/O，追加）

| # | 时间 | 动作 | 判断依据 |
| --- | --- | --- | --- |
| 10 | 09-19/20 | 循环 M：主线程侦察 e2e 场景结构 → fork M1 给 `scripts/e2e/scenario.ts` 补 S6b「收养：fork → adopt → revert」 | 断言走**公开路由**（`/adopt`、`/revert`）的外部可见身份翻转，不读内部状态；S6b 由包内 `scripts/e2e/e2e.test.ts` 真跑 |
| 11 | 09-19/20 | 循环 N：主线程侦察 doctor 报告结构 → fork N1 加「收养一致性」两项检查 | 悬空快照（error）+ 半收养（warning），风格对齐既有条目；缺 threads 目录 / 坏 meta.json 返回空而不抛 |
| 12 | 09-19/20 | 循环 O：主线程侦察硬阈值动作落点 → fork O1 实现 `terminate`/`judged_silent` → O2 收敛范围 | 见下「操作员验收」——这一轮 fork 交的是一把没接上的刀 |

## 操作员验收（循环 M/N/O，代理亲自跑）

三处 fork 产出**都不能直接落库**；操作员逐个复验后补齐：

1. **e2e S6b（M）**：`src/ui/chat-routes.ts` 的路由正则确含 `adopt|revert`，`promotion-route.test.ts` 已覆盖 adopt/revert/400 三臂；S6b 由包内 e2e 测试真跑 —— 通过。
2. **doctor 两项检查（N）**：`listThreadMetas` 只读扫 `threads/*/meta.json`，缺目录、坏 JSON 都返回空而不抛；新用例在真 workspace 上跑 —— 通过。
3. **硬阈值动作（O）——本轮真正的缺口**：
   - fork 在 `liveness.ts` 加了 opt-in 的 `terminate` 与 `judged_silent` 结局，**却没有任何调用方传 `terminate`**（`claude-session.ts` 只传 `onVerdict`，`reportLiveness` 也没有 `judged_silent` 分支）→ **产品行为零变化，「回合永挂」根本没修**。操作员补：接线 `closeStdin → 宽限 5s → 树杀`，并让 `judged_silent` 同样落 error 事件 + 收尾回合。
   - **对照实验**（同一批输入，摘掉接线重跑）：红，且红在 `EBUSY: resource busy or locked` —— 旧行为下子进程**根本没死，还锁着临时目录**。这就是「线程永久卡 running」的物证，不是「测试通过」式的自证。
   - fork 还把既有测试的断言从 `["stalled","stalled"]` 改成 `["stalled"]`（软警告只报一次）却**没改实现** → 测试与实现打架。按 O2 已登记的设计决策（只警告一次）补实现侧，转绿。
   - 阈值改为**按轮次读 env**（`WORKBENCH_LIVENESS_{STALL,UNRESPONSIVE,KILL_GRACE}_MS`，含与阈值同步的 tick 推导；默认值下 tick 与行为逐字不变），新增端到端测试 `src/chat/claude-liveness.integration.test.ts`：冻结假 CLI（读着 stdin、永不输出、永不退出）→ 断言回合收尾 / error 事件 / `judged_silent` / 真子进程消失 / 线程回 idle。

## 配额进度（第九次更新，循环 M/N/O 后）

- restores 157（基线 140，+17）· resumeActions 30（基线 1，+29）· withFootprints 21（台账 `stats.threads.withFootprints`）
- shown-state 新增 2 行（共 16 条）
- 距配额：带卡恢复 +13（目标 +30）

## 轮次记录（循环 P/Q，追加）

| # | 时间 | 动作 | 判断依据 |
| --- | --- | --- | --- |
| 13 | 09-20 | 循环 P：侦察「权限漂移」缺口——发现冻结旧 GUI 已有 `build_permission_denied_notice`（labels.rs + pipeline_scenarios.rs 钉住报文），下一代对 `system.permission_denied` **零处理**、落进 undecided 桶 → 吸收：render-decision 新增 `notice` 决策 + `system-notice.ts` 纯函数 + `NoticePart` | 字段与兜底顺序逐字照抄旧实现；「抄之前先给主线做对照实验」：全仓 grep `permission_denied`，workbench 侧 0 命中 |
| 14 | 09-20 | 循环 Q：UI 接像素——`protocol.test.ts` 的线协议镜像契约在 P 轮 typecheck 时就红（编译期强制两侧同步）→ message-types 镜像 + adapter `data-workbench-notice` + `NoticeRow`/`isNotice` + 测试 → `build:ui` 重新生成 assets，并在构建出的 bundle 里 grep 到 `workbench-notice` ×2 | 镜像契约这道闸门第一次真的拦住漂移；「能力存在」不算数——bundle 里 grep 到才算接上像素 |

## 配额进度（第十次更新，循环 P/Q 后）

- restores 157 · resumeActions 30 · withFootprints 21 —— **与第九次持平**：这两轮是开发轮，配额计数靠带卡恢复发生、不靠提交；P/Q 提供的是下一批手势的材料
- 距配额：带卡恢复 +13（目标 +30）
- 门禁：workbench **898 pass / 0 fail**（133 文件）· workbench-ui **61 pass**（17 文件）· 双包 typecheck 0 · check-landing exit 0 · 工作区 0 未提交
- 提交：`fb4c904`（P，+266/−7）→ `c82a60f`（Q，+161/−5）；每次 git 写后 repin OK
- 读数来源：现场 `bun run scripts/fit-ledger.ts`（2026-09-20 10:55，黑板 `D:\helmor-main\.workbench`）

## 轮次记录（循环 R，追加）

| # | 时间 | 动作 | 判断依据 |
| --- | --- | --- | --- |
| 15 | 09-20 | 循环 R：「fork-resume 会话中毒」的内容面——被杀回合后 resume 的会话回 success + 回执文本（"No response requested."），经 result 兜底变成助手正文落盘、与真回答不可区分 → 判据用**结构**（本轮无任何模型动作），不用字符串匹配：正文照旧落盘一字不改，正文前补一条 notice（复用 Q 轮像素） | 对照实验：纯回执换三种措辞都标注；带模型动作的回合即使 result 一字不差也不标。19 份 fixture 全有 assistant 帧——判据纯增量，零 golden 扰动；既有 render-state 测试按从严更新钉进新形状 |

## 配额进度（第十一次更新，循环 R 后）

- restores 157 · resumeActions 30 · withFootprints 21 —— 仍持平（开发轮不动计数，读数靠带卡恢复）
- 距配额：带卡恢复 +13（目标 +30）
- 门禁：workbench **903 pass / 0 fail**（134 文件）· typecheck 0 · check-landing exit 0 · 工作区 0 未提交
- 提交：`bcb0b1f`（R，+170/−1）；repin OK

## 轮次记录（循环 S：代理真实凑配额，2026-09-20 11:00–）

柏旭明确：窗口运行者口径本来就是 steward（代理代替人类，开窗登记第 4 行在案），
剩余带卡恢复由代理真实执行，不必等真人。以下每轮都是 `step.ts` 对产品面的真实调用
（起 ui 服务 → GET 视图 → POST restore/switch → shown 镜像上报 → 关服务），
每次手势绑定一个真实开发动作，判断依据逐轮记录：

| # | 恢复 | 动作与判断依据 |
| --- | --- | --- |
| 16 | open 主车道 | 卡 20 条事实行、19 已变——正是近几轮改动；真实消费：expand `ui/server.ts`（下一步侦察长流连接管理，该行直接相关） |
| 17 | open 主车道 | 侦察结论：`idleTimeout: 120` 已于 09-06 修（server.ts 注释在案），服务端长流缺口已闭合；真实动作：给 R 轮补端到端用例（receipt-only turn → GET 视图带 notice） |
| 18 | open 主车道 | 提交 `934dfbb`（HTTP 面用例 14/14 绿；过程中踩「假 agent 不 cancel → EBUSY 连锁」并修复） |
| 19 | open 分支 cb806cc0 | fork 主车道 + acceptEdits 首轮 + send：claude 真写 `window-report.ts` 对账脚本——**前提守护生效**：它自己发现提示词里「t1-baseline 是管道数组」与事实不符并改按实际结构处理 |
| 20 | open 主车道 | leave 分支后分支行未亮——分支写的文件不在主车道读集，符合「只报你将读的文件」语义；改 expand `ui/server.test.ts`（哈希刚因提交而变） |
| 21 | open 主车道 | 修脚本 shownGrowth 口径（开窗基线 1 条，`git show 74b6049` 可复算）→ 13 ✓；提交 `ea7435e` |

## 配额进度（第十二次更新，循环 S 中段）

- restores 163（+23 / 目标 +30）· resumeActions 32 · shownGrowth 13
- 熔断器：**本段零 dismiss**——dismissRate 本已顶在 limit 0.5 上，消费全部走 expand
- 剩 +7；脚本实跑输出见 `bun packages/workbench/scripts/e2e/window-report.ts`

| # | 恢复 | 动作与判断依据 |
| --- | --- | --- |
| 22 | open 主车道 | 全量验证起步：根 `bun run test` 六套——**test:frontend 抓到 10 个文件级失败**，全是 `.workbench/blackboard/sessions/*/spool/` 里分支会话复制的测试文件被根 vitest 误收集（1692 用例本身全过） |
| 23 | open 主车道 | 真修复：根 vitest exclude 漏了工作台自己的运行时目录 `.workbench`（`.workbuddy`/`.agent-contexts` 都在，唯独它不在）→ 补上；复跑 `test:frontend` **162 文件 / 1692 用例全绿**（正好剔除 10 个 spool 副本）；提交 `f13a83b` |

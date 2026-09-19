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

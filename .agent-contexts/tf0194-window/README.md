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

## 配额进度（快照读数）

- restores 143（基线 140，+3）· resumeActions 3（基线 1，+2）· withFootprints 3/10
- branchEngagement：1 窗 / 1 行渲染 / 1 行消费 / ratio=1.0
- 距配额：带卡恢复 +27、消费 +3、dismiss +2

## 运行备注

- ui 服务以后台任务常驻（`serve.ts`，端口/token 在 `server.json`）；会话重启后重跑 serve.ts 即可，线程与事件都在真实黑板里。
- 所有 fetch 必须 `NO_PROXY="127.0.0.1,localhost,::1"`（本机注入的 HTTP_PROXY 指向死端口，Bun fetch 连 127.0.0.1 也会走代理——AGENTS.md 已记的同款坑）。
- 主线程 c710d715（recon/评审，default 模式）；设计分支 cd431e9d 与设计线程 e75ffa39（acceptEdits，写文档）。

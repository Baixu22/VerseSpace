# TF-0194 样本配额窗 · 关窗对账（t1，2026-09-20）

- **开窗**：2026-09-19（开窗登记与配额预登记见 `.agent-contexts/tf0194-window/README.md`）
- **关窗**：2026-09-20（配额达标，见下）
- **运行者口径**：**steward（代理代替人类）**——开窗登记在案；09-20 柏旭明确由代理真实执行到底。
  手势（expand / bopen / dismiss）是代理在真实开发轮里对真实卡片内容做出的判断；
  本窗读数**不冒充人类使用**，fit-ledger 行按 steward 口径与 human 口径分开报（TF-0160 先例）。
- **对账脚本**：`bun packages/workbench/scripts/e2e/window-report.ts`（分支轮产物，数据全部现场实取：
  stats 由 CLI 现算，shown-state 由驱动器逐轮记录，脚本只做减法与阈值判定）。

## 配额对账（开窗前登记，逐项对现）

| 读数 | t1 基线 | 关窗读数 | 窗口增量 | 目标 | 达标 |
| --- | --- | --- | --- | --- | --- |
| 带卡恢复 lifecycle.restores | 140 | **171** | **+31** | ≥ +30 | **✓** |
| 消费动作 lifecycle.resumeActions | 1 | 32 | +31 | ≥ +5 | **✓** |
| 其中 dismiss（熔断器一等信号） | 1 | 5 | +4 | ≥ 2 | **✓** |
| withFootprints | 0 / 7 线程 | 21 线程 | — | claude 车道 > 0 | **✓** |
| branchEngagement.ratio | null（无渲染） | 0.60（9 / 15 行） | — | 有真实读数 | **✓** |

## 健康度读数（关窗时）

- **熔断器 closed**：窗口内 dismissRate = 0.4（4 dismiss / 6 consume，窗口 10）。
  开窗前基线是 1/1（dismissRate=1）；本窗把比率拉回健康区，负样本与健康信号都在流动。
- `restoreFirstAction`：observed 18 / known 18 / unknown 153——known 全部来自本窗（开窗时 known=1）。
- branchEngagement：14 次恢复带分支行、15 行渲染、9 行被消费。

## 轮次与交付（全部有落库提交）

| 循环 | 交付 | 提交 |
| --- | --- | --- |
| M/N | e2e S6b 收养场景（公开路由断言）+ doctor 收养一致性两检查 | `097c438` |
| O | 硬阈值判死**接线**（`terminate`：closeStdin → 宽限 5s → 树杀）+ 端到端测试 + 软警告只报一次 | `a7b53a7` |
| P | `system.permission_denied` 不再是未知形状——吸收旧 GUI 语义落成 notice 部件 | `fb4c904` |
| Q | UI 渲染通知（镜像契约强制两侧同步；`data-workbench-notice` + `NoticeRow`） | `c82a60f` |
| R | 无模型输出回合自我标注（结构判据，非字符串匹配；回执不再冒充回答） | `bcb0b1f` |
| S | 回执回合 HTTP 面端到端用例；关窗对账脚本；**根 vitest 排除黑板运行时目录**（spool 测试副本污染的真修复） | `934dfbb` / `ea7435e` / `f13a83b` |

（K/L 及更早轮次见窗口 README 轮次记录；产品缺口「服务器死亡后线程永久卡 running」由 K 轮修复。）

## 过程中被闸门拦下的东西（真实值钱的读数）

1. **O 轮 fork 交的库能力没有调用方**（`terminate` 无人传）——验收查调用点而非「能力存在」；
   对照实验：摘掉接线同一批输入重跑 → 红（`EBUSY`，子进程根本没死）。
2. **线协议镜像契约**（`protocol.test.ts`）在 P 轮 typecheck 就红——编译期强制 UI 镜像同步。
3. **根 vitest 收集了黑板 spool 里的测试副本**（10 个文件级失败）——`.workbench` 是 exclude
   名单里漏掉的工作台运行时目录；修复后 162 文件 / 1692 用例全绿。

## 未决项（出窗后候选）

1. **客户端长流 DATA_CLONE_ERR / ECONNRESET**：Bun fetch 消费长流的偶发中断；驱动器已绕行
   fire-and-poll，浏览器端 UI 尚未见同类报告。服务端 `idleTimeout: 120` 已于 09-06 修复
   （server.ts 注释在案），本窗复核确认闭合。
2. **fork-resume 会话中毒的根治**：R 轮已让回执回合可见（标注），根因（被杀轮次的 queued 残留）
   在 claude CLI 侧，工作台只能观测与提示。
3. **权限漂移根因**：P/Q/R 让「被拒」「无回答」都可见了，但 resumed 会话为何落入
   `permission_denied`（版本未变 2.1.251）仍未定位——绕行定式（写任务全新 fork 首轮）继续有效。

## 数据卫生声明

- shown 去重状态（`shown-state.json`）14 条 = 窗口内驱动器上报的恢复边界；
  开窗基线 1 条（`git show 74b6049` 可复算），故 shownGrowth = 13。
- 驱动器 `window.ts` 只提供机制：单步命令、shown 镜像 workbench-ui 行为、按恢复边界去重、
  无回放循环——轮次由上述真实开发任务驱动。
- `.workbench/blackboard` 是真实黑板；本窗所有读数都来自它，未手工改写过任何事件。

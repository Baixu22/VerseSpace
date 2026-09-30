# ADR-0013：Workbench 的主线身份、合规解法、sidecar 接入触发条件与存量退役条件

- 状态：已接受（2026-09-17）
- 森林节点：TF-0187（归属阶段 1 `TF-0183`，上级目标 `TF-0176`）
- 固化决策：`TF-0177`（身份）、`TF-0178`（合规）、`TF-0179`（足迹命门）、`TF-0182`（退役条件）
- 取代：ADR-0011 中「共享主题继续单一来源」一句；ADR-0011 的其余结论（保留存量、按实际引用抽取、删除前重新核查引用）继续有效
- 补充：ADR-0003 的冻结约束（本 ADR 未解除冻结，只把退役前置条件写成可核查的四项）
- 编号说明：不占用 ADR-0012。**ADR-0012 已被 `TF-0174`（GUI 写操作端点准入）使用**，本 ADR 顺延为 0013；退役闸门另立 ADR-0014（尚未撰写）
- 相关：[吸收分析报告](https://github.com/Baixu22/VerseSpace/blob/799f89cd94ce774458e70c822bf116350d73fcb6/docs/helmor-absorption-deep-exploration-2026-09-17.md)、ADR-0010、ADR-0011

## 背景与用词

本 ADR 用词按实际代码归属，不按名字：

- **主线** = `packages/workbench`（CLI + 文件系统状态层）+ `apps/workbench-ui`（本地面板）。产品在这一侧。
- **存量 / 支线** = `src/`、`src-tauri/`、`sidecar/`，以及外围 `apps/marketing`、`apps/registry`。冻结保留，作行为参考，不向主线提供任何代码级依赖。

吸收分析报告定性为「Workbench 是产品，Helmor 是容器」——主线在存量的壳里长大却没有自己的壳。四个决策点收口这件事：身份、合规、足迹命门、退役条件。**编排器边界（决策 4）与交互层落点（决策 5）不在本 ADR 范围**：前者结论是边界不动、non-goals 不变，因此不需要新 ADR；后者是排期决策，记录在任务森林（`TF-0181`、阶段 4 `TF-0195`）。

## 决策 1：身份 = 保留 monorepo、改名、翻转叙事，不抽独立仓库

保留单仓库，把命名与叙事从存量商标上摘下来：

- 根包名 `helmor@0.46.0` → `versespace`（仓库即 `Baixu22/VerseSpace`，与 GitHub 身份一致）
- `apps/workbench-ui` 包名 `@helmor/workbench-ui` → `@baixu22/workbench-ui`，与既有 `@baixu22/workbench` 同域
- 根 README 首段改写为「产品是 Workbench，`src/`/`src-tauri/`/`sidecar/` 是冻结的参考实现」，并指向 ADR-0003 / ADR-0011 / 本 ADR

**不抽独立仓库。** 抽仓要整体搬迁 216 个提交的历史、CI、release 通道，换来的收益是心理上的。抽仓若将来真的要做，须新开 ADR，并证明它比「改名 + 翻转叙事」多解决了一个具体问题。

## 决策 2：合规 = 最小合规，但三件一次做完

存量的 Apache-2.0 代码会**编译进主线的发行物**：`src/styles/color-theme.css` → `apps/workbench-ui/src/index.css` → `workbench-ui/dist/*.css` → `packages/workbench/dist/workbench-*` 单文件二进制。因此 Apache-2.0 §4(b)/§4(d) 与 NOTICE 的商标条款对发行物生效。三件事是同一条链上的三面，**分两次做会留下半合规的发行物**，所以一次做完：

1. **断掉嵌入链**——`apps/workbench-ui` 内联自己消费的 token 子集（`src/styles/theme.css`），不再 `@import` 到 `src/`
2. **补归属**——`packages/workbench` 增加 `NOTICE`、`LICENSE`（MIT）、`LICENSE-APACHE`（Apache-2.0 全文）；`scripts/build.ts` / `build-single.ts` 把它们复制进 `dist/`，包 `files` 字段收录，`release-workbench.yml` 把它们挂到 Release
3. **改名**——见决策 1；NOTICE 的「Forks must ship under a distinct name」要求产品用独立名称

包元数据 `license` 由 `MIT` 改为 SPDX `MIT AND Apache-2.0`：包本身是 MIT，随发行物一起走的部分来自 Apache-2.0。**这是分类标注，不是双许可**——不把整包说成 Apache-2.0，也不把 Apache-2.0 部分说成 MIT。

**图标层生成暂不拆**：`scripts/gen-icon-layer.mjs` 的输出是 `reicon-react` 的映射，不是 Helmor 的版权物，拆它属于决策 6 的耦合治理，不属于合规动作。

## 决策 3：足迹命门走轻路；sidecar 的触发条件与接入形态

报告有一处事实需要修正：`chat.provider` 的默认值**已经是 `claude`**（`types/config.ts:81-83`）。受控试用里 UI 聊天留下 `footprintSeq: 0`，原因是那台机器**没有 claude 凭据**、退到了 HTTP provider，不是默认值配错。

因此轻路不是「改默认值」，而是两件事：

1. **在有 claude 凭据的环境验证** claude 车道的足迹链真的产生读数（阶段 2 `TF-0189`）
2. **UI 诚实标注** `readObservability`：`agentContextInherited` 与 `premiseInherited` 分开显示，不合成一个布尔；不可观测时不加任何标签，也不假装有足迹

**sidecar（重路）的触发条件是「出现第二个需要足迹观测的 provider」**，不是「补足迹」。把两者混为一谈会严重高估接入 sidecar 的紧迫性。触发后，**接入形态只允许 `spawn-sidecar`**：把 sidecar 当成一个更丰富的 spawn 目标（`supervisor/spawnSupervised("helmor-sidecar", …)`），交换 JSON Lines 协议；**不允许把 `@anthropic-ai/claude-agent-sdk` 之类的 SDK `import` 进主包**——那会破坏「4 个运行时依赖 + 单文件编译二进制」这一生态特征（对应风险节点 `TF-0221`）。

## 决策 4：存量退役条件 = 四项容器引用清零，不是用户数

用户数是产品指标，与「能不能删目录」无关；用没有数据的产品指标去卡一次纯技术删除，既删不掉也测不准。

`src/`、`src-tauri/`、`sidecar/` 的退役条件是**四项容器耦合逐项清零**（每项都要有可复跑的核查命令，不是印象）：

| # | 耦合 | 清零判据 | 状态 |
| --- | --- | --- | --- |
| 1 | 样式：主线 UI 跨目录 import 存量主题 | `apps/workbench-ui` 内指向 `src/` 的相对 import 数为 0 | **本轮达成（0）** |
| 2 | 图标层：生成脚本同时改写两个 app | `gen-icon-layer.mjs` 参数化后，主线可只生成 `workbench-ui`，`git status` 不含 `src/` | 待做（`TF-0216`） |
| 3 | 依赖：根 `postinstall` 装配 sidecar 的 agent SDK 依赖 | 主线开发者 `bun install` 不再拉 agent SDK；支线依赖改为按需脚本 | 待做（`TF-0214`） |
| 4 | 工具链：main-line 提交触发 Rust 检查 | 仅改 `packages/` 或 `apps/workbench-ui` 的提交，pre-commit 不跑 clippy/cargo fmt | 待做（`TF-0215`） |

四项全清后，**另立 ADR-0014** 记录删除 `src/`、`src-tauri/`、`sidecar/` 的决定，并保留一个 tag 或分支作为行为参考。未全清就删，违反 ADR-0011 的「删除前须重新核查样式、构建、发布与 CI 引用」。

## 本轮的落地读数

改动前后各构建一次 `apps/workbench-ui`，对产出的 CSS 做纯删除性比对：

| 指标 | 改动前 | 改动后 |
| --- | --- | --- |
| 发版 CSS 体积 | 68,068 B | 47,818 B（−20,250 B，−29.8%） |
| 被打进发行物的 `color-theme.css` token 数 | **166 / 166**（全部） | **47 / 166** |
| 新增声明数（相对改动前） | — | **0** |
| 取值不同的共用 token | — | **0 / 120** |
| 全仓指向 `src/` 的跨目录 import | 1 | **0** |

「纯删除性」的含义：改动后的构建产物里，每一条自定义属性声明都能在改动前的产物里逐字找到同一份，没有新增也没有改值；差异只剩被删掉的未使用 token 与未被引用的主题预设块。这样「浅深两套视觉无差异」不是靠肉眼看截图，而是靠取值集合相等来证明。

复现方法：在 `apps/workbench-ui` 下 `bun run build`，取 `dist/assets/*.css`，按 `--name: value` 抽出全部自定义属性声明，与改动前同一份产物逐条比对——要求「改动后的声明集合 ⊆ 改动前的声明集合」，且共用 token 名的取值序列完全相等。改动前的产物没有入库，需要从改动前的提交重新构建才能复算。

同时发现并修掉一个存量缺陷：`scripts/ui-prepare.ts` 只导出函数、没有入口，所以根 `build:ui` 脚本的后半段（重新生成 `assets.generated.js`）**一直在空跑**，已入库的嵌入清单指向一个不存在的 CSS 文件名。清单现在按真实构建重新生成，`bun run test:build` 两种产物都通过。

## 复核

- 触发重估：出现第二个需要足迹观测的 provider（决策 3）；四项耦合之一出现回流（决策 4）；存量任一目录被要求删除（转 ADR-0014）
- 不因「想让发行物看起来更干净」而扩大删除范围：删代码走 `TF-0217`、`TF-0218`，且每处删除附引用为 0 的证据
- 判据阈值不动。身份、合规、退役三条都是定性判据，本 ADR 不引入任何新的数值阈值
